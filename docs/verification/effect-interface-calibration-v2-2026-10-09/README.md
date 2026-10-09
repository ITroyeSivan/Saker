# Official Desktop interface v2 calibration — failures retained

2026-10-09. This verifies the development benchmark adapter, not a production effectiveness improvement. Saker remains 0.4.97; the private `@saker-dev/effect-benchmark` 0.0.5 bundle is excluded from production packaging and removed after verification.

## What was fixed and exercised

- Plain control explicitly resolves the native `standard` preset even though the user's default is `pentest`. A first Desktop startup correctly refused the run because standard creates a late agent-local `subagent` tool; no model was called in that rejected start. The adapter now creates a temporary standard composition with its single `subagent.modelSelectionSettings` row set to false. Both the original and effective composition digests and this adjustment are recorded; the user's standard definition is unchanged.
- Both real native request headers contain exactly `exercise_request` and `exercise_submit`, with identical compiled definitions (1,115 bytes) and access digests. The execution guard also denies later local tools. Ordinary-agent system context has no Saker marker; candidate context does. This compares preset guidance under a common restricted interface, not the full unrestricted product toolchain.
- Native idle seals the monotonic duration before controller polling and cleanup. Delayed status reads preserve the terminal 55,807 / 44,292 ms values. Duration starts immediately before admitted follow-up, excluding preset creation and controller task preparation; it is not full user startup latency.
- Concurrent stop callers await the same cleanup. Idle and closed target servers were verified before Desktop teardown. Four reverse mutations independently fail the required default-selection, duration, stop-race and late-delegation assertions.

## Actual model results

Both runs use fresh p1 fixtures, `deepseek-official / deepseek-flash`, native resolved reasoning `high`, max output 4,096, and the same nominal 5-minute / 40-request / 150k-token budget. They are calibration runs, not randomized repeats.

| Group | Requests | Main model generations | Recorded tokens including cache | Native work ms | Independent success | Unsupported confirmed claim |
|---|---:|---:|---:|---:|---|---:|
| Plain single standard agent | 32 | 10 | 166,715 | 55,807 | false | 1 |
| Saker 0.4.97 preset | 19 | 7 | 124,173 | 44,292 | false | 1 |

The fixture is actually vulnerable and both agents obtained private-object reads. Failure means their final evidence did not satisfy the predeclared two-round confirmation contract; it does not mean no leak occurred. Plain executed sufficient normal controls but omitted repeat controls from its citation list. Saker executed only one subject-normal control and cited only one owner-normal control. Both submitted unsupported confirmation under the fixed grader. Neither score was rewritten using unsubmitted receipts.

Plain also exceeded the nominal token budget. The adapter currently checks settled usage between steps, so a final generation can overshoot. This is direct evidence that the cap is not a hard token reservation. Both results retain `comparable=false`: budget calibration, hard admission, frozen 0.4.92 runs and three-repeat comparisons are unfinished. Lower one-run request/time/token counts do not prove an efficiency gain. Usage covers the agent's settled generations; ancillary title generation and provider billing are not claimed to be completely measured.

## Evidence and environment

`plain/` and `candidate/` contain unchanged result and actual local HTTP audit records. `native-proof.json` retains native headers, system-context sizes/hashes and markers, event/model usage summaries, and actual versus cited control counts. Original transcripts remain in the daily home. The only targets were ephemeral 127.0.0.1 fixture servers with generated identities and documents; no outside target or source update was performed.

Official Desktop UI opened the candidate session and displayed its completed 44-second / 124K-token turn without slot errors. `desktop.png` is a main-pane clip; its model-authored confirmation remains visible as evidence of the failure. The MCP settings page loaded Burp and Yakit, with Save disabled because nothing was changed. Actual status remains two enabled, zero connected, zero tools; connection usability is not claimed. No login was required or performed.

Regression: 99 suites, 13,667 passing assertions, zero failures, 16 skips; all 95 required suites present. Product packages and release assets were not changed. Cleanup and normal shortcut launch results are recorded in `cleanup.json`.

Next: complete admission budgeting and evidence-completeness handling, then freeze and run all three groups with repeats. The previous v1 failed run remains preserved separately. G1 and the full G0–G10 goal remain incomplete.
