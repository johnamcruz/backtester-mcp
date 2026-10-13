import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { etDayBounds, globexRanges, type EtDate } from "../src/calendar.js";
import { FLOW_FORMAT, carryHash, computeFlowDay, flowCurrent, flowDayPath, flowRecords, flowSummary, readFlowDay, type FlowDay } from "../src/flowstore.js";
import { NQ_SCHEDULE } from "../src/rolltable.js";
import { DerivedStore, readDay, readManifest, type DayFile } from "../src/store.js";
import { join } from "node:path";
import { buildStore } from "../src/storebuild.js";
import { runBuildStoreCli } from "../src/build-store.js";
import type { L1Row, L2Row } from "./orderbook.js";
import { MIN, Z, builtStore, marchDays } from "./storefixture.js";

/** Columns as the parquet reader returns them (ts in µs) from rows with ms times. */
function cols(rows: number[][], names: string[]): Record<string, Float64Array> {
  const out: Record<string, Float64Array> = {};
  names.forEach((n, i) => (out[n] = Float64Array.from(rows.map((r) => (i === 0 ? Math.round(r[0] * 1000) : r[i])))));
  return out;
}
const L1 = (rows: L1Row[]) => cols(rows, ["ts", "type", "price", "vol"]);
const L2 = (rows: L2Row[]) => cols(rows, ["ts", "side", "price", "vol", "depth", "act"]);
const ref = (file: string, rows: number) => ({ file, size: 1, mtime: 1, rowGroup: 0, rows, kept: rows, index: [] as Array<[number, number]> });

/** A day file for `date` (its real Globex hours) with L1 and, optionally, L2. */
function dayFile(date: EtDate, l1Rows: number, l2Rows: number | null): DayFile {
  return {
    format: 2,
    root: "NQ",
    date,
    contract: NQ_SCHEDULE.dataContractAt(etDayBounds(date).start),
    sessions: globexRanges(date),
    l1: { ...ref(`l1/${date.slice(0, 7).replace("-", "")}.parquet`, l1Rows), trades: 0 },
    l2: l2Rows === null ? null : ref(`l2/${date.slice(0, 7).replace("-", "")}.parquet`, l2Rows),
    quoteStart: { bid: null, bidSize: null, ask: null, askSize: null },
    quoteEnd: { bid: null, bidSize: null, ask: null, askSize: null },
    bars: { t: [], o: [], h: [], l: [], c: [], v: [] },
  };
}

/** Tuesday 2024-03-05 09:30 ET (14:30Z): front H24. */
const T = Z("2024-03-05T14:30:00Z");

/**
 * Minute T: a book 18000 x 18000.25 (10 / 6), an L2 bid 17999.75 (20) and a stale L2 ask at the touch (18000.25, 99),
 * a buy of 3 at the ask and a sell of 2 at the bid. Minute T+1: the ask moves up a tick and a print inside the spread
 * (an up-tick: buy 1). Minute T+2: no L1 row (the book is still there). Minute T+3: a bid change.
 */
function tuesday(): { l1: L1Row[]; l2: L2Row[] } {
  return {
    l1: [
      [T + 100, 0, 18000, 10],
      [T + 100, 1, 18000.25, 6],
      [T + 1000, 2, 18000.25, 3],
      [T + 2000, 2, 18000, 2],
      [T + MIN + 500, 1, 18000.75, 6],
      [T + MIN + 1000, 2, 18000.5, 1],
      [T + 3 * MIN + 5000, 0, 18000, 12],
    ],
    l2: [
      [T + 100, 0, 17999.75, 20, 1, 0],
      [T + 100, 1, 18000.25, 99, 1, 0],
    ],
  };
}

function flowOf(date: EtDate, l1: L1Row[], l2: L2Row[] | null): FlowDay {
  return computeFlowDay(dayFile(date, l1.length, l2 ? l2.length : null), L1(l1), l2 ? L2(l2) : null, null);
}

const summaryOf = (...days: FlowDay[]) => ({ format: FLOW_FORMAT, tick: 0.25, levels: 5, days: days.map((d) => d.date) });
const reader = (...days: FlowDay[]) => (date: EtDate) => days.find((d) => d.date === date) ?? null;

describe("order flow of a store day", () => {
  it("computes the minute rows of the day's hours from L1 and L2", () => {
    const { l1, l2 } = tuesday();
    const f = flowOf("2024-03-05", l1, l2);
    const k = f.minutes.t.indexOf(T);
    expect(f.book).toBe(true);
    expect([f.minutes.bv[k], f.minutes.sv[k], f.minutes.volume[k], f.minutes.trades[k], f.minutes.vwap[k], f.minutes.l1Events[k]]).toEqual([3, 2, 5, 2, 18000.15, 4]);
    // (10 + 20 - 6) / 36: the L2 ask at the touch (99) is ignored.
    expect(f.minutes.imbalance[k]).toBeCloseTo(24 / 36, 12);
    // T+1: the print at 18000.5 is inside 18000 x 18000.75 and a up-tick from 18000: buy.
    const k1 = f.minutes.t.indexOf(T + MIN);
    expect([f.minutes.bv[k1], f.minutes.sv[k1]]).toEqual([1, 0]);
    // T+2 has the book but no L1 row.
    expect(f.minutes.l1Events[f.minutes.t.indexOf(T + 2 * MIN)]).toBe(0);
    // Every stored minute is inside the day's Globex hours.
    expect(f.minutes.t.every((t) => globexRanges("2024-03-05").some(([a, b]) => t >= a && t < b))).toBe(true);
  });

  it("a day without L2 has a null imbalance (ofiQuote still from L1)", () => {
    const { l1 } = tuesday();
    const f = flowOf("2024-03-05", l1, null);
    const k = f.minutes.t.indexOf(T);
    expect(f.book).toBe(false);
    expect(f.minutes.imbalance.every((v) => v === null)).toBe(true);
    // The ask moves up a tick: + its old size (6).
    expect(f.minutes.ofiQuote[f.minutes.t.indexOf(T + MIN)]).toBe(6);
    expect(f.minutes.ofiQuote[k]).toBe(0);
  });

  it("L2 rows all outside the day's hours count as no L2 (imbalance null)", () => {
    const { l1, l2 } = tuesday();
    const day = { ...dayFile("2024-03-05", l1.length, l2.length), l2: { ...ref("l2/202403.parquet", l2.length), kept: 0 } };
    const f = computeFlowDay(day, L1(l1), L2(l2), null);
    expect(f.book).toBe(false);
    expect(f.minutes.imbalance.every((v) => v === null)).toBe(true);
  });

  it("drops rows outside the Globex hours and resets at each session start", () => {
    // Tuesday 17:30 ET (22:30Z, the daily break) is dropped; 18:00 ET (23:00Z) starts a new session: the quote is forgotten.
    const brk = Z("2024-03-05T22:30:00Z");
    const open = Z("2024-03-05T23:00:00Z");
    const l1: L1Row[] = [
      [T, 0, 18000, 10],
      [T, 1, 18000.25, 6],
      [brk, 2, 18001, 4],
      [open + 1000, 2, 18000.25, 5],
    ];
    const f = flowOf("2024-03-05", l1, null);
    expect(f.minutes.t).not.toContain(brk);
    const k = f.minutes.t.indexOf(open);
    // No quote and no previous print in the new session: the print has no side, so the minute is incomplete.
    expect([f.minutes.bv[k], f.minutes.sv[k], f.minutes.sideless[k]]).toEqual([0, 0, 5]);
  });

  it("a day whose hours don't start at 00:00 ET starts fresh, even when given a state", () => {
    // Thursday evening's session runs on past 24:00 ET: its end state holds a quote.
    const thu: L1Row[] = [
      [Z("2024-03-07T23:30:00Z"), 0, 18000, 10],
      [Z("2024-03-07T23:30:00Z"), 1, 18000.25, 6],
      [Z("2024-03-07T23:30:01Z"), 2, 18000.25, 1],
    ];
    const a = computeFlowDay(dayFile("2024-03-07", 3, null), L1(thu), null, null);
    expect(a.end.quote.ask).toBe(18000.25);
    // Sunday 18:00 ET (22:00Z after the DST change): a print at the old ask has no side in the new session.
    const open = Z("2024-03-10T22:00:00Z");
    const b = computeFlowDay(dayFile("2024-03-10", 1, null), L1([[open + 1000, 2, 18000.25, 2]]), null, a.end);
    expect(b.minutes.sideless[b.minutes.t.indexOf(open)]).toBe(2);
  });

  it("carries the engine over 00:00 ET into the next day of the session, and records the hashes", () => {
    const eve: L1Row[] = [
      [Z("2024-03-05T23:00:00Z"), 0, 18000, 10],
      [Z("2024-03-05T23:00:00Z"), 1, 18000.25, 6],
      [Z("2024-03-05T23:00:01Z"), 2, 18000.25, 1],
    ];
    const a = computeFlowDay(dayFile("2024-03-05", 3, null), L1(eve), null, null);
    const mid = Z("2024-03-06T05:00:00Z"); // 00:00 ET Wednesday
    const b = computeFlowDay(dayFile("2024-03-06", 1, null), L1([[mid + 1000, 2, 18000, 2]]), null, a.end);
    // The carried quote makes the first print after midnight a sell at the bid.
    const k = b.minutes.t.indexOf(mid);
    expect([b.minutes.bv[k], b.minutes.sv[k]]).toEqual([0, 2]);
    expect(b.startHash).toBe(a.endHash);
    expect(a.startHash).toBe(carryHash(null));
    // Fresh, the print would have no side.
    const fresh = computeFlowDay(dayFile("2024-03-06", 1, null), L1([[mid + 1000, 2, 18000, 2]]), null, null);
    expect(fresh.minutes.sideless[fresh.minutes.t.indexOf(mid)]).toBe(2);
  });
});

describe("minute records served (completeness and the replay clock)", () => {
  const { l1, l2 } = tuesday();
  const f = flowOf("2024-03-05", l1, l2);
  const get = (code: string, cutoff: number, days: FlowDay[] = [f], from = T, to = T + 4 * MIN) => flowRecords(reader(...days), summaryOf(...days), NQ_SCHEDULE, code, from, to, cutoff);

  it("a minute with L1 data, ended by the clock, on its contract, every print sided: complete", () => {
    const { byMinute } = get("H24", T + 10 * MIN);
    expect(byMinute.get(T)).toMatchObject({ bv: 3, sv: 2, complete: true, source: "history" });
    expect(byMinute.get(T + MIN)?.complete).toBe(true);
  });

  it("a minute without L1 rows is not complete (no data)", () => {
    expect(get("H24", T + 10 * MIN).byMinute.get(T + 2 * MIN)?.complete).toBe(false);
  });

  it("another contract than the data's is not complete (a roll-mismatch stretch)", () => {
    expect(get("M24", T + 10 * MIN).byMinute.get(T)?.complete).toBe(false);
  });

  it("nothing at or after the clock: the minute in progress and later ones are empty and incomplete", () => {
    const cutoff = T + MIN + 30_000;
    const { byMinute } = get("H24", cutoff);
    expect(byMinute.get(T)?.complete).toBe(true);
    // The current partial minute: incomplete, and its stored values are not read.
    expect(byMinute.get(T + MIN)).toMatchObject({ complete: false, bv: 0, sv: 0, volume: 0, trades: 0, ofiQuote: null, bookImbalance: null });
    // A minute ending exactly at the clock is complete.
    expect(get("H24", T + 2 * MIN).byMinute.get(T + MIN)?.complete).toBe(true);
  });

  it("stored values of minutes at or after the clock never reach a result", () => {
    const poisoned: FlowDay = structuredClone(f);
    for (let k = 0; k < poisoned.minutes.t.length; k++) {
      if (poisoned.minutes.t[k] >= T + MIN) {
        poisoned.minutes.bv[k] = 999;
        poisoned.minutes.l1Events[k] = 999;
      }
    }
    const a = get("H24", T + MIN + 1, [f]).byMinute;
    const b = get("H24", T + MIN + 1, [poisoned]).byMinute;
    expect(b).toEqual(a);
  });

  it("a day whose flow is not current (an L1 gap, or not built) has no minutes and is listed", () => {
    const res = flowRecords(reader(f), { ...summaryOf(f), days: [] }, NQ_SCHEDULE, "H24", T, T + 4 * MIN, T + 10 * MIN);
    expect(res.byMinute.size).toBe(0);
    expect(res.missingDays).toEqual(["2024-03-05"]);
    // A day without Globex hours (Saturday) isn't listed; nor is a day after the clock.
    expect(flowRecords(reader(), summaryOf(), NQ_SCHEDULE, "H24", Z("2024-03-09T15:00:00Z"), Z("2024-03-11T15:00:00Z"), Z("2024-03-12T00:00:00Z")).missingDays).toEqual(["2024-03-10", "2024-03-11"]);
    expect(flowRecords(reader(), summaryOf(), NQ_SCHEDULE, "H24", Z("2024-03-06T15:00:00Z"), Z("2024-03-06T15:10:00Z"), T).missingDays).toEqual([]);
  });

  it("a minute with an unsided print is not complete", () => {
    const g = flowOf("2024-03-05", [[T + 1000, 2, 18000, 3]], null);
    expect(flowRecords(reader(g), summaryOf(g), NQ_SCHEDULE, "H24", T, T, T + 5 * MIN).byMinute.get(T)).toMatchObject({ sidelessVolume: 3, complete: false });
  });

  it("an L2 gap day: imbalance null, still complete", () => {
    const g = flowOf("2024-03-05", l1, null);
    expect(flowRecords(reader(g), summaryOf(g), NQ_SCHEDULE, "H24", T, T, T + 5 * MIN).byMinute.get(T)).toMatchObject({ bookImbalance: null, ofiQuote: 0, complete: true });
  });

  it("a table exception stretch and an unassigned stretch are never complete", () => {
    const at = (date: EtDate, iso: string, code: string) => {
      const t = Z(iso);
      const g = flowOf(date, [[t, 0, 16000, 1], [t, 1, 16000.25, 1], [t + 1000, 2, 16000.25, 1]], null);
      return flowRecords(reader(g), summaryOf(g), NQ_SCHEDULE, code, t, t, t + 5 * MIN).byMinute.get(t)?.complete;
    };
    // 2023-12-06: the data is on H24 (exception) while Z23 is the front.
    expect(at("2023-12-06", "2023-12-06T15:00:00Z", "H24")).toBe(false);
    expect(at("2023-12-06", "2023-12-06T15:00:00Z", "Z23")).toBe(false);
    expect(at("2023-12-05", "2023-12-05T15:00:00Z", "Z23")).toBe(true);
    // 2025-02-09 (Sunday evening): unassigned.
    expect(at("2025-02-09", "2025-02-09T23:30:00Z", "H25")).toBe(false);
    expect(at("2025-02-10", "2025-02-10T15:00:00Z", "H25")).toBe(true);
  });
});

describe("flow build in the store", () => {
  it("build-store writes the flow of every day with L1, lists it in the manifest, and a rerun keeps it", async () => {
    const b = await builtStore();
    const m = readManifest(b.dataDir, "NQ");
    expect(m?.flow).toMatchObject({ format: FLOW_FORMAT, tick: 0.25, levels: 5, l1Grouping: "exchange-timestamp" });
    // The L1 days of the fixture (03-13 has nothing, 03-14 L2 only).
    expect(m?.flow?.days).toEqual(["2024-03-07", "2024-03-08", "2024-03-09", "2024-03-10", "2024-03-11", "2024-03-12"]);
    expect(b.summary.flowBuilt).toEqual(m?.flow?.days);
    expect(existsSync(flowDayPath(b.dataDir, "NQ", "2024-03-14"))).toBe(false);
    const again = await buildStore({ source: b.source, dataDir: b.dataDir, from: "202403", to: "202403" });
    expect(again.flowBuilt).toEqual([]);
    expect(again.flowSkipped).toEqual(m?.flow?.days);
    expect(readManifest(b.dataDir, "NQ")?.flow).toEqual(m?.flow);
  });

  it("rebuilds a day whose start state changed, and the manifest drops a day whose chain is broken", async () => {
    const b = await builtStore();
    const path = flowDayPath(b.dataDir, "NQ", "2024-03-07");
    const prev = readFlowDay(b.dataDir, "NQ", "2024-03-07") as FlowDay;
    const day8 = readDay(b.dataDir, "NQ", "2024-03-08") as DayFile;
    const f8 = readFlowDay(b.dataDir, "NQ", "2024-03-08");
    expect(flowCurrent(f8, day8, prev, NQ_SCHEDULE)).toBe(true);
    // Change 03-07's end state: 03-08 (which continues its session) is no longer current.
    const changed = { ...prev, end: { ...prev.end, lastTrade: 1 } };
    writeFileSync(path, gzipSync(JSON.stringify(changed)));
    expect(flowCurrent(f8, day8, changed, NQ_SCHEDULE)).toBe(false);
    const days = ["2024-03-07", "2024-03-08", "2024-03-09", "2024-03-10", "2024-03-11", "2024-03-12"].map((d) => readDay(b.dataDir, "NQ", d) as DayFile);
    expect(flowSummary(b.dataDir, "NQ", days, NQ_SCHEDULE).days).toEqual(["2024-03-07", "2024-03-09", "2024-03-10", "2024-03-11", "2024-03-12"]);
    // A rebuild redoes 03-08 only (03-07 still matches its own source and start).
    const again = await buildStore({ source: b.source, dataDir: b.dataDir, from: "202403", to: "202403" });
    expect(again.flowBuilt).toEqual(["2024-03-08"]);
    expect(JSON.parse(gunzipSync(readFileSync(flowDayPath(b.dataDir, "NQ", "2024-03-08"))).toString()).startHash).toBe(carryHash(changed.end));
  });

  it("a day whose previous day is stale isn't current, even when that day's old end state still matches", async () => {
    const b = await builtStore();
    const path = flowDayPath(b.dataDir, "NQ", "2024-03-07");
    const prev = readFlowDay(b.dataDir, "NQ", "2024-03-07") as FlowDay;
    // 03-07's source no longer matches (its end state is unchanged, so 03-08's start hash still does).
    writeFileSync(path, gzipSync(JSON.stringify({ ...prev, l1: { ...prev.l1, size: 12345 } })));
    const days = ["2024-03-07", "2024-03-08", "2024-03-09"].map((d) => readDay(b.dataDir, "NQ", d) as DayFile);
    expect(flowCurrent(readFlowDay(b.dataDir, "NQ", "2024-03-08"), days[1], readFlowDay(b.dataDir, "NQ", "2024-03-07"), NQ_SCHEDULE)).toBe(true);
    expect(flowSummary(b.dataDir, "NQ", days, NQ_SCHEDULE).days).toEqual(["2024-03-09"]);
  });

  it("a manifest whose flow is of another format serves no flow", async () => {
    const b = await builtStore();
    const p = join(b.dataDir, "derived", "NQ", "manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    expect(new DerivedStore(b.dataDir).flowRecords("NQ", "H24", T, T, T + MIN)).not.toBeNull();
    writeFileSync(p, JSON.stringify({ ...m, flow: { ...m.flow, format: FLOW_FORMAT - 1 } }));
    expect(new DerivedStore(b.dataDir).flowRecords("NQ", "H24", T, T, T + MIN)).toBeNull();
  });

  it("--no-flow builds the bars only; a flow file of another format is not used", async () => {
    const b = await builtStore(marchDays());
    const lines: string[] = [];
    const dir = b.dataDir.replace(/data$/, "data2");
    const s = await runBuildStoreCli(["--from", "202403", "--source", b.source, "--data-dir", dir, "--no-flow"], {}, (l) => lines.push(l));
    expect(s.flowBuilt).toEqual([]);
    expect(readManifest(dir, "NQ")?.flow).toBeUndefined();
    const path = flowDayPath(b.dataDir, "NQ", "2024-03-07");
    const f = JSON.parse(gunzipSync(readFileSync(path)).toString());
    writeFileSync(path, gzipSync(JSON.stringify({ ...f, format: FLOW_FORMAT + 1 })));
    expect(readFlowDay(b.dataDir, "NQ", "2024-03-07")).toBeNull();
    writeFileSync(path, "not gzip");
    expect(readFlowDay(b.dataDir, "NQ", "2024-03-07")).toBeNull();
  });
});
