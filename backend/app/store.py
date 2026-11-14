"""File-based case store + live event bus (SSE).

cases/<case_id>/
  meta.json         CaseConfig + raw_dir
  raw/              uploaded / extracted docket files (unless raw_dir points elsewhere)
  atoms/<job>.json  per-job extraction output (resumable, debuggable)
  events.jsonl      every progress event (replayable for offline demos)
  case_graph.json   final fused output
"""
from __future__ import annotations

import asyncio
import json
import time
from collections import defaultdict
from pathlib import Path

from .config import CASES_DIR
from .schemas import CaseConfig, CaseGraph


class CaseStore:
    def __init__(self, case_id: str):
        self.case_id = case_id
        self.root = CASES_DIR / case_id
        self.atoms_dir = self.root / "atoms"
        self.meta_path = self.root / "meta.json"
        self.events_path = self.root / "events.jsonl"
        self.graph_path = self.root / "case_graph.json"

    def create(self, config: CaseConfig, raw_dir: Path | None = None) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.atoms_dir.mkdir(exist_ok=True)
        meta = {"config": config.model_dump(), "raw_dir": str(raw_dir or (self.root / "raw")), "created": time.time()}
        self.meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    @property
    def meta(self) -> dict:
        return json.loads(self.meta_path.read_text(encoding="utf-8"))

    @property
    def raw_dir(self) -> Path:
        return Path(self.meta["raw_dir"])

    @property
    def config(self) -> CaseConfig:
        return CaseConfig(**self.meta["config"])

    def save_graph(self, graph: CaseGraph) -> None:
        tmp = self.graph_path.with_suffix(".tmp")
        tmp.write_text(graph.model_dump_json(indent=1), encoding="utf-8")
        tmp.replace(self.graph_path)

    def load_graph(self) -> CaseGraph | None:
        if not self.graph_path.exists():
            return None
        return CaseGraph.model_validate_json(self.graph_path.read_text(encoding="utf-8"))

    def save_atoms(self, job_id: str, payload: dict) -> None:
        (self.atoms_dir / f"{job_id}.json").write_text(json.dumps(payload, indent=1, default=str), encoding="utf-8")

    def load_atoms(self, job_id: str) -> dict | None:
        p = self.atoms_dir / f"{job_id}.json"
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None

    @staticmethod
    def list_cases() -> list[dict]:
        out = []
        for d in sorted(CASES_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            if (d / "meta.json").exists():
                s = CaseStore(d.name)
                g = s.load_graph()
                out.append({"case_id": d.name, "config": s.meta["config"],
                            "status": g.status if g else "created", "stage": g.stage if g else "created"})
        return out


class EventBus:
    """Fan-out of progress events to SSE subscribers, persisted to events.jsonl."""

    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue]] = defaultdict(set)
        self._seq: dict[str, int] = defaultdict(int)

    def publish(self, case_id: str, type_: str, **data) -> None:
        self._seq[case_id] += 1
        msg = {"seq": self._seq[case_id], "type": type_, "ts": time.time(), **data}
        line = json.dumps(msg, default=str)
        with open(CaseStore(case_id).events_path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        for q in list(self._subs[case_id]):
            q.put_nowait(msg)

    def subscribe(self, case_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subs[case_id].add(q)
        return q

    def unsubscribe(self, case_id: str, q: asyncio.Queue) -> None:
        self._subs[case_id].discard(q)


bus = EventBus()
