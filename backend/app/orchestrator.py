"""Runs a case end to end and streams every step to the event bus.

ingest -> triage -> extractor swarm (priority queue, N workers) -> verify -> align -> dedup -> link.
Per-job outputs are cached in atoms/<job_id>.json, so re-runs only redo fusion (fast, cheap demos).
"""
from __future__ import annotations

import asyncio
import itertools
import logging
import time
import traceback
from dataclasses import dataclass, field

from .agents.atoms import to_atoms
from .agents.extractor import extract_image, extract_media, extract_pdf_chunk, triage_with_llm
from .agents.llm import get_llm
from .config import CHUNK_PAGES, MAX_CONCURRENCY, MAX_PAGES_PER_DOC
from .fusion.clock_anchor import anchor_mmss
from .fusion.dedup import dedup
from .fusion.linker import link
from .fusion.time_align import align
from .fusion.verifier import verify
from .ingest.chunker import plan_chunks
from .ingest.inventory import inventory
from .ingest.triage import apply_role, heuristic_role
from .schemas import Anomaly, CaseGraph, Entity, Event, Fact, Series, SourceFile, TrackPoint
from .store import CaseStore, bus
from .tools.fdr import analyze_fdr
from .tools.radar import analyze_radar
from .tools.track import analyze_track

log = logging.getLogger(__name__)
_seq = itertools.count()


@dataclass(order=True)
class Job:
    priority: int
    seq: int
    job_id: str = field(compare=False)
    file_id: str = field(compare=False)
    kind: str = field(compare=False)  # pdf | image | fdr | track
    start: int = field(default=0, compare=False)
    end: int = field(default=0, compare=False)


class CaseRunner:
    def __init__(self, case_id: str):
        self.case_id = case_id
        self.store = CaseStore(case_id)
        self.cfg = self.store.config
        self.graph = CaseGraph(case_id=case_id, config=self.cfg)
        self.files: dict[str, SourceFile] = {}
        self.llm = get_llm()
        self._last_save = 0.0
        self.track_rank = 99
        self.track_file: str | None = None
        self.mmss_files: set[str] = set()

    # ------------------------------------------------------------- helpers
    def emit(self, type_: str, **data) -> None:
        bus.publish(self.case_id, type_, **data)

    def stage(self, name: str) -> None:
        self.graph.stage = name
        self.emit("stage", stage=name)
        self.store.save_graph(self.graph)

    def save_throttled(self) -> None:
        if time.time() - self._last_save > 2:
            self.store.save_graph(self.graph)
            self._last_save = time.time()

    # ------------------------------------------------------------- stages
    async def ingest(self) -> None:
        self.stage("ingest")
        files = await asyncio.to_thread(inventory, self.store.raw_dir)
        unknown = []
        for f in files:
            role = heuristic_role(f)
            apply_role(f, role, self.cfg.blind_mode)
            if role == "other" and f.kind == "pdf" and not f.excluded:
                unknown.append(f)
            if f.excluded:
                f.status = "skipped"
        self.graph.files = files
        self.files = {f.file_id: f for f in files}
        self.emit("files", files=[f.model_dump() for f in files])

        if unknown:
            self.stage("triage")

            async def tri(f: SourceFile):
                try:
                    t = await triage_with_llm(self.store.raw_dir / f.rel_path, f, self.cfg)
                    if t:
                        apply_role(f, t.doc_role, self.cfg.blind_mode)
                        f.priority = max(1, min(5, t.priority))
                        if f.excluded:
                            f.status = "skipped"
                        self.emit("file", file=f.model_dump())
                except Exception as e:
                    log.warning("triage failed for %s: %s", f.name, e)

            await asyncio.gather(*(tri(f) for f in unknown))

    def plan_jobs(self) -> list[Job]:
        jobs: list[Job] = []
        for f in self.graph.files:
            if f.excluded or f.status == "error":
                continue
            path = self.store.raw_dir / f.rel_path
            if f.kind == "pdf":
                try:
                    chunks = plan_chunks(path, CHUNK_PAGES, MAX_PAGES_PER_DOC)
                except Exception as ex:  # one broken PDF must not stop the case
                    f.status, f.error = "error", f"chunking failed: {ex}"[:300]
                    continue
                for s, e in chunks:
                    jobs.append(Job(f.priority, next(_seq), f"{f.file_id}-p{s}-{e}", f.file_id, "pdf", s, e))
            elif f.kind == "table":
                kind = "track" if f.role == "adsb_radar" else "fdr"
                jobs.append(Job(f.priority, next(_seq), f"{f.file_id}-{kind}", f.file_id, kind))
            elif f.kind == "image":
                jobs.append(Job(f.priority, next(_seq), f"{f.file_id}-img", f.file_id, "image"))
            elif f.kind in ("audio", "video"):
                jobs.append(Job(f.priority, next(_seq), f"{f.file_id}-media", f.file_id, "media"))
            elif f.ext == ".ppb":
                jobs.append(Job(f.priority, next(_seq), f"{f.file_id}-radar", f.file_id, "radar"))
        for j in jobs:
            self.files[j.file_id].jobs_total += 1
        return jobs

    async def run_job(self, job: Job) -> None:
        f = self.files[job.file_id]
        path = self.store.raw_dir / f.rel_path
        cache_id = job.job_id + ("-mock" if self.llm.mock and job.kind in ("pdf", "image", "media") else "")
        f.status = "processing"
        self.emit("job", job_id=job.job_id, file_id=f.file_id, status="running", kind=job.kind,
                  pages=[job.start + 1, job.end + 1] if job.kind == "pdf" else None)
        t0 = time.time()
        try:
            payload = self.store.load_atoms(cache_id)
            cached = payload is not None
            if payload is None:
                if job.kind == "pdf":
                    ext = await extract_pdf_chunk(path, f, job.start, job.end, self.cfg)
                    payload = to_atoms(ext, f, cache_id, job.start, self.cfg.local_utc_offset_h)
                elif job.kind == "image":
                    ext = await extract_image(path, f, self.cfg)
                    payload = to_atoms(ext, f, cache_id, 0, self.cfg.local_utc_offset_h)
                elif job.kind == "media":
                    ext = await extract_media(path, f, self.cfg)
                    payload = to_atoms(ext, f, cache_id, 0, self.cfg.local_utc_offset_h)
                elif job.kind == "radar":
                    payload = await asyncio.to_thread(analyze_radar, path, f, self.store.raw_dir)
                elif job.kind == "fdr":
                    payload = await asyncio.to_thread(analyze_fdr, path, f, self.cfg.local_utc_offset_h)
                else:
                    payload = await asyncio.to_thread(analyze_track, path, f, self.cfg.local_utc_offset_h)
                self.store.save_atoms(cache_id, payload)
            self.absorb(f, payload)
            self.emit("job", job_id=job.job_id, file_id=f.file_id, status="done", cached=cached,
                      ms=int((time.time() - t0) * 1000), n_events=len(payload["events"]),
                      n_anomalies=len(payload["anomalies"]), summary=payload.get("summary"))
            self.emit("atoms", file_id=f.file_id, events=payload["events"], anomalies=payload["anomalies"],
                      track=payload.get("track", []), series=payload.get("series", []))
        except Exception as e:
            log.exception("job %s failed", job.job_id)
            f.error = str(e)[:500]
            self.emit("job", job_id=job.job_id, file_id=f.file_id, status="error", error=f.error)
        finally:
            f.jobs_done += 1
            if f.jobs_done >= f.jobs_total:
                f.status = "error" if (f.error and f.atoms == 0) else "done"
            self.emit("file", file=f.model_dump(), usage=self.llm.usage)
            self.save_throttled()

    def absorb(self, f: SourceFile, payload: dict) -> None:
        self.graph.events += [Event(**e) for e in payload["events"]]
        self.graph.anomalies += [Anomaly(**a) for a in payload["anomalies"]]
        self.graph.entities += [Entity(**e) for e in payload.get("entities", [])]
        self.graph.facts += [Fact(**x) for x in payload.get("facts", [])]
        # one track only: lowest rank wins (1 = FDR lat/lon, 2 = ADS-B/radar)
        if payload.get("track") and payload.get("track_rank", 9) < self.track_rank:
            self.graph.track = [TrackPoint(**p) for p in payload["track"]]
            self.track_rank = payload.get("track_rank", 9)
            self.track_file = f.file_id
        if payload.get("clock") == "mmss":
            self.mmss_files.add(f.file_id)
        self.graph.series += [Series(**s) for s in payload.get("series", [])]
        f.atoms += len(payload["events"]) + len(payload["anomalies"]) + len(payload.get("facts", []))
        if payload.get("summary"):
            f.summary = ((f.summary + " | ") if f.summary else "") + payload["summary"][:300]

    async def extract(self) -> None:
        jobs = self.plan_jobs()
        self.stage("extract")
        self.emit("plan", jobs=len(jobs), files=[f.model_dump() for f in self.graph.files])
        q: asyncio.PriorityQueue[Job] = asyncio.PriorityQueue()
        for j in jobs:
            q.put_nowait(j)

        async def worker():
            while not q.empty():
                job = q.get_nowait()
                await self.run_job(job)

        await asyncio.gather(*(worker() for _ in range(MAX_CONCURRENCY + 2)))

    async def fuse(self) -> None:
        g = self.graph
        if self.mmss_files:
            r = anchor_mmss(g, self.mmss_files, self.track_file)
            self.emit("fusion", step="clock_anchor", result=r)
        self.stage("verify")
        r = await asyncio.to_thread(verify, g, self.store.raw_dir)
        self.emit("fusion", step="verify", result=r)
        self.stage("align")
        r = align(g)
        self.emit("fusion", step="align", result=r)
        self.stage("dedup")
        r = dedup(g)
        self.emit("fusion", step="dedup", result=r)
        self.stage("link")
        r = await link(g)
        self.emit("fusion", step="link", result=r)
        g.events.sort(key=lambda e: (e.time.t_s is None, e.time.t_s or 0))

    async def run(self) -> CaseGraph:
        g = self.graph
        g.status = "running"
        t0 = time.time()
        try:
            await self.ingest()
            await self.extract()
            await self.fuse()
            g.status = "done"
            g.stats = {
                "files": len(g.files), "processed": sum(f.status == "done" for f in g.files),
                "skipped": sum(f.status == "skipped" for f in g.files), "events": len(g.events),
                "timed_events": sum(e.time.t_s is not None for e in g.events), "anomalies": len(g.anomalies),
                "edges": len(g.causal_edges), "hypotheses": len(g.hypotheses), "seconds": round(time.time() - t0, 1),
                "llm": self.llm.usage, "mock": self.llm.mock,
            }
            self.stage("done")
            self.emit("done", stats=g.stats)
        except Exception as e:
            g.status = "error"
            g.stats["error"] = str(e)
            self.store.save_graph(g)
            self.emit("error", error=str(e), trace=traceback.format_exc()[-2000:])
            raise
        return g
