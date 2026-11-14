import tempfile
import wave
from pathlib import Path
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, Mock, patch

from test_investigator import graph

from app.agents.extractor import extract_long_wav
from app.main import LocalCase, create_local_case
from app.schemas import CaseConfig, Extraction, LLMCitation, LLMEvent, LLMTime


class DemoMediaTests(IsolatedAsyncioTestCase):
    async def test_chunk_citations_seek_to_original_and_cache_is_reused(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'source.wav'
            with wave.open(str(p),'wb') as w:
                w.setnchannels(1);w.setsampwidth(2);w.setframerate(1);w.writeframes(b'\0\0'*601)
            result=Extraction(summary='chunk',events=[LLMEvent(time=LLMTime(basis='relative'),category='atc_comm',description='spoken',certainty='recorded',citations=[LLMCitation(quote='spoken',media_time='0:01')])])
            call=AsyncMock(return_value=result)
            sf=graph().files[0]
            with patch('app.agents.extractor.DATA_DIR',Path(folder)),patch('app.agents.extractor.extract_media',call):
                first=await extract_long_wav(p,sf,CaseConfig())
                second=await extract_long_wav(p,sf,CaseConfig())
            self.assertEqual(call.await_count,3)
            self.assertEqual([e.citations[0].media_time for e in first.events],['1.0','301.0','601.0'])
            self.assertEqual(first.model_dump(),second.model_dump())
            self.assertEqual(result.events[0].citations[0].media_time,'0:01')

    async def test_demo_folder_intake_does_not_start_extraction(self):
        with patch('app.main.DEMO_MODE',True),patch('app.main._demo_intake',return_value={'case_id':'saved','demo':True}),patch('app.main._start') as start:
            out=await create_local_case(LocalCase(path='/not/a/real/folder'))
            self.assertEqual(out['case_id'],'saved')
            start.assert_not_called()

    async def test_rerun_does_not_erase_an_active_cli_run(self):
        from fastapi import HTTPException

        from app.main import rerun
        store=Mock();store.meta_path.exists.return_value=True
        g=graph();g.status='running';store.load_graph.return_value=g
        with patch('app.main.CaseStore',return_value=store),patch('app.main._tasks',{}):
            with self.assertRaises(HTTPException) as error:
                await rerun('source')
        self.assertEqual(error.exception.status_code,409)
        store.events_path.unlink.assert_not_called()
