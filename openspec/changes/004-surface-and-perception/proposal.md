# Change: Surface abstraction and perception

## Why
The brief asks for an approach that still works when there is no clean DOM. The seam between
"how we perceive/act on a surface" and "the recorded flow" must be explicit so a desktop
adapter is an implementation, not a rewrite.

## What changes
`Surface` interface; `PlaywrightSurface` implementation; perception module that builds an
`Observation` from a screenshot plus the accessibility tree, with numbered marks drawn on the
image; locator capture that produces the multi-candidate `Locator` for any acted-on element.
Debug command `cua observe <url>` writes the annotated PNG and element list.

## Out of scope
Desktop implementation. Any model call.
