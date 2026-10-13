import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBuildStoreCli } from "../src/build-store.js";
import { addDays, weekday } from "../src/calendar.js";
import { DerivedStore, dayPath, manifestPath, readDay, readManifest } from "../src/store.js";
import { flowDayPath } from "../src/flowstore.js";
import { gunzipSync, gzipSync } from "node:zlib";
import { NQ_SCHEDULE, NQ_TABLE } from "../src/rolltable.js";
import { buildManifest, buildStore, monthRange } from "../src/storebuild.js";
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
    expect(lines.at(-1)).toMatch(
      /^done: 7 days built, 0 up to date, \d+ rows read .*; gaps L1 16, L2 16, \d+ minute runs; 0 day files left out; 1 day conflicts, 0 row groups quarantined; order flow: 6 days built, 0 up to date, 6 current in the store$/,
    );
    expect(lines).toContain("2024-03-11 NQM24: L1 9 rows (9 kept, 3 trades, 3 bars), L2 2 rows, " + lines.find((l) => l.startsWith("2024-03-11"))!.split(", L2 2 rows, ")[1]);
  });

  it("resumes: an up-to-date day is skipped, a missing or stale one is rebuilt, and a rerun changes nothing", async () => {
    const { dataDir, source } = await builtStore();
    const before = readFileSync(manifestPath(dataDir, "NQ"), "utf8");
    const again = await buildStore({ source, dataDir, from: "202403", to: "202403" });
    expect(again.built).toEqual([]);
    expect(again.skipped).toHaveLength(7);
    // Only the census of the one row group whose statistics span two ET days (Sunday's, 9 rows) is read again.
    expect(again.rows).toBe(9);
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

  it("keeps the first of two row groups that fit the same ET day equally, and records the conflict", async () => {
    const dir = tmp();
    const source = join(dir, "src");
    writeSource(source, { "2024-03-05": { l1: l1Minutes(Z("2024-03-05T14:30:00Z"), 1, 18000) } });
    writeL1(join(source, "l1", "202403.parquet"), [l1Minutes(Z("2024-03-05T14:30:00Z"), 1, 18000), l1Minutes(Z("2024-03-05T15:30:00Z"), 1, 19000), []]);
    const lines: string[] = [];
    const s = await buildStore({ source, dataDir: join(dir, "data"), from: "202403", to: "202403", log: (l) => lines.push(l) });
    expect(s.built).toEqual(["2024-03-05"]);
    expect(readDay(join(dir, "data"), "NQ", "2024-03-05")!.bars.c).toEqual([18000]);
    expect(lines).toContain("202403: l1/202403.parquet row groups 0, 1 all have rows on 2024-03-05; row group 0 is kept (3 rows there)");
    expect(readManifest(join(dir, "data"), "NQ")!.assignment.conflicts).toEqual([
      { date: "2024-03-05", file: "l1/202403.parquet", kept: { rowGroup: 0, rows: 3, share: 1 }, dropped: [{ rowGroup: 1, rows: 3, share: 1 }] },
    ]);
  });

  it("dates rows by their own timestamps: a late Sunday file no longer takes Monday's place (the 2024-06-10 bug)", async () => {
    // Sunday 2024-05-12's file runs late: 6 minutes still on Sunday (22:00 EDT = 02:00Z), 10 past 00:00 ET Monday.
    // Its middle row is Monday's: dated by it, Monday's own row group was dropped ("repeats; the first one is kept").
    const dir = tmp();
    const source = join(dir, "src");
    const dataDir = join(dir, "data");
    const sunday = [...l1Minutes(Z("2024-05-13T02:00:00Z"), 6, 18500), ...l1Minutes(Z("2024-05-13T04:00:00Z"), 10, 18600)];
    const monday = [...l1Minutes(Z("2024-05-13T04:00:00Z"), 5, 18000, 0.25), ...l1Minutes(Z("2024-05-13T13:30:00Z"), 5, 18100)];
    writeSource(source, { "2024-05-14": { l1: l1Minutes(Z("2024-05-14T13:30:00Z"), 1, 18200) } });
    writeL1(join(source, "l1", "202405.parquet"), [sunday, monday, l1Minutes(Z("2024-05-14T13:30:00Z"), 1, 18200)]);
    const lines: string[] = [];
    const s = await buildStore({ source, dataDir, from: "202405", to: "202405", log: (l) => lines.push(l) });
    expect(s.built).toEqual(["2024-05-12", "2024-05-13", "2024-05-14"]);
    const mon = readDay(dataDir, "NQ", "2024-05-13")!;
    expect(mon.l1).toMatchObject({ rowGroup: 1, rows: 30 });
    expect(mon.bars.t).toHaveLength(10);
    expect(mon.bars.c.slice(0, 5)).toEqual([18000, 18000.25, 18000.5, 18000.75, 18001]);
    // Sunday keeps its own hours' rows of its file (not quarantined: the quarantine is a reviewed table).
    expect(readDay(dataDir, "NQ", "2024-05-12")!.bars.t).toEqual(Array.from({ length: 6 }, (_, i) => Z("2024-05-13T02:00:00Z") + i * MIN));
    const m = readManifest(dataDir, "NQ")!;
    expect(m.assignment.conflicts).toEqual([
      { date: "2024-05-13", file: "l1/202405.parquet", kept: { rowGroup: 1, rows: 30, share: 1 }, dropped: [{ rowGroup: 0, rows: 30, share: 0.625 }] },
    ]);
    expect(m.assignment.outside).toEqual([{ file: "l1/202405.parquet", rowGroup: 0, rows: 48, day: "2024-05-13", outside: 18, share: 0.375 }]);
    expect(m.assignment.unchecked).toEqual([]);
    expect(lines).toContain("202405: l1/202405.parquet row groups 1, 0 all have rows on 2024-05-13; row group 1 is kept (30 rows there)");
  });

  it("never serves a quarantined row group: the late 2024-06-09 file (L1 group 8, L2 group 7)", async () => {
    const dir = tmp();
    const source = join(dir, "src");
    const dataDir = join(dir, "data");
    const day = (d: string, h: string, price: number) => l1Minutes(Z(`${d}T${h}:00Z`), 2, price);
    // L1: 0 Sat stray, 1 Sun, 2-6 Mon-Fri, 7 Sat stray, 8 the late Sunday (02:03Z-08:03Z), 9 Monday 06-10.
    const late = [...l1Minutes(Z("2024-06-10T02:03:00Z"), 3, 19500), ...l1Minutes(Z("2024-06-10T07:00:00Z"), 3, 19600)];
    const l1 = [
      [[Z("2024-06-01T07:46:00Z"), 2, 19000, 1] as [number, number, number, number]],
      day("2024-06-02", "22:00", 19010),
      ...["03", "04", "05", "06", "07"].map((d, i) => day(`2024-06-${d}`, "13:30", 19020 + i)),
      [[Z("2024-06-08T07:46:00Z"), 2, 19000, 1] as [number, number, number, number]],
      late,
      [...l1Minutes(Z("2024-06-10T04:00:00Z"), 3, 19100), ...l1Minutes(Z("2024-06-10T13:30:00Z"), 2, 19110)],
    ];
    mkdirSync(join(source, "l1"), { recursive: true });
    mkdirSync(join(source, "l2"), { recursive: true });
    writeL1(join(source, "l1", "202406.parquet"), l1);
    const l2 = [
      l2Pair(Z("2024-06-02T22:00:00Z"), 19010),
      ...["03", "04", "05", "06", "07"].map((d) => l2Pair(Z(`2024-06-${d}T13:30:00Z`), 19020)),
      l2Pair(Z("2024-06-08T07:46:00Z"), 19000),
      [...l2Pair(Z("2024-06-10T02:03:00Z"), 19500), ...l2Pair(Z("2024-06-10T07:00:00Z"), 19600)],
      l2Pair(Z("2024-06-10T04:00:00Z"), 19100),
    ];
    writeL2(join(source, "l2", "202406.parquet"), l2);
    const lines: string[] = [];
    await buildStore({ source, dataDir, from: "202406", to: "202406", log: (l) => lines.push(l) });
    expect(readDay(dataDir, "NQ", "2024-06-09")).toBeNull();
    const mon = readDay(dataDir, "NQ", "2024-06-10")!;
    expect(mon.l1).toMatchObject({ rowGroup: 9 });
    expect(mon.l2).toMatchObject({ rowGroup: 8 });
    expect(mon.bars.c).toEqual([19100, 19100, 19100, 19110, 19110]);
    expect(mon.bars.c).not.toContain(19500);
    expect(mon.bars.c).not.toContain(19600);
    const m = readManifest(dataDir, "NQ")!;
    expect(m.assignment.quarantined).toEqual([
      { date: "2024-06-09", file: "l1/202406.parquet", rowGroup: 8, rows: 18, offsetMinutes: 243, rowsChanged: true, missing: false },
      { date: "2024-06-09", file: "l2/202406.parquet", rowGroup: 7, rows: 4, offsetMinutes: 243, rowsChanged: true, missing: false },
    ]);
    expect(m.assignment.conflicts).toEqual([]);
    expect(m.assignment.quarantineHash).toMatch(/^[0-9a-f]{64}$/);
    expect(lines).toContain("202406: l1/202406.parquet row group 8 quarantined (2024-06-09, clock 243 min late): 18 rows, not the reviewed count (review the quarantine table)");
    // The Sunday session is a gap in the minute list: 18:00 EDT Sunday to Monday's first row at 00:00 ET.
    expect(m.gaps.minutes).toContainEqual({ from: "2024-06-09T22:00:00.000Z", to: "2024-06-10T04:00:00.000Z", minutes: 360 });
  });

  it("removes the day file of a date no row group serves any more", async () => {
    const { dataDir, source } = await builtStore();
    const days = marchDays();
    delete days["2024-03-12"];
    writeSource(source, days);
    const s = await buildStore({ source, dataDir, from: "202403", to: "202403" });
    expect(s.removed).toEqual(["2024-03-12"]);
    expect(existsSync(dayPath(dataDir, "NQ", "2024-03-12"))).toBe(false);
    expect(readManifest(dataDir, "NQ")!.days["2024-03-12"]).toBeUndefined();
  });

  it("drops stray prints of a closed holiday by the CME calendar: 2022-12-26 trades from 18:00 ET only", async () => {
    const days = {
      "2022-12-23": { l1: l1Minutes(Z("2022-12-23T14:30:00Z"), 1, 11000) },
      "2022-12-26": { l1: [...l1Minutes(Z("2022-12-26T19:44:00Z"), 1, 11500), ...l1Minutes(Z("2022-12-26T23:00:00Z"), 2, 11010)] },
      "2022-12-27": { l1: l1Minutes(Z("2022-12-27T14:30:00Z"), 1, 11020) },
    };
    const { dataDir } = await builtStore(days, ["202212", "202212"]);
    const d = readDay(dataDir, "NQ", "2022-12-26")!;
    expect(d.sessions).toEqual([[Z("2022-12-26T23:00:00Z"), Z("2022-12-27T05:00:00Z")]]);
    expect(d.bars.t).toEqual([Z("2022-12-26T23:00:00Z"), Z("2022-12-26T23:01:00Z")]);
    expect(d.quoteStart.bid).toBeNull();
    const m = readManifest(dataDir, "NQ")!;
    expect(m.gaps.holidays).toEqual(["2022-12-26"]);
    // No expected minutes on Christmas Sunday or Monday before 18:00 ET.
    expect(m.gaps.minutes.some((r) => Date.parse(r.from) < Z("2022-12-26T23:00:00Z") && Date.parse(r.to) > Z("2022-12-23T22:00:00Z"))).toBe(false);
  });

  it("lists the expected minutes without data as runs (gaps.minutes)", async () => {
    const { dataDir } = await builtStore();
    const runs = readManifest(dataDir, "NQ")!.gaps.minutes;
    expect(runs[0]).toEqual({ from: "2024-03-01T05:00:00.000Z", to: "2024-03-01T22:00:00.000Z", minutes: 1020 });
    // Thursday 03-07: data 14:30-14:31Z (the 22:30Z print is in the daily break: not expected, not data).
    expect(runs).toContainEqual({ from: "2024-03-07T14:32:00.000Z", to: "2024-03-07T22:00:00.000Z", minutes: 448 });
    // Over midnight into Friday: one run.
    expect(runs).toContainEqual({ from: "2024-03-07T23:00:00.000Z", to: "2024-03-08T14:30:00.000Z", minutes: 930 });
    // Sunday 03-10 (DST) to Monday's first row at 04:00Z.
    expect(runs).toContainEqual({ from: "2024-03-10T22:02:00.000Z", to: "2024-03-11T04:00:00.000Z", minutes: 358 });
    // Good Friday: nothing expected from Thursday 17:00 ET to Sunday 18:00 ET.
    expect(runs).toContainEqual({ from: "2024-03-27T22:00:00.000Z", to: "2024-03-28T21:00:00.000Z", minutes: 1380 });
    expect(runs.at(-1)).toEqual({ from: "2024-03-31T22:00:00.000Z", to: "2024-04-01T04:00:00.000Z", minutes: 360 });
  });

  it("is crash-safe: a build that stops midway leaves the store marked and refused until a build completes", async () => {
    const { dataDir, source } = await builtStore();
    const days = marchDays();
    days["2024-03-12"].l1 = l1Minutes(Z("2024-03-12T14:30:00Z"), 3, 18280);
    writeSource(source, days);
    const crash = (l: string) => {
      if (l.startsWith("2024-03-08 ")) throw new Error("simulated crash");
    };
    await expect(buildStore({ source, dataDir, from: "202403", to: "202403", log: crash })).rejects.toThrow("simulated crash");
    expect(existsSync(join(dataDir, "derived", "NQ", "building.json"))).toBe(true);
    expect(new DerivedStore(dataDir).manifest("NQ")).toBeNull();
    expect(new DerivedStore(dataDir).refusal("NQ")).toBe("a build-store run is in progress or was interrupted");
    await buildStore({ source, dataDir, from: "202403", to: "202403" });
    expect(existsSync(join(dataDir, "derived", "NQ", "building.json"))).toBe(false);
    expect(new DerivedStore(dataDir).refusal("NQ")).toBeNull();
    expect(new DerivedStore(dataDir).manifest("NQ")!.days["2024-03-12"].bars).toBe(3);
  });

  it("rebuilds a day's order flow when only its hours change (same source rows and start state)", async () => {
    const days = {
      "2022-12-26": { l1: [...l1Minutes(Z("2022-12-26T19:44:00Z"), 1, 11500), ...l1Minutes(Z("2022-12-26T23:00:00Z"), 2, 11010)] },
      "2022-12-27": { l1: l1Minutes(Z("2022-12-27T14:30:00Z"), 1, 11020) },
    };
    const { dataDir, source } = await builtStore(days, ["202212", "202212"]);
    // A flow file from before the calendar: computed over globexRanges (the 19:44Z print as a minute), no hours recorded.
    const p = flowDayPath(dataDir, "NQ", "2022-12-26");
    const f = JSON.parse(gunzipSync(readFileSync(p)).toString("utf8"));
    const startHash = f.startHash;
    delete f.sessions;
    f.minutes.t.unshift(Z("2022-12-26T19:44:00Z"));
    writeFileSync(p, gzipSync(JSON.stringify(f)));
    const s = await buildStore({ source, dataDir, from: "202212", to: "202212" });
    expect(s.built).toEqual([]);
    expect(s.flowBuilt).toEqual(["2022-12-26"]);
    const g = JSON.parse(gunzipSync(readFileSync(p)).toString("utf8"));
    expect(g.startHash).toBe(startHash);
    expect(g.minutes.t[0]).toBe(Z("2022-12-26T23:00:00Z"));
  });

  it("lists months without a current assignment report as unchecked", async () => {
    const { dataDir, source } = await builtStore();
    rmSync(join(dataDir, "derived", "NQ", "assign", "202403.json"));
    expect(buildManifest(dataDir, "NQ", source, ["202403"], [], NQ_SCHEDULE).assignment.unchecked).toEqual(["202403"]);
    writeFileSync(join(dataDir, "derived", "NQ", "assign", "202403.json"), "{");
    expect(buildManifest(dataDir, "NQ", source, ["202403"], [], NQ_SCHEDULE).assignment.unchecked).toEqual(["202403"]);
    // Assigned with another quarantine table: unchecked too.
    await buildStore({ source, dataDir, from: "202403", to: "202403" });
    const p = join(dataDir, "derived", "NQ", "assign", "202403.json");
    expect(buildManifest(dataDir, "NQ", source, ["202403"], [], NQ_SCHEDULE).assignment.unchecked).toEqual([]);
    const report = JSON.parse(readFileSync(p, "utf8"));
    writeFileSync(p, JSON.stringify({ ...report, quarantineHash: "0".repeat(64) }));
    expect(buildManifest(dataDir, "NQ", source, ["202403"], [], NQ_SCHEDULE).assignment.unchecked).toEqual(["202403"]);
    // The L2 file the month was assigned from changed, or one appeared where it had none: unchecked.
    writeFileSync(p, JSON.stringify({ ...report, l2: { ...report.l2, size: report.l2.size + 1 } }));
    expect(buildManifest(dataDir, "NQ", source, ["202403"], [], NQ_SCHEDULE).assignment.unchecked).toEqual(["202403"]);
    writeFileSync(p, JSON.stringify({ ...report, l2: null }));
    expect(buildManifest(dataDir, "NQ", source, ["202403"], [], NQ_SCHEDULE).assignment.unchecked).toEqual(["202403"]);
    writeFileSync(p, JSON.stringify(report));
    expect(buildManifest(dataDir, "NQ", source, ["202403"], [], NQ_SCHEDULE).assignment.unchecked).toEqual([]);
    rmSync(join(source, "l2", "202403.parquet"));
    expect(buildManifest(dataDir, "NQ", source, ["202403"], [], NQ_SCHEDULE).assignment.unchecked).toEqual(["202403"]);
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
