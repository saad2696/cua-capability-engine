# Design
- confidence = weighted: pass rate (0.6), primary-locator hit rate (0.3), checkpoint latency stability (0.1). Stored 0–1 with the inputs so it is explainable.
- Fault schedule option injects `slow`/`session_expired` on some runs to verify recovery is stable.
- Runs are sequential (single browser) to keep the target app deterministic.
- Console artifact viewer shows confidence badge and stability history.
- Approval writes `approvedBy`, `approvedAt`, `stabilityRunId` to `capability`.
