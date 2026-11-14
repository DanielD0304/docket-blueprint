"""Walk the raw docket folder, fingerprint files, detect kind, text layer, docket item number."""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

from .. import pdfutil
from ..schemas import SourceFile

KIND_BY_EXT = {
    ".pdf": "pdf",
    ".csv": "table", ".xlsx": "table", ".xls": "table", ".tsv": "table",
    ".jpg": "image", ".jpeg": "image", ".png": "image", ".tif": "image", ".tiff": "image", ".gif": "image", ".bmp": "image",
    ".wav": "audio", ".mp3": "audio", ".m4a": "audio",
    ".mp4": "video", ".wmv": "video", ".mov": "video", ".avi": "video",
    ".txt": "text", ".htm": "text", ".html": "text", ".docx": "text", ".kml": "text",
    ".zip": "archive",
}
_ITEM = re.compile(r"^\s*(\d{1,3})(?:[\s_\-.]|$)")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def pdf_text_stats(path: Path) -> tuple[int, float]:
    n = pdfutil.page_count(path)
    sample = list(range(0, n, max(1, n // 8)))[:8]
    chars = [len(pdfutil.page_text(str(path), i).strip()) for i in sample]
    return n, (sum(chars) / len(chars)) if chars else 0.0


def inventory(raw_dir: Path) -> list[SourceFile]:
    files: list[SourceFile] = []
    seen: set[str] = set()
    for p in sorted(raw_dir.rglob("*")):
        if not p.is_file():
            continue
        digest = sha256(p)
        if digest in seen:
            continue  # exact duplicate
        seen.add(digest)
        ext = p.suffix.lower()
        kind = KIND_BY_EXT.get(ext, "other")
        m = _ITEM.match(p.stem)
        sf = SourceFile(
            file_id=digest[:12], name=p.name, rel_path=str(p.relative_to(raw_dir)).replace("\\", "/"),
            kind=kind, ext=ext, size=p.stat().st_size, sha256=digest,
            docket_item=int(m.group(1)) if m else None,
        )
        if kind == "pdf":
            try:
                sf.pages, sf.text_chars_per_page = pdf_text_stats(p)
                sf.scanned = sf.text_chars_per_page < 50
            except Exception as e:  # corrupt PDF
                sf.status, sf.error = "error", f"unreadable pdf: {e}"
        files.append(sf)
    return files
