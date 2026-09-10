## ADDED Requirements
### Requirement: Base artifact plus tenant overlay
The system SHALL replay a base artifact against a tenant variant by merging a tenant overlay, without modifying the base artifact.

#### Scenario: Re-labeled field
- **WHEN** tenant-b renames "Member ID" to "Account Holder #" and the overlay provides the alias
- **THEN** replay succeeds and evidence shows the alias candidate matched

### Requirement: Drift detection without acting
The system SHALL report, per step, which locator candidate resolves on a target without performing actions.

#### Scenario: Dry run
- **WHEN** `cua drift` runs against tenant-b with no overlay
- **THEN** the report lists the steps whose primary candidate misses and proposes an overlay skeleton
