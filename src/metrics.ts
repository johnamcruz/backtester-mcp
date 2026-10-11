/**
 * Trade metrics: round trips built from one contract's fills and the 1-minute
 * bars they were held through. Pure: no I/O, no clock; the caller passes the
 * fills (in the order the exchange recorded them), the orders they came from,
 * the contract's bars, and the cutoff (the replay clock capped at
 * BACKTESTER_END). Nothing after the cutoff is read.
 *
 * A round trip is a position episode: it opens with the fill that takes the
 * contract's net position away from flat (or the part of a fill beyond flat
 * when it reverses the position), includes every add and partial exit, and
 * ends with the fill that returns the position to flat or reverses it. The
 * reversing fill ends one round trip and opens the next.
 *
 * The harness backtester (futures-trading-harness scripts/lib/backtest/
 * sim-broker.js#onBar and engine.js#closeTrade) holds one position of a fixed
 * size per trade; for such a trade these definitions reduce to its fields:
 *   - r = sign x (exit - entry) / risk, risk = |entry - initial stop| (here
 *     gross P&L / initial risk in dollars, the same ratio);
 *   - mfeR / maeR start at 0 and follow each bar's favourable / adverse
 *     extreme from the entry, the adverse side capped at the stop fill on the
 *     bar the stop fills (sim-broker.js#onBar: `worst = stopFill`);
 *   - barsHeld counts the bars the trade survived, from its fill bar on.
 * Difference: on the bar of an exit inside the bar (a stop or a target
 * filling), the harness also counts that bar's whole high/low (its peakR uses
 * bar.h on the stop's bar, its troughR bar.l on the target's bar). The order
 * of the high, the low and the fill inside that bar is unknown, so here that
 * bar contributes only its open (when the position was held through it) and
 * the fill price. MFE here is never above the harness's mfeR; MAE matches on
 * stop exits.
 *
 * Excursions. The round trip's running P&L at a price x is
 *   G(x) = realized so far + sign x (x - average entry) x tickValue / tickSize x open size
 * (gross, before fees). MFE is the largest G and MAE the smallest, both
 * starting at 0 at the entry, sampled at:
 *   - every fill of the round trip, at its price (with the position before it);
 *   - the high and the low of each closed 1-minute bar the position was held
 *     through whole: open from the bar's open (after any fill at that open)
 *     with no fill on the contract inside the bar;
 *   - the open of a bar with a fill inside it, when the position was held
 *     into that bar (not entered at its open).
 * A fill at a bar's open (market orders, closes) happens before the bar's
 * range; a stop or limit fill happens inside the bar (stamped at its close);
 * a fill on arrival (marketFill "now": stamped at the replay moment it was
 * placed) is at that bar's open when the moment is one, else inside the bar
 * containing the moment (whether that bar's high or low came before it is
 * unknown); an end-of-window fill at the last close comes after every bar.
 * MAE/MFE dollars are G; R is G / initial risk in dollars; points and ticks
 * are G per contract open at that moment (with no partial exit before it,
 * exactly the price's distance from the average entry). The time is the
 * bar's open time (as get_bars labels it) or the fill's time.
 *
 * Initial stop: the stop-loss bracket leg of the opening order, priced from
 * the opening fill (sim-broker.js#fillAtOpen: the stop keeps the order's
 * distance from the fill); else, among the client stops and trailing stops on
 * the closing side still working after the opening fill (not filled or
 * cancelled at or before it) and placed before it or within the minute after
 * it (before the first bar of the trade closed and before the trade ended),
 * at their price when they started protecting the trade and on the losing
 * side of the entry, the closest to the entry.
 * Exit reason "trail" (sim-broker.js#onBar: stop !== initialStop) is a
 * trailing stop, a stop whose price was modified during the trade, or a
 * client stop placed after the trade's first minute away from the initial
 * stop once the client cancelled or moved the initial stop's order before
 * the exit (a cancel-and-replace move; the engine's OCO and flat cancels don't
 * count). Other stops (scale-out stops, an add's stop)
 * read "stop". Initial risk = |entry - stop| /
 * tickSize x tickValue x opening size. No such stop: R fields are null.
 */

import type { BarSeries } from "./bars.js";
import { ORDER_TYPES } from "./enums.js";
import { MINUTE, STATUS, bracketPrice, containingBar, isLimitType, isStopType, sideSign, type BracketSpec, type Side } from "./fills.js";
import type { Trade } from "./performance.js";

export interface MetricOrder {
  id: number;
  side: Side;
  type: number;
  role: "order" | "sl" | "tp" | "close";
  stopPrice: number | null;
  stopLossBracket: BracketSpec | null;
  /** Bracket legs: the order whose fill created them. */
  parentId?: number | null;
  placedAt: number;
  updatedAt: number;
  status: number;
  /**
   * [time, stop price, seq] each time a stop was placed or modified (ratchets of a trailing stop not
   * included). seq is the id the next fill would get then: a price with seq <= a fill's id was set
   * before that fill, even at the same instant. Missing in runs from earlier versions.
   */
  stopAt?: Array<[number, number, number?]>;
  /** The id the next fill would get when the client cancelled it (same ordering as stopAt's seq). */
  cancelSeq?: number;
  /** Filled at the last close after BACKTESTER_END. */
  endOfWindow?: boolean;
  /** Filled on arrival at the replay moment it was placed (marketFill "now"), stamped at that moment. */
  arrival?: boolean;
}

export interface TickSpec {
  tickSize: number;
  tickValue: number;
}

export type ExitReason = "stop" | "trail" | "target" | "close" | "end" | "other";

export interface RoundTrip {
  /** The id of the round trip's opening fill (search_trades `id`). */
  id: number;
  contractId: string;
  direction: "long" | "short";
  /** Still open (list_open_positions): exit fields are null and P&L is what is realized so far. */
  open: boolean;
  entryTime: string;
  /** Price and size of the opening fill (the part beyond flat for a reversal). */
  entryPrice: number;
  entrySize: number;
  /** Size-weighted average price of every opening and adding fill. */
  averageEntryPrice: number;
  /** Largest open size during the round trip. */
  maxSize: number;
  /** Contracts closed so far (all of them once the round trip is over). */
  closedSize: number;
  exitTime: string | null;
  /** Size-weighted average price of the closing fills. */
  exitPrice: number | null;
  /** Id of the fill that ended the round trip. */
  exitFillId: number | null;
  reason: ExitReason | null;
  /** Fills that reduced the position without ending the round trip. */
  partialExits: number;
  /** Ended by a fill that went through flat (it also opened the next round trip). */
  reversed: boolean;
  initialStop: number | null;
  /** |entryPrice - initialStop| in price (the harness's `risk`). */
  risk: number | null;
  /** The initial risk in dollars: risk / tickSize x tickValue x entrySize. */
  riskDollars: number | null;
  maePoints: number;
  maeTicks: number;
  maeDollars: number;
  maeR: number | null;
  maeTime: string;
  mfePoints: number;
  mfeTicks: number;
  mfeDollars: number;
  mfeR: number | null;
  mfeTime: string;
  barsHeld: number;
  gross: number;
  fees: number;
  net: number;
  /** gross / riskDollars (the harness's `r`); rNet uses net. */
  r: number | null;
  rNet: number | null;
}

export interface FillInfo {
  roundTripId: number;
  /** On a fill that reduced the position: "partial" when the round trip goes on, else its exit reason. */
  exitReason?: ExitReason | "partial";
}

export interface RoundTripResult {
  closed: RoundTrip[];
  open: RoundTrip | null;
  fills: Map<number, FillInfo>;
}

interface Sample {
  g: number;
  time: number;
  open: number;
}

interface Episode {
  id: number;
  sign: 1 | -1;
  entrySide: Side;
  entryOrder: MetricOrder | undefined;
  entryTime: number;
  entryPrice: number;
  entrySize: number;
  open: number;
  avg: number;
  entryNotional: number;
  entered: number;
  maxSize: number;
  realized: number;
  fees: number;
  closedSize: number;
  exitNotional: number;
  exits: Array<{ fillId: number; order: MetricOrder | undefined }>;
  endTime: number | null;
  reversed: boolean;
  mae: Sample;
  mfe: Sample;
  barsHeld: number;
}

const iso = (ms: number) => new Date(ms).toISOString();
const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
const r9 = (x: number) => Math.round(x * 1e9) / 1e9 + 0;
const r2 = (x: number) => Math.round(x * 100) / 100 + 0;
const r3 = (x: number) => Math.round(x * 1000) / 1000 + 0;

/**
 * The stop price an order had when it began protecting the trade opened by fill `entryId` at
 * `entryTime`: its last price set before that fill (by seq; without one, recorded before
 * `entryTime`), else its first recorded price (placed after the fill), else its current price.
 */
function stopPriceAt(o: MetricOrder, entryId: number, entryTime: number): number | null {
  const h = o.stopAt ?? [];
  let price: number | null = null;
  for (const [t, p, seq] of h) if (seq !== undefined ? seq <= entryId : t < entryTime) price = p;
  return price ?? h[0]?.[1] ?? o.stopPrice;
}

/**
 * Round trips of one contract. `fills` are the contract's fills in recorded order; `orders` are
 * the contract's orders (any order); `bars` the contract's 1-minute bars (null without data).
 */
export function roundTrips(contractId: string, fills: Trade[], orders: MetricOrder[], bars: BarSeries | null, spec: TickSpec, cutoff: number): RoundTripResult {
  const byId = new Map(orders.map((o) => [o.id, o]));
  const sorted = [...orders].sort((a, b) => a.id - b.id);
  const closed: RoundTrip[] = [];
  const info = new Map<number, FillInfo>();
  let ep: Episode | null = null;
  let bi = 0; // first bar whose range is not yet accounted for
  let dirty: { bar: number; ep: Episode | null } | null = null; // the bar of the last fill inside a bar
  let openFillBar = -Infinity; // the last bar with a fill at its open

  const sample = (x: number, time: number) => {
    if (!ep) return;
    const ticks = r6((ep.sign * (x - ep.avg)) / spec.tickSize);
    const g = ep.realized + ticks * spec.tickValue * ep.open;
    if (g < ep.mae.g) ep.mae = { g, time, open: ep.open };
    if (g > ep.mfe.g) ep.mfe = { g, time, open: ep.open };
  };
  // Bars with t < limit: held whole by the open round trip (if any).
  const clean = (limit: number) => {
    if (!bars) return;
    const end = bars.lowerBound(limit);
    if (ep) {
      for (; bi < end; bi++) {
        sample(bars.h[bi], bars.t[bi]);
        sample(bars.l[bi], bars.t[bi]);
        ep.barsHeld++;
      }
    }
    bi = Math.max(bi, end);
  };
  // A bar with fills inside it counts as held when the same round trip was open at its open and still is at its close
  // (once it has closed: a fill on arrival can sit inside the bar in progress at the cutoff).
  const resolveDirty = () => {
    if (dirty && dirty.ep && dirty.ep === ep && dirty.bar + MINUTE <= cutoff) ep.barsHeld++;
    dirty = null;
  };

  const fillOf = new Map<number, number>(); // order id -> its first fill's id
  for (const f of fills) if (!fillOf.has(f.orderId)) fillOf.set(f.orderId, f.id);
  // Whether an order stopped working before the fill that opened `e` (fill ids and seqs order events within an instant).
  const endedBefore = (c: MetricOrder, e: Episode): boolean => {
    if (c.status === STATUS.open) return false;
    const filled = fillOf.get(c.id);
    if (filled !== undefined) return filled < e.id;
    if (c.cancelSeq !== undefined) return c.cancelSeq <= e.id;
    return c.updatedAt < e.entryTime || (c.updatedAt === e.entryTime && c.placedAt < e.entryTime);
  };

  /** The initial stop's price and the order that held it (the bracket leg, or the chosen client stop). */
  const initialStop = (e: Episode): { price: number; source: MetricOrder | undefined } | null => {
    const o = e.entryOrder;
    if (o && o.role === "order" && o.stopLossBracket && isStopType(o.stopLossBracket.type)) {
      const price = bracketPrice(e.entryPrice, e.entrySide, o.stopLossBracket.ticks, "sl", spec.tickSize);
      return { price, source: sorted.find((c) => c.role === "sl" && c.parentId === o.id && c.placedAt === e.entryTime) };
    }
    const until = Math.min(e.entryTime + MINUTE, e.endTime ?? Infinity);
    const closingSide: Side = e.sign > 0 ? 1 : 0;
    let best: { price: number; source: MetricOrder } | null = null;
    for (const c of sorted) {
      if (c.role !== "order" || c.side !== closingSide || !isStopType(c.type) || c.id === o?.id) continue;
      if (c.placedAt >= until) continue;
      // Filled or cancelled before the opening fill (an earlier trade's stop): not this trade's.
      if (endedBefore(c, e)) continue;
      const price = stopPriceAt(c, e.id, e.entryTime);
      if (price === null || e.sign * (e.entryPrice - price) <= 0) continue;
      // Several candidates (a leftover far stop, scale-out stops): the closest to the entry protects it.
      if (best === null || e.sign * (price - best.price) > 0) best = { price, source: c };
    }
    return best;
  };

  const reasonOf = (o: MetricOrder | undefined, e: Episode, stop: { price: number; source: MetricOrder | undefined } | null): ExitReason => {
    if (!o) return "other";
    if (o.endOfWindow) return "end";
    const stopLike = o.role === "sl" || (o.role === "order" && isStopType(o.type));
    if (stopLike) {
      const differs = (a: number | null | undefined, b: number | null | undefined) => a != null && b != null && Math.abs(a - b) > 1e-9;
      // Moved with modify_order during the trade: its price when filled differs from its price when the trade began.
      const moved = differs(o.stopPrice, stopPriceAt(o, e.id, e.entryTime));
      // Moved by cancel and replace: the initial stop's order was cancelled or moved before this exit, and this is a
      // client stop placed after the trade's first minute, away from the initial stop.
      // Only the client's own acts count (a cancel or modify recorded before the exit fill); the engine's OCO and
      // flat cancels don't, nor anything after the exit.
      const src = stop?.source;
      const exitFill = e.exits.at(-1)?.fillId ?? Infinity;
      const movedBefore = (x: MetricOrder) => {
        let price: number | undefined;
        for (const [, p, seq] of x.stopAt ?? []) if (seq !== undefined && seq <= exitFill) price = p;
        return differs(price, stop?.price);
      };
      const gone = !!src && src.id !== o.id && ((src.cancelSeq !== undefined && src.cancelSeq <= exitFill) || movedBefore(src));
      const replaced = gone && o.role === "order" && o.placedAt >= e.entryTime + MINUTE && differs(o.stopPrice, stop?.price);
      return o.type === ORDER_TYPES.trailing_stop || moved || replaced ? "trail" : "stop";
    }
    if (o.role === "tp" || isLimitType(o.type)) return "target";
    if (o.role === "close" || o.type === ORDER_TYPES.market) return "close";
    return "other";
  };

  const finalize = (e: Episode): RoundTrip => {
    const initial = initialStop(e);
    const stop = initial?.price ?? null;
    const riskTicks = stop === null ? null : r6(Math.abs(e.entryPrice - stop) / spec.tickSize);
    const riskRaw = riskTicks === null ? null : riskTicks * spec.tickValue * e.entrySize;
    const R = (g: number) => (riskRaw ? r3(g / riskRaw) : null);
    const over = e.endTime !== null;
    const last = e.exits.at(-1);
    const reason = over && last ? reasonOf(last.order, e, initial) : null;
    if (over && last) info.set(last.fillId, { roundTripId: e.id, exitReason: reason as ExitReason });
    const ex = (s: Sample) => {
      const ticks = r6(s.g / (spec.tickValue * s.open));
      return { points: r9(ticks * spec.tickSize), ticks, dollars: r2(s.g), r: R(s.g), time: iso(s.time) };
    };
    const mae = ex(e.mae);
    const mfe = ex(e.mfe);
    const gross = r2(e.realized);
    const fees = r2(e.fees);
    return {
      id: e.id,
      contractId,
      direction: e.sign > 0 ? "long" : "short",
      open: !over,
      entryTime: iso(e.entryTime),
      entryPrice: e.entryPrice,
      entrySize: e.entrySize,
      averageEntryPrice: r9(e.entryNotional / e.entered),
      maxSize: e.maxSize,
      closedSize: e.closedSize,
      exitTime: over ? iso(e.endTime as number) : null,
      exitPrice: over ? r9(e.exitNotional / e.closedSize) : null,
      exitFillId: over && last ? last.fillId : null,
      reason,
      partialExits: e.exits.length - (over ? 1 : 0),
      reversed: e.reversed,
      initialStop: stop,
      risk: riskTicks === null ? null : r9(riskTicks * spec.tickSize),
      riskDollars: riskRaw === null ? null : r2(riskRaw),
      maePoints: mae.points,
      maeTicks: mae.ticks,
      maeDollars: mae.dollars,
      maeR: mae.r,
      maeTime: mae.time,
      mfePoints: mfe.points,
      mfeTicks: mfe.ticks,
      mfeDollars: mfe.dollars,
      mfeR: mfe.r,
      mfeTime: mfe.time,
      barsHeld: e.barsHeld,
      gross,
      fees,
      net: r2(gross - fees),
      r: over ? R(e.realized) : null,
      rNet: over ? R(e.realized - e.fees) : null,
    };
  };

  for (const f of fills) {
    if (f.voided) continue;
    const o = byId.get(f.orderId);
    const time = Date.parse(f.creationTimestamp);
    // Where the fill sits among the bars: at a bar's open (market), inside a bar (stamped at its close), or after the window.
    // A fill on arrival is at its moment: a bar's open when the moment is one, else inside the bar containing it.
    const at = o?.arrival && bars ? containingBar(bars.t, bars.length, time) : -1;
    const arrivalInside = at >= 0 && (bars as BarSeries).t[at] !== time;
    const phase = o?.endOfWindow ? "end" : arrivalInside ? "inside" : !o || o.arrival || o.type === ORDER_TYPES.market ? "open" : "inside";
    const bar = arrivalInside ? (bars as BarSeries).t[at] : phase === "inside" ? time - MINUTE : time;
    if (dirty && !(phase === "inside" && dirty.bar === bar)) resolveDirty();
    if (phase === "open") {
      clean(bar);
      openFillBar = bar;
    } else if (phase === "end") {
      clean(time - MINUTE + 1);
    } else if (!dirty) {
      clean(bar);
      if (bars && bi < bars.length && bars.t[bi] === bar) {
        if (ep && openFillBar !== bar) sample(bars.o[bi], bar);
        bi++;
      }
      dirty = { bar, ep };
    }

    const sign = sideSign(f.side as Side);
    let size = f.size;
    if (ep && ep.sign !== sign) {
      sample(f.price, time);
      const closing = Math.min(size, ep.open);
      ep.realized += f.profitAndLoss ?? 0;
      ep.fees += ((f.fees ?? 0) * closing) / f.size;
      ep.exitNotional += f.price * closing;
      ep.closedSize += closing;
      ep.open -= closing;
      ep.exits.push({ fillId: f.id, order: o });
      size -= closing;
      if (ep.open === 0) {
        ep.endTime = time;
        ep.reversed = size > 0;
        closed.push(finalize(ep));
        ep = null;
      } else {
        info.set(f.id, { roundTripId: ep.id, exitReason: "partial" });
      }
      if (size === 0) continue;
    }
    const fees = ((f.fees ?? 0) * size) / f.size;
    if (!ep) {
      const start: Sample = { g: 0, time, open: size };
      ep = {
        id: f.id, sign: sign as 1 | -1, entrySide: f.side as Side, entryOrder: o, entryTime: time, entryPrice: f.price, entrySize: size,
        open: size, avg: f.price, entryNotional: f.price * size, entered: size, maxSize: size, realized: 0, fees, closedSize: 0,
        exitNotional: 0, exits: [], endTime: null, reversed: false, mae: start, mfe: { ...start }, barsHeld: 0,
      };
      if (!info.has(f.id)) info.set(f.id, { roundTripId: f.id });
    } else {
      sample(f.price, time);
      // As the fill engine averages an add (fills.ts#applyFill).
      ep.avg = (ep.avg * ep.open + f.price * size) / (ep.open + size);
      ep.open += size;
      ep.entryNotional += f.price * size;
      ep.entered += size;
      ep.maxSize = Math.max(ep.maxSize, ep.open);
      ep.fees += fees;
      info.set(f.id, { roundTripId: ep.id });
    }
  }
  resolveDirty();
  // The open round trip so far: closed bars only.
  if (ep) clean(cutoff - MINUTE + 1);
  return { closed, open: ep ? finalize(ep) : null, fills: info };
}
