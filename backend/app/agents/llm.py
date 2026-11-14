"""Thin async Gemini wrapper: structured output, concurrency limit, retries, usage accounting."""
from __future__ import annotations

import asyncio
import logging
import os
import random
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from ..config import GEMINI_API_KEY, MAX_CONCURRENCY, MOCK_LLM

log = logging.getLogger(__name__)
T = TypeVar("T", bound=BaseModel)

RETRYABLE = {408, 429, 500, 502, 503, 504}
REQUEST_TIMEOUT_S = float(os.getenv("GEMINI_REQUEST_TIMEOUT_S", "480"))


class LLM:
    def __init__(self) -> None:
        self.mock = MOCK_LLM
        self.sem = asyncio.Semaphore(MAX_CONCURRENCY)
        self.usage = {"calls": 0, "input_tokens": 0, "output_tokens": 0, "errors": 0}
        self.client = None
        if not self.mock:
            from google import genai
            self.client = genai.Client(api_key=GEMINI_API_KEY)

    async def upload(self, path, mime: str):
        """Upload a large file (audio/video) to the Gemini File API and wait until it is ready."""
        from google.genai import types

        assert self.client is not None
        f = await asyncio.wait_for(self.client.aio.files.upload(file=str(path), config=types.UploadFileConfig(mime_type=mime)), timeout=REQUEST_TIMEOUT_S)
        for _ in range(240):
            if "PROCESSING" not in str(f.state):
                break
            await asyncio.sleep(3)
            f = await asyncio.wait_for(self.client.aio.files.get(name=f.name), timeout=REQUEST_TIMEOUT_S)
        if "ACTIVE" not in str(f.state):
            raise RuntimeError(f"file upload not active: {f.state}")
        return f

    async def structured(self, *, model: str, system: str, parts: list, schema: type[T],
                         temperature: float = 0.1, retries: int = 4, extra: dict | None = None) -> T:
        from google.genai import types

        assert self.client is not None, "structured() called in mock mode"
        contents = list(parts)
        last_err: Exception | None = None
        async with self.sem:
            for attempt in range(retries):
                try:
                    resp = await asyncio.wait_for(self.client.aio.models.generate_content(
                        model=model,
                        contents=contents,
                        config=types.GenerateContentConfig(
                            system_instruction=system,
                            response_mime_type="application/json",
                            response_schema=schema,
                            temperature=temperature,
                            **(extra or {}),
                        ),
                    ), timeout=REQUEST_TIMEOUT_S)
                    self.usage["calls"] += 1
                    um = getattr(resp, "usage_metadata", None)
                    if um:
                        self.usage["input_tokens"] += um.prompt_token_count or 0
                        self.usage["output_tokens"] += um.candidates_token_count or 0
                    if isinstance(resp.parsed, schema):
                        return resp.parsed
                    return schema.model_validate_json(resp.text or "{}")
                except ValidationError as e:
                    last_err = e
                    contents = list(parts) + [f"Your previous answer failed schema validation:\n{e}\nReturn valid JSON only."]
                except Exception as e:  # network / API errors
                    last_err = e
                    if isinstance(e, TimeoutError):
                        last_err = TimeoutError(f"Gemini request exceeded {REQUEST_TIMEOUT_S:g} seconds")
                    log.warning("Model request attempt %s/%s failed (%s)", attempt + 1, retries, type(e).__name__)
                    code = getattr(e, "code", None) or getattr(e, "status_code", None)
                    if code not in RETRYABLE and attempt > 0:
                        break
                    await asyncio.sleep(min(60, 2 ** attempt * 2 + random.random() * 2))
            self.usage["errors"] += 1
        raise RuntimeError(f"LLM call failed after {retries} attempts: {last_err}")


_llm: LLM | None = None


def get_llm() -> LLM:
    global _llm
    if _llm is None:
        _llm = LLM()
    return _llm
