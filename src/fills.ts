/**
 * The fill engine: pure functions over one contract's book (its orders and
 * net position) and one 1-minute bar at a time. No I/O and no clock: the
 * exchange (client.ts) feeds it bars in time order.
 *
 * Ported from the futures-trading-harness simulated broker,
 * scripts/lib/backtest/sim-broker.js (`createSimBroker`; harness branch
 * feat/sim-broker, PR #23, extracted from scripts/lib/backtest/engine.js),
 * cited by function as sim-broker.js#<function>, so a replay through this
 * server fills the way a backtest does:
 *
 *   - market orders fill at the next 1-minute bar's open plus slippage
 *     (sim-broker.js#fillAtOpen), in the order's direction;
 *   - stops fill at the stop price less slippage, or at the bar's open when
 *     the bar gapped through it (sim-broker.js#onBar);
 *   - limits (targets) fill at the limit price, or at a better open
 *     (sim-broker.js#onBar), without slippage;
 *   - a bar that touches both a stop and a limit fills the stop first
 *     (sim-broker.js#onBar: "a bar reaching both stop and target is a loss");
 *   - bracket legs sit a number of ticks from the entry's fill price,
 *     slippage included (sim-broker.js#fillAtOpen: the stop keeps the order's
 *     distance from the fill), and are checked on the fill bar itself;
 *   - P&L is ticks x tick value x size, ticks rounded to 1e-6, fees per side
 *     per contract (sim-broker.js#exit charges both sides at the close; here
 *     each fill carries its own side);
 *   - prices on the tick grid without float noise (sim-broker.js#onTick).
 *
 * Trailing (scripts/lib/trading/trail.js) is not ported: the harness runner
 * trails its stops with modify_order. A broker-side `trailing_stop` order is
 * supported as a simple ratchet (see trailStep).
 */

import { ORDER_TYPES } from "./enums.js";

export const MINUTE = 60000;
export const STATUS = { open: 1, filled: 2, cancelled: 3, rejected: 5 } as const;

export type Side = 0 | 1; // 0 buy, 1 sell (interface enum)

export interface BracketSpec {
  ticks: number;
  /** Order type code of the leg (4 stop, 1 limit, 5 trailing stop). */
  type: number;
}

export interface SimOrder {
  id: number;
  side: Side;
  type: number;
  size: number;
  limitPrice: number | null;
  stopPrice: number | null;
  /** Trailing stops: the trail distance in price (search_orders shows it as trailPrice). */
  trailDistance: number | null;
  status: number;
  /** When it was placed (ms). Market orders fill at the open of the first bar starting at or after it. */
  placedAt: number;
  /** First bar (by open time) the order is checked against. */
  activeFrom: number;
  updatedAt: number;
  /**
   * "order" is any order the client placed; "sl"/"tp" are bracket legs of
   * `parentId`; "close" is a close_position/partial_close_position market
   * order. Legs and closes only reduce the position.
   */
  role: "order" | "sl" | "tp" | "close";
  parentId: number | null;
  stopLossBracket: BracketSpec | null;
  takeProfitBracket: BracketSpec | null;
  fillVolume: number;
  filledPrice: number | null;
  customTag: string | null;
  /** close_position: flattens whatever the position is when it fills (side and size set then). */
  flatten?: boolean;
  /** Why the broker rejected it at fill time (status rejected). */
  rejectReason?: string | null;
}

export interface SimPosition {
  id: number | null;
  /** Signed net size: +long, -short. */
  net: number;
  averagePrice: number;
  openedAt: number | null;
}

export interface SimFill {
  orderId: number;
  side: Side;
  size: number;
  price: number;
  time: number;
  /** Realized P&L of the part that closed; null when the fill only opened or added. */
  profitAndLoss: number | null;
  fees: number;
}

export interface Book {
  orders: SimOrder[];
  position: SimPosition;
}

export interface FillSpec {
  tickSize: number;
  tickValue: number;
  feePerSide: number;
  slippageTicks: number;
}

/**
 * Server-side limits, enforced at fill time as a real broker does: `guard`
 * is asked before any fill of a client order (never a bracket leg or a close)
 * and returns why it must be rejected, or null; `onFill` sees every fill as
 * it happens (so the guard can count fills made earlier in the same bar).
 */
export interface Hooks {
  guard?(o: SimOrder, size: number, pos: SimPosition, time: number): string | null;
  onFill?(fill: SimFill): void;
  /**
   * Exits first across contracts: when set, openBar/closeBar walk the book in its normal order
   * and stop at the first client order whose fill would open exposure (it and everything after
   * it stay as they are), so the caller can run every contract's leading reducing fills of a
   * moment first, then call again without it to continue each book from there in normal order.
   */
  deferOpening?: boolean;
}

/** The net position after a fill, and whether it opens exposure (grows |net| or goes through flat). */
export function exposureAfter(net: number, side: Side, size: number): { after: number; opens: boolean } {
  const after = net + sideSign(side) * size;
  const crosses = net !== 0 && after !== 0 && Math.sign(after) !== Math.sign(net);
  return { after, opens: Math.abs(after) > Math.abs(net) || crosses };
}

export interface Ids {
  order(): number;
  position(): number;
}

export interface BarOHLC {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

const round2 = (x: number) => Math.round(x * 100) / 100 + 0; // + 0: no -0

/** A price on the tick grid, free of float noise. sim-broker.js#onTick */
export const onTick = (x: number, tick: number) => Math.round(Math.round(x / tick) * tick * 1e9) / 1e9;

export const isOnTick = (x: number, tick: number) => Math.abs(x / tick - Math.round(x / tick)) < 1e-6;

/** +1 for a buy, -1 for a sell. */
export const sideSign = (side: Side) => (side === 0 ? 1 : -1);

export const isStopType = (type: number) => type === ORDER_TYPES.stop || type === ORDER_TYPES.trailing_stop;
export const isLimitType = (type: number) =>
  type === ORDER_TYPES.limit || type === ORDER_TYPES.join_bid || type === ORDER_TYPES.join_ask;

/** Market fill: the bar's open plus slippage in the order's direction. sim-broker.js#fillAtOpen */
export function marketFillPrice(open: number, side: Side, spec: FillSpec): number {
  return onTick(open + sideSign(side) * spec.slippageTicks * spec.tickSize, spec.tickSize);
}

/** A buy stop triggers when the high reaches it; a sell stop when the low does. sim-broker.js#onBar */
export function stopTriggered(bar: BarOHLC, side: Side, stop: number): boolean {
  return side === 0 ? bar.h >= stop : bar.l <= stop;
}

/** Stop fill: the stop, or the open when the bar gapped through it, less slippage. sim-broker.js#onBar */
export function stopFillPrice(bar: BarOHLC, side: Side, stop: number, spec: FillSpec): number {
  const base = side === 0 ? Math.max(bar.o, stop) : Math.min(bar.o, stop);
  return onTick(base + sideSign(side) * spec.slippageTicks * spec.tickSize, spec.tickSize);
}

/** A buy limit fills when the low reaches it; a sell limit when the high does. sim-broker.js#onBar */
export function limitTriggered(bar: BarOHLC, side: Side, limit: number): boolean {
  return side === 0 ? bar.l <= limit : bar.h >= limit;
}

/** Limit fill: the limit, or a better open. No slippage. sim-broker.js#onBar */
export function limitFillPrice(bar: BarOHLC, side: Side, limit: number): number {
  return side === 0 ? Math.min(bar.o, limit) : Math.max(bar.o, limit);
}

export function triggers(o: SimOrder, bar: BarOHLC): boolean {
  if (isStopType(o.type)) return o.stopPrice !== null && stopTriggered(bar, o.side, o.stopPrice);
  if (isLimitType(o.type)) return o.limitPrice !== null && limitTriggered(bar, o.side, o.limitPrice);
  return false;
}

/**
 * Bracket leg prices from the entry fill (slippage included), `ticks` away:
 * the stop loss against the position, the take profit with it. sim-broker.js#fillAtOpen
 */
export function bracketPrice(fill: number, entrySide: Side, ticks: number, leg: "sl" | "tp", tick: number): number {
  const dir = sideSign(entrySide) * (leg === "sl" ? -1 : 1);
  return onTick(fill + dir * Math.abs(ticks) * tick, tick);
}

/** Realized P&L of closing `size` contracts of a position at `price`. sim-broker.js#exit */
export function closePnl(net: number, averagePrice: number, price: number, size: number, spec: FillSpec): number {
  const sign = net > 0 ? 1 : -1;
  const ticks = Math.round(((sign * (price - averagePrice)) / spec.tickSize) * 1e6) / 1e6;
  return round2(ticks * spec.tickValue * size);
}

/** Fees of one fill: per side per contract. sim-broker.js#exit (2 sides x fee x size per round turn) */
export const feesFor = (size: number, spec: FillSpec) => round2(size * spec.feePerSide);

/**
 * Apply a fill to the net position: add (average price), reduce (realize
 * P&L), or reverse through flat. Returns the realized P&L, or null when
 * nothing closed.
 */
export function applyFill(pos: SimPosition, side: Side, size: number, price: number, time: number, spec: FillSpec, ids: Ids): number | null {
  const signed = sideSign(side) * size;
  if (pos.net === 0 || Math.sign(pos.net) === Math.sign(signed)) {
    if (pos.net === 0) Object.assign(pos, { id: ids.position(), openedAt: time, averagePrice: price });
    else pos.averagePrice = (pos.averagePrice * Math.abs(pos.net) + price * size) / (Math.abs(pos.net) + size);
    pos.net += signed;
    return null;
  }
  const closing = Math.min(size, Math.abs(pos.net));
  const pnl = closePnl(pos.net, pos.averagePrice, price, closing, spec);
  const rest = size - closing;
  pos.net += sideSign(side) * closing;
  if (pos.net === 0) Object.assign(pos, { id: null, openedAt: null, averagePrice: 0 });
  if (rest > 0) Object.assign(pos, { id: ids.position(), openedAt: time, averagePrice: price, net: sideSign(side) * rest });
  return pnl;
}

function newLeg(parent: SimOrder, leg: "sl" | "tp", spec: BracketSpec, fill: number, size: number, time: number, tick: number, ids: Ids): SimOrder {
  const price = bracketPrice(fill, parent.side, spec.ticks, leg, tick);
  const stopLike = isStopType(spec.type);
  return {
    id: ids.order(),
    side: parent.side === 0 ? 1 : 0,
    type: spec.type,
    size,
    limitPrice: stopLike ? null : price,
    stopPrice: stopLike ? price : null,
    trailDistance: spec.type === ORDER_TYPES.trailing_stop ? Math.abs(spec.ticks) * tick : null,
    status: STATUS.open,
    placedAt: time,
    activeFrom: time,
    updatedAt: time,
    role: leg,
    parentId: parent.id,
    stopLossBracket: null,
    takeProfitBracket: null,
    fillVolume: 0,
    filledPrice: null,
    customTag: null,
  };
}

const cancel = (o: SimOrder, time: number) => Object.assign(o, { status: STATUS.cancelled, updatedAt: time });

/**
 * Fill an order (whole size; a bracket leg only as far as it reduces the
 * position), then: create the entry's bracket legs, cancel a filled leg's
 * sibling (OCO), and cancel every bracket leg once the position is flat.
 * Returns the fill (null when a leg had nothing left to close) and the legs created.
 */
export function fillOrder(book: Book, o: SimOrder, price: number, time: number, spec: FillSpec, ids: Ids, hooks: Hooks = {}): { fill: SimFill | null; legs: SimOrder[]; deferred?: boolean } {
  const pos = book.position;
  if (o.role === "close" && o.flatten && pos.net !== 0) Object.assign(o, { side: pos.net > 0 ? 1 : 0, size: Math.abs(pos.net) });
  let size = o.size;
  if (o.role === "order") {
    if (hooks.deferOpening && exposureAfter(pos.net, o.side, size).opens) return { fill: null, legs: [], deferred: true };
    const reason = hooks.guard?.(o, size, pos, time) ?? null;
    if (reason) {
      Object.assign(o, { status: STATUS.rejected, updatedAt: time, rejectReason: reason });
      return { fill: null, legs: [] };
    }
  } else {
    // Bracket legs and closes protect or flatten the position; they never open or add to one.
    const reduces = pos.net !== 0 && Math.sign(pos.net) !== sideSign(o.side);
    if (!reduces) {
      cancel(o, time);
      return { fill: null, legs: [] };
    }
    size = Math.min(size, Math.abs(pos.net));
  }
  const before = pos.net;
  const pnl = applyFill(pos, o.side, size, price, time, spec, ids);
  Object.assign(o, { status: STATUS.filled, fillVolume: size, filledPrice: price, updatedAt: time });
  const fill: SimFill = { orderId: o.id, side: o.side, size, price, time, profitAndLoss: pnl, fees: feesFor(size, spec) };
  hooks.onFill?.(fill);
  if (o.role === "sl" || o.role === "tp") {
    for (const s of book.orders) if (s.parentId === o.parentId && s.id !== o.id && s.status === STATUS.open) cancel(s, time);
  }
  // Flat, or reversed through flat: the old position's legs (and waiting closes) have nothing left to protect.
  // A waiting close_position (flatten) survives a reversal: it closes whatever the position is.
  if (pos.net === 0 || Math.sign(pos.net) !== Math.sign(before)) {
    for (const s of book.orders) if (s.role !== "order" && s.status === STATUS.open && !(s.flatten && pos.net !== 0)) cancel(s, time);
  }
  // Brackets protect what the fill opened: none for a fill that only reduced the position (its legs
  // would sit on the wrong side), and only the part beyond flat for one that went through it.
  const legs: SimOrder[] = [];
  const opened = exposureAfter(before, o.side, size);
  if (o.role === "order" && pos.net !== 0 && opened.opens) {
    const legSize = before !== 0 && Math.sign(pos.net) !== Math.sign(before) ? Math.abs(pos.net) : size;
    if (o.stopLossBracket) legs.push(newLeg(o, "sl", o.stopLossBracket, price, legSize, time, spec.tickSize, ids));
    if (o.takeProfitBracket) legs.push(newLeg(o, "tp", o.takeProfitBracket, price, legSize, time, spec.tickSize, ids));
    book.orders.push(...legs);
  }
  return { fill, legs };
}

/**
 * The bar's open: market orders placed at or before it fill at the open plus
 * slippage (sim-broker.js#fillAtOpen). Their bracket legs are live from this bar on.
 */
export function openBar(book: Book, bar: BarOHLC, spec: FillSpec, ids: Ids, hooks: Hooks = {}): SimFill[] {
  const fills: SimFill[] = [];
  const due = book.orders.filter((o) => o.status === STATUS.open && o.type === ORDER_TYPES.market && o.placedAt <= bar.t);
  for (const o of due.sort((a, b) => a.id - b.id)) {
    if (o.status !== STATUS.open) continue;
    const { fill, deferred } = fillOrder(book, o, marketFillPrice(bar.o, o.side, spec), bar.t, spec, ids, hooks);
    if (deferred) break; // pass 1 stops at the first opening fill; pass 2 continues in order
    if (fill) fills.push(fill);
  }
  return fills;
}

/** Fill price of a triggered resting order on the bar. */
export function restingFillPrice(o: SimOrder, bar: BarOHLC, spec: FillSpec): number {
  return isStopType(o.type) ? stopFillPrice(bar, o.side, o.stopPrice as number, spec) : onTick(limitFillPrice(bar, o.side, o.limitPrice as number), spec.tickSize);
}

/**
 * The bar's range, once it has closed: every resting order live on this bar
 * that its high/low reached fills, stops before limits (sim-broker.js#onBar),
 * then by order id. A stop-loss leg created by a fill inside the bar is
 * checked against the same bar too (pessimistic: the stop is assumed hit
 * after the entry), at its own price less slippage, since the gap rule needs
 * an open that came before the entry. Trailing stops ratchet afterwards.
 * Fills inside the bar are stamped at the bar's close. Limits are enforced
 * per fill, in this order, against the position left by the fills before it.
 */
export function closeBar(book: Book, bar: BarOHLC, spec: FillSpec, ids: Ids, hooks: Hooks = {}, trail = true): SimFill[] {
  const end = bar.t + MINUTE;
  const fills: SimFill[] = [];
  const hit = book.orders
    .filter((o) => o.status === STATUS.open && o.type !== ORDER_TYPES.market && o.activeFrom <= bar.t && triggers(o, bar))
    .sort((a, b) => Number(isStopType(b.type)) - Number(isStopType(a.type)) || a.id - b.id);
  for (const o of hit) {
    if (o.status !== STATUS.open) continue;
    const { fill, legs, deferred } = fillOrder(book, o, restingFillPrice(o, bar, spec), end, spec, ids, hooks);
    if (deferred) break; // pass 1 stops at the first opening fill; pass 2 continues in order
    if (fill) fills.push(fill);
    for (const leg of legs) {
      if (leg.role !== "sl" || !isStopType(leg.type) || leg.status !== STATUS.open || !triggers(leg, bar)) continue;
      const price = onTick((leg.stopPrice as number) + sideSign(leg.side) * spec.slippageTicks * spec.tickSize, spec.tickSize);
      const r = fillOrder(book, leg, price, end, spec, ids, hooks);
      if (r.fill) fills.push(r.fill);
    }
  }
  if (trail) for (const o of book.orders) if (o.status === STATUS.open && o.activeFrom <= bar.t) trailStep(o, bar, spec.tickSize, end);
  return fills;
}

/** A broker-side trailing stop: after the bar, the stop follows the bar's extreme at the trail distance, never loosening. */
export function trailStep(o: SimOrder, bar: BarOHLC, tick: number, time: number): void {
  if (o.type !== ORDER_TYPES.trailing_stop || o.trailDistance === null || o.stopPrice === null) return;
  const next = o.side === 1 ? onTick(bar.h - o.trailDistance, tick) : onTick(bar.l + o.trailDistance, tick);
  if (o.side === 1 ? next > o.stopPrice : next < o.stopPrice) Object.assign(o, { stopPrice: next, updatedAt: time });
}
