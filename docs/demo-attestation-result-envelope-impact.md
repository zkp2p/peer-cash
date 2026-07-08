# Demo attestation result envelope impact

Temporary stack-impact smoke test for upstream `attestation-service` PR 274.

Upstream break:

- Public attestation-service `ServiceResponse` envelopes move payloads from `responseObject` to `result`.
- `@zkp2p/zkp2p-attestation` helpers unwrap `result`.
- `SERVICE_RESPONSE_ERROR` details expose `details.result`.
- No backward compatibility is intentionally included in the demo source PR.

Skill classification for this repo: **coordination/report-only**.

Impact notes:

- Consumer app should verify whether its SDK version exposes `result` before a real cutover.

Expected real-migration action:

- If this repo parses attestation-service envelopes directly, update code/tests from `responseObject` to `result`.
- If this repo consumes `@zkp2p/sdk` or `@zkp2p/zkp2p-attestation`, verify the bumped dependency and fixture contract before merging an upstream cutover.
- If this repo is report-only for this specific break, keep the PR as an explicit owner acknowledgement and close it after the drill.

This PR is temporary and should be closed after the demo drill succeeds.
