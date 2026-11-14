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
- 3D flight view with orbit controls in all camera modes, map tiles and time marks.
- Layered causal graph and source chips.

**Open / next** (see [AGENTS.md](AGENTS.md) for details):
- Check the 3D basemap rendering. Additive blending on the dark CARTO tiles was planned for better contrast.
- Look over the results of the first full Gemini run on Atlas 3591, then tune the prompts (event yield per chunk is low for some docs).
- Blind-mode evaluator: compare findings with the NTSB final report.
- Learned anomaly detection on FDR data (TimesFM etc.), see PLAN.md §11.
- Gemini context caching, an LLM conflict detector, a PDF.js viewer with quote highlight.
