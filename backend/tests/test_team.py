from pathlib import Path
from unittest import IsolatedAsyncioTestCase

from test_investigator import graph

from app.fusion.team import investigate_team
from app.schemas import (
    InvestigatorDecision,
    InvestigatorToolCall,
    LinkerOutput,
    LLMInvestigationConclusion,
    LLMInvestigationFinding,
    LLMResearchReport,
)


class TeamTests(IsolatedAsyncioTestCase):
    async def test_cited_handoffs_and_explicit_conclusion(self):
        class Model:
            mock = False
            async def structured(self, **kw):
                if kw['schema'] is LLMInvestigationConclusion:
                    return LLMInvestigationConclusion(summary='Qualified result', evidence_ids=['a1'])
                final = 'FINAL:' in kw['parts'][-1]
                if not final:
                    return InvestigatorDecision(question='Inspect primary evidence', action='research', tools=[InvestigatorToolCall(tool='inspect_evidence', evidence_ids=['a1'])])
                if 'Your assignment: Reconcile' in kw['system']:
                    return InvestigatorDecision(question='Synthesize', action='conclude', conclusion=LinkerOutput(conclusion=LLMInvestigationConclusion(summary='Qualified result', evidence_ids=['a1'])))
                return InvestigatorDecision(question='Report', action='conclude', research_report=LLMResearchReport(summary='Evidence reviewed', findings=[LLMInvestigationFinding(title='Supported', explanation='Observed in source', evidence_ids=['a1']), LLMInvestigationFinding(title='Unsupported', explanation='Reject me', evidence_ids=['unread'])]))
        g = graph()
        await investigate_team(g, Path('/tmp'), max_turns=3, llm=Model())
        r = g.investigation
        self.assertEqual(r.status, 'done')
        self.assertEqual(r.rejected_claims, 4)
        self.assertEqual(r.conclusion.evidence_ids, ['a1'])
        self.assertEqual(len(r.agents), 5)
        self.assertEqual(len({s.id for s in r.steps}), len(r.steps))
        calls = {s.id for s in r.steps if s.phase == 'tool_call'}
        self.assertTrue(all(s.parent_step_id in calls for s in r.steps if s.phase == 'tool_result'))
        self.assertEqual(r.coverage.inspected_evidence, 1)
