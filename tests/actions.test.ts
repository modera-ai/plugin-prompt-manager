import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext, PromptDocumentBlock } from "@modera/plugin-sdk";
import { activate } from "../src/index";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

it("binds settings scope to the host and refuses unknown or changed source edits before persistence", async () => {
  const storagePath = await mkdtemp(join(tmpdir(), "modera-prompt-actions-"));
  dirs.push(storagePath);
  const requests: (string | undefined)[] = [];
  const blocks: PromptDocumentBlock[] = [
    {
      owner: "instructions",
      id: "agents",
      source: "AGENTS.md",
      kind: "project",
      text: "Original",
    },
  ];
  const plugin = (await activate({
    storagePath,
    promptDocuments: {
      inspect: async (request) => {
        requests.push(request.projectId);
        return blocks;
      },
    },
  } as unknown as PluginContext))!;
  const context = { projectId: "one", signal: new AbortController().signal };
  const action = (id: string, value: unknown) =>
    plugin.settings!.act({ id, value: JSON.stringify(value) }, context);
  const initial = (await action("read", {
    scope: "project",
    projectId: "other",
  })) as { revision: number };
  expect(requests).toEqual(["one"]);
  const edit = {
    owner: "instructions",
    id: "agents",
    originalText: "Original",
    text: "Edited",
  };
  await expect(
    action("save", {
      scope: "project",
      revision: initial.revision,
      edits: [{ ...edit, owner: "unknown" }],
    }),
  ).rejects.toThrow("no longer available");
  await expect(
    action("save", {
      scope: "project",
      revision: initial.revision,
      edits: [{ ...edit, originalText: "Old original" }],
    }),
  ).rejects.toThrow("SOURCE_CHANGED");
  expect(await plugin.promptEditor!.edits(context)).toEqual([]);
  await action("save", {
    scope: "project",
    revision: initial.revision,
    edits: [edit],
  });
  expect(await plugin.promptEditor!.edits(context)).toEqual([edit]);
  await expect(
    action("save", { scope: "project", revision: initial.revision, edits: [] }),
  ).rejects.toThrow("REVISION_CONFLICT");
  expect(await plugin.promptEditor!.edits({ signal: context.signal })).toEqual(
    [],
  );
});
