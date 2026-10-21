import { join } from "node:path";
import {
  definePlugin,
  promptBlockKey,
  type PluginModule,
} from "@pal/plugin-sdk";
import { PromptStore, validateEdits } from "./store";
import manifest from "../pal-manifest.json";

export const activate: PluginModule["activate"] = async (host) => {
  if (!host.promptDocuments)
    throw new Error("Prompt document host is unavailable");
  const store = new PromptStore(join(host.storagePath, "prompt-edits.json"));
  const execute = async (
    operation: "read" | "save",
    input: Record<string, unknown>,
    context: import("@pal/plugin-sdk").ToolContext,
  ) => {
    if (input.scope !== "global" && input.scope !== "project")
      throw new Error("Invalid prompt scope");
    const projectId = input.scope === "project" ? context.projectId : undefined;
    if (input.scope === "project" && !projectId)
      throw new Error("Select a project first");
    const request = {
      ...(projectId ? { projectId } : {}),
      signal: context.signal,
    };
    if (operation === "save") {
      if (!Number.isSafeInteger(input.revision))
        throw new Error("Invalid prompt revision");
      const edits = validateEdits(input.edits);
      const existing = await store.read(projectId);
      const blocks = await host.promptDocuments!.inspect(request);
      const known = new Map(
        blocks.map((block) => [promptBlockKey(block), block]),
      );
      const previous = new Map(
        existing.edits.map((edit) => [promptBlockKey(edit), edit]),
      );
      const merged = new Map(
        existing.inherited.map((edit) => [promptBlockKey(edit), edit]),
      );
      for (const edit of edits) merged.set(promptBlockKey(edit), edit);
      validateEdits([...merged.values()]);
      // Stay below the host's bounded settings response before committing.
      if (JSON.stringify({ ...existing, edits, blocks }).length > 90_000)
        throw new Error("提示词覆盖过长，请减少修改文本后再保存。");
      for (const edit of edits) {
        const source = known.get(promptBlockKey(edit));
        if (!source || source.kind === "runtime") {
          if (
            JSON.stringify(previous.get(promptBlockKey(edit))) !==
            JSON.stringify(edit)
          )
            throw new Error(
              "Prompt source is no longer available; reload before saving",
            );
        } else if (source.text !== edit.originalText) {
          throw new Error(
            "PROMPT_SOURCE_CHANGED: 插件原文已变化，请重新加载后再保存。",
          );
        }
      }
      await store.save(
        input.revision as number,
        edits,
        context.signal,
        projectId,
      );
    }
    const [state, blocks] = await Promise.all([
      store.read(projectId),
      host.promptDocuments!.inspect(request),
    ]);
    context.signal.throwIfAborted();
    return { ...state, blocks, projectId: context.projectId ?? null };
  };
  const registered = await definePlugin((pal) => {
    for (const declaration of manifest.declarations.provides.commands)
      pal.command.register({
        ...declaration,
        visibility: "private",
        run: (input, execution) =>
          execute(
            declaration.id.endsWith(".save") ? "save" : "read",
            input as Record<string, unknown>,
            execution.context,
          ),
      });
  }).activate(host);
  return {
    ...registered,
    promptEditor: {
      async edits(request) {
        request.signal.throwIfAborted();
        const edits = await store.effective(request.projectId);
        request.signal.throwIfAborted();
        return edits;
      },
    },
    settings: {
      commands: manifest.declarations.provides.commands.map((item) => item.id),
    },
  };
};
