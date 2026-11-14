# Docket Blueprint

Agentic NTSB docket analyzer built on **Gemini 4**. You drop in an NTSB public docket (PDFs, CSVs, videos, audio, radar). A swarm of extractor agents reads every file, and fusion agents build one **verified timeline**, an **abnormality register** and a **causal graph**. Everything is shown in a blueprint-style console: a 3D flight view with crew/ATC/witness "voices", a timeline strip, the causal graph, and a sources view.

* Design and background: [PLAN.md](PLAN.md)
* UI requirements and layout: [docs/UI.md](docs/UI.md)
* Notes for agents and contributors: [AGENTS.md](AGENTS.md)

---

## Quick start

### 1. Backend (Python 3.12+)

```bash
cd backend
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt      # Windows; .venv/bin/python on Mac/Linux
cp .env.example .env                                         # set GEMINI_API_KEY (never commit .env)
.venv/Scripts/python -m uvicorn app.main:app --port 8000
```

Without `GEMINI_API_KEY` (or with `MOCK_LLM=1`) the backend runs a **mock extractor**. It is regex based but works on the real document text, so the full pipeline and UI run offline. It adds no cost.

Models: the hackathon key exposes `gemini-4-argon`, `gemini-4-carbon` and `gemini-4-hydrogen`. Defaults are `GEMINI_MODEL_FAST=gemini-4-hydrogen` (fastest in a quick test) and `GEMINI_MODEL_PRO=gemini-4-argon`. The codenames don't say which is which, so this is a guess.

### 2. Frontend (Node 20+)

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173, proxies /api -> :8000
```

If port 8000 is occupied, start the backend with `--port 8001` and run
`DOCKET_API_URL=http://127.0.0.1:8001 npm run dev` from `frontend` (Mac/Linux).

On this NixOS checkout, `source backend/.venv/bin/activate` from the repository
root also enables the installed Node runtime and the native libraries needed by
NumPy. Run this in each terminal before starting either service.

`http://localhost:5173/#sample` opens **synthetic demo data** (marked with a red banner) for UI work without a backend.

Deep links: `#case=<id>&t=<seconds UTC>&cam=chase|side|top|orbit&view=flight|profile|causal|sources`

### 3. Demo case: Atlas Air 3591 (DCA19MA086)

```bash
backend/.venv/Scripts/python scripts/fetch_docket.py DCA19MA086                 # 78 items, ~1.5 GB -> data/dockets/DCA19MA086
cd backend
.venv/Scripts/python -m app.cli ../data/dockets/DCA19MA086 --title "Atlas Air 3591" --ntsb DCA19MA086 --date 2019-02-23 --aircraft "Boeing 767-375BCF" --offset -6
```

Or use the UI: **Analyse local folder** (the parameters are prefilled), or `POST /api/cases/local`. A full run with Gemini takes about 15–25 minutes: around 130 PDF chunks at roughly 50 s each, 14 in parallel, plus 7 media files. Results are cached per job in `data/cases/<id>/atoms/`, so **Re-run** only redoes fusion.

`data/` is git-ignored: dockets and case outputs stay local.

### Re-run the investigator without re-extracting

The default final fusion step is a bounded investigator (8 turns, at most 3 tool
requests per research turn). It can search/inspect cited evidence, inspect a
timeline window across sources, read PDF
passages, and ask Python for recorder-window statistics. It tests relationships
before returning the causal graph and hypotheses. Claims referencing evidence
it has not inspected are discarded. Recorder summaries use cached, downsampled
profile samples and are labelled accordingly.

From the repository root on Mac/Linux:

```bash
source backend/.venv/bin/activate
cd backend
python -m app.refuse --from-case atlas-3591 --case-id atlas-investigator-v1 --max-turns 8
# Compare with the original single-pass linker using the same base extractions:
python -m app.refuse --from-case atlas-3591 --case-id atlas-linker-v1 --fusion linker
# Free tool/replay smoke test (no fabricated causal findings):
MOCK_LLM=1 python -m app.refuse --from-case atlas-3591 --case-id test-investigator-v1
python -m unittest discover -s tests -v
```

Each experiment requires a **new case ID**, preserves the source case, and records
its base-case ID and extraction digest in `stats`. New runs save
`extractions.json` before fusion changes clocks or merges atoms. Completed older
runs rebuild from the exact extraction jobs in their event log and caches;
missing caches fail rather than triggering paid extraction. No source inventory,
triage, extraction or media upload is performed by `app.refuse`. PDF verification
and investigator page reads still require the original docket files.

In the UI, **Investigate again** creates a separate experiment through
`POST /api/cases/{id}/fusion-runs` (`{"fusion":"investigator","max_turns":8}`).
The Sources view shows public questions, tool activity, cited evidence and
conclusions. **Replay investigation** animates just these steps without model
calls. Both the trace and source links persist in the graph and event log, and
CLI runs stream live to the browser. The trace is a public activity record, not
private model reasoning. The old full-pipeline **Re-run** button still exists.

ADS-B series with an unresolved `MM:SS` clock are withheld from the UTC Profile
until their hour is matched against FDR altitude. Live extraction publishes the
aligned preview as soon as both data sources are available.

---

## How it works

```
docket folder / zip
  └─ ingest      inventory (sha256, kind, pages, scanned?) → triage (filename rules, LLM fallback) → blind mode / ancillary hold-out
  └─ extract     priority queue, N async workers
        PDF chunk (20 pp)  → Gemini structured output (Extraction schema), role-specific prompt
        video / audio      → Gemini File API, citations carry media_time
        FDR CSV            → tools/fdr.py   (deterministic: discretes, exceedances, 20+ series, lat/lon track)
        ADS-B CSV          → tools/track.py (track, MM:SS clock, ADS-B v2 autopilot discretes)
        radar .ppb         → tools/radar.py (STARS playback, filtered by Mode-S address)
  └─ fuse        clock_anchor (ADS-B hour via altitude match) → verify (quote vs. page text) → align (clocks via anchor events)
                 → dedup (merge events across sources, conflicts) → link (Gemini: HFACS layers, causal edges, hypotheses)
  └─ case_graph.json  +  events.jsonl (SSE stream, replayable)
```

Core rule: **every atom (event / anomaly / fact) carries a citation**: file, page or media time, and a verbatim quote. The verifier checks each quote against the PDF text. The UI shows the origin of everything with source chips (`CVR #68 p.12 ✓`, `FDR #67 data ⚙`).

### Repository layout

```
backend/app/
  main.py            FastAPI: /api/cases (upload) · /api/cases/local · /api/cases/{id} · /stream (SSE) · /events · /files/{file_id}
  cli.py             headless run
  orchestrator.py    the pipeline above; emits progress events
  schemas.py         ALL data models (LLM-facing + stored). Frontend mirror: frontend/src/types.ts
  store.py           file-based case store + SSE event bus
  config.py          env config
  pdfutil.py         pypdf wrapper (PyMuPDF DLL is blocked by Windows app control on the dev laptop)
  timeparse.py       raw time strings → seconds since 00:00 UTC of accident date
  ingest/            unzip, inventory, triage (role rules), chunker
  agents/            llm.py (Gemini wrapper: structured output, retries, File API), prompts.py, extractor.py, atoms.py, mock.py
  tools/             table.py (robust NTSB CSV loader), fdr.py, track.py, radar.py
  fusion/            clock_anchor.py, verifier.py, time_align.py, dedup.py, linker.py
frontend/src/
  App.tsx            console layout: header · view + timeline strip · inspector
  useCase.ts         live state: applies SSE messages to the case graph; replay
  data.ts            derived views: series lookup, discrete states, aircraft zones, provenance (sourceOf)
  views/             FlightView (three.js hero), TimelineStrip (transport + lanes), Sources (swarm, log, media preview)
  sheets/            CausalGraph (layered DAG), Profile (parameter bands)
  components/        cards (ADI, system cards), SourceTag (provenance chip)
  panels.tsx         Header, Inspector (register / detail with evidence)
  sample.ts          synthetic demo data (clearly labelled)
scripts/fetch_docket.py   download any public NTSB docket
docs/UI.md                UI requirements
```

---

## Status (2026-11-14)

**Working:**
- End-to-end pipeline (mock and Gemini).
- Real Atlas 3591 data: the FDR CSV (CST→UTC, 20 series, lat/lon track), ADS-B with hour recovery (median altitude error 8 ft), the radar `.ppb`, and media extraction.
- Live SSE UI.
- 3D flight view with orbit controls in all camera modes, an OpenStreetMap ground (inverted to a blueprint look; zoom-14 patch follows the aircraft) and time marks.
- Layered causal graph and source chips on every item.

**First full Gemini run on Atlas 3591** (local only, `data/` is not in git):
- 25 min, 141 calls, about 2.6 M input tokens.
- 1,668 events, 332 anomalies, 24 causal links, 3 hypotheses. The top one, at 92%, is inadvertent go-around → somatogravic illusion → nose-down inputs.
- The ATC audio was aligned to UTC through 3 anchors with 0.2 s spread.
- This was not a blind test: the docket has no final report, but party submissions discuss the theory.

**Open / next** (see [AGENTS.md](AGENTS.md) for details):
- Prompt tuning: event yield per chunk is low for some docs, and causal links are sparse (24 for 332 anomalies).
- Check satellite and street basemap rendering and contrast.
- Blind-mode evaluator: compare findings with the NTSB final report.
- Learned anomaly detection on FDR data (TimesFM etc.), see PLAN.md §11.
- Gemini context caching, an LLM conflict detector, a PDF.js viewer with quote highlight.

### Basemap tiles and caching

The 3D path view defaults to EOX Sentinel-2 cloudless **2016** satellite imagery
(CC BY 4.0), with a Satellite/Streets switch. This is geographic context, not
accident-date imagery. EOX provides a token-free, best-effort service; see
[EOX::Maps](https://maps.eox.at/) for attribution and service details.

The Streets option loads standard OpenStreetMap raster tiles directly from
`https://tile.openstreetmap.org/{z}/{x}/{y}.png` without an API key. Normal browser
HTTP caching persists tiles across visits, honours the server's cache headers,
and revalidates expired tiles. Keep browser caching enabled (including in DevTools)
to reuse them. No tile prefetch or offline download is provided. Attribution links
to the OSM copyright page. See the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
