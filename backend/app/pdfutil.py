"""PDF helpers on pypdf (pure Python — PyMuPDF's DLL is blocked by Windows application control on this machine).

Swap the internals for PyMuPDF on Linux/Mac if you need speed; keep this interface.
"""
from __future__ import annotations

import io
import logging
from functools import lru_cache
from pathlib import Path

from pypdf import PdfReader, PdfWriter

logging.getLogger("pypdf").setLevel(logging.ERROR)


@lru_cache(maxsize=64)
def _reader(path: str) -> PdfReader:
    return PdfReader(path, strict=False)


def page_count(path: Path) -> int:
    return len(_reader(str(path)).pages)


@lru_cache(maxsize=8192)
def page_text(path: str, i: int) -> str:
    try:
        return _reader(path).pages[i].extract_text() or ""
    except Exception:
        return ""


def texts(path: Path, start: int, end: int) -> list[str]:
    return [page_text(str(path), i) for i in range(start, end + 1)]


def subset(path: Path, start: int, end: int) -> bytes:
    r = _reader(str(path))
    w = PdfWriter()
    for i in range(start, end + 1):
        w.add_page(r.pages[i])
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def toc_starts(path: Path) -> list[int]:
    """0-based page indices where outline entries start."""
    r = _reader(str(path))
    out: set[int] = set()

    def walk(items):
        for it in items:
            if isinstance(it, list):
                walk(it)
            else:
                try:
                    p = r.get_destination_page_number(it)
                    if isinstance(p, int) and p >= 0:
                        out.add(p)
                except Exception:
                    pass

    try:
        walk(r.outline)
    except Exception:
        pass
    return sorted(out)
