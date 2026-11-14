"""Download a public NTSB docket into data/dockets/<NTSB number>/.

python scripts/fetch_docket.py DCA19MA086 [--skip-ext ppb,mp4] [--list]

Files are saved as "<item> - <TITLE>.<ext>" so the triage heuristics see the docket item number and title.
A manifest.json with item/title/url/size is written alongside.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

BASE = "https://data.ntsb.gov"
UA = {"User-Agent": "docket-blueprint/0.1 (hackathon research tool)"}


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def list_items(ntsb: str) -> list[dict]:
    page = get(f"{BASE}/Docket/?NTSBNumber={ntsb}").decode("utf-8", "replace")
    items = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", page, re.S | re.I):
        m = re.search(r'href="([^"]*docBLOB\?[^"]+)"', row)
        if not m:
            continue
        cells = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip() for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S | re.I)]
        url = html.unescape(m.group(1))
        if url.startswith("/"):
            url = BASE + url
        ext = re.search(r"FileExtension=([^&]+)", url).group(1).lower()
        try:
            item = int(cells[0])
        except (ValueError, IndexError):
            item = len(items) + 1
        title = cells[1] if len(cells) > 1 else f"ITEM {item}"
        items.append({"item": item, "title": title, "ext": ext, "url": url})
    return items


def safe(s: str) -> str:
    s = s.replace("’", "'").encode("ascii", "ignore").decode()
    return re.sub(r'[<>:"/\\|?*]+', "_", s).strip()[:120]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("ntsb")
    ap.add_argument("--out", default=None)
    ap.add_argument("--skip-ext", default="")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()
    root = Path(__file__).resolve().parents[1]
    out = Path(a.out) if a.out else root / "data" / "dockets" / a.ntsb
    items = list_items(a.ntsb)
    if not items:
        sys.exit("No docket items found (page layout changed?)")
    if a.list:
        for it in items:
            print(it["item"], it["ext"], it["title"])
        return
    out.mkdir(parents=True, exist_ok=True)
    skip = {x.strip().lower() for x in a.skip_ext.split(",") if x.strip()}
    for it in items:
        name = f"{it['item']:02d} - {safe(it['title'])}.{it['ext']}"
        it["file"] = name
        dest = out / name
        if it["ext"] in skip:
            it["skipped"] = True
            continue
        if dest.exists() and dest.stat().st_size > 0:
            it["size"] = dest.stat().st_size
            continue
        for attempt in range(3):
            try:
                t0 = time.time()
                tmp = dest.with_suffix(dest.suffix + ".part")
                req = urllib.request.Request(it["url"], headers=UA)
                with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
                    while chunk := r.read(1 << 20):
                        f.write(chunk)
                tmp.replace(dest)
                it["size"] = dest.stat().st_size
                print(f"[{it['item']:02d}] {it['size'] / 1e6:7.1f} MB  {time.time() - t0:5.1f}s  {name}", flush=True)
                break
            except Exception as e:
                print(f"[{it['item']:02d}] retry {attempt + 1}: {e}", flush=True)
                time.sleep(3)
        time.sleep(0.3)  # be polite
    (out / "manifest.json").write_text(json.dumps(items, indent=1), encoding="utf-8")
    print("done", out)


if __name__ == "__main__":
    main()
