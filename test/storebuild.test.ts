import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBuildStoreCli } from "../src/build-store.js";
import { addDays, weekday } from "../src/calendar.js";
import { dayPath, manifestPath, readDay, readManifest } from "../src/store.js";
import { NQ_SCHEDULE, NQ_TABLE } from "../src/rolltable.js";
import { buildManifest, buildStore, dateOfRows, monthRange } from "../src/storebuild.js";
import { tmp } from "./helpers.js";
import { l1Minutes, writeL1, writeL2, writeSource } from "./orderbook.js";
import { MIN, Z, builtStore, l2Pair, marchDays } from "./storefixture.js";

const us = (s: string) => Z(s) * 1000;

describe("store build", () => {
  it("writes one day file per ET day: its rule contract, raw bars from in-session trades, and the event index", async () => {
    const { dataDir, summary } = await builtStore();
    expect(summary.built).toEqual(["2024-03-07", "2024-03-08", "2024-03-09", "2024-03-10", "2024-03-11", "2024-03-12", "2024-03-14"]);
    const d7 = readDay(dataDir, "NQ", "2024-03-07")!;
    expect(d7.contract).toBe("H24");
    // The trade in the daily break (22:30Z) is dropped; 14:30 has three trades.
    expect(d7.bars).toEqual({
      t: [Z("2024-03-07T14:30:00Z"), Z("2024-03-07T14:31:00Z")],
      o: [18000, 18002],
      h: [18001.5, 18002],
      l: [17999.25, 18002],
      c: [17999.25, 18002],
      v: [3, 1],
    });
    expect(d7.l1).toMatchObject({ file: "l1/202403.parquet", rowGroup: 0, rows: 11, kept: 8, trades: 4 });
    expect(d7.l1!.index).toEqual([
      [Z("2024-03-07T14:30:00Z"), 0],
      [Z("2024-03-07T14:31:00Z"), 5],
      [Z("2024-03-07T22:30:00Z"), 8],
    ]);
    expect(d7.l2).toMatchObject({ file: "l2/202403.parquet", rowGroup: 0, rows: 4, kept: 4 });
    expect(d7.quoteStart).toEqual({ bid: null, bidSize: null, ask: null, askSize: null });
    expect(d7.quoteEnd).toEqual({ bid: 18001.75, bidSize: 5, ask: 18002, askSize: 4 });
    // Friday: after the 17:00 ET close nothing is kept; the quote carries over midnight from Thursday.
    const d8 = readDay(dataDir, "NQ", "2024-03-08")!;
    expect(d8.bars.t).toEqual([Z("2024-03-08T14:30:00Z"), Z("2024-03-08T14:31:00Z")]);
    expect(d8.bars.c).toEqual([18010, 18010.25]);
    expect(d8.quoteStart).toEqual(d7.quoteEnd);
    // Saturday: rows, none kept.
    expect(readDay(dataDir, "NQ", "2024-03-09")!).toMatchObject({ bars: { t: [] }, l1: { rows: 1, kept: 0 } });
  });

  it("keys days by the roll rule across the roll Monday's 00:00 ET, dropping rows past the end of the ET day", async () => {
    const { dataDir } = await builtStore();
    const sun = readDay(dataDir, "NQ", "2024-03-10")!;
    expect(sun.contract).toBe("H24");
    // The rows at 04:30Z Monday in Sunday's row group are past 00:00 ET Monday: dropped.
    expect(sun.bars.t).toEqual([Z("2024-03-10T22:00:00Z"), Z("2024-03-10T22:01:00Z")]);
    expect(sun.l1).toMatchObject({ rows: 9, kept: 6 });
    expect(sun.quoteStart.bid).toBeNull(); // a Sunday opens a session: nothing carried
    const mon = readDay(dataDir, "NQ", "2024-03-11")!;
    expect(mon.contract).toBe("M24");
    expect(mon.bars.t[0]).toBe(Z("2024-03-11T04:00:00Z"));
    expect(mon.bars.c).toEqual([18270, 18270.5, 18271]);
    expect(mon.quoteStart.bid).toBeNull(); // a roll: the old contract's quote isn't carried
  });

  it("records the manifest: months, contracts by the roll table, gaps per day, the table itself", async () => {
    const { dataDir, source, summary, lines } = await builtStore();
    const m = readManifest(dataDir, "NQ")!;
    expect(m).toEqual(summary.manifest);
    expect(m.source).toBe(source);
    expect(m.months).toEqual(["202403"]);
    expect(m.contracts).toEqual({
      H24: { first: "2024-03-07T14:30:00.000Z", last: "2024-03-10T22:01:00.000Z", bars: 6, days: ["2024-03-07", "2024-03-08", "2024-03-10"] },
      M24: { first: "2024-03-11T04:00:00.000Z", last: "2024-03-12T14:31:00.000Z", bars: 5, days: ["2024-03-11", "2024-03-12"] },
    });
    const weekdays: string[] = [];
    for (let d = "2024-03-01"; d < "2024-04-01"; d = addDays(d, 1)) if (weekday(d) % 6 !== 0) weekdays.push(d);
    const holidays = ["2024-03-29"];
    expect(m.gaps.holidays).toEqual(holidays);
    expect(m.gaps.l1).toEqual(weekdays.filter((d) => !["2024-03-07", "2024-03-08", "2024-03-11", "2024-03-12", ...holidays].includes(d)));
    expect(m.gaps.l2).toEqual(weekdays.filter((d) => !["2024-03-07", "2024-03-08", "2024-03-11", "2024-03-14", ...holidays].includes(d)));
    expect(m.gaps.l1).toContain("2024-03-13");
    expect(m.gaps.l1).toContain("2024-03-14");
    expect(m.gaps.l2).toContain("2024-03-12");
    expect(m.days["2024-03-14"]).toEqual({ contract: "M24", l1Rows: 0, l1Kept: 0, trades: 0, bars: 0, l2Rows: 2, l2Kept: 2 });
    expect(m.days["2024-03-12"]).toMatchObject({ l2Rows: null, l2Kept: null, bars: 2 });
    expect(m.rollTable).toEqual({ ...NQ_TABLE, hash: NQ_SCHEDULE.hash });
    expect(m.dropped).toEqual([]);
    expect(lines.at(-1)).toMatch(/^done: 7 days built, 0 up to date, \d+ rows read .*0 day files left out; order flow: 6 days built, 0 up to date, 6 current in the store$/);
    expect(lines).toContain("2024-03-11 NQM24: L1 9 rows (9 kept, 3 trades, 3 bars), L2 2 rows, " + lines.find((l) => l.startsWith("2024-03-11"))!.split(", L2 2 rows, ")[1]);
  });

  it("resumes: an up-to-date day is skipped, a missing or stale one is rebuilt, and a rerun changes nothing", async () => {
    const { dataDir, source } = await builtStore();
    const before = readFileSync(manifestPath(dataDir, "NQ"), "utf8");
    const again = await buildStore({ source, dataDir, from: "202403", to: "202403" });
    expect(again.built).toEqual([]);
    expect(again.skipped).toHaveLength(7);
    expect(again.rows).toBe(0);
    expect(readFileSync(manifestPath(dataDir, "NQ"), "utf8")).toBe(before);
    rmSync(dayPath(dataDir, "NQ", "2024-03-11"));
    const resumed = await buildStore({ source, dataDir, from: "202403", to: "202403" });
    expect(resumed.built).toEqual(["2024-03-11"]);
    expect(readFileSync(manifestPath(dataDir, "NQ"), "utf8")).toBe(before);
  });

  it("rebuilds days whose L1 or L2 source changed: by size, or by modification time alone", async () => {
    const { dataDir, source } = await builtStore();
    // Only the L2 file changes (same L1): the days with L2 rows are rebuilt.
    const days = marchDays();
    writeL2(join(source, "l2", "202403.parquet"), [days["2024-03-07"].l2!, days["2024-03-08"].l2!, days["2024-03-09"].l2!, days["2024-03-10"].l2!, days["2024-03-11"].l2!, [...days["2024-03-14"].l2!, ...l2Pair(Z("2024-03-14T15:00:00Z"), 18290)]]);
    const l2only = await buildStore({ source, dataDir, from: "202403", to: "202403" });
    expect(l2only.built).toEqual(["2024-03-07", "2024-03-08", "2024-03-09", "2024-03-10", "2024-03-11", "2024-03-14"]);
    expect(readDay(dataDir, "NQ", "2024-03-14")!.l2!.rows).toBe(4);
    // Same size, new mtime: rebuilt too.
    const l1 = join(source, "l1", "202403.parquet");
    const later = new Date(statSync(l1).mtimeMs + 5000);
    utimesSync(l1, later, later);
    const touched = await buildStore({ source, dataDir, from: "202403", to: "202403" });
    expect(touched.built).toEqual(["2024-03-07", "2024-03-08", "2024-03-09", "2024-03-10", "2024-03-11", "2024-03-12"]);
    // A changed L1 (another size) rebuilds its days, with the new bars.
    days["2024-03-12"].l1 = l1Minutes(Z("2024-03-12T14:30:00Z"), 3, 18280);
    writeSource(source, days);
    await buildStore({ source, dataDir, from: "202403", to: "202403" });
    expect(readDay(dataDir, "NQ", "2024-03-12")!.bars.t).toHaveLength(3);
  });

  it("rebuilds a truncated day file instead of aborting, and leaves unreadable or stale ones out of the manifest", async () => {
    const { dataDir, source } = await builtStore();
    const p = dayPath(dataDir, "NQ", "2024-03-08");
    writeFileSync(p, readFileSync(p).subarray(0, 20));
    const lines: string[] = [];
    const s = await buildStore({ source, dataDir, from: "202403", to: "202403", log: (l) => lines.push(l) });
    expect(s.built).toEqual(["2024-03-08"]);
    expect(lines.some((l) => l.includes(p) && l.includes("rebuilt"))).toBe(true);
    expect(readDay(dataDir, "NQ", "2024-03-08")!.bars.c).toEqual([18010, 18010.25]);
    // A day file whose source is gone (here: from another month's source) is left out.
    writeFileSync(dayPath(dataDir, "NQ", "2024-02-05"), readFileSync(dayPath(dataDir, "NQ", "2024-03-07")));
    writeFileSync(dayPath(dataDir, "NQ", "2024-03-09"), readFileSync(p).subarray(0, 20));
    const m = buildManifest(dataDir, "NQ", source, ["202403"], [], NQ_SCHEDULE);
    expect(m.dropped).toEqual([
      { date: "2024-02-05", reason: "its source file changed or is gone, or its month isn't built" },
      { date: "2024-03-09", reason: "unreadable" },
    ]);
    expect(m.days["2024-02-05"]).toBeUndefined();
    rmSync(join(source, "l2", "202403.parquet"));
    const gone = buildManifest(dataDir, "NQ", source, ["202403"], [], NQ_SCHEDULE);
    expect(gone.days["2024-03-07"]).toBeUndefined(); // its L2 file is gone
    expect(gone.days["2024-03-12"]).toBeDefined(); // no L2: still current
  });

  it("rebuilds a day whose carried quote changed because the day before it was rebuilt", async () => {
    const { dataDir, source } = await builtStore();
    const days = marchDays();
    // Thursday ends on another quote: Friday starts from it, so Friday is rebuilt although its source is the same.
    days["2024-03-07"].l1 = [...days["2024-03-07"].l1!.slice(0, 8), [Z("2024-03-07T14:31:30Z"), 0, 18001, 9]];
    writeL1(join(source, "l1", "202403.parquet"), ["2024-03-07", "2024-03-08", "2024-03-09", "2024-03-10", "2024-03-11", "2024-03-12"].map((d) => days[d].l1!));
    const s = await buildStore({ source, dataDir, from: "202403", to: "202403" });
    expect(s.built).toContain("2024-03-08");
    expect(readDay(dataDir, "NQ", "2024-03-08")!.quoteStart).toMatchObject({ bid: 18001, bidSize: 9 });
  });

  it("allows one build at a time per store", async () => {
    const { dataDir, source } = await builtStore();
    writeFileSync(join(dataDir, "derived", "NQ", "build.lock"), "123");
    await expect(buildStore({ source, dataDir, from: "202403", to: "202403" })).rejects.toThrow(/another build-store is running .*delete the lock/);
    rmSync(join(dataDir, "derived", "NQ", "build.lock"));
    expect((await buildStore({ source, dataDir, from: "202403", to: "202403" })).built).toEqual([]);
    expect(existsSync(join(dataDir, "derived", "NQ", "build.lock"))).toBe(false);
  });

  it("takes the ET date of a row group from its middle row, not its first", () => {
    const us = (s: string) => Z(s) * 1000;
    // One stray row from the evening before, then the day's rows.
    expect(dateOfRows(Float64Array.from([us("2024-03-05T03:00:00Z"), us("2024-03-05T14:00:00Z"), us("2024-03-05T15:00:00Z")]))).toBe("2024-03-05");
    // Rows past the day's end at the tail don't move it either.
    expect(dateOfRows(Float64Array.from([us("2024-03-10T22:00:00Z"), us("2024-03-10T23:00:00Z"), us("2024-03-11T05:00:00Z")]))).toBe("2024-03-10");
  });

  it("adds months to an existing store and records months with no source file", async () => {
    const { dataDir, source } = await builtStore();
    writeSource(source, { "2024-04-01": { l1: l1Minutes(Z("2024-04-01T14:30:00Z"), 1, 18300) } });
    const s = await buildStore({ source, dataDir, from: "202404", to: "202405" });
    expect(s.months).toEqual(["202404"]);
    expect(s.missingMonths).toEqual(["202405"]);
    const m = readManifest(dataDir, "NQ")!;
    expect(m.months).toEqual(["202403", "202404"]);
    expect(m.missingMonths).toEqual(["202405"]);
    expect(m.contracts.M24.last).toBe("2024-04-01T14:30:00.000Z");
    expect(m.gaps.l1).toContain("2024-04-02");
    expect(m.gaps.l2).toContain("2024-04-01");
  });

  it("keeps the first of two row groups for the same ET day", async () => {
    const dir = tmp();
    const source = join(dir, "src");
    writeSource(source, { "2024-03-05": { l1: l1Minutes(Z("2024-03-05T14:30:00Z"), 1, 18000) } });
    writeL1(join(source, "l1", "202403.parquet"), [l1Minutes(Z("2024-03-05T14:30:00Z"), 1, 18000), l1Minutes(Z("2024-03-05T15:30:00Z"), 1, 19000), []]);
    const lines: string[] = [];
    const s = await buildStore({ source, dataDir: join(dir, "data"), from: "202403", to: "202403", log: (l) => lines.push(l) });
    expect(s.built).toEqual(["2024-03-05"]);
    expect(readDay(join(dir, "data"), "NQ", "2024-03-05")!.bars.c).toEqual([18000]);
    expect(lines).toContain("202403: L1 row group 1 repeats 2024-03-05; the first one is kept");
  });

  it("assigns bars by the roll table: the early 2024-09 data roll puts Thursday-to-Sunday bars on Z24", async () => {
    const days = {
      "2024-09-11": { l1: l1Minutes(Z("2024-09-11T14:30:00Z"), 2, 19300) },
      "2024-09-12": { l1: [...l1Minutes(Z("2024-09-12T04:00:00Z"), 1, 19530), ...l1Minutes(Z("2024-09-12T14:30:00Z"), 1, 19540)] },
      "2024-09-16": { l1: l1Minutes(Z("2024-09-16T14:30:00Z"), 1, 19600) },
    };
    const { dataDir } = await builtStore(days, ["202409", "202409"]);
    const m = readManifest(dataDir, "NQ")!;
    expect(m.contracts).toEqual({
      U24: { first: "2024-09-11T14:30:00.000Z", last: "2024-09-11T14:31:00.000Z", bars: 2, days: ["2024-09-11"] },
      Z24: { first: "2024-09-12T04:00:00.000Z", last: "2024-09-16T14:30:00.000Z", bars: 3, days: ["2024-09-12", "2024-09-16"] },
    });
    expect(m.days["2024-09-12"].contract).toBe("Z24");
    expect(m.days["2024-09-11"].contract).toBe("U24");
  });

  it("serves nothing outside the table, and nothing of a contract past its expiry", async () => {
    // 2022-06-17: the data is back on M22 until its expiry (13:30Z), unassigned after it.
    const days = {
      "2022-06-17": { l1: [...l1Minutes(Z("2022-06-17T13:29:00Z"), 1, 11160), ...l1Minutes(Z("2022-06-17T14:00:00Z"), 1, 11170)] },
    };
    const { dataDir } = await builtStore(days, ["202206", "202206"]);
    const m = readManifest(dataDir, "NQ")!;
    expect(m.contracts).toEqual({ M22: { first: "2022-06-17T13:29:00.000Z", last: "2022-06-17T13:29:00.000Z", bars: 1, days: ["2022-06-17"] } });
    const early = await builtStore({ "2021-03-05": { l1: l1Minutes(Z("2021-03-05T14:30:00Z"), 1, 13000) } }, ["202103", "202103"]);
    expect(readManifest(early.dataDir, "NQ")!.contracts).toEqual({});
    expect(readDay(early.dataDir, "NQ", "2021-03-05")!.contract).toBeNull();
  });

  it("refuses a store inside the read-only source, a source without l1/, and bad months", async () => {
    const dir = tmp();
    writeSource(join(dir, "src"), { "2024-03-05": { l1: l1Minutes(Z("2024-03-05T14:30:00Z"), 1, 18000) } });
    await expect(buildStore({ source: join(dir, "src"), dataDir: join(dir, "src"), from: "202403", to: "202403" })).rejects.toThrow(/must not be inside the source/);
    await expect(buildStore({ source: dir, dataDir: join(dir, "d"), from: "202403", to: "202403" })).rejects.toThrow(/no l1\/ folder/);
    expect(monthRange("202411", "202502")).toEqual(["202411", "202412", "202501", "202502"]);
    expect(() => monthRange("2024-11", "202502")).toThrow(/YYYYMM/);
    expect(() => monthRange("202413", "202502")).toThrow(/YYYYMM/);
    expect(() => monthRange("202502", "202411")).toThrow(/before --from/);
    expect(existsSync(join(dir, "src", "derived"))).toBe(false);
  });
});

describe("build-store CLI", () => {
  it("builds from flags or env, logs progress, and explains its usage", async () => {
    const dir = tmp();
    const source = join(dir, "src");
    writeSource(source, { "2024-03-05": { l1: l1Minutes(Z("2024-03-05T14:30:00Z"), 2, 18000) } });
    const lines: string[] = [];
    const s = await runBuildStoreCli(["--from", "202403"], { BACKTESTER_ORDERBOOK_DIR: source, BACKTESTER_DATA_DIR: join(dir, "data") }, (l) => lines.push(l));
    expect(s.built).toEqual(["2024-03-05"]);
    expect(lines.length).toBeGreaterThan(1);
    const t = await runBuildStoreCli(["--from", "202403", "--to", "202403", "--source", source, "--data-dir", join(dir, "d2")], {}, () => {});
    expect(t.built).toEqual(["2024-03-05"]);
    expect(statSync(join(dir, "d2", "derived", "NQ", "manifest.json")).isFile()).toBe(true);
    await expect(runBuildStoreCli([], {})).rejects.toThrow(/usage: build-store/);
  });
});

void us;
void MIN;
