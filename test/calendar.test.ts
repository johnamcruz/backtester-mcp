import { describe, expect, it } from "vitest";
import { CME_HOLIDAYS } from "../src/holidays-cme.js";
import {
  addDays,
  etDate,
  etDayBounds,
  etOffset,
  etToUtc,
  frontMonth,
  frontPeriod,
  expectedRanges,
  goodFriday,
  globexRanges,
  isFullHoliday,
  sessionsOf,
  monthCode,
  parseMonthCode,
  expiryMoment,
  rollStart,
  rollsBetween,
  tradingDayStartEt,
  thirdFriday,
  weekday,
} from "../src/calendar.js";

const Z = (s: string) => Date.parse(s);
const H = 36e5;

describe("ET time", () => {
  it("knows the ET offset in winter and summer and converts ET wall times to UTC", () => {
    expect(etOffset(Z("2024-01-15T12:00:00Z"))).toBe(-5 * H);
    expect(etOffset(Z("2024-07-15T12:00:00Z"))).toBe(-4 * H);
    expect(etToUtc(2024, 1, 15, 9, 30)).toBe(Z("2024-01-15T14:30:00Z"));
    expect(etToUtc(2024, 7, 15, 9, 30)).toBe(Z("2024-07-15T13:30:00Z"));
    expect(etToUtc(2024, 3, 10)).toBe(Z("2024-03-10T05:00:00Z"));
    expect(etToUtc(2024, 3, 11)).toBe(Z("2024-03-11T04:00:00Z"));
  });

  it("gives ET dates, day bounds (23 and 25 hours on DST days), weekdays", () => {
    expect(etDate(Z("2024-03-11T03:59:59Z"))).toBe("2024-03-10");
    expect(etDate(Z("2024-03-11T04:00:00Z"))).toBe("2024-03-11");
    expect(etDate(Z("2024-01-16T04:59:59Z"))).toBe("2024-01-15");
    expect(etDayBounds("2024-03-10")).toEqual({ start: Z("2024-03-10T05:00:00Z"), end: Z("2024-03-11T04:00:00Z") });
    expect(etDayBounds("2024-11-03")).toEqual({ start: Z("2024-11-03T04:00:00Z"), end: Z("2024-11-04T05:00:00Z") });
    expect(weekday("2024-03-10")).toBe(0);
    expect(weekday("2024-03-16")).toBe(6);
    expect(addDays("2024-02-28", 2)).toBe("2024-03-01");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("gives the Globex hours of an ET day: Sunday open, daily break, Friday close, no Saturday", () => {
    expect(globexRanges("2024-03-10")).toEqual([[Z("2024-03-10T22:00:00Z"), Z("2024-03-11T04:00:00Z")]]);
    expect(globexRanges("2024-03-11")).toEqual([
      [Z("2024-03-11T04:00:00Z"), Z("2024-03-11T21:00:00Z")],
      [Z("2024-03-11T22:00:00Z"), Z("2024-03-12T04:00:00Z")],
    ]);
    expect(globexRanges("2024-03-08")).toEqual([[Z("2024-03-08T05:00:00Z"), Z("2024-03-08T22:00:00Z")]]);
    expect(globexRanges("2024-03-09")).toEqual([]);
  });
});

describe("quarterly contracts", () => {
  it("names months and parses quarterly codes", () => {
    expect(monthCode({ year: 2024, month: 6 })).toBe("M24");
    expect(monthCode({ year: 2025, month: 12 })).toBe("Z25");
    expect(parseMonthCode("U24")).toEqual({ year: 2024, month: 9 });
    expect(parseMonthCode("F24")).toBeNull();
    expect(parseMonthCode("M2024")).toBeNull();
  });

  it("rolls by era: through U22 on the Thursday before the expiry week, from Z22 on the expiry-week Monday, at 00:00 ET", () => {
    expect(thirdFriday(2024, 3)).toBe("2024-03-15");
    expect(thirdFriday(2024, 9)).toBe("2024-09-20");
    expect(thirdFriday(2023, 12)).toBe("2023-12-15");
    // Era 1: third Friday minus 8 days (a Thursday).
    expect(rollStart({ year: 2021, month: 6 })).toBe(Z("2021-06-10T04:00:00Z"));
    expect(rollStart({ year: 2021, month: 12 })).toBe(Z("2021-12-09T05:00:00Z"));
    expect(rollStart({ year: 2022, month: 9 })).toBe(Z("2022-09-08T04:00:00Z"));
    // Era 2 from Z22: third Friday minus 4 days (a Monday).
    expect(rollStart({ year: 2022, month: 12 })).toBe(Z("2022-12-12T05:00:00Z"));
    expect(rollStart({ year: 2024, month: 3 })).toBe(Z("2024-03-11T04:00:00Z"));
    expect(rollStart({ year: 2023, month: 12 })).toBe(Z("2023-12-11T05:00:00Z"));
    expect(rollStart({ year: 2025, month: 6 })).toBe(Z("2025-06-16T04:00:00Z"));
  });

  it("knows a contract's expiry (third Friday 09:30 ET) and the start of the CME trading day (18:00 ET)", () => {
    expect(expiryMoment({ year: 2022, month: 6 })).toBe(Z("2022-06-17T13:30:00Z"));
    expect(expiryMoment({ year: 2023, month: 12 })).toBe(Z("2023-12-15T14:30:00Z"));
    expect(tradingDayStartEt(Z("2024-03-11T04:00:00Z"))).toBe(Z("2024-03-10T22:00:00Z"));
    expect(tradingDayStartEt(Z("2024-03-10T22:00:00Z"))).toBe(Z("2024-03-10T22:00:00Z"));
    expect(tradingDayStartEt(Z("2024-03-10T21:59:59Z"))).toBe(Z("2024-03-09T23:00:00Z"));
  });

  it("gives the front contract either side of a roll Monday's 00:00 ET", () => {
    expect(monthCode(frontMonth(Z("2024-03-11T03:59:59.999Z")))).toBe("H24");
    expect(monthCode(frontMonth(Z("2024-03-11T04:00:00Z")))).toBe("M24");
    expect(monthCode(frontMonth(Z("2024-01-02T00:00:00Z")))).toBe("H24");
    expect(monthCode(frontMonth(Z("2023-12-30T00:00:00Z")))).toBe("H24");
    expect(monthCode(frontMonth(Z("2023-12-10T12:00:00Z")))).toBe("Z23");
    expect(monthCode(frontMonth(Z("2021-06-10T03:59:59Z")))).toBe("M21");
    expect(monthCode(frontMonth(Z("2021-06-10T04:00:00Z")))).toBe("U21");
    expect(frontPeriod({ year: 2024, month: 6 })).toEqual({ from: Z("2024-03-11T04:00:00Z"), to: Z("2024-06-17T04:00:00Z") });
    expect(rollsBetween(Z("2024-01-01T00:00:00Z"), Z("2024-07-01T00:00:00Z")).map((r) => [new Date(r.at).toISOString(), monthCode(r.from), monthCode(r.to)])).toEqual([
      ["2024-03-11T04:00:00.000Z", "H24", "M24"],
      ["2024-06-17T04:00:00.000Z", "M24", "U24"],
    ]);
  });

  it("knows the full-closure holidays: the reviewed CME calendar's closed trade dates, else New Year, Good Friday, Christmas", () => {
    expect(isFullHoliday("2024-03-29")).toBe(true);
    // Good Friday 2021 and 2023 traded until 09:15 ET (the reviewed CME calendar): not full closures.
    expect(isFullHoliday("2021-04-02")).toBe(false);
    expect(isFullHoliday("2023-04-07")).toBe(false);
    expect(isFullHoliday("2022-04-15")).toBe(true);
    // Observed holidays: Christmas 2021 on Friday 12-24, Christmas 2022 and New Year 2023 on Monday.
    expect(isFullHoliday("2021-12-24")).toBe(true);
    expect(isFullHoliday("2022-12-26")).toBe(true);
    expect(isFullHoliday("2023-01-02")).toBe(true);
    // Outside the calendar's years: the rule.
    expect(isFullHoliday("2026-12-25")).toBe(true);
    expect(isFullHoliday("2020-04-10")).toBe(true);
    expect(isFullHoliday("2020-04-09")).toBe(false);
    expect(isFullHoliday("2025-04-18")).toBe(true);
    expect(isFullHoliday("2024-12-25")).toBe(true);
    expect(isFullHoliday("2025-01-01")).toBe(true);
    expect(isFullHoliday("2024-07-04")).toBe(false);
    expect(isFullHoliday("2024-03-28")).toBe(false);
  });
});

describe("CME holiday calendar", () => {
  const Z = (s: string) => Date.parse(s);

  it("is a reviewed table: sorted weekday trade dates, each once, closed or an HH:MM close, with a note", () => {
    const dates = CME_HOLIDAYS.map((h) => h.date);
    expect(dates).toEqual([...new Set(dates)].sort());
    for (const h of CME_HOLIDAYS) {
      expect(weekday(h.date) % 6, h.date).not.toBe(0);
      expect(h.close).toMatch(/^(closed|\d\d:\d\d)$/);
      expect(h.note.length).toBeGreaterThan(5);
    }
  });

  it("closes only on New Year's Day, Good Friday or Christmas (or the weekday they are observed on)", () => {
    for (const h of CME_HOLIDAYS.filter((x) => x.close === "closed")) {
      const y = Number(h.date.slice(0, 4));
      const md = h.date.slice(5);
      const wd = weekday(h.date);
      const ok =
        md === "01-01" ||
        md === "12-25" ||
        (md === "01-02" && wd === 1) || // New Year's Day on a Sunday
        (md === "12-26" && wd === 1) || // Christmas on a Sunday
        (md === "12-24" && wd === 5) || // Christmas on a Saturday
        h.date === goodFriday(y);
      expect(ok, h.date).toBe(true);
    }
    expect(goodFriday(2024)).toBe("2024-03-29");
    expect(goodFriday(2025)).toBe("2025-04-18");
  });

  it("keeps no rows of a closed trade date: neither the evening before it nor the day itself until 18:00 ET", () => {
    // Christmas 2022 observed Monday 12-26: no Sunday session, Monday from 18:00 ET (23:00Z) only.
    expect(sessionsOf("2022-12-25")).toEqual([]);
    expect(sessionsOf("2022-12-26")).toEqual([[Z("2022-12-26T23:00:00Z"), Z("2022-12-27T05:00:00Z")]]);
    // Christmas 2024 on Wednesday: Tuesday keeps its morning, not its evening (which is the 25th's).
    expect(sessionsOf("2024-12-24")).toEqual([[Z("2024-12-24T05:00:00Z"), Z("2024-12-24T22:00:00Z")]]);
    // Good Friday 2024: Thursday has no evening, Friday nothing.
    expect(sessionsOf("2024-03-28")).toEqual([[Z("2024-03-28T04:00:00Z"), Z("2024-03-28T21:00:00Z")]]);
    expect(sessionsOf("2024-03-29")).toEqual([]);
    // An ordinary day: the Globex hours.
    expect(sessionsOf("2024-03-12")).toEqual(globexRanges("2024-03-12"));
  });

  it("expects the hours to an early close, and the 16:15-16:30 ET halt before trade date 2021-06-28", () => {
    // Christmas Eve 2024: 13:15 ET (18:15Z) close; no evening session (Christmas is closed).
    expect(expectedRanges("2024-12-24")).toEqual([[Z("2024-12-24T05:00:00Z"), Z("2024-12-24T18:15:00Z")]]);
    // Labor Day 2025: 13:00 ET (17:00Z), then the next trade date from 18:00 ET.
    expect(expectedRanges("2025-09-01")).toEqual([
      [Z("2025-09-01T04:00:00Z"), Z("2025-09-01T17:00:00Z")],
      [Z("2025-09-01T22:00:00Z"), Z("2025-09-02T04:00:00Z")],
    ]);
    // Good Friday 2023: 09:15 ET.
    expect(expectedRanges("2023-04-07")).toEqual([[Z("2023-04-07T04:00:00Z"), Z("2023-04-07T13:15:00Z")]]);
    // Before 2021-06-28 the daily 16:15-16:30 ET halt; from then on none.
    expect(expectedRanges("2021-06-25")).toEqual([
      [Z("2021-06-25T04:00:00Z"), Z("2021-06-25T20:15:00Z")],
      [Z("2021-06-25T20:30:00Z"), Z("2021-06-25T21:00:00Z")],
    ]);
    // A holiday closing before the halt: the halt doesn't apply.
    expect(expectedRanges("2021-05-31")).toEqual([
      [Z("2021-05-31T04:00:00Z"), Z("2021-05-31T17:00:00Z")],
      [Z("2021-05-31T22:00:00Z"), Z("2021-06-01T04:00:00Z")],
    ]);
    expect(expectedRanges("2021-06-28")).toEqual(globexRanges("2021-06-28"));
    expect(expectedRanges("2024-03-09")).toEqual([]);
  });
});
