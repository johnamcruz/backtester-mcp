import { describe, expect, it } from "vitest";
import {
  STATUS,
  applyFill,
  bracketPrice,
  closeBar,
  closePnl,
  feesFor,
  fillOrder,
  limitFillPrice,
  limitTriggered,
  marketFillPrice,
  onTick,
  openBar,
  stopFillPrice,
  stopTriggered,
  termsOn,
  trailStep,
  type Book,
  type FillSpec,
  type Ids,
  type SimOrder,
} from "../src/fills.js";

// MNQ: tick 0.25, $0.50 per tick; micro fee $0.37 per side; 1 tick of slippage.
const MNQ: FillSpec = { tickSize: 0.25, tickValue: 0.5, feePerSide: 0.37, slippageTicks: 1 };
const T = Date.parse("2024-03-05T15:00:00Z");
const M = 60000;
const bar = (o: number, h: number, l: number, c: number, t = T) => ({ t, o, h, l, c });

function ids(): Ids {
  let o = 100;
  let p = 1;
  return { order: () => o++, position: () => p++ };
}

function order(p: Partial<SimOrder>): SimOrder {
  return {
    id: 1, side: 0, type: 2, size: 1, limitPrice: null, stopPrice: null, trailDistance: null, status: STATUS.open,
    placedAt: T, activeFrom: T, updatedAt: T, role: "order", parentId: null, stopLossBracket: null, takeProfitBracket: null,
    fillVolume: 0, filledPrice: null, customTag: null, ...p,
  };
}

const emptyBook = (orders: SimOrder[] = []): Book => ({ orders, position: { id: null, net: 0, averagePrice: 0, openedAt: null } });

describe("price rules (sim-broker.js)", () => {
  it("market: next bar's open plus slippage in the order's direction (fillAtOpen)", () => {
    expect(marketFillPrice(20000, 0, MNQ)).toBe(20000.25);
    expect(marketFillPrice(20000, 1, MNQ)).toBe(19999.75);
    expect(marketFillPrice(20000, 0, { ...MNQ, slippageTicks: 0 })).toBe(20000);
  });

  it("stop: the stop less slippage, or the open when the bar gapped through (onBar)", () => {
    expect(stopTriggered(bar(100, 101, 98.75, 99), 1, 99)).toBe(true);
    expect(stopTriggered(bar(100, 101, 99.25, 99.5), 1, 99)).toBe(false);
    expect(stopFillPrice(bar(100, 101, 98, 99), 1, 99, MNQ)).toBe(98.75);
    expect(stopFillPrice(bar(97, 98, 96, 97), 1, 99, MNQ)).toBe(96.75); // gap down through a sell stop
    expect(stopTriggered(bar(100, 101.25, 99, 101), 0, 101)).toBe(true);
    expect(stopFillPrice(bar(100, 102, 99, 101), 0, 101, MNQ)).toBe(101.25);
    expect(stopFillPrice(bar(103, 104, 102, 103), 0, 101, MNQ)).toBe(103.25); // gap up through a buy stop
  });

  it("limit: the limit or a better open, no slippage (onBar)", () => {
    expect(limitTriggered(bar(100, 101, 99, 100), 1, 101)).toBe(true);
    expect(limitTriggered(bar(100, 100.75, 99, 100), 1, 101)).toBe(false);
    expect(limitFillPrice(bar(100, 101, 99, 100), 1, 101)).toBe(101);
    expect(limitFillPrice(bar(102, 103, 101.5, 102), 1, 101)).toBe(102); // gapped past the target: the better open
    expect(limitTriggered(bar(100, 101, 99, 100), 0, 99)).toBe(true);
    expect(limitFillPrice(bar(98, 99, 97, 98), 0, 99)).toBe(98);
  });

  it("brackets sit ticks from the fill, slippage included (fillAtOpen)", () => {
    expect(bracketPrice(20000.25, 0, 20, "sl", 0.25)).toBe(19995.25);
    expect(bracketPrice(20000.25, 0, 40, "tp", 0.25)).toBe(20010.25);
    expect(bracketPrice(19999.75, 1, 20, "sl", 0.25)).toBe(20004.75);
    expect(bracketPrice(19999.75, 1, -40, "tp", 0.25)).toBe(19989.75); // signed ticks read as a distance
  });

  it("P&L in ticks x tick value x size; fees per side per contract (exit)", () => {
    expect(closePnl(1, 20000.25, 20010.25, 1, MNQ)).toBe(20); // 40 ticks x $0.50
    expect(closePnl(-2, 20000, 20005, 2, MNQ)).toBe(-20); // short 2, 20 ticks against: 2 x 20 x $0.50
    expect(closePnl(1, 2045.1, 2044.9, 1, { ...MNQ, tickSize: 0.1, tickValue: 1 })).toBe(-2); // MGC, no float noise
    expect(feesFor(2, MNQ)).toBe(0.74);
    expect(onTick(2045.1 - 0.2, 0.1)).toBe(2044.9);
  });
});

describe("positions", () => {
  it("adds at the average price, realizes on reduce, and reverses through flat", () => {
    const pos = { id: null, net: 0, averagePrice: 0, openedAt: null } as Book["position"];
    const i = ids();
    expect(applyFill(pos, 0, 1, 100, T, MNQ, i)).toBeNull();
    expect(applyFill(pos, 0, 1, 101, T + M, MNQ, i)).toBeNull();
    expect(pos).toMatchObject({ id: 1, net: 2, averagePrice: 100.5, openedAt: T });
    expect(applyFill(pos, 1, 1, 102, T + 2 * M, MNQ, i)).toBe(3); // 6 ticks x $0.50
    expect(applyFill(pos, 1, 3, 99, T + 3 * M, MNQ, i)).toBe(-3); // closes 1 (-6 ticks), then short 2
    expect(pos).toMatchObject({ id: 2, net: -2, averagePrice: 99, openedAt: T + 3 * M });
    expect(applyFill(pos, 0, 2, 99, T + 4 * M, MNQ, i)).toBe(0);
    expect(pos).toMatchObject({ id: null, net: 0, openedAt: null });
  });
});

describe("bars", () => {
  it("fills a market order at the open of the first bar starting at or after it was placed", () => {
    const early = order({ id: 1, placedAt: T - 30000 });
    const late = order({ id: 2, placedAt: T + 30000 });
    const book = emptyBook([early, late]);
    const fills = openBar(book, bar(100, 101, 99, 100), MNQ, ids());
    expect(fills).toEqual([{ orderId: 1, side: 0, size: 1, price: 100.25, time: T, profitAndLoss: null, fees: 0.37 }]);
    expect(late.status).toBe(STATUS.open);
    expect(openBar(book, bar(101, 101, 101, 101, T + M), MNQ, ids())[0]).toMatchObject({ orderId: 2, price: 101.25, time: T + M });
  });

  it("checks a market entry's bracket on its fill bar; a bar touching both fills the stop (onBar)", () => {
    const entry = order({ stopLossBracket: { ticks: 8, type: 4 }, takeProfitBracket: { ticks: 8, type: 1 } });
    const book = emptyBook([entry]);
    const i = ids();
    const b = bar(100, 103, 97, 100);
    openBar(book, b, MNQ, i); // long 1 @ 100.25: stop 98.25, target 102.25
    const [sl, tp] = book.orders.slice(1);
    expect([sl.stopPrice, tp.limitPrice, sl.side, tp.side]).toEqual([98.25, 102.25, 1, 1]);
    const fills = closeBar(book, b, MNQ, i);
    expect(fills).toEqual([{ orderId: sl.id, side: 1, size: 1, price: 98, time: T + M, profitAndLoss: -4.5, fees: 0.37 }]);
    expect(tp.status).toBe(STATUS.cancelled);
    expect(book.position.net).toBe(0);
  });

  it("fills a target at the limit and cancels the stop (OCO)", () => {
    const book = emptyBook([order({ stopLossBracket: { ticks: 8, type: 4 }, takeProfitBracket: { ticks: 8, type: 1 } })]);
    const i = ids();
    openBar(book, bar(100, 100, 100, 100), MNQ, i);
    closeBar(book, bar(100, 100, 100, 100), MNQ, i);
    const fills = closeBar(book, bar(101, 103, 100.5, 102, T + M), MNQ, i);
    expect(fills).toMatchObject([{ price: 102.25, profitAndLoss: 4 }]);
    expect(book.orders[1].status).toBe(STATUS.cancelled);
  });

  it("only checks resting orders on bars that open at or after they were placed", () => {
    const stop = order({ id: 5, type: 4, side: 1, stopPrice: 99, activeFrom: T + 30000 });
    const book = emptyBook([stop]);
    book.position = { id: 1, net: 1, averagePrice: 100, openedAt: T - M };
    expect(closeBar(book, bar(100, 100, 98, 99), MNQ, ids())).toEqual([]);
    expect(closeBar(book, bar(99.5, 99.5, 98.5, 99, T + M), MNQ, ids())).toMatchObject([{ orderId: 5, price: 98.75 }]);
  });

  it("checks a limit entry's stop leg on the same bar (pessimistic)", () => {
    const entry = order({ type: 1, limitPrice: 99, stopLossBracket: { ticks: 4, type: 4 }, takeProfitBracket: { ticks: 4, type: 1 } });
    const book = emptyBook([entry]);
    const fills = closeBar(book, bar(100, 101, 97, 98), MNQ, ids());
    // Entry at 99; stop 98 hit in the same bar at 98 less a tick; the target (100) waits for the next bar.
    expect(fills.map((f) => [f.side, f.price, f.profitAndLoss])).toEqual([[0, 99, null], [1, 97.75, -2.5]]);
    expect(book.position.net).toBe(0);
  });

  it("a bracket leg never opens a position and closes no more than is open", () => {
    const book = emptyBook();
    const i = ids();
    const entry = order({ id: 1, size: 2, stopLossBracket: { ticks: 4, type: 4 } });
    book.orders.push(entry);
    openBar(book, bar(100, 100, 100, 100), MNQ, i);
    const leg = book.orders[1];
    applyFill(book.position, 1, 1, 100, T, MNQ, i); // scaled out 1 by hand
    const { fill } = fillOrder(book, leg, 99, T + M, MNQ, i);
    expect(fill?.size).toBe(1);
    expect(book.position.net).toBe(0);
    const orphan = order({ id: 9, role: "sl", parentId: 3, side: 1, type: 4, stopPrice: 90 });
    book.orders.push(orphan);
    expect(fillOrder(book, orphan, 90, T + 2 * M, MNQ, i).fill).toBeNull();
    expect(orphan.status).toBe(STATUS.cancelled);
  });

  it("cancels every bracket leg once the position is flat, but leaves the client's own orders", () => {
    const book = emptyBook([order({ stopLossBracket: { ticks: 40, type: 4 }, takeProfitBracket: { ticks: 40, type: 1 } })]);
    const i = ids();
    openBar(book, bar(100, 100, 100, 100), MNQ, i);
    const own = order({ id: 50, type: 4, side: 1, stopPrice: 50 });
    const close = order({ id: 51, side: 1, placedAt: T + M });
    book.orders.push(own, close);
    openBar(book, bar(100, 100, 100, 100, T + M), MNQ, i);
    expect(book.orders.filter((o) => o.role !== "order").every((o) => o.status === STATUS.cancelled)).toBe(true);
    expect(own.status).toBe(STATUS.open);
  });

  it("ratchets a trailing stop after each bar, never loosening", () => {
    const o = order({ type: 5, side: 1, stopPrice: 98, trailDistance: 2 });
    trailStep(o, bar(100, 101, 99, 100), 0.25, T + M);
    expect(o.stopPrice).toBe(99);
    trailStep(o, bar(100, 100.5, 99, 100), 0.25, T + 2 * M);
    expect(o.stopPrice).toBe(99);
    const buy = order({ type: 5, side: 0, stopPrice: 102, trailDistance: 2 });
    trailStep(buy, bar(100, 101, 99.5, 100), 0.25, T + M);
    expect(buy.stopPrice).toBe(101.5);
    const plain = order({ type: 4, side: 1, stopPrice: 98 });
    trailStep(plain, bar(100, 110, 99, 100), 0.25, T + M);
    expect(plain.stopPrice).toBe(98);
  });

  it("a trailing stop triggers like a stop", () => {
    const book = emptyBook([order({ id: 7, type: 5, side: 1, stopPrice: 99, trailDistance: 1 })]);
    book.position = { id: 1, net: 1, averagePrice: 100, openedAt: T - M };
    expect(closeBar(book, bar(100, 100, 98.5, 99), MNQ, ids())).toMatchObject([{ orderId: 7, price: 98.75, profitAndLoss: -2.5 }]);
  });

  it("fills stops before limits on a bar that touches both, whatever their order ids", () => {
    const target = order({ id: 1, type: 1, side: 1, limitPrice: 102 });
    const stop = order({ id: 2, type: 4, side: 1, stopPrice: 98 });
    const book = emptyBook([target, stop]);
    book.position = { id: 1, net: 1, averagePrice: 100, openedAt: T - M };
    const fills = closeBar(book, bar(100, 103, 97, 100), MNQ, ids());
    expect(fills[0]).toMatchObject({ orderId: 2, price: 97.75 });
    // The client's own target is not a bracket leg: it then fills too and opens a short, as at a real broker.
    expect(fills[1]).toMatchObject({ orderId: 1, price: 102 });
  });

  it("a close order only reduces: cancelled once a stop has flattened the position", () => {
    const book = emptyBook([order({ stopLossBracket: { ticks: 4, type: 4 } })]);
    const i = ids();
    openBar(book, bar(100, 100, 100, 100), MNQ, i);
    const close = order({ id: 60, side: 1, role: "close", placedAt: T + 30000 });
    book.orders.push(close);
    closeBar(book, bar(100, 100, 98, 99), MNQ, i); // the stop (99.25) fills
    expect(openBar(book, bar(99, 99, 99, 99, T + M), MNQ, i)).toEqual([]);
    expect(close.status).toBe(STATUS.cancelled);
    expect(book.position.net).toBe(0);
  });

  it("cancels the old position's legs when a fill reverses it through flat", () => {
    const book = emptyBook([order({ stopLossBracket: { ticks: 20, type: 4 } })]);
    const i = ids();
    openBar(book, bar(100, 100, 100, 100), MNQ, i);
    book.orders.push(order({ id: 70, side: 1, size: 2, placedAt: T + M }));
    openBar(book, bar(101, 101, 101, 101, T + M), MNQ, i);
    expect(book.position.net).toBe(-1);
    expect(book.orders.filter((o) => o.status === STATUS.open)).toEqual([]);
  });

  it("settles the bar in progress on the terms an order had when it opened", () => {
    const o = order({ type: 4, side: 1, stopPrice: 99.5, activeFrom: T + 30000, prior: { from: T - M, limitPrice: null, stopPrice: 98, size: 1, trailDistance: null } });
    expect(termsOn(o, bar(100, 100, 99, 99))?.stopPrice).toBe(98);
    expect(termsOn(o, bar(100, 100, 99, 99, T + M))).toBe(o);
    expect(termsOn(order({ activeFrom: T + 30000 }), bar(100, 100, 99, 99))).toBeNull();
    const book = emptyBook([o]);
    book.position = { id: 1, net: 1, averagePrice: 100, openedAt: T - M };
    expect(closeBar(book, bar(100, 100, 99, 99), MNQ, ids())).toEqual([]); // the old stop (98) was not reached
    expect(closeBar(book, bar(99.5, 99.5, 99, 99, T + M), MNQ, ids())).toMatchObject([{ price: 99.25 }]);
  });

  it("creates no bracket legs for an order that flattens the position", () => {
    const book = emptyBook();
    book.position = { id: 1, net: 1, averagePrice: 100, openedAt: T - M };
    const { legs } = fillOrder(book, order({ side: 1, stopLossBracket: { ticks: 4, type: 4 } }), 101, T, MNQ, ids());
    expect(legs).toEqual([]);
    expect(book.orders).toEqual([]);
  });
});
