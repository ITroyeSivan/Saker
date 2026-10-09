# Saved HTTP evidence integrity — Saker 0.4.98

2026-10-09, official Windows dsh Desktop 0.2.0-rc.2, redteam-results 1.0.48. This is a repair to saved evidence validation, not completion of G1/G3/G4 or an effectiveness comparison.

Previously `readExecutionReceipt` checked the recorded request revision but did not recompute the stored request/response digests. Replacing captured bytes could leave a persisted private-read effect and finding deliverable. The reader now validates canonical base64, request and response SHA-256, captured length, response length and HTTP status consistency before marking the receipt current. Missing digests are unverified. Historical records remain readable; the reader does not invent replacement digests, delete evidence, or send HTTP to repair it.

## Actual checks

- Production regression: 99 suites, 13,669 passing assertions, zero failures, 16 skips; 95 required suites present. Nine byte/metadata/missing-digest mutations revoke persisted effects and delivery. Restoring the old reader makes the named test fail in the reverse runner; restoring the fix passes.
- Official Desktop loaded the updated packages and a temporary private verification addon. A real native standard agent called the addon once. It loaded the **installed production** execution/effect/finding functions, created an owned temporary database and a localhost HTTP fixture, and captured eight distinct requests through the production effect job. Initial independent effect and delivery were valid. Seven corruption variants each made receipt integrity, persisted effect currentness and delivery false. Original records remained readable; restoring bytes restored delivery. Assertions require the HTTP count to remain eight throughout.
- The renderer opened the actual native session and displayed the result with no slot errors. This verifies the changed backend evidence gate under Desktop, not the complete user finding/retest workflow or autonomous discovery. No user database or external target was modified. Source/installed SHA-256 and actual tool/model events are in `native-proof.json`.
- The verification addon initially failed activation because its RPC needed the `webServer` dependency. Version 0.0.2 declares it and the actual route, model call and assertions passed. This was a probe defect, not a hidden passing result.
- The model's final explanation reached the probe's configured output cap. It also incorrectly related eight HTTP requests to seven mutations. Its prose is preserved as a limitation; the request-count evidence comes from actual fixture counters and assertions, not that explanation.

## MCP and boundaries

The actual MCP settings page loaded Burp/Yakit, Save remained disabled, and there were no slot errors. Live state changed from the earlier calibration's offline state: **two enabled, two connected, 176 catalog tools** (Burp 27, Yakit 149). No MCP tool was invoked in this probe, so this is connection/catalog evidence, not a complete capability smoke test. Configuration was not edited.

Digests detect corrupted/replaced content against saved hashes; they do not authenticate a database adversary who rewrites bytes and all matching hashes. Historical proof at its recorded time remains distinct from live applicability/freshness and retesting. That larger contract is unfinished. The two earlier failed autonomous calibration scores remain unchanged.

Normal shortcut launch, addon removal and owned temporary cleanup are recorded in `cleanup.json`. The private addon is excluded from production packages. Full-tree token admission, complete three-group benchmark, Nday readiness and all remaining delivery goals stay active.
