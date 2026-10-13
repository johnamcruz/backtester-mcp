import { describe, expect, it } from "vitest";
import { specOf, storeRefusedMessage } from "../src/client.js";
import { minuteBars, normalizeL1 } from "../src/events.js";
import { ParquetFile } from "../src/parquet.js";
import { symbolRoot } from "../src/risk.js";
import { globexRanges } from "../src/calendar.js";
import { L1_COLUMNS } from "../src/store.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NQ_SCHEDULE } from "../src/rolltable.js";
import { buildStore } from "../src/storebuild.js";
import { flat, setup, writeData, RATIONALE } from "./helpers.js";
import { l1Minutes, writeSource, type SynthDay } from "./orderbook.js";
import { MIN, Z, builtStore } from "./storefixture.js";

const iso = (ms: number) => new Date(ms).toISOString();

/** A data dir with the March 2024 store and a back-adjusted CSV (NQ +2000) for March and May. */
async function world(now: string, env: Record<string, string> = {}) {
  const b = await builtStore();
  writeData(b.dataDir, { NQ: [...flat(Z("2024-03-12T14:00:00Z"), 60, 20280), ...flat(Z("2024-05-01T14:00:00Z"), 120, 20500)] });
  const s = await setup({ dir: b.dir, now: Z(now), env });
  return { ...s, ...b };
}

/** A run over a store built from `days` (no CSV). */
async function worldWith(days: Record<string, SynthDay>, months: [string, string], now: string, env: Record<string, string> = {}) {
  const b = await builtStore(days, months);
  const s = await setup({ dir: b.dir, now: Z(now), env });
  return { ...s, ...b };
}

/** One trade per hour of the ET day's Globex hours (UTC hours `hours`), at `price`. */
const hourly = (date: string, hours: number[], price: number) => hours.flatMap((h) => l1Minutes(Z(`${date}T${String(h).padStart(2, "0")}:30:00Z`), 1, price));

const bars = (call: (n: string, a: Record<string, unknown>) => Promise<{ data: any }>, contractId: string, extra: Record<string, unknown> = {}) =>
  call("get_bars", { contractId, unit: "minute", unitNumber: 1, limit: 100, ...extra }).then((r) => r.data);

describe("a store that exists but is refused", () => {
  it("says so in under 200 characters, the fix first, a long reason cut", () => {
    const long = storeRefusedMessage(`months ${Array.from({ length: 55 }, (_, i) => String(202105 + i)).join(", ")} weren't assigned`);
    expect(long.length).toBeLessThan(200);
    expect(long).toMatch(/^Derived store refused: rebuild with npm run build-store/);
    expect(long.endsWith("…")).toBe(true);
    for (const reason of ["a build-store run is in progress or was interrupted", "built before day assignment (no assignment in manifest)"]) {
      expect(storeRefusedMessage(reason).length).toBeLessThan(200);
      expect(storeRefusedMessage(reason).endsWith(reason)).toBe(true);
    }
  });

  it("fails a new run's calls with the reason and the rebuild command, and get_server_config shows it; never a silent CSV run", async () => {
    const b = await builtStore();
    writeData(b.dataDir, { NQ: flat(Z("2024-03-12T14:00:00Z"), 60, 20280) });
    const p = join(b.dataDir, "derived", "NQ", "manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    writeFileSync(p, JSON.stringify({ ...m, assignment: { ...m.assignment, quarantineHash: "0".repeat(64) } }));
    const { call } = await setup({ dir: b.dir, now: Z("2024-03-12T14:35:00Z") });
    const r = await call("get_bars", { contractId: "BT.MNQ", unit: "minute", unitNumber: 1, limit: 5 });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(storeRefusedMessage("built with another quarantine table"));
    expect(r.text).toMatch(/^Derived store refused: rebuild with npm run build-store .*Reason: built with another quarantine table$/);
    expect(r.text.length).toBeLessThan(200);
    const cfg = (await call("get_server_config", {})).data;
    expect(cfg.dataStore).toEqual({ NQ: { usable: false, refused: "built with another quarantine table", fix: expect.stringMatching(/npm run build-store/) } });
    // With the store off on purpose, the CSV series is served.
    const off = await setup({ dir: b.dir, now: Z("2024-03-12T14:35:00Z"), env: { BACKTESTER_STORE: "off", BACKTESTER_RUN_ID: "csv" } });
    expect((await off.call("get_bars", { contractId: "BT.MNQ", unit: "minute", unitNumber: 1, limit: 5 })).data.count).toBeGreaterThan(0);
  });
});

describe("contracts from the derived store", () => {
  it("search, get and list give the front contract month at the clock, MNQ on NQ's data", async () => {
    const { call } = await world("2024-03-12T14:35:00Z");
    expect((await call("search_contracts", { searchText: "MNQ" })).data).toEqual([
      {
        id: "BT.MNQ.M24",
        name: "MNQM24",
        description: "Micro E-mini Nasdaq-100 Jun 2024 (replay of raw NQ trades, local order-book data)",
        tickSize: 0.25,
        tickValue: 0.5,
        activeContract: true,
        symbolId: "F.US.MNQ",
      },
    ]);
    expect((await call("search_contracts", { searchText: "NQ" })).data.map((c: any) => c.id)).toEqual(["BT.NQ.M24", "BT.MNQ.M24"]);
    expect((await call("list_available_contracts", {})).data.map((c: any) => c.id)).toEqual(["BT.NQ.M24", "BT.MNQ.M24"]);
    // The contract that rolled off: still known (it has bars), no longer active.
    expect((await call("get_contract", { contractId: "BT.NQ.H24" })).data).toMatchObject({ id: "BT.NQ.H24", name: "NQH24", tickValue: 5, activeContract: false });
    expect((await call("get_contract", { contractId: "BT.NQ.U24" })).text).toMatch(/Contract BT.NQ.U24 not found/);
  });

  it("switches the active contract at the trading day's start (18:00 ET) before the data's 00:00 ET switch, with no bars made up", async () => {
    const before = await world("2024-03-10T21:59:00Z");
    expect((await before.call("search_contracts", { searchText: "MNQ" })).data.map((c: any) => [c.id, c.activeContract])).toEqual([["BT.MNQ.H24", true]]);
    // Sunday 18:01:30 ET: M24 is the front for the whole trading day, but the data is still on H24 until 00:00 ET.
    const evening = await world("2024-03-10T22:01:30Z");
    expect((await evening.call("search_contracts", { searchText: "MNQ" })).data.map((c: any) => [c.id, c.activeContract])).toEqual([["BT.MNQ.M24", true]]);
    expect((await evening.call("get_contract", { contractId: "BT.MNQ.H24" })).data.activeContract).toBe(false);
    expect((await bars(evening.call, "BT.MNQ.M24")).bars).toEqual([]);
    expect((await bars(evening.call, "BT.MNQ.H24")).bars.at(-1)).toMatchObject({ t: "2024-03-10T22:00:00.000Z", c: 18020 });
    const after = await world("2024-03-11T04:01:00Z");
    expect((await bars(after.call, "BT.MNQ.M24")).bars.map((x: any) => x.t)).toEqual(["2024-03-11T04:00:00.000Z"]);
  });

  it("shows in get_server_config nothing of the store past the replay clock", async () => {
    const { call } = await world("2024-03-08T15:00:00Z");
    const cfg = (await call("get_server_config", {})).data;
    expect(cfg.store).toBe("on");
    expect(cfg.dataStore).toEqual({
      NQ: { months: "202403..202403", activeContract: "H24", contracts: { H24: { first: "2024-03-07T14:30:00.000Z" } }, servedFor: ["NQ", "MNQ"] },
    });
    expect(JSON.stringify(cfg.dataStore)).not.toMatch(/M24|last|bars|gaps/);
    expect(cfg.data.NQ).toMatchObject({ file: "NQ_1min.csv" });
  });
});

describe("roll settlement", () => {
  it("settles a position and working orders on a contract when the data leaves it: closed at its last close, cancelled, journaled", async () => {
    // Sunday 18:00:30 ET: M24 is the front already, the data is on H24 until 00:00 ET; the trader holds H24.
    const { call, setNow } = await world("2024-03-10T22:00:30Z");
    const buy = await call("place_order", { accountId: 1, contractId: "BT.MNQ.H24", side: "buy", type: "market", size: 1, rationale: RATIONALE });
    expect(buy.data).toMatchObject({ success: true });
    const stop = await call("place_order", { accountId: 1, contractId: "BT.MNQ.H24", side: "sell", type: "stop", size: 1, stopPrice: 17900, rationale: RATIONALE });
    expect(stop.data, JSON.stringify(stop.data)).toMatchObject({ success: true });
    expect((await call("list_open_positions", { accountId: 1 })).data).toMatchObject([{ contractId: "BT.MNQ.H24", size: 1, averagePrice: 18020.25 }]);
    // Before the switch nothing happens; at 00:00 ET Monday (04:00Z) the data leaves H24.
    setNow(Z("2024-03-11T03:59:00Z"));
    expect((await call("list_open_positions", { accountId: 1 })).data).toHaveLength(1);
    setNow(Z("2024-03-11T05:00:00Z"));
    expect((await call("list_open_positions", { accountId: 1 })).data).toEqual([]);
    expect((await call("list_open_orders", { accountId: 1 })).data).toEqual([]);
    const trades = (await call("search_trades", { accountId: 1, startTimestamp: "2024-03-10T00:00:00Z" })).data;
    const close = trades.find((t: any) => t.profitAndLoss !== null);
    // At H24's last bar close (18020), without slippage, stamped at the switch.
    expect(close).toMatchObject({ contractId: "BT.MNQ.H24", price: 18020, side: 1, size: 1, creationTimestamp: "2024-03-11T04:00:00.000Z", rollSettlement: true, profitAndLoss: -0.5 });
    expect(close.roundTrip).toMatchObject({ reason: "roll" });
    const orders = (await call("search_orders", { accountId: 1, startTimestamp: "2024-03-10T00:00:00Z" })).data;
    expect(orders.find((o: any) => o.id === stop.data.orderId)).toMatchObject({ status: 3, rollSettlement: true });
    const notes = (await call("journal_read", { tag: "roll_settlement" })).data;
    expect(JSON.stringify(notes)).toMatch(/Roll settlement: the replay data left BT.MNQ.H24 at 2024-03-11T04:00:00.000Z; closed 1 at 18020/);
    // Journaled as a close_position is: kind "exit" with its flatten result.
    expect(notes).toMatchObject([
      {
        kind: "exit",
        accountId: 1,
        contractId: "BT.MNQ.H24",
        data: { status: "flat", close: { success: true }, positionNet: 0, cancelledOrderIds: [stop.data.orderId], remainingOrderIds: [], rollSettlement: true, at: "2024-03-11T04:00:00.000Z" },
      },
    ]);
    // Settled once: a later call settles nothing again.
    setNow(Z("2024-03-11T06:00:00Z"));
    expect((await call("search_trades", { accountId: 1, startTimestamp: "2024-03-10T00:00:00Z" })).data).toHaveLength(2);
  });

  it("doesn't settle a contract the data leaves for a stretch and comes back to: a gap, nothing fills in it", async () => {
    // Dec 2023: Z23 on 12-05, the data on H24 (200 higher) on 12-06, back on Z23 on 12-07.
    const days = {
      "2023-12-05": { l1: hourly("2023-12-05", [14, 15, 16], 16000) },
      "2023-12-06": { l1: hourly("2023-12-06", [14, 15, 16], 16200) },
      "2023-12-07": { l1: hourly("2023-12-07", [14, 15, 16], 16010) },
    };
    const { call, setNow } = await worldWith(days, ["202312", "202312"], "2023-12-05T14:30:30Z");
    expect((await call("place_order", { accountId: 1, contractId: "BT.MNQ.Z23", side: "buy", type: "market", size: 1, rationale: RATIONALE })).data).toMatchObject({ success: true });
    // A target at 16100: H24's 16200 on 12-06 is not Z23's price, so it must not fill.
    expect((await call("place_order", { accountId: 1, contractId: "BT.MNQ.Z23", side: "sell", type: "limit", size: 1, limitPrice: 16100, rationale: RATIONALE })).data).toMatchObject({ success: true });
    setNow(Z("2023-12-07T16:00:00Z"));
    expect((await call("list_open_positions", { accountId: 1 })).data).toMatchObject([{ contractId: "BT.MNQ.Z23", size: 1 }]);
    expect((await call("list_open_orders", { accountId: 1 })).data).toHaveLength(1);
    expect((await call("journal_read", { tag: "roll_settlement" })).data).toEqual([]);
  });

  it("settles an M22 position at its 2022-06-09 roll, although the data comes back to M22 on 06-17", async () => {
    const days = { "2022-06-08": { l1: hourly("2022-06-08", [14, 15, 16], 12000) }, "2022-06-09": { l1: hourly("2022-06-09", [14, 15], 11970) } };
    const { call, setNow } = await worldWith(days, ["202206", "202206"], "2022-06-08T14:30:30Z");
    await call("place_order", { accountId: 1, contractId: "BT.MNQ.M22", side: "buy", type: "market", size: 1, rationale: RATIONALE });
    setNow(Z("2022-06-10T15:00:00Z"));
    expect((await call("list_open_positions", { accountId: 1 })).data).toEqual([]);
    const exit = (await call("search_trades", { accountId: 1, startTimestamp: "2022-06-01T00:00:00Z" })).data.find((t: any) => t.profitAndLoss !== null);
    expect(exit).toMatchObject({ price: 12000, rollSettlement: true, creationTimestamp: "2022-06-09T04:00:00.000Z" });
    // An opening order on it after its roll: it rolled off (the gap message would be wrong: the data never comes back).
    const late = await call("place_order", { accountId: 1, contractId: "BT.MNQ.M22", side: "buy", type: "market", size: 1, rationale: RATIONALE });
    expect(late.data).toMatchObject({ success: false, errorCode: 5, errorMessage: "MNQM22 rolled off at 2022-06-09T04:00:00.000Z; trade the front month." });
  });

  it("during a gap (Z23 on 2023-12-06) takes reducing orders: close_position fills at the last close, a protective stop rests; opening orders are refused", async () => {
    const days = {
      "2023-12-05": { l1: hourly("2023-12-05", [14, 15, 16], 16000) },
      "2023-12-06": { l1: hourly("2023-12-06", [14, 15, 16], 16200) },
      "2023-12-07": { l1: hourly("2023-12-07", [14, 15, 16], 16010) },
    };
    const { call, setNow } = await worldWith(days, ["202312", "202312"], "2023-12-05T14:30:30Z");
    await call("place_order", { accountId: 1, contractId: "BT.MNQ.Z23", side: "buy", type: "market", size: 1, rationale: RATIONALE });
    await call("place_order", { accountId: 1, contractId: "BT.MNQ.Z23", side: "buy", type: "market", size: 1, rationale: RATIONALE });
    setNow(Z("2023-12-06T15:00:00Z"));
    // A reducing market order fills at once at the last close.
    expect((await call("place_order", { accountId: 1, contractId: "BT.MNQ.Z23", side: "sell", type: "market", size: 1, rationale: RATIONALE })).data).toMatchObject({ success: true });
    expect((await call("list_open_positions", { accountId: 1 })).data).toMatchObject([{ size: 1 }]);
    const stop = await call("place_order", { accountId: 1, contractId: "BT.MNQ.Z23", side: "sell", type: "stop", size: 1, stopPrice: 15900, rationale: RATIONALE });
    expect(stop.data, JSON.stringify(stop.data)).toMatchObject({ success: true });
    expect((await call("list_open_orders", { accountId: 1 })).data).toMatchObject([{ id: stop.data.orderId, stopPrice: 15900 }]);
    const add = await call("place_order", { accountId: 1, contractId: "BT.MNQ.Z23", side: "buy", type: "market", size: 1, rationale: RATIONALE });
    expect(add.data).toMatchObject({ success: false, errorCode: 5 });
    expect(add.data.errorMessage).toMatch(/^The replay data is away from MNQZ23 now \(no bars until it comes back\)/);
    expect(add.data.errorMessage).not.toMatch(/rolled off/);
    const flat = await call("close_position", { accountId: 1, contractId: "BT.MNQ.Z23" });
    expect(flat.data).toMatchObject({ status: "flat", cancelledOrderIds: [stop.data.orderId] });
    const exits = (await call("search_trades", { accountId: 1, startTimestamp: "2023-12-01T00:00:00Z" })).data.filter((t: any) => t.profitAndLoss !== null);
    // Both at Z23's last close (12-05 16:30, 16000), stamped at the clock.
    expect(exits).toMatchObject([
      { price: 16000, size: 1, side: 1, creationTimestamp: "2023-12-06T15:00:00.000Z" },
      { price: 16000, size: 1, side: 1, creationTimestamp: "2023-12-06T15:00:00.000Z" },
    ]);
  });

  it("doesn't settle a weekend position across a day the data has no contract (2025-02-09) or the back month (2023-12-03)", async () => {
    const feb = { "2025-02-07": { l1: hourly("2025-02-07", [14, 15], 21600) }, "2025-02-09": { l1: [[Z("2025-02-10T02:07:00Z"), 2, 21575.25, 1] as [number, number, number, number]] }, "2025-02-10": { l1: hourly("2025-02-10", [14, 15], 21685) } };
    const f = await worldWith(feb, ["202502", "202502"], "2025-02-07T14:30:30Z");
    await f.call("place_order", { accountId: 1, contractId: "BT.MNQ.H25", side: "buy", type: "market", size: 1, rationale: RATIONALE });
    f.setNow(Z("2025-02-10T15:00:00Z"));
    expect((await f.call("list_open_positions", { accountId: 1 })).data).toMatchObject([{ contractId: "BT.MNQ.H25", size: 1 }]);
    const dec = { "2023-12-01": { l1: hourly("2023-12-01", [14, 15], 16030) }, "2023-12-03": { l1: hourly("2023-12-04", [2], 16230) }, "2023-12-04": { l1: hourly("2023-12-04", [14, 15], 15980) } };
    const d = await worldWith(dec, ["202312", "202312"], "2023-12-01T14:30:30Z");
    await d.call("place_order", { accountId: 1, contractId: "BT.MNQ.Z23", side: "buy", type: "market", size: 1, rationale: RATIONALE });
    d.setNow(Z("2023-12-04T15:00:00Z"));
    expect((await d.call("list_open_positions", { accountId: 1 })).data).toMatchObject([{ contractId: "BT.MNQ.Z23", size: 1 }]);
  });

  it("settles at the old contract's last bar close, a bar that closes exactly at the switch included", async () => {
    // H24's last bar opens 03:59Z (Sunday 23:59 EDT) and closes at the 04:00Z switch.
    const days = { "2024-03-10": { l1: [...l1Minutes(Z("2024-03-10T22:00:00Z"), 1, 18020), ...l1Minutes(Z("2024-03-11T03:59:00Z"), 1, 18033.5)] } };
    const { call, setNow } = await worldWith(days, ["202403", "202403"], "2024-03-10T22:00:30Z");
    await call("place_order", { accountId: 1, contractId: "BT.MNQ.H24", side: "buy", type: "market", size: 1, rationale: RATIONALE });
    setNow(Z("2024-03-11T05:00:00Z"));
    const exit = (await call("search_trades", { accountId: 1, startTimestamp: "2024-03-10T00:00:00Z" })).data.find((t: any) => t.profitAndLoss !== null);
    expect(exit).toMatchObject({ price: 18033.5, rollSettlement: true, creationTimestamp: "2024-03-11T04:00:00.000Z" });
  });

  it("fills a stop that triggers before the switch at the stop, not at the settlement", async () => {
    const { call, setNow } = await world("2024-03-10T22:00:30Z");
    await call("place_order", { accountId: 1, contractId: "BT.MNQ.H24", side: "buy", type: "market", size: 1, rationale: RATIONALE });
    // The 22:01 bar's low (18020) touches the stop: it fills at 18020 less a tick, at that bar's close.
    await call("place_order", { accountId: 1, contractId: "BT.MNQ.H24", side: "sell", type: "stop", size: 1, stopPrice: 18020, rationale: RATIONALE });
    setNow(Z("2024-03-11T05:00:00Z"));
    const exit = (await call("search_trades", { accountId: 1, startTimestamp: "2024-03-10T00:00:00Z" })).data.find((t: any) => t.profitAndLoss !== null);
    expect(exit).toMatchObject({ price: 18019.75, creationTimestamp: "2024-03-10T22:02:00.000Z" });
    expect(exit.rollSettlement).toBeUndefined();
    expect((await call("journal_read", { tag: "roll_settlement" })).data).toEqual([]);
  });

  it("reports and tags every order the settlement ended, bracket legs cancelled by the close included", async () => {
    const { call, setNow } = await world("2024-03-10T22:00:30Z");
    const entry = await call("place_order", {
      accountId: 1, contractId: "BT.MNQ.H24", side: "buy", type: "market", size: 1, rationale: RATIONALE,
      stopLossBracket: { ticks: 40, type: "stop" }, takeProfitBracket: { ticks: 80, type: "limit" },
    });
    expect(entry.data).toMatchObject({ success: true });
    const legs = (await call("list_open_orders", { accountId: 1 })).data.map((o: any) => o.id);
    expect(legs).toHaveLength(2);
    setNow(Z("2024-03-11T05:00:00Z"));
    // A call that syncs the run to the clock settles; journal_read alone reads the journal as it is.
    expect((await call("list_open_positions", { accountId: 1 })).data).toEqual([]);
    const [note] = (await call("journal_read", { tag: "roll_settlement" })).data;
    expect([...note.data.cancelledOrderIds].sort()).toEqual([...legs].sort());
    const orders = (await call("search_orders", { accountId: 1, startTimestamp: "2024-03-10T00:00:00Z" })).data;
    for (const id of legs) expect(orders.find((o: any) => o.id === id)).toMatchObject({ status: 3, rollSettlement: true });
  });

  it("leaves contracts the data doesn't leave alone, and settles only what is open", async () => {
    const { call, setNow } = await world("2024-03-11T04:01:30Z");
    await call("place_order", { accountId: 1, contractId: "BT.MNQ.M24", side: "buy", type: "market", size: 1, rationale: RATIONALE });
    setNow(Z("2024-03-12T14:35:00Z"));
    expect((await call("list_open_positions", { accountId: 1 })).data).toMatchObject([{ contractId: "BT.MNQ.M24", size: 1 }]);
  });
});

describe("the new front before the data rolls to it", () => {
  it("refuses orders that open a position on it between 18:00 ET and the data's 00:00 ET switch, then takes them", async () => {
    const { call, setNow } = await world("2024-03-10T22:00:30Z");
    const early = await call("place_order", { accountId: 1, contractId: "BT.MNQ.M24", side: "buy", type: "limit", size: 1, limitPrice: 18000, rationale: RATIONALE });
    expect(early.data).toMatchObject({ success: false, errorCode: 5 });
    expect(early.data.errorMessage).toMatch(/No bars yet on MNQM24: the replay data rolls to it at 00:00 ET/);
    setNow(Z("2024-03-11T04:00:30Z"));
    expect((await call("place_order", { accountId: 1, contractId: "BT.MNQ.M24", side: "buy", type: "market", size: 1, rationale: RATIONALE })).data).toMatchObject({ success: true });
  });
});

describe("the run's data source is pinned", () => {
  it("past the run's store months behaves as after BACKTESTER_END: reads work, reducing orders fill at the last close, opening ones are refused", async () => {
    const { call, setNow } = await world("2024-03-12T14:30:30Z");
    expect((await call("place_order", { accountId: 1, contractId: "BT.MNQ.M24", side: "buy", type: "market", size: 1, rationale: RATIONALE })).data).toMatchObject({ success: true });
    // April 2024 was not built: the position is held into it.
    setNow(Z("2024-04-02T15:00:00Z"));
    expect((await call("list_open_positions", { accountId: 1 })).data).toMatchObject([{ contractId: "BT.MNQ.M24", size: 1 }]);
    expect((await call("get_account_snapshot", { accountId: 1 })).isError).toBe(false);
    const open = await call("place_order", { accountId: 1, contractId: "BT.MNQ.M24", side: "buy", type: "market", size: 1, rationale: RATIONALE });
    expect(open.data).toMatchObject({ success: false, errorCode: 5 });
    expect(open.data.errorMessage).toMatch(/outside the derived store's months this run started on \(202403\.\.202403\).*only market orders that reduce the position are taken/);
    const flat = await call("close_position", { accountId: 1, contractId: "BT.MNQ.M24" });
    expect(flat.data).toMatchObject({ status: "flat" });
    const exit = (await call("search_trades", { accountId: 1, startTimestamp: "2024-03-01T00:00:00Z" })).data.find((t: any) => t.profitAndLoss !== null);
    // At M24's last close in the store (14:31, 18280), without slippage.
    expect(exit).toMatchObject({ price: 18280, side: 1 });
  });

  it("refuses a process whose store differs from the run's (rebuilt, or turned off)", async () => {
    const w = await world("2024-03-12T14:35:00Z");
    expect((await w.call("search_contracts", { searchText: "MNQ" })).data[0].id).toBe("BT.MNQ.M24");
    const off = await setup({ dir: w.dir, env: { BACKTESTER_STORE: "off" } });
    expect((await off.call("search_contracts", { searchText: "MNQ" })).text).toMatch(/started on the derived store, and this process has it off/);
    // The store is rebuilt with another month: its manifest changes.
    writeSource(w.source, { "2024-04-01": { l1: l1Minutes(Z("2024-04-01T14:30:00Z"), 1, 18300) } });
    await buildStore({ source: w.source, dataDir: w.dataDir, from: "202404", to: "202404" });
    const again = await setup({ dir: w.dir });
    expect((await again.call("search_contracts", { searchText: "MNQ" })).text).toMatch(/derived store changed .* since run .* started/);
  });

  it("keeps a run that started on the CSV on the CSV, even where a store covers the clock later", async () => {
    const w = await world("2024-03-12T14:35:00Z", { BACKTESTER_STORE: "off" });
    expect((await w.call("search_contracts", { searchText: "MNQ" })).data[0].id).toBe("BT.MNQ");
    const on = await setup({ dir: w.dir });
    expect((await on.call("search_contracts", { searchText: "MNQ" })).data.map((c: any) => c.id)).toEqual(["BT.MNQ"]);
    expect((await on.call("get_contract", { contractId: "BT.MNQ.M24" })).text).toMatch(/not found/);
    const state = JSON.parse(readFileSync(join(w.dir, "state", "state.json"), "utf8"));
    expect(state.settings.data).toEqual({ useStore: false, manifestHash: null, months: [], rollTableHash: null });
  });

  it("pins a run that starts on the store to its manifest, months and roll table", async () => {
    const w = await world("2024-03-12T14:35:00Z");
    await w.call("search_contracts", { searchText: "MNQ" });
    const state = JSON.parse(readFileSync(join(w.dir, "state", "state.json"), "utf8"));
    expect(state.settings.data).toEqual({ useStore: true, manifestHash: expect.stringMatching(/^[0-9a-f]{64}$/), months: ["202403"], rollTableHash: NQ_SCHEDULE.hash });
  });

  it("keeps a run created before pinning (state without it, already trading) on the CSV", async () => {
    const w = await world("2024-03-12T14:35:00Z", { BACKTESTER_STORE: "off" });
    await w.call("place_order", { accountId: 1, contractId: "BT.MNQ", side: "buy", type: "market", size: 1, rationale: RATIONALE });
    const p = join(w.dir, "state", "state.json");
    const state = JSON.parse(readFileSync(p, "utf8"));
    delete state.settings.data;
    writeFileSync(p, JSON.stringify(state));
    const on = await setup({ dir: w.dir });
    expect((await on.call("search_contracts", { searchText: "MNQ" })).data.map((c: any) => c.id)).toEqual(["BT.MNQ"]);
    // A refused store (built before day assignment) doesn't stop it either: it keeps the CSV it is on.
    writeFileSync(p, JSON.stringify(state));
    const mp = join(w.dataDir, "derived", "NQ", "manifest.json");
    const m = JSON.parse(readFileSync(mp, "utf8"));
    delete m.assignment;
    writeFileSync(mp, JSON.stringify(m));
    const refused = await setup({ dir: w.dir });
    const r = await refused.call("search_contracts", { searchText: "MNQ" });
    expect(r.isError).toBe(false);
    expect(r.data.map((c: any) => c.id)).toEqual(["BT.MNQ"]);
  });
});

describe("get_bars from the derived store", () => {
  it("serves a contract's raw bars, equal to bars built from the source trades, closed by the clock only", async () => {
    const { call, source } = await world("2024-03-12T14:31:30Z");
    // The source trades of 03-11 (the parquet's 5th row group), built into bars independently here.
    const f = await ParquetFile.open(join(source, "l1", "202403.parquet"));
    const g = f.rowGroups[4];
    const src = minuteBars(normalizeL1(await f.read(g.index, L1_COLUMNS), globexRanges("2024-03-11")).trades);
    const res = await bars(call, "BT.MNQ.M24");
    expect(res.bars.slice(0, 3)).toEqual(src.t.map((t, i) => ({ t: iso(t), o: src.o[i], h: src.h[i], l: src.l[i], c: src.c[i], v: src.v[i] })));
    // 14:31 isn't closed at 14:31:30.
    expect(res.bars.map((b: any) => b.t)).toEqual(["2024-03-11T04:00:00.000Z", "2024-03-11T04:01:00.000Z", "2024-03-11T04:02:00.000Z", "2024-03-12T14:30:00.000Z"]);
    // Aggregated: one bar per closed hour with trades (the 14:00 hour is still forming).
    expect((await bars(call, "BT.NQ.M24", { unit: "hour" })).bars).toEqual([{ t: "2024-03-11T04:00:00.000Z", o: 18270, h: 18271, l: 18270, c: 18271, v: 3 }]);
    // The old contract keeps its own history, up to its last front-month minute.
    expect((await bars(call, "BT.NQ.H24")).bars.at(-1)).toEqual({ t: "2024-03-10T22:01:00.000Z", o: 18020, h: 18020, l: 18020, c: 18020, v: 1 });
  });

  it("has no bars for a contract before it became the front month (the data holds the front only)", async () => {
    const { call } = await world("2024-03-08T15:00:00Z");
    expect((await bars(call, "BT.MNQ.M24")).bars).toEqual([]);
    expect((await bars(call, "BT.MNQ.H24")).count).toBe(4);
  });

  it("quotes and fills on the contract month's own bars", async () => {
    const { call } = await world("2024-03-12T14:31:30Z");
    expect((await call("get_quote", { contractId: "BT.MNQ.M24" })).data.quote).toMatchObject({ lastPrice: 18280, open: 18280 });
    const placed = await call("place_order", { accountId: 1, contractId: "BT.MNQ.M24", side: "buy", type: "market", size: 1, rationale: RATIONALE });
    expect(placed.data).toMatchObject({ success: true });
    // At once, at the open of the bar containing the clock (14:31, 18280) plus a tick of slippage.
    expect((await call("list_open_positions", { accountId: 1 })).data).toMatchObject([{ contractId: "BT.MNQ.M24", size: 1, averagePrice: 18280.25 }]);
  });
});

describe("CSV fallback and precedence", () => {
  it("serves the continuous CSV series where the store doesn't cover the clock", async () => {
    const { call } = await world("2024-05-01T15:00:00Z");
    expect((await call("search_contracts", { searchText: "MNQ" })).data.map((c: any) => [c.id, c.name])).toEqual([["BT.MNQ", "MNQM24"]]);
    expect((await bars(call, "BT.MNQ", { limit: 1 })).bars).toEqual([{ t: "2024-05-01T14:59:00.000Z", o: 20500, h: 20500, l: 20500, c: 20500, v: 10 }]);
    // A run that started on the CSV has no contract-month ids.
    expect((await call("get_bars", { contractId: "BT.MNQ.M24", unit: "minute", unitNumber: 1, limit: 5 })).text).toMatch(/not found/);
  });

  it("keeps the CSV id usable inside the store's months, and BACKTESTER_STORE=off turns the store off", async () => {
    const on = await world("2024-03-12T14:35:00Z");
    expect((await bars(on.call, "BT.MNQ", { limit: 1 })).bars[0]).toMatchObject({ t: "2024-03-12T14:34:00.000Z", c: 20280 });
    const off = await world("2024-03-12T14:35:00Z", { BACKTESTER_STORE: "off" });
    expect((await off.call("search_contracts", { searchText: "MNQ" })).data.map((c: any) => c.id)).toEqual(["BT.MNQ"]);
    expect((await off.call("get_contract", { contractId: "BT.MNQ.M24" })).text).toMatch(/not found/);
    expect((await off.call("get_server_config", {})).data).toMatchObject({ store: "off", dataStore: {} });
    // The CSV id is still answered inside a store run.
    void on;
  });

  it("serves no contract for a root when the store covers the clock but holds no bars of its front month", async () => {
    // A March 2024 store with H24 days only, seen after the roll: M24 has no bars. The CSV isn't used inside the store's months.
    const b = await builtStore({ "2024-03-05": { l1: [[Z("2024-03-05T15:00:00Z"), 2, 17900, 1]] } });
    writeData(b.dataDir, { NQ: flat(Z("2024-03-12T14:00:00Z"), 60, 20280) });
    const { call } = await setup({ dir: b.dir, now: Z("2024-03-12T14:35:00Z") });
    expect((await call("search_contracts", { searchText: "NQ" })).data).toEqual([]);
    const early = await setup({ dir: b.dir, now: Z("2024-03-05T15:30:00Z"), env: { BACKTESTER_STATE_DIR: join(b.dir, "state2") } });
    expect((await early.call("search_contracts", { searchText: "MNQ" })).data.map((c: any) => c.id)).toEqual(["BT.MNQ.H24"]);
    void MIN;
  });
});

describe("contract-month ids", () => {
  it("parse to their root's spec for quarterly roots only, and give their symbol root", () => {
    expect(specOf("BT.MNQ.M24")).toMatchObject({ root: "MNQ", dataRoot: "NQ", tickValue: 0.5, expiry: "M24" });
    expect(specOf("BT.MNQ")?.expiry).toBeUndefined();
    expect(specOf("BT.MNQ.F24")).toBeNull();
    expect(specOf("BT.GC.M24")).toBeNull();
    expect(specOf("BT.XX.M24")).toBeNull();
    expect(symbolRoot("BT.MNQ.M24")).toBe("MNQ");
    expect(symbolRoot("BT.MNQ")).toBe("MNQ");
  });
});
