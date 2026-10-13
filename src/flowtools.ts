import { EMPTY_BAR_FLOW, MINUTE_MS, barFlow, flowWindow, type BarFlow, type MinuteRecord } from "./orderflow.js";

/**
 * get_bars' opt-in order flow, as projectx-mcp's src/flowtools.ts#barsWithFlow:
 * each bar [t, t + span) gets the sum of its minute rows (barFlow), plus trade
 * OFI and delta over the last n spans for each n in `windows`; only minute and
 * hour bars carry it; when flow is unavailable every bar gets empty flow and
 * `orderFlow.note` says why. The minutes come from the derived store's flow
 * (flowstore.ts) instead of a live feed.
 */

/**
 * Micro roots whose bars carry the full-size contract's flow (flowtools.ts#FLOW_SOURCE_ROOT):
 * MNQ bars carry NQ's, MES bars ES's (the local data has no ES: those get none).
 */
export const FLOW_SOURCE_ROOT: Readonly<Record<string, string>> = Object.freeze({ MNQ: "NQ", MES: "ES" });

/** The contract whose flow a contract's bars carry: BT.MNQ.M24 -> BT.NQ.M24, BT.MES -> BT.ES; any other, itself. */
export function flowSourceContract(contractId: string): string {
  const parts = contractId.split(".");
  const src = parts.length >= 2 ? FLOW_SOURCE_ROOT[parts[1]] : undefined;
  if (!src) return contractId;
  parts[1] = src;
  return parts.join(".");
}

export const COMPLETE =
  "complete=true means: every minute of the bar is in the derived store's order flow, ended by the replay clock, with L1 data in it (a quote change or a trade), " +
  "on the contract the bar belongs to (the roll table; not in an exception stretch), and every print sided. " +
  "Sides are inferred (the quote rule against the L1 quote in force strictly before the print, else the tick rule): history has no aggressor flag. " +
  "Times are exchange times. imbalance is null on days without L2 data. " +
  "ofiQuote is unvalidated: how history's L1 updates group into live's per-message book states is not calibrated yet. " +
  "Use a bar only when all its minutes are complete.";


export type FlowWindows = Record<string, { ofiTrade: number | null; delta: number | null }>;
export type BarWithFlow<B> = B & { flow: BarFlow & { windows: FlowWindows } };

/** Minutes a bar size spans (minute and hour bars); null for units that carry no flow. */
export function spanMinutes(unit: string, unitNumber: number): number | null {
  return unit === "minute" ? unitNumber : unit === "hour" ? unitNumber * 60 : null;
}

/** The minutes [from, to] the bars' flow and windows read (null: no bar has a usable time). */
export function flowRange(bars: Array<{ t: string }>, minutes: number, windows: number[]): { from: number; to: number } | null {
  const span = minutes * MINUTE_MS;
  const starts = bars.map((b) => Date.parse(b.t)).filter(Number.isFinite);
  if (!starts.length) return null;
  const deepest = Math.max(1, ...windows);
  return { from: Math.min(...starts) - (deepest - 1) * span, to: Math.max(...starts) + span - MINUTE_MS };
}

/** Every bar with empty flow and null windows. */
export function plainFlow<B extends { t: string }>(bars: B[], windows: number[]): Array<BarWithFlow<B>> {
  const noWindows = () => Object.fromEntries(windows.map((n) => [String(n), { ofiTrade: null, delta: null }]));
  return bars.map((b) => ({ ...b, flow: { ...EMPTY_BAR_FLOW, windows: noWindows() } }));
}

/** The bars with their flow from the minute records (flowtools.ts#withFlow). */
export function flowBars<B extends { t: string }>(byMinute: ReadonlyMap<number, MinuteRecord>, bars: B[], minutes: number, windows: number[], largePrint: number): Array<BarWithFlow<B>> {
  const span = minutes * MINUTE_MS;
  const memo = new Map<number, BarFlow>();
  const spanFlow = (start: number) => {
    let f = memo.get(start);
    if (!f) memo.set(start, (f = barFlow(byMinute, start, minutes, largePrint)));
    return f;
  };
  return bars.map((b) => {
    // A time that does not parse (NaN) finds no minutes: empty flow and null windows.
    const start = Date.parse(b.t);
    return { ...b, flow: { ...spanFlow(start), windows: Object.fromEntries(windows.map((n) => [String(n), flowWindow(spanFlow, start, span, n)])) } };
  });
}

