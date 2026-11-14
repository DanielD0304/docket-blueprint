"""Retrospective, robust FDR change discovery on native samples (no LLM/GPU).

Scores describe rarity within this recording, not failure probabilities or type
limits. No interpolation/forward fill; invalid clocks and recording gaps split
runs. Parsed data-row numbers refer to load_table's output, excluding metadata.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

VERSION = "sensor-layer-v2"
MIN_SAMPLES = 60
SCORE_THRESHOLD = 8.0
MAX_FINDINGS = 40
# Only continuous, dimensioned sensors; switches, selected targets and clocks are
# deliberately excluded. Angular headings are circular and handled separately.
UNITS = {"deg", "g", "ft", "kts", "kt", "%rpm", "degc", "psi", "%full", "v", "tu", "m", "lbs", "fpm", "ft/min"}


@dataclass
class Discovery:
    column: str
    unit: str
    start: int
    end: int
    baseline_start: int
    baseline_end: int
    score: float
    rate: float
    center: float
    scale: float
    horizon: str


def discover_changes(df: pd.DataFrame, times: np.ndarray, *,
                     max_findings: int | None = MAX_FINDINGS, per_channel: int = 3,
                     include_controls: bool = False) -> list[Discovery]:
    """Rank up to 40 episodes, at most three per channel, across two horizons.

    Baseline is the whole recording's change-rate distribution. Robust scale is
    max(MAD*1.4826, IQR/1.349, recorded step / interval, numerical floor).
    The step is capped at 1% of the channel range so an isolated transition
    cannot set its own detection threshold. Floors prevent degenerate scores.
    """
    import re

    units = df.attrs.get("units", {})
    found = []
    for column in df.columns:
        unit = units.get(column, "").strip()
        if unit.lower() not in UNITS or re.search(r"latitude|longitude|^time", column, re.I) or (not include_controls and re.search(
            r"\bsel\b|switch|handle|\bhdl\b|\bmcp\b|gross weight", column, re.I
        )):
            continue
        values = pd.to_numeric(df[column], errors="coerce").to_numpy(dtype=float)
        rows = np.flatnonzero(np.isfinite(times) & np.isfinite(values))
        if len(rows) < MIN_SAMPLES:
            continue
        t, v = times[rows], values[rows]
        dt = np.diff(t)
        positive = dt[dt > 0]
        if len(positive) < MIN_SAMPLES - 1:
            continue
        cadence = float(np.median(positive))
        valid = (dt > 0) & (dt <= 3 * cadence)
        # Unwrap only within uninterrupted runs; do not invent clock order.
        runs = np.r_[0, np.cumsum(~valid)]
        if re.search(r"heading|wind direction|wind dir|drift angle", column, re.I):
            for run in np.unique(runs):
                take = runs == run
                v[take] = np.rad2deg(np.unwrap(np.deg2rad(v[take])))
        steps = np.abs(np.diff(v)[valid])
        steps = steps[steps > 1e-9]
        if not len(steps):
            continue
        resolution = min(float(np.quantile(steps, .1)), .01 * float(np.ptp(v)))
        candidates = []
        horizons = [(1, "native")]
        if cadence < 5:
            horizons.append((max(2, round(5 / cadence)), "~5s"))
        for lag, horizon in horizons:
            if lag >= len(t):
                continue
            ends = np.arange(lag, len(t))
            starts = ends - lag
            ok = (runs[starts] == runs[ends]) & (t[ends] > t[starts])
            starts, ends = starts[ok], ends[ok]
            if len(starts) < MIN_SAMPLES - 1:
                continue
            duration = t[ends] - t[starts]
            rates = (v[ends] - v[starts]) / duration
            center = float(np.median(rates))
            q25, q75 = np.quantile(rates, [.25, .75])
            scale = max(float(np.median(np.abs(rates - center))) * 1.4826,
                        float(q75 - q25) / 1.349, resolution / float(np.median(duration)), max(1.0, float(np.max(np.abs(v)))) * 1e-6)
            scores = np.abs(rates - center) / scale
            # Cluster overlapping flagged intervals; report the peak interval as
            # the evidence window, rather than claiming an unsupported duration.
            hits = np.flatnonzero(scores >= SCORE_THRESHOLD)
            groups = []
            for hit in hits:
                if groups and starts[hit] <= ends[groups[-1][-1]] and runs[starts[hit]] == runs[starts[groups[-1][-1]]]:
                    groups[-1].append(int(hit))
                else:
                    groups.append([int(hit)])
            for group in groups:
                k = max(group, key=lambda x: scores[x])
                candidates.append(Discovery(column, unit, int(rows[starts[k]]), int(rows[ends[k]]),
                    int(rows[0]), int(rows[-1]), float(scores[k]), float(rates[k]), center, scale, horizon))
        # Suppress duplicate horizons for the same episode; maintain a small,
        # deterministic per-channel budget so noisy channels cannot flood fusion.
        selected = []
        for item in sorted(candidates, key=lambda x: (-x.score, x.start, x.horizon)):
            if any(times[item.start] <= times[old.end] + 5 and times[item.end] >= times[old.start] - 5 for old in selected):
                continue
            selected.append(item)
            if len(selected) == per_channel:
                break
        found.extend(selected)
    ranked = sorted(found, key=lambda x: (-x.score, x.column, x.start))
    # Give each channel a place before filling remaining slots with repeats.
    first, rest, seen = [], [], set()
    for item in ranked:
        (rest if item.column in seen else first).append(item)
        seen.add(item.column)
    return (first + rest)[:max_findings]
