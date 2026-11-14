"""Resume only missing extraction jobs using the saved inventory and existing caches.

python -m app.resume --case-id atlas-investigator-v1 --max-new-jobs 2 --fusion team
"""
from __future__ import annotations
import argparse
import asyncio
import shutil
import time
from .orchestrator import CaseRunner
from .store import CaseStore
from .schemas import CaseGraph

async def resume(case_id: str, *, max_new_jobs: int = 2, fusion: str = 'team'):
    store = CaseStore(case_id)
    old = store.load_graph()
    if old is None:
        raise ValueError('No saved case inventory to resume')
    if old.status == 'running':
        raise ValueError('Case is marked running; establish that its worker stopped before resuming')
    runner = CaseRunner(case_id, fusion=fusion)
    runner.graph = CaseGraph(case_id=case_id, config=old.config, files=[f.model_copy(deep=True) for f in old.files])
    for f in runner.graph.files:
        f.jobs_total = f.jobs_done = f.atoms = 0
        f.error = None
        if not f.excluded:
            f.status = 'queued'
    runner.files = {f.file_id:f for f in runner.graph.files}
    jobs = runner.plan_jobs()
    def cache_id(job):
        return job.job_id + ('-mock' if runner.llm.mock and job.kind in ('pdf','image','media') else '')
    missing = [j for j in jobs if runner.store.load_atoms(cache_id(j)) is None]
    paid = [j for j in missing if j.kind in ('pdf','image','media')]
    if len(paid) > max_new_jobs:
        raise ValueError(f'{len(paid)} uncached model jobs exceed --max-new-jobs {max_new_jobs}; nothing started')
    stamp = int(time.time())
    if store.events_path.exists():
        shutil.copy2(store.events_path, store.root/f'events.before-resume-{stamp}.jsonl')
        store.events_path.unlink()
    shutil.copy2(store.graph_path,store.root/f'case_graph.before-resume-{stamp}.json')
    g = runner.graph
    g.status = 'running'
    runner.stage('extract')
    runner.emit('files', files=[f.model_dump() for f in g.files])
    runner.emit('plan', jobs=len(jobs), files=[f.model_dump() for f in g.files])
    print(f'Reusing {len(jobs)-len(missing)} cached jobs; retrying {[j.job_id for j in missing]}',flush=True)
    started = time.time()
    try:
        # Restore each cached payload once; preserve current deterministic sensor caches.
        for job in jobs:
            if job not in missing:
                await runner.run_job(job)
        runner.store.save_graph(g)  # Persist restored sensors/evidence before waiting on media.
        await asyncio.gather(*(runner.run_job(job) for job in missing))
        failed = [f.name for f in g.files if f.error]
        if failed:
            raise RuntimeError(f'Resumed extraction has failed sources: {failed}')
        runner.save_extractions()
        await runner.fuse()
        g.status = 'done'
        g.stats = {'resumed':True,'retried_jobs':[j.job_id for j in missing],
            'cached_jobs':len(jobs)-len(missing),'seconds':round(time.time()-started,1),
            'llm':dict(runner.llm.usage),'fusion':fusion,'events':len(g.events),
            'anomalies':len(g.anomalies),'sensors':len(g.sensors),
            'edges':len(g.causal_edges),'hypotheses':len(g.hypotheses)}
        runner.stage('done')
        runner.emit('done',stats=g.stats)
        print(g.stats,flush=True)
    except BaseException as exc:
        g.status = 'error'
        g.stats['error'] = str(exc) or type(exc).__name__
        store.save_graph(g)
        runner.emit('error',error=g.stats['error'])
        raise
    return g

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--case-id',required=True)
    parser.add_argument('--max-new-jobs',type=int,default=2)
    parser.add_argument('--fusion',choices=('team','investigator','linker'),default='team')
    args=parser.parse_args()
    asyncio.run(resume(args.case_id,max_new_jobs=args.max_new_jobs,fusion=args.fusion))

if __name__ == '__main__':main()
