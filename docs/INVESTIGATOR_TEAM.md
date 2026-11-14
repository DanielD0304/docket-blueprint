# Investigator team

Use **Investigate again** on a completed case to run the team from its cached base extractions in a new case. The original case is preserved. The activity tab shows recorded reads and evidence connections; **Replay investigation** animates saved events without model calls.

CLI from `backend`:

```bash
python -m app.refuse --from-case atlas-3591 --case-id atlas-team-v2 --fusion team
```

Three specialists independently investigate sequence/timing, systems/recorders, and human/organizational factors. Their cited findings go to a challenger, then all four reports go to a lead for synthesis. Each context has separate inspected-evidence tracking. Receivers inherit only evidence explicitly included in the handoff. All agents can retrieve additional primary evidence through read-only tools. Recorder arithmetic remains in Python.

The initial ceiling is five model turns per agent plus one final evidence audit (26 total), with up to three tool calls per research turn. `--max-turns` can lower that per-agent ceiling; values above five are currently capped at five. At least two research turns precede a report when the budget permits. Failures remain visible per agent. Unsupported evidence references are rejected, and a missing supported overall conclusion leaves the report incomplete.

A citation gate proves retrieval and provenance, not that the quoted evidence logically entails the generated explanation. Review the actual quotes, competing explanations and limitations. Coverage counts describe retrieved evidence and successful tool calls; they do not imply exhaustive source review. PDF reads and recorder checks are optional model choices, not proof that all relevant pages or channels were checked.

The activity view is a moving force graph. Five agent hubs collect their recorded tool calls; source, finding, hypothesis and conclusion nodes appear as the local story cursor advances. Nodes settle through spring and repulsion forces rather than occupying fixed columns. Links represent recorded reads or shared cited evidence. Pause or scrub the story, drag nodes, zoom/pan, or select a node for its explanation and quotes. Contextual labels limit clutter. Replaying this visualization makes no model calls.

The lead conclusion receives a separate evidence audit before publication, checking numeric scope, attribution and uncertainty against the cited passages. This is another model review and can still miss errors; citation and human review remain necessary.

## First Atlas evaluation

`atlas-team-v1` reused the original Atlas extraction digest and finished in 491 seconds: 23 model calls, 54 tool calls, 343 distinct retrieved evidence IDs across 33 of 76 eligible sources, 14 PDF page-read calls and five recorder-window calls. It produced 22 specialist/challenger findings, 20 causal edges and four hypotheses, plus an overall conclusion. These counts describe coverage, not correctness.

Review found a temporal scope error: the conclusion generalized a source statement about angle of attack at particular moments to the entire interval. A separate final audit corrected the summary in `atlas-team-reviewed-v1`; the original result is preserved. The revised pipeline includes that audit before accepting the lead conclusion. Other improvements from inspection: shorter report prompts, explicit separation of measured and inferred claims, preservation of specialist open questions, team metadata through live updates, and graph follow/replay controls. The audit remains fallible, and source citations alone do not validate every inference.
