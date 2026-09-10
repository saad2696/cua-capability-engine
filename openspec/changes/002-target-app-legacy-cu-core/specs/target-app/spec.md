## ADDED Requirements
### Requirement: Multi-step member flow
The target app SHALL expose a login → search → member detail → new sub-account → confirm → done flow using server-rendered HTML with framesets, table layouts, and no element ids.

#### Scenario: Happy path
- **WHEN** an operator logs in with `demo/demo`, searches `10042`, opens the member, starts a sub-account, and confirms
- **THEN** a confirmation page with a confirmation number is shown

### Requirement: Deterministic fault injection
The target app SHALL trigger each of `not_found`, `validation`, `permission_denied`, `session_expired`, `unexpected_dialog`, `slow`, `server_error` on demand via query parameter or cookie.

#### Scenario: Not found
- **WHEN** a search is performed with `?fault=not_found` or for an unknown member id
- **THEN** the response is a page containing the text "No member found"

#### Scenario: Session expired mid-flow
- **WHEN** `fault=session_expired` is active and any authenticated page is requested
- **THEN** the session is cleared and the response redirects to `/login`

### Requirement: Synthetic data only
The target app SHALL contain only obviously fake member records and SHALL accept only the fixed demo credentials.

#### Scenario: Data review
- **WHEN** a reviewer reads `data/members.ts`
- **THEN** no record resembles a real person or real account number
