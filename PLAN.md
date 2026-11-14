# DOCKET//BLUEPRINT — Agentic NTSB Docket Analyzer

> Drop an NTSB docket (ZIP) → a swarm of Gemini 4.x agents reads every file → a second stage fuses everything into one **verified timeline, anomaly list and causal graph** → rendered as an interactive engineering blueprint.

---

## 0. Core idea in one picture

```
 ZIP upload
    │
    ▼
[Stage 0] Ingest & Triage ──── unzip, hash, detect type, split, OCR-check, classify doc role
    │
    ▼
[Stage 1] Extractor swarm (N parallel agents, one per file / chunk, specialist prompts)
    │        output: Evidence Atoms (events, anomalies, entities, facts, claims) + citations
    ▼
[Stage 1.5] Deterministic tools (FDR/radar/weather numeric analysis in Python, not LLM)
    │
    ▼
[Stage 2] Fusion agents
    ├─ Time Aligner        → one master clock (UTC) across CVR / FDR / ATC / local time
    ├─ Entity Resolver     → "FO", "first officer", "Pilot B", "the copilot" = same person
    ├─ Event Deduplicator  → merge same event seen in 5 documents, keep all sources
    ├─ Conflict Detector   → source A says 1,200 ft, source B says 900 ft → flag
    ├─ Anomaly Linker      → causal / contributory edges between anomalies
    ├─ Hypothesis Agent    → competing explanations, each with pro/contra evidence
    └─ Verifier / Critic   → re-checks every citation against the source page, drops hallucinations
    │
    ▼
Case Graph JSON  ──►  Blueprint UI (timeline swimlanes, flight profile, aircraft schematic, causal graph)
```

**Non‑negotiable design rule:** every atom carries a *citation* (file, page, quote/bbox). Nothing reaches the UI without one. This is what makes the system trustworthy and is the best thing to show judges.

---

## 1. What is in an NTSB docket (aviation, major investigation)

Dockets live at `data.ntsb.gov/Docket` (by NTSB number, e.g. `DCA19MA086`). Major airline dockets have 50–400 items. Typical contents:

| Doc family | Typical file types | Notes |
|---|---|---|
| **Operations Group Factual** | PDF (native text) | Crew history, flight sequence, company procedures. Gold mine for timeline. |
| **Human Performance Factual** | PDF | Fatigue, 72‑hr history, training, medical, workload. |
| **Interview summaries / transcripts** | PDF, sometimes scanned | Subjective, conflicting accounts. Need "claimed by X" semantics. |
| **CVR Group Chairman's Factual + transcript** | PDF (tables) | Audio is never released. Time base = CVR elapsed / local time. Speakers coded (HOT‑1, CAM‑2, RDO…). |
| **FDR Factual Report** | PDF + **plots** (images) + sometimes **CSV/XLSX** of parameters | Time base = FDR subframe ref / UTC. Hundreds of parameters. |
| **Aircraft Performance Study** | PDF with charts | Derived AoA, energy, trajectory reconstruction. |
| **ATC Group Factual, ATC transcripts** | PDF, sometimes MP3/WAV, radar CSV/KML | Time base = UTC. |
| **Meteorology Factual** | PDF + METAR/TAF text + satellite/radar images, soundings | |
| **Airworthiness / Systems / Powerplants / Structures** | PDF + photos | Component findings, teardown. |
| **Maintenance records** | **Scanned PDFs** (logbooks, work cards, handwriting) | Hard OCR, high value (deferred defects, recurring write-ups). |
| **Materials Laboratory reports** | PDF + SEM/fractography images | Fatigue cracks, striation counts. |
| **Survival Factors / Airport / ARFF** | PDF, diagrams | Post-crash, less relevant for cause. |
| **Photos, wreckage diagrams** | JPG/PNG/TIFF | Wreckage distribution, instrument positions. |
| **Animations / videos** | MP4/WMV | Security cam, animations of FDR data. |
| **Manuals & certification excerpts** | PDF (AFM, FCOM, QRH, ADs, SBs) | Baseline for "expected behaviour". |
| **Party submissions** | PDF | Biased by definition (manufacturer, operator, union). Tag as advocacy. |
| **Preliminary / Final report, Board meeting** | PDF | **Hold out for evaluation** (see §8). |

Also: file name conventions are messy (`Docket item 34 - Operational Factors - Attachment 7.pdf`). The docket index (CSV/HTML listing title + item number) is worth parsing first if included.

---

## 2. Stage 0 — Ingest & Triage (deterministic + 1 cheap LLM call per file)

1. **Unzip safely** into `cases/<case_id>/raw/` (path traversal check, size limit, nested zips).
2. **Fingerprint**: SHA‑256, MIME sniff (`python-magic`/`filetype`), page count, file size.
3. **Text-layer check for PDFs** (`pymupdf`): chars/page. < ~50 chars/page → scanned → send pages as images to Gemini (native vision OCR is fine; no Tesseract needed).
4. **Split large docs**: chunk PDFs at ~20–30 pages *on section boundaries* (use PDF outline/TOC if present). Keep 1-page overlap. Each chunk is a job.
5. **Classifier call (Flash‑class model)** on first 2–3 pages / thumbnail →
   ```json
   {"doc_role":"cvr_transcript|fdr_report|fdr_data|ops_factual|hp_factual|interview|atc|weather|maintenance|materials|photo|manual|party_submission|final_report|other",
    "time_base":"utc|local|cvr_elapsed|fdr_subframe|none",
    "priority":1-5, "contains_tables":bool, "contains_plots":bool, "notes":"..."}
   ```
6. **Job queue**: `(file, chunk, doc_role) → specialist extractor`. Priority order: CVR, FDR, Ops, ATC, HP first so the timeline skeleton appears early in the UI.

---

## 3. Stage 1 — Extractor swarm

### 3.1 Common output schema ("Evidence Atoms")

Use Gemini **structured output** (`response_schema` from Pydantic). One schema for all extractors so fusion is uniform:

```python
class Citation(BaseModel):
    file_id: str; page: int | None
    quote: str            # verbatim, <= 300 chars — used by verifier
    bbox: list[float] | None   # optional, for highlight in UI

class TimeRef(BaseModel):
    raw: str              # "1:49:21.3 EST", "CVR 00:31:12", "FDR SF 23411"
    basis: Literal["utc","local","cvr_elapsed","fdr_subframe","relative","unknown"]
    utc_estimate: datetime | None
    uncertainty_s: float | None

class Event(BaseModel):
    id: str; time: TimeRef
    actor: str | None                 # "Captain", "ATC Approach", "Autopilot", "Left engine"
    category: Literal["crew_action","crew_comm","atc_comm","aircraft_state","system_event",
                      "alert_warning","environment","maintenance","organizational","impact","post_impact"]
    description: str
    parameters: dict[str, float|str]  # {"altitude_ft":1800, "ias_kt":131}
    citations: list[Citation]
    certainty: Literal["measured","recorded","reported","inferred","claimed"]

class Anomaly(BaseModel):
    id: str; time: TimeRef | None
    domain: Literal["human_performance","procedural_deviation","aircraft_system","powerplant",
                    "structure","flight_path_energy","environment","atc_communication",
                    "maintenance_airworthiness","training_qualification","organizational_oversight",
                    "design_certification","survival"]
    expected: str        # what SOP / manual / normal ops says
    observed: str        # what actually happened
    severity: Literal["info","minor","significant","critical"]
    related_event_ids: list[str]
    citations: list[Citation]

class Entity(BaseModel):   # people, aircraft, components, orgs, locations
    id: str; type: str; names: list[str]; attributes: dict

class Fact(BaseModel):     # static facts: crew hours, aircraft config, MEL items, weather obs
    subject: str; predicate: str; value: str; citations: list[Citation]
```

Prompt rules for all extractors:
- Extract **only** what the document states; mark interpretation as `certainty="inferred"`.
- Always give the verbatim `quote`. Keep raw time strings; never "convert" time in Stage 1 except when the doc states the conversion.
- Interviews → `certainty="claimed"` + who claimed it.
- Party submissions → tag `advocacy=true`.

### 3.2 Specialist extractors (prompt + tools per doc role)

| Agent | Input | What we want | How |
|---|---|---|---|
| **CVR agent** | CVR transcript PDF | Every utterance as event (speaker, time, text), callouts, alerts (stick shaker, GPWS, "caution terrain"), non‑pertinent conversation (sterile cockpit violations!), checklist calls | Table-heavy: send pages as PDF to Gemini, ask for row-wise JSON. Detect sterile‑cockpit violations, missed callouts vs SOP. |
| **FDR agent (report)** | FDR factual PDF + plots | Parameter list, key excursions described in text, plot readings | Vision on plot pages: "read approximate values at annotated times". Low certainty, use for cross-check. |
| **FDR agent (data)** | CSV/XLSX | Exceedances, mode changes, AP disconnects, stall warning, flap/gear changes, engine params | **Python first** (pandas): detect discrete transitions + threshold exceedances (see §4). LLM only summarises the detected list and names parameters. Gemini **code execution** tool can do this if we want it "agentic". |
| **ATC agent** | ATC transcripts, radar | Clearances, readbacks, readback errors, altitude/speed assignments, frequency changes, radar track points | Readback-mismatch detection is a strong anomaly source. |
| **Ops factual agent** | Ops group report | Flight sequence narrative, SOPs relevant to event, crew pairing, company policies | Also extract **SOP baselines** ("expected behaviour") into a `Baseline` store → anomalies elsewhere compare against it. |
| **Human Performance agent** | HP factual, interviews | 72‑hr sleep/wake, commute, fatigue, medications, training failures, prior events | Fact-heavy. Builds crew entity profiles. |
| **Interview agent** | Interview summaries | Claims, opinions, contradictions, culture indications | All `certainty="claimed"`, attributed. |
| **Weather agent** | Met factual, METARs, images | Wx timeline (METAR every hour/SPECI), icing, wind shear, visibility, PIREPs | Parse METAR deterministically (`python-metar`), LLM for narrative/images. |
| **Maintenance agent** | Scanned logbooks, work cards | Deferred items (MEL), recurring write-ups, missed inspections, AD/SB compliance | Vision OCR page by page; highlight **recurring defects** on same system (classic precursor). |
| **Systems/Structures/Powerplant/Materials agent** | Group factuals + lab reports + photos | Component state at impact, pre-existing damage, fatigue, failure mode | Distinguish pre-impact vs impact damage explicitly (key field). |
| **Photo/diagram agent** | JPG/PNG | Caption, what's visible (instrument readings, switch positions, wreckage layout) | Cheap flash model, low priority; useful for UI gallery. |
| **Video/audio agent** | MP4/MP3 | Timestamped observations | Gemini native video/audio; only if time permits. |
| **Manual/cert agent** | AFM/FCOM excerpts | Limitations, procedures → Baseline store | Feeds "expected" side of anomalies. |

### 3.3 Model choice (confirm exact Gemini 4.x IDs at the event)
- **Flash‑class** (cheap, fast): triage, photos, simple tables, verifier passes.
- **Pro‑class** (long context, reasoning): CVR, Ops, HP, all Stage‑2 agents.
- Use **context caching** for the shared "case brief" (aircraft type, date, crew names, location, SOP baseline) that every extractor gets as a prefix — fewer tokens, consistent naming.
- Concurrency: `MAX_CONCURRENCY` (default 32) job workers = extractor agents, same cap on simultaneous Gemini calls via `asyncio.Semaphore` + exponential backoff on 429. Job retries ×2; on schema validation failure, re-ask with the validation error.

---

## 4. Stage 1.5 — Deterministic numeric tools (don't let the LLM do math)

Python module `tools/` exposed as **function-calling tools** to the agents:

- `fdr_transitions(df, params)` → discrete changes (AP engage/disengage, flap, gear, stick shaker, master warning, mic keying).
- `fdr_exceedances(df, rules)` → rules table, e.g. `pitch > 15°`, `|bank| > 35°`, `AoA > stall_aoa - 2`, `descent rate > 2000 fpm below 1000 ft AGL`, `IAS < Vref-10`, `N1 split > 10%`.
- `energy_state(df)` → total energy / rate, low-energy approach flag.
- `metar_parse(str)`, `density_altitude(...)`, `sun_position(lat, lon, t)` (night/glare).
- `radar_to_track(csv|kml)` → lat/lon/alt path for the flight-profile view.
- `time_offset_solve(anchors)` → least-squares offset between clocks (see §5.1).

Results become Events/Anomalies with `certainty="measured"` and citation `file_id + row range`.

---

## 5. Stage 2 — Fusion agents (the "common truth")

Run once Stage 1 drains (and incrementally as batches finish, so the UI grows live).

### 5.1 Time Aligner (hardest + most impressive)
Different clocks: CVR elapsed, FDR subframe, ATC UTC, local time in interviews, "approximately 5 minutes later".
- Find **anchor events** present in ≥2 sources: radio transmissions (CVR "RDO‑1" ↔ ATC transcript ↔ FDR VHF mic‑key discrete), stick shaker (CVR sound ↔ FDR), impact / end of recording.
- Solve offset per source (least squares, robust to outliers) → convert all `TimeRef` to `utc_estimate ± uncertainty`.
- Relative/vague times ("shortly after") → placed with wide uncertainty band; UI shows them as fuzzy bars.
- Agent role: propose anchor pairs (LLM, semantic matching) → tool solves → agent checks residuals.

### 5.2 Entity Resolver
Cluster names → canonical entities (Captain/PIC/HOT‑1/"Pilot A"; aircraft registration; component P/Ns). LLM with candidate list + embedding similarity.

### 5.3 Event Deduplicator / Merger
- Candidate pairs = same/similar category, |Δt| < window, embedding similarity > τ.
- LLM decides `same | different | related`. Merged event keeps **all citations** → "corroboration count" (shown as line weight in UI).

### 5.4 Conflict Detector
For merged events/facts with disagreeing values (altitude, time, who said what) → `Conflict{atoms, nature, which source more authoritative and why}`. Authority order default: measured (FDR) > recorded (CVR/ATC) > factual report text > interview claim > party submission.

### 5.5 Anomaly Linker → Causal graph
- Nodes: anomalies (+ key events). Edges: `precondition_of | contributed_to | triggered | masked | mitigated | contradicts`, each with rationale + citations + confidence.
- Organise by layer (Swiss‑cheese / **HFACS**): Organizational → Supervision → Preconditions → Unsafe acts → Aircraft/Environment → Outcome.
- Tag overall occurrence with **ICAO CICTT categories** (LOC‑I, CFIT, SCF‑PP, SCF‑NP, ICE, RE, ARC, …).

### 5.6 Hypothesis Agent
Generates 2–5 competing explanations ("Crew failed to recognize low-energy state due to fatigue + automation confusion" vs "Pitot icing led to erroneous IAS"). For each: supporting anomalies, contradicting evidence, open questions / missing data ("no maintenance records for the pitot heat system in docket"). This is the "diagnose" output.

### 5.7 Verifier / Critic
- For every citation: fuzzy-match `quote` against the extracted text of that page (rapidfuzz ≥ 85). Fail → drop atom or downgrade + re-extract.
- LLM critic pass on the causal graph: "Is each edge actually supported by the cited text?" → prunes overreach.
- Report **coverage**: % of files processed, % atoms verified.

### 5.8 Output: `case_graph.json`
```
{ case, aircraft, crew[], entities[], clocks{source: offset±σ},
  events[], anomalies[], facts[], conflicts[], causal_edges[],
  hypotheses[], open_questions[], sources[], stats{} }
```

---

## 6. Blueprint UI

**Look:** dark navy paper (`#0B2545`) with fine cyan grid (`#8EC5FF` @ 15%), white/cyan 1px line work, monospace labels (IBM Plex Mono / JetBrains Mono), dimension-line style annotations, title block in the corner (case no., aircraft, date, "SHEET 1 OF 4"), red/amber callout bubbles for anomalies. Subtle line-drawing animation on first render (SVG `stroke-dashoffset`).

**Views (tabs as "sheets"):**
1. **Sheet 1 — Timeline**: horizontal UTC axis, zoomable (D3 zoom; seconds near impact, hours for 72‑hr history). Swimlanes: *Crew · Cockpit voice · ATC · Aircraft state · Systems/Alerts · Environment · Maintenance/Org*. Events as ticks, anomalies as numbered callouts, uncertainty as fuzzy bars, conflicts as split markers. Click → side panel with quotes + "open source at page".
2. **Sheet 2 — Flight profile**: altitude & IAS vs time (vertical profile) + lateral track (plan view) from FDR/radar, anomalies pinned on the path. Looks like an engineering elevation drawing.
3. **Sheet 3 — Aircraft schematic**: generic airliner outline (own SVG line drawing) with system callouts (engines, flight controls, pitot/static, gear, doors) colored by anomaly count.
4. **Sheet 4 — Causal graph**: HFACS layered left→right DAG (dagre/elkjs), edges labelled, hypotheses as highlightable paths.
5. **Live "Agent Swarm" panel** (demo gold): grid of file cards flipping states queued → reading → extracted (n atoms) → verified; counters ticking up; timeline populating live via SSE.

Tech: React + Vite + TypeScript, D3 for timeline/profile, elkjs for graph, Tailwind for chrome, PDF.js to show source page with highlighted quote.

**As scaffolded:** sheets are *1 Timeline (2D, D3 zoom)*, *2 Flight profile (2D stacked parameter bands)*, *3 Flight path 3D (three.js: ADS‑B track with altitude curtain, ground shadow, anomaly markers, scrub‑synced aircraft marker; falls back to altitude ribbon from FDR)*, *4 Causal graph (HFACS columns, hypothesis highlighting)*. A shared time cursor links all sheets. The UI is fully reactive: SSE events (`files`, `job`, `atoms`, `stage`, `fusion`, `done`) are applied incrementally, so file cards scan, counters tick, and events/anomalies pop into the timeline and 3D scene as each agent finishes. **Replay swarm** re-plays the recorded `events.jsonl` compressed to ~25 s for offline demos. **Sheet 0 — Aircraft** (default, the central view): original side-section blueprint of a generic twinjet that pitches with FDR pitch. Moving elevator/flaps, retracting gear, fan animation from N1, stick-shaker vibration, speed streaks, ground plane rising with altitude, θ / γ / α annotations. Ten system callout boxes (air data, autoflight, flight deck, empennage, engines, wings, gear, structure, comms, environment) with leader lines to the parts show live values at the playhead, sparklines, discrete states, latest event, and alarm when an anomaly fires. Each box links to a drill-down list. A flight-state box (ADI + readouts) and an anomaly feed complete the view. A global playback bar (play / 1–60× / scrub / jump to anomaly / space key) drives every sheet. Deep link: `#case=<id>&t=<seconds UTC>`.

---

## 7. Architecture & repo layout

As scaffolded (PyMuPDF is blocked by Windows application control on the dev laptop → `pypdf` behind `pdfutil.py`):

```
backend/app/
  main.py             FastAPI: POST /api/cases (upload) · POST /api/cases/local (folder) · GET /api/cases/{id}
                      GET /api/cases/{id}/stream (SSE) · GET /api/cases/{id}/events (replay log) · GET .../files/{file_id}
  cli.py              run a case headless (precompute demo)
  orchestrator.py     ingest → triage → priority-queue swarm → verify → align → dedup → link; emits events
  schemas.py          LLM-facing + stored models (single source of truth)
  store.py            file-based case store + SSE event bus
  pdfutil.py          PDF page text / subset / outline (pypdf)
  timeparse.py        raw time strings → seconds since 00:00 UTC of accident date
  ingest/             unzip.py inventory.py triage.py chunker.py
  agents/             llm.py (Gemini wrapper) prompts.py extractor.py atoms.py mock.py (offline regex extractor)
  tools/              table.py fdr.py (transitions + exceedances + series) track.py (ADS-B → 3D track)
  fusion/             verifier.py time_align.py dedup.py linker.py
frontend/src/
  App.tsx Home.tsx panels.tsx (title block, pipeline, swarm, detail, log) useCase.ts (live SSE reducer)
  sheets/ Timeline.tsx Profile.tsx Flight3D.tsx CausalGraph.tsx
  sample.ts (synthetic data for UI dev) theme.css
```

Keep everything file-based (JSON per job) → resumable, cacheable, easy to debug, and we can **pre-compute** the demo case so the live demo never depends on rate limits.

---

## 8. Demo case & evaluation

**Decision: Atlas Air 3591 — DCA19MA086** (B767‑375BCF, 2019‑02‑23, Trinity Bay TX; final report AAR‑20‑02; local = CST = UTC−6).
The docket has 78 items: rich but manageable. Key items (checked on data.ntsb.gov): #1 Ops/HP group factual (86 pp) + attachments #2–32 (#2 is the 734‑page interview compilation → capped by `MAX_PAGES_PER_DOC`), #37/#38 FDR ancillary report + **CSV**, #48 **ADS‑B CSV** (→ 3D track), #52 maintenance records, #53 ATC factual, #57 ATC audio WAV, #60 ATIS MP3, #61 ATC transcript, #62 airplane performance study, #63 powerplants, #66/#67 FDR factual + **CSV**, #68 CVR group chairman's factual + transcript (54 pp), #69 CVR sound spectrum study, #70 systems, #33–34/#49–51 MP4 videos, #55 radar (PPB), #75–78 party submissions.
Download the docket into `<DATA_DIR>/dockets/DCA19MA086/` (default DATA_DIR: `~/DocketBlueprintData`, outside OneDrive) (keep the item number at the start of each filename — triage uses it).

Other candidates considered:
- **Atlas Air 3591**, B767F, 2019 (DCA19MA086) — FDR/CVR, spatial disorientation, HP; strong.
- **Colgan Air 3407**, Q400, 2009 (DCA09MA027) — stall, fatigue, sterile cockpit; very rich HP + CVR.
- **Southwest 1380**, B737, 2018 (DCA18MA142) — fan blade fatigue; good materials/maintenance angle.
- **Asiana 214**, B777, 2013 (DCA13MA120) — automation/energy state; great FDR profile.

**Blind mode (key differentiator):** exclude final report, Board presentations and "probable cause" docs at ingest (doc_role = `final_report`). After run, an **Evaluator agent** compares our anomalies/hypotheses against the NTSB findings & probable cause → show a "recall vs NTSB findings" score on stage. Very convincing to judges.

---

## 9. Hackathon schedule (adjust to event length)

| Block | Person A (backend/agents) | Person B (extraction quality) | Person C (frontend) |
|---|---|---|---|
| H0–2 | Repo, FastAPI upload, unzip, triage, Gemini wrapper w/ structured output | Download demo docket, inventory file types, write schemas.py | Vite app, blueprint theme, title block, static mock timeline from fake JSON |
| H2–6 | Orchestrator + fan-out + SSE progress | CVR, Ops, ATC, FDR extractors + FDR python tools | Timeline sheet (zoom, lanes, callouts, side panel) + Swarm panel |
| H6–10 | Time aligner, dedup, entity resolver | HP, interview, wx, maintenance extractors; prompt tuning on real pages | Flight profile sheet, source viewer (PDF.js + highlight) |
| H10–14 | Linker, hypotheses, verifier, evaluator | Run full case, fix failures, cache results | Causal graph sheet, schematic, animations |
| H14+ | Precompute demo, fallback cached run, pitch | Blind-mode score | Polish, recording of demo video |

**MVP cut line** (if time runs out): Triage → CVR + FDR + Ops + ATC extractors → time align + dedup → timeline sheet + swarm panel. Everything else is bonus.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Hallucinated events/quotes | Mandatory citation + verifier fuzzy match; UI only shows verified atoms (toggle to see unverified). |
| Clock misalignment ruins timeline | Anchor-based solver, show uncertainty explicitly, manual override of offsets in UI. |
| Rate limits / cost with 300 files | Priority queue, Flash for low-value docs, skip/limit photos, context caching, cache by SHA‑256. |
| Huge scanned maintenance PDFs | Page-sampling + only pages that triage flags as relevant; low priority. |
| Over-reaching causal claims | Edge confidence + critic pass + "open questions" list; frame as decision support, not probable cause. |
| Docket download format varies | Accept ZIP **or** multi-file drop; ignore unknown types gracefully, list them as "not processed". |
| Live demo flakiness | Pre-computed case_graph.json + replay of SSE event log to "re-run" swarm animation offline. |

---

## 11. Future TODOs — learned anomaly detection on recorder data

The scaffold detects FDR anomalies with hand-written rules (`tools/fdr.py`: discrete transitions + thresholds). Next options, roughly in order of value per hour:

1. **Google TimesFM** (time-series foundation model, open weights from Google Research; `timesfm` package / Hugging Face checkpoint): zero-shot forecast each FDR parameter from a rolling context window; anomaly score = |actual − forecast| normalised by the model's quantile spread. Flag segments where several correlated parameters (pitch, AoA, Nz, elevator, column force) diverge together. Fits the Google stack story; run on GPU/Colab or Vertex AI. Feed the resulting segments to the FDR agent as `certainty="measured"` anomalies with the score attached.
2. **Matrix profile** (`stumpy`): discord discovery finds the most unusual sub-sequences per parameter without training; cheap and explainable.
3. **Change-point detection** (`ruptures`, PELT/BinSeg): regime changes such as mode transitions, thrust changes, and the onset of an upset; good timeline anchors.
4. **Multivariate isolation forest / robust PCA** on engineered features (rates, cross-parameter residuals): catches odd combinations that look normal one parameter at a time.
5. **Physics consistency checks**: residuals of simple kinematic relations (vertical speed vs d(alt)/dt, pitch − flight-path angle ≈ AoA, Nz vs pitch rate × TAS). They catch sensor faults vs real motion.
6. **Fleet / phase baselines**: compare against normal-flight envelopes for the same type and phase (needs other flights' data; FOQA-style). Long-term.
7. **Gemini on rendered plots**: render parameter plots to PNG and ask Gemini to describe the inflections. Useful for narrative and cross-checking the numeric detectors.
8. **Same detectors on ADS-B / radar tracks**: abnormal descent rates, track deviations, speed excursions when no FDR data exists (GA accidents).

**Done since the scaffold:**
- **Media:** Gemini audio/video extraction through the File API, with citations that carry `media_s` so the UI can seek to the moment. Simulator videos become facts, not timeline events.
- **Radar:** the STARS `.ppb` parser filters the accident aircraft by its Mode-S address and extracts radar altitude, track association and the last return.
- **FDR CSV:** real NTSB exports are handled (preamble, units row, enums, sparse 1/64-s rows, CST→UTC), and the FDR lat/lon becomes the primary track.
- **ADS-B:** the hour is recovered for MM:SS-only clocks by matching altitude against the FDR, and ADS-B v2 autopilot/MCP transitions are extracted.
- **Ancillary data:** recorder data from other aircraft is held out.

The UI design is in [docs/UI.md](docs/UI.md).

Other TODOs from the scaffold: context caching for the case brief, LLM anchor proposer in the time aligner (CVR ↔ ATC ↔ FDR mic-key), LLM conflict detector, entity resolver beyond alias match, aircraft schematic sheet, PDF.js viewer with quote highlight, evaluator agent for blind-mode scoring.

## 12. Open decisions
1. Exact Gemini 4.x model IDs / quotas available at the event (Pro vs Flash split).
2. ~~Which demo case~~ → Atlas Air 3591 (see §8).
3. Event length → which cut line.
4. Agent framework: plain `asyncio` orchestrator (recommended: transparent, fast to debug) vs Google ADK if judges reward its use.

## 13. Investigator team and evidence graph — implementation goals

Status: planned; the existing single investigator remains the baseline. New report schemas are in progress. This section describes intended behavior, not completed capabilities.

### Analysis goals

- Run three specialists concurrently: flight sequence and timing; aircraft systems and recorder consistency; crew performance, training and organizational context.
- Give each specialist independent evidence retrieval and require cited findings, contrary evidence and unresolved questions. Search hits alone do not establish a finding; agents should open the underlying evidence and relevant source pages.
- Run a challenger after the specialists to examine competing explanations and identify unsupported causal jumps, source disagreements and gaps.
- Have a lead investigator reconcile the reports and produce an explicit overall conclusion: strongest supported explanation, evidence supporting it, alternatives considered, remaining uncertainty and limitations.
- Keep arithmetic and recorder analysis in deterministic tools. Admit findings and causal edges only when their evidence was actually retrieved and carries valid citations.
- Use a bounded budget, initially up to 25 model turns across the team, with visible per-agent usage and coverage. A budget limit or missing evidence must yield a qualified, visibly incomplete result.

### Interface goals

- Replace the dense activity list with a graph showing sources and evidence on the left, agents and tool actions in the middle, and findings, hypotheses and the conclusion on the right.
- Animate nodes and links from persisted activity events so viewers can replay actual reads, tool calls and evidence handoffs. Do not invent actions or display private model reasoning.
- Make every evidence node inspectable with its quote and source location; connect result nodes only to the evidence actually used.
- Give hypotheses a readable comparison view with a short explanation, supporting evidence, challenges, context and open questions. Avoid duplicate inspector panels that squeeze the graph.

### Completion criteria

- A rerun starts from the existing immutable base extractions in a new case, preserving prior results and avoiding extraction charges.
- Each specialist has a recorded status and cited report; the challenger and lead receive traceable evidence handoffs.
- The final report contains a cited overall conclusion or clearly explains why no supported conclusion was reached.
- Coverage reports distinguish available sources, inspected evidence, opened pages and recorder checks; they do not imply exhaustive review.
- The activity graph replays saved events without additional model calls, and hypotheses remain understandable even when absent from the causal chain.
- Validate citation rejection, budgets, partial failures and cached reruns; inspect the UI with both legacy and team reports before declaring the work complete.
