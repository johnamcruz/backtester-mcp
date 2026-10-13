import * as zlib from "node:zlib";
import { asyncBufferFromFile, parquetMetadataAsync, parquetRead, type AsyncBuffer, type FileMetaData } from "hyparquet";

/**
 * Reading the local order-book parquet files one row group (one ET day) at a
 * time, with hyparquet (pure JS, no native code) and Node's own zstd
 * (`zlib.zstdDecompressSync`, Node 22.15+). A month is never loaded whole: a
 * call decodes one row group's columns.
 */

type Zstd = (buf: Uint8Array) => Buffer;
const zstd = (zlib as unknown as { zstdDecompressSync?: Zstd }).zstdDecompressSync;

/** hyparquet decompressor table: ZSTD from node:zlib (SNAPPY and UNCOMPRESSED are built in). */
export function compressors(z: Zstd | null = zstd ?? null) {
  return {
    ZSTD: (input: Uint8Array) => {
      if (!z) throw new Error(`reading zstd parquet needs Node 22.15 or later (node:zlib zstdDecompressSync); this is Node ${process.versions.node}`);
      const b = z(input);
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    },
  };
}

export interface RowGroupInfo {
  index: number;
  /** First row of the group in the file. */
  rowStart: number;
  rows: number;
}

/** Decoded columns of a row range: timestamps as µs numbers, everything else as numbers. */
export type Columns = Record<string, Float64Array>;

export class ParquetFile {
  private constructor(
    readonly path: string,
    private readonly file: AsyncBuffer,
    readonly metadata: FileMetaData,
    readonly rowGroups: RowGroupInfo[],
  ) {}

  static async open(path: string): Promise<ParquetFile> {
    const file = await asyncBufferFromFile(path);
    const metadata = await parquetMetadataAsync(file);
    let rowStart = 0;
    const groups = metadata.row_groups.map((g, index) => {
      const info = { index, rowStart, rows: Number(g.num_rows) };
      rowStart += info.rows;
      return info;
    });
    return new ParquetFile(path, file, metadata, groups);
  }

  /** Column names of the file's schema (top level). */
  get columnNames(): string[] {
    return this.metadata.schema.slice(1).map((s) => s.name);
  }

  /**
   * The smallest and largest `ts` of row group `group`, UTC ms, from the file's
   * column statistics (no rows read); null when the file has none for it.
   * Statistics give milliseconds (a Date: the µs floored) or µs (a bigint: floored here too).
   */
  tsRange(group: number): { min: number; max: number } | null {
    const col = this.metadata.row_groups[group]?.columns.find((c) => c.meta_data?.path_in_schema.join(".") === "ts");
    const s = col?.meta_data?.statistics;
    const ms = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === "bigint" ? Math.floor(Number(v) / 1000) : NaN);
    const min = ms(s?.min_value ?? s?.min);
    const max = ms(s?.max_value ?? s?.max);
    return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
  }

  /**
   * Rows [from, to) of row group `group` (relative to the group), the named
   * columns as Float64Array. INT64 timestamps (µs since the epoch) stay exact:
   * they are below 2^53.
   */
  async read(group: number, columns: string[], from = 0, to?: number): Promise<Columns> {
    const g = this.rowGroups[group];
    if (!g) throw new Error(`${this.path}: no row group ${group}`);
    const end = Math.min(to ?? g.rows, g.rows);
    const rowStart = g.rowStart + Math.max(0, from);
    const rowEnd = g.rowStart + end;
    const out: Columns = {};
    for (const c of columns) out[c] = new Float64Array(Math.max(0, rowEnd - rowStart));
    if (rowEnd <= rowStart) return out;
    const missing = columns.filter((c) => !this.columnNames.includes(c));
    if (missing.length) throw new Error(`${this.path}: no column ${missing.join(", ")}`);
    await parquetRead({
      file: this.file,
      metadata: this.metadata,
      columns,
      rowStart,
      rowEnd,
      compressors: compressors(),
      parsers: { timestampFromMicroseconds: (x: bigint) => x, timestampFromMilliseconds: (x: bigint) => x * 1000n },
      onChunk: ({ columnName, columnData, rowStart: cs }) => {
        const dst = out[columnName];
        // A chunk may cover rows outside the requested range: copy the overlap only.
        const lo = Math.max(cs, rowStart);
        const hi = Math.min(cs + columnData.length, rowEnd);
        for (let r = lo; r < hi; r++) dst[r - rowStart] = Number(columnData[r - cs] as number | bigint);
      },
    });
    return out;
  }
}
