# Design: Surface and perception

## Interface
```ts
interface Surface {
  open(url: string): Promise<void>;
  observe(): Promise<Observation>;                 // screenshot + elements + url + title + dialog?
  act(action: Action): Promise<ActResult>;         // by element index (agent) or Locator (replay)
  resolve(locator: Locator): Promise<Resolved | null>;
  captureLocator(elementIndex: number): Promise<Locator>;
  screenshot(opts?): Promise<Buffer>;
  onDialog(handler): void;
  close(): Promise<void>;
}
type Observation = { url, title, screenshotPng, elements: ElementSummary[], dialog?: { type, message } };
type ElementSummary = { index, role, name, value?, bbox, frame: string[], enabled, focused };
```

## Perception pipeline (PlaywrightSurface)
1. Snapshot accessibility tree for every frame (`page.accessibility.snapshot` equivalent via
   `locator.ariaSnapshot()` / role queries), keep interactive roles only: button, link, textbox,
   combobox, checkbox, radio, menuitem, cell-with-onclick, plus any element with tabindex.
2. Compute bounding boxes; drop zero-size and off-screen.
3. Cap at 60 elements, prioritizing viewport-visible ones.
4. Draw numbered marks on the screenshot (Set-of-Marks). Downscale to max width 1024.
5. Emit `Observation`.

## Locator capture
For the acted element: role+name from a11y; nearest label/adjacent cell text; exact visible
text; a CSS path with no ids (nth-child chain limited to 6 levels); bbox + anchor text.
Frame path recorded as list of frame names/indices.

## Resolution (used by replay)
Try candidates in order. Each strategy maps to a Playwright locator inside the recorded frame;
require exactly one visible match; on ambiguity move to next candidate. `visual` candidate
clicks the bbox center only if the anchor text is still visible within 150px. Return which
strategy matched.

## Dialogs
Native `alert/confirm/prompt` are captured, not auto-dismissed. They appear in `Observation.dialog`
so the agent or replay detectors can decide. Replay only dismisses dialogs declared recoverable.

## Extensibility
`DesktopSurface` would use OS accessibility APIs (macOS AX, Windows UIA) for elements and a
screen grab for the image. Same `Observation`, same `Locator` strategies minus `css`.
