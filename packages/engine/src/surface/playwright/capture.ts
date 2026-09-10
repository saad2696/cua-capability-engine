/**
 * Locator capture: given an element the model acted on, record every way we could find it
 * again, most stable first, with a rationale a reviewer can read.
 */
import type { ElementHandle, Frame } from "playwright";
import type { ElementSummary, Locator, LocatorCandidate } from "@cua/schema";

interface DomFacts {
  tag: string;
  type: string | null;
  nameAttr: string | null;
  title: string | null;
  ariaLabel: string | null;
  placeholder: string | null;
  labelText: string | null;
  cellLabel: string | null;
  text: string;
  value: string | null;
  cssPath: string;
}

const FACTS_SCRIPT = (el: Element): DomFacts => {
  const e = el as HTMLElement & { type?: string; value?: string; placeholder?: string; labels?: NodeListOf<HTMLLabelElement> };
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim() || null;
  const labels = (e as HTMLInputElement).labels;
  const labelText = labels && labels.length ? clean(labels[0]!.textContent) : null;
  // legacy pattern: control sits in a cell whose previous sibling cell is the label
  let cellLabel: string | null = null;
  const td = e.closest("td");
  const prev = td?.previousElementSibling;
  if (prev && prev.tagName === "TD") cellLabel = clean(prev.textContent);
  // css path with no ids, class-light, nth-child chain up to 6 levels
  const parts: string[] = [];
  let cur: Element | null = e;
  let depth = 0;
  while (cur && cur !== document.body && cur !== document.documentElement && depth < 6) {
    const tag = cur.tagName.toLowerCase();
    const name = cur.getAttribute("name");
    if (name) {
      parts.unshift(`${tag}[name="${name}"]`);
      break;
    }
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
    } else parts.unshift(tag);
    cur = parent;
    depth += 1;
  }
  const tag = e.tagName.toLowerCase();
  const isControl = tag === "input" || tag === "select" || tag === "textarea";
  return {
    tag,
    type: e.getAttribute("type"),
    nameAttr: e.getAttribute("name"),
    title: clean(e.getAttribute("title")),
    ariaLabel: clean(e.getAttribute("aria-label")),
    placeholder: clean(e.placeholder),
    labelText,
    cellLabel,
    text: clean(isControl ? (e as HTMLInputElement).value : e.textContent) ?? "",
    value: isControl ? ((e as HTMLInputElement).value ?? null) : null,
    cssPath: parts.join(" > "),
  };
};

export async function captureLocatorFor(frame: Frame, handle: ElementHandle, summary: ElementSummary, viewport: { width: number; height: number }): Promise<Locator> {
  const facts = await handle.evaluate(FACTS_SCRIPT);
  const candidates: LocatorCandidate[] = [];
  const why: string[] = [];

  if (summary.name) {
    candidates.push({ strategy: "role", role: summary.role, name: summary.name, exact: true, confidence: 0.9 });
    why.push(`role "${summary.role}" + accessible name "${summary.name}" comes from the accessibility tree and survives layout and branding changes`);
  }
  const label = facts.labelText ?? facts.cellLabel;
  if (label && label !== summary.name) {
    candidates.push({ strategy: "label", text: label, exact: true, confidence: 0.8 });
    why.push(`label "${label}" (${facts.labelText ? "<label>" : "adjacent table cell"}) identifies the field if titles are dropped`);
  } else if (label) {
    candidates.push({ strategy: "label", text: label, exact: true, confidence: 0.8 });
  }
  const clickable = ["button", "link", "menuitem", "tab"].includes(summary.role) || facts.type === "submit" || facts.type === "button";
  if (clickable && facts.text) {
    candidates.push({ strategy: "text", text: facts.text, exact: true, confidence: 0.7 });
    why.push(`visible text "${facts.text}" is what an operator reads`);
  }
  if (facts.placeholder) candidates.push({ strategy: "placeholder", text: facts.placeholder, confidence: 0.6 });
  if (facts.cssPath) {
    candidates.push({ strategy: "css", selector: facts.cssPath, confidence: facts.nameAttr ? 0.5 : 0.35 });
    why.push(facts.nameAttr ? `css by form field name is layout-independent` : `css nth-of-type path is layout-bound; last structural resort`);
  }
  candidates.push({ strategy: "visual", bbox: summary.bbox, viewport: [viewport.width, viewport.height], ...(label || summary.name ? { anchorText: label ?? summary.name } : {}), confidence: 0.3 });
  why.push(`visual position is the universal fallback, trusted only if the anchor text is still within 150px`);

  return {
    frame: summary.frame,
    candidates,
    rationale: why.join("; ") + ".",
    recordedBBox: summary.bbox,
  };
}
