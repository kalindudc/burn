import { describe, expect, it } from "vitest";
import { buildSpendHistory } from "../../extensions/bb/spend-history.js";
import { timeFraction, timeTicks } from "../../extensions/bb/spend-axis.js";
import { applyDiscounts } from "../../src/discounts.js";
import { buildReport, HOURS_MAX, HOUR_MS, SERIES_MAX } from "../../src/report.js";
import { assistant, compaction, user } from "../helpers.js";

const START = Date.UTC(2026, 10, 26, 14);
const MINUTE = 60_000;
const at = <T extends { timestamp: string }>(entry: T, when: number): T => ({ ...entry, timestamp: new Date(when).toISOString() });
const report = (...entries: Parameters<typeof buildReport>[0]) => buildReport(entries, null);

describe("thread spend history", () => {
  it("reconciles exact calls with non-call spend before, between and after the calls", () => {
    const source = report(
      at(user(), START),
      at(compaction(1), START + 5 * MINUTE),
      at(assistant(2), START + 15 * MINUTE),
      at(compaction(1), START + 20 * MINUTE),
      at(assistant(3), START + 30 * MINUTE),
      at(compaction(2), START + 55 * MINUTE),
      at(user(), START + 2 * HOUR_MS),
      at(assistant(1), START + 2 * HOUR_MS + MINUTE),
      at(user(), START + 3 * HOUR_MS),
    );
    expect(buildSpendHistory(source)).toMatchObject({
      from: START, to: START + 3 * HOUR_MS, carried: 0, unplotted: 0, plotted: 10, hasHourly: true,
      points: [
        { at: START, total: 0 },
        { at: START + 15 * MINUTE, total: 1 },
        { at: START + 15 * MINUTE, total: 3 },
        { at: START + 30 * MINUTE, total: 4 },
        { at: START + 30 * MINUTE, total: 7 },
        { at: START + HOUR_MS, total: 9 },
        { at: START + 2 * HOUR_MS + MINUTE, total: 9 },
        { at: START + 2 * HOUR_MS + MINUTE, total: 10 },
        { at: START + 3 * HOUR_MS, total: 10 },
      ],
    });
  });

  it("starts at the first retained hour with a carry when both reports have truncated", () => {
    const source = report(...Array.from({ length: HOURS_MAX + 5 }, (_, i) => at(assistant(1), START + i * HOUR_MS + MINUTE)));
    expect(source.series).toHaveLength(SERIES_MAX);
    const graph = buildSpendHistory(source)!;
    expect(graph.points[0]).toEqual({ at: START + 5 * HOUR_MS, total: 5 });
    expect(graph.plotted).toBe(source.cost.total);
    expect(graph.unplotted).toBe(0);
  });

  it("leaves only the unmatched spend unplotted for legacy or untimed rows", () => {
    const source = report(
      { ...assistant(2), timestamp: "" },
      at(assistant(5), START + MINUTE),
      at(compaction(3), START + 20 * MINUTE),
    );
    expect(buildSpendHistory(source)).toMatchObject({ from: START, carried: 0, unplotted: 2, plotted: 8, hasHourly: true });
    expect(buildSpendHistory({ ...source, hours: [] })).toMatchObject({
      from: START + MINUTE, carried: 0, unplotted: 5, plotted: 5, hasHourly: false,
    });
    const truncated = report(
      { ...compaction(9), timestamp: "" },
      ...Array.from({ length: HOURS_MAX }, (_, i) => at(compaction(1), START + i * HOUR_MS + MINUTE)),
    );
    expect(buildSpendHistory(truncated)).toMatchObject({ carried: 0, unplotted: 9 });
  });

  it("does not carry truncated spend ahead of an older retained call if the missing hours could follow it", () => {
    const firstCall = START + HOUR_MS + MINUTE;
    const source = report(
      at(assistant(2), firstCall),
      at(compaction(7), START + 3 * HOUR_MS),
      ...Array.from({ length: HOURS_MAX }, (_, i) => at(compaction(1), START + (i + 4) * HOUR_MS + MINUTE)),
    );
    expect(buildSpendHistory(source)).toMatchObject({ from: firstCall, carried: 0, unplotted: 7, plotted: HOURS_MAX + 2 });
  });

  it("keeps the server's discounted and list-price amounts as supplied", () => {
    const source = report(at(assistant(8), START + MINUTE), at(compaction(4), START + 15 * MINUTE));
    const priced = applyDiscounts(source, { input: 50, output: 10, cacheRead: 0, cacheWrite: 100 });
    const graph = buildSpendHistory(priced)!;
    expect(graph.plotted).toBe(priced.cost.total);
    expect(graph.points[1]?.total).toBe(priced.series[0]?.cost);
    expect(buildSpendHistory(source)?.plotted).toBe(12);
  });

  it("shows no history for empty, zero-priced, untimed, or contradictory rows", () => {
    const unknown = report({ ...assistant(1), timestamp: "" });
    const source = report(at(assistant(3), START));
    const [hour] = source.hours;
    expect(buildSpendHistory(report())).toBeNull();
    expect(buildSpendHistory(report(at(assistant(0), START)))).toBeNull();
    expect(buildSpendHistory(unknown)).toBeNull();
    expect(buildSpendHistory({ ...source, hours: [{ ...hour!, cost: 2 }] })).toBeNull();
    expect(buildSpendHistory({ ...source, cost: { ...source.cost, total: Number.NaN } })).toBeNull();
  });

  it("orders timed samples and handles equal timestamps without making up a time range", () => {
    const same = report(at(assistant(1), START), at(assistant(2), START));
    expect(buildSpendHistory(same)).toMatchObject({ from: START, to: START, plotted: 3 });
    expect(timeFraction(START, START, START)).toBe(0.5);
    const reversed = report(at(assistant(2), START + MINUTE), at(assistant(1), START));
    const badEnd = { ...reversed, updatedAt: Number.MAX_VALUE };
    expect(buildSpendHistory(badEnd)?.points).toEqual([
      { at: START, total: 0 }, { at: START, total: 1 },
      { at: START + MINUTE, total: 1 }, { at: START + MINUTE, total: 3 },
    ]);
  });

  it("preserves the elapsed gaps for identical spends at different times", () => {
    const draw = (when: number) => buildSpendHistory(report(at(user(), START), at(assistant(2), when), at(assistant(2), START + 4 * HOUR_MS)))!;
    const early = draw(START + HOUR_MS);
    const late = draw(START + 3 * HOUR_MS);
    expect(early.points.map((p) => p.total)).toEqual(late.points.map((p) => p.total));
    const position = (graph: typeof early) => timeFraction(graph.points[2]!.at, graph.from, graph.to);
    expect(position(early)).toBe(0.25);
    expect(position(late)).toBe(0.75);
  });
});

describe("thread spend time labels", () => {
  it("keeps the midnight date and drops the clock labels in the narrow mock", () => {
    const start = new Date(2026, 10, 26, 9, 12).getTime();
    const end = new Date(2026, 10, 27, 11, 55).getTime();
    expect(timeTicks(start, end, 576).map((tick) => tick.label)).toEqual(["18:00", "Nov 27", "06:00"]);
    expect(timeTicks(start, end, 336).map((tick) => tick.label)).toEqual(["Nov 27"]);
  });

  it("aligns labels to the caller's IANA zone even across a daylight-saving change", () => {
    const start = Date.UTC(2026, 2, 7, 16, 30);
    const end = Date.UTC(2026, 2, 9, 4, 15);
    const ny = timeTicks(start, end, 576, "America/New_York");
    expect(ny).toContainEqual({ at: Date.UTC(2026, 2, 8, 5), label: "Mar 8", day: true });
    expect(ny.some((tick) => tick.at >= Date.UTC(2026, 2, 8, 10) && tick.label === "06:00")).toBe(true);
    expect(timeTicks(start, end, 576, "UTC")).toContainEqual({ at: Date.UTC(2026, 2, 8), label: "Mar 8", day: true });
  });

  it("keeps tick work bounded on very long sparse timelines", () => {
    const end = Date.UTC(2126, 0, 1);
    const ticks = timeTicks(START, end, 2000);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThanOrEqual(12);
    expect(ticks.every((tick) => tick.at > START && tick.at < end)).toBe(true);
    expect(timeTicks(START, START, 320)).toEqual([]);
  });
});
