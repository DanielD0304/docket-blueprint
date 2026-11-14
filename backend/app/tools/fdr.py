"""Deterministic FDR analysis: discrete transitions + threshold exceedances + profile series.

Handles sparse NTSB exports (one row per 1/64 s, each row only carries the parameters sampled then)
and local-time clocks (units row "(CST)"). The LLM never does arithmetic on raw recorder data.
See PLAN.md §11 for learned detectors (TimesFM residuals, matrix profile, ...) to add later.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from ..schemas import Anomaly, AnomalyObservation, Citation, Event, Param, Series, SourceFile, TimeRef
from .discovery import VERSION as DISCOVERY_VERSION
from .discovery import discover_changes
from .sensors import analyze_sensors
from .table import find_col, load_table, numeric, time_seconds

# Discretes worth showing, most important first (others are skipped to keep the timeline readable).
DISCRETE_PRIORITY = [
    r"stick.?shak|stall", r"g/a|go.?around|toga", r"a/p (cmd|engage|disc)|autopilot", r"a/t|autothrot",
    r"master (warn|caut)|gpws|egpws|windshear|ground prox", r"a/p .*mode|fma|flch|vnav|lnav|v/s mode|hdg sel|alt mode|ias mode",
    r"flap|slat", r"gear", r"speed ?brake|spoiler", r"mic|key|vhf", r"trim",
]
ALERT_RE = re.compile(r"shak|stall|warn|caution|gpws|windshear|ground prox", re.I)


@dataclass
class Rule:
    patterns: tuple[str, ...]
    test: str  # "abs_gt", "gt", "lt"
    threshold: float
    title: str
    severity: str
    domain: str = "flight_path_energy"
    exclude: str | None = None


RULES = [
    Rule((r"^pitch angle|pitch att|^pitch$",), "abs_gt", 20, "Extreme pitch attitude", "critical"),
    Rule((r"^roll angle|bank angle|^roll$",), "abs_gt", 35, "Excessive bank angle", "significant"),
    Rule((r"vert.*speed|altitude rate|alt.*rate|\bivv\b",), "lt", -6000, "Extreme descent rate", "critical"),
    Rule((r"vertical acc|normal acc|load factor|\bnz\b",), "lt", 0.0, "Negative load factor", "critical"),
    Rule((r"vertical acc|normal acc|load factor|\bnz\b",), "gt", 2.5, "High load factor", "significant"),
    Rule((r"computed airspeed|^airspeed|\bcas\b|\bias\b",), "gt", 360, "Possible overspeed (check Vmo for type)", "significant",
         exclude=r"target|sel|mach|max|min"),
    Rule((r"angle of attack|\baoa\b",), "gt", 12, "High angle of attack", "significant", exclude=r"rate"),
]

# (series name, unit, column patterns, exclude). Names are the contract with the frontend.
SERIES_COLS = [
    ("altitude_ft", "ft", (r"^pressure alt|press.*alt|^altitude|\balt\b",), r"rate|sel|target|radio|radar|mode|caution|alert|mcp"),
    ("airspeed_kt", "kt", (r"computed airspeed|^airspeed|\bcas\b|\bias\b",), r"target|sel|mach|max|min|mode"),
    ("pitch_deg", "deg", (r"^pitch angle|pitch att|^pitch$",), r"trim|rate|cmd"),
    ("roll_deg", "deg", (r"^roll angle|bank angle|^roll$",), r"rate|cmd|trim"),
    ("radio_alt_ft", "ft", (r"radio alt|radar alt",), None),
    ("aoa_deg", "deg", (r"angle of attack|\baoa\b",), r"rate"),
    ("vs_fpm", "fpm", (r"vert.*speed|altitude rate|alt.*rate|\bivv\b",), r"mode|sel"),
    ("nz_g", "g", (r"accel vert|vertical acc|normal acc|load factor|\bnz\b",), None),
    ("elevator_deg", "deg", (r"elevator",), r"trim|cmd|feel"),
    ("stab_trim_deg", "deg", (r"stab.*pos|stabilizer|stab trim|pitch trim",), r"switch|cmd|arm"),
    ("column_deg", "deg", (r"ctrl col pos|column pos|control column|^column",), r"force|switch"),
    ("wheel_deg", "deg", (r"ctrl whl pos|control wheel",), r"force"),
    ("groundspeed_kt", "kt", (r"^groundspeed|ground speed",), None),
    ("tra_1_deg", "deg", (r"eng1 tra|eng 1 tra|throttle.*1",), None),
    ("tra_2_deg", "deg", (r"eng2 tra|eng 2 tra|throttle.*2",), None),
    ("wind_kt", "kt", (r"wind spd|wind speed",), None),
    ("wind_dir_deg", "deg", (r"wind dir",), None),
    ("heading_deg", "deg", (r"^mag(netic)? heading|^heading|true heading",), r"sel|target|mode"),
    ("flap_deg", "deg", (r"flap pos|^flap",), r"handle|lever|alert"),
    ("mach", "", (r"^mach",), r"sel|target"),
]
ENGINE_RE = re.compile(r"\bn1\b|n1 |fan speed|\bepr\b", re.I)


def _segments(mask: np.ndarray) -> list[tuple[int, int]]:
    segs, start = [], None
    for i, m in enumerate(mask):
        if m and start is None:
            start = i
        elif not m and start is not None:
            segs.append((start, i - 1))
            start = None
    if start is not None:
        segs.append((start, len(mask) - 1))
    return segs


def _downsample(t: np.ndarray, v: np.ndarray, n: int = 2500) -> list[tuple[float, float]]:
    ok = ~(np.isnan(t) | np.isnan(v))
    t, v = t[ok], v[ok]
    if len(t) == 0:
        return []
    idx = np.unique(np.linspace(0, len(t) - 1, min(n, len(t))).astype(int))
    return [(float(t[i]), float(v[i])) for i in idx]


def analyze_fdr(path: Path, sf: SourceFile, local_utc_offset_h: float = 0.0) -> dict:
    df = load_table(path)
    t, basis, tcol = time_seconds(df)
    if t is None:
        t = pd.Series(np.arange(len(df), dtype=float))
        basis = "relative"
    if basis == "local":
        t = t - local_utc_offset_h * 3600  # local = UTC + offset
    utc = basis in ("utc", "local")
    tv = t.to_numpy(dtype=float)
    unit = df.attrs.get("units", {}).get(tcol or "", "")

    def tref(i: int) -> TimeRef:
        raw = str(df[tcol].iloc[i]) + (f" {unit}" if unit else "") if tcol else f"row {i}"
        return TimeRef(raw=raw, basis="utc" if utc else basis, t_s=float(tv[i]) if utc else None,  # type: ignore[arg-type]
                       uncertainty_s=1.0 if utc else None, aligned_by=f"fdr_clock({unit or basis})" if utc else None)

    def cite(i: int, j: int, col: str, note: str) -> Citation:
        return Citation(file_id=sf.file_id, page=None, quote=f"rows {i + 1}-{j + 1}, column '{col}': {note}", verified=True, score=100)

    events: list[Event] = []
    anomalies: list[Anomaly] = []

    # 1) discrete transitions (prioritised)
    def prio(c: str) -> int:
        return next((k for k, p in enumerate(DISCRETE_PRIORITY) if re.search(p, c, re.I)), 99)

    budget = 900
    for col in sorted((c for c in df.columns if c != tcol and prio(c) < 99), key=prio):
        raw = df[col]
        nonnull = raw.dropna()
        if nonnull.empty or pd.to_numeric(nonnull, errors="coerce").notna().mean() > 0.9 and nonnull.nunique() > 8:
            continue  # continuous parameter
        s = nonnull.astype(str).str.strip()
        if not (2 <= s.nunique() <= 10):
            continue
        prev = s.shift()
        idx = s.index[(s != prev) & prev.notna()]
        for i in idx[:60]:
            p = s.index.get_loc(i)
            before, after = s.iloc[p - 1], s.iloc[p]
            events.append(Event(
                id=f"ev-{sf.file_id}-d{len(events)}", time=tref(i), actor="FDR", lane="systems",
                category="alert_warning" if ALERT_RE.search(col) else "system_event",
                description=f"{col}: {before} → {after}", parameters=[Param(name=col, value=after)], certainty="measured",
                citations=[cite(i, i, col, f"{before} -> {after}")], source_files=[sf.file_id], verified=True))
            budget -= 1
        if budget <= 0:
            break

    # 2) threshold exceedances on the non-null samples of each parameter
    for r in RULES:
        col = find_col(df, *r.patterns, exclude=r.exclude)
        if col is None:
            continue
        v = numeric(df, col).dropna()
        if len(v) < 10:
            continue
        mask = {"abs_gt": v.abs() > r.threshold, "gt": v > r.threshold, "lt": v < r.threshold}[r.test].to_numpy()
        for a, b in _segments(mask)[:10]:
            seg = v.iloc[a:b + 1]
            peak_i = seg.abs().idxmax() if r.test == "abs_gt" else (seg.idxmax() if r.test == "gt" else seg.idxmin())
            i0, i1 = int(seg.index[0]), int(seg.index[-1])
            anomalies.append(Anomaly(
                id=f"an-{sf.file_id}-x{len(anomalies)}", time=tref(i0), domain=r.domain, title=r.title,  # type: ignore[arg-type]
                expected=f"{col} within {'±' if r.test == 'abs_gt' else ('<' if r.test == 'gt' else '>')}{r.threshold}",
                observed=f"{col} peaked at {float(v[peak_i]):.2f} for {tv[i1] - tv[i0]:.1f} s",
                severity=r.severity, certainty="measured",  # type: ignore[arg-type]
                citations=[cite(i0, i1, col, f"peak {float(v[peak_i]):.2f}")], source_files=[sf.file_id], verified=True,
                observations=[AnomalyObservation(start_s=float(tv[i0]), end_s=float(tv[i1]),
                             citations=[cite(i0, i1, col, f"peak {float(v[peak_i]):.2f}")])] if utc else []))

    # Statistical discovery uses native samples, never the UI's reduced series.
    # Only clocks known to be seconds are eligible (subframes are not seconds).
    discoveries = discover_changes(df, tv) if utc else []
    for k, hit in enumerate(discoveries):
        detail = (f"{DISCOVERY_VERSION}; {hit.horizon} change rate {hit.rate:.6g} {hit.unit}/s; "
                  f"recording median {hit.center:.6g}, robust scale {hit.scale:.6g}; "
                  f"score {hit.score:.2f} >= 8 (not a probability). Parsed data rows exclude metadata.")
        citations = [cite(hit.start, hit.end, hit.column, detail),
                     cite(hit.baseline_start, hit.baseline_end, hit.column, "whole-recording rate baseline; "
                          "scale=max(1.4826*MAD,IQR/1.349,capped-step/interval,numerical-floor); gaps >3 cadences excluded")]
        anomalies.append(Anomaly(
            id=f"an-{sf.file_id}-discovery-{k}", time=tref(hit.start), domain="aircraft_system",
            title=f"Unusual change: {hit.column}",
            expected="Change rates typical of this recording; statistical reference only, not an aircraft operating limit.",
            observed=detail + " Candidate may reflect normal maneuvering, a regime change, or a sensor artifact; investigate in context.",
            severity="info", certainty="measured", citations=citations, source_files=[sf.file_id], verified=True,
            observations=[AnomalyObservation(start_s=float(tv[hit.start]), end_s=float(tv[hit.end]), citations=citations)]))

    # 3) profile series for the UI (on UTC when possible)
    series: list[Series] = []
    for name, sunit, pats, excl in SERIES_COLS:
        col = find_col(df, *pats, exclude=excl)
        if col:
            pts = _downsample(tv, numeric(df, col).to_numpy(dtype=float))
            if len(pts) > 5:
                series.append(Series(name=name, unit=sunit, source_file=sf.file_id, points=pts))
    eng_cols = [c for c in df.columns if ENGINE_RE.search(c) and not re.search(r"cmd|target|limit|ref|max|vib|mode", c, re.I)]
    for k, col in enumerate(eng_cols[:4], start=1):
        pts = _downsample(tv, numeric(df, col).to_numpy(dtype=float))
        if len(pts) > 5:
            series.append(Series(name=f"n1_{k}", unit="%", source_file=sf.file_id, points=pts))

    # 4) recorder track (lat/lon on the FDR beats ADS-B: same clock as everything else)
    track = []
    lat_c, lon_c = find_col(df, r"^latitude$|^lat$"), find_col(df, r"^longitude$|^lon$")
    if lat_c and lon_c and utc:
        # sparse export: lat and lon are sampled in different rows -> forward-fill lon onto lat samples
        lat = numeric(df, lat_c).to_numpy(dtype=float)
        lon = numeric(df, lon_c).ffill().to_numpy(dtype=float)
        alt_c = find_col(df, *SERIES_COLS[0][2], exclude=SERIES_COLS[0][3])
        alt = pd.Series(numeric(df, alt_c) if alt_c else np.nan, index=df.index).ffill().to_numpy(dtype=float)
        gs_c = find_col(df, r"^groundspeed")
        gs = pd.Series(numeric(df, gs_c) if gs_c else np.nan, index=df.index).ffill().to_numpy(dtype=float)
        ok = np.where(~(np.isnan(lat) | np.isnan(lon) | np.isnan(tv)) & (np.abs(lat) > 0.01))[0]
        if len(ok) > 10:
            sel = ok[np.unique(np.linspace(0, len(ok) - 1, min(4000, len(ok))).astype(int))]
            track = [{"t_s": float(tv[i]), "lat": float(lat[i]), "lon": float(lon[i]),
                      "alt_ft": None if np.isnan(alt[i]) else float(alt[i]), "gs_kt": None if np.isnan(gs[i]) else float(gs[i])} for i in sel]

    t_ok = tv[~np.isnan(tv)]
    sensors = analyze_sensors(df, tv, sf.file_id, clock_resolved=utc, time_column=tcol)
    return {
        "track": track, "track_rank": 1,
        "summary": f"FDR table: {len(df)} rows × {len(df.columns)} params, clock '{tcol}' ({unit or basis}"
                   f"{' → UTC' if basis == 'local' else ''}), span {t_ok.min() if len(t_ok) else 0:.0f}-{t_ok.max() if len(t_ok) else 0:.0f} s. "
                   f"{len(events)} discrete transitions, {len(anomalies) - len(discoveries)} exceedances, "
                   f"{len(discoveries)} statistical change candidates, {len(series)} series.",
        "discovery_version": DISCOVERY_VERSION,
        "sensors": [s.model_dump() for s in sensors],
        "events": [e.model_dump() for e in events],
        "anomalies": [a.model_dump() for a in anomalies],
        "entities": [], "facts": [],
        "series": [s.model_dump() for s in series],
        "time_basis": basis,
    }
