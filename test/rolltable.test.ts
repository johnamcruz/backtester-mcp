import { describe, expect, it } from "vitest";
import { etDate, etDayBounds, expiryMoment, monthCode, nextQuarter, parseMonthCode, rollStart } from "../src/calendar.js";
import { NQ_SCHEDULE, NQ_TABLE, RollSchedule, scheduleOf, segments, type RollTable } from "../src/rolltable.js";

const Z = (s: string) => Date.parse(s);

describe("the reviewed NQ roll table", () => {
  it("lists every quarterly roll in order, each at 00:00 ET", () => {
    let c = parseMonthCode(NQ_TABLE.rolls[0].from)!;
    for (const r of NQ_TABLE.rolls) {
      expect(r.from).toBe(monthCode(c));
      c = nextQuarter(c);
      expect(r.to).toBe(monthCode(c));
      expect(etDayBounds(etDate(Z(r.at))).start).toBe(Z(r.at));
    }
    expect(NQ_TABLE.rolls.at(-1)!.to).toBe("Z25");
    for (const e of NQ_TABLE.exceptions) {
      expect(etDayBounds(etDate(Z(e.from))).start).toBe(Z(e.from));
      expect(etDayBounds(etDate(Z(e.to))).start).toBe(Z(e.to));
    }
  });

  it("follows the rule of its era at every roll, except the reviewed ones", () => {
    const off = NQ_TABLE.rolls.filter((r) => Z(r.at) !== rollStart(parseMonthCode(r.from)!)).map((r) => [r.from, r.at]);
    expect(off).toEqual([["U24", "2024-09-12T04:00:00.000Z"]]);
    // Era 1 (through U22) rolls on Thursdays, era 2 on Mondays.
    for (const r of NQ_TABLE.rolls.filter((x) => x.from !== "U24")) {
      const c = parseMonthCode(r.from)!;
      const era1 = c.year < 2022 || (c.year === 2022 && c.month <= 9);
      expect(new Date(Z(r.at) - 4 * 36e5).getUTCDay(), `${r.from}`).toBe(era1 ? 4 : 1);
    }
  });

  it("never assigns a contract past its expiry (third Friday 09:30 ET), nor outside the table", () => {
    for (const s of NQ_SCHEDULE.segments) if (s.contract) expect(s.to, `${s.contract}`).toBeLessThanOrEqual(expiryMoment(parseMonthCode(s.contract)!));
    // 2022-06-17: back on M22 until its expiry, unassigned after it.
    expect(NQ_SCHEDULE.dataContractAt(Z("2022-06-17T13:29:59Z"))).toBe("M22");
    expect(NQ_SCHEDULE.dataContractAt(Z("2022-06-17T13:30:00Z"))).toBeNull();
    expect(NQ_SCHEDULE.dataContractAt(Z("2022-06-18T04:00:00Z"))).toBe("U22");
    expect(NQ_SCHEDULE.dataContractAt(Z("2021-03-31T12:00:00Z"))).toBeNull();
    expect(NQ_SCHEDULE.dataContractAt(Z("2025-12-01T05:00:00Z"))).toBeNull();
    expect(NQ_SCHEDULE.covers(Z("2021-04-01T04:00:00Z"))).toBe(true);
    expect(NQ_SCHEDULE.covers(Z("2021-04-01T03:59:59Z"))).toBe(false);
  });

  it("assigns the data's contract per minute: switches at 00:00 ET, exceptions, the early 2024-09 roll", () => {
    expect(NQ_SCHEDULE.dataContractAt(Z("2024-03-11T03:59:00Z"))).toBe("H24");
    expect(NQ_SCHEDULE.dataContractAt(Z("2024-03-11T04:00:00Z"))).toBe("M24");
    expect(NQ_SCHEDULE.dataContractAt(Z("2021-06-10T03:59:00Z"))).toBe("M21");
    expect(NQ_SCHEDULE.dataContractAt(Z("2021-06-10T04:00:00Z"))).toBe("U21");
    expect(NQ_SCHEDULE.dataContractAt(Z("2024-09-12T03:59:00Z"))).toBe("U24");
    expect(NQ_SCHEDULE.dataContractAt(Z("2024-09-12T04:00:00Z"))).toBe("Z24");
    expect(NQ_SCHEDULE.dataContractAt(Z("2023-12-05T12:00:00Z"))).toBe("Z23");
    expect(NQ_SCHEDULE.dataContractAt(Z("2023-12-06T05:00:00Z"))).toBe("H24");
    expect(NQ_SCHEDULE.dataContractAt(Z("2023-12-07T04:59:00Z"))).toBe("H24");
    expect(NQ_SCHEDULE.dataContractAt(Z("2023-12-07T05:00:00Z"))).toBe("Z23");
    expect(NQ_SCHEDULE.dataContractAt(Z("2023-12-04T02:44:00Z"))).toBe("H24");
  });

  it("switches the active contract at the CME trading day's start (18:00 ET) before the data's switch", () => {
    // Data switch Monday 2024-03-11 00:00 ET; active from Sunday 18:00 ET (22:00Z, EDT).
    expect(NQ_SCHEDULE.activeAt(Z("2024-03-10T21:59:59Z"))).toBe("H24");
    expect(NQ_SCHEDULE.activeAt(Z("2024-03-10T22:00:00Z"))).toBe("M24");
    // Data switch Thursday 2021-06-10 00:00 ET; active from Wednesday 18:00 ET.
    expect(NQ_SCHEDULE.activeAt(Z("2021-06-09T21:59:59Z"))).toBe("M21");
    expect(NQ_SCHEDULE.activeAt(Z("2021-06-09T22:00:00Z"))).toBe("U21");
    // An exception doesn't move the front.
    expect(NQ_SCHEDULE.activeAt(Z("2023-12-06T12:00:00Z"))).toBe("Z23");
    expect(NQ_SCHEDULE.activeAt(Z("2021-03-01T00:00:00Z"))).toBeNull();
  });

  it("lists the moments the data leaves a contract for good: its roll or its expiry, not a stretch it comes back from", () => {
    // Dec 2023: the data is on H24 on 12-03 evening and 12-06, then back on Z23 until the 12-11 roll.
    expect(NQ_SCHEDULE.switchesBetween(Z("2023-12-01T00:00:00Z"), Z("2023-12-12T00:00:00Z")).map((x) => [new Date(x.at).toISOString(), x.off])).toEqual([
      ["2023-12-11T05:00:00.000Z", "Z23"],
    ]);
    // 2022-06: M22 is settled at its 06-09 roll (the expiry-day file back on M22 doesn't hold that off),
    // and again at its expiry for anything opened on it in that file; U22, away on 06-17, is not settled.
    expect(NQ_SCHEDULE.switchesBetween(Z("2022-06-01T00:00:00Z"), Z("2022-06-30T00:00:00Z")).map((x) => [new Date(x.at).toISOString(), x.off])).toEqual([
      ["2022-06-09T04:00:00.000Z", "M22"],
      ["2022-06-17T13:30:00.000Z", "M22"],
    ]);
    // 2025-02-09: a day with no contract, H25 comes back.
    expect(NQ_SCHEDULE.switchesBetween(Z("2025-02-01T00:00:00Z"), Z("2025-02-28T00:00:00Z"))).toEqual([]);
    // (from, to]: a switch exactly at `from` is not repeated, one exactly at `to` is in.
    expect(NQ_SCHEDULE.switchesBetween(Z("2024-03-11T04:00:00Z"), Z("2024-03-12T00:00:00Z"))).toEqual([]);
    expect(NQ_SCHEDULE.switchesBetween(Z("2024-03-10T00:00:00Z"), Z("2024-03-11T04:00:00Z"))).toEqual([{ at: Z("2024-03-11T04:00:00Z"), off: "H24" }]);
    // The table's end is not a switch.
    expect(NQ_SCHEDULE.switchesBetween(Z("2025-11-25T00:00:00Z"), Z("2026-01-01T00:00:00Z"))).toEqual([]);
  });

  it("tells the exception stretches (half-open)", () => {
    expect(NQ_SCHEDULE.inException(Date.parse("2023-12-06T05:00:00Z"))).toBe(true);
    expect(NQ_SCHEDULE.inException(Date.parse("2023-12-07T04:59:00Z"))).toBe(true);
    expect(NQ_SCHEDULE.inException(Date.parse("2023-12-07T05:00:00Z"))).toBe(false);
    expect(NQ_SCHEDULE.inException(Date.parse("2025-02-09T23:00:00Z"))).toBe(true);
    expect(NQ_SCHEDULE.inException(Date.parse("2024-03-05T15:00:00Z"))).toBe(false);
  });

  it("hashes the table, and only NQ has one", () => {
    expect(NQ_SCHEDULE.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new RollSchedule(NQ_TABLE).hash).toBe(NQ_SCHEDULE.hash);
    const other: RollTable = { ...NQ_TABLE, exceptions: [] };
    expect(new RollSchedule(other).hash).not.toBe(NQ_SCHEDULE.hash);
    expect(scheduleOf("NQ")).toBe(NQ_SCHEDULE);
    expect(scheduleOf("ES")).toBeNull();
    expect(() => segments({ ...NQ_TABLE, exceptions: [{ from: NQ_TABLE.start, to: NQ_TABLE.end, contract: "X1", note: "" }] })).toThrow(/bad contract code X1/);
  });
});
