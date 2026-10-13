import { tradingDayStart } from "./risk.js";
import { snapToTick } from "./ticks.js";

/**
 * Order flow: the per-minute fields, bars and windows of projectx-mcp's live
 * field contract (its docs/ORDER-FLOW-DESIGN.md), ported function by function
 * from its src/orderflow.ts (cited as `orderflow.ts#<name>`). Pure: no I/O, no
 * clock. The history engine that fills the minute buckets from the local
 * order-book data is flowengine.ts; the store and the tool are flowstore.ts and
 * flowtools.ts.
 */

export const MINUTE_MS = 60_000;

export type Side = "buy" | "sell";

/** A print as the bucket takes it (orderflow.ts#Print): `t` in ms, `side` null when unknown. */
export interface Print {
  t: number;
  price: number;
  size: number;
  side: Side | null;
  /** The exchange timestamp was unusable (live only; history always has one). */
  badTimestamp?: boolean;
}

/** One L1 (top of book) state (orderflow.ts#L1Event, without `source`: history's L1 is the exchange's top of book). */
export interface L1State {
  bid: number | null;
  bidSize: number | null;
  ask: number | null;
  askSize: number | null;
}

/**
 * One event's order-flow imbalance (Cont, Kukanov & Stoikov 2014, eq. 2), orderflow.ts#ofiEvent:
 *   e_n = 1{Pb_n >= Pb_n-1} qb_n - 1{Pb_n <= Pb_n-1} qb_n-1 - 1{Pa_n <= Pa_n-1} qa_n + 1{Pa_n >= Pa_n-1} qa_n-1
 * Null when either state lacks a price or a size.
 */
export function ofiEvent(prev: L1State, cur: L1State): number | null {
  const v = [prev.bid, prev.bidSize, prev.ask, prev.askSize, cur.bid, cur.bidSize, cur.ask, cur.askSize];
  if (v.some((x) => x === null)) return null;
  const [pb, qb0, pa, qa0, b, qb, a, qa] = v as number[];
  return (b >= pb ? qb : 0) - (b <= pb ? qb0 : 0) - (a <= pa ? qa : 0) + (a >= pa ? qa0 : 0);
}

/** Mutable per-minute accumulator (orderflow.ts#MinuteBucket, without the live quote-volume cross-check fields). */
export interface MinuteBucket {
  t: number;
  bv: number;
  sv: number;
  volume: number;
  trades: number;
  pv: number;
  high: number | null;
  low: number | null;
  maxPrint: number | null;
  /** print size -> [buy volume, sell volume] */
  sizes: Map<number, [number, number]>;
  /** price -> [bid-side volume (sell aggressor), ask-side volume (buy aggressor)] */
  vap: Map<number, [number, number]>;
  ofiQuote: number;
  ofiEvents: number;
  /** ∫ book imbalance dt and the ms it was defined during the minute. */
  imbArea: number;
  imbMs: number;
  badTimestamps: number;
  sidelessVolume: number;
  /** History only: L1 rows (quote changes and trades) in the minute, the data-present fact for completeness. */
  l1Events: number;
}

export const minuteOf = (t: number) => Math.floor(t / MINUTE_MS) * MINUTE_MS;

export function newBucket(t: number): MinuteBucket {
  return { t: minuteOf(t), bv: 0, sv: 0, volume: 0, trades: 0, pv: 0, high: null, low: null, maxPrint: null, sizes: new Map(), vap: new Map(), ofiQuote: 0, ofiEvents: 0, imbArea: 0, imbMs: 0, badTimestamps: 0, sidelessVolume: 0, l1Events: 0 };
}

const key = (price: number) => Number(price.toFixed(10));

/** orderflow.ts#addPrint (without the live cross-check's last-print fields). */
export function addPrint(b: MinuteBucket, p: Print): void {
  b.volume += p.size;
  b.trades += 1;
  b.pv += p.price * p.size;
  b.high = b.high === null ? p.price : Math.max(b.high, p.price);
  b.low = b.low === null ? p.price : Math.min(b.low, p.price);
  b.maxPrint = b.maxPrint === null ? p.size : Math.max(b.maxPrint, p.size);
  if (p.badTimestamp) b.badTimestamps += 1;
  if (!p.side) {
    b.sidelessVolume += p.size;
    return;
  }
  if (p.side === "buy") b.bv += p.size;
  else b.sv += p.size;
  const s = b.sizes.get(p.size) ?? [0, 0];
  s[p.side === "buy" ? 0 : 1] += p.size;
  b.sizes.set(p.size, s);
  const k = key(p.price);
  const v = b.vap.get(k) ?? [0, 0];
  v[p.side === "buy" ? 1 : 0] += p.size;
  b.vap.set(k, v);
}

/** A minute in plain form (orderflow.ts#MinuteRecord). `source` is "history" here. */
export interface MinuteRecord {
  t: number;
  bv: number;
  sv: number;
  volume: number;
  trades: number;
  vwap: number | null;
  high: number | null;
  low: number | null;
  maxPrint: number | null;
  /** [size, buy volume, sell volume] */
  sizes: Array<[number, number, number]>;
  /** [price, bid-side volume, ask-side volume] */
  vap: Array<[number, number, number]>;
  ofiQuote: number | null;
  bookImbalance: number | null;
  badTimestamps: number;
  sidelessVolume: number;
  complete: boolean;
  source: "history";
}

/**
 * The record of a minute (orderflow.ts#recordOf): `covered` is the source's
 * coverage verdict; the minute is complete only if, in addition, no timestamp
 * in it was unusable and every print had a known side.
 */
export function recordOf(b: MinuteBucket, covered: boolean): MinuteRecord {
  return {
    t: b.t,
    bv: b.bv,
    sv: b.sv,
    volume: b.volume,
    trades: b.trades,
    vwap: b.volume > 0 ? Number((b.pv / b.volume).toFixed(10)) : null,
    high: b.high,
    low: b.low,
    maxPrint: b.maxPrint,
    sizes: [...b.sizes].map(([s, [buy, sell]]) => [s, buy, sell]),
    vap: [...b.vap].map(([p, [bid, ask]]) => [p, bid, ask]),
    // No book during the minute: OFI and imbalance are unknown, not zero.
    ofiQuote: b.imbMs > 0 || b.ofiEvents > 0 ? b.ofiQuote : null,
    bookImbalance: b.imbMs > 0 ? b.imbArea / b.imbMs : null,
    badTimestamps: b.badTimestamps,
    sidelessVolume: b.sidelessVolume,
    complete: covered && b.badTimestamps === 0 && b.sidelessVolume === 0,
    source: "history",
  };
}

export interface MinuteRow {
  t: string;
  bv: number;
  sv: number;
  delta: number;
  volume: number;
  trades: number;
  vwap: number | null;
  high: number | null;
  low: number | null;
  maxPrint: number | null;
  largeBuyVolume: number;
  largeSellVolume: number;
  ofiTrades: number | null;
  ofiQuote: number | null;
  bookImbalance: number | null;
  badTimestamps: number;
  sidelessVolume: number;
  complete: boolean;
  cumDelta: number | null;
  source: "history";
}

/** The row of a record, large prints at `largePrint` contracts or more (orderflow.ts#rowOf). */
export function rowOf(r: MinuteRecord, largePrint: number, cumDelta: number | null): MinuteRow {
  let largeBuyVolume = 0;
  let largeSellVolume = 0;
  for (const [size, buy, sell] of r.sizes) {
    if (size >= largePrint) {
      largeBuyVolume += buy;
      largeSellVolume += sell;
    }
  }
  return {
    t: new Date(r.t).toISOString(),
    bv: r.bv,
    sv: r.sv,
    delta: r.bv - r.sv,
    volume: r.volume,
    trades: r.trades,
    vwap: r.vwap,
    high: r.high,
    low: r.low,
    maxPrint: r.maxPrint,
    largeBuyVolume,
    largeSellVolume,
    ofiTrades: r.bv + r.sv > 0 ? (r.bv - r.sv) / (r.bv + r.sv) : null,
    ofiQuote: r.ofiQuote,
    bookImbalance: r.bookImbalance,
    badTimestamps: r.badTimestamps,
    sidelessVolume: r.sidelessVolume,
    complete: r.complete,
    cumDelta,
    source: r.source,
  };
}

/**
 * Session cumulative delta per minute (orderflow.ts#cumulativeDeltas): the
 * session starts at the trading-day start (17:00 America/Chicago); the value is
 * null from the first missing or incomplete minute of a session on.
 */
export function cumulativeDeltas(byMinute: ReadonlyMap<number, MinuteRecord>, from: number, to: number): Map<number, number | null> {
  const out = new Map<number, number | null>();
  let session = NaN;
  let sum: number | null = null;
  let s = NaN;
  let nextHour = -Infinity;
  for (let t = minuteOf(from); t <= to; t += MINUTE_MS) {
    if (t >= nextHour) {
      s = tradingDayStart(new Date(t)).getTime();
      nextHour = Math.floor(t / 3600_000) * 3600_000 + 3600_000;
    }
    if (s !== session) {
      session = s;
      sum = t === s ? 0 : null;
    }
    const r = byMinute.get(t);
    sum = sum !== null && r?.complete ? sum + r.bv - r.sv : null;
    out.set(t, sum);
  }
  return out;
}

export interface FootprintLevel {
  price: number;
  bidVolume: number;
  askVolume: number;
  buyImbalance: boolean | null;
  sellImbalance: boolean | null;
}

export interface FootprintBar {
  t: string;
  complete: boolean;
  minutes: number;
  volume: number;
  delta: number;
  poc: number | null;
  levels: FootprintLevel[];
  sources: Array<"history">;
}

/** One footprint bar from its minutes' records (orderflow.ts#footprintBar); a missing minute makes it incomplete. */
export function footprintBar(start: number, barMinutes: number, records: Array<MinuteRecord | undefined>, tick: number | null, ratio: number): FootprintBar {
  const vap = new Map<number, [number, number]>();
  let complete = records.length === barMinutes;
  const sources = new Set<"history">();
  for (const r of records) {
    if (!r?.complete) complete = false;
    if (!r) continue;
    sources.add(r.source);
    for (const [p, bid, ask] of r.vap) {
      const v = vap.get(p) ?? [0, 0];
      v[0] += bid;
      v[1] += ask;
      vap.set(p, v);
    }
  }
  const at = (p: number) => vap.get(key(p));
  const levels: FootprintLevel[] = [...vap.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([price, [bidVolume, askVolume]]) => {
      let buyImbalance: boolean | null = null;
      let sellImbalance: boolean | null = null;
      if (tick) {
        const below = at(snapToTick(price - tick, tick, "nearest"))?.[0] ?? 0;
        const above = at(snapToTick(price + tick, tick, "nearest"))?.[1] ?? 0;
        buyImbalance = below > 0 && askVolume >= ratio * below;
        sellImbalance = above > 0 && bidVolume >= ratio * above;
      }
      return { price, bidVolume, askVolume, buyImbalance, sellImbalance };
    });
  let volume = 0;
  let delta = 0;
  let pv = 0;
  for (const l of levels) {
    const v = l.bidVolume + l.askVolume;
    volume += v;
    pv += v * l.price;
    delta += l.askVolume - l.bidVolume;
  }
  // POC: the price with the most volume; a tie goes to the price nearest the bar's VWAP, then to the lower price.
  const vwap = volume > 0 ? pv / volume : 0;
  let poc: number | null = null;
  let pocVol = -1;
  for (const l of levels) {
    const v = l.bidVolume + l.askVolume;
    const better =
      v > pocVol ||
      (v === pocVol && poc !== null && (Math.abs(l.price - vwap) < Math.abs(poc - vwap) - 1e-9 || (Math.abs(Math.abs(l.price - vwap) - Math.abs(poc - vwap)) <= 1e-9 && l.price < poc)));
    if (better) {
      pocVol = v;
      poc = l.price;
    }
  }
  return { t: new Date(start).toISOString(), complete, minutes: barMinutes, volume, delta, poc, levels, sources: [...sources] };
}

/** Order flow over one bar span, from its minute rows (orderflow.ts#BarFlow). */
export interface BarFlow {
  bv: number | null;
  sv: number | null;
  delta: number | null;
  trades: number | null;
  volume: number | null;
  vwap: number | null;
  ofiTrade: number | null;
  ofiQuote: number | null;
  imbalance: number | null;
  largeBuy: number | null;
  largeSell: number | null;
  complete: boolean;
}

export const EMPTY_BAR_FLOW: Readonly<BarFlow> = Object.freeze({
  bv: null, sv: null, delta: null, trades: null, volume: null, vwap: null, ofiTrade: null, ofiQuote: null, imbalance: null, largeBuy: null, largeSell: null, complete: false,
});

/**
 * Bar flow for [start, start + minutes): the sum of its minute rows
 * (orderflow.ts#barFlow). Only a span whose minutes are all present and
 * complete has values; any other span is EMPTY_BAR_FLOW.
 */
export function barFlow(byMinute: ReadonlyMap<number, MinuteRecord>, start: number, minutes: number, largePrint: number): BarFlow {
  const rows: MinuteRow[] = [];
  for (let k = 0; k < minutes; k++) {
    const r = byMinute.get(start + k * MINUTE_MS);
    if (!r?.complete) return { ...EMPTY_BAR_FLOW };
    rows.push(rowOf(r, largePrint, null));
  }
  let bv = 0, sv = 0, trades = 0, volume = 0, pv = 0, largeBuy = 0, largeSell = 0, ofiQuote: number | null = 0, imbSum = 0, imbN = 0;
  for (const r of rows) {
    bv += r.bv;
    sv += r.sv;
    trades += r.trades;
    volume += r.volume;
    if (r.vwap !== null) pv += r.vwap * r.volume;
    largeBuy += r.largeBuyVolume;
    largeSell += r.largeSellVolume;
    ofiQuote = ofiQuote === null || r.ofiQuote === null ? null : ofiQuote + r.ofiQuote;
    if (r.bookImbalance !== null) {
      imbSum += r.bookImbalance;
      imbN++;
    }
  }
  return {
    bv,
    sv,
    delta: bv - sv,
    trades,
    volume,
    vwap: volume > 0 ? Number((pv / volume).toFixed(10)) : null,
    ofiTrade: bv + sv > 0 ? (bv - sv) / (bv + sv) : null,
    ofiQuote,
    imbalance: imbN > 0 ? imbSum / imbN : null,
    largeBuy,
    largeSell,
    complete: true,
  };
}

/**
 * Trade OFI and delta over the n spans ending with the one at `start`, going
 * back by `spanMs` whether or not a bar exists there (orderflow.ts#flowWindow).
 * Null unless every one of them is complete.
 */
export function flowWindow(spanFlow: (start: number) => BarFlow, start: number, spanMs: number, n: number): { ofiTrade: number | null; delta: number | null } {
  let bv = 0;
  let sv = 0;
  for (let k = 0; k < n; k++) {
    const f = spanFlow(start - k * spanMs);
    if (!f.complete) return { ofiTrade: null, delta: null };
    bv += f.bv!;
    sv += f.sv!;
  }
  return { ofiTrade: bv + sv > 0 ? (bv - sv) / (bv + sv) : null, delta: bv - sv };
}
