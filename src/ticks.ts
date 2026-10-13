/**
 * Tick rounding, ported from projectx-mcp's src/ticks.ts (snapToTick, snapMode, snapPrices) so
 * an off-grid price is handled exactly as there: rounded onto the contract's tick grid, never
 * toward the market or to a worse fill, and reported in `snapped`. The tick size comes from the
 * contract table here (client.ts specOf), not a broker lookup.
 */

export type SnapMode = "down" | "up" | "nearest";

/** Slack on the tick ratio so float noise (x.9999999999 ticks) never costs a whole tick. */
const EPSILON = 1e-9;

/**
 * Snap a price to the contract's tick grid: divide by the tick, floor/ceil/round
 * the ratio with a small epsilon, multiply back, and round to 10 decimals so the
 * result carries no float noise.
 */
export function snapToTick(price: number, tick: number, mode: SnapMode): number {
  if (!Number.isFinite(price) || !Number.isFinite(tick) || tick <= 0) return price;
  const ratio = price / tick;
  const n = mode === "down" ? Math.floor(ratio + EPSILON) : mode === "up" ? Math.ceil(ratio - EPSILON) : Math.round(ratio);
  return Number((n * tick).toFixed(10));
}

export type PriceField = "limitPrice" | "stopPrice" | "trailPrice";

/**
 * Which way a price field rounds so it never moves toward the market or to a
 * worse fill. Stops (stopPrice, trailPrice): a sell stop rounds down, a buy stop
 * up. Limits: a buy rounds down (never pay more), a sell up. A stop-limit's
 * limitPrice rounds the same way as its stopPrice, so it never crosses the trigger.
 */
export function snapMode(field: PriceField, side: "buy" | "sell", stopLimit = false): SnapMode {
  if (field === "limitPrice" && !stopLimit) return side === "buy" ? "down" : "up";
  return side === "sell" ? "down" : "up";
}

export type Snapped = Partial<Record<PriceField, { from: number; to: number }>>;

/** Snap each given price field; returns the prices to send and what changed (empty when nothing did). */
export function snapPrices(
  prices: Partial<Record<PriceField, number | undefined>>,
  side: "buy" | "sell",
  tick: number | null,
  opts: { stopLimit?: boolean; fields?: readonly PriceField[] } = {},
): { prices: Partial<Record<PriceField, number | undefined>>; snapped: Snapped } {
  const out = { ...prices };
  const snapped: Snapped = {};
  if (tick === null) return { prices: out, snapped };
  for (const field of opts.fields ?? (["limitPrice", "stopPrice", "trailPrice"] as const)) {
    const from = prices[field];
    if (from === undefined) continue;
    const to = snapToTick(from, tick, snapMode(field, side, opts.stopLimit));
    if (to !== from) {
      out[field] = to;
      snapped[field] = { from, to };
    }
  }
  return { prices: out, snapped };
}

/** `{ snapped }` when a price was moved onto the tick grid, else nothing. */
export const snappedField = (s: Snapped) => (Object.keys(s).length ? { snapped: s } : {});
