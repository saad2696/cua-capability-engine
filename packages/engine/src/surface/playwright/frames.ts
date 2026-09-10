import type { Frame, Page } from "playwright";

/** Name path of a frame from the top document. Unnamed frames get `#<index>`. */
export function framePath(frame: Frame): string[] {
  const path: string[] = [];
  let f: Frame | null = frame;
  while (f && f.parentFrame()) {
    const parent: Frame = f.parentFrame()!;
    const name = f.name() || `#${parent.childFrames().indexOf(f)}`;
    path.unshift(name);
    f = parent;
  }
  return path;
}

export function findFrame(page: Page, path: string[] | undefined): Frame | null {
  let f: Frame = page.mainFrame();
  for (const seg of path ?? []) {
    const children = f.childFrames();
    const next = seg.startsWith("#") ? children[Number(seg.slice(1))] : children.find((c) => c.name() === seg);
    if (!next) return null;
    f = next;
  }
  return f;
}

/** Offset of a frame's viewport in page coordinates (sum of ancestor frame element boxes). */
export async function frameOffset(frame: Frame): Promise<{ x: number; y: number }> {
  let x = 0;
  let y = 0;
  let f: Frame | null = frame;
  while (f && f.parentFrame()) {
    const el = await f.frameElement().catch(() => null);
    const box = el ? await el.boundingBox().catch(() => null) : null;
    if (box) {
      x += box.x;
      y += box.y;
    }
    f = f.parentFrame();
  }
  return { x, y };
}

/** Frames ordered top-down, depth-first. */
export function allFrames(page: Page): Frame[] {
  const out: Frame[] = [];
  const walk = (f: Frame) => {
    out.push(f);
    for (const c of f.childFrames()) walk(c);
  };
  walk(page.mainFrame());
  return out;
}
