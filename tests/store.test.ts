import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptStore, validateEdits } from "../src/store";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
const edit = (text: string) => ({
  owner: "instructions",
  id: "AGENTS.md",
  originalText: "Original",
  text,
});
const signal = new AbortController().signal;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "modera-prompts-"));
  dirs.push(dir);
  const file = join(dir, "prompts.json");
  return { file, store: new PromptStore(file) };
}

describe("prompt overrides", () => {
  it("persists scoped overrides, inherits globally and restores inheritance", async () => {
    const { file, store } = await fixture();
    await store.save(0, [edit("Global")], signal);
    expect(await store.effective("one")).toEqual([edit("Global")]);
    await store.save(1, [edit("Project")], signal, "one");
    expect(await new PromptStore(file).effective("one")).toEqual([
      edit("Project"),
    ]);
    expect(await store.effective("two")).toEqual([edit("Global")]);
    await store.save(2, [], signal, "one");
    expect(await store.effective("one")).toEqual([edit("Global")]);
  });

  it("rejects concurrent stale writes without overwriting the saved value", async () => {
    const { store } = await fixture();
    const results = await Promise.allSettled([
      store.save(0, [edit("First")], signal),
      store.save(0, [edit("Second")], signal, "one"),
    ]);
    expect(results.map((item) => item.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(await store.effective("one")).toEqual([edit("First")]);
  });

  it("rejects invalid data, cancelled writes and corrupt stores", async () => {
    const { file, store } = await fixture();
    expect(() => validateEdits([edit("one"), edit("two")])).toThrow();
    expect(() =>
      validateEdits([{ ...edit("one"), disabled: "yes" }]),
    ).toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      store.save(0, [edit("one")], controller.signal),
    ).rejects.toThrow();
    expect((await store.read()).revision).toBe(0);
    await writeFile(file, "broken", "utf8");
    await expect(store.read()).rejects.toThrow();
  });
});
