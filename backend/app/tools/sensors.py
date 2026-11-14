"""Independent sensor states and candidates, computed from native FDR rows.

States are descriptive statistical regimes, never inferred aircraft modes or
sensor health diagnoses. Missing sparse cells are not outages; elapsed gaps
between actual observations are reported separately. No interpolation is used.
"""
from __future__ import annotations

import re
from hashlib import sha256

import numpy as np
import pandas as pd

from ..schemas import Citation, SensorAnalysis, SensorFinding, SensorState
from .discovery import UNITS, VERSION, discover_changes

MAX_STATES = 2000
MAX_PER_DETECTOR = 12


def analyze_sensors(df: pd.DataFrame, times: np.ndarray, source_file: str, *,
                    clock_resolved: bool, time_column: str | None = None) -> list[SensorAnalysis]:
    units = df.attrs.get("units", {})
    changes = discover_changes(df, times, max_findings=None, per_channel=MAX_PER_DETECTOR,
                               include_controls=True) if clock_resolved else []
    output = []
    for column in df.columns:
        if column == time_column or re.search(r"^time\b", column, re.I):
            continue
        sid = f"sensor-{source_file}-{sha256(column.encode()).hexdigest()[:12]}"
        raw = df[column]
        valid = raw.notna().to_numpy() & np.isfinite(times)
        rows = np.flatnonzero(valid)
        unit = units.get(column, "").strip()
        numeric = pd.to_numeric(raw, errors="coerce").to_numpy(dtype=float)
        # Units distinguish a continuous sensor from a numeric encoded switch.
        is_numeric = bool(len(rows) and np.isfinite(numeric[rows]).all())
        kind = "continuous" if is_numeric and unit.lower() in UNITS else "discrete"
        if kind == "discrete" and raw.dropna().nunique() > 32:
            kind = "unsupported"

        def citation(a: int, b: int, detail: str) -> Citation:
            return Citation(file_id=source_file, quote=f"Parsed data rows {a + 1}-{b + 1}, column '{column}': {detail}",  # noqa: B023 (called within this iteration)
                            verified=True, score=100)

        analysis = SensorAnalysis(sensor_id=sid, source_file=source_file, column=column, unit=unit,
            kind=kind, status="analyzed", samples=len(rows), method=VERSION,
            limitations=["Retrospective per-recording baseline; candidates are not faults or probabilities.",
                         "State bounds are observed sample times; no state is asserted across recording gaps.",
                         f"At most {MAX_PER_DETECTOR} findings per detector per sensor are retained; no global sensor cap."],
            citations=[citation(int(rows[0]), int(rows[-1]), f"{len(rows)} clocked samples; metadata excluded")]
                if len(rows) else [Citation(file_id=source_file, quote=f"Column '{column}': no samples with a finite clock", verified=True, score=100)])
        output.append(analysis)
        if not clock_resolved:
            analysis.status = "unresolved_clock"
            continue
        if not len(rows):
            analysis.status = "no_samples"
            continue
        if kind == "unsupported":
            analysis.status = "unsupported"
            analysis.limitations.append("High-cardinality channel without supported continuous units; no numeric assumptions made.")
            continue
        t = times[rows]
        dt = np.diff(t)
        positive = dt[dt > 0]
        cadence = float(np.median(positive)) if len(positive) else None
        analysis.cadence_s = cadence
        if len(rows) < 2 or cadence is None:
            analysis.status = "insufficient_samples"
            continue
        boundary = (dt <= 0) | (dt > 3 * cadence)
        analysis.plot_gaps = [(float(t[k]), float(t[k + 1])) for k in np.flatnonzero(dt > 3 * cadence)]
        runs = np.r_[0, np.cumsum(boundary)]
        for k in np.flatnonzero(dt > 3 * cadence)[:MAX_PER_DETECTOR]:
            analysis.findings.append(SensorFinding(id=f"{sid}:gap:{int(rows[k])}", kind="sampling_gap",
                start_s=float(t[k]), end_s=float(t[k + 1]),
                description=f"{column}: {dt[k]:g}s between observed samples versus median cadence {cadence:g}s; not proof of sensor failure.",
                citations=[citation(int(rows[k]), int(rows[k + 1]), f"sample gap {dt[k]:g}s; threshold >3×{cadence:g}s")]))
        if kind == "continuous":
            v = numeric[rows].copy()
            circular = bool(re.search(r"heading|wind direction|wind dir|drift angle|longitude", column, re.I)) and unit.lower() == "deg"
            for run in np.unique(runs):
                take = runs == run
                if circular:
                    v[take] = np.rad2deg(np.unwrap(np.deg2rad(v[take])))
            good = ~boundary
            rates = np.diff(v)[good] / dt[good]
            floor = max(1.0, float(np.ptp(v))) * 1e-6
            typical_rate = float(np.median(np.abs(rates))) if len(rates) else 0.0
            steps = np.abs(np.diff(v)[good])
            steps = steps[steps > floor]
            resolution = min(float(np.quantile(steps, .1)), .01 * float(np.ptp(v))) if len(steps) else floor
            # State thresholds reflect this channel's activity and quantization.
            slope_threshold = max(typical_rate * .5, resolution / max(5., cadence), floor)
            analysis.limitations.append(f"States use {max(5., cadence * 2):g}s observed-time windows; slope threshold={slope_threshold:g} {unit}/s; circular channels unwrapped per run.")
            blocks = []
            for run in np.unique(runs):
                indices = np.flatnonzero(runs == run)
                # Fixed observed-time windows; low-rate sensors use pairs.
                bins = np.floor((t[indices] - t[indices[0]]) / max(5., cadence * 2)).astype(int)
                cuts = np.r_[0, np.flatnonzero(np.diff(bins)) + 1, len(indices)]
                for a, b in zip(cuts[:-1], cuts[1:]):
                    ix = indices[a:b]
                    if len(ix) < 2:
                        label = "insufficient_samples"
                    else:
                        delta = np.diff(v[ix])
                        rate = float((v[ix[-1]] - v[ix[0]]) / (t[ix[-1]] - t[ix[0]]))
                        travel = float(np.sum(np.abs(delta)))
                        coherence = abs(float(v[ix[-1]] - v[ix[0]])) / travel if travel > floor else 1.
                        if travel <= resolution * max(1, len(ix) - 1) and abs(rate) <= slope_threshold:
                            label = "stable"
                        elif coherence < .5:
                            label = "variable"
                        elif rate > slope_threshold:
                            label = "rising"
                        elif rate < -slope_threshold:
                            label = "falling"
                        else:
                            label = "variable"
                    # Include the preceding sample in the trend decision at a
                    # window boundary, so a jump exactly on a bin edge is seen.
                    first = int(ix[0])
                    if first > 0 and runs[first - 1] == run:
                        edge_rate = (v[first] - v[first - 1]) / (t[first] - t[first - 1])
                        if abs(edge_rate) > max(slope_threshold * 8, floor):
                            label = "rising" if edge_rate > 0 else "falling"
                    blocks.append((first, int(ix[-1]), label, int(run)))
            # Level rarity: contiguous excursions, split by clock/gap boundaries.
            # Circular absolute levels have no unique linear reference.
            if len(rows) >= 60 and not circular:
                center = float(np.median(v))
                q25, q75 = np.quantile(v, [.25, .75])
                scale = max(float(np.median(np.abs(v - center))) * 1.4826,
                            float(q75 - q25) / 1.349, resolution, floor)
                score = np.abs(v - center) / scale
                hits = score >= 8
                starts = np.flatnonzero(hits & np.r_[True, ~hits[:-1] | boundary])
                ends = np.flatnonzero(hits & np.r_[~hits[1:] | boundary, True])
                episodes = sorted(zip(starts, ends), key=lambda ab: (-float(np.max(score[ab[0]:ab[1] + 1])), int(ab[0])))
                for a, b in episodes[:MAX_PER_DETECTOR]:
                    peak = a + int(np.argmax(score[a:b + 1]))
                    detail = f"{column}: rare level {v[peak]:g} {unit}; median={center:g}, robust scale={scale:g}, score={score[peak]:.2f} >=8. Flight phase or artifacts may explain it."
                    analysis.findings.append(SensorFinding(id=f"{sid}:level:{int(rows[a])}", kind="level_outlier",
                        start_s=float(t[a]), end_s=float(t[b]), score=float(score[peak]), description=detail,
                        citations=[citation(int(rows[a]), int(rows[b]), detail),
                                   citation(int(rows[0]), int(rows[-1]), "whole-recording level baseline; scale=max(1.4826*MAD,IQR/1.349,capped-step,numerical-floor)")]))
            for hit in (h for h in changes if h.column == column):
                detail = (f"{column}: {hit.horizon} change {hit.rate:g} {unit}/s; "
                          f"median={hit.center:g}, scale={hit.scale:g}, score={hit.score:.2f} >=8; not an operating-limit test.")
                analysis.findings.append(SensorFinding(id=f"{sid}:change:{hit.start}", kind="unusual_change",
                    start_s=float(times[hit.start]), end_s=float(times[hit.end]), score=hit.score, description=detail,
                    citations=[citation(hit.start, hit.end, detail), citation(hit.baseline_start, hit.baseline_end,
                        "whole-recording rate baseline; scale=max(1.4826*MAD,IQR/1.349,capped-step/interval,numerical-floor)")]))
            chosen = np.unique(np.linspace(0, len(rows) - 1, min(2000, len(rows))).astype(int))
            analysis.points = [(float(t[k]), float(numeric[rows[k]])) for k in chosen]
        else:
            values = raw.iloc[rows].astype(str).str.strip().to_numpy()
            cuts = np.r_[0, np.flatnonzero((values[1:] != values[:-1]) | boundary) + 1, len(rows)]
            blocks = [(int(a), int(b - 1), str(values[a]), int(runs[a])) for a, b in zip(cuts[:-1], cuts[1:])]
            v = None
        merged = []
        for a, b, label, run in blocks:
            same_level = (v is None or label != "stable" or not merged or
                          abs(float(np.median(v[a:b + 1])) - float(np.median(v[merged[-1][0]:merged[-1][1] + 1]))) <= max(resolution * 2, floor))
            if merged and merged[-1][2:] == (label, run) and same_level:
                merged[-1] = (merged[-1][0], b, label, run)
            else:
                merged.append((a, b, label, run))
        if len(merged) > MAX_STATES:
            analysis.limitations.append(f"State output truncated: first {MAX_STATES} of {len(merged)} intervals retained.")
        for a, b, label, _ in merged[:MAX_STATES]:
            detail = f"{VERSION}; {kind} state '{label}', {b - a + 1} observed samples; descriptive, not a health diagnosis"
            evidence_a = a - 1 if a > 0 and runs[a - 1] == runs[a] else a
            analysis.states.append(SensorState(id=f"{sid}:state:{int(rows[a])}", label=label,
                start_s=float(t[a]), end_s=float(t[b]), first_row=int(rows[a]) + 1, last_row=int(rows[b]) + 1,
                samples=b - a + 1, minimum=float(np.min(v[a:b + 1])) if v is not None else None,
                maximum=float(np.max(v[a:b + 1])) if v is not None else None,
                median=float(np.median(v[a:b + 1])) if v is not None else None,
                citations=[citation(int(rows[evidence_a]), int(rows[b]), detail + "; preceding sample included when available for boundary-change detection")]))
        if len(rows) < 60:
            analysis.status = "insufficient_samples"
            analysis.limitations.append("Fewer than 60 samples: states available, statistical anomaly baselines withheld.")
        analysis.findings.sort(key=lambda f: (f.start_s, f.id))
    return output
