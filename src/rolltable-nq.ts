import type { DataException, RollEntry } from "./rolltable.js";

/**
 * The reviewed roll table of the local NQ L1/L2 data (README "Roll table").
 *
 * Derived per roll with scripts/derive-roll-table.ts: while the raw data is on
 * contract X, (back-adjusted CSV close - raw close) is X's constant adjustment,
 * whatever day the CSV itself rolled, so a step in that offset is a raw switch,
 * and its level names the contract. Every switch is at 00:00 ET (the vendor's
 * day-file boundary). Rule eras (calendar.ts rollStart): through U22 the
 * Thursday before the expiry week, from Z22 the expiry-week Monday.
 *
 * The CSV starts 2021-04-25, so the table starts 2021-04-01 (00:00 ET), on
 * M21; the H21 roll (2021-03-11 by the rule) is before it and can't be
 * checked. Data outside the table is not served. Checked and not switches
 * (the CSV wanders on a partial day, or drifts after its own Sunday roll):
 * 2021-05-11, 2022-11-21, 2023-06-11, 2023-12-10, 2024-03-10, 2024-06-10,
 * 2025-06-29, 2025-07-20.
 */

export const NQ_TABLE_START = "2021-04-01T04:00:00.000Z";
export const NQ_TABLE_END = "2025-12-01T05:00:00.000Z";

export const NQ_ROLLS: RollEntry[] = [
  { from: "M21", to: "U21", at: "2021-06-10T04:00:00.000Z", note: "rule (era 1, Thursday)" },
  { from: "U21", to: "Z21", at: "2021-09-09T04:00:00.000Z", note: "rule (era 1)" },
  { from: "Z21", to: "H22", at: "2021-12-09T05:00:00.000Z", note: "rule (era 1)" },
  { from: "H22", to: "M22", at: "2022-03-10T05:00:00.000Z", note: "rule (era 1)" },
  { from: "M22", to: "U22", at: "2022-06-09T04:00:00.000Z", note: "rule (era 1); the 2022-06-17 file is back on M22 (exception)" },
  { from: "U22", to: "Z22", at: "2022-09-08T04:00:00.000Z", note: "rule (era 1; first trade 00:01 ET)" },
  { from: "Z22", to: "H23", at: "2022-12-12T05:00:00.000Z", note: "rule (era 2 from here, Monday)" },
  { from: "H23", to: "M23", at: "2023-03-13T04:00:00.000Z", note: "rule (era 2)" },
  { from: "M23", to: "U23", at: "2023-06-12T04:00:00.000Z", note: "rule (era 2)" },
  { from: "U23", to: "Z23", at: "2023-09-11T04:00:00.000Z", note: "rule (era 2)" },
  { from: "Z23", to: "H24", at: "2023-12-11T05:00:00.000Z", note: "rule (era 2); 2023-12-03 evening and 2023-12-06 were on H24 (exceptions)" },
  { from: "H24", to: "M24", at: "2024-03-11T04:00:00.000Z", note: "rule (era 2); the 03-10 file also holds H24 rows past 00:00 ET Monday (dropped)" },
  { from: "M24", to: "U24", at: "2024-06-17T04:00:00.000Z", note: "rule (era 2)" },
  { from: "U24", to: "Z24", at: "2024-09-12T04:00:00.000Z", note: "EARLY: Thursday 00:00 ET, four days before the rule's 2024-09-16" },
  { from: "Z24", to: "H25", at: "2024-12-16T05:00:00.000Z", note: "rule (era 2)" },
  { from: "H25", to: "M25", at: "2025-03-17T04:00:00.000Z", note: "rule (era 2)" },
  { from: "M25", to: "U25", at: "2025-06-16T04:00:00.000Z", note: "rule (era 2)" },
  { from: "U25", to: "Z25", at: "2025-09-15T04:00:00.000Z", note: "rule (era 2)" },
];

export const NQ_EXCEPTIONS: DataException[] = [
  {
    from: "2022-06-17T04:00:00.000Z",
    to: "2022-06-18T04:00:00.000Z",
    contract: "M22",
    note: "the expiry-day file is back on M22 (offset +35.5, thin volume); cut at M22's expiry 09:30 ET: the trades after it are unassigned",
  },
  { from: "2023-12-03T05:00:00.000Z", to: "2023-12-04T05:00:00.000Z", contract: "H24", note: "Sunday evening on the back month (25 bars)" },
  { from: "2023-12-06T05:00:00.000Z", to: "2023-12-07T05:00:00.000Z", contract: "H24", note: "one day on the back month (836 bars, offset -201.75)" },
  {
    from: "2025-02-09T05:00:00.000Z",
    to: "2025-02-10T05:00:00.000Z",
    contract: null,
    note: "Sunday file with one print 92.75 points off the H25 level, matching no contract (H25-M25 spread about 207): unassigned",
  },
];
