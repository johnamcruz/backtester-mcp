import { join } from "node:path";
import { buildStore } from "../src/storebuild.js";
import { tmp } from "./helpers.js";
import { l1Minute, l1Minutes, writeSource, type L2Row, type SynthDay } from "./orderbook.js";

export const Z = (s: string) => Date.parse(s);
export const MIN = 60000;

/** Two L2 rows (an add and a remove) at `at` ms. */
export const l2Pair = (at: number, price: number): L2Row[] => [
  [at, 0, price - 0.5, 7, 1, 0],
  [at + 2, 0, price - 0.5, 7, 1, 2],
];

/**
 * March 2024 around the H24 -> M24 roll (rule: Monday 2024-03-11 00:00 ET = 04:00Z):
 * - Thu 03-07 and Fri 03-08: H24 near 18000, plus a trade in the daily break / after the Friday close (dropped);
 * - Sat 03-09: stray rows only (all dropped);
 * - Sun 03-10 (DST): the session opens 18:00 EDT = 22:00Z on H24; rows past 00:00 ET Monday in this
 *   day's row group (as the real data has) are dropped;
 * - Mon 03-11: M24 near 18250 from 04:00Z;
 * - Tue 03-12: L1 without L2; Wed 03-13: nothing; Thu 03-14: L2 without L1;
 * - Fri 03-29 (Good Friday): nothing (a holiday, not a gap).
 */
export function marchDays(): Record<string, SynthDay> {
  return {
    "2024-03-07": {
      l1: [...l1Minute(Z("2024-03-07T14:30:00Z"), [18000, 18001.5, 17999.25]), ...l1Minute(Z("2024-03-07T14:31:00Z"), [18002]), ...l1Minute(Z("2024-03-07T22:30:00Z"), [18500])],
      l2: [...l2Pair(Z("2024-03-07T14:30:00Z"), 18000), ...l2Pair(Z("2024-03-07T14:32:00Z"), 18001)],
    },
    "2024-03-08": {
      l1: [...l1Minutes(Z("2024-03-08T14:30:00Z"), 2, 18010, 0.25), ...l1Minute(Z("2024-03-08T22:30:00Z"), [18600])],
      l2: l2Pair(Z("2024-03-08T14:30:00Z"), 18010),
    },
    "2024-03-09": { l1: [[Z("2024-03-09T19:00:00Z"), 2, 18230, 1]], l2: l2Pair(Z("2024-03-09T19:00:00Z"), 18230) },
    "2024-03-10": {
      l1: [...l1Minutes(Z("2024-03-10T22:00:00Z"), 2, 18020), ...l1Minute(Z("2024-03-11T04:30:00Z"), [18030])],
      l2: l2Pair(Z("2024-03-10T22:00:00Z"), 18020),
    },
    "2024-03-11": { l1: l1Minutes(Z("2024-03-11T04:00:00Z"), 3, 18270, 0.5), l2: l2Pair(Z("2024-03-11T04:00:00Z"), 18270) },
    "2024-03-12": { l1: l1Minutes(Z("2024-03-12T14:30:00Z"), 2, 18280) },
    "2024-03-14": { l2: l2Pair(Z("2024-03-14T14:30:00Z"), 18290) },
  };
}

/** A source folder and a data dir with the store built from it (and CSV data if given). */
export async function builtStore(days: Record<string, SynthDay> = marchDays(), months: [string, string] = ["202403", "202403"]) {
  const dir = tmp("btm-store-");
  const source = join(dir, "orderbook");
  const dataDir = join(dir, "data");
  writeSource(source, days);
  const lines: string[] = [];
  const summary = await buildStore({ source, dataDir, from: months[0], to: months[1], log: (s) => lines.push(s) });
  return { dir, source, dataDir, summary, lines };
}
