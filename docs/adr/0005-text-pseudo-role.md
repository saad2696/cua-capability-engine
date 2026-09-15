# 0005 — A `text` pseudo-role for extraction targets with no accessible name

- **Slice:** 006 (deterministic replay)
- **Status:** accepted

## Decision

Locator candidates may carry `role: "text"`, which is not an ARIA role. It means "a text node
matched by its content and position", and the resolver handles it as a distinct strategy.

## Why

The values a capability needs to read — a balance in a table cell, a confirmation number — are
usually plain text in a `<td>` with no role, no name, and no id. The accessibility tree, which is
what the rest of the engine perceives through, does not expose them as elements at all.

The alternative was a separate extraction mechanism running beside the locator system, with its own
drift handling and its own failure modes. Reusing the locator's candidate list instead means
extraction gets multi-candidate fallback, drift reporting and the failure bundle for free, at the
cost of one value in the role field that an ARIA reader would not recognise.

`docs/artifact-schema.md` documents it as a pseudo-role so nobody reads the artifact as a claim
about the page's accessibility tree.
