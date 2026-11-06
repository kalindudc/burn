/** Shows or hides the jsdom page the way a browser tab does, and tells the page's listeners. */
export function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Puts the page back to jsdom's own state, which is visible. */
export function resetVisibility(): void {
  delete (document as { visibilityState?: unknown }).visibilityState;
}
