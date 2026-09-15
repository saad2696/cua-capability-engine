# Diagrams to produce at the end (mermaid, for the video walkthrough)

- [ ] System architecture: packages, apps, Surface seam, artifact store, evidence store
- [ ] Discovery loop: observe → decide → act → record, with policy check and stop conditions
- [ ] Perception pipeline: CDP frame tree → per-frame AX tree → boxes → filter → marks → Observation
- [ ] Locator lifecycle: capture (candidates + rationale) → resolve on replay → drift signal
- [ ] Replay step state machine: precondition → resolve → act → expect → detect → outcome/recover/fail
- [ ] Error taxonomy decision tree: business vs recoverable vs failure vs escalate
- [ ] Session controller state machine: running → paused → human_control → resuming, with leases
- [ ] Escalation sequence: engine ↔ console ↔ operator, frame stream and input forwarding
- [ ] Artifact lifecycle: draft → needsReview/approved → deprecated, with stability gate
- [ ] Multi-tenant overlay merge: base artifact + tenant overlay → effective artifact
- [ ] Policy enforcement layers: decision → surface boundary → network → pre-flight, and where a
      human override is recorded instead of refused
- [ ] Risk grading: signals in, `risky` / `sideEffect: possible` / `none` out, and what each mode
      (escalate, approvedArtifact, humanConfirm, block) does with the answer
