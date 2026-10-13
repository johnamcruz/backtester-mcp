import { describe, expect, it } from "vitest";
import { snapMode, snapPrices, snapToTick, snappedField } from "../src/ticks.js";

// Ported from projectx-mcp's test/ticks.test.ts: the same rounding, case for case.
describe("snapToTick", () => {
  it("removes float noise", () => {
    expect(snapToTick(30342.249999, 0.25, "nearest")).toBe(30342.25);
    expect(snapToTick(30342.249999, 0.25, "up")).toBe(30342.25);
    expect(snapToTick(30342.250000000004, 0.25, "down")).toBe(30342.25);
    expect(snapToTick(30342.249999999996, 0.25, "up")).toBe(30342.25);
    expect(snapToTick(0.1 + 0.2, 0.1, "down")).toBe(0.3);
    expect(snapToTick(0.3, 0.1, "down")).toBe(0.3);
    expect(snapToTick(0.1 + 0.2, 0.1, "up")).toBe(0.3);
  });

  it("floors, ceils, or rounds an off-grid price", () => {
    expect(snapToTick(21000.1, 0.25, "down")).toBe(21000);
    expect(snapToTick(21000.1, 0.25, "up")).toBe(21000.25);
    expect(snapToTick(21000.1, 0.25, "nearest")).toBe(21000);
    expect(snapToTick(21000.2, 0.25, "nearest")).toBe(21000.25);
  });

  it("handles an MGC-style 0.1 tick without float noise", () => {
    expect(snapToTick(2650.37, 0.1, "down")).toBe(2650.3);
    expect(snapToTick(2650.31, 0.1, "up")).toBe(2650.4);
    expect(snapToTick(2650.3, 0.1, "down")).toBe(2650.3);
    expect(snapToTick(2650.3, 0.1, "up")).toBe(2650.3);
  });

  it("leaves on-grid prices untouched and ignores a bad tick", () => {
    for (const mode of ["down", "up", "nearest"] as const) expect(snapToTick(21000.75, 0.25, mode)).toBe(21000.75);
    expect(snapToTick(21000.1, 0, "down")).toBe(21000.1);
    expect(snapToTick(21000.1, Number.NaN, "down")).toBe(21000.1);
  });
});

describe("snapMode", () => {
  it("never moves a price toward the market or to a worse fill", () => {
    expect(snapMode("stopPrice", "sell")).toBe("down");
    expect(snapMode("stopPrice", "buy")).toBe("up");
    expect(snapMode("trailPrice", "sell")).toBe("down");
    expect(snapMode("trailPrice", "buy")).toBe("up");
    expect(snapMode("limitPrice", "buy")).toBe("down");
    expect(snapMode("limitPrice", "sell")).toBe("up");
    expect(snapMode("limitPrice", "buy", true)).toBe("up");
    expect(snapMode("limitPrice", "sell", true)).toBe("down");
  });
});

describe("snapPrices", () => {
  it("reports only what changed, and changes nothing without a tick", () => {
    expect(snapPrices({ limitPrice: 100.1, stopPrice: 99.5 }, "buy", 0.25)).toEqual({
      prices: { limitPrice: 100, stopPrice: 99.5 },
      snapped: { limitPrice: { from: 100.1, to: 100 } },
    });
    expect(snapPrices({ stopPrice: 99.6 }, "buy", null)).toEqual({ prices: { stopPrice: 99.6 }, snapped: {} });
  });

  it("rounds only the fields asked for", () => {
    expect(snapPrices({ stopPrice: 99.6, trailPrice: 99.6 }, "sell", 0.25, { fields: ["stopPrice"] })).toEqual({
      prices: { stopPrice: 99.5, trailPrice: 99.6 },
      snapped: { stopPrice: { from: 99.6, to: 99.5 } },
    });
  });

  it("snappedField is empty when nothing moved", () => {
    expect(snappedField({})).toEqual({});
    expect(snappedField({ stopPrice: { from: 1.1, to: 1 } })).toEqual({ snapped: { stopPrice: { from: 1.1, to: 1 } } });
  });
});
