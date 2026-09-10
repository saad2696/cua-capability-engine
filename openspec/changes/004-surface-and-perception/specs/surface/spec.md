## ADDED Requirements
### Requirement: Surface abstraction
The engine SHALL interact with any application only through the `Surface` interface, and the recorded artifact SHALL contain no surface-implementation types.

#### Scenario: Grep check
- **WHEN** `packages/schema` is searched for "playwright"
- **THEN** there are no matches

### Requirement: DOM-independent perception
The surface SHALL produce an observation consisting of a screenshot with numbered marks and a list of interactive elements derived from the accessibility tree, including elements inside frames.

#### Scenario: Frameset page
- **WHEN** the target app search page (inside a frameset) is observed
- **THEN** the element list includes the Member ID textbox and Search button with their frame path

### Requirement: Multi-strategy locator capture and resolution
The surface SHALL capture a locator with role, text, css, and visual candidates for any acted element and SHALL resolve locators by trying candidates in order, reporting which strategy matched.

#### Scenario: Primary strategy fails
- **WHEN** a locator's role candidate does not match but its css candidate does
- **THEN** resolution succeeds and the result reports `matchedStrategy: "css"`

### Requirement: Dialogs are observed, not swallowed
Native browser dialogs SHALL appear in the observation and SHALL NOT be dismissed automatically by the surface.

#### Scenario: Unexpected alert
- **WHEN** the target app raises an alert after navigation
- **THEN** the next observation has `dialog.type = "alert"` and its message
