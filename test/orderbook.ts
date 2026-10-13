import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { parquetWriteFile } from "hyparquet-writer";
import type { CompressionCodec, SchemaElement } from "hyparquet";

/**
 * Tiny synthetic order-book parquet in the layout of the local NQ data:
 * l1/YYYYMM.parquet and l2/YYYYMM.parquet, zstd, one row group per ET day,
 * `ts` an INT64 µs timestamp (timezone-naive, UTC values).
 */

/** [time (ms, UTC; may be fractional for µs), type (0 bid, 1 ask, 2 trade, 3-9 stats), price, vol] */
export type L1Row = [number, number, number, number];
/** [time (ms), side (0 bid, 1 ask), price, vol, depth, act (0 add, 1 update, 2 remove)] */
export type L2Row = [number, number, number, number, number, number];

const ts: SchemaElement = { name: "ts", type: "INT64", repetition_type: "REQUIRED", logical_type: { type: "TIMESTAMP", isAdjustedToUTC: false, unit: "MICROS" } };
const int8 = (name: string): SchemaElement => ({ name, type: "INT32", repetition_type: "REQUIRED", logical_type: { type: "INTEGER", bitWidth: 8, isSigned: true } });
const f64 = (name: string): SchemaElement => ({ name, type: "DOUBLE", repetition_type: "REQUIRED" });
const i32 = (name: string): SchemaElement => ({ name, type: "INT32", repetition_type: "REQUIRED" });

const us = (ms: number) => BigInt(Math.round(ms * 1000));

/** Write one monthly file: `groups` are the row groups (one per ET day), in order. */
export function writeL1(file: string, groups: L1Row[][], codec: CompressionCodec = "ZSTD"): void {
  const rows = groups.flat();
  parquetWriteFile({
    filename: file,
    codec,
    compressors: { ZSTD: (b: Uint8Array) => new Uint8Array(zstdCompressSync(b)) },
    rowGroupSize: groups.map((g) => g.length),
    schema: [{ name: "schema", num_children: 4 }, ts, int8("type"), f64("price"), i32("vol")],
    columnData: [
      { name: "ts", data: BigInt64Array.from(rows.map((r) => us(r[0]))) },
      { name: "type", data: Int32Array.from(rows.map((r) => r[1])) },
      { name: "price", data: Float64Array.from(rows.map((r) => r[2])) },
      { name: "vol", data: Int32Array.from(rows.map((r) => r[3])) },
    ],
  });
}

export function writeL2(file: string, groups: L2Row[][]): void {
  const rows = groups.flat();
  parquetWriteFile({
    filename: file,
    codec: "ZSTD",
    compressors: { ZSTD: (b: Uint8Array) => new Uint8Array(zstdCompressSync(b)) },
    rowGroupSize: groups.map((g) => g.length),
    schema: [{ name: "schema", num_children: 6 }, ts, int8("side"), f64("price"), i32("vol"), int8("depth"), int8("act")],
    columnData: [
      { name: "ts", data: BigInt64Array.from(rows.map((r) => us(r[0]))) },
      { name: "side", data: Int32Array.from(rows.map((r) => r[1])) },
      { name: "price", data: Float64Array.from(rows.map((r) => r[2])) },
      { name: "vol", data: Int32Array.from(rows.map((r) => r[3])) },
      { name: "depth", data: Int32Array.from(rows.map((r) => r[4])) },
      { name: "act", data: Int32Array.from(rows.map((r) => r[5])) },
    ],
  });
}

/** One synthetic ET day: its L1 and (optionally) L2 rows, time-sorted. */
export interface SynthDay {
  l1?: L1Row[];
  l2?: L2Row[];
}

/** Write a source folder from days keyed "YYYY-MM-DD" (grouped into monthly files, days in date order). */
export function writeSource(dir: string, days: Record<string, SynthDay>): void {
  mkdirSync(join(dir, "l1"), { recursive: true });
  mkdirSync(join(dir, "l2"), { recursive: true });
  const months = new Map<string, string[]>();
  for (const d of Object.keys(days).sort()) {
    const m = d.slice(0, 7).replace("-", "");
    months.set(m, [...(months.get(m) ?? []), d]);
  }
  for (const [m, ds] of months) {
    const l1 = ds.map((d) => days[d].l1 ?? []).filter((g) => g.length);
    const l2 = ds.map((d) => days[d].l2 ?? []).filter((g) => g.length);
    if (l1.length) writeL1(join(dir, "l1", `${m}.parquet`), l1);
    if (l2.length) writeL2(join(dir, "l2", `${m}.parquet`), l2);
  }
}

const MIN = 60000;

/**
 * A simple L1 minute: a bid, an ask, then trades at `prices` (size 1 each,
 * 1 s apart) starting `at` (ms).
 */
export function l1Minute(at: number, prices: number[], size = 1): L1Row[] {
  const p0 = prices[0];
  return [[at, 0, p0 - 0.25, 5], [at + 1, 1, p0, 4], ...prices.map((p, i): L1Row => [at + 1000 * (i + 1), 2, p, size])];
}

/** `n` minutes of L1 from `start` (ms), one trade per minute at `price + i * step`. */
export function l1Minutes(start: number, n: number, price: number, step = 0): L1Row[] {
  return Array.from({ length: n }, (_, i) => l1Minute(start + i * MIN, [price + i * step])).flat();
}
