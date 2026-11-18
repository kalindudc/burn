import { useLayoutEffect, useState } from "react";
import { pluginScopeAttributes } from "./lib/portal-scope.js";

// bb's own markup, not an SDK contract: when it changes, the chip stays in the native thread context row.
/** The row under the prompt box that ends with the context circle. */
export const FOOTER_SELECTOR = "[data-follow-up-composer-footer]";
/** One thread pane; a split view has several. */
const PANE_SELECTOR = "[data-split-pane-id]";
const CIRCLE_SELECTOR = ':scope > button[aria-label^="Context window"]';

/**
 * Puts `node` in the right-hand group of the pane's composer footer, before
 * the context circle, and says whether it is there. A node already in that
 * group stays where it is, so another plugin that also keeps a node beside the
 * circle (cortex's memory icon, Thread Spend) never makes the two move each other in a loop.
 */
export function placeInFooter(node: HTMLElement, pane: ParentNode): boolean {
  const group = pane.querySelector(FOOTER_SELECTOR)?.lastElementChild;
  if (!(group instanceof HTMLElement)) {
    node.remove();
    return false;
  }
  if (node.parentElement !== group) group.insertBefore(node, group.querySelector(CIRCLE_SELECTOR));
  return true;
}

/**
 * A node in the composer footer of the thread pane that holds `anchor`, kept
 * there as bb re-renders the footer; null when that pane shows no footer.
 */
export function useFooterMount(anchor: HTMLElement | null): HTMLElement | null {
  const [mount, setMount] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const pane = anchor?.closest(PANE_SELECTOR) ?? null;
    if (pane === null) {
      setMount(null);
      return;
    }
    const node = document.createElement("span");
    node.setAttribute("data-burn-chip", "");
    // Outside the slot's root, so the plugin's scoped utilities need the scope on the node itself.
    for (const [name, value] of Object.entries(pluginScopeAttributes())) node.setAttribute(name, value);
    node.className = "inline-flex shrink-0 items-center";
    let frame = 0;
    const place = (): void => {
      frame = 0;
      setMount(placeInFooter(node, pane) ? node : null);
    };
    place();
    const observer = new MutationObserver(() => {
      // A streaming timeline changes the pane all the time: a node still in the footer costs one check,
      // and a search runs at most once a frame.
      if (node.isConnected && node.parentElement?.parentElement?.matches(FOOTER_SELECTOR)) return;
      if (frame === 0) frame = requestAnimationFrame(place);
    });
    observer.observe(pane, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      node.remove();
    };
  }, [anchor]);
  return mount;
}
