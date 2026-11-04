import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { useControl } from "../effective-controls.js";
import { useHostStore } from "../host.js";
import { linkAddress } from "../link-address.js";
import { Markdown } from "../markdown/markdown-node.js";
import { ErrorNode } from "../nodes.js";
import { useSay } from "../texts.js";
import { errorSpec, type ErrorSpec } from "../ui-error.js";
import { ChatButton } from "./chat-buttons.js";
import { EntryOwnerContext, useEntryState } from "./chat-entry-state.js";
import { partName, type Block } from "./chat-blocks.js";
import { Thumbnail, ViewerContext, entryPictureId, livePictureId, useChatMediaSource } from "./chat-pictures.js";
import type { Usage } from "./chat-protocol.js";

/** What the chat's presentation lets its parts draw. */
export interface ChatShow {
  reasoning: boolean;
  toolDetail: boolean;
  usage: boolean;
  export: boolean;
  copy: boolean;
}

export const ShowContext = createContext<ChatShow>({ reasoning: true, toolDetail: true, usage: true, export: true, copy: true });

/** Says a thing through the chat's polite live region. */
export const AnnounceContext = createContext<(text: string) => void>(() => undefined);

const COPY_CONFIRMATION_MS = 2000;

/** A button copying a text, saying so for a moment. */
export function CopyButton({ text }: { text: string }) {
  const say = useSay();
  const announce = useContext(AnnounceContext);
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState<ErrorSpec>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const settle = () => {
    setCopied(false);
    announce("");
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      setFailure(errorSpec(error, "ERR_UI_COPY_FAILED"));
      return;
    }
    setFailure(undefined);
    setCopied(true);
    announce(say("chatCopied"));
    clearTimeout(timer.current);
    timer.current = setTimeout(settle, COPY_CONFIRMATION_MS);
  };
  return (
    <>
      <ChatButton which="copy" part="chat-copy" text={say(copied ? "chatCopied" : "chatCopy")} done={copied} onClick={copy} />
      {failure ? <ErrorNode error={failure} /> : null}
    </>
  );
}

const json = (value: unknown): string => JSON.stringify(value, null, 2) ?? "";

/** A disclosure: a button that opens or closes the panel it controls, kept open across the entry being drawn again. */
function useDisclosure(slot: string, initial: boolean) {
  const id = useId();
  const [open, setOpen] = useEntryState(slot, initial);
  return { id, open, toggle: () => setOpen(!open) };
}

function Reasoning({ slot, text, streaming }: { slot: string; text: string; streaming: boolean }) {
  const say = useSay();
  const { id, open, toggle } = useDisclosure(slot, streaming);
  return (
    <section data-telo-part="chat-reasoning" data-state={open ? "open" : "closed"}>
      <button data-telo-part="chat-reasoning-toggle" type="button" aria-expanded={open} aria-controls={id} onClick={toggle}>
        {say(streaming ? "chatThinking" : "chatReasoning")}
      </button>
      {open && (
        <div data-telo-part="chat-reasoning-body" id={id}>
          <Markdown source={text} images="app-relative" />
        </div>
      )}
    </section>
  );
}

function ToolCard({ block, detail }: { block: Extract<Block, { kind: "tool" }>; detail: boolean }) {
  const say = useSay();
  const { id, open, toggle } = useDisclosure(`tool:${block.id}`, false);
  const status = block.isError ? "failed" : block.done ? "done" : "running";
  const args = block.arguments !== undefined ? json(block.arguments) : block.written;
  return (
    <section data-telo-part="chat-tool" data-status={status}>
      <div data-telo-part="chat-tool-header">
        <span data-telo-part="chat-tool-name">{say("chatToolCall", { name: block.name ?? "…" })}</span>
        {status !== "done" && <span data-telo-part="chat-tool-status">{say(status === "failed" ? "chatToolFailed" : "chatToolRunning")}</span>}
        {detail && (
          <button data-telo-part="chat-tool-toggle" type="button" aria-expanded={open} aria-controls={id} onClick={toggle}>
            {say(open ? "chatHideDetails" : "chatShowDetails")}
          </button>
        )}
      </div>
      {detail && open && (
        <div data-telo-part="chat-tool-detail" id={id}>
          <span data-telo-part="chat-tool-label">{say("chatToolArguments")}</span>
          <pre data-telo-part="chat-tool-data" tabIndex={0}>{args}</pre>
          {block.done && (
            <>
              <span data-telo-part="chat-tool-label">{say("chatToolResult")}</span>
              <pre data-telo-part="chat-tool-data" tabIndex={0}>{typeof block.result === "string" ? block.result : json(block.result)}</pre>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function ApprovalCard({
  block,
  detail,
  onDecide,
}: {
  block: Extract<Block, { kind: "approval" }>;
  detail: boolean;
  onDecide: (id: string, approved: boolean, reason?: string) => void;
}) {
  const say = useSay();
  const TextInput = useControl("TextInput");
  const id = useId();
  const [reason, setReason] = useEntryState(`approval:${block.id}`, "");
  const decision = block.decision;
  return (
    <section data-telo-part="chat-approval" data-status={decision ? (decision.approved ? "approved" : "rejected") : "pending"}>
      <span data-telo-part="chat-approval-title">{say("chatApprovalRequest", { name: block.name })}</span>
      {detail && <pre data-telo-part="chat-tool-data" tabIndex={0}>{json(block.arguments)}</pre>}
      {decision ? (
        <span data-telo-part="chat-approval-decision">
          {decision.approved ? say("chatApproved") : decision.reason ? say("chatRejectedReason", { reason: decision.reason }) : say("chatRejected")}
        </span>
      ) : (
        <div data-telo-part="chat-approval-actions">
          <TextInput
            id={id}
            part="input"
            type="text"
            label={say("chatRejectReason")}
            value={reason}
            invalid={false}
            required={false}
            disabled={false}
            onChange={setReason}
          />
          <button data-telo-part="chat-approve" type="button" onClick={() => onDecide(block.id, true)}>
            {say("chatApprove")}
          </button>
          <button data-telo-part="chat-reject" type="button" onClick={() => onDecide(block.id, false, reason.trim() || undefined)}>
            {say("chatReject")}
          </button>
        </div>
      )}
    </section>
  );
}

type MediaPart = { type: "image" | "audio" | "video" | "file"; url: string; mediaType: string; name?: string };

/** A media part, drawn only from an app-relative address — a relative reference resolves under the endpoint's `basePath`. Any other is its name. A picture is a thumbnail that opens the viewer. */
function MediaView({ part, id }: { part: MediaPart; id: string }) {
  const say = useSay();
  const open = useContext(ViewerContext);
  const name = partName(part);
  const src = useChatMediaSource()(part.url);
  if (src === undefined) return <span data-telo-part="chat-attachment">{name}</span>;
  switch (part.type) {
    case "image":
      return <Thumbnail part="chat-image" src={src} name={name} onOpen={() => open(id)} />;
    case "audio":
      return <audio data-telo-part="chat-media" src={src} controls preload="none" aria-label={name} />;
    case "video":
      return <video data-telo-part="chat-media" src={src} controls preload="none" aria-label={name} />;
    default:
      return (
        <a data-telo-part="chat-attachment" href={src} download={name}>
          {say("chatAttachmentOpen", { name })}
        </a>
      );
  }
}

type Citation = { type: "citation"; url: string; title?: string; quote?: string };

function Sources({ citations }: { citations: Citation[] }) {
  const say = useSay();
  const store = useHostStore();
  return (
    <aside data-telo-part="chat-sources">
      <h4 data-telo-part="chat-sources-title">{say("chatSources")}</h4>
      <ol data-telo-part="chat-source-list">
        {citations.map((citation, index) => {
          const href = linkAddress(store, citation.url);
          const label = citation.title ?? citation.url;
          return (
            <li key={index} data-telo-part="chat-source">
              {href === undefined ? (
                label
              ) : (
                <a data-telo-part="markdown-link" href={href} {...(/^https?:/.test(href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                  {label}
                </a>
              )}
              {citation.quote ? <q data-telo-part="chat-source-quote">{citation.quote}</q> : null}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

const MEDIA = new Set(["image", "audio", "video", "file"]);

/** The blocks of one message, in order, its citations gathered under it. */
export function BlockList({
  blocks,
  streaming,
  onDecide,
}: {
  blocks: readonly Block[];
  streaming: boolean;
  onDecide: (id: string, approved: boolean, reason?: string) => void;
}) {
  const show = useContext(ShowContext);
  const say = useSay();
  const owner = useContext(EntryOwnerContext);
  const citations: Citation[] = [];
  const drawn = blocks.map((block, index) => {
    const last = index === blocks.length - 1;
    switch (block.kind) {
      case "text":
        return <Markdown key={index} source={block.text} images="app-relative" />;
      case "reasoning":
        return show.reasoning ? <Reasoning key={index} slot={`reasoning:${index}`} text={block.text} streaming={streaming && last} /> : null;
      case "tool":
        return <ToolCard key={block.id} block={block} detail={show.toolDetail} />;
      case "approval":
        return <ApprovalCard key={block.id} block={block} detail={show.toolDetail} onDecide={onDecide} />;
      case "part": {
        const part = block.part;
        if (part.type === "citation") {
          citations.push(part as Citation);
          return null;
        }
        if (part.type === "refusal") {
          return (
            <div key={index} data-telo-part="chat-refusal" role="note">
              <strong data-telo-part="chat-refusal-title">{say("chatRefusal")}</strong> {(part as { text: string }).text}
            </div>
          );
        }
        return MEDIA.has(part.type) ? <MediaView key={index} part={part as MediaPart} id={owner === undefined ? livePictureId(index) : entryPictureId(owner, index)} /> : null;
      }
    }
  });
  return (
    <>
      {drawn}
      {citations.length > 0 && <Sources citations={citations} />}
    </>
  );
}

/** The tokens a reply cost, as a line. */
export function UsageLine({ usage }: { usage: Usage }) {
  const say = useSay();
  const show = useContext(ShowContext);
  if (!show.usage) return null;
  const { inputTokens, outputTokens, totalTokens } = usage;
  const text =
    inputTokens !== undefined && outputTokens !== undefined
      ? say("chatUsage", { input: inputTokens, output: outputTokens })
      : totalTokens !== undefined
        ? say("chatUsageTotal", { total: totalTokens })
        : undefined;
  return text === undefined ? null : <span data-telo-part="chat-usage">{text}</span>;
}
