# How Burn works

Burn has two halves: a bb plugin for bb-managed threads, and a pi extension for standalone pi. The pi extension adds the pill and `/burn` in the terminal and stays inactive in bb.

## Where the numbers come from

In bb, Burn counts every thread, whatever harness runs it.

- **pi threads:** the figures come from pi's session logs, where every assistant message already carries the cost pi recorded.
- **OMP threads (`acp-omp`):** the host reads the exact session identities from OMP's native logs in `~/.omp/agent/sessions/<project>/`. Recorded tokens, costs, model calls, reasoning tokens, request durations and per-prompt tool counts replace BB's cost-only events; they are not added to them.
- **OpenCode threads:** the figures come from opencode's own database on the thread's machine, where every assistant message records its tokens and cost, including the calls of subagents that opencode's task tool starts.
- **Claude Code threads:** a host reader reads the exact session identities and their recursive subagent transcript trees. Repeated content-block usage snapshots replace one another by API message ID. Logs replace event totals rather than being added to them.
- **Other harnesses,** such as Codex: the figures come from the usage bb records for each thread, and Burn keeps its own copy of it.

When a harness passes bb its own cost, Burn uses that cost as it is. Codex and Claude Code pass bb their tokens but no cost. Burn prices their tokens with pi's list prices for OpenAI Codex and Anthropic models, and marks every such amount as an estimate, for example `~$1.23`. A model without a known price shows tokens instead of dollars.

Burn reads and keeps list prices, and applies the discounts in its settings each time it answers. So a changed discount applies at once, to past figures as well, with nothing to rebuild. See [Discounts](bb.md#discounts).

## Reading session logs and opencode's database

The bb plugin has a host entry: code that bb runs on every connected machine. It reads the session log that bb's pi bridge keeps for each pi thread on that machine, and builds the same report pi would. Newer bb keeps those logs in a different folder from older bb, so Burn reads both; see [session logs](troubleshooting.md#session-logs). When a machine has no log for a pi thread that bb says has finished a turn, Burn asks bb once, says so on the chip and in the card instead of waiting for a first model call, and logs the machine once.

The host entry watches the log folders, so the chip updates about a second after pi finishes a model call. It reads only the bytes pi appended since the last read. The plugin keeps the last figures each machine gave, so a thread on a machine that is offline still shows its cost. Whether a thread is working comes from bb's own thread status.

For OpenCode threads, the host entry opens `opencode.db` read-only. It is in `$XDG_DATA_HOME/opencode` when that is set, and in `~/.local/share/opencode` otherwise. Burn has no watch on the database, so it reads the database again each time bb records new events for the thread, about once a second while the thread works, and again when the thread stops. In the older OpenCode database, a user message that opencode writes itself, such as "Continue if you have next steps" or a compaction, does not count as a prompt; its calls count within the prompt before it. In the OpenCode 2 layout, Burn reads user rows and skips the separate row types used for internal messages. OpenCode 2 can also store internal text, including BB system instructions, as unmarked user rows; these may appear as prompts.

OMP uses the same incremental log parser as pi, with its native project-directory layout and exact filename/header identity matching. A prepended title record is not mistaken for the session header. Copied history before a fork's creation time is excluded. BB event and status changes invalidate OMP reports, with the existing report TTL as a fallback; no extra polling service is started. Missing logs retain the last saved report, or fall back to BB events with a partial-coverage notice. Custom OMP session directories and unlinked subprocess sessions are not discovered.

OMP spend also includes `model_usage` side calls and the aggregate `details.usage` on blocking `task` results. Like pi's supplemental usage entries, these add to token and cost totals without incrementing assistant-call counts. A tool result exposing both usage locations is counted once. Discovered session paths are cached for up to one minute from discovery, not renewed by warm reads; the next read after expiry can find new fuller copies while the original remains. Missing identities and moved logs trigger discovery immediately. An unreadable OMP bucket is warned about once and skipped, rather than preventing reads of other sessions or harnesses.

**Calls** means model requests, not tool executions. Tool counts are shown separately in each prompt's details. Costs recorded by a harness are usage accounting, not proof of a subscription invoice.

## Reading the usage bb records

The host entry reads pi and OMP logs and opencode's database. Claude Code also uses the host entry to read its transcripts; other harnesses need no host code. Their provider bridges, the adapters that connect an agent such as Codex to bb, may send token-usage events after a model call or turn, or only a running cost. A cost-only event does not supply a model-call count or token breakdown. bb tells the plugin within a second when a thread has new events, and the plugin reads them.

bb deletes older usage events and keeps only the latest one for each thread. So Burn keeps its own copy of what it read in the plugin's database, and the figures survive a plugin reload.

## The pi extension in a bb thread

The pi extension recognises BB-managed sessions and does not register commands or handlers there. The bb plugin reads the session log and enforces budgets set in bb using discounted cost, the same amount the panel displays. For a budget that includes children, the plugin uses the combined cost and stops the running family when it crosses the limit and stopping is on.

For older pi extensions, the bb plugin still accepts authenticated usage reports and session-log hints, but replies with a policy that disables stops in pi. If an already-running pi thread loaded the old extension, restart it after updating so it cannot use a cached stop policy.

See [Usage coverage and workflow accounting](usage-coverage.md) for source limits and the distinction between native subagents and BB workflow workers.
