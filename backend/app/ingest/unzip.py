"""Safe extraction of uploaded docket archives (handles nested zips, zip-slip, junk entries)."""
from __future__ import annotations

import zipfile
from pathlib import Path

MAX_TOTAL_BYTES = 8 * 1024**3  # 8 GB uncompressed safety cap
_JUNK = ("__MACOSX/", ".DS_Store", "Thumbs.db")


def safe_extract(zip_path: Path, dest: Path, depth: int = 0) -> list[Path]:
    dest.mkdir(parents=True, exist_ok=True)
    out: list[Path] = []
    total = 0
    root = dest.resolve()
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            if info.is_dir() or any(j in info.filename for j in _JUNK):
                continue
            target = (dest / info.filename).resolve()
            if not target.is_relative_to(root):
                continue  # zip-slip
            total += info.file_size
            if total > MAX_TOTAL_BYTES:
                raise ValueError("Archive too large")
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as dst:
                while chunk := src.read(1 << 20):
                    dst.write(chunk)
            if target.suffix.lower() == ".zip" and depth < 2:
                out += safe_extract(target, target.with_suffix(""), depth + 1)
                target.unlink()
            else:
                out.append(target)
    return out
