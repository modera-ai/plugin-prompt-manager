import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { promptBlockKey, type PromptDocumentEdit } from "@modera/plugin-sdk";

export interface PromptScopeState {
  revision: number;
  edits: PromptDocumentEdit[];
}
interface StoreData {
  version: 1;
  revision: number;
  scopes: Record<string, PromptDocumentEdit[]>;
}
const scopeKey = (projectId?: string) =>
  projectId ? `project:${projectId}` : "global";

export function validateEdits(value: unknown): PromptDocumentEdit[] {
  if (!Array.isArray(value) || value.length > 80)
    throw new Error("Invalid prompt edits");
  const seen = new Set<string>();
  let size = 0;
  let textSize = 0;
  return value.map((item) => {
    if (
      !item ||
      typeof item.owner !== "string" ||
      !item.owner ||
      item.owner.length > 200 ||
      typeof item.id !== "string" ||
      !item.id ||
      item.id.length > 200 ||
      typeof item.originalText !== "string" ||
      item.originalText.length > 32_000 ||
      typeof item.text !== "string" ||
      item.text.length > 32_000 ||
      (item.disabled !== undefined && typeof item.disabled !== "boolean")
    )
      throw new Error("Invalid prompt edit");
    size += item.text.length + item.originalText.length;
    textSize += item.text.length;
    const key = promptBlockKey(item);
    if (seen.has(key) || size > 128_000 || textSize > 64_000)
      throw new Error("Prompt edits exceed limits");
    seen.add(key);
    return {
      owner: item.owner,
      id: item.id,
      originalText: item.originalText,
      text: item.text,
      ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
    };
  });
}

/** One serialized file and a shared revision prevent global/project lost updates. */
export class PromptStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}

  private async load(): Promise<StoreData> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, revision: 0, scopes: {} };
      throw error;
    }
    if (raw.length > 8_000_000) throw new Error("Prompt store too large");
    const data = JSON.parse(raw) as StoreData;
    if (
      data.version !== 1 ||
      !Number.isSafeInteger(data.revision) ||
      data.revision < 0 ||
      !data.scopes ||
      typeof data.scopes !== "object" ||
      Array.isArray(data.scopes) ||
      Object.keys(data.scopes).length > 256
    )
      throw new Error("Invalid prompt store");
    for (const [key, edits] of Object.entries(data.scopes)) {
      if (key !== "global" && !key.startsWith("project:"))
        throw new Error("Invalid prompt scope");
      data.scopes[key] = validateEdits(edits);
    }
    return data;
  }

  async read(
    projectId?: string,
  ): Promise<PromptScopeState & { inherited: PromptDocumentEdit[] }> {
    await this.queue;
    const data = await this.load();
    return {
      revision: data.revision,
      edits: data.scopes[scopeKey(projectId)] ?? [],
      inherited: projectId ? (data.scopes.global ?? []) : [],
    };
  }

  async effective(projectId?: string): Promise<PromptDocumentEdit[]> {
    const state = await this.read(projectId);
    const map = new Map(
      state.inherited.map((edit) => [promptBlockKey(edit), edit]),
    );
    for (const edit of state.edits) map.set(promptBlockKey(edit), edit);
    return [...map.values()];
  }

  save(
    revision: number,
    edits: unknown,
    signal: AbortSignal,
    projectId?: string,
  ): Promise<void> {
    const validated = validateEdits(edits);
    const work = this.queue.then(async () => {
      signal.throwIfAborted();
      const data = await this.load();
      if (data.revision !== revision)
        throw new Error(
          "PROMPT_REVISION_CONFLICT: 提示词已在其他窗口修改，请重新加载后再保存。",
        );
      data.scopes[scopeKey(projectId)] = validated;
      if (!validated.length) delete data.scopes[scopeKey(projectId)];
      if (Object.keys(data.scopes).length > 256)
        throw new Error("Too many prompt scopes");
      data.revision++;
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(data), "utf8");
        signal.throwIfAborted();
        await rename(temp, this.file);
      } finally {
        await unlink(temp).catch(() => {});
      }
    });
    this.queue = work.catch(() => {});
    return work;
  }
}
