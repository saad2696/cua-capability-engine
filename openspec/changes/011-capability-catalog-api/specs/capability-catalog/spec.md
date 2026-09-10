## ADDED Requirements
### Requirement: Discoverable, invocable capabilities
The system SHALL expose approved artifacts as typed tool definitions and SHALL execute one by name with validated arguments, returning the structured replay result.

#### Scenario: Agent invocation
- **WHEN** an agent calls `member-savings-balance` with `{ memberId: "10042" }`
- **THEN** the response is `success` with `savingsBalance` and the run appears in evidence
