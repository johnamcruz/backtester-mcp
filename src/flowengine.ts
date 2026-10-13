import { MINUTE_MS, addPrint, minuteOf, newBucket, ofiEvent, type L1State, type MinuteBucket, type Side } from "./orderflow.js";

/**
 * The history order-flow engine: per-minute buckets (orderflow.ts) from one
 * time-ordered stream of normalized events (events.ts): L1 quote states, trade
 * prints, L2 level changes, and resets (a session start or end). It reproduces
 * projectx-mcp's live computation (its src/flowfeed.ts onTrade / onDepth /
 * advanceImbalance) with what history has instead of what live has:
 *
 * - Trade side: history has no aggressor flag, so it is inferred (inferSide):
 *   the quote rule against the L1 quote in force strictly before the print, else
 *   the tick rule. A print the rules can't side has no side, as a live print
 *   without a flag (its minute is incomplete). A side given with the event (a
 *   converted live print) is used as is.
 * - Times: exchange time for everything (live times the book by receive time).
 *   Minutes are UTC, half-open; µs in, ms for the arithmetic (as live).
 * - Book: price-keyed (L2 ranks sit behind the touch): level 1 is the
 *   L1 touch, the levels behind it are the L2 levels strictly outside the touch
 *   in price order (the data's `rank` is not a tick distance and isn't used); an
 *   L2 add or update sets the size at its price, a remove clears it; at every L1
 *   change the levels through the touch are removed and the touch level takes
 *   the L1 size (live's Best rules), so none returns with a stale size. Imbalance is over the top `levels` (5) of
 *   each side, as live. After a day without L2 the imbalance stays null until L2
 *   rows arrive.
 * - L1 states: grouped by L1_STATE_GROUPING (one per exchange timestamp: all L1
 *   and L2 rows sharing a µs are one update; live takes one state per depth
 *   message, and the match is not validated yet); an unchanged state adds no OFI
 *   event (live's pushL1).
 * - Validity (live Book.valid): both sides of the touch seen with size since the
 *   last reset; a side that empties later keeps the book valid (imbalance ±1,
 *   OFI chain broken until two full states follow each other).
 */

/**
 * How L1 rows are grouped into the L1 states quote OFI is computed from: one
 * state per exchange timestamp (µs). Live takes one state per SignalR depth
 * message; which grouping of history reproduces that is NOT validated yet (a µs
 * groups only about 0.1% of the rows): minutes recorded live by projectx-mcp's
 * flow recorder will calibrate it. Until then `ofiQuote` is reported as
 * unvalidated (flowtools.ts, `orderFlow.coverage.unvalidated`).
 */
export const L1_STATE_GROUPING = "exchange-timestamp" as const;

/** Ticks scanned outside the touch for the levels behind it (a bound on the scan). */
export const SCAN_TICKS = 120;
/** Levels per side in the book imbalance (live: top 5). */
export const BOOK_LEVELS = 5;

export const EMPTY_L1: L1State = Object.freeze({ bid: null, bidSize: null, ask: null, askSize: null });

const sameL1 = (a: L1State, b: L1State) => a.bid === b.bid && a.bidSize === b.bidSize && a.ask === b.ask && a.askSize === b.askSize;

/**
 * The aggressor side of a print at `price`, given the L1 quote in force strictly
 * before it and the tick-rule sign so far (+1 up, -1 down, 0 none yet):
 * at or above the ask a buy, at or below the bid a sell; a locked or crossed
 * quote (bid >= ask) says nothing, and neither does a side not quoted yet; then
 * the tick rule; null when the tick rule has no sign either.
 */
export function inferSide(price: number, quote: L1State, tick: number): Side | null {
  const { bid, ask } = quote;
  const usable = !(bid !== null && ask !== null && bid >= ask);
  if (usable && ask !== null && price >= ask) return "buy";
  if (usable && bid !== null && price <= bid) return "sell";
  return tick > 0 ? "buy" : tick < 0 ? "sell" : null;
}

/** The engine's state between two calls (carried over 00:00 ET within a session, from one day file to the next). */
export interface EngineCarry {
  /** µs of the last event (or advance). */
  cur: number;
  quote: L1State;
  seenBid: boolean;
  seenAsk: boolean;
  lastL1: L1State | null;
  ofiPrev: L1State | null;
  /** [tick index, size] of each side's L2 levels. */
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  lastTrade: number | null;
  lastTick: number;
  imb: number | null;
  /** ms from which `imb` is not yet integrated. */
  imbFrom: number;
  /** The engine had L2 data (a day without L2 carries no levels). */
  book: boolean;
  /** No L2 level has arrived since a carry from a day without L2: the imbalance is null until one does. */
  awaitL2: boolean;
}

export interface EngineOptions {
  /** Price grid of the book (NQ 0.25). */
  tick: number;
  /**
   * L2 present (default true). False (an L2 gap day): the carried L2 levels are
   * dropped and the imbalance is over the touch alone, which only keeps
   * `ofiQuote`'s null rule (the book is defined); the store reports
   * `bookImbalance` null for such a day.
   */
  book?: boolean;
  levels?: number;
  carry?: EngineCarry | null;
}

export class FlowEngine {
  readonly buckets = new Map<number, MinuteBucket>();
  private readonly tick: number;
  private readonly book: boolean;
  private readonly levels: number;
  private cur = -Infinity;
  private dirty = false;
  private quote: L1State = { ...EMPTY_L1 };
  /** The L1 state in force strictly before `cur` (the quote rule's). */
  private before: L1State = { ...EMPTY_L1 };
  private seenBid = false;
  private seenAsk = false;
  private lastL1: L1State | null = null;
  private ofiPrev: L1State | null = null;
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();
  private lastTrade: number | null = null;
  private lastTick = 0;
  private imb: number | null = null;
  private imbFrom = -Infinity;
  private awaitL2 = false;
  /** Highest bid / lowest ask tick index set since the last cleanup (bounds the levels through the touch). */
  private hiBid = -Infinity;
  private loAsk = Infinity;

  constructor(o: EngineOptions) {
    this.tick = o.tick;
    this.book = o.book ?? true;
    this.levels = o.levels ?? BOOK_LEVELS;
    const c = o.carry;
    if (!c) return;
    this.cur = c.cur;
    this.quote = { ...c.quote };
    this.before = { ...c.quote };
    this.seenBid = c.seenBid;
    this.seenAsk = c.seenAsk;
    this.lastL1 = c.lastL1 && { ...c.lastL1 };
    this.ofiPrev = c.ofiPrev && { ...c.ofiPrev };
    if (this.book) {
      for (const [k, v] of c.bids) this.setLevel(this.bids, k, v);
      for (const [k, v] of c.asks) this.setLevel(this.asks, k, v);
    }
    // After a day without L2 the book has no levels behind the touch until L2 rows arrive: no imbalance until then.
    this.awaitL2 = this.book && (c.awaitL2 || !c.book);
    this.lastTrade = c.lastTrade;
    this.lastTick = c.lastTick;
    this.imb = c.imb;
    this.imbFrom = c.imbFrom;
  }

  private bucket(ms: number): MinuteBucket {
    const m = minuteOf(ms);
    let b = this.buckets.get(m);
    if (!b) this.buckets.set(m, (b = newBucket(m)));
    return b;
  }

  /** Move to time `t` (µs): the updates at the previous time take effect first. Times never go back. */
  private at(t: number): void {
    if (t < this.cur) throw new Error(`order-flow events out of time order at ${new Date(t / 1000).toISOString()}`);
    if (t === this.cur) return;
    this.flush();
    this.cur = t;
    this.before = { ...this.quote };
  }

  /** The updates at `cur` take effect: one L1 state (quote OFI) and the book imbalance from `cur` on. */
  private flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const ms = this.cur / 1000;
    if (this.seenBid && this.seenAsk) {
      const ev = { ...this.quote };
      if (!this.lastL1 || !sameL1(this.lastL1, ev)) {
        this.lastL1 = ev;
        if (this.ofiPrev) {
          const e = ofiEvent(this.ofiPrev, ev);
          if (e !== null) {
            const b = this.bucket(ms);
            b.ofiQuote += e;
            b.ofiEvents += 1;
          }
        }
        this.ofiPrev = ev;
      }
    }
    const v = this.imbalance();
    if (v !== this.imb) {
      this.integrate(ms);
      this.imb = v;
      this.imbFrom = ms;
    }
  }

  /** Integrate the imbalance in effect from imbFrom to `ms` into the minutes it spans (flowfeed.ts#advanceImbalance). */
  private integrate(ms: number): void {
    let from = this.imbFrom;
    this.imbFrom = Math.max(this.imbFrom, ms);
    const v = this.imb;
    if (v === null) return;
    while (from < ms) {
      const end = Math.min(minuteOf(from) + MINUTE_MS, ms);
      const b = this.bucket(from);
      b.imbArea += v * (end - from);
      b.imbMs += end - from;
      from = end;
    }
  }

  /** Summed size of the top levels of a side: the touch, then the L2 levels strictly outside it. */
  private depthOf(side: "bid" | "ask"): number {
    const price = side === "bid" ? this.quote.bid : this.quote.ask;
    const size = side === "bid" ? this.quote.bidSize : this.quote.askSize;
    if (price === null) return 0;
    let sum = size ?? 0;
    const grid = side === "bid" ? this.bids : this.asks;
    const step = side === "bid" ? -1 : 1;
    const top = Math.round(price / this.tick);
    for (let s = 1, k = 1; k < this.levels && s <= SCAN_TICKS; s++) {
      const q = grid.get(top + step * s);
      if (q) {
        sum += q;
        k++;
      }
    }
    return sum;
  }

  /** (B - A) / (B + A) over the top levels; null without a valid book or with no size. */
  private imbalance(): number | null {
    if (!this.seenBid || !this.seenAsk || this.awaitL2) return null;
    const b = this.depthOf("bid");
    const a = this.depthOf("ask");
    return b + a > 0 ? (b - a) / (b + a) : null;
  }

  /** The full L1 state after a bid or ask change at `t` (µs). */
  quoteState(t: number, q: L1State): void {
    this.at(t);
    this.quote = { bid: q.bid, bidSize: q.bidSize, ask: q.ask, askSize: q.askSize };
    if (q.bid !== null && (q.bidSize ?? 0) > 0) this.seenBid = true;
    if (q.ask !== null && (q.askSize ?? 0) > 0) this.seenAsk = true;
    this.clearThrough();
    this.dirty = true;
    this.bucket(t / 1000).l1Events += 1;
  }

  /**
   * A print at `t` (µs). `side` undefined: inferred from the quote in force
   * strictly before `t` and the tick rule; given (null included): used as is.
   */
  trade(t: number, price: number, size: number, side?: Side | null, badTimestamp = false): void {
    this.at(t);
    if (this.lastTrade !== null && price !== this.lastTrade) this.lastTick = price > this.lastTrade ? 1 : -1;
    this.lastTrade = price;
    const s = side === undefined ? inferSide(price, this.before, this.lastTick) : side;
    const b = this.bucket(t / 1000);
    addPrint(b, { t: t / 1000, price, size, side: s, ...(badTimestamp ? { badTimestamp: true } : {}) });
    b.l1Events += 1;
  }

  /** An L2 level's size after a change at `t` (µs); 0 removes it. */
  level(t: number, side: "bid" | "ask", price: number, size: number): void {
    this.at(t);
    if (!this.book) return;
    const grid = side === "bid" ? this.bids : this.asks;
    const k = Math.round(price / this.tick);
    if (size > 0) this.setLevel(grid, k, size);
    else grid.delete(k);
    this.awaitL2 = false;
    this.dirty = true;
  }

  private setLevel(grid: Map<number, number>, k: number, size: number): void {
    grid.set(k, size);
    if (grid === this.bids) this.hiBid = Math.max(this.hiBid, k);
    else this.loAsk = Math.min(this.loAsk, k);
  }

  /**
   * Live's Book.apply: a new best bid at P removes the bids above P, then sets P
   * to its size (the mirror for asks). Here on every L1 change: L2 levels
   * strictly through the touch are gone, and the touch level takes the L1 size,
   * so neither comes back with a stale size when the touch moves away and back.
   */
  private clearThrough(): void {
    const drop = (grid: Map<number, number>, from: number, to: number) => {
      if (to - from > 4096) for (const k of [...grid.keys()]) (k >= from && k <= to) && grid.delete(k);
      else for (let k = from; k <= to; k++) grid.delete(k);
    };
    if (this.quote.bid !== null) {
      const top = Math.round(this.quote.bid / this.tick);
      if (this.hiBid > top) drop(this.bids, top + 1, this.hiBid);
      this.hiBid = Math.min(this.hiBid, top);
      if (this.book && (this.quote.bidSize ?? 0) > 0) this.setLevel(this.bids, top, this.quote.bidSize as number);
    }
    if (this.quote.ask !== null) {
      const top = Math.round(this.quote.ask / this.tick);
      if (this.loAsk < top) drop(this.asks, this.loAsk, top - 1);
      this.loAsk = Math.max(this.loAsk, top);
      if (this.book && (this.quote.askSize ?? 0) > 0) this.setLevel(this.asks, top, this.quote.askSize as number);
    }
  }

  /** A reset at `t` (µs): a session's start or end, or a live Reset or disconnect. The book and the OFI chain start over. */
  reset(t: number): void {
    this.at(t);
    this.bids.clear();
    this.asks.clear();
    this.hiBid = -Infinity;
    this.loAsk = Infinity;
    this.quote = { ...EMPTY_L1 };
    this.before = { ...EMPTY_L1 };
    this.seenBid = this.seenAsk = false;
    this.ofiPrev = null;
    this.lastTrade = null;
    this.lastTick = 0;
    this.dirty = true;
  }

  /** Bring the engine to `t` (µs): everything before it is applied and the imbalance integrated up to it. */
  advance(t: number): void {
    this.at(t);
    this.flush();
    this.integrate(t / 1000);
  }

  carry(): EngineCarry {
    this.flush();
    return {
      cur: this.cur,
      quote: { ...this.quote },
      seenBid: this.seenBid,
      seenAsk: this.seenAsk,
      lastL1: this.lastL1 && { ...this.lastL1 },
      ofiPrev: this.ofiPrev && { ...this.ofiPrev },
      bids: [...this.bids].sort((a, b) => a[0] - b[0]),
      asks: [...this.asks].sort((a, b) => a[0] - b[0]),
      lastTrade: this.lastTrade,
      lastTick: this.lastTick,
      imb: this.imb,
      imbFrom: this.imbFrom,
      book: this.book,
      awaitL2: this.awaitL2,
    };
  }
}
