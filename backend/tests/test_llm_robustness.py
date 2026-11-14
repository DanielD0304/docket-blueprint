"""Offline checks: truncated model output is split instead of retried, and stalled calls time out."""
import asyncio
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch

from pypdf import PdfWriter

from app.agents import extractor
from app.agents.llm import LLM, OutputTruncated
from app.schemas import CaseConfig, Extraction, LLMCitation, LLMEvent, LLMTime, SourceFile


class FakeModels:
    def __init__(self, behaviour):
        self.behaviour = behaviour
        self.calls = 0

    async def generate_content(self, **kw):
        self.calls += 1
        return await self.behaviour(self.calls)


def fake_llm(behaviour) -> LLM:
    llm = LLM.__new__(LLM)
    llm.mock = False
    llm.sem = asyncio.Semaphore(4)
    llm.usage = {"calls": 0, "input_tokens": 0, "output_tokens": 0, "errors": 0}
    models = FakeModels(behaviour)
    llm.client = SimpleNamespace(aio=SimpleNamespace(models=models))
    llm._models = models
    return llm


class StructuredTests(IsolatedAsyncioTestCase):
    async def test_max_tokens_raises_without_retry(self):
        async def truncated(_n):
            cand = SimpleNamespace(finish_reason="FinishReason.MAX_TOKENS")
            return SimpleNamespace(parsed=None, text='{"summary": "cut', candidates=[cand],
                                   usage_metadata=SimpleNamespace(prompt_token_count=10, candidates_token_count=32768))
        llm = fake_llm(truncated)
        with self.assertRaises(OutputTruncated):
            await llm.structured(model="m", system="s", parts=["p"], schema=Extraction)
        self.assertEqual(llm._models.calls, 1, "a truncated answer must not be re-requested")

    async def test_stalled_call_times_out(self):
        async def stall(_n):
            await asyncio.sleep(3600)
        llm = fake_llm(stall)
        with self.assertRaises(RuntimeError) as cm:
            await llm.structured(model="m", system="s", parts=["p"], schema=Extraction, retries=2, timeout_s=0.05)
        self.assertIn("no response within", str(cm.exception))
        self.assertEqual(llm._models.calls, 2)


class SplitTests(IsolatedAsyncioTestCase):
    async def test_truncated_chunk_is_split_and_pages_stay_relative(self):
        with tempfile.TemporaryDirectory() as d:
            pdf = Path(d) / "acars.pdf"
            w = PdfWriter()
            for _ in range(20):
                w.add_blank_page(width=200, height=200)
            w.write(pdf)
            sf = SourceFile(file_id="f", name="acars.pdf", rel_path="acars.pdf", kind="pdf", ext=".pdf",
                            size=1, sha256="x", pages=20, role="ops_factual")
            seen = []

            async def structured(*, parts, **kw):
                # attachment text says "document pages A-B"; pretend >5 pages overflow the output
                text = parts[1]
                a, b = [int(x) for x in text.split("document pages ")[1].split(" of")[0].split("-")]
                seen.append((a, b))
                if b - a + 1 > 5:
                    raise OutputTruncated("too long")
                ev = LLMEvent(time=LLMTime(raw="12:00", basis="local"), category="crew_comm", description=f"p{a}",
                              certainty="recorded", citations=[LLMCitation(page=1, quote=f"page {a}")])
                return Extraction(summary=f"{a}-{b}", events=[ev])

            llm = SimpleNamespace(mock=False, structured=structured)
            with patch.object(extractor, "get_llm", return_value=llm):
                ext = await extractor.extract_pdf_chunk(pdf, sf, 0, 19, CaseConfig())

        self.assertEqual(seen[0], (1, 20))
        self.assertEqual(sorted(s for s in seen if s[1] - s[0] + 1 <= 5), [(1, 5), (6, 10), (11, 15), (16, 20)])
        # every final piece's first page must map back to the right page of the original 20-page chunk
        pages = sorted(e.citations[0].page for e in ext.events)
        firsts = sorted(int(e.description[1:]) for e in ext.events)
        self.assertEqual(pages, firsts, "citation pages must stay relative to the original chunk start")
        self.assertEqual(len(ext.events), 4)  # 20 pages -> 10 -> 5 +5 each side
