"""Split PDFs into page-range chunks, snapping to section starts from the outline when possible."""
from __future__ import annotations

from pathlib import Path

from .. import pdfutil


def plan_chunks(path: Path, chunk_pages: int, max_pages: int = 0) -> list[tuple[int, int]]:
    """Returns inclusive 0-based (start, end) page ranges."""
    n = pdfutil.page_count(path)
    starts = pdfutil.toc_starts(path)
    if max_pages:
        n = min(n, max_pages)
    chunks, start = [], 0
    while start < n:
        end = min(n - 1, start + chunk_pages - 1)
        if end < n - 1:
            # snap so the next chunk begins at a section start within +-3 pages
            near = [s - 1 for s in starts if abs((s - 1) - end) <= 3 and s - 1 > start]
            if near:
                end = min(near, key=lambda s: abs(s - end))
        chunks.append((start, end))
        start = end + 1
    return chunks


def subset_pdf(path: Path, start: int, end: int) -> bytes:
    return pdfutil.subset(path, start, end)


def page_texts(path: Path, start: int, end: int) -> list[str]:
    return pdfutil.texts(path, start, end)
