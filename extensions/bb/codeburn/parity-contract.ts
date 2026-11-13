import { z } from "zod";

export type FeatureField = { key: string; label: string; type?: "text" | "date" | "number" | "select" | "multiline"; options?: readonly string[]; required?: boolean; hint?: string };
export type FeatureDefinition = { id: string; label: string; group: string; description: string; scoped?: boolean; fields?: readonly FeatureField[] };

const comparisonDates = [
  { key: "fromA", label: "Reference A from", type: "date", required: true },
  { key: "toA", label: "Reference A to", type: "date", required: true },
  { key: "fromB", label: "Analyzed B from", type: "date", required: true },
  { key: "toB", label: "Analyzed B to", type: "date", required: true },
] as const;
const comparisonModels = [
  { key: "modelA", label: "Model A", hint: "Leave both blank to list available models." },
  { key: "modelB", label: "Model B" },
] as const;
export const REPORTS = [
  { id: "overview", label: "Overview", group: "Usage", scoped: true, description: "CLI-accounted cost, tokens, cache efficiency, provider coverage and current usage." },
  { id: "timeline", label: "Timeline", group: "Usage", scoped: true, description: "Native daily and granular history spans all available dates, not only the selected summary period. Missing observations are not zero-spend days." },
  { id: "models", label: "Models", group: "Usage", scoped: true, description: "All models, including sub-cent and unpriced usage.", fields: [{ key: "breakdown", label: "Breakdown", type: "select", options: ["model", "task", "agent"] }] },
  { id: "sessions", label: "Sessions", group: "Usage", scoped: true, description: "Complete sessions with day, category, branch, model and PR contribution drilldowns." },
  { id: "session-why", label: "Session diagnosis", group: "Usage", description: "Claude Code only: on-demand transcript diagnosis, prompts and steps. Other providers are not supported by this upstream command.", fields: [{ key: "sessionId", label: "Claude session ID", required: true }] },
  { id: "pull-requests", label: "Pull requests", group: "Spend", scoped: true, description: "Spend grouped by PR references. Rows can overlap; this is not proof a PR merged." },
  { id: "flow", label: "Spend flow", group: "Spend", scoped: true, description: "Model × project spend flows computed by CodeBurn." },
  { id: "branches", label: "Branches", group: "Spend", scoped: true, description: "Project × branch spend and explicit coverage for sources without branch metadata." },
  { id: "yield", label: "Outcomes / yield", group: "Spend", scoped: true, description: "Experimental git-correlated productive, reverted and abandoned spend. Upstream supports preset periods, not custom dates." },
  { id: "model-comparison", label: "Compare models", group: "Compare", scoped: true, description: "Native CodeBurn model comparison, including available-model discovery.", fields: comparisonModels },
  { id: "cohort-comparison", label: "Compare cohorts", group: "Compare", scoped: true, description: "Matched model comparison narrowed by exact project identity or task category.", fields: [...comparisonModels, { key: "projectId", label: "Exact project identity" }, { key: "category", label: "Activity category" }] },
  { id: "period-comparison", label: "Compare periods", group: "Compare", scoped: true, description: "Explicit local-calendar periods: B minus A, calculated by CodeBurn.", fields: comparisonDates },
  { id: "period-sessions", label: "Period comparison sessions", group: "Compare", scoped: true, description: "Drill into the sessions behind one project or model comparison row.", fields: [...comparisonDates, { key: "dimension", label: "Dimension", type: "select", options: ["project", "model"], required: true }, { key: "key", label: "Canonical project/model key", required: true }] },
  { id: "plans", label: "Plans & pacing", group: "Capacity", description: "Account-wide configured plans and subscription usage. Project/provider filters do not narrow subscription bills." },
  { id: "quota", label: "Live quota", group: "Capacity", description: "Explicit refresh of live provider windows using CodeBurn's existing signed-in credentials. May contact providers or prompt Keychain; no automatic polling." },
  { id: "optimize", label: "Optimization findings", group: "Optimize", scoped: true, description: "Token-waste findings, grades, estimated savings and remediation guidance. Analysis only; opening this page does not apply fixes." },
  { id: "actions", label: "Measured fixes", group: "Optimize", description: "Realized versus estimated savings for previously applied CodeBurn fixes." },
  { id: "audit", label: "Token / cost audit", group: "Inspect", scoped: true, description: "Provider token fields, billing routes and cost derivation from the CLI." },
  { id: "doctor", label: "Provider diagnostics", group: "Inspect", description: "Detected providers, paths and parse health; diagnostic failures stay visible." },
  { id: "aliases", label: "Model aliases", group: "Settings", description: "Existing model-to-pricing aliases." },
  { id: "prices", label: "Price overrides", group: "Settings", description: "Existing local per-million-token pricing overrides." },
  { id: "proxy-paths", label: "Subscription proxy paths", group: "Settings", description: "Directories marked as covered by subscription-backed proxies." },
  { id: "project-filter", label: "Saved project visibility", group: "Settings", description: "The same app-filter.json used by CodeBurn desktop. Unreadable filters fail closed." },
  { id: "devices", label: "Paired devices", group: "Devices", description: "Previously paired devices and combined usage. Reading does not start a sharing daemon." },
  { id: "device-scan", label: "Discover devices", group: "Devices", description: "Explicit local-network discovery; does not pair or enable sharing." },
  { id: "identity", label: "Device identity", group: "Devices", description: "CodeBurn's local sharing identity." },
  { id: "share-status", label: "Sharing status", group: "Devices", description: "Inspect existing sharing state without starting or stopping a service." },
] as const satisfies readonly FeatureDefinition[];
export type ReportName = typeof REPORTS[number]["id"];
export const REPORT_IDS = REPORTS.map((feature) => feature.id) as [ReportName, ...ReportName[]];

export const ACTIONS = [
  { id: "currency-set", label: "Set currency", group: "Settings", description: "Changes CodeBurn's display currency; future CLI scans use it.", fields: [{ key: "code", label: "ISO currency code", required: true, hint: "Three uppercase letters, e.g. USD or EUR." }] },
  { id: "currency-reset", label: "Reset currency", group: "Settings", description: "Removes the display-currency override and returns to CodeBurn's default." },
  { id: "alias-set", label: "Set model alias", group: "Settings", description: "Maps one provider model name onto another model for future pricing.", fields: [{ key: "from", label: "Provider model name", required: true }, { key: "to", label: "Canonical pricing model", required: true }] },
  { id: "alias-remove", label: "Remove model alias", group: "Settings", description: "Removes this model's configured pricing alias.", fields: [{ key: "from", label: "Provider model name", required: true }] },
  { id: "price-set", label: "Set price override", group: "Settings", description: "Sets local USD prices per 1,000,000 tokens. Both input and output rates must be specified explicitly; rates must be nonnegative.", fields: [{ key: "model", label: "Model", required: true }, { key: "input", label: "Input USD / 1M", type: "number", required: true }, { key: "output", label: "Output USD / 1M", type: "number", required: true }, { key: "cacheRead", label: "Cache read USD / 1M", type: "number" }, { key: "cacheCreation", label: "Cache creation USD / 1M", type: "number" }] },
  { id: "price-remove", label: "Remove price override", group: "Settings", description: "Removes the model's local price override.", fields: [{ key: "model", label: "Model", required: true }] },
  { id: "plan-set", label: "Set subscription plan", group: "Capacity", description: "Sets a CodeBurn subscription plan. This changes accounting configuration, not your actual provider subscription.", fields: [{ key: "id", label: "Plan preset or custom", required: true }, { key: "provider", label: "Provider", required: true, hint: "all, claude, codex, cursor, grok, copilot or antigravity" }, { key: "monthlyUsd", label: "Custom monthly USD", type: "number" }, { key: "credits", label: "Custom Copilot credits", type: "number" }, { key: "resetDay", label: "Reset day (1–28)", type: "number" }] },
  { id: "plan-reset", label: "Reset subscription plan", group: "Capacity", description: "Clears the configured plan for this provider.", fields: [{ key: "provider", label: "Provider", required: true }] },
  { id: "project-filter-set", label: "Save project visibility", group: "Settings", description: "Writes CodeBurn's existing app-filter.json. Includes narrow all scoped reports; excludes remain applied even with a temporary project selection. Empty includes show all except exclusions.", fields: [{ key: "project", label: "Included project patterns, one per line", type: "multiline" }, { key: "exclude", label: "Excluded project patterns, one per line", type: "multiline" }] },
  { id: "sharing-initialize", label: "Initialize sharing identity", group: "Devices", description: "Creates CodeBurn's local sharing key/certificate only if missing, without starting a sharing service or changing existing identity. Device reports never create these credentials automatically." },
  { id: "device-remove", label: "Forget paired device", group: "Devices", description: "Removes the named device from CodeBurn's pairing configuration; does not delete its logs.", fields: [{ key: "name", label: "Paired device name", required: true }] },
] as const satisfies readonly FeatureDefinition[];
export type ActionName = typeof ACTIONS[number]["id"];
export const ACTION_IDS = ACTIONS.map((feature) => feature.id) as [ActionName, ...ActionName[]];

const text = z.string().max(4096).refine((value) => !value.includes("\0"), "NUL is not valid in CLI arguments");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
export const dateRangeSchema = z.object({ from: date, to: date }).strict().refine((value) => value.from <= value.to, "Range start must not follow its end");
export const scopeSchema = z.object({
  period: z.enum(["today", "week", "30days", "month", "all", "lifetime"]).default("30days"),
  range: dateRangeSchema.optional(),
  provider: z.string().regex(/^[a-z0-9-]{1,50}$/).default("all"),
  project: z.array(text).max(100).default([]),
  exclude: z.array(text).max(100).default([]),
});
export type ReportScope = z.infer<typeof scopeSchema>;
export const reportQuerySchema = scopeSchema.extend({
  report: z.enum(REPORT_IDS),
  params: z.record(z.string().max(50), text).default({}),
  focus: z.array(z.string().max(4096)).max(30).default([]),
  snapshot: z.string().min(1).max(100).optional(),
  page: z.number().int().min(0).max(1_000_000).default(0),
  search: z.string().max(200).default(""),
  refresh: z.boolean().default(false),
}).strict();
export type ReportQuery = z.infer<typeof reportQuerySchema>;
export const fieldSchema = z.object({
  name: z.string(), path: z.array(z.string()), kind: z.enum(["value", "object", "array"]),
  value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]).optional(),
  count: z.number().int().nonnegative().optional(),
});
export const reportReplySchema = z.object({
  report: z.enum(REPORT_IDS), snapshot: z.string(), generated: z.string(),
  focus: z.array(z.string()), fields: z.array(fieldSchema).max(500),
  rows: z.array(z.record(z.string(), z.json())).max(50),
  rowPaths: z.array(z.array(z.string())).max(50),
  columns: z.array(z.string()).max(200), totalRows: z.number().int().nonnegative(),
  page: z.number().int().nonnegative(), pageSize: z.literal(50),
  scopeNote: z.string(),
});
export type ReportReply = z.infer<typeof reportReplySchema>;
export const actionQuerySchema = z.object({ action: z.enum(ACTION_IDS), values: z.record(z.string().max(50), text).default({}) }).strict();
export type ActionQuery = z.infer<typeof actionQuerySchema>;
export const previewReplySchema = z.object({ ticket: z.string(), expiresAt: z.string(), description: z.string(), command: z.array(z.string()) });
export type ActionPreview = z.infer<typeof previewReplySchema>;
export const confirmQuerySchema = z.object({ ticket: z.string().min(1).max(100) }).strict();
export const actionReplySchema = z.object({ stdout: z.string(), stderr: z.string() });
export const exportStartSchema = scopeSchema.extend({ format: z.enum(["csv", "json"]) }).strict();
export type ExportQuery = z.infer<typeof exportStartSchema>;
export const exportLeaseSchema = z.object({ id: z.string(), expiresAt: z.string(), files: z.array(z.object({ name: z.string(), size: z.number().int().nonnegative(), mime: z.string() })).max(100) });
export type ExportLease = z.infer<typeof exportLeaseSchema>;
export const exportReadSchema = z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(1000), offset: z.number().int().nonnegative() }).strict();
export const exportChunkSchema = z.object({ base64: z.string(), nextOffset: z.number().int().nonnegative(), totalSize: z.number().int().nonnegative(), eof: z.boolean() });
export const exportEndSchema = z.object({ id: z.string().min(1).max(100) }).strict();
export const executableSchema = z.string().trim().min(1).max(4096).refine((value) => !value.includes("\0"));
