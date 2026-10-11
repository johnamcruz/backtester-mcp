import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { aggregate, BarStore, MINUTE, type AggUnit, type BarSeries, type OutBar } from "./bars.js";
import { readNow } from "./clock.js";
import type { Config } from "./config.js";
import { ORDER_TYPES } from "./enums.js";
import {
  STATUS,
  closeBar,
  fillOrder,
  isLimitType,
  isOnTick,
  isStopType,
  marketFillPrice,
  onTick,
  sideSign,
  openBar,
  type BracketSpec,
  type Book,
  type FillSpec,
  type Ids,
  type Side,
  type SimFill,
  type Hooks,
  exposureAfter,
  type SimOrder,
  type SimPosition,
} from "./fills.js";
import { roundTrips, type FillInfo, type RoundTrip } from "./metrics.js";
import type { Trade } from "./performance.js";
import { realizedNet, tradingDayStart } from "./risk.js";

/**
 * The replay exchange: this server's stand-in for the broker API that
 * projectx-mcp's client.ts talks to. It holds a simulated account over local
 * 1-minute bars: contracts, bars and quotes as of the replay clock, and
 * orders, positions and fills from the fill engine (fills.ts).
 *
 * Every call is one transaction on the run's state file (BACKTESTER_STATE_DIR):
 * lock, read, sync to the clock, act, write, unlock. Several processes (the
 * harness's gateway and its runner each start the server) share one run.
 * Syncing processes every 1-minute bar between the last synced time and now,
 * in order, so results depend only on the data, the window, the clock
 * sequence and the orders.
 */

export class ReplayError extends Error {}

/** A broker answer: success, or a refusal with the interface's errorCode. */
export interface Outcome {
  success: boolean;
  errorCode: number;
  errorMessage: string | null;
}

const OK: Outcome = { success: true, errorCode: 0, errorMessage: null };
const refuse = (errorCode: number, errorMessage: string): Outcome => ({ success: false, errorCode, errorMessage });

// ── Contracts ────────────────────────────────────────────────────────

type RollRule = "quarterly" | "gc" | "si" | "monthly";

export interface ContractSpec {
  root: string;
  /** The data file root: micros replay their mini's bars (MNQ -> NQ_1min.csv). */
  dataRoot: string;
  tickSize: number;
  tickValue: number;
  micro: boolean;
  description: string;
  roll: RollRule;
}

const spec = (root: string, dataRoot: string, tickSize: number, tickValue: number, description: string, roll: RollRule): ContractSpec => ({
  root,
  dataRoot,
  tickSize,
  tickValue,
  micro: root !== dataRoot,
  description,
  roll,
});

/** Tick specs (USD per tick per contract). Micros map to their mini's file with the micro's tick value. */
export const CONTRACTS: Record<string, ContractSpec> = {
  NQ: spec("NQ", "NQ", 0.25, 5, "E-mini Nasdaq-100", "quarterly"),
  MNQ: spec("MNQ", "NQ", 0.25, 0.5, "Micro E-mini Nasdaq-100", "quarterly"),
  ES: spec("ES", "ES", 0.25, 12.5, "E-mini S&P 500", "quarterly"),
  MES: spec("MES", "ES", 0.25, 1.25, "Micro E-mini S&P 500", "quarterly"),
  YM: spec("YM", "YM", 1, 5, "E-mini Dow ($5)", "quarterly"),
  MYM: spec("MYM", "YM", 1, 0.5, "Micro E-mini Dow", "quarterly"),
  RTY: spec("RTY", "RTY", 0.1, 5, "E-mini Russell 2000", "quarterly"),
  M2K: spec("M2K", "RTY", 0.1, 0.5, "Micro E-mini Russell 2000", "quarterly"),
  GC: spec("GC", "GC", 0.1, 10, "Gold", "gc"),
  MGC: spec("MGC", "GC", 0.1, 1, "Micro Gold", "gc"),
  SI: spec("SI", "SI", 0.005, 25, "Silver", "si"),
  SIL: spec("SIL", "SI", 0.005, 5, "Micro Silver (1,000 oz)", "si"),
  CL: spec("CL", "CL", 0.01, 10, "Crude Oil", "monthly"),
  MCL: spec("MCL", "CL", 0.01, 1, "Micro Crude Oil", "monthly"),
};

const MONTH_CODES = "FGHJKMNQUVXZ";
const ROLL_MONTHS: Record<RollRule, number[]> = {
  quarterly: [3, 6, 9, 12],
  gc: [2, 4, 6, 8, 10, 12],
  si: [3, 5, 7, 9, 12],
  monthly: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
};

/** When a contract month stops being the front month (approximately, for its ticker name only). */
function rollsAt(rule: RollRule, year: number, month: number): number {
  if (rule === "quarterly") {
    // Eight days before expiry, the third Friday of the month.
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const thirdFriday = 1 + ((5 - first + 7) % 7) + 14;
    return Date.UTC(year, month - 1, thirdFriday - 8);
  }
  if (rule === "monthly") return Date.UTC(year, month - 2, 15); // crude: mid prior month
  return Date.UTC(year, month - 1, 1) - 5 * 864e5; // metals: late in the prior month
}

/**
 * The front-month ticker at `now` (e.g. MNQZ24). The data is one
 * back-adjusted continuous series per root, so the name only labels the
 * front month for the harness's contract translator; the id stays the same.
 */
export function frontMonthName(spec: ContractSpec, now: Date): string {
  let year = now.getUTCFullYear();
  for (let k = 0; k < 40; k++) {
    for (const m of ROLL_MONTHS[spec.roll]) {
      if (rollsAt(spec.roll, year, m) > now.getTime()) return `${spec.root}${MONTH_CODES[m - 1]}${String(year % 100).padStart(2, "0")}`;
    }
    year++;
  }
  /* c8 ignore next */
  throw new Error("no front month");
}

export const contractIdOf = (root: string) => `BT.${root}`;

export function specOf(contractId: string): ContractSpec | null {
  const m = /^BT\.([A-Z0-9]+)$/.exec(contractId);
  return m ? (CONTRACTS[m[1]] ?? null) : null;
}

// ── State ────────────────────────────────────────────────────────────

interface StoredOrder extends SimOrder {
  accountId: number;
  contractId: string;
  /** Stops: [time, stop price] at placement (client stops) and at each modify (for a round trip's initial stop and "trail"). */
  stopAt?: Array<[number, number]>;
  /** Filled at the last close after BACKTESTER_END (a round trip's exit reason "end"). */
  endOfWindow?: boolean;
}

/** A fill as search_trades returns it: the stored fill plus its round-trip metrics (extra fields). */
export type TradeWithMetrics = Trade & { roundTripId?: number; exitReason?: FillInfo["exitReason"]; roundTrip?: RoundTrip };

interface State {
  version: 1;
  runId: string;
  accountId: number;
  startBalance: number;
  /** Every bar event up to this time (ms) has been processed. */
  syncedTo: number | null;
  nextOrderId: number;
  nextTradeId: number;
  nextPositionId: number;
  orders: StoredOrder[];
  positions: Record<string, SimPosition>;
  trades: Trade[];
  /** The fill and account settings the run was created with; every process on the run must match them. */
  settings?: RunSettings;
}

interface RunSettings {
  accountId: number;
  startBalance: number;
  slippageTicks: number;
  feesMicro: number;
  feesMini: number;
}

export interface PlaceRequest {
  accountId: number;
  contractId: string;
  type: number;
  side: Side;
  size: number;
  limitPrice: number | null;
  stopPrice: number | null;
  trailPrice: number | null;
  customTag: string | null;
  stopLossBracket: BracketSpec | null;
  takeProfitBracket: BracketSpec | null;
}

export interface ModifyRequest {
  accountId: number;
  orderId: number;
  size: number | null;
  limitPrice: number | null;
  stopPrice: number | null;
  trailPrice: number | null;
}

export interface BarsRequest {
  contractId: string;
  unit: string;
  unitNumber: number;
  limit: number;
  startTime?: string;
  endTime?: string;
  includePartialBar: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Contracts the run has traded (read without the lock, so their bars load before it). */
function state0Contracts(statePath: string): string[] {
  try {
    return [...new Set(((JSON.parse(readFileSync(statePath, "utf8")) as State).trades ?? []).map((t) => t.contractId))];
  } catch {
    return [];
  }
}
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const LOCK_WAIT_MS = 60000; // longer than LOCK_STALE_MS, so a crashed holder's lock is cleared before callers give up
const LOCK_STALE_MS = 30000;

export interface ExchangeOptions {
  store?: BarStore;
  /** The replay time; defaults to the configured clock (file, else BACKTESTER_NOW). */
  now?: () => Date;
}

export class ReplayExchange {
  readonly store: BarStore;
  private readonly clock: () => Date;

  constructor(
    private readonly config: Config,
    opts: ExchangeOptions = {},
  ) {
    this.store = opts.store ?? new BarStore(config.dataDir);
    this.clock = opts.now ?? (() => readNow(config));
  }

  /** The replay time now. */
  now(): Date {
    return this.clock();
  }

  /** Time the run can see: the clock, capped at BACKTESTER_END. */
  private cutoff(now: Date): number {
    return this.config.end !== null ? Math.min(now.getTime(), this.config.end) : now.getTime();
  }

  private spec(c: ContractSpec): FillSpec {
    return {
      tickSize: c.tickSize,
      tickValue: c.tickValue,
      feePerSide: c.micro ? this.config.feesMicro : this.config.feesMini,
      slippageTicks: this.config.slippageTicks,
    };
  }

  // ── Transactions ─────────────────────────────────────────────────

  private freshState(): State {
    return {
      version: 1,
      runId: this.config.runId,
      accountId: this.config.accountId,
      startBalance: this.config.startBalance,
      syncedTo: null,
      nextOrderId: 1,
      nextTradeId: 1,
      nextPositionId: 1,
      orders: [],
      positions: {},
      trades: [],
      settings: this.settings(),
    };
  }

  private lock(): () => void {
    const path = `${this.config.statePath}.lock`;
    mkdirSync(dirname(path), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const token = `${process.pid}-${Math.random()}`;
        const fd = openSync(path, "wx");
        writeFileSync(fd, token);
        closeSync(fd);
        return () => {
          try {
            // Only remove our own lock (a stale-lock sweep may have handed it to another process).
            if (readFileSync(path, "utf8") === token) unlinkSync(path);
          } catch {
            /* already gone */
          }
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) unlinkSync(path);
        } catch {
          /* raced with its owner */
        }
        if (Date.now() > deadline) throw new ReplayError(`Timed out waiting for the run's state lock ${path}.`);
        sleep(5);
      }
    }
  }

  private load(): State {
    try {
      return JSON.parse(readFileSync(this.config.statePath, "utf8")) as State;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return this.freshState();
      throw new ReplayError(`Replay state ${this.config.statePath} is unreadable: ${(e as Error).message}`);
    }
  }

  private save(state: State): void {
    const tmp = `${this.config.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, this.config.statePath);
  }

  /** Lock the run, sync it to the clock, run `fn`, save. */
  private settings(): RunSettings {
    const c = this.config;
    return { accountId: c.accountId, startBalance: c.startBalance, slippageTicks: c.slippageTicks, feesMicro: c.feesMicro, feesMini: c.feesMini };
  }

  /** Every process on a run fills the same way: refuse one whose settings differ from the run's. */
  private checkSettings(state: State): void {
    const mine = this.settings();
    state.settings ??= mine;
    const diff = (Object.keys(mine) as Array<keyof RunSettings>).filter((k) => state.settings?.[k] !== mine[k]);
    if (diff.length) {
      throw new ReplayError(
        `This process's settings differ from run ${this.config.runId}'s (${diff.map((k) => `${k} ${mine[k]} vs ${state.settings?.[k]}`).join(", ")}). ` +
          "Use the run's settings, or a new BACKTESTER_RUN_ID.",
      );
    }
  }

  /**
   * Load the data files this call may need before taking the lock (bars never change), so a
   * large CSV loading inside the lock can't make other processes judge it stale.
   */
  private preload(contractIds: string[]): void {
    const roots = new Set<string>();
    const add = (id: string) => {
      const c = specOf(id);
      if (c) roots.add(c.dataRoot);
    };
    contractIds.forEach(add);
    try {
      const st = JSON.parse(readFileSync(this.config.statePath, "utf8")) as State;
      for (const o of st.orders ?? []) if (o.status === STATUS.open) add(o.contractId);
    } catch {
      /* no state yet, or mid-write: the locked read decides */
    }
    for (const r of roots) if (this.store.has(r)) this.store.get(r);
  }

  private tx<T>(fn: (state: State, now: Date) => T, contractIds: string[] = []): T {
    this.preload(contractIds);
    const unlock = this.lock();
    try {
      // Read the clock under the lock: another process may have synced to a newer clock while this one waited.
      const now = this.clock();
      const state = this.load();
      this.checkSettings(state);
      this.sync(state, now);
      const out = fn(state, now);
      this.save(state);
      return out;
    } finally {
      unlock();
    }
  }

  private ids(state: State): Ids {
    return { order: () => state.nextOrderId++, position: () => state.nextPositionId++ };
  }

  private book(state: State, contractId: string): Book {
    state.positions[contractId] ??= { id: null, net: 0, averagePrice: 0, openedAt: null };
    return { orders: state.orders.filter((o) => o.contractId === contractId), position: state.positions[contractId] };
  }

  /** New orders created inside a book (bracket legs) join the state's list with their account and contract. */
  private adopt(state: State, book: Book, contractId: string): void {
    const known = new Set(state.orders.map((o) => o.id));
    for (const o of book.orders) {
      if (!known.has(o.id)) state.orders.push(Object.assign(o, { accountId: state.accountId, contractId }) as StoredOrder);
    }
  }

  /** Fill-time limits (as a broker enforces server-side) and immediate recording of fills. */
  private hooks(state: State, contractId: string): Hooks {
    return {
      guard: (o, size, pos, time) => this.limitReason(state, o.side, size, pos.net, time),
      onFill: (fill) => this.record(state, contractId, [fill]),
    };
  }

  /**
   * Why a fill of a client order must be rejected, or null. Only fills that open exposure (grow
   * |net| or go through flat) are checked: past BACKTESTER_MAX_POSITION_SIZE, or with the daily
   * loss limit reached. Reducing fills, bracket legs and closes are never rejected.
   */
  private limitReason(state: State, side: Side, size: number, net: number, time: number): string | null {
    const { after, opens } = exposureAfter(net, side, size);
    if (!opens) return null;
    const c = this.config;
    if (Math.abs(after) > c.maxPositionSize) {
      return `Rejected at fill: the net position would be ${after} (from ${net}); BACKTESTER_MAX_POSITION_SIZE is ${c.maxPositionSize}.`;
    }
    if (c.maxDailyLoss > 0) {
      const dayStart = tradingDayStart(new Date(time)).getTime();
      const realized = realizedNet(state.trades.filter((t) => Date.parse(t.creationTimestamp) >= dayStart));
      if (realized <= -c.maxDailyLoss) {
        return `Rejected at fill: daily loss limit reached (realized net ${realized.toFixed(2)} today, limit -${c.maxDailyLoss}); only reducing fills until the next trading day.`;
      }
    }
    return null;
  }

  private record(state: State, contractId: string, fills: SimFill[]): void {
    for (const f of fills) {
      state.trades.push({
        id: state.nextTradeId++,
        accountId: state.accountId,
        contractId,
        creationTimestamp: iso(f.time),
        price: f.price,
        profitAndLoss: f.profitAndLoss,
        fees: f.fees,
        side: f.side,
        size: f.size,
        voided: false,
        orderId: f.orderId,
      } as Trade);
    }
  }

  /**
   * Process every 1-minute bar event between the last synced time and now, in
   * order: a bar's open fills waiting market orders, its close (once closed)
   * settles resting orders against its range. Nothing after BACKTESTER_END.
   */
  private sync(state: State, now: Date): void {
    const cutoff = this.cutoff(now);
    if (state.syncedTo === null) {
      state.syncedTo = cutoff;
      return;
    }
    if (cutoff < state.syncedTo) {
      throw new ReplayError(
        `The replay clock moved backwards: this run (${this.config.runId}) is synced to ${iso(state.syncedTo)}, the clock says ${now.toISOString()}. ` +
          "Start a new run (a new BACKTESTER_RUN_ID or BACKTESTER_STATE_DIR) to replay again.",
      );
    }
    const from = state.syncedTo;
    const contracts = [...new Set(state.orders.filter((o) => o.status === STATUS.open).map((o) => o.contractId))].sort();
    // One cursor per contract; bars are processed in time order across contracts (opens of a
    // minute, then its closes), so the account-wide daily loss sees fills as they happen.
    const curs = contracts.flatMap((contractId) => {
      const c = specOf(contractId);
      if (!c || !this.store.has(c.dataRoot)) return [];
      const s = this.store.get(c.dataRoot);
      return [{ contractId, s, fs: this.spec(c), book: this.book(state, contractId), i: s.lowerBound(from - MINUTE + 1) }];
    });
    const ids = this.ids(state);
    const active = (k: (typeof curs)[number]) => k.i < k.s.length && k.s.t[k.i] <= cutoff && k.book.orders.some((o) => o.status === STATUS.open);
    for (;;) {
      let t = Infinity;
      for (const k of curs) if (active(k)) t = Math.min(t, k.s.t[k.i]);
      if (t === Infinity) break;
      const group = curs.filter((k) => active(k) && k.s.t[k.i] === t);
      // Each moment (the minute's open, then its close) runs in two passes over every contract.
      // Pass 1 walks each book in its normal order (markets by arrival; resting orders stops first,
      // then by id) and stops at its first fill that would open exposure; pass 2 continues every
      // book from there in the same order. So a contract's own fills keep their order, and the
      // leading reductions on every contract count before an opening fill on any other.
      const pass = (fn: (k: (typeof curs)[number], hooks: Hooks, last: boolean) => void) => {
        for (const k of group) fn(k, { ...this.hooks(state, k.contractId), deferOpening: true }, false);
        for (const k of group) fn(k, this.hooks(state, k.contractId), true);
      };
      if (t > from) pass((k, h) => openBar(k.book, k.s.bar(k.i), k.fs, ids, h));
      if (t + MINUTE <= cutoff) pass((k, h, last) => closeBar(k.book, k.s.bar(k.i), k.fs, ids, h, last));
      for (const k of group) k.i++;
    }
    for (const k of curs) this.adopt(state, k.book, k.contractId);
    state.syncedTo = cutoff;
  }

  // ── Account ──────────────────────────────────────────────────────

  private accountOf(state: State) {
    const balance = Math.round((state.startBalance + realizedNet(state.trades)) * 100) / 100;
    return { id: state.accountId, name: this.config.accountName, balance, canTrade: balance > 0, isVisible: true, simulated: true };
  }

  private assertAccount(state: State, accountId: number): void {
    if (accountId !== state.accountId) throw new ReplayError(`Account ${accountId} not found (this replay's account is ${state.accountId}).`);
  }

  accounts() {
    return this.tx((state) => [this.accountOf(state)]);
  }

  /**
   * Round trips (metrics.ts) of every contract the account traded, from the whole run's fills and
   * the bars closed at or before the cutoff: closed ones, each contract's open one, and per fill
   * the round trip it belongs to.
   */
  private roundTripsOf(state: State, now: Date) {
    const cutoff = this.cutoff(now);
    const closed: RoundTrip[] = [];
    const open: Record<string, RoundTrip> = {};
    const fills = new Map<number, FillInfo>();
    for (const contractId of [...new Set(state.trades.map((t) => t.contractId))].sort()) {
      const c = specOf(contractId);
      if (!c) continue;
      const bars = this.store.has(c.dataRoot) ? this.store.get(c.dataRoot) : null;
      const r = roundTrips(
        contractId,
        state.trades.filter((t) => t.contractId === contractId),
        state.orders.filter((o) => o.contractId === contractId),
        bars,
        c,
        cutoff,
      );
      closed.push(...r.closed);
      if (r.open) open[contractId] = r.open;
      for (const [id, f] of r.fills) fills.set(id, f);
    }
    return { closed, open, fills };
  }

  /**
   * Open positions; with `metrics`, each carries its round trip so far (extra field `roundTrip`:
   * MAE/MFE over the bars closed at or before the clock, bars held, initial stop and risk).
   */
  positions(accountId: number, metrics = false) {
    return this.tx((state, now) => {
      this.assertAccount(state, accountId);
      const trips = metrics ? this.roundTripsOf(state, now).open : null;
      return Object.entries(state.positions)
        .filter(([, p]) => p.net !== 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([contractId, p]) => ({
          id: p.id as number,
          accountId,
          contractId,
          creationTimestamp: iso(p.openedAt as number),
          type: p.net > 0 ? 1 : 2,
          size: Math.abs(p.net),
          averagePrice: Math.round(p.averagePrice * 1e9) / 1e9,
          ...(trips?.[contractId] ? { roundTrip: trips[contractId] } : {}),
        }));
    }, metrics ? state0Contracts(this.config.statePath) : []);
  }

  private orderView(o: StoredOrder) {
    const c = specOf(o.contractId);
    return {
      id: o.id,
      accountId: o.accountId,
      contractId: o.contractId,
      symbolId: c ? `F.US.${c.root}` : null,
      creationTimestamp: iso(o.placedAt),
      updateTimestamp: iso(o.updatedAt),
      status: o.status,
      type: o.type,
      side: o.side,
      size: o.size,
      limitPrice: o.limitPrice,
      stopPrice: o.stopPrice,
      trailPrice: o.trailDistance,
      fillVolume: o.fillVolume,
      filledPrice: o.filledPrice,
      customTag: o.customTag,
      // Extra field: why the broker rejected the order at fill time (status 5), else null.
      rejectReason: o.rejectReason ?? null,
      // Extra field (allowed by the interface): bracket legs and closes only ever reduce the position.
      reduceOnly: o.role !== "order",
    };
  }

  openOrders(accountId: number) {
    return this.tx((state) => {
      this.assertAccount(state, accountId);
      return state.orders.filter((o) => o.status === STATUS.open).map((o) => this.orderView(o));
    });
  }

  searchOrders(accountId: number, start: string, end?: string | null) {
    return this.tx((state) => {
      this.assertAccount(state, accountId);
      const s = Date.parse(start);
      const e = end ? Date.parse(end) : Infinity;
      return state.orders.filter((o) => o.placedAt >= s && o.placedAt <= e).map((o) => this.orderView(o));
    });
  }

  /**
   * Fills in a window with their round-trip metrics (extra fields: `roundTripId` on every fill,
   * `exitReason` on a fill that reduced the position, `roundTrip` on the fill that ended one), and
   * the round trips that ended in the window. Round trips are built from the whole run, so one that
   * began before the window is complete.
   */
  tradeReport(accountId: number, start: string, end?: string | null): { trades: TradeWithMetrics[]; roundTrips: RoundTrip[] } {
    return this.tx((state, now) => {
      this.assertAccount(state, accountId);
      const s = Date.parse(start);
      const e = end ? Date.parse(end) : Infinity;
      const inWindow = (iso: string) => {
        const ts = Date.parse(iso);
        return ts >= s && ts <= e;
      };
      const { closed, fills } = this.roundTripsOf(state, now);
      const ended = new Map(closed.map((r) => [r.exitFillId, r]));
      const trades = state.trades
        .filter((t) => inWindow(t.creationTimestamp))
        .map((t) => {
          const f = fills.get(t.id);
          const trip = ended.get(t.id);
          return { ...t, ...(f ? { roundTripId: f.roundTripId } : {}), ...(f?.exitReason ? { exitReason: f.exitReason } : {}), ...(trip ? { roundTrip: trip } : {}) };
        });
      return { trades, roundTrips: closed.filter((r) => inWindow(r.exitTime as string)) };
    }, state0Contracts(this.config.statePath));
  }

  trades(accountId: number, start: string, end?: string | null): Trade[] {
    return this.tx((state) => {
      this.assertAccount(state, accountId);
      const s = Date.parse(start);
      const e = end ? Date.parse(end) : Infinity;
      return state.trades.filter((t) => {
        const ts = Date.parse(t.creationTimestamp);
        return ts >= s && ts <= e;
      });
    });
  }

  // ── Contracts and market data ───────────────────────────────────

  private contractView(c: ContractSpec, now: Date) {
    return {
      id: contractIdOf(c.root),
      name: frontMonthName(c, now),
      description: `${c.description} (replay of ${c.dataRoot}_1min.csv)`,
      tickSize: c.tickSize,
      tickValue: c.tickValue,
      activeContract: true,
      symbolId: `F.US.${c.root}`,
    };
  }

  private available(): ContractSpec[] {
    return Object.values(CONTRACTS).filter((c) => this.store.has(c.dataRoot));
  }

  searchContracts(searchText: string) {
    return this.tx((_state, now) => {
      const q = searchText.trim().toUpperCase();
      const all = this.available();
      const exact = all.filter((c) => c.root === q);
      const rest = all.filter((c) => c.root !== q && (c.root.includes(q) || c.description.toUpperCase().includes(q)));
      return [...exact, ...rest].slice(0, 20).map((c) => this.contractView(c, now));
    });
  }

  contract(contractId: string) {
    return this.tx((_state, now) => {
      const c = specOf(contractId);
      if (!c || !this.store.has(c.dataRoot)) throw new ReplayError(`Contract ${contractId} not found (ids look like BT.MNQ; use search_contracts).`);
      return this.contractView(c, now);
    });
  }

  allContracts() {
    return this.tx((_state, now) => this.available().map((c) => this.contractView(c, now)));
  }

  /** Per contract with data: its file and first/last bar (read cheaply from the file's head and tail). */
  dataRanges() {
    const out: Record<string, { file: string; first: string; last: string } | null> = {};
    for (const c of this.available()) {
      const r = this.store.range(c.dataRoot);
      out[c.root] = r ? { file: `${c.dataRoot}_1min.csv`, ...r } : null;
    }
    return out;
  }

  private series(contractId: string): { c: ContractSpec; s: BarSeries } {
    const c = specOf(contractId);
    if (!c || !this.store.has(c.dataRoot)) throw new ReplayError(`Contract ${contractId} not found (ids look like BT.MNQ; use search_contracts).`);
    return { c, s: this.store.get(c.dataRoot) };
  }

  bars(req: BarsRequest): OutBar[] {
    if (req.unit === "second" || req.unit === "month") {
      throw new ReplayError(`unit "${req.unit}" is not available in replay: bars are built from 1-minute data (use minute, hour, day or week).`);
    }
    return this.tx((_state, now) => {
      const { s } = this.series(req.contractId);
      const cutoff = this.cutoff(now);
      const end = req.endTime ? Math.min(Date.parse(req.endTime), cutoff) : cutoff;
      return aggregate(s, {
        unit: req.unit as AggUnit,
        unitNumber: req.unitNumber,
        limit: req.limit,
        from: req.startTime ? Date.parse(req.startTime) : null,
        to: end + 1, // endTime is inclusive: bars starting at or before it
        cutoff,
        partial: req.includePartialBar,
      });
    }, [req.contractId]);
  }

  /** The last closed 1-minute bar as a quote; null when the newest closed bar is over 15 minutes old (market closed). */
  quote(contractId: string) {
    return this.tx((_state, now) => {
      const { s } = this.series(contractId);
      const cutoff = this.cutoff(now);
      const n = s.closedCount(cutoff);
      if (n === 0) return null;
      const last = n - 1;
      const closedAt = s.t[last] + MINUTE;
      if (cutoff - closedAt > 15 * MINUTE) return null;
      const dayStart = tradingDayStart(new Date(s.t[last])).getTime();
      const first = s.lowerBound(dayStart);
      let high = -Infinity;
      let low = Infinity;
      let volume = 0;
      for (let i = first; i <= last; i++) {
        if (s.h[i] > high) high = s.h[i];
        if (s.l[i] < low) low = s.l[i];
        volume += s.v[i];
      }
      const prior = first > 0 ? s.c[first - 1] : null;
      const lastPrice = s.c[last];
      const change = prior === null ? 0 : Math.round((lastPrice - prior) * 1e9) / 1e9;
      return {
        ageMs: cutoff - closedAt,
        quote: {
          lastPrice,
          bestBid: lastPrice,
          bestAsk: lastPrice,
          change,
          changePercent: prior ? Math.round((change / prior) * 1e6) / 1e4 : 0,
          open: s.o[first],
          high,
          low,
          volume: Math.round(volume * 1e6) / 1e6,
          lastUpdated: iso(closedAt),
          timestamp: iso(closedAt),
        },
      };
    }, [contractId]);
  }

  // ── Orders ───────────────────────────────────────────────────────

  /**
   * Whether `contractId` trades at `now`: the next 1-minute bar at or after
   * now exists, inside the replay window, in the same trading day. A market
   * order fills at that bar's open. Returns that bar's index, or a reason.
   */
  private nextBar(s: BarSeries, now: Date): { index: number } | { reason: string } {
    const i = s.lowerBound(now.getTime());
    if (i >= s.length) return { reason: `no data after ${now.toISOString()}` };
    if (this.config.end !== null && s.t[i] > this.config.end) return { reason: "the next bar is after BACKTESTER_END" };
    if (tradingDayStart(new Date(s.t[i])).getTime() !== tradingDayStart(now).getTime()) {
      return { reason: `the market is closed at ${now.toISOString()}` };
    }
    return { index: i };
  }

  /** Fill a market order at once when the bar it fills on opens exactly now (the clock sits on a bar boundary). */
  private fillNowIfDue(state: State, contractId: string, c: ContractSpec, s: BarSeries, index: number, now: Date, orderId: number): void {
    if (s.t[index] > now.getTime()) return;
    const book = this.book(state, contractId);
    const fs = this.spec(c);
    const o = book.orders.find((x) => x.id === orderId && x.status === STATUS.open);
    if (!o) return;
    fillOrder(book, o, marketFillPrice(s.o[index], o.side, fs), s.t[index], fs, this.ids(state), this.hooks(state, contractId));
    this.adopt(state, book, contractId);
  }

  /**
   * No bar is left to fill on before BACKTESTER_END: the clock is at or past END (">=": a bar
   * opening at END would close after it), or the next bar after the clock opens after END (or
   * there is none) while a window is set.
   */
  private ended(now: Date, s: BarSeries): boolean {
    if (this.config.end === null) return false;
    if (now.getTime() >= this.config.end) return true;
    const i = s.lowerBound(now.getTime());
    return i >= s.length || s.t[i] > this.config.end;
  }

  /**
   * After the window: fill at the last close at or before BACKTESTER_END, without slippage, as the
   * harness backtester settles a trade still open at the end of its data (reason "end").
   */
  private fillAtEnd(state: State, contractId: string, c: ContractSpec, s: BarSeries, now: Date, orderId: number): void {
    const last = this.lastClose(s, now);
    const book = this.book(state, contractId);
    const o = book.orders.find((x) => x.id === orderId && x.status === STATUS.open);
    if (last === null || !o) return;
    (o as StoredOrder).endOfWindow = true;
    const fs = this.spec(c);
    fillOrder(book, o, onTick(last, c.tickSize), this.cutoff(now), fs, this.ids(state), this.hooks(state, contractId));
    this.adopt(state, book, contractId);
  }

  private lastClose(s: BarSeries, now: Date): number | null {
    const n = s.closedCount(this.cutoff(now));
    return n ? s.c[n - 1] : null;
  }

  place(req: PlaceRequest): Outcome & { orderId: number | null } {
    return this.tx((state, now) => {
      const no = (code: number, msg: string) => ({ orderId: null, ...refuse(code, msg) });
      if (req.accountId !== state.accountId) return no(1, `Account ${req.accountId} not found.`);
      const c = specOf(req.contractId);
      if (!c) return no(8, `Contract ${req.contractId} not found.`);
      if (!this.store.has(c.dataRoot)) return no(9, `No data for ${c.root} (${c.dataRoot}_1min.csv) in BACKTESTER_DATA_DIR.`);
      const s = this.store.get(c.dataRoot);
      const ended = this.ended(now, s);
      if (ended) {
        // After BACKTESTER_END only a market order that reduces the position is taken: it fills at the last close.
        const net = state.positions[req.contractId]?.net ?? 0;
        const reduces = req.type === ORDER_TYPES.market && net !== 0 && Math.sign(net) !== sideSign(req.side) && req.size <= Math.abs(net);
        if (!reduces) return no(5, "The replay is over (no bar left before BACKTESTER_END): only market orders that reduce the position are taken, at the last close.");
      }
      const next = ended ? { index: -1 } : this.nextBar(s, now);
      if ("reason" in next) return no(5, `Outside trading hours: ${next.reason}.`);
      if (req.customTag !== null && state.orders.some((o) => o.customTag === req.customTag)) {
        return no(2, `customTag "${req.customTag}" is already used on this account.`);
      }
      for (const [name, p] of [["limitPrice", req.limitPrice], ["stopPrice", req.stopPrice], ["trailPrice", req.trailPrice]] as const) {
        if (p !== null && !isOnTick(p, c.tickSize)) return no(2, `${name} ${p} is not a multiple of the tick size ${c.tickSize}.`);
      }
      for (const [name, b] of [["stopLossBracket", req.stopLossBracket], ["takeProfitBracket", req.takeProfitBracket]] as const) {
        if (!b) continue;
        if (!Number.isInteger(b.ticks) || b.ticks === 0) return no(2, `${name}.ticks must be a non-zero whole number of ticks.`);
        if (!isStopType(b.type) && !isLimitType(b.type)) return no(2, `${name}.type must be stop, trailing_stop or limit.`);
      }
      let limitPrice = isLimitType(req.type) ? req.limitPrice : null;
      let stopPrice = req.type === ORDER_TYPES.stop ? req.stopPrice : null;
      let trailDistance: number | null = null;
      const last = this.lastClose(s, now);
      if (req.type === ORDER_TYPES.join_bid || req.type === ORDER_TYPES.join_ask) {
        if (last === null) return no(2, "No price yet to join.");
        limitPrice = last;
      }
      if (req.type === ORDER_TYPES.trailing_stop) {
        if (last === null || req.trailPrice === null) return no(2, "No price yet to trail from.");
        const wrongSide = req.side === 1 ? req.trailPrice >= last : req.trailPrice <= last;
        if (wrongSide) return no(2, `A ${req.side === 1 ? "sell" : "buy"} trailing stop must sit ${req.side === 1 ? "below" : "above"} the last price ${last}.`);
        stopPrice = req.trailPrice;
        trailDistance = Math.round(Math.abs(last - req.trailPrice) * 1e9) / 1e9;
      }
      const t = now.getTime();
      const order: StoredOrder = {
        id: state.nextOrderId++,
        accountId: state.accountId,
        contractId: req.contractId,
        side: req.side,
        type: req.type,
        size: req.size,
        limitPrice,
        stopPrice,
        trailDistance,
        status: STATUS.open,
        placedAt: t,
        activeFrom: t,
        updatedAt: t,
        role: "order",
        parentId: null,
        stopLossBracket: req.stopLossBracket,
        takeProfitBracket: req.takeProfitBracket,
        fillVolume: 0,
        filledPrice: null,
        customTag: req.customTag,
      };
      if (stopPrice !== null) order.stopAt = [[t, stopPrice]];
      state.orders.push(order);
      if (ended) this.fillAtEnd(state, req.contractId, c, s, now, order.id);
      else if (req.type === ORDER_TYPES.market) this.fillNowIfDue(state, req.contractId, c, s, next.index, now, order.id);
      return { orderId: order.id, ...OK };
    }, [req.contractId]);
  }

  modify(req: ModifyRequest): Outcome {
    return this.tx((state, now) => {
      if (req.accountId !== state.accountId) return refuse(1, `Account ${req.accountId} not found.`);
      const o = state.orders.find((x) => x.id === req.orderId);
      if (!o || o.status !== STATUS.open) return refuse(2, `No working order ${req.orderId}.`);
      const c = specOf(o.contractId) as ContractSpec;
      if (o.type === ORDER_TYPES.market) return refuse(3, "A market order waiting for the next bar can't be modified; cancel it instead.");
      for (const [name, p] of [["limitPrice", req.limitPrice], ["stopPrice", req.stopPrice], ["trailPrice", req.trailPrice]] as const) {
        if (p !== null && !isOnTick(p, c.tickSize)) return refuse(3, `${name} ${p} is not a multiple of the tick size ${c.tickSize}.`);
      }
      if (req.limitPrice !== null && !isLimitType(o.type)) return refuse(3, "limitPrice applies to limit orders only.");
      if (req.stopPrice !== null && o.type !== ORDER_TYPES.stop) return refuse(3, "stopPrice applies to stop orders only.");
      if (req.trailPrice !== null && o.type !== ORDER_TYPES.trailing_stop) return refuse(3, "trailPrice applies to trailing stops only.");
      const patch: Partial<SimOrder> = {};
      if (req.size !== null) patch.size = req.size;
      if (req.limitPrice !== null) patch.limitPrice = req.limitPrice;
      if (req.stopPrice !== null) patch.stopPrice = req.stopPrice;
      if (req.trailPrice !== null) {
        const last = this.lastClose(this.store.get(c.dataRoot), now);
        if (last === null) return refuse(3, "No price yet to trail from.");
        patch.stopPrice = req.trailPrice;
        patch.trailDistance = Math.round(Math.abs(last - req.trailPrice) * 1e9) / 1e9;
      }
      // A modify takes effect at once, as at a live broker: the bar in progress (not yet settled)
      // is checked on the new terms, so a resting order is never skipped for a bar, and a smaller
      // order can't fill at its old size beside a replacement.
      if (typeof patch.stopPrice === "number" && o.stopPrice !== null) {
        o.stopAt ??= [[o.placedAt, o.stopPrice]];
        o.stopAt.push([now.getTime(), patch.stopPrice]);
      }
      Object.assign(o, patch, { updatedAt: now.getTime() });
      return OK;
    });
  }

  cancel(accountId: number, orderId: number): Outcome {
    return this.tx((state, now) => {
      if (accountId !== state.accountId) return refuse(1, `Account ${accountId} not found.`);
      const o = state.orders.find((x) => x.id === orderId);
      if (!o || o.status !== STATUS.open) return refuse(2, `No working order ${orderId}.`);
      // A cancel takes effect at once, as at a live broker and the harness sim-broker's cancel().
      Object.assign(o, { status: STATUS.cancelled, updatedAt: now.getTime() });
      return OK;
    });
  }

  /** Close `size` contracts (all when null) of a position at market: the next bar's open plus slippage. */
  close(accountId: number, contractId: string, size: number | null): Outcome {
    return this.tx((state, now) => {
      if (accountId !== state.accountId) return refuse(1, `Account ${accountId} not found.`);
      const c = specOf(contractId);
      if (!c) return refuse(3, `Contract ${contractId} not found.`);
      if (!this.store.has(c.dataRoot)) return refuse(4, `No data for ${c.root}.`);
      const held = state.positions[contractId]?.net ?? 0;
      const s = this.store.get(c.dataRoot);
      const ended = this.ended(now, s);
      const next = ended ? { index: -1 } : this.nextBar(s, now);
      const closes = state.orders.filter((o) => o.contractId === contractId && o.status === STATUS.open && o.role === "close");
      const flat = closes.filter((o) => o.flatten).at(-1);
      // With a close_position waiting, what is left to close is what the client sent after it.
      const after = (o: StoredOrder) => !flat || o.id > flat.id;
      const later = flat
        ? state.orders.filter((o) => o.contractId === contractId && o.status === STATUS.open && o.role === "order" && o.type === ORDER_TYPES.market && after(o))
        : [];
      const ref = flat ? later.reduce((n, o) => n + sideSign(o.side) * o.size, 0) : held;
      if (size === null) {
        // The same request again is a no-op only with no market order sent since; any later one (even
        // if they net to zero: one may be rejected at fill) moves the close after them.
        if (flat && later.length === 0) return OK;
        if (!flat && held === 0) return refuse(2, `No open position in ${contractId}.`);
      } else {
        if (ref === 0) {
          return flat
            ? refuse(7, "A close_position is already waiting for the next bar and nothing sent after it is left to close.")
            : refuse(2, `No open position in ${contractId}.`);
        }
        if (size > Math.abs(ref)) return refuse(5, `Close size ${size} is larger than the position${flat ? " left after the waiting close_position" : ""} (${Math.abs(ref)}).`);
        const waiting = closes.filter((o) => !o.flatten && after(o)).reduce((n, o) => n + o.size, 0);
        if (waiting + size > Math.abs(ref)) return refuse(7, `Partial closes for ${waiting} are already waiting for the next bar; ${Math.abs(ref) - waiting} left to close.`);
      }
      // Refuse before touching anything: a refusal never drops the waiting close.
      if ("reason" in next) return refuse(6, `Order rejected: ${next.reason}.`);
      // close_position is "flat after everything sent before it": with a client market order sent
      // after the waiting close, the close moves to the end of the arrival order.
      if (flat && size === null) Object.assign(flat, { status: STATUS.cancelled, updatedAt: now.getTime() });
      const qty = size ?? Math.abs(ref);
      const side: Side = ref > 0 ? 1 : 0;
      const t = now.getTime();
      const id = state.nextOrderId++;
      state.orders.push({
        id,
        accountId,
        contractId,
        side,
        type: ORDER_TYPES.market,
        size: qty,
        limitPrice: null,
        stopPrice: null,
        trailDistance: null,
        status: STATUS.open,
        placedAt: t,
        activeFrom: t,
        updatedAt: t,
        role: "close",
        flatten: size === null,
        parentId: null,
        stopLossBracket: null,
        takeProfitBracket: null,
        fillVolume: 0,
        filledPrice: null,
        customTag: null,
      });
      if (ended) this.fillAtEnd(state, contractId, c, s, now, id);
      else this.fillNowIfDue(state, contractId, c, s, next.index, now, id);
      return OK;
    }, [contractId]);
  }

  /** The id of a close_position waiting on the contract (it will leave it flat), or null. */
  waitingClose(accountId: number, contractId: string): number | null {
    return this.tx((state) => {
      this.assertAccount(state, accountId);
      const o = state.orders.filter((x) => x.contractId === contractId && x.status === STATUS.open && x.role === "close" && x.flatten).at(-1);
      return o ? o.id : null;
    }, [contractId]);
  }

  /** Signed net position of a contract (for the guardrails). */
  netPosition(accountId: number, contractId: string): number {
    return this.tx((state) => {
      this.assertAccount(state, accountId);
      return state.positions[contractId]?.net ?? 0;
    });
  }
}

