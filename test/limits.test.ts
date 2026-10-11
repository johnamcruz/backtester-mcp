import { describe, expect, it } from "vitest";
import { realizedNet, tradingDayStart } from "../src/risk.js";
import { MIN, RATIONALE, T0, flat, iso, seq, setup, type Row } from "./helpers.js";

// Server-side limits are enforced when an order fills, as a real broker does: placement-time
// checks alone can't be sound, because reduce-only orders (closes, bracket legs) and reducing
// market orders can flatten the position first and turn an accepted opposite order into a new entry.

const base = { accountId: 1, contractId: "BT.MNQ", rationale: RATIONALE };
/** Flat at 20000, then two bars ranging 19980 to 20020. */
const swings = () => ({
  NQ: [...flat(T0 - 30 * MIN, 30, 20000), ...seq(T0, [[20000, 20000, 20000, 20000], [20000, 20020, 19980, 20000], [20000, 20020, 19980, 20000]]), ...flat(T0 + 3 * MIN, 30, 20000)],
});
const net = async (call: any) =>
  (await call("list_open_positions", { accountId: 1 })).data.reduce((n: number, p: any) => n + (p.type === 1 ? 1 : -1) * p.size, 0);
const orders = async (call: any) => (await call("search_orders", { accountId: 1, startTimestamp: iso(T0 - 864e5) })).data;

describe("fill-time limits: the review's repros", () => {
  it("A: a waiting exit flattens first; the opposite stop fills, the limit past the max is rejected", async () => {
    const { call, setNow } = await setup({ data: swings(), env: { BACKTESTER_MAX_POSITION_SIZE: "2", BACKTESTER_MAX_ORDER_SIZE: "2", BACKTESTER_MAX_DAILY_LOSS: "0" } });
    await call("place_order", { ...base, side: "buy", type: "market", size: 2 });
    setNow(T0 + 30000);
    for (const o of [
      { side: "sell", type: "market", size: 2 },
      { side: "sell", type: "stop", size: 2, stopPrice: 19990 },
      { side: "sell", type: "limit", size: 2, limitPrice: 20010 },
    ]) expect((await call("place_order", { ...base, ...o })).data.success).toBe(true);
    setNow(T0 + 3 * MIN);
    expect(await net(call)).toBe(-2);
    expect((await orders(call)).find((o: any) => o.id === 4)).toMatchObject({ statusName: "rejected", rejectReason: expect.stringMatching(/would be -4/) });
  });

  it("B: past the daily loss limit, a stop and a target: the second fill would open a short and is rejected", async () => {
    const { call, setNow } = await setup({ data: swings(), env: { BACKTESTER_MAX_POSITION_SIZE: "2", BACKTESTER_MAX_ORDER_SIZE: "2", BACKTESTER_MAX_DAILY_LOSS: "1" } });
    await call("place_order", { ...base, side: "buy", type: "market", size: 2 });
    await call("partial_close_position", { accountId: 1, contractId: "BT.MNQ", size: 1 }); // -0.50 and fees: past the $1 limit
    setNow(T0 + 30000);
    expect((await call("place_order", { ...base, side: "buy", type: "market", size: 1 })).text).toMatch(/Daily loss limit reached/);
    expect((await call("place_order", { ...base, side: "sell", type: "stop", size: 1, stopPrice: 19990 })).data.success).toBe(true);
    expect((await call("place_order", { ...base, side: "sell", type: "limit", size: 1, limitPrice: 20010 })).data.success).toBe(true);
    setNow(T0 + 3 * MIN);
    expect(await net(call)).toBe(0);
    expect((await orders(call)).find((o: any) => o.type === 1)).toMatchObject({ statusName: "rejected", rejectReason: expect.stringMatching(/daily loss limit/) });
  });

  it("C: a bracket target flattens a short; of two buy stops, the one past the max is rejected", async () => {
    const data = { NQ: [...flat(T0 - 30 * MIN, 30, 20000), ...seq(T0, [[20000, 20000, 20000, 20000], [20000, 20000, 19990, 19995], [19995, 20020, 19995, 20018]]), ...flat(T0 + 3 * MIN, 30, 20018)] };
    const { call, setNow } = await setup({ data, env: { BACKTESTER_MAX_POSITION_SIZE: "2", BACKTESTER_MAX_ORDER_SIZE: "2" } });
    for (const o of [
      { side: "sell", type: "market", size: 2, takeProfitBracket: { ticks: 8, type: "limit" } },
      { side: "buy", type: "stop", size: 2, stopPrice: 20010 },
      { side: "buy", type: "stop", size: 2, stopPrice: 20015 },
    ]) expect((await call("place_order", { ...base, ...o })).data.success).toBe(true);
    setNow(T0 + 4 * MIN);
    expect(await net(call)).toBe(2);
    expect((await orders(call)).filter((o: any) => o.statusName === "rejected").map((o: any) => o.stopPrice)).toEqual([20015]);
  });

  it("D: close_position waiting, then a reversing buy: the close flattens, the buy past the max is rejected", async () => {
    const { call, setNow } = await setup({ data: swings(), env: { BACKTESTER_MAX_POSITION_SIZE: "1", BACKTESTER_MAX_ORDER_SIZE: "2" } });
    await call("place_order", { ...base, side: "sell", type: "market", size: 1 });
    setNow(T0 + 30000);
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data.success).toBe(true);
    expect((await call("place_order", { ...base, side: "buy", type: "market", size: 2 })).data.success).toBe(true);
    setNow(T0 + 2 * MIN);
    expect(await net(call)).toBe(0);
    expect((await orders(call)).at(-1)).toMatchObject({ statusName: "rejected", rejectReason: expect.stringMatching(/would be 2/) });
  });
});

describe("closes", () => {
  it("close_position is taken beside a waiting reversing market order, and still flattens", async () => {
    const { call, setNow } = await setup({ data: swings(), env: { BACKTESTER_MAX_POSITION_SIZE: "2", BACKTESTER_MAX_ORDER_SIZE: "2" } });
    await call("place_order", { ...base, side: "sell", type: "market", size: 1 });
    setNow(T0 + 30000);
    expect((await call("place_order", { ...base, side: "buy", type: "market", size: 2 })).data.success).toBe(true); // long 1 at the next open
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data.success).toBe(true);
    expect((await call("close_position", { accountId: 1, contractId: "BT.MNQ" })).data).toMatchObject({ errorName: "OrderPending", errorMessage: expect.stringMatching(/already waiting/) });
    setNow(T0 + 2 * MIN);
    expect(await net(call)).toBe(0); // the close flattened the long the buy left
  });

  it("a reducing market order isn't refused for the opposite orders resting beside it", async () => {
    const { call, setNow } = await setup({ data: swings(), env: { BACKTESTER_MAX_POSITION_SIZE: "1", BACKTESTER_MAX_DAILY_LOSS: "1" } });
    await call("place_order", { ...base, side: "buy", type: "market", size: 1 });
    await call("place_order", { ...base, side: "sell", type: "limit", size: 1, limitPrice: 20030 });
    await call("place_order", { ...base, side: "sell", type: "stop", size: 1, stopPrice: 19970 });
    await call("place_order", { ...base, contractId: "BT.NQ", side: "buy", type: "market", size: 1 });
    await call("partial_close_position", { accountId: 1, contractId: "BT.NQ", size: 1 }); // past the daily loss limit
    setNow(T0 + 30000);
    expect((await call("place_order", { ...base, side: "sell", type: "market", size: 1 })).data.success).toBe(true);
  });
});

// ── Property test: a bounded, seeded fuzz of random order flow ────────────────

function rng(seed: number) {
  let s = seed;
  const next = () => ((s = (s * 1103515245 + 12345) % 2147483648), s / 2147483648);
  return { next, int: (a: number, b: number) => a + Math.floor(next() * (b - a + 1)), pick: <T,>(xs: T[]) => xs[Math.floor(next() * xs.length)] };
}

describe("property: limits hold under random order flow", () => {
  it("never exceeds the max position, and opens no exposure past the daily loss limit (seeded)", async () => {
    const r = rng(20241005);
    let steps = 0;
    const violations: string[] = [];
    for (let e = 0; e < 40; e++) {
      const maxPos = r.int(1, 3);
      const maxOrd = r.int(1, 3);
      const dl = r.pick([0, 3, 10, 30]);
      const rows: Row[] = [];
      let p = 20000;
      for (let i = -30; i < 150; i++) {
        const o = p;
        const c = o + r.int(-8, 8) * 0.25;
        rows.push([T0 + i * MIN, o, Math.max(o, c) + r.int(0, 6) * 0.25, Math.min(o, c) - r.int(0, 6) * 0.25, c]);
        p = c;
      }
      const { call, setNow, exchange } = await setup({
        data: { NQ: rows },
        env: { BACKTESTER_MAX_POSITION_SIZE: String(maxPos), BACKTESTER_MAX_ORDER_SIZE: String(maxOrd), BACKTESTER_MAX_DAILY_LOSS: String(dl), BACKTESTER_END: iso(T0 + 100 * MIN) },
      });
      let now = T0;
      const last = () => rows[rows.findLastIndex((x) => x[0] + MIN <= now)][4];
      for (let k = 0; k < 50; k++) {
        steps++;
        const open = exchange.openOrders(1);
        const a = r.next();
        const L = last();
        if (a < 0.38) {
          const type = r.pick(["market", "limit", "stop", "join_bid", "trailing_stop", "market", "limit", "stop"]);
          const side = r.pick(["buy", "sell"]);
          const off = r.int(1, 12) * 0.25;
          const args: Record<string, unknown> = { ...base, side, type, size: r.int(1, maxOrd + 1) };
          if (type === "limit") args.limitPrice = r.next() < 0.2 ? (side === "buy" ? L + off : L - off) : side === "buy" ? L - off : L + off;
          if (type === "stop") args.stopPrice = side === "buy" ? L + off : L - off;
          if (type === "trailing_stop") args.trailPrice = side === "buy" ? L + off : L - off;
          if (r.next() < 0.25) args.stopLossBracket = { ticks: r.int(2, 10), type: "stop" };
          if (r.next() < 0.25) args.takeProfitBracket = { ticks: r.int(2, 10), type: "limit" };
          await call("place_order", args);
        } else if (a < 0.55 && open.length) {
          const o = r.pick(open);
          const args: Record<string, unknown> = { accountId: 1, orderId: o.id };
          if (r.next() < 0.6 || (o.type !== 1 && o.type !== 4)) args.size = r.int(1, maxOrd + 1);
          else if (o.type === 1) args.limitPrice = L + r.int(-12, 12) * 0.25;
          else args.stopPrice = L + r.int(-12, 12) * 0.25;
          await call("modify_order", args);
        } else if (a < 0.65 && open.length) {
          await call("cancel_order", { accountId: 1, orderId: r.pick(open).id });
        } else if (a < 0.72) {
          await call("close_position", { accountId: 1, contractId: "BT.MNQ" });
        } else if (a < 0.76) {
          await call("partial_close_position", { accountId: 1, contractId: "BT.MNQ", size: r.int(1, 3) });
        } else {
          now = Math.min(now + r.pick([0, 15000, 30000, 59999, MIN, MIN, 2 * MIN, 3 * MIN, MIN + 30000]), T0 + 140 * MIN);
          setNow(now);
          exchange.openOrders(1);
        }
      }
      setNow(T0 + 140 * MIN);
      exchange.openOrders(1);
      // Replay the fills: |net| within the max after every fill; past the daily loss limit, no fill opens exposure.
      const reduceOnly = new Set(exchange.searchOrders(1, iso(0)).filter((o) => o.reduceOnly).map((o) => o.id));
      let n = 0;
      const trades = exchange.trades(1, iso(0));
      trades.forEach((t, i) => {
        const before = n;
        n += (t.side === 0 ? 1 : -1) * t.size;
        const opens = Math.abs(n) > Math.abs(before) || (before !== 0 && n !== 0 && Math.sign(n) !== Math.sign(before));
        if (Math.abs(n) > maxPos) violations.push(`episode ${e}: net ${n} > max ${maxPos} after trade ${t.id}`);
        if (opens && reduceOnly.has(t.orderId)) violations.push(`episode ${e}: reduce-only order ${t.orderId} opened exposure`);
        const dayStart = tradingDayStart(new Date(t.creationTimestamp)).getTime();
        const realized = realizedNet(trades.slice(0, i).filter((x) => Date.parse(x.creationTimestamp) >= dayStart));
        if (dl > 0 && opens && realized <= -dl) violations.push(`episode ${e}: trade ${t.id} opened exposure at realized ${realized.toFixed(2)} (limit -${dl})`);
      });
    }
    expect(steps).toBe(2000);
    expect(violations).toEqual([]);
  }, 60000);
});
