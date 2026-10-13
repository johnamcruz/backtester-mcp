import type { Columns } from "./parquet.js";

/**
 * Normalized market events from the local NQ order-book data (L1: best quotes
 * and trades; L2: the book behind the touch), pure functions over decoded
 * columns. Times `t` are exchange timestamps in µs since the epoch (UTC),
 * exact integers; the order is the data's order, ties kept.
 *
 * They map onto projectx-mcp's live order-flow events (src/orderflow.ts):
 * TradeEvent -> Print, QuoteEvent -> L1Event, DepthEvent -> LevelChange, with
 * `t` in ms there (`Math.floor(t / 1000)`). Fields the data doesn't have are
 * listed on each type.
 */

/** A trade print (L1 type 2). Print's `side` (aggressor) isn't in the data: flowengine.ts#inferSide infers it from the quote in force before it, else the tick rule. */
export interface TradeEvent {
  t: number;
  price: number;
  size: number;
}

/**
 * The full best-quote state after an L1 bid (type 0) or ask (type 1) change.
 * A side not seen yet since the session opened is null. L1Event's `source`
 * would be "depth" (the data is the exchange's top of book).
 */
export interface QuoteEvent {
  t: number;
  bid: number | null;
  bidSize: number | null;
  ask: number | null;
  askSize: number | null;
}

export type QuoteState = Omit<QuoteEvent, "t">;
export const EMPTY_QUOTE: QuoteState = { bid: null, bidSize: null, ask: null, askSize: null };

/**
 * An L2 change: a price level behind the touch. `size` is the level's size
 * after the change (0 for a remove; the data's own `vol` on a remove is kept
 * in `rawSize`). `rank` is the data's `depth`: the level's position among the
 * non-empty levels behind the L1 touch (1 = the first behind it), not a tick
 * distance (the order-flow book, flowengine.ts, keys levels by price and doesn't
 * use it). LevelChange's `prevSize` needs the book and is left to its consumer;
 * its `type` corresponds to `act`.
 */
export interface DepthEvent {
  t: number;
  side: "bid" | "ask";
  price: number;
  size: number;
  rawSize: number;
  act: "add" | "update" | "remove";
  rank: number;
}

/** L1 `type` codes. 3-9 are session statistics (cumulative volume, highs/lows, settlement, open interest): skipped. */
export const L1_TYPE = { bid: 0, ask: 1, trade: 2 } as const;
const ACTS = ["add", "update", "remove"] as const;

/** Rows to keep: those inside `ranges` ([from, to) in UTC ms). Row times are µs. */
export function keepRow(tUs: number, ranges: Array<[number, number]>): boolean {
  const ms = tUs / 1000;
  for (const [a, b] of ranges) if (ms >= a && ms < b) return true;
  return false;
}

/**
 * L1 rows -> trades and quote states, keeping rows inside `ranges` only. The
 * quote state starts from `start` and resets to empty at each range start
 * after the first (a new session: the book is rebuilt from fresh quotes).
 * `quotes: false` skips building the quote list (the end state is still kept).
 */
export function normalizeL1(
  cols: Columns,
  ranges: Array<[number, number]>,
  start: QuoteState = EMPTY_QUOTE,
  opts: { quotes?: boolean } = {},
): { trades: TradeEvent[]; quotes: QuoteEvent[]; end: QuoteState; kept: number } {
  const { ts, type, price, vol } = cols;
  const trades: TradeEvent[] = [];
  const quotes: QuoteEvent[] = [];
  const wantQuotes = opts.quotes !== false;
  const q: QuoteState = { ...start };
  let range = -1;
  let kept = 0;
  for (let i = 0; i < ts.length; i++) {
    const ms = ts[i] / 1000;
    let r = -1;
    for (let k = 0; k < ranges.length; k++) {
      if (ms >= ranges[k][0] && ms < ranges[k][1]) {
        r = k;
        break;
      }
    }
    if (r === -1) continue;
    kept++;
    if (range !== -1 && r !== range) Object.assign(q, EMPTY_QUOTE);
    range = r;
    const k = type[i];
    if (k === L1_TYPE.trade) trades.push({ t: ts[i], price: price[i], size: vol[i] });
    else if (k === L1_TYPE.bid || k === L1_TYPE.ask) {
      if (k === L1_TYPE.bid) {
        q.bid = price[i];
        q.bidSize = vol[i];
      } else {
        q.ask = price[i];
        q.askSize = vol[i];
      }
      if (wantQuotes) quotes.push({ t: ts[i], bid: q.bid, bidSize: q.bidSize, ask: q.ask, askSize: q.askSize });
    }
  }
  return { trades, quotes, end: q, kept };
}

/** L2 rows -> depth events, keeping rows inside `ranges` only. */
export function normalizeL2(cols: Columns, ranges: Array<[number, number]>): DepthEvent[] {
  const { ts, side, price, vol, depth, act } = cols;
  const out: DepthEvent[] = [];
  for (let i = 0; i < ts.length; i++) {
    if (!keepRow(ts[i], ranges)) continue;
    const a = ACTS[act[i]];
    if (a === undefined || (side[i] !== 0 && side[i] !== 1)) continue;
    out.push({ t: ts[i], side: side[i] === 0 ? "bid" : "ask", price: price[i], size: a === "remove" ? 0 : vol[i], rawSize: vol[i], act: a, rank: depth[i] });
  }
  return out;
}

/** One-minute OHLCV columns; `t` is the minute's open (UTC ms). */
export interface MinuteBars {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

/**
 * Raw one-minute bars from trades, as live bars are built: UTC minute open,
 * half-open minutes [t, t + 1 min), OHLC from trade prices in the data's
 * order, volume = the sum of trade sizes. Only minutes with trades get a bar.
 */
export function minuteBars(trades: TradeEvent[]): MinuteBars {
  const b: MinuteBars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let cur = -1;
  for (const tr of trades) {
    const m = Math.floor(tr.t / 60e6) * 60000;
    if (m !== b.t[cur]) {
      if (cur >= 0 && m < b.t[cur]) throw new Error(`trades out of time order at ${new Date(tr.t / 1000).toISOString()}`);
      cur++;
      b.t.push(m);
      b.o.push(tr.price);
      b.h.push(tr.price);
      b.l.push(tr.price);
      b.c.push(tr.price);
      b.v.push(tr.size);
    } else {
      if (tr.price > b.h[cur]) b.h[cur] = tr.price;
      if (tr.price < b.l[cur]) b.l[cur] = tr.price;
      b.c[cur] = tr.price;
      b.v[cur] += tr.size;
    }
  }
  return b;
}

/**
 * Event index of one row group: for each minute with rows, [minute open (UTC
 * ms), first row of that minute (relative to the group)], so a minute range's
 * rows can be read without decoding the whole day. Rows are time-sorted.
 */
export function minuteIndex(ts: Float64Array): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let last = NaN;
  for (let i = 0; i < ts.length; i++) {
    const m = Math.floor(ts[i] / 60e6) * 60000;
    if (m !== last) {
      out.push([m, i]);
      last = m;
    }
  }
  return out;
}
