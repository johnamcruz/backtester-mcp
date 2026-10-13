/**
 * The reviewed quarantine of the local NQ L1/L2 data: source row groups whose
 * timestamps are wrong, so none of their rows is served. build-store leaves them
 * out of day assignment (dayassign.ts) and lists them in the manifest
 * (`assignment.quarantined`).
 *
 * Each is a Sunday evening file (18:00-24:00 ET) whose clock runs late by a
 * constant offset: its rows run past 00:00 ET Monday by that much, and a
 * Monday's rows dated by them would be mistimed. Offsets were measured against
 * the vendor's one-minute CSV of the same market (NQ_1min.csv, back-adjusted,
 * UTC): the lag that makes the file's per-minute trade volume correlate with
 * the CSV's (volCorr) and its closes sit at one constant back-adjustment offset
 * (priceShare: the share of minutes at that offset). The same Sunday's L2 row
 * group ends at the same late time and is quarantined with it.
 *
 * A row group is matched by file and index. When its row count differs from
 * `rows` the source has changed: it is still left out (fail closed), and the
 * manifest flags it (`rowsChanged`) for a new review.
 */

export interface QuarantineRef {
  /** Relative to the source folder, e.g. "l1/202406.parquet". */
  file: string;
  rowGroup: number;
  rows: number;
}

export interface QuarantineEntry {
  /** The Sunday (ET) the file holds. */
  date: string;
  l1: QuarantineRef;
  l2: QuarantineRef | null;
  /** How late the file's clock runs, in minutes (measured, ±1). */
  offsetMinutes: number;
  evidence: string;
}

export const NQ_QUARANTINE: readonly QuarantineEntry[] = [
  {
    date: "2022-11-20",
    l1: { file: "l1/202211.parquet", rowGroup: 18, rows: 117038 },
    l2: { file: "l2/202211.parquet", rowGroup: 16, rows: 106725 },
    offsetMinutes: 319,
    evidence:
      "trades 2022-11-21 04:19Z-06:28Z (129 minutes; the session opens 23:00Z): best lag -319 min (volCorr 0.854; at lag 0 -0.214). " +
      "The midpoint dating put it on Monday 2022-11-21 and dropped that day's own row group (19, 4626277 rows): the whole Monday was lost.",
  },
  {
    date: "2024-02-18",
    l1: { file: "l1/202402.parquet", rowGroup: 16, rows: 37416 },
    l2: { file: "l2/202402.parquet", rowGroup: 14, rows: 48238 },
    offsetMinutes: 41,
    evidence: "trades 2024-02-19 03:50Z-05:41Z (111 minutes), 31% past 00:00 ET Monday: best lag -41 min (volCorr 0.987, priceShare 0.73; at lag 0 -0.038, 0.054).",
  },
  {
    date: "2024-03-10",
    l1: { file: "l1/202403.parquet", rowGroup: 8, rows: 187190 },
    l2: { file: "l2/202403.parquet", rowGroup: 9, rows: 369574 },
    offsetMinutes: 94,
    evidence:
      "trades 2024-03-10 23:33Z-2024-03-11 05:34Z (361 minutes; the session opens 22:00Z, DST), 17.5% past 00:00 ET Monday: best lag -94 min (volCorr 0.783; at lag 0 0.072).",
  },
  {
    date: "2024-06-09",
    l1: { file: "l1/202406.parquet", rowGroup: 8, rows: 180515 },
    l2: { file: "l2/202406.parquet", rowGroup: 7, rows: 222362 },
    offsetMinutes: 243,
    evidence:
      "trades 2024-06-10 02:03Z-08:04Z (361 minutes; the session opens 22:00Z): best lag -243 min (volCorr 0.972, priceShare 0.446 at M24's offset 2179.75; at lag 0 -0.249). " +
      "The midpoint dating put it on Monday 2024-06-10 and dropped that day's own row group (9, 6112263 rows): mistimed bars to 08:03Z, then none until 2024-06-11 04:00Z.",
  },
  {
    date: "2025-06-29",
    l1: { file: "l1/202506.parquet", rowGroup: 27, rows: 278345 },
    l2: { file: "l2/202506.parquet", rowGroup: 25, rows: 378113 },
    offsetMinutes: 148,
    evidence: "trades 2025-06-30 00:27Z-06:28Z (361 minutes; the session opens 22:00Z), 33% past 00:00 ET Monday: best lag -148 min (volCorr 0.963, priceShare 0.258; at lag 0 -0.005).",
  },
  {
    date: "2025-07-20",
    l1: { file: "l1/202507.parquet", rowGroup: 18, rows: 148908 },
    l2: { file: "l2/202507.parquet", rowGroup: 17, rows: 207799 },
    offsetMinutes: 69,
    evidence: "trades 2025-07-20 23:08Z-2025-07-21 05:09Z (361 minutes; the session opens 22:00Z), 11% past 00:00 ET Monday: best lag -69 min (volCorr 0.788; at lag 0 0.164).",
  },
];
