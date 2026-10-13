import { describe, expect, it } from "vitest";
import { bracketRefusal, pendingFill, positionOn, protectEntry, signedBrackets, type EntryOps, type FlattenResult, type PositionState } from "../src/protect.js";

const C = "BT.MNQ";
const flatFl: FlattenResult = { status: "flat", close: { success: true, errorCode: 0, errorMessage: null }, positionNet: 0, positionSize: 0, cancelledOrderIds: [3], failedCancelOrderIds: [], remainingOrderIds: [] };
const openFl: FlattenResult = { ...flatFl, status: "still_open", positionNet: 1, positionSize: 1, cancelledOrderIds: [], remainingOrderIds: null };
const pos = (net: number, averagePrice: number | null = 20000.25): PositionState => ({ net, size: Math.abs(net), averagePrice: net ? averagePrice : null });
const stop = (id: number, side: number, size = 1, type = 4) => ({ id, contractId: C, side, size, type, status: 1 });

/** Fake replay reads: the order and position before and after a cancel, the working orders, the flatten. */
function ops(o: { order: Record<string, unknown> | null; after?: Record<string, unknown> | null; position: PositionState; positionAfter?: PositionState; orders?: Record<string, unknown>[]; cancelOk?: boolean; flatten?: FlattenResult }) {
  const log: string[] = [];
  let cancelled = false;
  const api: EntryOps = {
    order: () => (cancelled && o.after !== undefined ? o.after : o.order),
    position: () => (cancelled && o.positionAfter ? o.positionAfter : o.position),
    ordersOn: () => o.orders ?? [],
    cancelEntry: () => {
      cancelled = true;
      log.push("cancel");
      return o.cancelOk ?? true;
    },
    flatten: () => {
      log.push("flatten");
      return o.flatten ?? flatFl;
    },
    note: async (text) => {
      log.push(text);
    },
  };
  return { api, log };
}
const entry = (p: Partial<Parameters<typeof protectEntry>[1]> = {}) => ({ contractId: C, side: "buy" as const, orderId: 1, before: pos(0), targetRequested: true, ...p });

describe("bracket rules (projectx-mcp's)", () => {
  it.each([
    ["buy", 10, 20, -10, 20],
    ["sell", 10, 20, 10, -20],
    ["buy", -10, -20, -10, 20],
    ["sell", -6, 8, 6, -8],
  ] as const)("signs %s brackets by side (stop %i, target %i)", (side, sl, tp, wantSl, wantTp) => {
    expect(signedBrackets(side, sl, tp)).toEqual({ stop: wantSl, target: wantTp });
  });

  it("leaves a missing bracket out", () => {
    expect(signedBrackets("buy", undefined, undefined)).toEqual({ stop: undefined, target: undefined });
  });

  it("refuses a distance under 4 ticks, whatever its sign, and a fractional one", () => {
    expect(bracketRefusal("stopLossBracket", 3)).toBe("stopLossBracket is 3 ticks; the minimum bracket distance is 4 ticks.");
    expect(bracketRefusal("stopLossBracket", -3)).toBe("stopLossBracket is 3 ticks; the minimum bracket distance is 4 ticks.");
    expect(bracketRefusal("takeProfitBracket", 0)).toBe("takeProfitBracket is 0 ticks; the minimum bracket distance is 4 ticks.");
    expect(bracketRefusal("takeProfitBracket", 4.5)).toBe("takeProfitBracket.ticks must be a whole number of ticks.");
    expect(bracketRefusal("stopLossBracket", 4)).toBeNull();
    expect(bracketRefusal("stopLossBracket", -4)).toBeNull();
  });

  it("positionOn nets the contract's rows", () => {
    expect(positionOn([{ contractId: C, type: 2, size: 2, averagePrice: 5 }, { contractId: "X", type: 1, size: 9 }], C)).toEqual({ net: -2, size: 2, averagePrice: 5 });
    expect(positionOn([], C)).toEqual({ net: 0, size: 0, averagePrice: null });
  });

  it("pendingFill is projectx-mcp's object", () => {
    expect(pendingFill(false)).toEqual({ status: "pending_fill", stopOrderId: null, filledSize: null, fillPrice: null, targetPlaced: false, message: "Resting entry: its bracket legs attach when it fills." });
  });
});

describe("protectEntry", () => {
  it("protected: filled, and stops on the opposite side cover the new position", async () => {
    const { api, log } = ops({ order: { id: 1, status: 2, size: 1, fillVolume: 1, filledPrice: 20000.25 }, position: pos(1), orders: [stop(2, 1), stop(3, 0)] });
    expect(await protectEntry(api, entry())).toEqual({ status: "protected", stopOrderId: 2, filledSize: 1, fillPrice: 20000.25, targetPlaced: true, message: "The entry filled and its stop is working." });
    expect(log).toEqual([]);
  });

  it("a trailing stop covers too; a short needs a buy stop", async () => {
    const { api } = ops({ order: { id: 1, status: 2, size: 1, fillVolume: 1, filledPrice: 19999.75 }, position: pos(-1), orders: [stop(2, 1), stop(4, 0, 1, 5)] });
    expect((await protectEntry(api, entry({ side: "sell" }))).stopOrderId).toBe(4);
  });

  it("flattens when the stops cover only part of the position, and places no stop of its own", async () => {
    const { api, log } = ops({ order: { id: 1, status: 2, size: 1, fillVolume: 1, filledPrice: 20000.25 }, position: pos(2), orders: [stop(2, 1), { ...stop(3, 1), type: 1 }] });
    const p = await protectEntry(api, entry({ before: pos(1) }));
    expect(p).toMatchObject({ status: "flattened_stop_unconfirmed", filledSize: 1, fillPrice: 20000.25, targetPlaced: false, flatten: flatFl });
    expect(p.message).toBe("The entry filled but its stop leg was not confirmed in time, so the server closed the position and cancelled its orders. The account is flat on BT.MNQ.");
    expect(log).toEqual(["flatten", "flatten after unconfirmed stop: filled but its stop leg was not confirmed in time -> flat"]);
  });

  it("unknown when the flatten is not confirmed", async () => {
    const { api } = ops({ order: { id: 1, status: 2, size: 1, fillVolume: 1, filledPrice: 20000.25 }, position: pos(1), flatten: openFl });
    const p = await protectEntry(api, entry());
    expect(p.status).toBe("unknown");
    expect(p.message).toBe(
      "UNPROTECTED POSITION MAY BE OPEN on BT.MNQ: the entry filled but its stop leg was not confirmed in time, and closing it could not be confirmed (still_open). " +
        "Call close_position for this contract now, then check list_open_positions and list_open_orders and protect or close what is left. Never re-send the entry.",
    );
  });

  it("not_filled when the broker ended the entry empty (rejected at fill)", async () => {
    const { api, log } = ops({ order: { id: 1, status: 5, size: 1, fillVolume: 0, filledPrice: null }, position: pos(0) });
    expect(await protectEntry(api, entry())).toEqual({
      status: "not_filled", stopOrderId: null, filledSize: null, fillPrice: null, targetPlaced: false,
      message: "The broker ended the market entry without a fill (rejected); this entry opened nothing, and any earlier position is unchanged.",
    });
    expect(log).toEqual([]);
  });

  it("not_filled after cancelling an entry still waiting", async () => {
    const { api, log } = ops({ order: { id: 1, status: 1, size: 1, fillVolume: 0 }, after: { id: 1, status: 3, size: 1, fillVolume: 0 }, position: pos(0) });
    const p = await protectEntry(api, entry());
    expect(p).toMatchObject({ status: "not_filled", message: "The market entry was not filled within the check window, so the server cancelled it; this entry opened nothing, and any earlier position is unchanged." });
    expect(log).toEqual(["cancel", "fill not confirmed in time: cancel entry 1: ok"]);
  });

  it("flattens when the cancel of a waiting entry fails and it filled meanwhile", async () => {
    const { api, log } = ops({
      order: { id: 1, status: 1, size: 1, fillVolume: 0 }, after: { id: 1, status: 2, size: 1, fillVolume: 1, filledPrice: 20000.25 },
      position: pos(0), positionAfter: pos(1), cancelOk: false,
    });
    const p = await protectEntry(api, entry());
    expect(p).toMatchObject({ status: "flattened_stop_unconfirmed", filledSize: 1, fillPrice: 20000.25 });
    expect(log.slice(0, 2)).toEqual(["cancel", "fill not confirmed in time: cancel entry 1: failed"]);
    expect(log.at(-1)).toBe("flatten after unconfirmed stop: was not confirmed filled in time -> flat");
  });

  it("measures the fill from the position when the order is not found", async () => {
    const { api } = ops({ order: null, position: pos(2, 20001), orders: [stop(2, 1, 2)] });
    expect(await protectEntry(api, entry({ before: pos(1) }))).toMatchObject({ status: "protected", filledSize: 1, fillPrice: 20001 });
  });

  it("an unknown order with no position change is not confirmed: cancelled, then flattened", async () => {
    const { api } = ops({ order: null, position: pos(0) });
    const p = await protectEntry(api, entry());
    expect(p).toMatchObject({ status: "flattened_stop_unconfirmed", filledSize: null, fillPrice: null });
  });

  it("an entry ended with a partial fill counts as filled (fillVolume)", async () => {
    const { api } = ops({ order: { id: 1, status: 3, size: 2, fillVolume: 1, filledPrice: 20000.25 }, position: pos(1), orders: [stop(2, 1)] });
    expect(await protectEntry(api, entry())).toMatchObject({ status: "protected", filledSize: 1 });
  });

  it("an entry that left the position flat is flattened (nothing to protect)", async () => {
    const { api } = ops({ order: { id: 1, status: 2, size: 1, fillVolume: 1, filledPrice: 20000.25 }, position: pos(0) });
    expect((await protectEntry(api, entry({ before: pos(-1) }))).status).toBe("flattened_stop_unconfirmed");
  });
});

describe("protectEntry: a flatten that isn't flat", () => {
  it.each(["still_open", "legs_left"] as const)("maps a %s flatten to unknown", async (status) => {
    const { api } = ops({ order: { id: 1, status: 2, size: 1, fillVolume: 1, filledPrice: 20000.25 }, position: pos(1), flatten: { ...openFl, status } });
    const p = await protectEntry(api, entry());
    expect(p).toMatchObject({ status: "unknown", targetPlaced: false, flatten: { status } });
    expect(p.message).toContain(`could not be confirmed (${status})`);
  });
});
