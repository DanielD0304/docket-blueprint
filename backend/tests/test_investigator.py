"""Offline regression checks for provenance, tool bounds and repeatable fusion."""
import asyncio
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import patch

from app.fusion.investigator import investigate
from app.orchestrator import CaseRunner
from app.refuse import prepare_fusion_run
from app.schemas import (Anomaly, CaseConfig, CaseGraph, Citation, InvestigatorDecision,
                         InvestigatorToolCall, LinkerOutput, Series, SourceFile, TimeRef)
from app.store import CaseStore
from app.tools.investigation import EvidenceTools


def graph():
    f = SourceFile(file_id="f", name="FDR.csv", rel_path="FDR.csv", kind="table", ext=".csv",
                   size=1, sha256="f", status="done")
    cs = [Citation(file_id="f", quote="rows 1-2, column pitch: 30", verified=True)]
    anoms = [Anomaly(id=i, domain="flight_path_energy", title=i, expected="normal", observed="pitch 30",
                     severity="critical", certainty="measured", citations=cs, source_files=["f"])
             for i in ("a1", "a2", "a3")]
    return CaseGraph(case_id="source", config=CaseConfig(), files=[f], anomalies=anoms,
                     series=[Series(name="pitch_deg", source_file="f", unit="deg", points=[(10, 1), (11, 3), (12, 2)])])


class FakeLLM:
    mock = False
    usage = {"calls": 0, "input_tokens": 0, "output_tokens": 0, "errors": 0}

    def __init__(self, decisions):
        self.decisions = iter(decisions)

    async def structured(self, **kwargs):
        return next(self.decisions)


class ToolTests(TestCase):
    def test_legacy_live_clock_resolves_before_media_finishes(self):
        from app.fusion.clock_anchor import resolve_live_clocks
        g = graph()
        g.status, g.stage = "running", "extract"
        g.files[0].summary = "Track: clock mmss (hour recovered in fusion)"
        g.series = [
            Series(name="altitude_ft", source_file="fdr", points=[(64800 + i, i * 10) for i in range(30)]),
            Series(name="altitude_ft_adsb", source_file="f", points=[(i, i * 10) for i in range(30)])]
        resolve_live_clocks(g)
        self.assertEqual(g.series[1].points[0][0], 64800)
        self.assertEqual(g.series[1].clock_basis, "utc")
        self.assertEqual(g.stage, "extract")
        self.assertEqual(resolve_live_clocks(g), {})
        self.assertEqual(g.series[1].points[0][0], 64800)

    def test_dedup_preserves_distinct_observation_times(self):
        from app.fusion.dedup import _merge_anomalies
        a, b = graph().anomalies[:2]
        a.title = b.title = "Repeated pitch excursion"
        a.time, b.time = TimeRef(t_s=0), TimeRef(t_s=3600)
        merged = _merge_anomalies([a, b])
        self.assertEqual(len(merged), 1)
        self.assertEqual([o.start_s for o in merged[0].observations], [0, 3600])
        self.assertTrue(all(o.citations for o in merged[0].observations))
        self.assertTrue(all(o.end_s is None for o in merged[0].observations))

    def test_timeline_window_excludes_unresolved_partial_clocks(self):
        g = graph()
        g.anomalies[0].time = TimeRef(t_s=10, aligned_by="mmss")
        g.anomalies[1].time = TimeRef(t_s=11, aligned_by="fdr_clock")
        result = EvidenceTools(g, Path("/tmp")).run(InvestigatorToolCall(
            tool="timeline_window", start_s=9, end_s=12))
        self.assertEqual([e["id"] for e in result["evidence"]], ["a2"])

    def test_recorder_arithmetic_and_limits(self):
        tools = EvidenceTools(graph(), Path("/tmp"))
        call = InvestigatorToolCall(tool="recorder_window", file_id="f", series_name="pitch_deg", start_s=10, end_s=12)
        result = tools.run(call)
        self.assertEqual((result["min"], result["max"], result["mean"], result["samples"]), (1, 3, 2, 3))
        self.assertIn("sample rows 1-3", result["citations"][0]["quote"])
        self.assertIn(result["evidence_id"], tools.seen)
        with self.assertRaises(ValueError):
            tools.run(call.model_copy(update={"end_s": 100000}))
        tools.graph.series[0].clock_basis = "unresolved"
        with self.assertRaises(ValueError):
            tools.run(call)

    def test_excluded_sources_and_path_traversal_are_inaccessible(self):
        g = graph()
        g.files[0].excluded = True
        tools = EvidenceTools(g, Path("/tmp"))
        self.assertEqual(tools.run(InvestigatorToolCall(tool="search_evidence", query="pitch"))["evidence"], [])
        with self.assertRaises(ValueError):
            tools.read_page("f", 1)
        g.files[0].excluded = False
        g.files[0].kind = "pdf"
        g.files[0].rel_path = "../../etc/passwd"
        with self.assertRaises(ValueError):
            EvidenceTools(g, Path("/tmp/docket")).read_page("f", 1)

    def test_page_quotes_match_the_exact_passage(self):
        g = graph()
        g.files[0].kind = "pdf"
        with patch("app.tools.investigation.pdfutil.page_count", return_value=1), patch(
            "app.tools.investigation.pdfutil.page_text", return_value="A" * 300 + "The crew reported confusion."):
            tools = EvidenceTools(g, Path("/tmp"))
            result = tools.read_page("f", 1)
            self.assertEqual(result["passages"][1]["citations"][0]["quote"], "The crew reported confusion.")
            self.assertEqual(tools.seen["page:f:1:2"][0].quote, "The crew reported confusion.")


class InvestigatorTests(IsolatedAsyncioTestCase):
    async def test_only_inspected_claims_survive_and_steps_are_replayable(self):
        g = graph()
        decisions = [
            InvestigatorDecision(question="Check support and contrary evidence", action="research", tools=[
                InvestigatorToolCall(tool="inspect_evidence", evidence_ids=["a1", "a2"])]),
            InvestigatorDecision(question="Conclude", action="conclude", conclusion=LinkerOutput.model_validate({
                "edges": [
                    {"source": "a1", "target": "a2", "relation": "contributed_to", "rationale": "Supported inference",
                     "confidence": .5, "evidence_ids": ["a1", "a2"]},
                    {"source": "a1", "target": "a3", "relation": "triggered", "rationale": "Uninspected",
                     "confidence": .9, "evidence_ids": ["a1", "a3"]}],
                "hypotheses": [{"title": "Candidate", "narrative": "Qualified explanation",
                                "supporting_anomaly_ids": ["a1"], "confidence": .5, "evidence_ids": ["a1"]}]}))]
        messages = []
        result = await investigate(g, Path("/tmp"), llm=FakeLLM(decisions), emit=lambda t, **m: messages.append(m))
        self.assertEqual(result["rejected_claims"], 1)
        self.assertEqual(len(g.causal_edges), 1)
        self.assertEqual(g.causal_edges[0].citations[0].quote, "rows 1-2, column pitch: 30")
        self.assertEqual(g.investigation.status, "done")
        self.assertEqual([m["step"]["phase"] for m in messages],
                         ["started", "question", "tool_call", "tool_result", "question", "conclusion", "conclusion", "finished"])
        json.dumps(messages)  # UI/SSE contract is JSON serializable

    async def test_budget_does_not_trigger_an_unbounded_fallback(self):
        decision = InvestigatorDecision(question="More evidence?", action="research", tools=[
            InvestigatorToolCall(tool="list_sources")])
        g = graph()
        await investigate(g, Path("/tmp"), max_turns=2, llm=FakeLLM([decision, decision]))
        self.assertEqual(g.investigation.status, "budget_exhausted")
        self.assertEqual(g.investigation.tool_calls, 1)
        self.assertEqual(g.causal_edges, [])


class FusionReplayTests(IsolatedAsyncioTestCase):
    async def test_stream_follows_cli_events_written_after_connection(self):
        from app.main import stream
        with TemporaryDirectory() as td, patch("app.store.CASES_DIR", Path(td)):
            store = CaseStore("streamtest")
            store.create(CaseConfig())
            store.events_path.write_text('{"type":"stage","stage":"ingest"}\n')
            response = await stream("streamtest")
            iterator = response.body_iterator
            self.assertIn('"ingest"', await anext(iterator))
            self.assertIn('"replay_done"', await anext(iterator))
            # CLI writes to disk; there is no in-process bus publication here.
            with store.events_path.open("a") as f:
                f.write('{"type":"investigator","step":{"title":"Inspect evidence"}}\n')
            self.assertIn('"Inspect evidence"', await asyncio.wait_for(anext(iterator), timeout=2))
            await iterator.aclose()

    async def test_repeat_fusion_preserves_base_and_does_not_double_shift_clocks(self):
        with TemporaryDirectory() as td, patch("app.store.CASES_DIR", Path(td)), patch(
            "app.orchestrator.get_llm") as get_llm, patch("app.fusion.investigator.get_llm") as investigator_llm:
            fake = FakeLLM([])
            fake.mock = True
            get_llm.return_value = investigator_llm.return_value = fake
            CaseStore("source").create(CaseConfig(), raw_dir=Path(td))
            runner = CaseRunner("source")
            runner.graph = graph()
            runner.graph.series = [
                Series(name="altitude_ft", source_file="f", points=[(18 * 3600 + i, i * 10) for i in range(30)]),
                Series(name="altitude_ft_adsb", source_file="adsb", clock_basis="unresolved",
                       points=[(i, i * 10) for i in range(30)])]
            runner.mmss_files = {"adsb"}
            runner.save_extractions()
            original = (CaseStore("source").root / "extractions.json").read_bytes()
            digests, starts = [], []
            for name in ("experiment1", "experiment2"):
                prepare_fusion_run("source", name)
                exp = CaseRunner(name)
                result = await exp.run(from_case="source")
                self.assertEqual(result.status, "done")
                self.assertEqual(result.investigation.status, "done")
                starts.append(result.series[1].points[0][0])
                digests.append(result.stats["base_digest"])
            self.assertEqual(starts, [64800, 64800])
            self.assertEqual(digests[0], digests[1])
            self.assertEqual(hashlib.sha256(original).hexdigest(), digests[0])
            self.assertEqual(original, (CaseStore("source").root / "extractions.json").read_bytes())

    async def test_legacy_missing_cache_fails_without_reextracting(self):
        with TemporaryDirectory() as td, patch("app.store.CASES_DIR", Path(td)), patch("app.orchestrator.get_llm") as llm:
            fake = FakeLLM([])
            fake.mock = True
            llm.return_value = fake
            source = CaseStore("source")
            source.create(CaseConfig(), raw_dir=Path(td))
            g = graph()
            g.status = "done"
            source.save_graph(g)
            source.events_path.write_text('\n'.join(json.dumps(m) for m in [
                {"type": "plan", "jobs": 1}, {"type": "job", "status": "running", "job_id": "missing", "kind": "fdr", "file_id": "f"}]))
            prepare_fusion_run("source", "experiment")
            with self.assertRaisesRegex(ValueError, "extraction will NOT be retried"):
                CaseRunner("experiment").restore_extractions("source")
