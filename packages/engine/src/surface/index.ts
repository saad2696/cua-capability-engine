export * from "./types.js";
export { PlaywrightSurface, type PlaywrightSurfaceOptions } from "./playwright/PlaywrightSurface.js";
export { INTERACTIVE_ROLES, LANDMARK_ROLES, isSensitiveName, type LandmarkSummary } from "./playwright/perception.js";
export { findFrame, framePath } from "./playwright/frames.js";
