---
name: burn-codeburn
description: Use when inspecting machine-wide CodeBurn usage, sessions, spend comparisons, quota, plans, optimization findings, pricing configuration, or native exports through Burn in BB.
---

# CodeBurn in Burn

Use **BB → Burn → Machine usage → Reports & settings** for the selected enrolled machine's CLI-backed reports, drilldowns, configuration previews and native downloads. **Raw export tables** retains the nine statistics views. No desktop/menu-bar app, web server, resident query server or periodic collector is required. The selected machine needs CodeBurn CLI 0.9.28 or newer.

For structured agent queries, use Burn's native RPC interface with JSON input files:

```sh
bb plugin rpc call burn codeburnMachines --json
bb plugin rpc call burn codeburnStatistics --input-file /tmp/codeburn-query.json --json
bb plugin rpc call burn codeburnReport --input-file /tmp/codeburn-report.json --json
```

A statistics input contains a discovered `hostId`, `period` (`today`, `7d`, `30d`), `table` (`daily`, `activity`, `models`, `projects`, `sessions`, `tools`, `mcp`, `shellCommands`, `records`), zero-based `page`, `search`, and `refresh`. Set `refresh` only for an explicit fresh scan; table navigation can reuse the short-lived successful export. Each response includes the whole-period summary and up to 50 filtered rows, with `totalRows`, `page`, `pageSize`, source schema, currency, dates, and scan timestamp.

A report input needs a discovered `hostId` and a `report` id from `REPORTS` in `extensions/bb/codeburn/parity-contract.ts`. Periods are `today`, `week`, `30days`, `month`, `all` (six months), or `lifetime`; optional `range: {from, to}` uses valid local-calendar `YYYY-MM-DD` dates. Optional `provider`, `project`, `exclude` and report-specific `params` are validated. `period-comparison` requires `params.fromA`, `toA`, `fromB`, `toB`; its `period-sessions` drilldown also requires `dimension` and canonical `key`.

Reports include overview/timeline, models/sessions/Claude session diagnosis, PRs/branches/flow/yield, model/cohort/period comparisons, plans/quota, optimization/measured fixes, audits/diagnostics, settings and device state. The catalog describes scoped versus account-wide queries and exact required fields. Do not submit unsupported global filters to an account-wide report. Live quota may contact providers using CodeBurn's existing sign-in; opening the plugin does not poll it.

Each report returns `snapshot`, `generated`, `focus`, primitive/object/array `fields`, paginated `rows`, original `rowPaths`, and a `scopeNote`. Navigate using the same query plus its snapshot and field/row path. Snapshots expire after five minutes or worker disposal. Refresh with no snapshot; never combine a stale index with a new population. Omit absent optional JSON keys entirely. Previews are bounded and long text may be clipped; use nested paths for structured details.

The saved CodeBurn `app-filter.json` scopes reports/exports and cannot be widened by temporary includes. Unreadable visibility filters fail closed. Presets use CodeBurn's native inclusive calendar boundaries, including the raw `7d`/`30d` statistics queries.

Read-only children disable implicit Cursor synchronization without changing saved user settings. Device reports require existing sharing credentials; initialization is a separate explicitly confirmed action and starts no sharing service.

Configuration RPC is separate: `codeburnPreviewAction` returns an effect, exact command and 60-second single-use ticket; `codeburnConfirmAction` consumes that ticket on the same host/executable. A read-only statistics request does not authorize confirmation. Confirm only a particular change the user explicitly requested. Supported changes are currency, aliases, explicit input/output pricing, plans, saved visibility, explicit sharing-identity initialization and forgetting a paired device. Inspect state before retrying an interrupted mutation. Do not install companions, alter Guard hooks, enable telemetry/sync or apply optimization fixes as part of reporting.

Native downloads use `codeburnExportStart` (`format: csv|json` plus scope), then `codeburnExportRead` (`id`, exact leased `name`, byte `offset`) for bounded base64 chunks. `codeburnExportEnd` releases the lease. Never substitute an arbitrary filesystem path or retain private export data in the repository.

Do not sum these machine-wide costs with Burn's overlapping BB-thread totals. Burn discounts, price overrides and budgets do not affect CodeBurn. Preserve logs and CodeBurn caches. Do not interpret empty tables as evidence that unsupported telemetry never occurred. Surface errors; do not substitute stale data or invented zeroes. Change the executable path only through Burn's declared `codeburnCliPath` setting.
