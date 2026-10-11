import { describe, expect, it } from "vitest";
import { ORDER_TYPES, SIDES, decorateOrder, decoratePosition, decorateTrade } from "../src/enums.js";

describe("enum decoration", () => {
  it("names order, position, and trade enums", () => {
    expect(decorateOrder({ status: 5, type: 5, side: 1 })).toMatchObject({ statusName: "rejected", typeName: "trailing_stop", sideName: "sell" });
    expect(decorateOrder({ status: 99, type: 0, side: 0 })).toMatchObject({ statusName: "unknown(99)", typeName: "unknown(0)", sideName: "buy" });
    expect(decoratePosition({ type: 2 }).direction).toBe("short");
    expect(decorateTrade({ side: 0, profitAndLoss: 5 })).toMatchObject({ sideName: "buy", halfTurn: false });
  });

  it("uses the interface's codes", () => {
    expect(ORDER_TYPES).toEqual({ limit: 1, market: 2, stop_limit: 3, stop: 4, trailing_stop: 5, join_bid: 6, join_ask: 7 });
    expect(SIDES).toEqual({ buy: 0, sell: 1 });
  });
});
