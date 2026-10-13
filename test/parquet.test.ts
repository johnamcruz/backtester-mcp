import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ParquetFile, compressors } from "../src/parquet.js";
import { tmp } from "./helpers.js";
import { writeL1 } from "./orderbook.js";

const T = Date.parse("2024-03-05T15:00:00Z");

describe("parquet", () => {
  it("reads one zstd row group at a time, timestamps as exact µs", async () => {
    const file = join(tmp(), "l1.parquet");
    writeL1(file, [
      [[T + 0.001, 2, 18000.25, 3], [T + 1000.5, 0, 18000, 7]],
      [[T + 864e5, 1, 18010.5, 2]],
    ]);
    const f = await ParquetFile.open(file);
    expect(f.rowGroups).toEqual([
      { index: 0, rowStart: 0, rows: 2 },
      { index: 1, rowStart: 2, rows: 1 },
    ]);
    expect(f.columnNames).toEqual(["ts", "type", "price", "vol"]);
    const g0 = await f.read(0, ["ts", "type", "price", "vol"]);
    expect([...g0.ts]).toEqual([T * 1000 + 1, T * 1000 + 1000500]);
    expect([...g0.type]).toEqual([2, 0]);
    expect([...g0.price]).toEqual([18000.25, 18000]);
    expect([...g0.vol]).toEqual([3, 7]);
    const g1 = await f.read(1, ["price"]);
    expect([...g1.price]).toEqual([18010.5]);
    // A row range inside a group.
    expect([...(await f.read(0, ["vol"], 1)).vol]).toEqual([7]);
    expect([...(await f.read(0, ["vol"], 0, 1)).vol]).toEqual([3]);
    expect([...(await f.read(0, ["vol"], 2, 2)).vol]).toEqual([]);
    await expect(f.read(2, ["ts"])).rejects.toThrow(/no row group 2/);
    await expect(f.read(0, ["nope"])).rejects.toThrow(/no column nope/);
  });

  it("reads snappy files too, and explains a Node without zstd", async () => {
    const file = join(tmp(), "s.parquet");
    writeL1(file, [[[T, 2, 1, 1]]], "SNAPPY");
    expect([...(await (await ParquetFile.open(file)).read(0, ["price"])).price]).toEqual([1]);
    expect(() => compressors(null).ZSTD(new Uint8Array(1))).toThrow(/Node 22.15 or later/);
  });
});
