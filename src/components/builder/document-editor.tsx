"use client";

import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  Copy,
  Plus,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { PricingTableEditor } from "@/components/builder/pricing-table-editor";
import { SendForSignatureDialog } from "@/components/builder/send-for-signature-dialog";
import { ShellButton } from "@/components/shared/form-shell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  builderContentSchema,
  builderTitleSchema,
  collectVariableUsage,
  findSendProblems,
  MAX_BUILDER_BLOCKS,
  MAX_BUILDER_ROLES,
  MAX_BUILDER_VARIABLES,
  MAX_PARAGRAPH_LENGTH,
  newBuilderId,
  pageSizes,
  VARIABLE_KEY_PATTERN,
  type BuilderBlock,
  type BuilderContent,
  type BuilderRole,
  type InlineFieldType,
} from "@/lib/document-builder/model";
import type { BuilderDocument } from "@/lib/document-builder/store";

type BlockType = BuilderBlock["type"];
type SaveStatus =
  "conflict" | "dirty" | "error" | "invalid" | "saved" | "saving";

const blockTypeLabels: Record<BlockType, string> = {
  divider: "Divider",
  field: "Form field",
  heading: "Heading",
  list: "List",
  pageBreak: "Page break",
  paragraph: "Text",
  pricing: "Pricing table",
  signature: "Signature block",
};

const addableBlocks: BlockType[] = [
  "heading",
  "paragraph",
  "list",
  "pricing",
  "signature",
  "field",
  "divider",
  "pageBreak",
];

const inlineFieldLabels: Record<InlineFieldType, string> = {
  checkbox: "Checkbox",
  date: "Date signed",
  initials: "Initials",
  number: "Number",
  text: "Text",
};

function newBlock(type: BlockType, content: BuilderContent): BuilderBlock {
  const id = newBuilderId("b");
  const signedRoles = new Set(
    content.blocks.flatMap((block) =>
      block.type === "signature" ? [block.roleId] : [],
    ),
  );
  const nextRole =
    content.roles.find((role) => !signedRoles.has(role.id)) ??
    content.roles[0]!;

  switch (type) {
    case "heading":
      return { id, level: 2, text: "", type };
    case "paragraph":
      return { id, text: "", type };
    case "list":
      return { id, items: [""], style: "bullet", type };
    case "pricing":
      return {
        currency: "USD",
        id,
        rows: [
          {
            description: "",
            discountPercent: 0,
            id: newBuilderId("r"),
            quantity: 1,
            unitPriceCents: 0,
          },
        ],
        taxLabel: "Tax",
        taxPercent: 0,
        type,
      };
    case "signature":
      return { id, roleId: nextRole.id, type };
    case "field":
      return {
        fieldType: "text",
        id,
        label: "",
        required: true,
        roleId: content.roles[0]!.id,
        type,
      };
    case "divider":
      return { id, type };
    case "pageBreak":
      return { id, type };
  }
}

function cloneBlock(block: BuilderBlock): BuilderBlock {
  const copy = structuredClone(block);

  copy.id = newBuilderId("b");

  if (copy.type === "pricing") {
    copy.rows = copy.rows.map((row) => ({ ...row, id: newBuilderId("r") }));
  }

  return copy;
}

/** Wraps the selection in **…** for Ctrl/Cmd+B in a text box. */
function handleBoldShortcut(
  event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
) {
  if (event.key.toLowerCase() !== "b" || !(event.metaKey || event.ctrlKey)) {
    return;
  }

  event.preventDefault();

  const element = event.currentTarget;
  const start = element.selectionStart ?? 0;
  const end = element.selectionEnd ?? start;
  const selected = element.value.slice(start, end);

  document.execCommand("insertText", false, `**${selected}**`);
  if (!selected) {
    element.setSelectionRange(start + 2, start + 2);
  }
}

const saveStatusLabels: Record<SaveStatus, string> = {
  conflict: "Changed elsewhere",
  dirty: "Unsaved changes",
  error: "Not saved",
  invalid: "Not saved",
  saved: "Saved",
  saving: "Saving…",
};

export function DocumentEditor({
  currentUser,
  document,
}: {
  currentUser: { email: string; name: string };
  document: BuilderDocument;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(document.title);
  const [content, setContent] = useState<BuilderContent>(document.content);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSendOpen, setIsSendOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const revisionRef = useRef(document.revision);
  const latestRef = useRef({ content, title });
  const savingRef = useRef(false);
  const queuedRef = useRef(false);
  const hasEditedRef = useRef(false);
  const lastFocusedRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(
    null,
  );
  const saveRef = useRef<() => Promise<boolean>>(async () => true);

  const save = useCallback(async (): Promise<boolean> => {
    if (savingRef.current) {
      queuedRef.current = true;

      return false;
    }

    const snapshot = latestRef.current;
    const parsedTitle = builderTitleSchema.safeParse(snapshot.title);
    const parsedContent = builderContentSchema.safeParse(snapshot.content);

    if (!parsedTitle.success || !parsedContent.success) {
      setStatus("invalid");
      setStatusMessage(
        (parsedTitle.success ? null : parsedTitle.error.issues[0]?.message) ??
          (parsedContent.success
            ? null
            : parsedContent.error.issues[0]?.message) ??
          "Something in this document needs fixing before it can be saved.",
      );

      return false;
    }

    savingRef.current = true;
    setStatus("saving");

    try {
      const response = await fetch(`/api/builder/documents/${document.id}`, {
        body: JSON.stringify({
          content: parsedContent.data,
          expectedRevision: revisionRef.current,
          title: parsedTitle.data,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        revision?: number;
      } | null;

      if (response.status === 409) {
        setStatus("conflict");
        setStatusMessage(payload?.error ?? null);

        return false;
      }

      if (!response.ok || typeof payload?.revision !== "number") {
        setStatus("error");
        setStatusMessage(payload?.error ?? "The last change was not saved.");

        return false;
      }

      revisionRef.current = payload.revision;

      if (latestRef.current !== snapshot) {
        queuedRef.current = true;
      }

      setStatus(queuedRef.current ? "dirty" : "saved");
      setStatusMessage(null);

      return !queuedRef.current;
    } catch {
      setStatus("error");
      setStatusMessage("The last change was not saved. Check your connection.");

      return false;
    } finally {
      savingRef.current = false;

      if (queuedRef.current) {
        queuedRef.current = false;
        void saveRef.current();
      }
    }
  }, [document.id]);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    latestRef.current = { content, title };

    if (!hasEditedRef.current) {
      return;
    }

    setStatus("dirty");

    const timer = setTimeout(() => {
      void saveRef.current();
    }, 900);

    return () => clearTimeout(timer);
  }, [content, title]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (status !== "saved") {
        event.preventDefault();
      }
    };

    window.addEventListener("beforeunload", warn);

    return () => window.removeEventListener("beforeunload", warn);
  }, [status]);

  const edit = useCallback(
    (updater: (current: BuilderContent) => BuilderContent) => {
      hasEditedRef.current = true;
      setContent(updater);
    },
    [],
  );

  const updateBlock = (next: BuilderBlock) =>
    edit((current) => ({
      ...current,
      blocks: current.blocks.map((block) =>
        block.id === next.id ? next : block,
      ),
    }));

  const insertBlock = (type: BlockType, index: number) =>
    edit((current) => {
      const blocks = [...current.blocks];

      blocks.splice(index, 0, newBlock(type, current));

      return { ...current, blocks };
    });

  const moveBlock = (id: string, delta: -1 | 1) =>
    edit((current) => {
      const index = current.blocks.findIndex((block) => block.id === id);
      const target = index + delta;

      if (index < 0 || target < 0 || target >= current.blocks.length) {
        return current;
      }

      const blocks = [...current.blocks];
      const [moved] = blocks.splice(index, 1);

      blocks.splice(target, 0, moved!);

      return { ...current, blocks };
    });

  const usage = useMemo(() => collectVariableUsage(content), [content]);
  const problems = useMemo(() => findSendProblems(content), [content]);
  const rolesInUse = useMemo(
    () =>
      new Set(
        content.blocks.flatMap((block) =>
          block.type === "signature" || block.type === "field"
            ? [block.roleId]
            : [],
        ),
      ),
    [content.blocks],
  );

  async function flush(): Promise<boolean> {
    if (status === "saved" && !savingRef.current) {
      return true;
    }

    return saveRef.current();
  }

  async function openPreview() {
    const preview = window.open("", "_blank");

    await flush();

    const url = `/api/builder/documents/${document.id}/pdf?r=${String(revisionRef.current)}`;

    if (preview) {
      preview.location.href = url;
    } else {
      setNotice("Allow pop-ups for this site to open the preview.");
    }
  }

  async function copyDocument(asTemplate: boolean) {
    setBusyAction(asTemplate ? "template" : "use");
    setNotice(null);

    try {
      await flush();

      const response = await fetch("/api/builder/documents", {
        body: JSON.stringify({ asTemplate, sourceId: document.id }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        redirectPath?: string;
      } | null;

      if (!response.ok || !payload?.redirectPath) {
        setNotice(payload?.error ?? "That did not work. Try again.");

        return;
      }

      if (asTemplate) {
        setNotice("Saved to your templates.");
      } else {
        router.push(payload.redirectPath);
      }
    } finally {
      setBusyAction(null);
    }
  }

  function insertVariable(key: string) {
    const token = `{{${key}}}`;
    const target = lastFocusedRef.current;

    if (target && target.isConnected) {
      target.focus();
      if (document_execInsert(token)) {
        return;
      }
    }

    void navigator.clipboard?.writeText(token).then(
      () => setNotice(`Copied ${token}. Paste it where it belongs.`),
      () => setNotice(`Type ${token} where it belongs.`),
    );
  }

  return (
    <div className="space-y-5">
      <header className="panel flex flex-col gap-4 p-5 sm:p-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <Link
            className="inline-flex items-center gap-1 text-sm font-semibold text-(--secondary) hover:text-(--fg)"
            href="/builder"
          >
            <ChevronLeft aria-hidden="true" className="h-4 w-4" />
            All documents
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <input
              aria-label="Document title"
              className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1 text-2xl font-extrabold tracking-[-0.03em] text-(--fg) outline-none hover:border-(--border-strong) focus-visible:border-(--accent)"
              maxLength={160}
              onChange={(event) => {
                hasEditedRef.current = true;
                setTitle(event.target.value);
              }}
              value={title}
            />
            {document.isTemplate ? (
              <span className="pill pill-accent">Template</span>
            ) : null}
            <span
              aria-live="polite"
              className={`text-sm font-semibold ${
                status === "saved"
                  ? "text-(--tertiary)"
                  : status === "saving" || status === "dirty"
                    ? "text-(--secondary)"
                    : "text-(--danger)"
              }`}
            >
              {saveStatusLabels[status]}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <ShellButton
            className="min-h-11"
            onClick={() => void openPreview()}
            variant="secondary"
          >
            Preview PDF
          </ShellButton>
          {document.isTemplate ? (
            <ShellButton
              className="min-h-11"
              loading={busyAction === "use"}
              onClick={() => void copyDocument(false)}
            >
              Use template
            </ShellButton>
          ) : (
            <>
              <ShellButton
                className="min-h-11"
                loading={busyAction === "template"}
                onClick={() => void copyDocument(true)}
                variant="secondary"
              >
                Save as template
              </ShellButton>
              <ShellButton
                className="min-h-11"
                onClick={() => {
                  void flush();
                  setIsSendOpen(true);
                }}
              >
                Send for signature
              </ShellButton>
            </>
          )}
        </div>
      </header>

      {statusMessage && status !== "saved" ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-(--danger-soft) px-4 py-3 text-sm font-semibold text-(--danger)"
          role="alert"
        >
          <span>{statusMessage}</span>
          {status === "conflict" ? (
            <button
              className="btn-quiet"
              onClick={() => window.location.reload()}
              type="button"
            >
              Reload
            </button>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <p
          className="rounded-xl bg-(--accent-softer) px-4 py-3 text-sm font-semibold text-(--accent-ink)"
          role="status"
        >
          {notice}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section
          aria-label="Document content"
          className="panel min-w-0 p-4 sm:p-8"
          onFocusCapture={(event) => {
            const target = event.target;

            if (
              (target instanceof HTMLTextAreaElement ||
                target instanceof HTMLInputElement) &&
              target.dataset.variables === "true"
            ) {
              lastFocusedRef.current = target;
            }
          }}
        >
          {content.blocks.length === 0 ? (
            <div className="well space-y-3 p-6 text-center">
              <p className="font-extrabold text-(--fg)">
                This document is empty
              </p>
              <p className="text-sm leading-6 text-(--secondary)">
                Add a heading and some text, then a signature block for each
                person who signs.
              </p>
            </div>
          ) : (
            <ol className="space-y-2">
              {content.blocks.map((block, index) => (
                <li key={block.id}>
                  <BlockFrame
                    canAdd={content.blocks.length < MAX_BUILDER_BLOCKS}
                    isFirst={index === 0}
                    isLast={index === content.blocks.length - 1}
                    label={blockTypeLabels[block.type]}
                    onAddBelow={(type) => insertBlock(type, index + 1)}
                    onDuplicate={() =>
                      edit((current) => {
                        const blocks = [...current.blocks];

                        blocks.splice(index + 1, 0, cloneBlock(block));

                        return { ...current, blocks };
                      })
                    }
                    onMove={(delta) => moveBlock(block.id, delta)}
                    onRemove={() =>
                      edit((current) => ({
                        ...current,
                        blocks: current.blocks.filter(
                          (candidate) => candidate.id !== block.id,
                        ),
                      }))
                    }
                  >
                    <BlockEditor
                      block={block}
                      onChange={updateBlock}
                      roles={content.roles}
                    />
                  </BlockFrame>
                </li>
              ))}
            </ol>
          )}

          <div className="mt-6 border-t border-dashed border-(--border-strong) pt-5">
            <p className="section-eyebrow mb-3">Add to the end</p>
            <div className="flex flex-wrap gap-2">
              {addableBlocks.map((type) => (
                <button
                  className="btn-quiet"
                  disabled={content.blocks.length >= MAX_BUILDER_BLOCKS}
                  key={type}
                  onClick={() => insertBlock(type, content.blocks.length)}
                  type="button"
                >
                  <Plus aria-hidden="true" className="h-4 w-4" />
                  {blockTypeLabels[type]}
                </button>
              ))}
            </div>
          </div>
        </section>

        <aside className="min-w-0 space-y-5 lg:sticky lg:top-24 lg:self-start">
          <SidePanel title="Ready to send?">
            {problems.length === 0 ? (
              <p className="text-sm leading-6 text-(--success)">
                Every variable has a value and every signer has a signature
                block.
              </p>
            ) : (
              <ul className="space-y-2 text-sm leading-6 text-(--secondary)">
                {problems.map((problem) => (
                  <li className="flex gap-2" key={problem}>
                    <span
                      aria-hidden="true"
                      className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-(--warning)"
                    />
                    <span>{problem}</span>
                  </li>
                ))}
              </ul>
            )}
          </SidePanel>

          <SidePanel
            description="In signing order. Name the people when you send."
            title="Signers"
          >
            <ol className="space-y-2">
              {content.roles.map((role, index) => (
                <li className="flex items-center gap-2" key={role.id}>
                  <span className="w-5 text-right text-sm font-bold text-(--tertiary)">
                    {index + 1}
                  </span>
                  <input
                    aria-label={`Signer ${index + 1} role name`}
                    className="field-input min-h-10 flex-1"
                    maxLength={60}
                    onChange={(event) =>
                      edit((current) => ({
                        ...current,
                        roles: current.roles.map((candidate) =>
                          candidate.id === role.id
                            ? { ...candidate, name: event.target.value }
                            : candidate,
                        ),
                      }))
                    }
                    value={role.name}
                  />
                  <button
                    aria-label={`Remove the ${role.name} role`}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-(--tertiary) hover:bg-(--danger-soft) hover:text-(--danger) disabled:opacity-30"
                    disabled={
                      content.roles.length === 1 || rolesInUse.has(role.id)
                    }
                    onClick={() =>
                      edit((current) => ({
                        ...current,
                        roles: current.roles.filter(
                          (candidate) => candidate.id !== role.id,
                        ),
                      }))
                    }
                    title={
                      rolesInUse.has(role.id)
                        ? "Remove this role's signature blocks and fields first"
                        : undefined
                    }
                    type="button"
                  >
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ol>
            <button
              className="btn-quiet mt-3"
              disabled={content.roles.length >= MAX_BUILDER_ROLES}
              onClick={() =>
                edit((current) => ({
                  ...current,
                  roles: [
                    ...current.roles,
                    {
                      id: newBuilderId("role"),
                      name: `Signer ${current.roles.length + 1}`,
                    },
                  ],
                }))
              }
              type="button"
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add signer role
            </button>
          </SidePanel>

          <SidePanel
            description="Write {{name}} in any text. Click a name to insert it where you were typing."
            title="Variables"
          >
            <ul className="space-y-3">
              {content.variables.map((variable, index) => {
                const keyValid = VARIABLE_KEY_PATTERN.test(variable.key);

                return (
                  <li className="well space-y-2 p-3" key={index}>
                    <div className="flex items-center gap-2">
                      <button
                        className="truncate rounded-md bg-(--paper) px-2 py-1 font-mono text-xs font-semibold text-(--accent-ink) hover:bg-(--accent-softer)"
                        disabled={!keyValid}
                        onClick={() => insertVariable(variable.key)}
                        title="Insert into the text you were editing"
                        type="button"
                      >
                        {`{{${variable.key || "name"}}}`}
                      </button>
                      <button
                        aria-label={`Remove the variable ${variable.key}`}
                        className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-lg text-(--tertiary) hover:bg-(--danger-soft) hover:text-(--danger)"
                        onClick={() =>
                          edit((current) => ({
                            ...current,
                            variables: current.variables.filter(
                              (_, candidate) => candidate !== index,
                            ),
                          }))
                        }
                        type="button"
                      >
                        <Trash2 aria-hidden="true" className="h-4 w-4" />
                      </button>
                    </div>
                    {variable.label ? (
                      <p className="text-sm font-semibold text-(--fg)">
                        {variable.label}
                      </p>
                    ) : (
                      <input
                        aria-invalid={!keyValid}
                        aria-label="Variable name"
                        className="field-input min-h-9 font-mono text-xs"
                        maxLength={40}
                        onChange={(event) =>
                          edit((current) => ({
                            ...current,
                            variables: current.variables.map(
                              (candidate, candidateIndex) =>
                                candidateIndex === index
                                  ? {
                                      ...candidate,
                                      key: event.target.value.trim(),
                                    }
                                  : candidate,
                            ),
                          }))
                        }
                        placeholder="client.name"
                        value={variable.key}
                      />
                    )}
                    <input
                      aria-label={`Value of ${variable.label || variable.key}`}
                      className="field-input min-h-10"
                      maxLength={500}
                      onChange={(event) =>
                        edit((current) => ({
                          ...current,
                          variables: current.variables.map(
                            (candidate, candidateIndex) =>
                              candidateIndex === index
                                ? { ...candidate, value: event.target.value }
                                : candidate,
                          ),
                        }))
                      }
                      placeholder={variable.label || "Value"}
                      value={variable.value}
                    />
                  </li>
                );
              })}
            </ul>
            {usage.undefinedKeys.length > 0 ? (
              <div className="mt-3 space-y-2">
                <p className="text-xs font-semibold text-(--secondary)">
                  Used in the text but not defined:
                </p>
                <div className="flex flex-wrap gap-2">
                  {usage.undefinedKeys.map((key) => (
                    <button
                      className="btn-quiet min-h-8 font-mono text-xs"
                      disabled={
                        content.variables.length >= MAX_BUILDER_VARIABLES
                      }
                      key={key}
                      onClick={() =>
                        edit((current) => ({
                          ...current,
                          variables: [
                            ...current.variables,
                            { key, label: key, value: "" },
                          ],
                        }))
                      }
                      type="button"
                    >
                      <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                      {key}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <button
              className="btn-quiet mt-3"
              disabled={content.variables.length >= MAX_BUILDER_VARIABLES}
              onClick={() =>
                edit((current) => ({
                  ...current,
                  variables: [
                    ...current.variables,
                    {
                      key: `field_${current.variables.length + 1}`,
                      label: "",
                      value: "",
                    },
                  ],
                }))
              }
              type="button"
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add variable
            </button>
          </SidePanel>

          <SidePanel title="Page">
            <div aria-label="Page size" className="segmented" role="group">
              {(Object.keys(pageSizes) as (keyof typeof pageSizes)[]).map(
                (size) => (
                  <button
                    aria-pressed={content.pageSize === size}
                    className="segmented-item"
                    key={size}
                    onClick={() =>
                      edit((current) => ({ ...current, pageSize: size }))
                    }
                    type="button"
                  >
                    {pageSizes[size].label}
                  </button>
                ),
              )}
            </div>
          </SidePanel>
        </aside>
      </div>

      {isSendOpen ? (
        <SendForSignatureDialog
          currentUser={currentUser}
          documentId={document.id}
          flush={flush}
          onClose={() => setIsSendOpen(false)}
          problems={problems}
          roles={content.roles}
        />
      ) : null}
    </div>
  );
}

function document_execInsert(text: string): boolean {
  try {
    return window.document.execCommand("insertText", false, text);
  } catch {
    return false;
  }
}

function SidePanel({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <section className="panel space-y-3 p-5">
      <div className="space-y-1">
        <h2 className="text-base font-extrabold text-(--fg)">{title}</h2>
        {description ? (
          <p className="text-sm leading-5 text-(--secondary)">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function BlockFrame({
  canAdd,
  children,
  isFirst,
  isLast,
  label,
  onAddBelow,
  onDuplicate,
  onMove,
  onRemove,
}: {
  canAdd: boolean;
  children: ReactNode;
  isFirst: boolean;
  isLast: boolean;
  label: string;
  onAddBelow: (type: BlockType) => void;
  onDuplicate: () => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const iconButton =
    "inline-flex h-8 w-8 items-center justify-center rounded-lg text-(--tertiary) hover:bg-(--surface-strong) hover:text-(--fg) disabled:opacity-30";

  return (
    <div className="group rounded-xl border border-transparent p-2 transition-colors focus-within:border-(--border) hover:border-(--border) sm:p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="section-eyebrow">{label}</span>
        <div className="flex items-center gap-0.5 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
          <button
            aria-label={`Move ${label.toLowerCase()} up`}
            className={iconButton}
            disabled={isFirst}
            onClick={() => onMove(-1)}
            type="button"
          >
            <ArrowUp aria-hidden="true" className="h-4 w-4" />
          </button>
          <button
            aria-label={`Move ${label.toLowerCase()} down`}
            className={iconButton}
            disabled={isLast}
            onClick={() => onMove(1)}
            type="button"
          >
            <ArrowDown aria-hidden="true" className="h-4 w-4" />
          </button>
          <button
            aria-label={`Duplicate ${label.toLowerCase()}`}
            className={iconButton}
            disabled={!canAdd}
            onClick={onDuplicate}
            type="button"
          >
            <Copy aria-hidden="true" className="h-4 w-4" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label={`Add a block below this ${label.toLowerCase()}`}
                className={iconButton}
                disabled={!canAdd}
                type="button"
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {addableBlocks.map((type) => (
                <DropdownMenuItem key={type} onSelect={() => onAddBelow(type)}>
                  {blockTypeLabels[type]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            aria-label={`Delete ${label.toLowerCase()}`}
            className={`${iconButton} hover:bg-(--danger-soft) hover:text-(--danger)`}
            onClick={onRemove}
            type="button"
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}

const plainText =
  "w-full resize-none rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-(--fg) outline-none field-sizing-content placeholder:text-(--placeholder) hover:border-(--border-strong) focus-visible:border-(--accent) focus-visible:bg-(--paper)";

function RoleSelect({
  label,
  onChange,
  roles,
  value,
}: {
  label: string;
  onChange: (roleId: string) => void;
  roles: BuilderRole[];
  value: string;
}) {
  return (
    <label className="space-y-1 text-xs font-semibold text-(--secondary)">
      <span className="block">{label}</span>
      <select
        className="field-input min-h-10 w-48"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {roles.map((role) => (
          <option key={role.id} value={role.id}>
            {role.name || "Unnamed role"}
          </option>
        ))}
      </select>
    </label>
  );
}

function BlockEditor({
  block,
  onChange,
  roles,
}: {
  block: BuilderBlock;
  onChange: (block: BuilderBlock) => void;
  roles: BuilderRole[];
}) {
  switch (block.type) {
    case "heading": {
      const sizes = {
        1: "text-2xl font-extrabold tracking-[-0.02em]",
        2: "text-lg font-extrabold",
        3: "text-base font-bold",
      } as const;

      return (
        <div className="flex items-start gap-2">
          <select
            aria-label="Heading level"
            className="field-input min-h-9 w-20 px-2 text-xs"
            onChange={(event) =>
              onChange({
                ...block,
                level: Number(event.target.value) as 1 | 2 | 3,
              })
            }
            value={block.level}
          >
            <option value={1}>H1</option>
            <option value={2}>H2</option>
            <option value={3}>H3</option>
          </select>
          <input
            aria-label="Heading text"
            className={`${plainText} ${sizes[block.level]}`}
            data-variables="true"
            maxLength={300}
            onChange={(event) =>
              onChange({ ...block, text: event.target.value })
            }
            placeholder="Heading"
            value={block.text}
          />
        </div>
      );
    }
    case "paragraph":
      return (
        <textarea
          aria-label="Text"
          className={`${plainText} min-h-16 text-[0.9375rem] leading-7`}
          data-variables="true"
          maxLength={MAX_PARAGRAPH_LENGTH}
          onChange={(event) => onChange({ ...block, text: event.target.value })}
          onKeyDown={handleBoldShortcut}
          placeholder="Write here. **Bold** with Ctrl+B or ⌘B, {{variables}} for details that change."
          rows={2}
          value={block.text}
        />
      );
    case "list":
      return (
        <div className="space-y-2">
          <div aria-label="List style" className="segmented" role="group">
            {(["bullet", "number"] as const).map((style) => (
              <button
                aria-pressed={block.style === style}
                className="segmented-item"
                key={style}
                onClick={() => onChange({ ...block, style })}
                type="button"
              >
                {style === "bullet" ? "Bullets" : "Numbered"}
              </button>
            ))}
          </div>
          <textarea
            aria-label="List items, one per line"
            className={`${plainText} min-h-16 text-[0.9375rem] leading-7`}
            data-variables="true"
            onChange={(event) =>
              onChange({
                ...block,
                items: event.target.value.split("\n").slice(0, 100),
              })
            }
            onKeyDown={handleBoldShortcut}
            placeholder="One item per line"
            rows={2}
            value={block.items.join("\n")}
          />
        </div>
      );
    case "pricing":
      return <PricingTableEditor block={block} onChange={onChange} />;
    case "signature": {
      const role = roles.find((candidate) => candidate.id === block.roleId);

      return (
        <div className="well flex flex-col gap-4 p-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="grid flex-1 gap-3 sm:grid-cols-[1fr_auto]">
            <div className="space-y-1">
              <div className="h-10 border-b-2 border-(--border-strong)" />
              <p className="text-xs text-(--tertiary)">
                Signature · {role?.name ?? "Signer"}
              </p>
            </div>
            <div className="space-y-1 sm:w-32">
              <div className="h-10 border-b-2 border-(--border-strong)" />
              <p className="text-xs text-(--tertiary)">Date signed</p>
            </div>
          </div>
          <RoleSelect
            label="Signed by"
            onChange={(roleId) => onChange({ ...block, roleId })}
            roles={roles}
            value={block.roleId}
          />
        </div>
      );
    }
    case "field":
      return (
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-xs font-semibold text-(--secondary)">
            <span className="block">Kind</span>
            <select
              className="field-input min-h-10 w-36"
              onChange={(event) =>
                onChange({
                  ...block,
                  fieldType: event.target.value as InlineFieldType,
                })
              }
              value={block.fieldType}
            >
              {(Object.keys(inlineFieldLabels) as InlineFieldType[]).map(
                (type) => (
                  <option key={type} value={type}>
                    {inlineFieldLabels[type]}
                  </option>
                ),
              )}
            </select>
          </label>
          <label className="min-w-48 flex-1 space-y-1 text-xs font-semibold text-(--secondary)">
            <span className="block">
              {block.fieldType === "checkbox" ? "Statement" : "Label"}
            </span>
            <input
              className="field-input min-h-10"
              data-variables="true"
              maxLength={120}
              onChange={(event) =>
                onChange({ ...block, label: event.target.value })
              }
              placeholder={
                block.fieldType === "checkbox"
                  ? "I have read the terms above"
                  : "Job title"
              }
              value={block.label}
            />
          </label>
          <RoleSelect
            label="Filled in by"
            onChange={(roleId) => onChange({ ...block, roleId })}
            roles={roles}
            value={block.roleId}
          />
          <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-(--secondary)">
            <input
              checked={block.required}
              className="h-4 w-4 accent-(--accent)"
              onChange={(event) =>
                onChange({ ...block, required: event.target.checked })
              }
              type="checkbox"
            />
            Required
          </label>
        </div>
      );
    case "divider":
      return <hr className="my-2 border-(--border-strong)" />;
    case "pageBreak":
      return (
        <div className="flex items-center gap-3 py-1 text-xs font-semibold text-(--tertiary)">
          <span className="h-px flex-1 border-t border-dashed border-(--border-strong)" />
          Next page starts here
          <span className="h-px flex-1 border-t border-dashed border-(--border-strong)" />
        </div>
      );
  }
}
