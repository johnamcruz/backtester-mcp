/**
 * projectx-mcp's golden order-flow vectors (test/vectors/projectx/*.json, schema
 * `projectx-orderflow-vector/1`, its docs/ORDER-FLOW-DESIGN.md "Golden vectors")
 * run through this repo's order-flow computation.
 *
 * The converter turns the vectors' market-hub pushes (GatewayTrade, GatewayDepth,
 * GatewayQuote in the hub's own payload form, on a receive clock) into this
 * repo's normalized events (events.ts), as the design doc says to:
 * - trades: exchange time (ms, as live parses it), the side from the vector's
 *   type flag (0 buy, 1 sell, else none), an unusable timestamp placed at the
 *   receive time and marked, as live does;
 * - depth: each message applied to a price-keyed book with live's DomType rules
 *   (a port of projectx-mcp's Book) at its receive time, giving the L2 level
 *   changes, a reset for a Reset item, and one L1 state per message once the
 *   book is valid (the best levels, as live's L1 history);
 * - quotes (GatewayQuote): not converted; live uses them only for its trade-feed
 *   cross-check and its L1 fallback, neither of which history has;
 * - a disconnect: a reset; the coverage facts (what history knows as data
 *   present): from a trade subscription to the last hub message before a
 *   disconnect.
 *
 * Each call step then runs the engine (flowengine.ts) over the events received by
 * then, in time order, up to the call's time, and assembles the tool's result
 * the way projectx-mcp's flowtools.ts does from this repo's orderflow.ts and
 * flowtools.ts. A minute is covered when the subscription was up from before
 * its start through its end, and it ended by the call.
 */
import { FlowEngine } from "../src/flowengine.js";
import { MINUTE_MS, cumulativeDeltas, footprintBar, minuteOf, newBucket, recordOf, rowOf, type MinuteRecord } from "../src/orderflow.js";
import { flowBars, flowRange, flowSourceContract, spanMinutes } from "../src/flowtools.js";
import { tradingDayStart } from "../src/risk.js";

export const VECTOR_SCHEMA = "projectx-orderflow-vector/1";

export type Step =
  | { at: number; hub: "trade" | "depth" | "quote"; contractId: string; payload: unknown }
  | { at: number; hub: "down" }
  | { at: number; hub: "resubscribed"; kind: string; contractId: string }
  | { at: number; tick: true }
  | { at: number; restBars: Array<Record<string, unknown> & { t: string }> }
  | { at: number; call: { tool: string; args: Record<string, any> }; expect?: any };

export interface Vector {
  schema: string;
  name: string;
  description: string;
  env: Record<string, string>;
  tickSize: number | null;
  steps: Step[];
}

/** Live ids (CON.F.US.ENQ.Z26) <-> this repo's (BT.NQ.Z26): ProjectX names NQ "ENQ" and ES "EP". */
const LIVE_ROOT: Record<string, string> = { ENQ: "NQ", EP: "ES" };
export const toBt = (id: string) => {
  const p = id.split(".");
  return `BT.${LIVE_ROOT[p[3]] ?? p[3]}.${p[4]}`;
};
export const toLive = (id: string) => {
  const p = id.split(".");
  const root = Object.entries(LIVE_ROOT).find(([, r]) => r === p[1])?.[0] ?? p[1];
  return `CON.F.US.${root}.${p[2]}`;
};

// ── live parsing and book rules (projectx-mcp src/orderflow.ts) ──────────

const DOM = { Ask: 1, Bid: 2, BestAsk: 3, BestBid: 4, Reset: 6, NewBestBid: 9, NewBestAsk: 10 };
const ASK = new Set([DOM.Ask, DOM.BestAsk, DOM.NewBestAsk]);
const BID = new Set([DOM.Bid, DOM.BestBid, DOM.NewBestBid]);
const BEST = new Set([DOM.BestAsk, DOM.NewBestAsk, DOM.BestBid, DOM.NewBestBid]);
const HAS_OFFSET = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;
const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const asList = (p: unknown): unknown[] => (Array.isArray(p) ? p : [p]);

/** orderflow.ts#parseTimestamp: an ISO time with an offset or epoch ms, within 60 s of the receive time. */
function parseTimestamp(value: unknown, receivedAt: number): { t: number; bad: boolean } {
  const t = typeof value === "number" ? value : typeof value === "string" && HAS_OFFSET.test(value.trim()) ? Date.parse(value) : NaN;
  if (!Number.isFinite(t) || Math.abs(t - receivedAt) > 60_000) return { t: receivedAt, bad: true };
  return { t, bad: false };
}

/** orderflow.ts#Book, reduced to what the conversion needs: the level changes, validity and the best levels. */
class LiveBook {
  bids = new Map<number, number>();
  asks = new Map<number, number>();
  seenBid = false;
  seenAsk = false;
  get valid() {
    return this.seenBid && this.seenAsk;
  }
  clear() {
    this.bids.clear();
    this.asks.clear();
    this.seenBid = this.seenAsk = false;
  }
  /** Applies one item; returns the levels it changed. */
  apply(type: number, price: number, volume: number): Array<{ side: "bid" | "ask"; price: number; size: number }> {
    const isAsk = ASK.has(type);
    if (!isAsk && !BID.has(type)) return [];
    const side = isAsk ? this.asks : this.bids;
    const name = isAsk ? "ask" : "bid";
    const out: Array<{ side: "bid" | "ask"; price: number; size: number }> = [];
    const set = (p: number, size: number) => {
      const prev = side.get(p) ?? 0;
      if (size === 0) side.delete(p);
      else side.set(p, size);
      if (prev !== size) out.push({ side: name, price: p, size });
    };
    if (BEST.has(type) && volume > 0) for (const p of [...side.keys()]) if (isAsk ? p < price : p > price) set(p, 0);
    set(price, volume);
    if (volume > 0) {
      if (isAsk) this.seenAsk = true;
      else this.seenBid = true;
    }
    return out;
  }
  best(which: "bid" | "ask") {
    const side = which === "bid" ? this.bids : this.asks;
    let best: { price: number; size: number } | null = null;
    for (const [price, size] of side) if (!best || (which === "bid" ? price > best.price : price < best.price)) best = { price, size };
    return best;
  }
}

// ── conversion ───────────────────────────────────────────────────────────

/** A normalized event (t in µs) and when it was received (ms). */
type Ev =
  | { k: "trade"; t: number; price: number; size: number; side: "buy" | "sell" | null; bad: boolean }
  | { k: "quote"; t: number; bid: number | null; bidSize: number | null; ask: number | null; askSize: number | null }
  | { k: "level"; t: number; side: "bid" | "ask"; price: number; size: number }
  | { k: "reset"; t: number }
  /** Live integrates the book imbalance at each depth message and maintenance pass: the same split points. */
  | { k: "advance"; t: number };

interface Feed {
  events: Array<{ at: number; ev: Ev }>;
  intervals: Array<{ from: number; to: number | null }>;
  lastMsg: number | null;
  book: LiveBook;
}

/** What a conversion did that history can't (counted, for the test to list). */
export interface ConversionNotes {
  quotesNotConverted: number;
}

/** Replays a vector through the converter and this repo's computation; returns every call's result, in order. */
export function runVector(v: Vector): { results: unknown[]; notes: ConversionNotes } {
  if (v.schema !== VECTOR_SCHEMA) throw new Error(`unknown vector schema ${String(v.schema)}`);
  const feeds = new Map<string, Feed>();
  const notes: ConversionNotes = { quotesNotConverted: 0 };
  const largeDefault = Number(v.env.PROJECTX_FLOW_LARGE_PRINT ?? 10);
  let restBars: Array<Record<string, unknown> & { t: string }> = [];
  const results: unknown[] = [];
  const subscribe = (id: string, at: number) => {
    if (!feeds.has(id)) feeds.set(id, { events: [], intervals: [{ from: at, to: null }], lastMsg: null, book: new LiveBook() });
    return feeds.get(id) as Feed;
  };
  for (const step of v.steps) {
    const at = step.at;
    if ("call" in step) results.push(callTool(step.call.tool, step.call.args, at));
    else if ("restBars" in step) restBars = step.restBars;
    else if ("tick" in step) for (const f of feeds.values()) f.events.push({ at, ev: { k: "advance", t: at * 1000 } });
    else if (step.hub === "down") {
      for (const f of feeds.values()) {
        const last = f.intervals.at(-1);
        if (last && last.to === null) last.to = Math.max(last.from, Math.min(at, f.lastMsg ?? last.from));
        f.book.clear();
        f.events.push({ at, ev: { k: "reset", t: at * 1000 } });
      }
    } else if (step.hub === "resubscribed") {
      const f = feeds.get(step.contractId);
      const last = f?.intervals.at(-1);
      if (f && step.kind === "trades" && last && last.to !== null) f.intervals.push({ from: at, to: null });
    } else {
      // Pushes for a contract before its first tool call are ignored, as live.
      const f = feeds.get(step.contractId);
      if (!f) continue;
      f.lastMsg = at;
      if (step.hub === "quote") notes.quotesNotConverted++;
      else if (step.hub === "trade") {
        for (const raw of asList(step.payload)) {
          if (!isObj(raw) || !finite(raw.price) || !finite(raw.volume) || raw.volume <= 0 || raw.price <= 0) continue;
          const ts = parseTimestamp(raw.timestamp, at);
          const side = raw.type === 0 ? "buy" : raw.type === 1 ? "sell" : null;
          f.events.push({ at, ev: { k: "trade", t: ts.t * 1000, price: raw.price, size: raw.volume, side, bad: ts.bad } });
        }
      } else {
        const items = asList(step.payload).filter((r): r is Record<string, any> => isObj(r) && finite(r.type) && (r.type === DOM.Reset || (finite(r.price) && finite(r.volume) && r.volume >= 0)));
        if (!items.length) continue;
        f.events.push({ at, ev: { k: "advance", t: at * 1000 } });
        for (const r of items) {
          if (r.type === DOM.Reset) {
            f.book.clear();
            f.events.push({ at, ev: { k: "reset", t: at * 1000 } });
            continue;
          }
          for (const c of f.book.apply(r.type, r.price, r.volume)) f.events.push({ at, ev: { k: "level", t: at * 1000, ...c } });
        }
        if (f.book.valid) {
          const b = f.book.best("bid");
          const a = f.book.best("ask");
          f.events.push({ at, ev: { k: "quote", t: at * 1000, bid: b?.price ?? null, bidSize: b?.size ?? null, ask: a?.price ?? null, askSize: a?.size ?? null } });
        }
      }
    }
  }
  return { results, notes };

  /** The minute records of a feed at `now`, for minutes [from, to] since it subscribed. */
  function records(id: string, from: number, to: number, now: number): Map<number, MinuteRecord> {
    const f = feeds.get(id) as Feed;
    const engine = new FlowEngine({ tick: v.tickSize ?? 0.25 });
    const evs = f.events.filter((e) => e.at <= now && e.ev.t <= now * 1000).map((e, i) => ({ ...e, i }));
    evs.sort((a, b) => a.ev.t - b.ev.t || a.i - b.i);
    for (const { ev } of evs) {
      if (ev.k === "trade") engine.trade(ev.t, ev.price, ev.size, ev.side, ev.bad);
      else if (ev.k === "quote") engine.quoteState(ev.t, ev);
      else if (ev.k === "level") engine.level(ev.t, ev.side, ev.price, ev.size);
      else if (ev.k === "reset") engine.reset(ev.t);
      else engine.advance(ev.t);
    }
    engine.advance(now * 1000);
    const covered = (m: number) => m + MINUTE_MS <= now && f.intervals.some((iv) => iv.from < m && (iv.to === null || iv.to >= m + MINUTE_MS));
    const out = new Map<number, MinuteRecord>();
    for (let m = Math.max(minuteOf(from), minuteOf(f.intervals[0].from)); m <= to; m += MINUTE_MS) out.set(m, recordOf(engine.buckets.get(m) ?? newBucket(m), covered(m)));
    return out;
  }

  function callTool(tool: string, a: Record<string, any>, now: number): unknown {
    if (tool === "get_order_flow") {
      subscribe(a.contractId, now);
      const cur = minuteOf(now);
      const minutes = a.minutes ?? 30;
      const from = cur - (minutes - 1) * MINUTE_MS;
      const sessionFrom = Math.min(from, tradingDayStart(new Date(from)).getTime());
      const byMinute = records(a.contractId, from, cur, now);
      const all = new Map([...records(a.contractId, sessionFrom, from - MINUTE_MS, now), ...byMinute]);
      const cum = cumulativeDeltas(all, sessionFrom, cur);
      const lp = a.largePrint ?? largeDefault;
      const rows = [...byMinute.values()].sort((x, y) => x.t - y.t).map((r) => rowOf(r, lp, cum.get(r.t) ?? null));
      const lastComplete = [...rows].reverse().find((r) => r.complete);
      const value = lastComplete?.cumDelta ?? null;
      return {
        contractId: a.contractId,
        largePrint: lp,
        rows,
        cumulativeDelta: {
          value,
          asOf: lastComplete?.t ?? null,
          sessionStart: tradingDayStart(new Date(now)).toISOString(),
          ...(value === null ? { note: "Unknown: not every minute since the session start (17:00 CT) is complete in live or recorded data." } : {}),
        },
      };
    }
    if (tool === "get_footprint") {
      subscribe(a.contractId, now);
      const barMs = a.barMinutes * MINUTE_MS;
      const cur = minuteOf(now);
      const lastBar = Math.floor(cur / barMs) * barMs;
      const firstBar = lastBar - (a.bars - 1) * barMs;
      const byMinute = records(a.contractId, firstBar, cur, now);
      const bars = [];
      for (let b = firstBar; b <= lastBar; b += barMs) {
        const ms = Array.from({ length: a.barMinutes }, (_, k) => byMinute.get(b + k * MINUTE_MS));
        if (ms.every((r) => !r)) continue;
        bars.push(footprintBar(b, a.barMinutes, ms, v.tickSize, a.imbalanceRatio));
      }
      return { contractId: a.contractId, barMinutes: a.barMinutes, tickSize: v.tickSize, imbalanceRatio: a.imbalanceRatio, bars };
    }
    if (tool === "get_bars") {
      const source = toLive(flowSourceContract(toBt(a.contractId)));
      subscribe(source, now);
      const bars = [...restBars].sort((x, y) => Date.parse(x.t) - Date.parse(y.t));
      const windows = [...new Set<number>(a.flowWindows ?? [])].sort((x, y) => x - y);
      const minutes = spanMinutes(a.unit, a.unitNumber) as number;
      const range = flowRange(bars, minutes, windows) as { from: number; to: number };
      const byMinute = records(source, range.from, range.to, now);
      return {
        contractId: a.contractId,
        barSize: `${a.unitNumber} ${a.unit}`,
        count: bars.length,
        bars: flowBars(byMinute, bars, minutes, windows, largeDefault),
        orderFlow: { sourceContractId: source, largePrint: largeDefault, windows },
      };
    }
    // get_trades, get_market_depth, get_top_of_book: views of the live feed this server doesn't have.
    subscribe(a.contractId, now);
    return { tool, notServed: true };
  }
}

export const expectedResults = (v: Vector) => v.steps.filter((s): s is Extract<Step, { call: unknown }> => "call" in s).map((s) => s.expect);
