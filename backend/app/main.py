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
from pydantic import BaseModel

from .config import MOCK_LLM, MODEL_FAST, MODEL_PRO
from .ingest.unzip import safe_extract
from .orchestrator import CaseRunner
from .schemas import CaseConfig
from .store import CaseStore, bus

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
app = FastAPI(title="Docket Blueprint")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_tasks: dict[str, asyncio.Task] = {}


def _new_case_id(cfg: CaseConfig) -> str:
    base = re.sub(r"[^A-Za-z0-9]+", "-", cfg.ntsb_id or "case").strip("-")
    return f"{base}-{uuid.uuid4().hex[:6]}"


def _start(case_id: str) -> None:
    if case_id in _tasks and not _tasks[case_id].done():
        raise HTTPException(409, "case already running")
    _tasks[case_id] = asyncio.create_task(CaseRunner(case_id).run())


@app.get("/api/health")
def health():
    return {"ok": True, "mock": MOCK_LLM, "models": {"fast": MODEL_FAST, "pro": MODEL_PRO}}


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
    p = Path(body.path).expanduser().resolve()
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
    store.events_path.unlink(missing_ok=True)
    _start(case_id)
    return {"case_id": case_id}


@app.get("/api/cases")
def list_cases():
    return CaseStore.list_cases()


@app.get("/api/cases/{case_id}")
def get_case(case_id: str):
    store = CaseStore(case_id)
    if not store.meta_path.exists():
        raise HTTPException(404)
    g = store.load_graph()
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
        q = bus.subscribe(case_id)
        last = 0
        try:
            if store.events_path.exists():
                for line in store.events_path.read_text(encoding="utf-8").splitlines():
                    if line.strip():
                        msg = json.loads(line)
                        last = max(last, msg.get("seq", 0))
                        yield f"data: {line}\n\n"
            yield 'data: {"type":"replay_done"}\n\n'
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if msg.get("seq", 0) <= last:
                    continue
                yield f"data: {json.dumps(msg, default=str)}\n\n"
        finally:
            bus.unsubscribe(case_id, q)

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
