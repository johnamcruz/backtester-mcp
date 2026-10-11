import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Journal } from "../src/journal.js";

describe("Journal", () => {
  it("appends and filters entries", async () => {
    const j = new Journal(join(mkdtempSync(join(tmpdir(), "btj-")), "nested", "journal.jsonl"));
    expect(await j.read()).toEqual([]);
    await j.add({ kind: "plan", text: "fade the open", contractId: "A" });
    await j.add({ kind: "lesson", text: "never move the stop away", tags: ["discipline"] });
    await j.add({ kind: "lesson", text: "size down after two losses" });
    expect((await j.read({ kind: "lesson" })).map((e) => e.text)).toEqual(["never move the stop away", "size down after two losses"]);
    expect(await j.read({ tag: "discipline" })).toHaveLength(1);
    expect(await j.read({ contractId: "A" })).toHaveLength(1);
    expect((await j.read({ limit: 1 }))[0].text).toBe("size down after two losses");
  });

  it("stamps entries with the given clock (the replay time) and filters by it", async () => {
    let now = new Date("2024-03-05T15:00:00Z");
    const j = new Journal(join(mkdtempSync(join(tmpdir(), "btj-")), "journal.jsonl"), () => now);
    expect((await j.add({ kind: "note", text: "a" })).ts).toBe("2024-03-05T15:00:00.000Z");
    now = new Date("2024-03-06T15:00:00Z");
    await j.add({ kind: "note", text: "b" });
    expect((await j.read({ since: "2024-03-06T00:00:00Z" })).map((e) => e.text)).toEqual(["b"]);
  });

  it("skips corrupt lines", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "btj-")), "journal.jsonl");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, '{"ts":"2024-01-01T00:00:00Z","kind":"note","text":"ok"}\nnot json\n');
    expect((await new Journal(path).read()).map((e) => e.text)).toEqual(["ok"]);
  });
});
