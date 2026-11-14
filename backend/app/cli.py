"""Run a case without the web server (precompute the demo).

python -m app.cli ../data/dockets/DCA19MA086 --title "Atlas Air 3591" --ntsb DCA19MA086 --date 2019-02-23 \
    --aircraft "Boeing 767-375BCF" --offset -6
"""
from __future__ import annotations

import argparse
import asyncio
import uuid
from pathlib import Path

from .orchestrator import CaseRunner
from .schemas import CaseConfig
from .store import CaseStore


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--title", default="Untitled case")
    ap.add_argument("--ntsb")
    ap.add_argument("--date")
    ap.add_argument("--aircraft")
    ap.add_argument("--offset", type=float, default=0.0, help="local time = UTC + offset hours")
    ap.add_argument("--no-blind", action="store_true")
    ap.add_argument("--case-id")
    ap.add_argument("--fusion", choices=("team", "investigator", "linker"), default="investigator")
    ap.add_argument("--max-turns", type=int, choices=range(2, 21), default=8)
    a = ap.parse_args()
    cfg = CaseConfig(title=a.title, ntsb_id=a.ntsb, date=a.date, aircraft=a.aircraft,
                     local_utc_offset_h=a.offset, blind_mode=not a.no_blind)
    case_id = a.case_id or f"{a.ntsb or 'case'}-{uuid.uuid4().hex[:6]}"
    store = CaseStore(case_id)
    if not store.meta_path.exists():
        store.create(cfg, raw_dir=Path(a.folder).resolve())
    store.events_path.unlink(missing_ok=True)
    g = asyncio.run(CaseRunner(case_id, fusion=a.fusion, max_turns=a.max_turns).run())
    print(f"case {case_id}: {g.stats}")


if __name__ == "__main__":
    main()
