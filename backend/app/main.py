"""FastAPI app: upload a docket, watch the swarm live (SSE), fetch the fused case graph and source files."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from .config import CASES_DIR, DATA_DIR, DEMO_CASE_ID, DEMO_MODE, DOCKETS_DIR, MOCK_LLM, MODEL_FAST, MODEL_PRO
from .ingest.unzip import safe_extract
from .fusion.clock_anchor import resolve_live_clocks
from .orchestrator import CaseRunner
from .refuse import prepare_fusion_run
from .schemas import CaseConfig
from typing import Literal
from .store import CaseStore, bus

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
app = FastAPI(title="Docket Blueprint")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_tasks: dict[str, asyncio.Task] = {}


@app.on_event("startup")
def _mark_interrupted_runs() -> None:
    """A server restart kills running pipelines. Without this, their cases stay "running" forever and the UI
    keeps counting their open jobs as active agents. Close those jobs and mark the case interrupted;
    "Re-run" resumes from the per-job cache."""
    for d in CASES_DIR.iterdir() if CASES_DIR.exists() else []:
        store = CaseStore(d.name)
        if not store.meta_path.exists():
            continue
        g = store.load_graph()
        # "running": killed hard (no chance to save). "error ... interrupted": the orchestrator's own
        # CancelledError handler saved the status on a clean shutdown, but job events may still be open.
        interrupted_cleanly = bool(g) and g.status == "error" and "interrupt" in str(g.stats.get("error", "")).lower()
        if not g or (g.status != "running" and not interrupted_cleanly):
            continue
        open_jobs: dict[str, dict] = {}
        if store.events_path.exists():
            for line in store.events_path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    m = json.loads(line)
                    if m.get("type") == "job":
                        open_jobs[m["job_id"]] = m
        still_open = [(job_id, m) for job_id, m in open_jobs.items() if m.get("status") == "running"]
        for job_id, m in still_open:
            bus.publish(d.name, "job", job_id=job_id, file_id=m.get("file_id"), status="interrupted")
        if interrupted_cleanly:
            continue  # status already persisted by the orchestrator
        g.status, g.stage = "error", "interrupted"
        g.stats["error"] = "interrupted by a backend restart; use Re-run (finished jobs are reused from the cache)"
        store.save_graph(g)
        bus.publish(d.name, "error", error=g.stats["error"])
        logging.getLogger(__name__).warning("case %s was interrupted by a restart; marked as such", d.name)


def _new_case_id(cfg: CaseConfig) -> str:
    base = re.sub(r"[^A-Za-z0-9]+", "-", cfg.ntsb_id or "case").strip("-")
    return f"{base}-{uuid.uuid4().hex[:6]}"


def _start(case_id: str) -> None:
    if case_id in _tasks and not _tasks[case_id].done():
        raise HTTPException(409, "case already running")
    _tasks[case_id] = asyncio.create_task(CaseRunner(case_id).run())


@app.get("/api/health")
def health():
    return {"ok": True, "mock": MOCK_LLM, "demo": DEMO_MODE, "demo_case_id": DEMO_CASE_ID if DEMO_MODE else None,
            "models": {"fast": MODEL_FAST, "pro": MODEL_PRO}, "data_dir": str(DATA_DIR)}


def _demo_intake():
    store = CaseStore(DEMO_CASE_ID)
    graph = store.load_graph()
    if graph is None or graph.status != "done" or not store.events_path.exists() or not store.events_path.stat().st_size:
        raise HTTPException(409, "Demo requires a completed DEMO_CASE_ID with saved events")
    return {"case_id": DEMO_CASE_ID, "demo": True}


@app.post("/api/cases")
async def create_case(
    files: list[UploadFile] = File(...),
    title: str = Form("Untitled case"),
    ntsb_id: str | None = Form(None),
    date: str | None = Form(None),
    aircraft: str | None = Form(None),
    local_utc_offset_h: float = Form(0.0),
    blind_mode: bool = Form(True),
):
    if DEMO_MODE:
        return _demo_intake()
    cfg = CaseConfig(title=title, ntsb_id=ntsb_id, date=date, aircraft=aircraft,
                     local_utc_offset_h=local_utc_offset_h, blind_mode=blind_mode)
    case_id = _new_case_id(cfg)
    store = CaseStore(case_id)
    store.create(cfg)
    raw = store.raw_dir
    raw.mkdir(parents=True, exist_ok=True)
    for up in files:
        name = Path(up.filename or "upload.bin").name
        dest = raw / name
        with open(dest, "wb") as out:
            shutil.copyfileobj(up.file, out)
        if dest.suffix.lower() == ".zip":
            await asyncio.to_thread(safe_extract, dest, raw / dest.stem)
            dest.unlink()
    _start(case_id)
    return {"case_id": case_id}


class LocalCase(BaseModel):
    path: str
    config: CaseConfig = CaseConfig()


@app.post("/api/cases/local")
async def create_local_case(body: LocalCase):
    """Point at an already-downloaded docket folder (no copy). Handy for the 1 GB+ dockets."""
    if DEMO_MODE:
        return _demo_intake()
    p = Path(body.path).expanduser()
    if not p.is_absolute():  # short names like "DCA19MA086" are looked up in DATA_DIR/dockets
        p = DOCKETS_DIR / p if (DOCKETS_DIR / p).is_dir() else p
    p = p.resolve()
    if not p.is_dir():
        raise HTTPException(400, f"not a directory: {p}")
    case_id = _new_case_id(body.config)
    CaseStore(case_id).create(body.config, raw_dir=p)
    _start(case_id)
    return {"case_id": case_id}


@app.post("/api/cases/{case_id}/rerun")
async def rerun(case_id: str):
    """Re-run the pipeline. Extraction results are cached per job, so this mostly redoes fusion."""
    store = CaseStore(case_id)
    if not store.meta_path.exists():
        raise HTTPException(404)
    current = store.load_graph()
    if (case_id in _tasks and not _tasks[case_id].done()) or (current and current.status == "running"):
        raise HTTPException(409, "case already running; do not start a second worker")
    store.events_path.unlink(missing_ok=True)
    _start(case_id)
    return {"case_id": case_id}


@app.get("/api/cases")
def list_cases():
    return CaseStore.list_cases()


class FusionRunRequest(BaseModel):
    fusion: Literal["team", "investigator", "linker"] = "investigator"
    max_turns: int = Field(8, ge=2, le=20)


@app.post("/api/cases/{case_id}/fusion-runs")
async def create_fusion_run(case_id: str, body: FusionRunRequest):
    target = f"{case_id[:80]}-{body.fusion}-{uuid.uuid4().hex[:6]}"
    try:
        prepare_fusion_run(case_id, target)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    runner = CaseRunner(target, fusion=body.fusion, max_turns=body.max_turns)
    _tasks[target] = asyncio.create_task(runner.run(from_case=case_id))
    return {"case_id": target}


@app.get("/api/cases/{case_id}")
def get_case(case_id: str):
    store = CaseStore(case_id)
    if not store.meta_path.exists():
        raise HTTPException(404)
    g = store.load_graph()
    if g:
        resolve_live_clocks(g)
    return json.loads(g.model_dump_json()) if g else {"case_id": case_id, "config": store.meta["config"],
                                                      "status": "created", "stage": "created"}


@app.get("/api/cases/{case_id}/events")
def get_events(case_id: str):
    """Full progress log, used by the UI to replay the swarm animation offline."""
    store = CaseStore(case_id)
    if not store.events_path.exists():
        return []
    return [json.loads(l) for l in store.events_path.read_text(encoding="utf-8").splitlines() if l.strip()]


@app.get("/api/cases/{case_id}/stream")
async def stream(case_id: str):
    store = CaseStore(case_id)
    if not store.meta_path.exists():
        raise HTTPException(404)

    async def gen():
        # Tail the persisted log so CLI runs and API runs both stream live.
        offset, idle = 0, 0
        replay_done = False
        while True:
            sent = False
            if store.events_path.exists():
                if store.events_path.stat().st_size < offset:
                    offset = 0
                with store.events_path.open("rb") as log_file:
                    log_file.seek(offset)
                    for _ in range(100):
                        line = log_file.readline()
                        if not line.endswith(b"\n"):
                            break  # retry a partially-written record next poll
                        offset = log_file.tell()
                        if line.strip():
                            yield f"data: {line.decode('utf-8').strip()}\n\n"
                            sent = True
            if not replay_done and (not store.events_path.exists() or offset >= store.events_path.stat().st_size):
                # A legacy CLI/API process may have emitted unaligned numeric
                # evidence. Correct that history before transitioning to live.
                graph = store.load_graph()
                if graph and resolve_live_clocks(graph):
                    packet = {"type": "clock_sync", "series": [s.model_dump() for s in graph.series],
                              "events": [e.model_dump() for e in graph.events],
                              "track": [p.model_dump() for p in graph.track], "clocks": graph.clocks}
                    yield f"data: {json.dumps(packet)}\n\n"
                yield 'data: {"type":"replay_done"}\n\n'
                replay_done = True
            idle = 0 if sent else idle + 1
            if idle >= 50:
                yield ": keepalive\n\n"
                idle = 0
            await asyncio.sleep(0.3)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/cases/{case_id}/files/{file_id}")
def get_file(case_id: str, file_id: str):
    store = CaseStore(case_id)
    g = store.load_graph()
    f = next((x for x in (g.files if g else []) if x.file_id == file_id), None)
    if not f:
        raise HTTPException(404)
    path = (store.raw_dir / f.rel_path).resolve()
    if not str(path).startswith(str(store.raw_dir.resolve())):
        raise HTTPException(403)
    return FileResponse(path, filename=f.name, content_disposition_type="inline")
