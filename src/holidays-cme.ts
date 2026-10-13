/**
 * The reviewed CME Globex holiday calendar of the equity index futures (NQ, MNQ)
 * for 2021-2025: the trade dates that are closed or close early. calendar.ts
 * turns it into each ET day's expected hours (expectedRanges) and kept rows
 * (sessionsOf).
 *
 * Source: CME Group's holiday calendar (https://www.cmegroup.com/tools-information/holiday-calendar.html)
 * and its per-holiday "Holiday trading hours" notices for CME Globex equity
 * products. Times are ET (the notices give CT: 12:00 CT = 13:00 ET, 12:15 CT =
 * 13:15 ET, 08:15 CT = 09:15 ET, 08:30 CT = 09:30 ET). After an early close,
 * Globex reopens at 18:00 ET for the next trade date. A closed trade date T has
 * no session at all: neither the evening before it (18:00 ET of the previous
 * calendar day, Sunday for a Monday) nor T itself until 18:00 ET.
 *
 * Each entry was checked against the local NQ order-book data (the day's first
 * and last trade minutes, ET): "data" says what it shows. "no data" marks days
 * the source has no rows for (a source gap, listed in the manifest's gaps), and
 * "before data" / "after data" the days outside the local data (2021-05 to
 * 2025-11), taken from the notices alone.
 *
 * Also from the notices: until trade date 2021-06-25 the equity futures halted
 * daily 16:15-16:30 ET (15:15-15:30 CT); CME removed that halt from trade date
 * 2021-06-28 (the data trades through it from then on).
 */

export interface CmeHoliday {
  /** The trade date (an ET calendar date, Monday to Friday). */
  date: string;
  /** "closed", or the ET time ("HH:MM") the trade date's session ends early. */
  close: "closed" | `${number}:${number}`;
  note: string;
}

/** Trade dates before this one halted 16:15-16:30 ET daily. */
export const MAINTENANCE_HALT_UNTIL = "2021-06-28";

/** First and last years the table is complete for. */
export const CME_CALENDAR_YEARS: readonly [number, number] = [2021, 2025];

export const CME_HOLIDAYS: readonly CmeHoliday[] = [
  { date: "2021-01-01", close: "closed", note: "New Year's Day (before data)" },
  { date: "2021-01-18", close: "13:00", note: "Martin Luther King Jr. Day (before data)" },
  { date: "2021-02-15", close: "13:00", note: "Presidents Day (before data)" },
  { date: "2021-04-02", close: "09:15", note: "Good Friday, abbreviated for the employment report (before data)" },
  { date: "2021-05-31", close: "13:00", note: "Memorial Day (data: 00:00-13:00, 18:00 on)" },
  { date: "2021-07-05", close: "13:00", note: "Independence Day observed (data: 00:00-13:00, 18:00 on)" },
  { date: "2021-09-06", close: "13:00", note: "Labor Day (data: 00:00-13:00, 18:00 on)" },
  { date: "2021-11-25", close: "13:00", note: "Thanksgiving (data: 00:00-13:00, 18:00 on)" },
  { date: "2021-11-26", close: "13:15", note: "day after Thanksgiving (data: 00:00-13:15)" },
  { date: "2021-12-24", close: "closed", note: "Christmas observed (data: none from Thursday 17:00 to Sunday 18:00)" },
  // 2022-01-01 is a Saturday: no closure (2021-12-31 trades a full day in the data).
  { date: "2022-01-17", close: "13:00", note: "Martin Luther King Jr. Day (data: 00:00-13:00, 18:00 on)" },
  { date: "2022-02-21", close: "13:00", note: "Presidents Day (data: 00:00-13:00, 18:00 on)" },
  { date: "2022-04-15", close: "closed", note: "Good Friday (data: none after Thursday 17:00)" },
  { date: "2022-05-30", close: "13:00", note: "Memorial Day (data: 00:00-13:00, 18:00 on)" },
  { date: "2022-06-20", close: "13:00", note: "Juneteenth observed (data: 00:00-13:00, 18:00 on)" },
  { date: "2022-07-04", close: "13:00", note: "Independence Day (data: 00:00-13:00, 18:00 on)" },
  { date: "2022-09-05", close: "13:00", note: "Labor Day (data: 00:00-13:00, 18:00 on)" },
  { date: "2022-11-24", close: "13:00", note: "Thanksgiving (data: 00:00-13:00, 18:00 on)" },
  { date: "2022-11-25", close: "13:15", note: "day after Thanksgiving (data: 00:00-13:15)" },
  { date: "2022-12-26", close: "closed", note: "Christmas observed (data: no Sunday session; one stray print Monday 14:44, dropped)" },
  { date: "2023-01-02", close: "closed", note: "New Year's Day observed (data: no Sunday session, Monday from 18:00)" },
  { date: "2023-01-16", close: "13:00", note: "Martin Luther King Jr. Day (data: 00:00-13:00, 18:00 on)" },
  { date: "2023-02-20", close: "13:00", note: "Presidents Day (no data)" },
  { date: "2023-04-07", close: "09:15", note: "Good Friday, abbreviated for the employment report (data: 00:00-09:15)" },
  { date: "2023-05-29", close: "13:00", note: "Memorial Day (no data)" },
  { date: "2023-06-19", close: "13:00", note: "Juneteenth (data: 00:00-13:00, 18:00 on)" },
  { date: "2023-07-03", close: "13:15", note: "Independence Day eve (data: 00:00-13:15, 18:00 on)" },
  { date: "2023-07-04", close: "13:00", note: "Independence Day (data: 00:00-13:00, 18:00 on)" },
  { date: "2023-09-04", close: "13:00", note: "Labor Day (no data)" },
  { date: "2023-11-23", close: "13:00", note: "Thanksgiving (data: 00:00-13:00, 18:00 on)" },
  { date: "2023-11-24", close: "13:15", note: "day after Thanksgiving (data: 00:00-13:15)" },
  { date: "2023-12-25", close: "closed", note: "Christmas (data: no Sunday session, Monday from 18:00)" },
  { date: "2024-01-01", close: "closed", note: "New Year's Day (data: no Sunday session, Monday from 18:00)" },
  { date: "2024-01-15", close: "13:00", note: "Martin Luther King Jr. Day (no data)" },
  { date: "2024-02-19", close: "13:00", note: "Presidents Day (data: 00:00-13:00, 18:00 on)" },
  { date: "2024-03-29", close: "closed", note: "Good Friday (data: none after Thursday 17:00)" },
  { date: "2024-05-27", close: "13:00", note: "Memorial Day (data: 00:00-13:00, 18:00 on)" },
  { date: "2024-06-19", close: "13:00", note: "Juneteenth (data: 00:00-13:00, 18:00 on)" },
  { date: "2024-07-03", close: "13:15", note: "Independence Day eve (data: 00:00-13:15, 18:00 on)" },
  { date: "2024-07-04", close: "13:00", note: "Independence Day (data: 00:00-13:00, 18:00 on)" },
  { date: "2024-09-02", close: "13:00", note: "Labor Day (no data)" },
  { date: "2024-11-28", close: "13:00", note: "Thanksgiving (data: 00:00-13:00, 18:00 on)" },
  { date: "2024-11-29", close: "13:15", note: "day after Thanksgiving (data: 00:00-13:15)" },
  { date: "2024-12-24", close: "13:15", note: "Christmas Eve (data: 00:00-13:15; stray prints after it)" },
  { date: "2024-12-25", close: "closed", note: "Christmas (data: no Tuesday evening session, Wednesday from 18:00)" },
  { date: "2025-01-01", close: "closed", note: "New Year's Day (data: no Tuesday evening session; one stray print Wednesday 14:12, dropped)" },
  { date: "2025-01-09", close: "09:30", note: "National Day of Mourning (data: 00:00-09:30, 18:00 on)" },
  { date: "2025-01-20", close: "13:00", note: "Martin Luther King Jr. Day (data: 00:00-13:00, 18:00 on)" },
  { date: "2025-02-17", close: "13:00", note: "Presidents Day (data: 00:00-13:00, 18:00 on)" },
  { date: "2025-04-18", close: "closed", note: "Good Friday (data: none after Thursday 17:00)" },
  { date: "2025-05-26", close: "13:00", note: "Memorial Day (data: 00:00-13:00, 18:00 on)" },
  { date: "2025-06-19", close: "13:00", note: "Juneteenth (data: 00:00-13:00, 18:00 on)" },
  { date: "2025-07-03", close: "13:15", note: "Independence Day eve (data: 00:00-13:15, 18:00 on)" },
  { date: "2025-07-04", close: "13:00", note: "Independence Day (data: 00:00-13:00)" },
  { date: "2025-09-01", close: "13:00", note: "Labor Day (data: 00:00-13:00, 18:00 on)" },
  { date: "2025-11-27", close: "13:00", note: "Thanksgiving (data: 00:00-13:00, then 18:00-21:45 before CME's outage of 2025-11-27/28)" },
  { date: "2025-11-28", close: "13:15", note: "day after Thanksgiving (data: 08:30-13:15, after the outage)" },
  { date: "2025-12-24", close: "13:15", note: "Christmas Eve (after data)" },
  { date: "2025-12-25", close: "closed", note: "Christmas (after data)" },
];
