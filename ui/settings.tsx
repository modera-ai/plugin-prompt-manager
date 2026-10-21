import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChatIcon as MessageSquare } from "@phosphor-icons/react/dist/csr/Chat";
import { ArrowCounterClockwiseIcon as RotateCcw } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { XIcon as X } from "@phosphor-icons/react/dist/csr/X";
import { CaretDownIcon as ChevronDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon as Check } from "@phosphor-icons/react/dist/csr/Check";
import { EyeIcon as Eye } from "@phosphor-icons/react/dist/csr/Eye";
import { ArrowsClockwiseIcon as RefreshCw } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { PencilIcon as Pencil } from "@phosphor-icons/react/dist/csr/Pencil";

import {
  mountPlugin,
  frontend,
  usePluginSnapshot,
} from "@pal/plugin-sdk/react";
import {
  promptBlockKey,
  serializePromptDocument,
  PROMPT_GUIDANCE_HEADING,
  PROMPT_PROJECT_HEADING,
  type PromptDocumentBlock,
  type PromptDocumentEdit,
} from "@pal/contracts";

import { Button, Select, UiProvider } from "@pal/ui";
import { SettingsPage } from "@pal/ui/settings";
import "@pal/ui/styles.css";
import "./settings.css";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface DocumentState {
  revision: number;
  edits: PromptDocumentEdit[];
  inherited: PromptDocumentEdit[];
  blocks: PromptDocumentBlock[];
  projectId: string | null;
}
type Scope = "global" | "project";

const highlights = (CSS as unknown as { highlights?: Map<string, unknown> })
  .highlights;
function highlightParagraph(element: HTMLElement, x?: number, y?: number) {
  const caret =
    x === undefined || y === undefined
      ? null
      : document.caretRangeFromPoint(x, y);
  highlights?.delete("prompt-source");
  const node = caret?.startContainer;
  const target = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const paragraph =
    target instanceof Element
      ? target.closest("p, li, h1, h2, h3, h4, h5, h6, pre, td, th")
      : element.querySelector("p, li, h1, h2, h3, pre");
  if (!paragraph || !element.contains(paragraph)) return;
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  const Highlight = (
    window as unknown as { Highlight?: new (range: Range) => unknown }
  ).Highlight;
  if (Highlight && highlights)
    highlights.set("prompt-source", new Highlight(range));
}

function DocumentText({
  value,
  label,
  onChange,
  onSelect,
  disabled,
  editing,
  onEditing,
  zh,
}: {
  value: string;
  label: string;
  onChange(value: string): void;
  onSelect(y: number): void;
  disabled: boolean;
  editing: boolean;
  onEditing(value: boolean): void;
  zh: boolean;
}) {
  const editor = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!editing || !editor.current) return;
    editor.current.style.height = "0px";
    editor.current.style.height = `${editor.current.scrollHeight}px`;
  }, [value, editing]);
  useEffect(() => {
    if (editing) editor.current?.focus();
  }, [editing]);
  if (editing)
    return (
      <div className="prompt-inline-editor">
        <div className="prompt-editor-toolbar">
          <span>Markdown</span>
          <Button disabled={disabled} onClick={() => onEditing(false)}>
            <Check size={14} />
            {zh ? "完成编辑" : "Done editing"}
          </Button>
        </div>
        <textarea
          ref={editor}
          className="mu-input mu-textarea prompt-markdown-input"
          aria-label={label}
          value={value}
          readOnly={disabled}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          onFocus={(event) =>
            onSelect(event.currentTarget.getBoundingClientRect().top + 24)
          }
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              onEditing(false);
            }
          }}
        />
      </div>
    );
  return (
    <div
      className="prompt-text prompt-markdown"
      tabIndex={0}
      role="group"
      aria-label={label}
      onClick={(event) => {
        // Links are prompt content: selecting them opens provenance, not navigation.
        event.preventDefault();
        highlightParagraph(event.currentTarget, event.clientX, event.clientY);
        onSelect(event.clientY);
      }}
      onDoubleClick={() => {
        if (!disabled) onEditing(true);
      }}
      onFocus={(event) =>
        onSelect(event.currentTarget.getBoundingClientRect().top + 24)
      }
      onKeyDown={(event) => {
        if (event.key === "Enter" && !disabled) {
          event.preventDefault();
          onEditing(true);
        }
      }}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ alt }) => (
            <span className="prompt-image-label">
              {alt || (zh ? "图片" : "Image")}
            </span>
          ),
        }}
      >
        {value ||
          (zh ? "空片段 · 双击编辑" : "Empty section · double-click to edit")}
      </Markdown>
    </div>
  );
}

function PromptSettings() {
  const { snapshot, error: snapshotError } = usePluginSnapshot();
  const zh = snapshot?.locale.startsWith("zh") ?? true;
  const pluginNames = (
    snapshot?.view.data as { pluginNames?: Record<string, string> } | undefined
  )?.pluginNames;
  const pluginName = (owner: string) => pluginNames?.[owner] ?? owner;
  const t = (cn: string, en: string) => (zh ? cn : en);
  const [scope, setScope] = useState<Scope>("global");
  const [narrow, setNarrow] = useState(window.innerWidth < 1580);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1579px)");
    const resize = () => setNarrow(media.matches);
    resize();
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  const [state, setState] = useState<DocumentState>();
  const [edits, setEdits] = useState<PromptDocumentEdit[]>([]);
  const [activeKey, setActiveKey] = useState<string>();
  const [annotationTop, setAnnotationTop] = useState(24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [showOriginal, setShowOriginal] = useState(false);
  const [preview, setPreview] = useState(false);
  const [editingKey, setEditingKey] = useState<string>();
  const [pending, setPending] = useState<Scope | "reload">();
  const workspace = useRef<HTMLDivElement>(null);
  const annotation = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const requestVersion = useRef(0);
  const dirty =
    !!state && JSON.stringify(state.edits) !== JSON.stringify(edits);
  const projectId = (
    snapshot?.view.data as { projectId?: string | null } | undefined
  )?.projectId;
  const inherited = new Map(
    state?.inherited.map((edit) => [promptBlockKey(edit), edit]) ?? [],
  );
  const current = new Map(edits.map((edit) => [promptBlockKey(edit), edit]));
  const effective = new Map([...inherited, ...current]);
  const active = state?.blocks.find(
    (block) => promptBlockKey(block) === activeKey,
  );
  const activeEdit = activeKey ? effective.get(activeKey) : undefined;
  const sourceChanged =
    !!active && !!activeEdit && activeEdit.originalText !== active.text;
  const effectiveBlocks =
    state?.blocks.map((block) => {
      const edit = effective.get(promptBlockKey(block));
      return {
        ...block,
        text: edit?.disabled ? "" : (edit?.text ?? block.text),
      };
    }) ?? [];
  const finalText = serializePromptDocument(effectiveBlocks);
  const changes = edits.length;

  useEffect(() => {
    if (!activeKey || preview) highlights?.delete("prompt-source");
  }, [activeKey, preview]);

  useEffect(() => {
    if (!pending || !dialog.current) return;
    const previous = document.activeElement as HTMLElement | null;
    const buttons = [
      ...dialog.current.querySelectorAll<HTMLButtonElement>("button"),
    ];
    buttons[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const index = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const next =
        (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      event.preventDefault();
      buttons[next]?.focus();
    };
    dialog.current.addEventListener("keydown", trap);
    return () => {
      dialog.current?.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [pending]);

  useLayoutEffect(() => {
    if (!active || !workspace.current || !annotation.current) return;
    const maxTop = Math.max(
      20,
      workspace.current.offsetHeight - annotation.current.offsetHeight - 32,
    );
    if (annotationTop > maxTop) setAnnotationTop(maxTop);
  }, [activeKey, edits, showOriginal, annotationTop, preview]);

  async function load(target = scope) {
    const version = ++requestVersion.current;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = (await frontend().command.execute(
        "pal.prompt-manager.read",
        { scope: target },
      )) as DocumentState;
      if (version !== requestVersion.current) return;
      setState(next);
      setEdits(next.edits);
      setScope(target);
      setActiveKey(undefined);
      setShowOriginal(false);
      setEditingKey(undefined);
    } catch (cause) {
      if (version === requestVersion.current) setError(String(cause));
    } finally {
      if (version === requestVersion.current) {
        setBusy(false);
        void frontend().ready();
      }
    }
  }

  useEffect(() => {
    if (!snapshot) return;
    void load(scope === "project" && !projectId ? "global" : scope);
    return () => {
      requestVersion.current++;
    };
  }, [projectId, !!snapshot]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty && !busy) void save();
      }
      if (event.key === "Escape") {
        setActiveKey(undefined);
        setPreview(false);
        setPending(undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function save() {
    if (!state || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = (await frontend().command.execute(
        "pal.prompt-manager.save",
        { scope, revision: state.revision, edits },
      )) as DocumentState;
      setState(next);
      setEdits(next.edits);
      setMessage(
        t("已保存，下次模型请求生效", "Saved for the next model request"),
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  function update(block: PromptDocumentBlock, text: string, disabled = false) {
    const key = promptBlockKey(block);
    if (disabled) setEditingKey(undefined);
    setMessage("");
    setEdits((previous) => {
      const rest = previous.filter((edit) => promptBlockKey(edit) !== key);
      const inheritedEdit = inherited.get(key);
      if (
        text === (inheritedEdit?.text ?? block.text) &&
        disabled === (inheritedEdit?.disabled ?? false) &&
        (!inheritedEdit || inheritedEdit.originalText === block.text)
      )
        return rest;
      return [
        ...rest,
        {
          owner: block.owner,
          id: block.id,
          originalText: block.text,
          text,
          disabled,
        },
      ];
    });
  }

  function select(block: PromptDocumentBlock, y: number) {
    if (preview) return;
    const key = promptBlockKey(block);
    if (key !== activeKey) setShowOriginal(false);
    setActiveKey(key);
    const rect = workspace.current?.getBoundingClientRect();
    setAnnotationTop(Math.max(20, y - (rect?.top ?? 0) - 32));
  }

  function navigate(target: Scope | "reload") {
    if (busy || target === scope) return;
    if (dirty) setPending(target);
    else void load(target === "reload" ? scope : target);
  }

  const annotationView = active && !preview && (
    <aside
      ref={annotation}
      className="prompt-annotation"
      style={{ top: annotationTop }}
      aria-label={t("提示词来源批注", "Prompt source annotation")}
    >
      <div className="annotation-heading">
        <div className="annotation-icon">
          <MessageSquare size={17} />
        </div>
        <div>
          <Button
            className="annotation-plugin-link"
            title={active.owner}
            onClick={() =>
              void frontend()
                .openSettings(`plugin-details:${active.owner}`)
                .catch((cause) => setError(String(cause)))
            }
          >
            {pluginName(active.owner)} <ChevronDown size={12} />
          </Button>
          <small>{t("提示词来源", "Prompt source")}</small>
        </div>
        <Button
          aria-label={t("关闭批注", "Close annotation")}
          onClick={() => setActiveKey(undefined)}
        >
          <X size={16} />
        </Button>
      </div>
      <dl>
        <dt>{t("来源", "Source")}</dt>
        <dd>
          {active.source ?? t("Agent 基础系统提示词", "Agent base policy")}
        </dd>
        <dt>{t("片段", "Section")}</dt>
        <dd>{active.id}</dd>
      </dl>
      <div className="annotation-note">
        <span className={activeEdit ? "modified-dot" : "original-dot"} />
        {activeEdit
          ? t("已由你调整", "Edited by you")
          : t("插件原文", "Original plugin text")}
        {activeEdit && !current.has(activeKey!) && (
          <small>{t("继承全局", "Inherited globally")}</small>
        )}
      </div>
      {sourceChanged && (
        <p className="annotation-warning">
          {t(
            "插件原文已变化。重新确认后，才能保存这份覆盖。",
            "The source changed. Review it before saving this override.",
          )}
          <Button
            onClick={() =>
              update(active, activeEdit!.text, activeEdit!.disabled)
            }
          >
            {t("保留修改，确认新原文", "Keep edits and acknowledge source")}
          </Button>
        </p>
      )}
      <div className="annotation-actions">
        <Button
          disabled={busy || !!activeEdit?.disabled}
          onClick={() => setEditingKey(activeKey)}
        >
          <Pencil size={13} />
          {t("编辑", "Edit")}
        </Button>
        <Button
          aria-expanded={showOriginal}
          onClick={() => setShowOriginal(!showOriginal)}
        >
          {showOriginal
            ? t("收起原文", "Hide original")
            : t("查看原文", "View original")}
        </Button>
        <Button
          disabled={busy || !current.has(activeKey!)}
          title={t(
            "撤销当前范围的调整，恢复继承",
            "Remove this scope's override",
          )}
          onClick={() => {
            setEdits((previous) =>
              previous.filter((edit) => promptBlockKey(edit) !== activeKey),
            );
            setMessage("");
          }}
        >
          <RotateCcw size={13} />
          {t("恢复", "Restore")}
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            update(
              active,
              activeEdit?.text ?? active.text,
              !activeEdit?.disabled,
            )
          }
        >
          {activeEdit?.disabled ? t("启用", "Enable") : t("停用", "Disable")}
        </Button>
      </div>
      {showOriginal && <pre className="annotation-original">{active.text}</pre>}
    </aside>
  );

  return (
    <UiProvider
      theme={snapshot?.theme?.mode ?? "system"}
      locale={zh ? "zh-CN" : "en"}
      className="prompt-settings-ui mu-settings-codex"
    >
      <SettingsPage
        className="prompt-page"
        title={t("系统提示词", "System prompt")}
        description={t(
          "编辑提示词文档，查看并管理各插件提供的内容。",
          "Edit the prompt document and manage content from each plugin.",
        )}
      >
        <header className="prompt-header">
          <div className="prompt-controls">
            <Button
              variant="quiet"
              className="prompt-preview"
              disabled={!state}
              aria-pressed={preview}
              onClick={() => {
                setPreview(!preview);
                setEditingKey(undefined);
                setActiveKey(undefined);
              }}
            >
              <Eye size={15} weight={preview ? "fill" : "regular"} />
              {preview
                ? t("返回编辑", "Back to editing")
                : t("纯文本预览", "Plain text preview")}
            </Button>

            <span className="prompt-scope-control">
              <Select
                label={t("保存范围", "Scope")}
                className="prompt-scope-select"
                value={scope}
                disabled={busy}
                onValueChange={(value) => navigate(value as Scope)}
                options={[
                  { value: "global", label: t("全局", "Global") },
                  {
                    value: "project",
                    label: t("当前项目", "Current project"),
                    disabled: !projectId,
                  },
                ]}
              />
            </span>

            <Button
              disabled={busy || !state}
              variant="outline"
              size="icon"
              title={t("重新读取插件原文", "Reload source text")}
              aria-label={t("重新加载", "Reload")}
              onClick={() => navigate("reload")}
            >
              <RefreshCw size={16} />
            </Button>
            <Button
              variant="primary"
              className="prompt-save"
              disabled={!dirty || busy}
              onClick={() => void save()}
            >
              {busy ? t("处理中…", "Working…") : t("保存", "Save")}
            </Button>
          </div>
        </header>
        <div className="prompt-document-caption">
          <span>{t("Markdown 文档", "Markdown document")}</span>
          <span>
            {t(
              "单击查看来源 · 双击编辑",
              "Click for source · double-click to edit",
            )}
          </span>
        </div>
        {(error || snapshotError) && (
          <div className="prompt-status" role="alert">
            {error || snapshotError}
            <Button onClick={() => navigate("reload")}>
              {t("重新加载", "Reload")}
            </Button>
          </div>
        )}
        {!state ? (
          <div className="prompt-empty">
            {busy
              ? t("正在读取提示词…", "Loading prompt…")
              : t(
                  "暂时无法读取提示词，请重新加载。",
                  "Unable to load the prompt. Please retry.",
                )}
          </div>
        ) : (
          <div
            className={`prompt-workspace ${active ? "has-annotation" : ""}`}
            ref={workspace}
          >
            <article
              className="prompt-document"
              aria-label={t("系统提示词文档", "System prompt document")}
            >
              {preview ? (
                <pre className="prompt-final">{finalText}</pre>
              ) : (
                state.blocks.map((block, index) => {
                  const key = promptBlockKey(block),
                    edit = effective.get(key);
                  const value = edit?.text ?? block.text;
                  const firstOfKind =
                    index ===
                    state.blocks.findIndex((item) => item.kind === block.kind);
                  return (
                    <section
                      className={`prompt-range ${activeKey === key ? "selected" : ""} ${edit?.disabled ? "disabled" : ""}`}
                      key={key}
                      data-source-key={key}
                    >
                      {firstOfKind && block.kind !== "base" && (
                        <p className="prompt-group-heading">
                          {block.kind === "guidance"
                            ? PROMPT_GUIDANCE_HEADING
                            : PROMPT_PROJECT_HEADING}
                        </p>
                      )}
                      {edit?.disabled ? (
                        <details
                          className="prompt-fold"
                          key={`disabled-${key}`}
                        >
                          <summary
                            onClick={(event) => select(block, event.clientY)}
                          >
                            <ChevronDown size={15} />
                            <span>
                              {block.source ?? pluginName(block.owner)}
                            </span>
                            <small>{t("已停用", "Disabled")}</small>
                          </summary>
                          <div className="prompt-fold-content">
                            <DocumentText
                              value={value}
                              label={`${t("停用的提示词", "Disabled prompt")}: ${block.source ?? block.owner}`}
                              disabled
                              editing={false}
                              onEditing={() => {}}
                              zh={zh}
                              onChange={() => {}}
                              onSelect={(y) => select(block, y)}
                            />
                          </div>
                        </details>
                      ) : (
                        <DocumentText
                          value={value}
                          label={`${t("编辑提示词", "Edit prompt")}: ${block.source ?? block.owner}`}
                          disabled={busy}
                          editing={editingKey === key}
                          zh={zh}
                          onEditing={(editing) =>
                            setEditingKey(editing ? key : undefined)
                          }
                          onChange={(text) => update(block, text)}
                          onSelect={(y) => select(block, y)}
                        />
                      )}
                      <Button
                        className="prompt-comment-marker"
                        aria-label={t("查看来源批注", "Show source annotation")}
                        title={t("查看来源", "Show source")}
                        onClick={(event) => select(block, event.clientY)}
                      >
                        <MessageSquare size={15} />
                        {edit && <span />}
                      </Button>
                      {narrow && activeKey === key && annotationView}
                    </section>
                  );
                })
              )}
              {!state.blocks.length && (
                <p>
                  {t(
                    "当前没有可用的提示词。",
                    "No prompt sources are available.",
                  )}
                </p>
              )}
              <div className="prompt-document-end" aria-hidden="true" />
            </article>
            {!narrow && annotationView}
          </div>
        )}
        <footer className="prompt-footer">
          <span>
            {finalText.length.toLocaleString()} {t("字符", "characters")}
            <span className="footer-dot">·</span>
            {state?.blocks.length ?? 0} {t("个来源片段", "source sections")}
            {changes > 0 && (
              <>
                <span className="footer-dot">·</span>
                {changes} {t("处覆盖", "overrides")}
              </>
            )}
          </span>
          <span
            className="prompt-save-status"
            aria-live="polite"
            role="status"
            title={t(
              "工作区预览；实际请求随会话、工具和运行模式变化",
              "Workspace preview; requests vary by session, tools and mode",
            )}
          >
            {dirty ? t("未保存", "Unsaved") : <Check size={12} />}
            {!dirty && (message || t("原文已保留", "Sources preserved"))}
          </span>
        </footer>
        {pending && (
          <div className="prompt-dialog-backdrop">
            <div
              ref={dialog}
              className="prompt-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="discard-title"
            >
              <h2 id="discard-title">
                {t("保留这次修改？", "Keep your edits?")}
              </h2>
              <p>
                {t(
                  "切换范围或重新加载会替换当前文档。你可以先保存，或放弃尚未保存的修改。",
                  "Switching scope or reloading replaces the document. Save first or discard unsaved edits.",
                )}
              </p>
              <div>
                <Button onClick={() => setPending(undefined)}>
                  {t("继续编辑", "Keep editing")}
                </Button>
                <Button
                  onClick={() => {
                    const target = pending;
                    setPending(undefined);
                    void load(target === "reload" ? scope : target);
                  }}
                >
                  {t("放弃修改", "Discard")}
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    setPending(undefined);
                    void save();
                  }}
                >
                  {t("保存", "Save")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </SettingsPage>
    </UiProvider>
  );
}

mountPlugin(<PromptSettings />);
