"""Re-run fusion from immutable base extractions into a separate experiment case.

python -m app.refuse --from-case atlas-3591 --case-id atlas-investigator-v1 --max-turns 8
MOCK_LLM=1 python -m app.refuse --from-case atlas-3591 --case-id test-investigator-mock
python -m app.refuse --from-case atlas-3591 --case-id atlas-linker-baseline --fusion linker
"""
from __future__ import annotations

import argparse
import asyncio
import re

from .orchestrator import CaseRunner
from .store import CaseStore


def prepare_fusion_run(source_id: str, target_id: str) -> None:
    for value in (source_id, target_id):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,119}", value):
            raise ValueError("Case IDs must contain only letters, numbers, underscores and hyphens")
    if source_id == target_id:
        raise ValueError("Choose a new case ID; the original case must be preserved")
    source, target = CaseStore(source_id), CaseStore(target_id)
    if not source.meta_path.exists():
        raise ValueError("Source case does not exist")
    if target.root.exists():
        raise ValueError("Target case already exists; choose a new experiment ID")
    if not (source.root / "extractions.json").exists():
        graph = source.load_graph()
        if not graph or graph.status != "done":
            raise ValueError("Wait for source extraction to finish before re-running fusion")
    target.create(source.config, raw_dir=source.raw_dir)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from-case", required=True)
    parser.add_argument("--case-id", required=True)
    parser.add_argument("--fusion", choices=("investigator", "linker"), default="investigator")
    parser.add_argument("--max-turns", type=int, choices=range(2, 21), default=8)
    args = parser.parse_args()
    try:
        prepare_fusion_run(args.from_case, args.case_id)
        runner = CaseRunner(args.case_id, fusion=args.fusion, max_turns=args.max_turns)
        graph = asyncio.run(runner.run(from_case=args.from_case))
    except ValueError as exc:
        parser.error(str(exc))
    print(f"case {args.case_id}: {graph.stats}")


if __name__ == "__main__":
    main()
