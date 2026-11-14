from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import Mock, patch

from test_investigator import graph

from app.resume import resume


class ResumeTests(IsolatedAsyncioTestCase):
    async def test_running_case_is_not_duplicated(self):
        g=graph();g.status='running'
        store=Mock();store.load_graph.return_value=g
        with patch('app.resume.CaseStore',return_value=store),patch('app.resume.CaseRunner') as runner:
            with self.assertRaisesRegex(ValueError,'marked running'):
                await resume('source')
            runner.assert_not_called()

    async def test_missing_model_job_budget_checked_before_mutation(self):
        g=graph();g.status='error'
        store=Mock();store.load_graph.return_value=g
        runner=Mock();runner.llm.mock=False;runner.store.load_atoms.return_value=None
        runner.plan_jobs.return_value=[SimpleNamespace(job_id='uncached',kind='pdf')]
        with patch('app.resume.CaseStore',return_value=store),patch('app.resume.CaseRunner',return_value=runner):
            with self.assertRaisesRegex(ValueError,'exceed'):
                await resume('source',max_new_jobs=0)
        runner.run_job.assert_not_called()
        runner.stage.assert_not_called()
