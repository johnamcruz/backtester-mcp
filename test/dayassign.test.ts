import { describe, expect, it } from "vitest";
import { assertConflicts, assignDays, censusFromStats, censusOf, missingRuns, quarantineHashOf, quarantineOf, quarantineTableOf, type GroupCensus } from "../src/dayassign.js";
import { NQ_QUARANTINE, type QuarantineEntry } from "../src/quarantine-nq.js";
import { weekday } from "../src/calendar.js";

const Z = (s: string) => Date.parse(s);
const us = (s: string) => Z(s) * 1000;
const F = "l1/202406.parquet";
const g = (rowGroup: number, byDate: Record<string, number>): GroupCensus => ({ file: F, rowGroup, rows: Object.values(byDate).reduce((a, b) => a + b, 0), byDate });

describe("census", () => {
  it("counts rows per ET date by their own timestamps", () => {
    // 2024-06-10 00:00 ET = 04:00Z: a late Sunday file's rows past it are Monday's.
    const ts = Float64Array.from([us("2024-06-10T02:03:00Z"), us("2024-06-10T03:59:59.999Z"), us("2024-06-10T04:00:00Z"), us("2024-06-10T08:03:00Z"), us("2024-06-11T04:00:00Z")]);
    expect(censusOf(ts)).toEqual({ "2024-06-09": 2, "2024-06-10": 2, "2024-06-11": 1 });
    expect(censusOf(new Float64Array())).toEqual({});
  });

  it("takes the census from the statistics only when every row is on one ET date", () => {
    expect(censusFromStats(7, Z("2024-06-10T04:00:00Z"), Z("2024-06-11T03:59:59.999Z"))).toEqual({ "2024-06-10": 7 });
    expect(censusFromStats(7, Z("2024-06-09T23:12:00Z"), Z("2024-06-10T08:03:00Z"))).toBeNull();
  });
});

describe("day assignment", () => {
  it("serves a day from the row group that fits it, not from a late neighbour, and records the conflict", () => {
    // Row group 8: a Sunday file 243 min late, 39% of its rows on Sunday, 61% past 00:00 ET Monday.
    // Row group 9: Monday's own file. The old midpoint dating gave Monday to 8 and dropped 9.
    const a = assignDays("202406", F, [g(8, { "2024-06-09": 39, "2024-06-10": 61 }), g(9, { "2024-06-10": 1000 })], []);
    expect(a.days.get("2024-06-10")!.rowGroup).toBe(9);
    expect(a.days.get("2024-06-09")!.rowGroup).toBe(8);
    expect(a.conflicts).toEqual([{ date: "2024-06-10", file: F, kept: { rowGroup: 9, rows: 1000, share: 1 }, dropped: [{ rowGroup: 8, rows: 61, share: 0.61 }] }]);
    // Row group 8's own day is Monday (most of its rows); 39% of them are outside it.
    expect(a.outside).toEqual([{ file: F, rowGroup: 8, rows: 100, day: "2024-06-10", outside: 39, share: 0.39 }]);
    expect(a.quarantined).toEqual([]);
  });

  it("ranks by rows on the date, then share, then the first row group; lists only groups over 1% outside their day", () => {
    const a = assignDays("202406", F, [g(3, { "2024-06-05": 50 }), g(2, { "2024-06-05": 60, "2024-06-06": 60 }), g(4, { "2024-06-05": 80 })], []);
    expect(a.conflicts[0]).toMatchObject({ date: "2024-06-05", kept: { rowGroup: 4 }, dropped: [{ rowGroup: 2 }, { rowGroup: 3 }] });
    // Equal rows: the larger share, then the first.
    expect(assignDays("202406", F, [g(1, { "2024-06-05": 5, "2024-06-04": 5 }), g(2, { "2024-06-05": 5 })], []).days.get("2024-06-05")!.rowGroup).toBe(2);
    expect(assignDays("202406", F, [g(2, { "2024-06-05": 5 }), g(1, { "2024-06-05": 5 })], []).days.get("2024-06-05")!.rowGroup).toBe(1);
    // A full day with one stray row elsewhere keeps its day against a 3-row group wholly on it.
    const big = assignDays("202406", F, [g(7, { "2024-06-04": 1, "2024-06-05": 5_000_000 }), g(8, { "2024-06-05": 3 })], []);
    expect(big.days.get("2024-06-05")!.rowGroup).toBe(7);
    expect(big.conflicts[0]).toMatchObject({ kept: { rowGroup: 7, rows: 5_000_000 }, dropped: [{ rowGroup: 8, rows: 3, share: 1 }] });
    expect(a.days.get("2024-06-06")!.rowGroup).toBe(2);
    expect(a.outside).toEqual([{ file: F, rowGroup: 2, rows: 120, day: "2024-06-05", outside: 60, share: 0.5 }]);
    // 1 row in 100 outside: not over 1%.
    expect(assignDays("202406", F, [g(0, { "2024-06-03": 99, "2024-06-04": 1 })], []).outside).toEqual([]);
    expect(assignDays("202406", F, [g(0, { "2024-06-03": 98, "2024-06-04": 2 })], []).outside).toHaveLength(1);
  });

  it("serves only the file's month; rows on other months' dates count as outside", () => {
    const a = assignDays("202406", F, [g(0, { "2024-06-30": 40, "2024-07-01": 60 })], []);
    expect([...a.days.keys()]).toEqual(["2024-06-30"]);
    expect(a.outside).toEqual([{ file: F, rowGroup: 0, rows: 100, day: "2024-06-30", outside: 60, share: 0.6 }]);
    // A row group wholly on another month's date serves nothing here and is listed, all of it outside.
    const b = assignDays("202407", "l1/202407.parquet", [g(0, { "2024-06-30": 10 })], []);
    expect(b.days.size).toBe(0);
    expect(b.outside).toEqual([{ file: "l1/202407.parquet", rowGroup: 0, rows: 10, day: "2024-06-30", outside: 10, share: 1 }]);
  });

  it("leaves quarantined row groups out: matched, with changed rows (still out, flagged), or missing", () => {
    const entry: QuarantineEntry = { date: "2024-06-09", l1: { file: F, rowGroup: 8, rows: 100 }, l2: { file: "l2/202406.parquet", rowGroup: 7, rows: 5 }, offsetMinutes: 243, evidence: "test" };
    const q = quarantineOf([entry], F);
    expect(q).toEqual([{ entry, rowGroup: 8, rows: 100 }]);
    expect(quarantineOf([entry], "l2/202406.parquet")).toEqual([{ entry, rowGroup: 7, rows: 5 }]);
    const a = assignDays("202406", F, [g(8, { "2024-06-09": 39, "2024-06-10": 61 }), g(9, { "2024-06-10": 1000 })], q);
    expect([...a.days.keys()]).toEqual(["2024-06-10"]);
    expect(a.conflicts).toEqual([]);
    expect(a.outside).toEqual([]);
    expect(a.quarantined).toEqual([{ date: "2024-06-09", file: F, rowGroup: 8, rows: 100, offsetMinutes: 243, rowsChanged: false, missing: false }]);
    const changed = assignDays("202406", F, [g(8, { "2024-06-09": 10 }), g(9, { "2024-06-10": 1000 })], q);
    expect(changed.days.has("2024-06-09")).toBe(false);
    expect(changed.quarantined[0]).toMatchObject({ rows: 10, rowsChanged: true, missing: false });
    const missing = assignDays("202406", F, [g(9, { "2024-06-10": 1000 })], q);
    expect(missing.quarantined[0]).toMatchObject({ rows: null, rowsChanged: false, missing: true });
  });
});

describe("conflict guard", () => {
  it("refuses a conflict whose kept row group has fewer rows on the date than a dropped one", () => {
    const ok = { date: "2024-06-10", file: F, kept: { rowGroup: 9, rows: 10, share: 1 }, dropped: [{ rowGroup: 8, rows: 10, share: 0.6 }] };
    expect(() => assertConflicts([ok])).not.toThrow();
    expect(() => assertConflicts([{ ...ok, dropped: [{ rowGroup: 8, rows: 11, share: 0.6 }] }])).toThrow(
      "l1/202406.parquet: on 2024-06-10 row group 9 (10 rows there) was kept over row group 8 (11 rows there): refusing to build; review the day assignment",
    );
  });
});

describe("the reviewed NQ quarantine", () => {
  it("is the table of NQ only, hashed", () => {
    expect(quarantineTableOf("NQ")).toBe(NQ_QUARANTINE);
    expect(quarantineTableOf("ES")).toEqual([]);
    expect(quarantineHashOf("NQ")).toMatch(/^[0-9a-f]{64}$/);
    expect(quarantineHashOf("NQ")).not.toBe(quarantineHashOf("ES"));
  });

  it("holds the late Sunday files found in the audit, each with its L1 and L2 row group, offset and evidence", () => {
    expect(NQ_QUARANTINE.map((e) => e.date)).toEqual(["2022-11-20", "2024-02-18", "2024-03-10", "2024-06-09", "2025-06-29", "2025-07-20"]);
    for (const e of NQ_QUARANTINE) {
      const month = e.date.slice(0, 7).replace("-", "");
      expect(weekday(e.date), e.date).toBe(0);
      expect(e.l1.file).toBe(`l1/${month}.parquet`);
      expect(e.l2?.file).toBe(`l2/${month}.parquet`);
      expect(e.l1.rows).toBeGreaterThan(0);
      expect(e.offsetMinutes).toBeGreaterThan(0);
      expect(e.evidence).toMatch(/best lag -\d+ min/);
      expect(e.evidence).toContain(`-${e.offsetMinutes} min`);
    }
    expect(NQ_QUARANTINE.find((e) => e.date === "2024-06-09")).toMatchObject({ l1: { rowGroup: 8, rows: 180515 }, l2: { rowGroup: 7 }, offsetMinutes: 243 });
    expect(NQ_QUARANTINE.find((e) => e.date === "2022-11-20")).toMatchObject({ l1: { rowGroup: 18 }, offsetMinutes: 319 });
  });
});

describe("missing minute runs", () => {
  it("lists runs of expected minutes without data, joined over 00:00 ET, split at a break", () => {
    const has = new Set([Z("2024-03-07T14:30:00Z"), Z("2024-03-07T14:31:00Z")]);
    const runs = missingRuns(
      [
        [Z("2024-03-07T14:28:00Z"), Z("2024-03-07T14:34:00Z")],
        [Z("2024-03-07T14:40:00Z"), Z("2024-03-07T14:42:00Z")],
        [Z("2024-03-07T14:42:00Z"), Z("2024-03-07T14:43:00Z")],
      ],
      (t) => has.has(t),
    );
    expect(runs).toEqual([
      { from: "2024-03-07T14:28:00.000Z", to: "2024-03-07T14:30:00.000Z", minutes: 2 },
      { from: "2024-03-07T14:32:00.000Z", to: "2024-03-07T14:34:00.000Z", minutes: 2 },
      { from: "2024-03-07T14:40:00.000Z", to: "2024-03-07T14:43:00.000Z", minutes: 3 },
    ]);
    expect(missingRuns([[Z("2024-03-07T14:30:00Z"), Z("2024-03-07T14:32:00Z")]], (t) => has.has(t))).toEqual([]);
    expect(missingRuns([], () => false)).toEqual([]);
  });
});
