"""Robust loader for NTSB tabular attachments (FDR CSV/XLSX, ADS-B CSV).

Real NTSB FDR exports look like:
  6 metadata lines ("NTSB DCA19MA086, Attachment 1 ...", "Operator: ...")
  header line      Time,A/P Alt Mode,...,Pitch Angle,...
  units line       (CST),(),(deg),(ft),...
  enum line        ,"%N(0:0=""Off"",1:1=""Engaged"")",...
  data             sparse rows at 1/64 s, each row carries only the parameters sampled at that instant
The units are kept in df.attrs["units"]; the time unit tells us whether the clock is local (CST) or UTC.
"""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import pandas as pd

from ..timeparse import clock_seconds

_TIMEISH = re.compile(r"^\s*\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*$|^\s*-?\d+(\.\d+)?\s*$")


def _header_line(path: Path) -> int:
    """Index of the line with the most name-like cells (letters first, not '(unit)' or '%N(...)' enums)."""
    import csv

    with open(path, encoding="latin-1", errors="replace", newline="") as f:
        lines = [f.readline() for _ in range(40)]
    best, idx = 0, 0
    for i, row in enumerate(csv.reader(lines)):
        if not row:
            continue
        if _TIMEISH.match(row[0] or "x"):
            break  # reached data
        score = sum(1 for c in row if re.match(r"^\s*[A-Za-z]", c) and not c.strip().startswith("%"))
        if score > best:
            best, idx = score, i
    return idx


def load_table(path: Path) -> pd.DataFrame:
    if path.suffix.lower() in (".xlsx", ".xls"):
        df = pd.read_excel(path)
    else:
        df = pd.read_csv(path, header=_header_line(path), encoding="latin-1", low_memory=False, on_bad_lines="skip")
    df = df.dropna(axis=1, how="all")
    df.columns = [str(c).strip() for c in df.columns]
    units: dict[str, str] = {}
    # strip units / enum rows until the first row whose first cell looks like data
    first = df.columns[0]
    drop = 0
    for i in range(min(4, len(df))):
        v = str(df.iloc[i][first]) if pd.notna(df.iloc[i][first]) else ""
        row = df.iloc[i].astype(str)
        if _TIMEISH.match(v):
            break
        if v.startswith("(") or row.str.match(r"^\(.*\)$").mean() > 0.3:
            units = {c: str(u).strip("()") for c, u in df.iloc[i].items() if isinstance(u, str)}
        drop = i + 1
    if drop:
        df = df.iloc[drop:].reset_index(drop=True)
    df.attrs["units"] = units
    return df


def find_col(df: pd.DataFrame, *patterns: str, exclude: str | None = None) -> str | None:
    for pat in patterns:
        for c in df.columns:
            if re.search(pat, c, re.I) and not (exclude and re.search(exclude, c, re.I)):
                return c
    return None


def numeric(df: pd.DataFrame, col: str) -> pd.Series:
    return pd.to_numeric(df[col], errors="coerce")


_LOCAL_UNITS = re.compile(r"\b(cst|cdt|est|edt|pst|pdt|mst|mdt|akst|hst|local|lcl)\b", re.I)


def time_seconds(df: pd.DataFrame) -> tuple[pd.Series | None, str, str | None]:
    """Returns (seconds series, basis, column name). basis: utc | local | mmss | fdr_subframe | unknown."""
    col = next((c for c in df.columns if c.lower() in ("time", "utc time", "time (utc)", "gmt")), None) \
        or find_col(df, r"^time", r"\butc\b", r"gmt", r"timestamp")
    if col is None:
        return None, "unknown", None
    raw = df[col].astype(str).str.strip()
    sample = raw[raw.ne("nan") & raw.ne("")].head(200)
    unit = df.attrs.get("units", {}).get(col, "")
    # MM:SS.s only (e.g. ADS-B exports): hour must be recovered later
    if len(sample) and sample.str.match(r"^\d{1,2}:\d{2}(\.\d+)?$").mean() > 0.9:
        mm = raw.str.extract(r"^(\d{1,2}):(\d{2}(?:\.\d+)?)$").astype(float)
        s = (mm[0] * 60 + mm[1]).to_numpy()
        out = np.full(len(s), np.nan)
        hour, prev = 0, None
        for i, v in enumerate(s):
            if np.isnan(v):
                continue
            if prev is not None and v < prev - 1800:
                hour += 1
            prev = v
            out[i] = v + hour * 3600
        return pd.Series(out, index=df.index).ffill(), "mmss", col
    num = pd.to_numeric(raw, errors="coerce")
    if num.notna().mean() > 0.8:
        return num, "fdr_subframe", col
    parsed = raw.map(lambda s: clock_seconds(s) if s and s != "nan" else np.nan).astype(float)
    if parsed.notna().mean() > 0.5:
        basis = "local" if _LOCAL_UNITS.search(unit) or _LOCAL_UNITS.search(col) else "utc"
        return parsed.ffill(), basis, col
    return None, "unknown", col
