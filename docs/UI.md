# UI design — Docket Blueprint console

## 1. What people need to see

| Need | Question it answers | Data it needs | Where |
|---|---|---|---|
| **Run status** | Is it working? What is being read? How far? Cost? Errors? | files (role, pages, status, atoms), jobs, stage, LLM usage, log | **Sources** view (default while running) + stage bar in header |
| **Flight state at time t** | What was the aircraft doing? | FDR/ADS-B series (alt, IAS, V/S, pitch, roll, AoA, Nz, N1, controls), discretes (AP, A/T, GA, shaker, gear, flaps) | **Aircraft** view: side section + system callouts + ADI |
| **Sequence** | What happened when, and who said what? | timed events per lane (CVR, ATC, systems, aircraft, env/org), anomalies | **Timeline strip** — always visible, the single time control for every view |
| **Abnormalities** | What deviated, how badly, how sure are we? | anomalies (expected vs observed, severity, certainty, HFACS layer, verification) | **Inspector** (right rail) register; alarms on the aircraft |
| **Reasoning** | How do anomalies connect? What are the competing explanations? | causal edges, hypotheses, open questions | **Causal** view + Inspector |
| **Trust** | Where does this come from? | citations: quote, file, page or media time, verified score | **Inspector** detail → opens the source (PDF page / video at time) |
| **Media** | What do the videos / recordings show? | Gemini video + audio extraction with media timestamps | **Sources** view player, seeks to evidence |
| **Spatial** | Where was it? | track lat/lon/alt | **3D path** view |

## 2. Layout rules

* No stacked panels and no fixed bottom bar. The layout is three zones: **header (48 px)**, **center (view + timeline strip)**, **inspector (right rail)**.
* **One clock**: the timeline strip below the view holds the transport (play, speed, jump to anomaly, zoom presets), shows lanes and anomalies, and is the scrubber. Every view reads the same cursor.
* **The Aircraft view is the hero.** It uses HTML boxes at fixed, readable font sizes in a 5×3 grid around the aircraft SVG. Leader lines are drawn in an overlay computed from the real DOM positions, so nothing gets scaled into illegibility and nothing overlaps.
* **Aircraft drawing**: a clean side section, rotated by pitch (visual clamp ±28°, true value printed), with the ground plane and the flight-path vector. Angle readouts sit in a legend corner, not as floating labels.
* **Inspector**: if something is selected, show its detail and evidence; otherwise the abnormality register (active up to t highlighted), hypotheses and open questions.
* The **Sources** view replaces the old swarm panel and log bar: a document grid with live status, a log, and a preview (PDF / video / audio).
* Responsive: below 1200 px the inspector narrows to 300 px; below 1000 px it becomes a slide-over.

## 3. Views

1. **Aircraft**: system callouts (comms/ATC, autoflight, flight deck, air data, flight state | structure, empennage, wings, engines, gear) around the section.
2. **3D path**: three.js track.
3. **Profile**: stacked parameter bands.
4. **Causal**: HFACS columns with hypothesis paths.

The Sources view also shows the lead investigator's public activity trace:
question → tool request → cited evidence → conclusion. Each step has a stable ID,
turn number, phase, evidence IDs and source citations, emitted as an `investigator`
SSE message and persisted in `CaseGraph.investigation`. **Replay investigation**
replays this trace on its own; it makes no model calls. Source chips open the
corresponding PDF page or media position. Reduced-motion preferences disable
entry animations.

Profile bands share a UTC axis. Sources whose hour is unresolved must not appear
on that axis as though their partial clock were UTC; show an alignment notice
until a `clock_sync` update arrives.

The timeline overview window supports dragging and click-to-recenter; Shift-drag
or horizontal scrolling pans the detailed strip. Plain dragging scrubs and pauses
playback. Untimed findings are labelled "time unknown", rather than being assumed
to be latent conditions active from the start. The Flight view hides them and
retrospective testimony by default; **Context** reveals that material explicitly.

Flight annotations age on the playback clock: blue after 5 minutes, grey after 15 minutes without a
new observation, hidden after 30. A source-established ongoing interval stays
visible until it ends; the inactivity clock then starts at its end. Repeated
observations survive fusion deduplication and reset the age when playback reaches
them. Hovering does not reset age. Hiding an annotation does not remove evidence
from the register or causal graph. Untimed context has no invented age.

Recorded samples remain unchanged. Display interpolation uses a shape-preserving
cubic curve between samples, shared by the instruments and Profile cursor. The
3D aircraft additionally eases position/attitude over 350 ms; large timeline jumps
snap immediately. Labels show full titles with wrapping and use their measured
height for collision spacing.
5. **Sources**: the swarm, the log, and a media/PDF preview.
