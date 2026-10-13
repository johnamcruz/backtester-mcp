import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VECTOR_SCHEMA, expectedResults, runVector, type Vector } from "./flowvectors.js";

/**
 * projectx-mcp's golden order-flow vectors through this repo's computation
 * (converter: test/flowvectors.ts). Every flow field must equal the vector's
 * expected value exactly (bit for bit, floats included), except the cases listed
 * in EXCEPTIONS, where a live-only behaviour can't apply to history; each of
 * those is asserted too (the live value and the history value), so a change on
 * either side fails here.
 *
 * The copies in test/vectors/projectx/ are projectx-mcp's vectors/*.json at
 * PROJECTX_COMMIT (README "Order flow"). With PROJECTX_MCP_DIR pointing at a
 * projectx-mcp checkout, the last test checks they are byte-identical to the
 * files at that commit; without it, it is skipped.
 */

const DIR = join(import.meta.dirname, "vectors", "projectx");
export const PROJECTX_COMMIT = "1e2e03cf7f7427d798317cbd9e5448fb64452e70";
const SHA256: Record<string, string> = {
  "bars-and-session.json": "58047a0274d4f376fbb3339f84db3361bc9b7958664c95f64414d28a5a902288",
  "book-fields.json": "87b8d5a225ba406a867b6fa405b0e0700cdd9d32bdca1a31a2a8d3049a1b135e",
  "completeness.json": "c72edf1eabb9f92dd629f0deeb82e14f4ebc20d67582de2e2731d800f2212455",
  "trade-fields.json": "90f4521bf55447946694e64dbf6d4fa46b8009a430dab0daad1fe9ac12da98d8",
};

const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
const raw = (f: string) => readFileSync(join(DIR, f));
const load = (f: string) => JSON.parse(raw(f).toString("utf8")) as Vector;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/**
 * What is never compared, for every vector:
 * - `source` of a row ("live") and `sources` of a footprint bar (["live"]): the
 *   label of where the minute came from; here it is "history".
 * - `coverage` (get_order_flow, get_footprint): projectx-mcp's own subscription
 *   state; the design doc says it need not be reproduced.
 * - `orderFlow.recorded` and `orderFlow.note` (get_bars): the live recorder's
 *   status and live's completeness text; history has neither (its note says what
 *   complete means here).
 * - get_trades, get_market_depth and get_top_of_book: views of the live feed
 *   (its print buffer, its book, its L1 history); this server has no such tools.
 * - Trade sides: the converter passes the vector's exchange flag, as the design
 *   doc says to; history infers them (flowengine.test.ts tests the inference).
 */
const NOT_SERVED = new Set(["get_trades", "get_market_depth", "get_top_of_book"]);

interface Exception {
  /** Call index in the vector, then the path in its result. */
  call: number;
  path: Array<string | number>;
  live: unknown;
  history: unknown;
  why: string;
}

const LATE = "a print received after its minute was final: live never applies it; history has no receive time and applies every print in its exchange minute";
const REPLAYED = "a print timed before the resubscribe (replayed): live ignores it; history applies it in its exchange minute (the minute is incomplete in both)";
const printFields = (call: number, row: number, why: string, size: number) =>
  (
    [
      ["bv", 0, size],
      ["delta", 0, size],
      ["volume", 0, size],
      ["trades", 0, 1],
      ["vwap", null, 100],
      ["high", null, 100],
      ["low", null, 100],
      ["maxPrint", null, size],
      ["ofiTrades", null, 1],
    ] as const
  ).map(([field, live, history]): Exception => ({ call, path: ["rows", row, field], live, history, why }));

/** Every field where history can't match live, with the reason. Only completeness.json has any. */
const EXCEPTIONS: Record<string, Exception[]> = {
  "completeness.json": [
    { call: 1, path: ["rows", 2, "complete"], live: false, history: true, why: "22:04: a silence over 10 s between hub messages (receive-time liveness); history has no receive time and its data is there" },
    { call: 1, path: ["rows", 4, "complete"], live: false, history: true, why: "22:06: the quote feed's session volume rose with no print (the trade-feed cross-check); history has no quote-volume feed" },
    ...printFields(1, 6, `22:08: ${LATE}`, 7),
    { call: 1, path: ["rows", 7, "complete"], live: false, history: true, why: "22:09: the silence from the last message before the disconnect touches the minute's settle window; history has the minute's data through its end" },
    ...printFields(1, 8, `22:10: ${REPLAYED}`, 9),
    { call: 1, path: ["rows", 11, "complete"], live: false, history: true, why: "22:13: not settled yet: live's settle grace grows with the measured receive delay (here 42 s, capped at 20 s), so it settles at 22:14:20, after the call at 22:14:12; history: ended by the clock" },
    { call: 1, path: ["cumulativeDelta", "asOf"], live: "2026-10-12T22:12:00.000Z", history: "2026-10-12T22:13:00.000Z", why: "follows from 22:13 being complete in history" },
  ],
};

/** The compared part of a call's result (expected or ours). */
function compared(tool: string, r: any): any {
  const c = structuredClone(r);
  if (tool === "get_order_flow") {
    delete c.coverage;
    for (const row of c.rows) delete row.source;
  } else if (tool === "get_footprint") {
    delete c.coverage;
    for (const b of c.bars) delete b.sources;
  } else if (tool === "get_bars") {
    delete c.orderFlow.recorded;
    delete c.orderFlow.note;
  }
  return c;
}

const at = (o: any, path: Array<string | number>) => path.reduce((x, k) => x?.[k], o);
const setAt = (o: any, path: Array<string | number>, v: unknown) => {
  const parent = at(o, path.slice(0, -1));
  parent[path.at(-1) as string | number] = v;
};

describe("projectx-mcp's golden order-flow vectors", () => {
  it("are the four documented scenarios, byte for byte the pinned copies", () => {
    expect(files).toEqual(Object.keys(SHA256).sort());
    for (const f of files) {
      expect(sha(raw(f)), f).toBe(SHA256[f]);
      const v = load(f);
      expect(v.schema).toBe(VECTOR_SCHEMA);
      expect(`${v.name}.json`).toBe(f);
    }
  });

  for (const f of files) {
    it(`${f}: every flow field matches, except the listed live-only cases`, () => {
      const v = load(f);
      const { results } = runVector(v);
      const calls = v.steps.filter((s): s is Extract<typeof s, { call: unknown }> => "call" in s);
      const exceptions = EXCEPTIONS[f] ?? [];
      let compares = 0;
      calls.forEach((s, i) => {
        if (NOT_SERVED.has(s.call.tool)) return;
        const want = compared(s.call.tool, s.expect);
        const got = compared(s.call.tool, results[i]);
        for (const e of exceptions.filter((x) => x.call === i)) {
          expect(at(want, e.path), `${e.path.join(".")}: the vector's live value (${e.why})`).toEqual(e.live);
          expect(at(got, e.path), `${e.path.join(".")}: the history value (${e.why})`).toEqual(e.history);
          setAt(want, e.path, e.history);
        }
        expect(got, `${f} call ${i} (${s.call.tool})`).toEqual(want);
        compares++;
      });
      expect(compares).toBeGreaterThan(0);
      // Every exception names a call that was compared.
      for (const e of exceptions) expect(NOT_SERVED.has(calls[e.call].call.tool)).toBe(false);
    });
  }

  it("the expected results of every served call are compared (none skipped by accident)", () => {
    const served = files.flatMap((f) => load(f).steps.filter((s) => "call" in s && !NOT_SERVED.has(s.call.tool)));
    const count = (tool: string) => served.filter((s) => "call" in s && s.call.tool === tool).length;
    expect([count("get_order_flow"), count("get_footprint"), count("get_bars"), served.length]).toEqual([9, 1, 3, 13]);
    expect(files.every((f) => expectedResults(load(f)).every((e) => e !== undefined))).toBe(true);
  });

  it("the converter refuses an unknown schema", () => {
    expect(() => runVector({ ...load("trade-fields.json"), schema: "other/1" })).toThrow(/unknown vector schema/);
  });

  it.skipIf(!process.env.PROJECTX_MCP_DIR)(`the copies are byte-identical to projectx-mcp's vectors at ${PROJECTX_COMMIT.slice(0, 7)}`, () => {
    const dir = process.env.PROJECTX_MCP_DIR as string;
    for (const f of files) {
      const theirs = execFileSync("git", ["-C", dir, "show", `${PROJECTX_COMMIT}:vectors/${f}`]);
      expect(sha(theirs), f).toBe(sha(raw(f)));
    }
  });
});
