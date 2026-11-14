"""Recover the missing hour of MM:SS-only clocks (NTSB ADS-B exports) by matching altitude against the FDR.

For each candidate hour k (0..23) the ADS-B pressure altitude shifted by k*3600 s is compared with the FDR
altitude at the same instants; the k with the smallest median error wins (needs a few dozen overlapping points).
"""
from __future__ import annotations

import numpy as np

from ..schemas import CaseGraph


def _interp(points: list[tuple[float, float]], ts: np.ndarray) -> np.ndarray:
    p = np.array(points, dtype=float)
    out = np.interp(ts, p[:, 0], p[:, 1], left=np.nan, right=np.nan)
    return out


def anchor_mmss(graph: CaseGraph, mmss_files: set[str], track_file: str | None = None) -> dict:
    ref = next((s for s in graph.series if s.name == "altitude_ft" and s.source_file not in mmss_files), None)
    report: dict = {}
    for fid in mmss_files:
        own = next((s for s in graph.series if s.source_file == fid and s.name.startswith("altitude")), None)
        if not own or not ref or len(own.points) < 20:
            report[fid] = "no reference altitude: hour left unresolved"
            continue
        if fid in graph.clocks and own.clock_basis == "utc":
            report[fid] = "already anchored"
            continue
        for s in graph.series:
            if s.source_file == fid:
                s.clock_basis = "unresolved"
        ts = np.array([p[0] for p in own.points]); alt = np.array([p[1] for p in own.points])
        best_k, best_err, n_best = None, float("inf"), 0
        for k in range(0, 24):
            r = _interp(ref.points, ts + k * 3600)
            ok = ~np.isnan(r)
            if ok.sum() < 20:
                continue
            err = float(np.median(np.abs(r[ok] - alt[ok])))
            if err < best_err:
                best_k, best_err, n_best = k, err, int(ok.sum())
        if best_k is None:
            report[fid] = "no overlap with reference"
            continue
        off = best_k * 3600.0
        for s in graph.series:
            if s.source_file == fid:
                s.points = [(t + off, v) for t, v in s.points]
                s.clock_basis = "utc"
        for e in graph.events:
            if e.source_files and e.source_files[0] == fid and e.time.t_s is not None and e.time.aligned_by == "mmss":
                e.time.t_s += off
                e.time.aligned_by = f"mmss+{best_k}h (alt match {best_err:.0f} ft)"
        if track_file == fid:
            for p in graph.track:
                if p.t_s is not None:
                    p.t_s += off
        graph.clocks[fid] = off
        report[fid] = {"hour": best_k, "median_alt_err_ft": round(best_err, 1), "overlap_pts": n_best}
    return report
