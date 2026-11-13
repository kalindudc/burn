import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { BurnContextChip } from "./chip.js";
import { mountRowFlags } from "./flags.js";
import { FLAME_ICON, FlameIcon } from "./icon.js";
import { costActionRegistration } from "./menu.js";
import { BurnOverlay } from "./overlay.js";
import { BurnPanel } from "./panel.js";
import { PANEL_ACTION_ID } from "./panel-requests.js";
import { BurnWorkspace } from "./workspace.js";

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: FLAME_ICON, component: FlameIcon });
  app.slots.experimental_threadContextSegment({ id: "burn-chip", title: "Burn", group: "3_usage", summary: BurnContextChip });
  app.slots.experimental_tab({ context: { kind: "thread" }, availability: "action", id: PANEL_ACTION_ID, title: "Burn", icon: FLAME_ICON, component: BurnPanel });
  app.slots.experimental_threadAction(costActionRegistration);
  app.slots.experimental_appOverlay({ id: "burn-alerts", component: BurnOverlay });
  app.contentScripts.register({ id: "burn-row-flags", mount: mountRowFlags });
  app.slots.navPanel({ id: "spend", title: "Burn", icon: FLAME_ICON, path: "spend", component: BurnWorkspace });
});
