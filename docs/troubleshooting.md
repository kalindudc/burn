# Troubleshooting and limits

## Troubleshooting

- **The chip shows a dashed "—" in bb.** The thread has made no model call yet, or its harness sends bb no usage. For a pi thread it can also mean that Burn found no session log on the thread's machine and no report from pi. Check that bb keeps its pi sessions in one of the folders Burn reads; see [session logs](#session-logs) below. For an OpenCode thread it can mean that Burn found no opencode database on the thread's machine at `~/.local/share/opencode/opencode.db`, or under `$XDG_DATA_HOME/opencode` when that is set.
- **The chip says Burn cannot find this thread's session log.** bb says the pi thread has finished a turn, but its machine has no pi session log for it in any folder Burn reads. The card and the Burn tab list the folders it searched, and Burn's plugin log names the machine once. bb may keep pi's sessions somewhere Burn does not know, for example with `BB_PI_BRIDGE_SESSION_DIR`. Update the Burn pi extension with `pi update git:github.com/kalindudc/burn` and restart the thread: from 0.11.2 the extension tells Burn where its session log is. A thread whose log disappeared after Burn had read it keeps its last figures, marked as such.
- **The plugin log says a pi session reported without a usage token.** The Burn pi extension in that pi is older than 0.9.0, or the session started before the Burn plugin was installed or updated. Run `pi update git:github.com/kalindudc/burn` and restart the session. Until then the session's cost still comes from its session log, but bb ignores its report, so the budget set with `/burn budget`, pi's own stops and the context window do not reach bb.
- **The chip's tooltip says Burn has seen no new usage for a while, such as "3h".** bb says a pi or OpenCode thread is working, but its session log or opencode's database has not changed for at least five minutes. A long tool call does this, and so does an agent that has stopped. The chip keeps its working animation, because bb, not the log, says whether the thread is working. Threads of other harnesses never show this note, because a Claude Code turn can run for minutes before bb records its usage.
- **There is no chip in bb.** Check that the **Cost chip** setting in Burn's plugin settings is on. `bb plugin list` should show `burn` as running.
- **The chip is in the thread header, not the footer.** Burn did not find bb's footer markup; see [bb's page markup](#bbs-page-markup) below. The chip works the same there. On a phone, the header shows only the flame until you expand the prompt box, and the chip then moves to the footer.
- **There is no pill in pi.** The pill shows only in pi's terminal UI. `/burn` works in any mode.

## Limits

### bb's page markup

bb's footer has no plugin slot. The chip is a thread header action that moves itself next to the context circle by finding bb's page markup (`[data-follow-up-composer-footer]`). If bb changes that markup, the chip stays in the thread header.

The sidebar flag uses an experimental bb API, so on a bb without it the flag does not show. It covers every thread that is not archived.

Burn checks the daily budget at most every 30 seconds, so its notification can arrive up to half a minute after the spend that passes it.

### Session logs

Burn reads pi's session logs from two folders on each machine, so it works with any version of bb:

- `plugins/provider-pi/bridge-data/sessions` in bb's data folder, usually `~/.bb`. Newer bb keeps its pi sessions there. Burn finds the folder from its own data folder on that machine.
- `~/.bb/pi-bridge-sessions`, where older bb kept them.

Newer bb copies a thread's log from the old folder into the new one the next time the thread runs, and then writes only to the new copy. A thread that has not run since keeps only its old log. When both folders hold a session, Burn reads the copy with the newest modification time, which is normally the one bb still writes to, and skips the other:

- After a move back to an older bb, the old folder's copy is newer. It lacks what the thread spent while the newer bb ran it.
- A log restored from a backup without its original modification time looks newer than it is, so Burn can show the restored copy's lower figures until bb writes to the other copy again.

If Burn may not read a copy, it reads the next one. If no copy can be read, that thread keeps the last figures Burn read for it, and Burn logs the machine once. A thread with several pi sessions, one of which Burn may not read, is marked partial. Burn shows the partial figures only while they are higher than the last complete ones, and never saves them, so the complete figures stay to fall back on.

bb's pi bridge can be pointed elsewhere with `BB_PI_BRIDGE_SESSION_DIR`, and then it writes only to that folder. bb 0.50.1 removes `BB_*` variables that plugin code would inherit from bb's own environment, so Burn sees the variable only when it is set in bb's machine environment, and the pi bridge may not see it from there. When Burn sees it, Burn reads that folder first and still reads the two folders above. When only the pi bridge sees it, Burn finds those logs only through the Burn pi extension: from 0.11.2 it sends Burn its session log's path with each report, and Burn reads that folder for the thread's sessions too. Burn does not watch that folder, so the figures change as the extension reports, after each model call, rather than as the log changes. Without the extension, Burn shows no cost for those threads, and the chip says it cannot find their session logs.

A log with more than 50,000 entries is read from its newest entries, as OpenCode's own reader does with its 20,000 messages, so a single extremely long session drops its oldest spend from the figures. Across all logs Burn keeps at most 200,000 entries in memory and reads an evicted log again from the beginning when something asks for it. If the logs that are being polled at once hold more than that, the cost is repeated reads rather than growing memory. A line with no newline larger than 4 MB is dropped rather than held.

A new thread's pi session id can reach bb after Burn's first lookup. Burn treats that lookup as provisional and looks again after five seconds, so a thread shows its figures within seconds even though the host watch could not match its log at first.

A thread whose machine bb creates when the thread starts has no machine until that machine is ready, and Burn's shared list of threads can be up to a minute older than that. When a working thread has no machine in that list, Burn reads the thread itself from bb. If bb has not given it a machine yet, Burn looks again after 5, 10 and 20 seconds, then every 30 seconds, for about three minutes in all, and only while bb says the thread is working. Each look reads that thread from bb, and its environment once it has one, but never the whole list of threads. At most four looks run at once. A look bb does not answer within 25 seconds gives up its place to the next, but no more than eight reads ever wait on bb together. A look that fails counts as one that found no machine. The chip reads again only when a look finds the machine. After the last look, Burn looks again when the thread next starts, or on the first read after five minutes.

After a machine's bb daemon restarts, live updates for its threads resume within a minute.

Burn mints a token for each thread and gives it to that thread's pi session, so one thread's pi cannot report another thread's figures. A pi session that was already running when you updated Burn has no token and stops reporting its budget, context and stop marker until it restarts; its cost still shows from the session log. If Burn cannot read or write its token secret when it loads, it mints a per-load secret, which locks out every running session the same way until it restarts; check the plugin log for the storage error. Two plugin loads that overlap can also mint different secrets, with the same restart-only recovery.

Burn waits at most a second for a machine to answer. When one takes longer, Burn shows the figures it last read there and updates them as soon as the machine answers.

### Prices

Dollar figures are list prices unless you set a **Discount (%)** in Burn's settings; see [Discounts](bb.md#discounts). They are either the costs pi recorded or Burn's estimates (`~$`), and estimates are discounted too. Burn cannot see what a proxy actually bills, so set the discounts to match its rates. Estimates also price every cache write as a five-minute write, because bb's usage events do not say which writes were one-hour writes.

The pi extension does not use Burn's discounts, so pi's pill and `/burn` show list price. With the pi extension installed and **Stop a thread at its budget** on, the extension stops a run when its list-price cost reaches the budget. With a discount set, that is earlier than the chip shows.

Router aliases such as `shopify/auto-best` have no known price, so their threads show tokens unless you add their rates under **Price overrides** in Burn's settings. An override replaces that model's whole built-in rate row, including any long-context price tier, so give the rates you actually pay. Overrides price Claude Code and Codex threads, whose tokens Burn prices itself; pi and OpenCode threads keep the cost their harness recorded. A cost in a currency other than US dollars is not converted, so that thread shows tokens too. Estimates also skip a price tier when a Codex usage event covers more than one call, because the event has no single call's token count.

### Harnesses other than pi

- A harness that sends bb no usage, and whose own records Burn does not read, shows nothing.
- Call time, output speed and failed calls come from pi's session logs and opencode's database, and only from the calls they timed. Codex and Claude Code record none of them, so their figures read "—".
- Output speed counts the whole call, from the request to the last token, so it reads lower than a provider's quoted generation speed. Figures that Burn 0.5.3 or older recorded, such as those kept for a machine that is offline, have no speed per prompt, and a model with some untimed calls has no speed until Burn reads that thread's log again.
- Claude Code threads read saved transcripts, including nested subagent/workflow transcripts, on the execution host. When transcripts are unavailable Burn keeps its last report or falls back to BB events with a limited-coverage notice. Claude Code is still never stopped at its budget; alerts still fire. See [coverage](usage-coverage.md).
- Usage that bb deleted before Burn first read a thread counts as one entry: the total is right, but the split by day and model is lost. Claude Code's event fallback can lose usage when its running total restarts between turns; transcript reads recover only history still present on disk.

### The Burn page

- The page counts the spend of every thread by the days on which its model calls were made.
- The Models table's cache hit rate, average call time, output per second and failure rate cover the whole life of the threads in the range, not only the chosen days.
- The activity map counts by UTC clock hour. In a time zone with a half-hour offset it shifts by half an hour, so calls in the first half hour after midnight show on the previous day.
- A report from a Burn 0.2 pi extension, or the last report of an offline machine, has no token, call-time or hourly detail until Burn reads the thread again.

### Stopping and counting

- The server-side stop, used when the pi extension is not installed, ends the thread's current work through bb.
- A forked session counts only from its creation, so pi's own footer reads higher for it.
- pi orders status entries by key, so where the pill sits next to other markers is up to pi.
