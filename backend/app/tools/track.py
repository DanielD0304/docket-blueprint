"""ADS-B / radar CSV -> flight track, altitude series and ADS-B v2 autopilot discretes.

NTSB ADS-B exports (e.g. DCA19MA086 #48) carry only MM:SS times; the hour is recovered later by
fusion.clock_anchor (matching altitude against the FDR). Those times are flagged aligned_by="mmss".
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from ..schemas import Citation, Event, Param, Series, SourceFile, TimeRef
from .table import find_col, load_table, numeric, time_seconds

ADSB_DISCRETES = ["AutoPilot", "AltHold", "VNav", "LNav", "Approach", "SelAlt", "TcasRa", "EmerPriStat"]


def analyze_track(path: Path, sf: SourceFile, local_utc_offset_h: float = 0.0, max_points: int = 3000) -> dict:
    df = load_table(path)
    # keep the main target only (exports sometimes include other traffic)
    for idc in ("ModeSId", "FlightId", "ICAO", "Callsign"):
        if idc in df.columns and df[idc].notna().any():
            main = df[idc].astype(str).str.strip().value_counts().index[0]
            df = df[df[idc].astype(str).str.strip() == main].reset_index(drop=True)
            break
    lat_c = find_col(df, r"^latdeg$|^latitude$", r"^lat")
    lon_c = find_col(df, r"^londeg$|^longitude$", r"^lon", r"^lng")
    alt_c = find_col(df, r"^pressalt$|press.*alt", r"baro.*alt|^altitude$|\balt\b", exclude=r"rate|sel|delta")
    gs_c = find_col(df, r"^grndspd$|ground ?speed|\bgs\b")
    if not (lat_c and lon_c):
        return {"summary": "No lat/lon columns found", "events": [], "anomalies": [], "entities": [], "facts": [], "track": [], "series": []}
    t, basis, tcol = time_seconds(df)
    if basis == "local" and t is not None:
        t, basis = t - local_utc_offset_h * 3600, "utc"
    timed = t is not None and basis in ("utc", "mmss")
    lat, lon = numeric(df, lat_c), numeric(df, lon_c)
    alt = numeric(df, alt_c) if alt_c else pd.Series(np.nan, index=df.index)
    gs = numeric(df, gs_c) if gs_c else pd.Series(np.nan, index=df.index)
    ok = np.where(lat.notna() & lon.notna() & (lat.abs() > 0.01))[0]
    idx = ok[np.unique(np.linspace(0, len(ok) - 1, min(max_points, len(ok))).astype(int))] if len(ok) else ok
    track = [{"t_s": float(t.iloc[i]) if timed and pd.notna(t.iloc[i]) else None, "lat": float(lat.iloc[i]), "lon": float(lon.iloc[i]),
              "alt_ft": None if pd.isna(alt.iloc[i]) else float(alt.iloc[i]), "gs_kt": None if pd.isna(gs.iloc[i]) else float(gs.iloc[i])} for i in idx]
    series = []
    if timed and alt_c:
        a = alt.iloc[ok]
        pts = [(float(t.iloc[i]), float(a[i])) for i in ok if pd.notna(a[i]) and pd.notna(t.iloc[i])]
        if pts:
            series.append(Series(name="altitude_ft_adsb", unit="ft", source_file=sf.file_id, points=pts[:: max(1, len(pts) // 3000)]).model_dump())

    # ADS-B v2 autopilot / MCP discretes -> transition events (great for the autoflight card)
    events = []
    if timed:
        for col in [c for c in ADSB_DISCRETES if c in df.columns]:
            s = df[col].dropna().astype(str).str.strip()
            s = s[s != ""]
            if s.empty or s.nunique() > 30:
                continue
            prev = s.shift()
            for i in s.index[(s != prev) & prev.notna()][:80]:
                p = s.index.get_loc(i)
                events.append(Event(
                    id=f"ev-{sf.file_id}-a{len(events)}",
                    time=TimeRef(raw=str(df[tcol].iloc[i]), basis="utc", t_s=float(t.iloc[i]), uncertainty_s=1.0,
                                 aligned_by="mmss" if basis == "mmss" else "adsb_clock"),
                    actor="ADS-B", lane="systems", category="system_event",
                    description=f"ADS-B {col}: {s.iloc[p - 1]} → {s.iloc[p]}", parameters=[Param(name=f"ADS-B {col}", value=s.iloc[p])],
                    certainty="measured", source_files=[sf.file_id], verified=True,
                    citations=[Citation(file_id=sf.file_id, quote=f"row {i + 1}, column '{col}': {s.iloc[p - 1]} -> {s.iloc[p]}", verified=True, score=100)],
                ).model_dump())
    return {
        "summary": f"Track: {len(track)} points ({lat_c}/{lon_c}/{alt_c}), clock {basis}"
                   f"{' (hour recovered in fusion)' if basis == 'mmss' else ''}; {len(events)} ADS-B autopilot/MCP transitions.",
        "events": events, "anomalies": [], "entities": [], "facts": [],
        "track": track, "track_rank": 2, "clock": basis,
        "series": series,
    }
