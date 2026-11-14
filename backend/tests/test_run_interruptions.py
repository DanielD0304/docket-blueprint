import asyncio
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, Mock, patch
from test_investigator import graph
from app.agents.llm import LLM
from app.orchestrator import CaseRunner
from app.schemas import LinkerOutput

class InterruptionTests(IsolatedAsyncioTestCase):
    async def test_cancellation_persists_resumable_error(self):
        runner = object.__new__(CaseRunner)
        runner.graph = graph()
        runner.llm = SimpleNamespace(usage={})
        runner.store = SimpleNamespace(save_graph=Mock())
        runner.emit = Mock()
        runner.ingest = AsyncMock(side_effect=asyncio.CancelledError)
        with self.assertRaises(asyncio.CancelledError):
            await runner.run()
        self.assertEqual(runner.graph.status, 'error')
        self.assertIn('interrupted', runner.graph.stats['error'])
        runner.store.save_graph.assert_called_once()
        self.assertEqual(runner.emit.call_args.args[0], 'error')

    async def test_stalled_model_request_exits(self):
        async def stalled(**kw):
            await asyncio.Event().wait()
        llm = object.__new__(LLM)
        llm.client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=stalled)))
        llm.sem = asyncio.Semaphore(1)
        llm.usage = dict(calls=0,input_tokens=0,output_tokens=0,errors=0)
        with patch('app.agents.llm.REQUEST_TIMEOUT_S', .01), patch('app.agents.llm.asyncio.sleep', new=AsyncMock()):
            with self.assertRaisesRegex(RuntimeError, 'exceeded'):
                await llm.structured(model='test',system='',parts=[],schema=LinkerOutput,retries=1)
        self.assertEqual(llm.usage['errors'], 1)
        self.assertEqual(llm.sem._value, 1)
