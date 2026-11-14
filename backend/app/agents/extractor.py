"""Stage 1 extractor agents. One call per (file, chunk), specialised by doc role."""
from __future__ import annotations

import asyncio
import logging
import random
from pathlib import Path

from ..config import MOCK_DELAY_S, MODEL_FAST, MODEL_PRO
from ..ingest.chunker import page_texts, subset_pdf
from ..ingest.triage import first_pages_text
from ..schemas import CaseConfig, Extraction, SourceFile, Triage
from .llm import OutputTruncated, get_llm
from .mock import mock_extract
from .prompts import EXTRACT_BASE, IMAGE_PROMPT, MEDIA_BASE, MEDIA_PROMPTS, ROLE_PROMPTS, TRIAGE_PROMPT

log = logging.getLogger(__name__)

# Roles that need the stronger reasoning model.
PRO_ROLES = {"cvr_transcript", "ops_factual", "hp_factual", "fdr_report", "performance", "atc", "systems"}

IMAGE_MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
              ".tif": "image/tiff", ".tiff": "image/tiff", ".bmp": "image/bmp"}


def case_brief(cfg: CaseConfig) -> str:
    """Shared prefix for every agent. TODO: move into Gemini context cache once SOP baselines are added."""
    return (f"\nCase: {cfg.title}. NTSB {cfg.ntsb_id or 'n/a'}. Date {cfg.date or 'n/a'}. "
            f"Aircraft: {cfg.aircraft or 'n/a'}. Local time = UTC{cfg.local_utc_offset_h:+g}h.\n")


async def triage_with_llm(path: Path, sf: SourceFile, cfg: CaseConfig) -> Triage | None:
    llm = get_llm()
    if llm.mock:
        return None
    text = first_pages_text(path)
    return await llm.structured(model=MODEL_FAST, system=TRIAGE_PROMPT + case_brief(cfg),
                                parts=[f"File name: {sf.name}\n\n{text}"], schema=Triage)


async def extract_pdf_chunk(path: Path, sf: SourceFile, start: int, end: int, cfg: CaseConfig) -> Extraction:
    llm = get_llm()
    if llm.mock:
        if MOCK_DELAY_S:
            await asyncio.sleep(MOCK_DELAY_S * (0.5 + random.random()))
        return mock_extract(page_texts(path, start, end), sf.role)
    from google.genai import types

    system = EXTRACT_BASE + "\n" + ROLE_PROMPTS.get(sf.role, ROLE_PROMPTS["other"]) + case_brief(cfg)
    parts = [
        types.Part.from_bytes(data=subset_pdf(path, start, end), mime_type="application/pdf"),
        f"Document: '{sf.name}' (docket item {sf.docket_item}). This attachment is document pages "
        f"{start + 1}-{end + 1} of {sf.pages}. Citation page numbers refer to the attachment (1 = first attached page).",
    ]
    model = MODEL_PRO if sf.role in PRO_ROLES else MODEL_FAST
    try:
        return await llm.structured(model=model, system=system, parts=parts, schema=Extraction, timeout_s=600)
    except OutputTruncated:
        # Dense pages (ACARS logs, CVR transcripts) can produce more atoms than one response holds.
        # Split the range and extract the halves separately instead of re-asking the same thing.
        if end - start < 1:
            raise
        mid = (start + end) // 2
        log.warning("%s pages %d-%d: output truncated, splitting into %d-%d and %d-%d",
                    sf.name, start + 1, end + 1, start + 1, mid + 1, mid + 2, end + 1)
        left = await extract_pdf_chunk(path, sf, start, mid, cfg)
        right = await extract_pdf_chunk(path, sf, mid + 1, end, cfg)
        return merge_extractions(left, right, page_shift=mid + 1 - start)


def merge_extractions(left: Extraction, right: Extraction, page_shift: int) -> Extraction:
    """Combine two half-chunk extractions. Citation pages are 1-based within each attachment, so the
    right half's pages are shifted to stay relative to the original chunk start (what to_atoms expects)."""
    def shift(items):
        for it in items:
            for c in it.citations:
                if c.page:
                    c.page += page_shift
        return items

    return Extraction(
        summary=" ".join(s for s in (left.summary, right.summary) if s),
        events=left.events + shift(right.events),
        anomalies=left.anomalies + shift(right.anomalies),
        entities=left.entities + right.entities,
        facts=left.facts + shift(right.facts),
    )


MEDIA_MIME = {".mp4": "video/mp4", ".mov": "video/quicktime", ".wmv": "video/x-ms-wmv", ".avi": "video/x-msvideo",
              ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4"}
_media_sem = asyncio.Semaphore(3)  # uploads are large; keep a few in flight


async def extract_media(path: Path, sf: SourceFile, cfg: CaseConfig) -> Extraction:
    """Gemini native video/audio understanding via the File API. Citations carry media_time."""
    llm = get_llm()
    if llm.mock:
        return Extraction(summary=f"[mock] {sf.kind} {sf.name} (needs Gemini)")
    from google.genai import types

    if sf.role == "simulation":
        key = "simulation"
    elif sf.role == "weather" or "atis" in sf.name.lower():
        key = "weather"
    elif sf.kind == "audio":
        key = "atc"
    else:
        key = "video"
    mime = MEDIA_MIME.get(sf.ext, "video/mp4" if sf.kind == "video" else "audio/mpeg")
    async with _media_sem:
        up = await llm.upload(path, mime)
        extra = {"media_resolution": types.MediaResolution.MEDIA_RESOLUTION_LOW} if sf.kind == "video" else {}
        model = MODEL_PRO if key in ("atc", "video") else MODEL_FAST
        return await llm.structured(
            model=model, system=MEDIA_BASE + "\n" + MEDIA_PROMPTS[key] + case_brief(cfg),
            parts=[types.Part.from_uri(file_uri=up.uri, mime_type=up.mime_type or mime), f"File: '{sf.name}' (docket item {sf.docket_item})."],
            schema=Extraction, extra=extra, timeout_s=1800)  # long recordings: ~15 min observed


async def extract_image(path: Path, sf: SourceFile, cfg: CaseConfig) -> Extraction:
    llm = get_llm()
    if llm.mock:
        return Extraction(summary=f"[mock] image {sf.name}")
    from google.genai import types

    mime = IMAGE_MIME.get(sf.ext, "image/jpeg")
    parts = [types.Part.from_bytes(data=path.read_bytes(), mime_type=mime), f"Image file: '{sf.name}'"]
    return await llm.structured(model=MODEL_FAST, system=IMAGE_PROMPT + case_brief(cfg), parts=parts, schema=Extraction)
