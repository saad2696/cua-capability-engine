/**
 * Perception from the browser's accessibility tree via the Chrome DevTools Protocol.
 * We read the same tree screen readers use, frame by frame (the root tree stops at frame
 * boundaries, which is exactly the legacy-frameset trap), and take bounding boxes from the
 * layout engine. The DOM is never handed to the model.
 */
import type { CDPSession, Page } from "playwright";
import type { ElementSummary } from "@cua/schema";
import { allFrames, framePath } from "./frames.js";

export const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "slider", "spinbutton", "option", "treeitem",
]);

const SENSITIVE_NAME = /password|passcode|ssn|social|pin\b|secret|token|cvv/i;

interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
  value?: { value: string };
  properties?: { name: string; value: { value: unknown } }[];
  backendDOMNodeId?: number;
  childIds?: string[];
}

interface FrameTreeNode {
  frame: { id: string; name?: string; url: string };
  childFrames?: FrameTreeNode[];
}

export interface PerceivedFrame {
  cdpFrameId: string;
  path: string[];
  url: string;
}

/** Map CDP frame ids to name paths by walking Page.getFrameTree in parallel with Playwright's frame tree. */
export async function perceiveFrames(page: Page, cdp: CDPSession): Promise<PerceivedFrame[]> {
  const { frameTree } = (await cdp.send("Page.getFrameTree")) as { frameTree: FrameTreeNode };
  const out: PerceivedFrame[] = [];
  const pwFrames = allFrames(page);
  const walk = (node: FrameTreeNode, path: string[]) => {
    out.push({ cdpFrameId: node.frame.id, path, url: node.frame.url });
    node.childFrames?.forEach((c, i) => walk(c, [...path, c.frame.name || `#${i}`]));
  };
  walk(frameTree, []);
  // prefer Playwright's naming when it differs (unnamed frames)
  for (const f of out) {
    const pw = pwFrames.find((p) => p.url() === f.url && framePath(p).length === f.path.length);
    if (pw) f.path = framePath(pw);
  }
  return out;
}

export async function perceiveElements(cdp: CDPSession, frames: PerceivedFrame[], viewport: { width: number; height: number }, maxElements = 60): Promise<ElementSummary[]> {
  const raw: (Omit<ElementSummary, "index"> & { area: number })[] = [];
  for (const frame of frames) {
    let nodes: AXNode[];
    try {
      ({ nodes } = (await cdp.send("Accessibility.getFullAXTree", { frameId: frame.cdpFrameId })) as { nodes: AXNode[] });
    } catch {
      continue; // frame navigated away between calls
    }
    for (const n of nodes) {
      const role = n.role?.value ?? "";
      if (n.ignored || !INTERACTIVE_ROLES.has(role) || n.backendDOMNodeId === undefined) continue;
      let box: [number, number, number, number] | null = null;
      try {
        const bm = (await cdp.send("DOM.getBoxModel", { backendNodeId: n.backendDOMNodeId })) as { model: { content: number[] } };
        const q = bm.model.content;
        box = [Math.round(q[0]!), Math.round(q[1]!), Math.round(q[2]! - q[0]!), Math.round(q[5]! - q[1]!)];
      } catch {
        continue; // not rendered
      }
      if (box[2] <= 0 || box[3] <= 0) continue;
      const inViewport = box[0] < viewport.width && box[1] < viewport.height && box[0] + box[2] > 0 && box[1] + box[3] > 0;
      if (!inViewport) continue;
      const name = n.name?.value?.trim() ?? "";
      const props = new Map((n.properties ?? []).map((p) => [p.name, p.value.value]));
      const disabled = props.get("disabled") === true;
      const focused = props.get("focused") === true;
      const rawValue = typeof n.value?.value === "string" ? n.value.value : undefined;
      const value = rawValue === undefined ? undefined : SENSITIVE_NAME.test(name) ? (rawValue ? "[redacted]" : "") : rawValue;
      raw.push({ role, name, ...(value !== undefined ? { value } : {}), bbox: box, frame: frame.path, enabled: !disabled, focused, area: box[2] * box[3] });
    }
  }
  // stable reading order: top-to-bottom, left-to-right; cap by dropping the smallest late items
  raw.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  const kept = raw.length > maxElements ? raw.slice(0, maxElements) : raw;
  return kept.map((e, index) => {
    const { area: _area, ...rest } = e;
    return { index, ...rest };
  });
}

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME.test(name);
}
