import { describe, expect, it } from "vitest";
import {
  addDays,
  etDate,
  etDayBounds,
  etOffset,
  etToUtc,
  frontMonth,
  frontPeriod,
  globexRanges,
  isFullHoliday,
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

  it("knows the full-closure holidays (New Year, Good Friday, Christmas) only", () => {
    expect(isFullHoliday("2024-03-29")).toBe(true);
    expect(isFullHoliday("2021-04-02")).toBe(true);
    expect(isFullHoliday("2025-04-18")).toBe(true);
    expect(isFullHoliday("2024-12-25")).toBe(true);
    expect(isFullHoliday("2025-01-01")).toBe(true);
    expect(isFullHoliday("2024-07-04")).toBe(false);
    expect(isFullHoliday("2024-03-28")).toBe(false);
  });
});
