# Burn in bb

The bb plugin shows what every thread has cost, whatever harness runs it: pi, OMP, OpenCode, Codex, Claude Code or another. It needs no pi extension.

## The chip and its card

The chip sits beside the context circle under the prompt box. Like pi's footer, it shows the thread's own cost. While the thread works, and for a moment after its cost changes, it also shows what the last prompt added. Near or over its budget, it shows the budget instead. Click it for a card with the breakdown: where the money went, a chart of each call, the models used, and the total with the thread's child threads, such as minions. From the card you can open the Burn tab in the side panel, set a budget for the thread, or copy a summary.

On a phone, bb shows the row under the prompt box only while the prompt box is expanded. Until then, a flame button in the thread header stands in for the chip and opens the same card.

![The Burn card above the chip: $4.27 for this thread, $4.40 with its child thread](../assets/screenshots/bb-chip-card.png)

Each model in the card shows its calls and its output speed, for example `41 calls · 62 tok/s`. Calls are model requests, not tool executions; tool counts appear in each prompt's details. The speed is the output tokens of the timed calls, divided by how long those calls took. A call's time runs from the request to the last token, so it includes the wait for the first token, and the speed reads lower than a provider's quoted generation speed. Only pi, OMP and OpenCode time their calls, so threads in other harnesses show no speed.

**Where it went** splits a thread's cost into input, cache write, cache read and output. When a harness reports one total with no split by token kind, that part appears as **Unsplit** in the bar and the legend, with a note saying why, rather than leaving the bar grey.

Amounts that Burn estimated from list prices start with `~`, for example `~$1.23`. A model without a known price shows tokens instead of dollars. See [where the numbers come from](how-it-works.md#where-the-numbers-come-from).

Elsewhere in bb:

- Every thread menu has a **Cost** entry with the thread's cost, including its children, and the same actions as the card.
- Threads over their budget get a red flame in the sidebar.

## The Burn tab

The Burn tab in the thread's side panel charts cumulative spend for this thread, lists every prompt with its cost, and adds the cost of the thread's child threads. **Spend over time** uses recorded call times and hourly totals where finer timing is unavailable. It labels gaps in coverage rather than attributing spend to an invented time. The budget guide compares thread spend with a thread-only budget, not a budget shared with children. It also holds the thread's budget. Beside the totals, **Speed** gives the thread's output tokens per second over its timed calls, and each prompt's details and the models list give their own. With a discount set, a **With discounts · List price** switch at the top shows the same thread at list price, to compare.

The chip and panel count the descendants and workflow workers Burn finds, including archived and hidden threads. If some children have no recorded usage, the total says how many it covers, for example “with 60 of 115 child threads.” The detail list shows at most the 50 highest-cost children, but the total includes recorded usage outside that list.

![The Burn tab: totals, every prompt's cost, and the thread with its child](../assets/screenshots/bb-panel.png)

## The Burn page

The **Burn** page in bb's navigation shows spend across all threads by day, project, model and harness.

![The Burn page for the last 30 days: cost and usage cards, spend per day by model, token mix and call time](../assets/screenshots/bb-burn-page.png)

The toolbar has two rows. The first picks which days the page shows:

- **Days:** **Today**, the arrows that step back or forward by one range, and the dates, which open a date picker. Picking a date shows the range that ends on it, and clicking a day in the per-day chart opens that day. The page address keeps what you look at, such as `spend/7d/2026-10-15`, so the browser's back and forward buttons walk through it and a link opens the same days.
- **Range:** a day, 7 days or 30 days. Looking back, every figure covers the days shown, and the change in the Spent card compares them with the same length of time just before them.

The second picks what the page measures:

- **Show:** **Cost**, **Tokens** or **Calls**. The choice re-ranks the daily chart, the activity map, the threads, the Models table and the bars by project and by harness.
- **Project:** every project, or one.
- **View:** which calendar day counts as today, and which panels show. **Local** is the bb machine's day, and the default; **UTC** is the day that Shopify's AI proxy and menu bar count. Any panel apart from the four cost cards can be hidden, here or with the hide button that appears when you point at it; Burn keeps the hidden panels for every bb window.

Under the cost cards, a **With discounts or List price** switch shows while a discount is set. List price shows every figure without your discounts, to compare, and leaves budgets out, because they apply to the discounted figures.

Burn remembers the range, the measure, the project, Local or UTC and the price switch on this device, so the page opens as you left it. Opening the page always shows the newest days. How far back you can look depends on each thread: it keeps its last 60 days with use, and its last 744 hours with use for Activity by hour, so a long-lived thread's oldest days drop out.

The panels:

- In **Day** with **Cost** selected, **Spend over time** charts cumulative spend for the selected date and project using hourly records. The by-model bar stays available. Burn calls out missing hourly detail and omits the daily budget guide when the selected scope or the hourly figures do not match the daily budget total.
- Under the four cost cards, usage cards show the tokens, the calls and prompts, the median call time with its 90th percentile (p90), and the failed calls.
- **Token mix** sets each kind of token (input, cache write, cache read, output, and the reasoning part of output) against what it cost.
- **Call time** shows how long calls took, and how many failed or were stopped.
- **Activity by hour** shows the busiest hours of each day.
- **Costliest threads** lists the threads that spent the most in the range.
- The **Models** table lists each model with its harness, calls, tokens, cost, cache hit rate, average call time, output tokens per second and failure rate.
- **By project** and **By harness** split the spend between projects, and between pi, OpenCode, Codex, Claude Code and any other harness.

![The Burn page's tables: costliest threads, models, and spend by project and by harness](../assets/screenshots/bb-burn-tables.png)

## Budgets

Burn warns at 80% and at 100% of a thread's budget. It never stops a thread unless you turn on **Stop a thread at its budget**, which is off by default.

An over-budget or stopped-thread notification stays on screen until you close it. The others close after 10 to 15 seconds. bb's notification center, behind the bell in the sidebar, keeps every Burn notification, so you can read one you missed.

Set a thread's own budget from the chip, the thread menu or the Burn tab. The **Thread budget** setting applies to every thread without its own.

BB owns budget stops for its Pi threads and uses discounted spend. The Burn extension is inactive in BB-managed Pi sessions. Burn still accepts reports from older extensions, but tells them not to stop runs or send expensive-turn notices. Restart older sessions that may still be using a cached policy. A budget reported only by an older Pi extension can still appear in BB. To enforce it, set it in the Burn editor.

### Share a budget with child threads

In the budget editor, check **Include child threads** and save. This is off by default and applies only to that budget. It counts the thread and all descendants, including nested children, archived or hidden children, and workflow-owned workers. Native subagent usage already included in a thread's cost is not added again. Children's own budgets still apply independently.

The budget meter, chip colour, sidebar flag and alerts use the combined cost. The chip's main amount remains the thread's own cost; its tooltip and the card show the combined budget spending. The Burn page uses combined spending for budget status without adding children to its spend totals twice.

With **Stop a thread at its budget** enabled, crossing the combined limit stops the family's running threads through bb, even when the parent is idle. Claude Code threads retain the existing exception: Burn does not stop them because their cost arrives only as each turn ends. Turning on child tracking alone does not enable stopping.

This is a stop on a threshold crossing, not a hard spending cap. Usage arrives after a model call, so concurrent calls can overshoot. Saving a budget already below the current total does not stop work immediately, and sending another prompt after a stop still continues. **Use default** and **Clear** also turn child tracking off for this budget.

### Let agents use a budget

Burn enables two native tools by default. An agent can call `burn_budget_status` for its own thread or a descendant, including workflow-owned workers. It shows the known spend for the thread and its family, the cap that applies, the amount left based on known spend, and whether BB's stopping setting is on. That setting does not imply that every harness or a legacy Pi-only budget can stop a run. It lists IDs for up to 50 descendants. Missing usage and estimated prices are shown separately. The figures include your discounts, but estimates can differ from the bill in either direction.

`burn_set_budget` sets an absolute lifetime amount in USD, not an amount to add. For example, to change a $100 cap to $200, pass `amountUsd: 200`. The tools and the budget editor use the same cap. The tool preserves its scope and cannot clear it or change the default, daily budget, alerts, or stopping.

An agent can add a finite cap where there is none or lower an existing cap. For other increases, the tool refuses and shows the target and the old and requested amounts. Change the amount yourself in Burn's existing budget editor. The tool reads the saved cap on the next call. It does not accept a chat message or a form answer as approval.

A parent with **Include child threads** can raise a descendant's cap when the descendant's new headroom fits the parent's remaining recorded family spend. That shortcut requires complete enough usage with known prices. The parent's own cap does not change. A child cap is a threshold, not a reservation against the family cap. Usage arrives after calls, so concurrent work can overshoot, and the same opt-in stopping rules still apply.

These restrictions apply to Burn's native tools. They do not restrict an agent or process that already has owner-equivalent access to BB's editor or APIs.

## Discounts

Burn's dollar figures are list prices, the published price per token. If you pay less, for example at a contract rate, set **Discount (%)** in Burn's settings. 16 means you pay 84% of list price. A negative number raises prices instead: -10 adds 10%. Four more settings each replace the discount for one line item: uncached input, output, cache reads or cache writes. Leave them empty to use **Discount (%)**.

Every cost Burn shows uses your discounts: the chip, the card, the Burn tab, the Burn page and the thread menu, and also budgets, budget alerts, the daily budget, the sidebar flag and the stop at budget. The card, the Burn tab and the Burn page say when their figures include discounts. The **With discounts · List price** switch, in the Burn tab and on the Burn page, shows the same figures at list price, to compare.

A thread's total, each day's total and the split by line item are exact. Figures per call, per prompt and per model hold only a total, so when the line items have different discounts, they take the thread's overall discount. With one discount for everything, every figure is exact. A cost that a harness reports as one total, with no split by line item, is shown as reported.

## Settings

These are in Burn's plugin settings.

| Setting | Default | What it does |
| --- | --- | --- |
| Cost chip | on | Shows the chip beside the context circle, or in the thread header when that row is not on screen, where a phone shows the flame alone. |
| Chip shows | Cost and last turn | Or the cost only. |
| Thread budget | none | A budget for every thread. A thread's own budget, set from the chip or the thread menu, overrides it. |
| Daily budget | none | One notification a day when all threads together pass it. |
| Budget alerts | on | Notifications at 80% and 100% of a thread's budget. |
| Stop a thread at its budget | off | Stops the current work through bb when discounted spend crosses a budget set in bb. A budget that includes children stops the running family. Claude Code threads are not stopped, because their cost arrives only as each turn ends. Sending another prompt continues. |
| Flag threads over budget | on | The red flame in the sidebar. |
| Notify after an expensive prompt | off | A notification after a prompt that costs at least 3 times the thread's median and at least $0.50. |
| Price overrides (JSON) | empty | Rates in dollars per million tokens for models the built-in list does not price, such as router aliases or contract rates: `{"model-id": {"input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75}}`. Input and output are required; cache rates default to 0. An override replaces that model's whole built-in row, including any long-context price tier. Burn uses these rates for Claude Code and Codex threads, whose tokens it prices itself. pi, OMP and OpenCode threads keep the cost their harness recorded. |
| Discount (%) | 0 | Percent off list price for every cost Burn shows, budgets included. 16 means you pay 84% of list price, and a negative number raises prices. 0 is list price. See [Discounts](#discounts). |
| Input discount (%) | empty | Replaces **Discount (%)** for uncached input tokens. |
| Output discount (%) | empty | Replaces **Discount (%)** for output tokens, reasoning included. |
| Cache read discount (%) | empty | Replaces **Discount (%)** for cache reads. |
| Cache write discount (%) | empty | Replaces **Discount (%)** for cache writes. |
