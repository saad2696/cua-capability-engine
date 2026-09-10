/**
 * The Surface seam: everything the engine knows about "how we perceive and act on an
 * application". The recorded flow (the artifact) never references these types' implementations.
 *
 * PlaywrightSurface is the web implementation. A DesktopSurface would implement the same
 * interface on top of an OS accessibility API plus a screen grab.
 */
import type { BBox, ElementSummary, Locator, LocatorStrategy } from "@cua/schema";

export type { ElementSummary };

export interface DialogInfo {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultValue?: string;
}

export interface FrameInfo {
  /** Path from the top document by frame name (or `#index` when unnamed). [] is the top. */
  path: string[];
  url: string;
  /** Offset of the frame's viewport in page coordinates. */
  offset: { x: number; y: number };
}

export interface Observation {
  at: string;
  /** Top-level URL. In framesets this rarely changes; see `frames` for the content frames. */
  url: string;
  title: string;
  frames: FrameInfo[];
  /** Interactive elements from the accessibility tree, numbered for the model. */
  elements: ElementSummary[];
  /** PNG with numbered marks drawn over `elements`. */
  screenshotPng: Buffer;
  /** Plain PNG without marks (for evidence and visual comparisons). */
  rawScreenshotPng: Buffer;
  viewport: { width: number; height: number };
  dialog?: DialogInfo;
  /** Main-frame HTTP status of the most recent navigation, when known. */
  lastHttpStatus?: number;
}

/** Actions the engine can ask a surface to perform. Targets are element indexes from the last observation or Locators. */
export type Target = { index: number } | { locator: Locator } | { point: { x: number; y: number }; frame?: string[] };

export type SurfaceAction =
  | { kind: "navigate"; url: string }
  | { kind: "click"; target: Target }
  | { kind: "type"; target: Target; text: string; secret?: boolean }
  | { kind: "select"; target: Target; value: string }
  | { kind: "press"; key: string }
  | { kind: "dismissDialog"; accept: boolean; text?: string }
  | { kind: "scroll"; dx: number; dy: number; target?: Target };

export interface ActResult {
  ok: boolean;
  /** How the target was resolved, when applicable. */
  resolved?: Resolved;
  error?: string;
  /** Wall time the action took. */
  durationMs: number;
}

export interface Resolved {
  strategy: LocatorStrategy;
  candidateIndex: number;
  /** Number of candidates tried before this one matched. */
  attempts: number;
  bbox: BBox;
  frame: string[];
  role?: string;
  name?: string;
}

export interface TextReadResult {
  text: string;
  bbox: BBox;
}

export interface Surface {
  readonly kind: "web" | "desktop";
  open(url: string): Promise<void>;
  observe(): Promise<Observation>;
  act(action: SurfaceAction): Promise<ActResult>;
  /** Resolve a locator without acting. Returns null when no candidate matches. */
  resolve(locator: Locator): Promise<Resolved | null>;
  /** Build a multi-candidate Locator for an element from the latest observation. */
  captureLocator(elementIndex: number): Promise<Locator>;
  /** Read text at a locator (for extraction). */
  readText(locator: Locator): Promise<TextReadResult | null>;
  /** Visible text of a frame (or the whole page when path is undefined). */
  visibleText(frame?: string[]): Promise<string>;
  /** Is a role+name landmark visible in the given frame? */
  landmarkVisible(role: string, name: string, frame?: string[], exact?: boolean): Promise<boolean>;
  frameUrl(frame?: string[]): string | undefined;
  pendingDialog(): DialogInfo | undefined;
  screenshot(): Promise<Buffer>;
  /** Fires when the page opens a new window/tab. */
  onPageSwitch(handler: (url: string) => "adopt" | "close"): void;
  close(): Promise<void>;
}
