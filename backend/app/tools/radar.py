"""FAA STARS/TRACON playback (.ppb) parser.

The NTSB docket radar attachment (e.g. DCA19MA086 #55, I90 TRACON 18:00-19:09Z, ~2.5 M rows, 790 MB) is a tab-separated
text export of every target. We stream it, keep the accident aircraft (matched by its Mode-S address taken from the ADS-B CSV
next to it), and extract: altitude series per radar return, ATC safety-alert flags (MSAW = minimum safe altitude warning,
CA/MCI = conflict alert) as events, and the last radar return.
Columns (0-based): 0 time UTC · 1 sensor · 3 callsign · 6 altitude (hundreds ft, '-V' valid) · 17 ground speed · 18 heading ·
40/41 lat/lon (DDMMSS) · 42 MSAW flag · 43 CA/MCI flag · 48 Mode-S address.
"""
from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

from ..schemas import Citation, Event, Param, Series, SourceFile, TimeRef
from ..timeparse import clock_seconds


def _icao_from_adsb(raw_dir: Path) -> str | None:
    for csv in raw_dir.glob("*.csv"):
        try:
            head = pd.read_csv(csv, nrows=2000, usecols=lambda c: c in ("ModeSId",), encoding="latin-1")
        except Exception:
            continue
        if "ModeSId" in head and head["ModeSId"].notna().any():
            return str(head["ModeSId"].astype(str).str.strip().value_counts().index[0]).lower()
    return None


def _dms(s: str, deg_digits: int) -> float | None:
    m = re.match(rf"^(\d{{{deg_digits}}})(\d{{2}})(\d{{2}})([NSEW])$", s.strip())
    if not m:
        return None
    v = int(m.group(1)) + int(m.group(2)) / 60 + int(m.group(3)) / 3600
    return -v if m.group(4) in "SW" else v


def analyze_radar(path: Path, sf: SourceFile, raw_dir: Path) -> dict:
    icao = _icao_from_adsb(raw_dir)
    if not icao:
        return {"summary": "Radar playback: no Mode-S address available (needs ADS-B CSV)", "events": [], "anomalies": [],
                "entities": [], "facts": [], "series": []}
    key = f"0x{icao.lower().removeprefix('0x')}"
    rows = []
    with open(path, encoding="latin-1") as f:
        for i, line in enumerate(f):
            if key in line:
                c = line.rstrip("\n").split("\t")
                if len(c) > 48:
                    rows.append((i + 1, c))
    events: list[Event] = []
    alt_pts = []
    flags: dict[str, str] = {}
    sensors: dict[str, float] = {}
    callsign = ""
    for ln, c in rows:
        t = clock_seconds(c[0])
        if t is None:
            continue
        sensors[c[1].strip()] = t
        callsign = callsign or c[3].strip() or c[52].strip() if len(c) > 52 else callsign
        m = re.match(r"^\s*(\d+)-V", c[6])
        if m:
            alt_pts.append((t, int(m.group(1)) * 100.0))
        # Columns 42/43 ("MSAW Active", "CA/MCI Active") flip with the reporting sensor and most likely mean the
        # safety-alert *processing* is enabled for the track, not that an alert fired -> not emitted as alerts.
        cs = (c[3].strip() or (c[52].strip() if len(c) > 52 else ""))
        if cs and "assoc" not in flags:
            flags["assoc"] = cs
            events.append(Event(
                id=f"ev-{sf.file_id}-assoc", time=TimeRef(raw=c[0].strip(), basis="utc", t_s=t, uncertainty_s=1.0, aligned_by="radar_clock"),
                actor=f"ATC radar ({c[1].strip()})", lane="atc", category="atc_comm",
                description=f"TRACON radar track associated with flight plan {cs} (first associated return in playback)",
                parameters=[Param(name="callsign", value=cs)], certainty="measured", source_files=[sf.file_id], verified=True,
                citations=[Citation(file_id=sf.file_id, quote=f"line {ln}: {' '.join(x.strip() for x in c[:7] if x.strip())}", verified=True, score=100)]))
    if rows:
        last_ln, last = rows[-1]
        t_last = clock_seconds(last[0])
        events.append(Event(
            id=f"ev-{sf.file_id}-last", time=TimeRef(raw=last[0].strip(), basis="utc", t_s=t_last, uncertainty_s=1.0, aligned_by="radar_clock"),
            actor=f"ATC radar ({last[1].strip()})", lane="atc", category="aircraft_state",
            description=f"Last radar return ({last[1].strip()}), altitude {last[6].strip()} (hundreds ft)", certainty="measured",
            source_files=[sf.file_id], verified=True, citations=[Citation(file_id=sf.file_id, quote=f"line {last_ln}: {' '.join(x.strip() for x in last[:7])}", verified=True, score=100)]))
    series = [Series(name="altitude_ft_radar", unit="ft", source_file=sf.file_id, points=alt_pts[:: max(1, len(alt_pts) // 3000)]).model_dump()] if alt_pts else []
    return {
        "summary": f"Radar playback: {len(rows)} returns for Mode-S {icao} ({callsign or 'no callsign'}) from sensors {', '.join(sorted(sensors))}; "
                   f"last return {rows[-1][1][0].strip() if rows else '—'}.",
        "events": [e.model_dump() for e in events], "anomalies": [], "entities": [], "facts": [], "series": series,
    }
