# Notes for agents working on this repo

Read [README.md](README.md) first (run instructions, architecture), then [PLAN.md](PLAN.md) and [docs/UI.md](docs/UI.md).

## Ground rules

* **Never commit secrets or data.** `backend/.env` (Gemini key), `data/` (dockets, case outputs) and `.claude/` are git-ignored. Run `git grep -n "AIza"` before pushing.
* **Every atom needs a citation.** Extractors must return verbatim quotes with a page (PDF) or `media_time` (audio/video). Tool-generated atoms (FDR/ADS-B/radar) use `certainty="measured"` and pre-verified citations that name rows or lines. Don't add UI items without provenance.
* **The LLM never does arithmetic on recorder data.** Numeric work belongs in `backend/app/tools/`.
* **Schemas live in one place.** `backend/app/schemas.py` defines the models; `frontend/src/types.ts` mirrors them by hand. Change both together.
* **Keep LLM-facing schemas simple** (no dicts or datetimes) so they work as Gemini `response_schema`.
* **Synthetic data must stay labelled.** `frontend/src/sample.ts` is fake and shows a red banner. Never mix it into real cases. Test dockets belong outside `data/cases`.

## Dev loop

```bash
cd frontend && npx tsc -b                      # type-check (no test suite yet)
cd backend && .venv/Scripts/python -c "import app.main"
MOCK_LLM=1 .venv/Scripts/python -m app.cli <folder> --case-id test-x    # free end-to-end run
```

* Re-running a case reuses `data/cases/<id>/atoms/<job>.json`. Delete a job file to force re-extraction, or the mock suffix keeps mock and real caches apart.
* `POST /api/cases/{id}/rerun` restarts the pipeline (fusion re-runs; extraction is cached).
* For UI screenshots without a visible browser: Chrome headless with `--use-angle=swiftshader --virtual-time-budget=9000 --screenshot=...` against `#sample&t=...`. Live cases keep an SSE stream open, so headless won't finish: screenshot finished cases instead.

## Known pitfalls (learned the hard way)

* **Windows PowerShell 5.1** `Get-Content -Raw` / `Set-Content` re-encode UTF-8 as ANSI and corrupt `→ θ “ ”`. Edit files with an editor tool or Python, not PowerShell string replacement.
* **PyMuPDF** is blocked by Windows application control on the dev laptop, so `pypdf` sits behind `app/pdfutil.py`. Keep that interface if you switch back on Linux/Mac.
* **NTSB FDR CSV format:** 6 metadata lines, a header, a units row (`(CST)` = local time!), an enum row, then sparse rows every 1/64 s. Parameters are sampled in different rows (lat and lon too), so forward-fill where needed. See `tools/table.py` and `tools/fdr.py`.
* **NTSB ADS-B CSV:** `Time` is `MM:SS.s` without the hour. `fusion/clock_anchor.py` recovers the hour by matching altitude against the FDR. Lat/lon are in `LatDeg`/`LonDeg`, not `Lat`/`Lon` (which are DMS strings).
* **Radar `.ppb`:** STARS playback, tab-separated, 2.5 M rows. Columns 42/43 ("MSAW Active", "CA/MCI Active") are most likely *processing enabled* flags, not fired alerts, so they're deliberately not shown as alarms.
* **Ancillary FDR data** (docket items 37/38 in DCA19MA086) comes from a *different aircraft*. Triage excludes anything titled "ancillary".
* **Simulator videos** are re-enactments: `atoms.py` turns their events into facts so they never reach the accident timeline.
* **Map tiles:** CARTO basemaps now return an "API KEY REQUIRED" image. Use `tile.openstreetmap.org` (attribution shown, keep the tile count low). The tile range in `addTiles` is inclusive at both ends: n×n tiles around a centre means (n+1)² requests, so check `maxTiles`.
* **Voice card type** comes from the source document's role first: a party submission quoting the CVR is shown as PARTY, not CVR.
* **Time model:** `t_s` is seconds since 00:00 UTC on the accident date. Multi-day history (72-h crew history) gives values outside 0–86400; that's fine.

## Where to start on open items

| Item | Where |
|---|---|
| Basemap tuning (OSM tiles, inverted-luminance shader + additive blending; CARTO needs an API key now) | `frontend/src/views/FlightView.tsx` → `addTiles`, `invertedMaterial` |
| Denser causal graph (only 24 edges for 332 anomalies): linker gets top 150 anomalies; consider per-hypothesis linking | `backend/app/fusion/linker.py`, `LINKER_PROMPT` |
| Prompt tuning / event yield | `backend/app/agents/prompts.py` (`EXTRACT_BASE`, `ROLE_PROMPTS`, `MEDIA_PROMPTS`) |
| Blind-mode evaluator agent | new `backend/app/fusion/evaluator.py`; final report is in the docket but excluded at triage |
| FDR learned anomaly detection (TimesFM, matrix profile, change points) | `backend/app/tools/fdr.py`, PLAN.md §11 |
| Conflict detector (LLM) / better entity resolution | `backend/app/fusion/dedup.py` |
| PDF.js viewer with quote highlight | `frontend/src/views/Sources.tsx` (`Preview`) |
| Tests | none yet: start with `tools/table.py` + `timeparse.py` on small fixture CSVs |
