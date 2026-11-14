"""Turn raw time strings from docket documents into seconds since 00:00 UTC of the accident date."""
from __future__ import annotations

import re

# "12:38:57", "1238:57" (NTSB CVR style HHMM:SS), "12:38:57.3"
_HMS = re.compile(r"(?<!\d)(\d{1,2}):?(\d{2}):(\d{2}(?:\.\d+)?)(?!\d)")
# "12:38" (no seconds)
_HM = re.compile(r"(?<!\d)(\d{1,2}):(\d{2})(?![\d:])")
_UTC_HINT = re.compile(r"\b(utc|gmt|zulu)\b|\d{4}z\b", re.I)


def clock_seconds(raw: str | None) -> float | None:
    if not raw:
        return None
    m = _HMS.search(raw)
    if m:
        h, mi, s = int(m.group(1)), int(m.group(2)), float(m.group(3))
        if h < 48 and mi < 60 and s < 61:
            return h * 3600 + mi * 60 + s
    m = _HM.search(raw)
    if m:
        h, mi = int(m.group(1)), int(m.group(2))
        if h < 48 and mi < 60:
            return h * 3600 + mi * 60
    return None


def to_case_seconds(raw: str, basis: str, local_utc_offset_h: float) -> tuple[float | None, str]:
    """Returns (t_s, effective_basis). Only utc/local can be converted directly; the rest wait for alignment."""
    s = clock_seconds(raw)
    if s is None:
        return None, basis
    if _UTC_HINT.search(raw):
        basis = "utc"
    if basis == "utc":
        return s, basis
    if basis == "local":
        return s - local_utc_offset_h * 3600, basis
    return None, basis


def fmt(t_s: float | None) -> str:
    if t_s is None:
        return "--:--:--"
    day, rem = divmod(t_s, 86400)
    h, rem = divmod(rem, 3600)
    m, s = divmod(rem, 60)
    prefix = f"D{int(day):+d} " if day else ""
    return f"{prefix}{int(h):02d}:{int(m):02d}:{s:04.1f}"
