import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nextBarClose, readNow, runClockCli, stepClock, writeClock } from "../src/clock.js";
import { tmp } from "./helpers.js";

describe("readNow", () => {
  it("reads the clock file on every call, else BACKTESTER_NOW", () => {
    const file = join(tmp(), "clock.json");
    expect(() => readNow({ clockFile: file, fixedNow: null })).toThrow(/does not exist yet/);
    expect(readNow({ clockFile: file, fixedNow: "2024-01-02T00:00:00Z" }).toISOString()).toBe("2024-01-02T00:00:00.000Z");
    writeClock(file, new Date("2024-03-05T15:00:00Z"));
    expect(readNow({ clockFile: file, fixedNow: null }).toISOString()).toBe("2024-03-05T15:00:00.000Z");
    writeClock(file, new Date("2024-03-05T15:01:00Z"));
    expect(readNow({ clockFile: file, fixedNow: "2020-01-01T00:00:00Z" }).toISOString()).toBe("2024-03-05T15:01:00.000Z");
    expect(readNow({ clockFile: null, fixedNow: "2024-01-02T00:00:00Z" }).toISOString()).toBe("2024-01-02T00:00:00.000Z");
    expect(() => readNow({ clockFile: null, fixedNow: null })).toThrow(/No replay clock/);
  });

  it("explains a malformed clock", () => {
    const file = join(tmp(), "clock.json");
    writeFileSync(file, "nope");
    expect(() => readNow({ clockFile: file, fixedNow: null })).toThrow(/not JSON/);
    writeFileSync(file, JSON.stringify({ now: "later" }));
    expect(() => readNow({ clockFile: file, fixedNow: null })).toThrow(/no valid "now"/);
  });
});

describe("clock arithmetic", () => {
  it("steps and finds the next bar close", () => {
    const t = new Date("2024-03-05T15:02:30Z");
    expect(stepClock(t, 5).toISOString()).toBe("2024-03-05T15:07:30.000Z");
    expect(nextBarClose(t, 5).toISOString()).toBe("2024-03-05T15:05:00.000Z");
    expect(nextBarClose(new Date("2024-03-05T15:05:00Z"), 5).toISOString()).toBe("2024-03-05T15:10:00.000Z");
    expect(nextBarClose(t, 1).toISOString()).toBe("2024-03-05T15:03:00.000Z");
  });
});

describe("clock CLI", () => {
  it("sets, steps, advances to the next bar, and prints", () => {
    const file = join(tmp(), "sub", "clock.json");
    const out: string[] = [];
    const run = (...a: string[]) => runClockCli(["--file", file, ...a], {}, (s) => out.push(s.trim()));
    expect(run("--set", "2024-03-05T15:00:00Z")).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ now: "2024-03-05T15:00:00.000Z" });
    run("--step", "2");
    run("--next-bar", "5");
    run();
    expect(out).toEqual([
      '{"now":"2024-03-05T15:00:00.000Z"}',
      '{"now":"2024-03-05T15:02:00.000Z"}',
      '{"now":"2024-03-05T15:05:00.000Z"}',
      '{"now":"2024-03-05T15:05:00.000Z"}',
    ]);
  });

  it("takes the file from BACKTESTER_CLOCK_FILE and rejects bad arguments", () => {
    const file = join(tmp(), "clock.json");
    expect(runClockCli(["--set", "2024-03-05T15:00:00Z"], { BACKTESTER_CLOCK_FILE: file }, () => {})).toBe(0);
    expect(() => runClockCli([], {}, () => {})).toThrow(/usage/);
    expect(() => runClockCli(["--file", file, "--set", "x"], {}, () => {})).toThrow(/ISO/);
    expect(() => runClockCli(["--file", file, "--step", "-1"], {}, () => {})).toThrow(/positive/);
    expect(() => runClockCli(["--file", file, "--step", "1", "--next-bar", "5"], {}, () => {})).toThrow(/only one/);
  });
});
