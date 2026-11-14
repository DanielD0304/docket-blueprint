# Docket Blueprint

Agentic NTSB docket analyzer built on Gemini. You drop in a docket and a swarm of extractor agents reads every file. Fusion agents then build one verified timeline, an abnormality register and a causal graph, all rendered as live blueprint sheets in 2D and 3D. The full design is in [PLAN.md](PLAN.md).

## Run

Backend (Python 3.12+):

```bash
cd backend
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # Windows; use .venv/bin/python on Mac/Linux
cp .env.example .env   # add GEMINI_API_KEY and confirm the Gemini 4.x model IDs
.venv/Scripts/python -m uvicorn app.main:app --reload --port 8000
```

Without an API key the backend runs a **mock extractor** (regex based). It uses the real document text, so the whole pipeline and UI work offline.

Frontend:

```bash
cd frontend
npm install
npm run dev     # http://localhost:5173 (proxies /api to :8000)
```

To work on the UI without a backend, open `http://localhost:5173/#sample` for synthetic data.

## Demo case: Atlas Air 3591 (DCA19MA086)

1. Download the docket from https://data.ntsb.gov/Docket/?NTSBNumber=DCA19MA086 (78 items) into `data/dockets/DCA19MA086/`. Keep the item number at the start of each filename.
2. In the UI, the case parameters are prefilled for Atlas 3591. Click **Analyse local folder** with `../data/dockets/DCA19MA086`.
3. Or precompute it headless:

```bash
cd backend
.venv/Scripts/python -m app.cli ../data/dockets/DCA19MA086 --title "Atlas Air 3591" --ntsb DCA19MA086 --date 2019-02-23 --aircraft "Boeing 767-375BCF" --offset -6
```

Blind mode (on by default) holds back final-report and probable-cause documents so they can serve as ground truth. Re-runs reuse cached per-job extractions (`data/cases/<id>/atoms/`). **Replay swarm** re-animates a finished run offline.
