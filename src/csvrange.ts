import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { parseCsv, parseTimestamp, type BarSeries } from "./bars.js";

/** A window bigger than any CSV line: the binary search stops narrowing at it and scans lines from there. */
const WINDOW = 65536;
const PROBE = 512;

/**
 * The rows of a time-sorted `datetime,open,high,low,close,volume` file with `from <= t < to`, read by
 * seeking (a binary search on byte offsets, then one read of the range): the file is never loaded whole.
 * Parsed exactly as `parseCsv` parses the whole file (same rounding, duplicates keep the first row), so a
 * slice equals the same rows of the full series.
 */
export function readCsvRange(file: string, from: number, to: number): BarSeries {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const read = (pos: number, len: number): Buffer => {
      const buf = Buffer.alloc(Math.max(0, Math.min(len, size - pos)));
      const n = buf.length ? readSync(fd, buf, 0, buf.length, pos) : 0;
      return buf.subarray(0, n);
    };
    const headEnd = read(0, 4096).indexOf(0x0a);
    if (headEnd < 0) return parseCsv(read(0, size).toString("utf8"), file);
    const header = read(0, headEnd).toString("utf8");
    const dataStart = headEnd + 1;
    const stamp = (pos: number): number => {
      const buf = read(pos, PROBE);
      const end = buf.indexOf(0x2c);
      return end < 0 ? Infinity : parseTimestamp(buf.subarray(0, end).toString("utf8").trim());
    };
    /** First position after a newline at or after `p` (size: none). */
    const nextLine = (p: number): number => {
      for (let q = p; q < size; q += PROBE) {
        const i = read(q, PROBE).indexOf(0x0a);
        if (i >= 0) return q + i + 1;
      }
      return size;
    };
    /** Start of the first line with t >= ms (size: none). */
    const seek = (ms: number): number => {
      let lo = dataStart; // a line start; every line before it has t < ms
      let hi = size; // the answer is a line start at most `hi`, or one line after it
      while (hi - lo > WINDOW) {
        const mid = Math.floor((lo + hi) / 2);
        const s = nextLine(mid);
        if (s < size && stamp(s) < ms) lo = s;
        else hi = mid;
      }
      const text = read(lo, hi - lo + WINDOW).toString("utf8");
      let pos = lo;
      for (const line of text.split("\n")) {
        const comma = line.indexOf(",");
        if (comma > 0 && parseTimestamp(line.slice(0, comma).trim()) >= ms) return pos;
        pos += Buffer.byteLength(line) + 1;
      }
      return Math.min(pos, size);
    };
    if (to <= from) return parseCsv(`${header}\n`, file);
    const a = seek(from);
    const b = Math.max(a, seek(to));
    return parseCsv(`${header}\n${read(a, b - a).toString("utf8")}`, file);
  } finally {
    closeSync(fd);
  }
}
