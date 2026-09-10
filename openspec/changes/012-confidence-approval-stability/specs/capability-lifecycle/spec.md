## ADDED Requirements
### Requirement: Measured stability before approval
The system SHALL replay an artifact N times, report pass rate and drift, compute an explainable confidence score, and SHALL refuse approval below a configured threshold unless forced with a reason.

#### Scenario: Flaky artifact
- **WHEN** stability shows 7/10 passes
- **THEN** approval is refused with the failing steps listed
