/**
 * US/Eastern calendar math for the local order-book data, pure: ET days, the
 * CME Globex session of an ET day, and the quarterly front-contract rule the
 * data follows. Times are UTC ms unless a name says otherwise.
 */

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const HOUR = 36e5;
const DAY = 864e5;

/** ET wall clock minus UTC at `ms`, in ms (-5 h in winter, -4 h in summer). */
export function etOffset(ms: number): number {
  const p: Record<string, number> = {};
  for (const x of ET_PARTS.formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

/** UTC ms of an ET wall time (a time that doesn't exist on a spring-forward day resolves to the later offset). */
export function etToUtc(y: number, m: number, d: number, h = 0, min = 0): number {
  const wall = Date.UTC(y, m - 1, d, h, min);
  const t = wall - etOffset(wall - 5 * HOUR);
  const off = etOffset(t);
  return wall - off;
}

/** An ET calendar date "YYYY-MM-DD". */
export type EtDate = string;

/** The ET calendar date containing `ms`. */
export function etDate(ms: number): EtDate {
  return new Date(ms + etOffset(ms)).toISOString().slice(0, 10);
}

const parse = (d: EtDate) => d.split("-").map(Number) as [number, number, number];

/** [00:00 ET, 24:00 ET) of an ET date, in UTC ms (23 or 25 hours on DST change days). */
export function etDayBounds(d: EtDate): { start: number; end: number } {
  const [y, m, day] = parse(d);
  const next = new Date(Date.UTC(y, m - 1, day) + DAY);
  return { start: etToUtc(y, m, day), end: etToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()) };
}

/** 0 = Sunday ... 6 = Saturday, of an ET date. */
export function weekday(d: EtDate): number {
  const [y, m, day] = parse(d);
  return new Date(Date.UTC(y, m - 1, day)).getUTCDay();
}

export function addDays(d: EtDate, n: number): EtDate {
  const [y, m, day] = parse(d);
  return new Date(Date.UTC(y, m - 1, day) + n * DAY).toISOString().slice(0, 10);
}

/**
 * The CME Globex hours of an ET date as UTC ms ranges: the session opens
 * 18:00 ET Sunday to Thursday and runs to 17:00 ET the next day, with a
 * 17:00-18:00 ET daily break and no trading from Friday 17:00 to Sunday 18:00.
 * Holiday schedules aren't modelled: the data simply has no trades then.
 */
export function globexRanges(d: EtDate): Array<[number, number]> {
  const [y, m, day] = parse(d);
  const { start, end } = etDayBounds(d);
  const at = (h: number) => etToUtc(y, m, day, h);
  switch (weekday(d)) {
    case 6:
      return [];
    case 0:
      return [[at(18), end]];
    case 5:
      return [[start, at(17)]];
    default:
      return [
        [start, at(17)],
        [at(18), end],
      ];
  }
}

// ── Quarterly contracts ──────────────────────────────────────────────

export const MONTH_CODES = "FGHJKMNQUVXZ";
const QUARTERS = [3, 6, 9, 12];

/** A quarterly contract month, e.g. { year: 2024, month: 6 } = M24. */
export interface ContractMonth {
  year: number;
  month: number;
}

/** "M24" for June 2024. */
export const monthCode = (c: ContractMonth) => `${MONTH_CODES[c.month - 1]}${String(c.year % 100).padStart(2, "0")}`;

/** "M24" -> June 2024 (years 2000-2099), or null if it isn't a quarterly code. */
export function parseMonthCode(code: string): ContractMonth | null {
  const m = /^([HMUZ])(\d\d)$/.exec(code);
  return m ? { year: 2000 + Number(m[2]), month: MONTH_CODES.indexOf(m[1]) + 1 } : null;
}

/** The third Friday of a month (the equity index futures' expiry day), as an ET date. */
export function thirdFriday(year: number, month: number): EtDate {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return new Date(Date.UTC(year, month - 1, 1 + ((5 - first + 7) % 7) + 14)).toISOString().slice(0, 10);
}

/**
 * The roll rule of the local NQ data, by era: when contract month `c` stops
 * being the front month, at 00:00 ET.
 * - through U22: the Thursday of the week before the expiry week (the third
 *   Friday minus 8 days, CME's roll date);
 * - from Z22: the Monday of the expiry week (the third Friday minus 4 days).
 * Each roll the data actually made is in the reviewed table (rolltable.ts),
 * which is what assigns contracts; this rule only predicts it, and the table's
 * tests check every roll against it.
 */
export function rollStart(c: ContractMonth): number {
  const lateEra = c.year > 2022 || (c.year === 2022 && c.month === 12);
  return etDayBounds(addDays(thirdFriday(c.year, c.month), lateEra ? -4 : -8)).start;
}

/** When contract month `c` stops trading: 09:30 ET on its third Friday (the equity index futures' final settlement). */
export function expiryMoment(c: ContractMonth): number {
  const [y, m, d] = parse(thirdFriday(c.year, c.month));
  return etToUtc(y, m, d, 9, 30);
}

/** The latest 18:00 ET (a CME trading day's start) at or before `ms`. */
export function tradingDayStartEt(ms: number): number {
  const d = etDate(ms);
  const [y, m, day] = parse(d);
  const today = etToUtc(y, m, day, 18);
  if (today <= ms) return today;
  const [py, pm, pd] = parse(addDays(d, -1));
  return etToUtc(py, pm, pd, 18);
}

const nextQuarter = (c: ContractMonth): ContractMonth => (c.month === 12 ? { year: c.year + 1, month: 3 } : { year: c.year, month: c.month + 3 });
const prevQuarter = (c: ContractMonth): ContractMonth => (c.month === 3 ? { year: c.year - 1, month: 12 } : { year: c.year, month: c.month - 3 });
export { nextQuarter, prevQuarter };

/** The front quarterly contract at `ms`: the first whose roll start is after it. */
export function frontMonth(ms: number): ContractMonth {
  const d = new Date(ms);
  let c: ContractMonth = { year: d.getUTCFullYear() - 1, month: 12 };
  while (rollStart(c) <= ms) c = nextQuarter(c);
  return c;
}

/** [from, to): when contract month `c` is the front month. */
export function frontPeriod(c: ContractMonth): { from: number; to: number } {
  return { from: rollStart(prevQuarter(c)), to: rollStart(c) };
}

/** Roll starts in [from, to). */
export function rollsBetween(from: number, to: number): Array<{ at: number; from: ContractMonth; to: ContractMonth }> {
  const out: Array<{ at: number; from: ContractMonth; to: ContractMonth }> = [];
  let c = frontMonth(from);
  for (let at = rollStart(c); at < to; at = rollStart(c)) {
    out.push({ at, from: c, to: nextQuarter(c) });
    c = nextQuarter(c);
  }
  return out;
}

/** Western Easter Sunday (anonymous Gregorian algorithm). */
function easter(year: number): EtDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Weekdays CME equity index futures don't trade at all: New Year's Day,
 * Good Friday and Christmas Day. A missing data day on one of these is a
 * holiday, not a gap. Other holidays have shortened sessions with data.
 */
export function isFullHoliday(d: EtDate): boolean {
  const md = d.slice(5);
  return md === "01-01" || md === "12-25" || d === addDays(easter(Number(d.slice(0, 4))), -2);
}
