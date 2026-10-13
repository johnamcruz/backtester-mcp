/**
 * UNSHIPPED DEV TOOL: not part of the server, the build (tsconfig covers src/ only) or the npm
 * package; run it by hand with `npx tsx`. It reviews data, it doesn't decide anything at runtime.
 *
 * Dev tool (not shipped): derives, per ET day of a built store, which contract the raw data is on,
 * using a back-adjusted one-minute CSV of the same data as referee. While the raw data is on contract
 * X, CSV close - raw close is the constant back-adjustment of X (whatever day the CSV itself rolled:
 * its adjustment is the spread at its roll), so the offset's level names the raw contract, and a
 * change of level is a data switch. Prints one line per ET day (offset median, share of minutes at
 * the median, per-session-part medians) for review; the reviewed result is src/rolltable.ts.
 *
 *   npx tsx scripts/derive-roll-table.ts <BACKTESTER_DATA_DIR> <NQ_1min.csv> [YYYY-MM-DD from] [to]
 */
import { readFileSync } from "node:fs";
import { parseCsv } from "../src/bars.js";
import { etDayBounds, weekday } from "../src/calendar.js";
import { gunzipSync } from "node:zlib";
import { dayPath, listDays, type DayFile } from "../src/store.js";

// Any store format: only the bars are read.
const readDay = (dir: string, root: string, date: string) => JSON.parse(gunzipSync(readFileSync(dayPath(dir, root, date))).toString("utf8")) as DayFile;

const [dataDir, csvPath, from = "0000", to = "9999"] = process.argv.slice(2);
if (!dataDir || !csvPath) throw new Error("usage: derive-roll-table.ts <data dir> <NQ_1min.csv> [from] [to]");
const csv = parseCsv(readFileSync(csvPath, "utf8"));
const median = (x: number[]) => {
  const s = x.slice().sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
};
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
let prev = NaN;
for (const date of listDays(dataDir, "NQ")) {
  if (date < from || date > to) continue;
  const d = readDay(dataDir, "NQ", date);
  if (!d || !d.bars.t.length) continue;
  const offs: number[] = [];
  const times: number[] = [];
  const parts: number[][] = [[], [], [], []]; // ET 00-06, 06-12, 12-18, 18-24
  const start = etDayBounds(date).start;
  for (let i = 0; i < d.bars.t.length; i++) {
    const t = d.bars.t[i];
    const j = csv.lowerBound(t);
    if (j >= csv.length || csv.t[j] !== t) continue;
    const off = Math.round((csv.c[j] - d.bars.c[i]) * 4) / 4;
    offs.push(off);
    times.push(t);
    parts[Math.min(3, Math.floor((t - start) / 36e5 / 6))].push(off);
  }
  if (!offs.length) {
    console.log(`${date} ${DOW[weekday(date)]} bars ${d.bars.t.length} no CSV minutes`);
    continue;
  }
  const m = median(offs);
  const share = offs.filter((x) => Math.abs(x - m) <= 0.5).length / offs.length;
  // On a level change: the first minute off the previous level and the last one still on it.
  let flag = "";
  if (Number.isFinite(prev) && Math.abs(m - prev) >= 2) {
    const off = offs.findIndex((x) => Math.abs(x - prev) > 0.5);
    const lastOn = offs.map((x) => Math.abs(x - prev) <= 0.5).lastIndexOf(true);
    flag = `  <-- level ${prev} -> ${m}, first off ${new Date(times[off]).toISOString()}, last on ${lastOn >= 0 ? new Date(times[lastOn]).toISOString() : "-"}`;
  }
  console.log(
    `${date} ${DOW[weekday(date)]} rule ${d.contract} bars ${d.bars.t.length} csv ${offs.length} offset ${m} at-median ${(share * 100).toFixed(0)}%` +
      ` parts ${parts.map((p) => (p.length ? median(p) : "-")).join("/")}${flag}`,
  );
  prev = m;
}
