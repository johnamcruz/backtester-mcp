/**
 * Bracket rules and the protection check after a bracketed market entry, mirroring projectx-mcp's
 * src/protect.ts so the harness sees the same results from this replay broker as from the live one:
 * the same minimum bracket distance, the same bracket signs, the same `protection` object
 * (status, stopOrderId, filledSize, fillPrice, targetPlaced, message) and messages, and the same
 * flatten result (close, cancel the contract's working orders once flat, verify).
 *
 * projectx-mcp polls a remote broker within a 9.5 s budget; here every read is of the replay
 * state, which is final at once, so the same decisions are taken without waiting: a fill that has
 * not happened by the time place_order returns is "not filled in time" (the market order is
 * waiting for the next bar's open), and a stop leg that is not there is "not confirmed".
 */
import { ORDER_TYPES, SIDES } from "./enums.js";

/** Smallest bracket distance place_order accepts, in ticks (projectx-mcp's MIN_BRACKET_TICKS). */
export const MIN_BRACKET_TICKS = 4;
/** projectx-mcp answers every order tool within this; the replay answers well within it. */
export const CALL_BUDGET_MS = 9_500;

type Row = Record<string, unknown>;

const FILLED = 2;
const ENDED_WITHOUT_FILL = [3, 4, 5]; // cancelled, expired, rejected
const STATUS_NAMES: Record<number, string> = { 3: "cancelled", 4: "expired", 5: "rejected" };
const STOP_TYPES: number[] = [ORDER_TYPES.stop, ORDER_TYPES.trailing_stop];

/** Signed bracket ticks as projectx-mcp sends them: long stop below (-), target above (+); short the reverse. */
export function signedBrackets(side: "buy" | "sell", stopTicks: number | undefined, targetTicks: number | undefined) {
  const s = side === "buy" ? 1 : -1;
  return {
    stop: stopTicks === undefined ? undefined : -s * Math.abs(stopTicks),
    target: targetTicks === undefined ? undefined : s * Math.abs(targetTicks),
  };
}

/** Why a bracket is refused before anything is sent (projectx-mcp's place_order checks), or null. */
export function bracketRefusal(label: "stopLossBracket" | "takeProfitBracket", ticks: number): string | null {
  const n = Math.abs(ticks);
  if (!Number.isInteger(n)) return `${label}.ticks must be a whole number of ticks.`;
  if (n < MIN_BRACKET_TICKS) return `${label} is ${n} ticks; the minimum bracket distance is ${MIN_BRACKET_TICKS} ticks.`;
  return null;
}

export interface PositionState {
  /** +long / -short. Replay positions always have a direction. */
  net: number;
  /** Total open size on the contract. Flat means 0. */
  size: number;
  averagePrice: number | null;
}

/** The position on one contract from position rows (type 1 long, 2 short). */
export function positionOn(positions: Row[], contractId: string): PositionState {
  const rows = positions.filter((p) => p.contractId === contractId && Math.abs(Number(p.size) || 0) > 0);
  const size = rows.reduce((n, p) => n + Math.abs(Number(p.size)), 0);
  const net = rows.reduce((n, p) => n + (p.type === 1 ? 1 : -1) * Math.abs(Number(p.size)), 0);
  return { net, size, averagePrice: (rows[0]?.averagePrice as number | undefined) ?? null };
}

export type FlatStatus = "flat" | "still_open" | "legs_left";
export interface FlattenResult {
  status: FlatStatus;
  close: { success: boolean; errorCode?: number; errorMessage?: string | null };
  /** Net position at the end (null when it could not be read). */
  positionNet: number | null;
  /** Total open size at the end (null when it could not be read). */
  positionSize: number | null;
  cancelledOrderIds: number[];
  /** Orders the cancel step tried and failed to cancel. */
  failedCancelOrderIds: number[];
  /** Working orders still on the contract (null when they could not be read). */
  remainingOrderIds: number[] | null;
}

export type ProtectionStatus = "protected" | "flattened_stop_unconfirmed" | "pending_fill" | "not_filled" | "unknown";
export interface Protection {
  status: ProtectionStatus;
  stopOrderId: number | null;
  filledSize: number | null;
  fillPrice: number | null;
  targetPlaced: boolean;
  message: string;
  flatten?: FlattenResult;
}

/** The protection a resting entry with a stop-loss bracket gets (projectx-mcp, word for word). */
export const pendingFill = (targetRequested: boolean): Protection => ({
  status: "pending_fill",
  stopOrderId: null,
  filledSize: null,
  fillPrice: null,
  targetPlaced: targetRequested,
  message: "Resting entry: its bracket legs attach when it fills.",
});

/** What the protection check reads and does; each call is one transaction on the replay state. */
export interface EntryOps {
  /** The entry order as search_orders shows it, or null. */
  order(): Row | null;
  position(): PositionState;
  /** Working orders on the contract. */
  ordersOn(): Row[];
  /** Cancel the entry; true when the broker took the cancel. */
  cancelEntry(): boolean;
  flatten(): FlattenResult;
  note(text: string, data: unknown): Promise<void>;
}

export interface EntryInput {
  contractId: string;
  side: "buy" | "sell";
  orderId: number;
  /** The position on the contract before the entry. */
  before: PositionState;
  targetRequested: boolean;
}

/**
 * After an accepted bracketed market entry that opens: confirm the fill, then that working stops
 * cover the whole new position on the side opposite it, else flatten (projectx-mcp's protectEntry,
 * step for step). It never places a stop of its own.
 */
export async function protectEntry(ops: EntryOps, e: EntryInput): Promise<Protection> {
  const { contractId, side, before } = e;
  const sign = side === "buy" ? 1 : -1;
  const base = { stopOrderId: null, filledSize: null as number | null, fillPrice: null as number | null, targetPlaced: e.targetRequested };
  let order = ops.order();
  let st = ops.position();

  const fillVolume = (o: Row | null) => Number(o?.fillVolume) || 0;
  const filled = (o: Row | null) => o !== null && (o.status === FILLED || (ENDED_WITHOUT_FILL.includes(o.status as number) && fillVolume(o) > 0));
  const endedEmpty = (o: Row | null) => o !== null && ENDED_WITHOUT_FILL.includes(o.status as number) && fillVolume(o) === 0;
  const moved = (s: PositionState) => (s.net - before.net) * sign > 0;
  const fillOf = () => {
    const delta = (st.net - before.net) * sign;
    return {
      filledSize: filled(order) ? fillVolume(order) || (order!.size as number) : delta > 0 ? delta : null,
      fillPrice: (order?.filledPrice as number | null | undefined) ?? st.averagePrice ?? null,
    };
  };

  const giveUp = async (why: string): Promise<Protection> => {
    const fill = fillOf();
    const fl = ops.flatten();
    await ops.note(`flatten after unconfirmed stop: ${why} -> ${fl.status}`, fl);
    if (fl.status === "flat") {
      return { ...base, ...fill, status: "flattened_stop_unconfirmed", targetPlaced: false, flatten: fl, message: `The entry ${why}, so the server closed the position and cancelled its orders. The account is flat on ${contractId}.` };
    }
    return {
      ...base, ...fill, status: "unknown", targetPlaced: false, flatten: fl,
      message:
        `UNPROTECTED POSITION MAY BE OPEN on ${contractId}: the entry ${why}, and closing it could not be confirmed (${fl.status}). ` +
        "Call close_position for this contract now, then check list_open_positions and list_open_orders and protect or close what is left. Never re-send the entry.",
    };
  };

  // 1. The fill. The replay state is final: an entry that ended empty is not filled.
  if (!filled(order) && endedEmpty(order) && !moved(st)) {
    return { ...base, status: "not_filled", targetPlaced: false, message: `The broker ended the market entry without a fill (${STATUS_NAMES[order!.status as number] ?? order!.status}); this entry opened nothing, and any earlier position is unchanged.` };
  }

  // 2. Not filled when place_order answers (it waits for the next bar's open): cancel it, then see what is open.
  if (!filled(order) && !(order === null && moved(st))) {
    const ok = ops.cancelEntry();
    await ops.note(`fill not confirmed in time: cancel entry ${e.orderId}: ${ok ? "ok" : "failed"}`, { success: ok });
    order = ops.order();
    st = ops.position();
    if (!filled(order) && endedEmpty(order) && !moved(st)) {
      return { ...base, status: "not_filled", targetPlaced: false, message: "The market entry was not filled within the check window, so the server cancelled it; this entry opened nothing, and any earlier position is unchanged." };
    }
    return giveUp("was not confirmed filled in time");
  }

  // 3. Working stops must cover the whole new position, on the side opposite it.
  st = ops.position();
  // (A replay position always has a direction, so projectx-mcp's typeless branch never applies.)
  if (st.net !== 0) {
    const coverSide = st.net > 0 ? SIDES.sell : SIDES.buy;
    const required = Math.abs(st.net);
    const stops = ops.ordersOn().filter((o) => STOP_TYPES.includes(o.type as number) && o.side === coverSide);
    if (stops.reduce((n, o) => n + (Number(o.size) || 0), 0) >= required) {
      return { ...base, ...fillOf(), status: "protected", stopOrderId: stops[0].id as number, message: "The entry filled and its stop is working." };
    }
  }
  return giveUp("filled but its stop leg was not confirmed in time");
}
