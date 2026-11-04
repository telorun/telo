import { resolveRefresh, segment, type AddressWire } from "../address-wire.js";
import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from "react";
import { fillAttribute, styleAttribute, type Style } from "../bindings.js";
import { CommandsContext, type Command, type CommandHandler } from "../command-node.js";
import { useControl } from "../effective-controls.js";
import { useHost, useHostStore } from "../host.js";
import { MediaViewer } from "../media-viewer.js";
import { ErrorNode, Loading, Nodes, type SpecNode } from "../nodes.js";
import { RendererContext, RootsContext } from "../renderer-context.js";
import { useSay, type WireText } from "../texts.js";
import { errorSpec, type ErrorSpec } from "../ui-error.js";
import { ButtonsContext, ChatButton, type ChatButtons } from "./chat-buttons.js";
import { entryAttachments, entryBlocks, messageText, transcriptMarkdown, type Block, type SentFile } from "./chat-blocks.js";
import { AnnounceContext, BlockList, CopyButton, ShowContext, UsageLine, type ChatShow } from "./chat-blocks-view.js";
import { Composer, type Starter } from "./chat-composer.js";
import { EditForm } from "./chat-edit-form.js";
import { EMPTY_DRAFT, NEW_DRAFT, discard, useDrafts } from "./chat-drafts.js";
import { EntryOwnerContext, EntryStateContext } from "./chat-entry-state.js";
import { BasePathContext, Thumbnail, ViewerContext, entryPictures, livePictures, sentPictures, sentSource, sentPictureId, useMediaSource, type Picture } from "./chat-pictures.js";
import { ChatApi, type ChatSpec, type Entry, type TurnEndReason } from "./chat-protocol.js";
import { useChatSession } from "./chat-session.js";
import { useTranscriptWindow, type RowKey } from "./chat-transcript-window.js";

/** A `chat` node as the page document carries it. */
export interface ChatNodeSpec {
  type: "chat";
  spec: ChatSpec;
  basePath: string;
  /** The nodes drawn above the transcript, over `conversation` and `chat`; none draws no header. */
  header: SpecNode[];
  placeholder: WireText | null;
  starters: Starter[];
  show: ChatShow;
  buttons: ChatButtons;
  composer: { actions: "inside" | "outside" };
  /** The page query parameter that names the conversation shown; null keeps the choice in memory. */
  conversation: { parameter: string } | null;
  /** Requests read again when a send is admitted and when a turn ends, over `conversation.id`. */
  refreshes: AddressWire[];
  style?: Style;
  fill?: boolean;
}

const END_NOTES: Partial<Record<TurnEndReason, string>> = {
  length: "chatTurnLength",
  "content-filter": "chatTurnContentFilter",
  limit: "chatTurnLimit",
  approval: "chatTurnApproval",
  cancelled: "chatTurnCancelled",
  failed: "chatTurnFailed",
};

type Decide = (id: string, approved: boolean, reason?: string) => void;

/** Where a message stands in the transcript: its row, how it is placed, and its position of the total (-1 while earlier pages remain). */
interface Placement {
  index?: number;
  measure?: (element: Element | null) => void;
  style?: CSSProperties;
  position: number;
  total: number;
}

/** One stored entry: who wrote it, what it holds, and what can be done with it. */
function EntryView({
  api,
  offer,
  entry,
  previous,
  branching,
  busy,
  placement,
  editing,
  setEditing,
  onResend,
  onSwitch,
  onDecide,
}: {
  api: ChatApi;
  offer: ChatSpec["attachments"];
  entry: Entry;
  previous: Entry | undefined;
  branching: boolean;
  busy: boolean;
  placement: Placement;
  /** Kept by the chat, so the entry stays drawn while it is edited. */
  editing: boolean;
  setEditing: (editing: boolean) => void;
  onResend: (source: Entry, message: string, attachments: string[], files: SentFile[]) => void;
  onSwitch: (leaf: string) => void;
  onDecide: Decide;
}) {
  const say = useSay();
  const Icon = useControl("Icon");
  const { copy } = useContext(ShowContext);
  const blocks = useMemo(() => entryBlocks(entry), [entry]);
  const text = messageText(blocks);
  const { siblings } = entry;
  const source = entry.role === "user" ? entry : previous?.role === "user" ? previous : undefined;
  const branchable = branching && !busy && source !== undefined;
  return (
    <article
      data-telo-part="chat-message"
      data-role={entry.role}
      data-index={placement.index}
      ref={placement.measure}
      style={placement.style}
      tabIndex={-1}
      aria-posinset={placement.position}
      aria-setsize={placement.total}
    >
      <span data-telo-part="chat-message-label">{say(entry.role === "user" ? "chatYou" : "chatAssistant")}</span>
      {!editing ? (
        <div data-telo-part="chat-message-body">
          <EntryOwnerContext.Provider value={entry.id}>
            <BlockList blocks={blocks} streaming={false} onDecide={onDecide} />
          </EntryOwnerContext.Provider>
        </div>
      ) : (
        <EditForm
          api={api}
          offer={offer}
          entry={entry}
          text={text}
          onCancel={() => setEditing(false)}
          onSubmit={(message, attachments, files) => {
            onResend(entry, message, attachments, files);
            setEditing(false);
          }}
        />
      )}
      {entry.role === "assistant" && entry.usage && <UsageLine usage={entry.usage} />}
      <div data-telo-part="chat-message-actions">
        {copy && text !== "" && <CopyButton text={text} />}
        {branchable && entry.role === "user" && !editing && (
          <ChatButton which="edit" part="chat-edit" text={say("chatEditMessage")} onClick={() => setEditing(true)} />
        )}
        {branchable && entry.role === "assistant" && (
          <ChatButton
            which="regenerate"
            part="chat-regenerate"
            text={say("chatRegenerate")}
            onClick={() => onResend(source as Entry, messageText(entryBlocks(source as Entry)), entryAttachments(source as Entry), [])}
          />
        )}
        {branching && siblings.count > 1 && (
          <span data-telo-part="chat-branches">
            <button data-telo-part="chat-branch-previous" type="button" disabled={siblings.previous === null || busy} aria-label={say("chatBranchPrevious")} onClick={() => onSwitch(siblings.previous as string)}>
              <Icon name="previous" />
            </button>
            <span data-telo-part="chat-branch-position">{say("chatBranchPosition", { position: siblings.position, total: siblings.count })}</span>
            <button data-telo-part="chat-branch-next" type="button" disabled={siblings.next === null || busy} aria-label={say("chatBranchNext")} onClick={() => onSwitch(siblings.next as string)}>
              <Icon name="next" />
            </button>
          </span>
        )}
      </div>
    </article>
  );
}

/** The row standing for the earlier page being read, above the first entry. */
const EARLIER: RowKey = -1;

/** The address with one query parameter set, or removed when `value` is absent. */
const withParameter = (location: { path: string; search: string; hash: string }, name: string, value: string | undefined): string => {
  const params = new URLSearchParams(location.search);
  if (value === undefined) params.delete(name);
  else params.set(name, value);
  const search = params.toString();
  return `${location.path}${search === "" ? "" : `?${search}`}${location.hash}`;
};

/** The chat: the transcript with the message box under it, following the page's address when it names a parameter. */
export function ChatNode({ node, embedded = false }: { node: ChatNodeSpec; embedded?: boolean }) {
  const say = useSay();
  const host = useHost();
  const store = useHostStore();
  const { prefix } = useContext(RendererContext);
  const hostRef = useRef(host);
  hostRef.current = host;
  const sayRef = useRef(say);
  sayRef.current = say;
  const api = useMemo(() => new ChatApi(() => hostRef.current, prefix, node.basePath, (key, values) => sayRef.current(key, values)), [prefix, node.basePath]);
  const drafts = useDrafts();
  const parameter = node.conversation?.parameter;
  const refreshes = useRef(node.refreshes);
  refreshes.current = node.refreshes;
  const refresh = (conversation: string) => {
    for (const each of refreshes.current) {
      const refresh = resolveRefresh(each, { conversation: { id: conversation } }, "chat refresh");
      if (refresh !== undefined) store.notifyRefresh(refresh);
    }
  };
  const session = useChatSession(api, {
    admitted: refresh,
    ended: refresh,
    assigned: (previous, id) => {
      drafts.move(previous ?? NEW_DRAFT, id);
      // The created conversation takes the place of the entry the chat was opened at.
      if (parameter !== undefined) hostRef.current.navigate(withParameter(hostRef.current.location, parameter, id), { replace: true });
    },
  });
  const operations = node.spec.operations;
  const branching = operations.includes("branch");
  const [commandFailure, setCommandFailure] = useState<ErrorSpec>();
  const [announcement, setAnnouncement] = useState("");
  const { entries, live, phase, failure, ended } = session;
  const running = phase !== "idle";
  // The address names the conversation: one the chat did not itself just open is opened, a running turn left to run on.
  const named = parameter === undefined ? undefined : new URLSearchParams(host.location.search).get(parameter) || undefined;
  useEffect(() => {
    if (parameter !== undefined && named !== session.shown()) session.open(named);
  }, [parameter, named]);
  // A write to the open conversation's own address (a rename, a delete) reads it again in place, unless a turn is under way.
  const latest = useRef({ running, refresh: session.refresh });
  latest.current = { running, refresh: session.refresh };
  const openId = session.conversation;
  const openAt = openId === undefined ? undefined : `${node.basePath}/conversations/${segment(openId)}`;
  useEffect(
    () => (openAt === undefined ? undefined : host.onChanged(openAt, () => latest.current.running || void latest.current.refresh())),
    [openAt],
  );
  const waiting = live !== undefined && live.blocks.some((block) => block.kind === "approval" && !block.decision);

  useEffect(() => {
    setAnnouncement(phase === "running" ? say("chatAnnounceStarted") : ended !== undefined && ended !== "approval" ? say("chatAnnounceDone") : "");
  }, [phase === "running", ended]);

  /** The entries being edited, which stay drawn wherever they are scrolled. */
  const [editing, setEditing] = useState<ReadonlySet<string>>(() => new Set());
  const edit = (id: string, open: boolean) =>
    setEditing((now) => {
      const next = new Set(now);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  // An entry that left the transcript — another branch, another conversation — is no longer edited.
  useEffect(() => {
    setEditing((now) => {
      const present = new Set(entries.map((each) => each.id));
      const kept = [...now].filter((id) => present.has(id));
      return kept.length === now.size ? now : new Set(kept);
    });
  }, [entries]);
  /** The entry holding the keyboard focus, which stays drawn while it does. */
  const [focused, setFocused] = useState<string>();
  const entryState = useMemo(() => new Map<string, unknown>(), [session.conversation]);
  const loadingEarlier = session.loadingEarlier;
  const rows = useMemo<RowKey[]>(() => [...(loadingEarlier ? [EARLIER] : []), ...entries.map((each) => each.id)], [entries, loadingEarlier]);
  const keep = useMemo(() => new Set<RowKey>([...editing, ...(focused === undefined ? [] : [focused])]), [editing, focused]);
  const transcriptWindow = useTranscriptWindow({
    keys: rows,
    keep,
    conversation: session.conversation,
    // Earlier pages are read until the viewport is filled, and as the viewer nears the top.
    reachedTop: () => {
      if (session.earlier && !session.loadingEarlier && !session.earlierFailed && !session.loading) void session.loadEarlier();
    },
  });
  const firstEntry = loadingEarlier ? 1 : 0;
  const liveCount = live === undefined ? 0 : (live.user ? 1 : 0) + (live.blocks.length > 0 || phase !== "idle" ? 1 : 0);
  const total = session.earlier ? -1 : entries.length + liveCount;

  const send = (message: string, attachments: string[], files: SentFile[]) => {
    transcriptWindow.follow();
    void session.send({ message, attachments, files, parent: entries[entries.length - 1]?.id });
  };

  const resend = (source: Entry, message: string, attachments: string[], files: SentFile[]) => {
    transcriptWindow.follow();
    void session.send({ message, attachments, files, parent: source.parent });
  };

  /** The pictures of the conversation loaded so far, in the order the transcript draws them: the stored entries, then the live turn. */
  const source = useMediaSource(node.basePath);
  const stored = useMemo(() => entries.flatMap((entry) => entryPictures(entry, source)), [entries, source]);
  const sent = live?.user?.files;
  const pictures: Picture[] = [...stored, ...(sent ? sentPictures(sent, source) : []), ...(live ? livePictures(live.blocks, source) : [])];
  const [viewing, setViewing] = useState<string>();
  const viewedAt = pictures.findIndex((picture) => picture.id === viewing);
  // The local previews of the files just sent are shown until the turn is read back, then released.
  useEffect(
    () => () => {
      for (const file of sent ?? []) if (file.preview) window.URL.revokeObjectURL(file.preview);
    },
    [sent],
  );

  const markdown = () => transcriptMarkdown(entries, { user: say("chatYou"), assistant: say("chatAssistant") }, node.basePath);

  const exportTranscript = () => {
    try {
      const url = URL.createObjectURL(new Blob([markdown()], { type: "text/markdown" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "conversation.md";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url));
      setCommandFailure(undefined);
    } catch (error) {
      setCommandFailure(errorSpec(error, "ERR_UI_EXPORT_FAILED"));
    }
  };

  const copyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(markdown());
      setCommandFailure(undefined);
      setAnnouncement(say("chatCopied"));
    } catch (error) {
      setCommandFailure(errorSpec(error, "ERR_UI_COPY_FAILED"));
    }
  };

  useSyncExternalStore(drafts.subscribe, drafts.snapshot);
  const fresh = drafts.get(NEW_DRAFT);
  const drafted = session.conversation === undefined && (fresh.message !== "" || fresh.files.length > 0);

  /** A new conversation in place of the one shown: the parameter cleared by a new history entry, else the selection held in memory; with none open, the draft is discarded. */
  const newConversation = () => {
    if (session.conversation === undefined) {
      for (const file of fresh.files) discard(file);
      return drafts.patch(NEW_DRAFT, () => EMPTY_DRAFT);
    }
    if (parameter === undefined) return session.open(undefined);
    host.navigate(withParameter(host.location, parameter, undefined));
  };

  /** Page Down and Page Up move the focus to the next and previous message drawn, as the feed pattern asks; a field inside a message keeps its own keys. */
  const moveBetweenMessages = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.key !== "PageDown" && event.key !== "PageUp") || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return;
    const current = target.closest('[data-telo-part="chat-message"]');
    if (!current) return;
    const messages = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-telo-part="chat-message"]')];
    const next = messages[messages.indexOf(current as HTMLElement) + (event.key === "PageDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  const empty = entries.length === 0 && live === undefined;
  const state = failure ? "error" : session.loading ? "loading" : running ? "submitting" : empty ? "empty" : "idle";
  const note = live?.end ?? ended;
  const noteKey = note === undefined ? undefined : END_NOTES[note];
  const canCancel = operations.includes("cancel");
  const transcribed = entries.length > 0;
  const commands: Record<string, Command> = {
    exportTranscript: { offered: true, enabled: transcribed },
    copyTranscript: { offered: true, enabled: transcribed },
    stop: { offered: canCancel, enabled: running },
    newConversation: { offered: true, enabled: session.conversation !== undefined || drafted },
  };
  const handlers: Record<string, CommandHandler> = {
    "chat.exportTranscript": { run: exportTranscript, glyph: "export" },
    "chat.copyTranscript": { run: () => void copyTranscript(), glyph: "copy" },
    "chat.stop": { run: () => void session.stop(), glyph: "stop" },
    "chat.newConversation": { run: newConversation, glyph: "add" },
  };

  return (
    <ShowContext.Provider value={node.show}>
      <EntryStateContext.Provider value={entryState}>
      <AnnounceContext.Provider value={setAnnouncement}>
      <ButtonsContext.Provider value={node.buttons}>
      <BasePathContext.Provider value={node.basePath}>
      <ViewerContext.Provider value={setViewing}>
      <section data-telo-part="chat" data-state={state} data-embedded={embedded ? "true" : undefined} data-fill={fillAttribute(node)} data-style={styleAttribute(node.style)}>
        <div data-telo-part="chat-main">
          {node.header.length > 0 && (
            <header data-telo-part="chat-header">
              {/* An open conversation whose record is not read yet holds nothing, so no condition over it holds. */}
              <RootsContext.Provider value={{ conversation: session.conversation === undefined ? null : (session.summary ?? undefined), chat: commands }}>
                <CommandsContext.Provider value={handlers}>
                  <Nodes nodes={node.header} />
                </CommandsContext.Provider>
              </RootsContext.Provider>
            </header>
          )}
          {commandFailure && <ErrorNode error={commandFailure} />}
          <div
            data-telo-part="chat-transcript"
            role="feed"
            aria-label={say("chatTranscript")}
            aria-busy={running || loadingEarlier}
            tabIndex={0}
            ref={transcriptWindow.ref}
            onScroll={transcriptWindow.onScroll}
            onFocus={(event) => {
              const row = (event.target as Element).closest('[data-telo-part="chat-message"][data-index]');
              const key = row ? rows[Number(row.getAttribute("data-index"))] : undefined;
              setFocused(typeof key === "string" ? key : undefined);
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(undefined);
            }}
            onKeyDown={moveBetweenMessages}
          >
            {empty && !session.loading && <p data-telo-part="chat-empty" role="presentation">{say("chatEmpty")}</p>}
            {transcriptWindow.drawn.map(({ index, style }) => {
              const placed = { index, measure: transcriptWindow.measure, style };
              if (index < firstEntry) return <Loading key="earlier" role="presentation" ref={placed.measure} index={index} style={style} />;
              const at = index - firstEntry;
              const entry = entries[at];
              return (
                <EntryView
                  key={entry.id}
                  api={api}
                  offer={node.spec.attachments}
                  entry={entry}
                  previous={entries[at - 1]}
                  branching={branching}
                  busy={running}
                  placement={{ ...placed, position: at + 1, total }}
                  editing={editing.has(entry.id)}
                  setEditing={(open) => edit(entry.id, open)}
                  onResend={resend}
                  onSwitch={session.switchTo}
                  onDecide={session.decide}
                />
              );
            })}
            {live && (
              <>
                {live.user && (
                  <article data-telo-part="chat-message" data-role="user" tabIndex={-1} aria-posinset={entries.length + 1} aria-setsize={total}>
                    <span data-telo-part="chat-message-label">{say("chatYou")}</span>
                    <div data-telo-part="chat-message-body">
                      <BlockList blocks={[{ kind: "text", text: live.user.text } satisfies Block]} streaming={false} onDecide={session.decide} />
                      {live.user.files.map((file, index) => {
                        const src = file.image ? sentSource(file, source) : undefined;
                        return src === undefined ? (
                          <span key={index} data-telo-part="chat-attachment">
                            {file.name}
                          </span>
                        ) : (
                          <Thumbnail key={index} part="chat-image" src={src} name={file.name} onOpen={() => setViewing(sentPictureId(index))} />
                        );
                      })}
                    </div>
                  </article>
                )}
                {(live.blocks.length > 0 || phase !== "idle") && (
                  <article
                    data-telo-part="chat-message"
                    data-role="assistant"
                    tabIndex={-1}
                    aria-busy={phase !== "idle" && !waiting}
                    aria-posinset={entries.length + liveCount}
                    aria-setsize={total}
                  >
                    <span data-telo-part="chat-message-label">{say("chatAssistant")}</span>
                    <div data-telo-part="chat-message-body">
                      <BlockList blocks={live.blocks} streaming={phase !== "idle"} onDecide={session.decide} />
                      {live.blocks.length === 0 && <span data-telo-part="chat-pending">{say("chatThinking")}</span>}
                    </div>
                    {live.usage && <UsageLine usage={live.usage} />}
                  </article>
                )}
                {live.error && <ErrorNode error={{ type: "error", code: live.error.code, message: live.error.detail }} />}
              </>
            )}
            {phase === "reconnecting" && (
              <p data-telo-part="chat-reconnecting" role="status">
                {say("chatReconnecting")}
              </p>
            )}
            {phase === "dropped" && (
              <div data-telo-part="chat-reconnecting" role="alert">
                {say("chatReconnectFailed")}
                <button data-telo-part="chat-retry" type="button" onClick={session.retry}>
                  {say("chatRetry")}
                </button>
              </div>
            )}
            {noteKey && (
              <p data-telo-part="chat-turn-note">
                {say(noteKey)}
                {note === "limit" && phase === "idle" && (
                  <button data-telo-part="chat-continue" type="button" onClick={() => send(say("chatContinue"), [], [])}>
                    {say("chatContinue")}
                  </button>
                )}
              </p>
            )}
            {failure && (
              <>
                <ErrorNode error={{ type: "error", code: failure.code, message: failure.message }} />
                <button data-telo-part="chat-retry" type="button" onClick={session.retry}>
                  {say("chatRetry")}
                </button>
              </>
            )}
          </div>
          <div data-telo-part="chat-announcer" role="status" aria-live="polite">
            {announcement}
          </div>
          <Composer
            api={api}
            drafts={drafts}
            conversation={session.conversation}
            spec={node.spec}
            placeholder={node.placeholder}
            starters={node.starters}
            running={running || waiting || session.unavailable}
            canStop={canCancel && running}
            empty={empty}
            actions={node.composer.actions}
            onSend={send}
            onStop={() => void session.stop()}
          />
        </div>
      </section>
      {viewedAt >= 0 && <MediaViewer items={pictures} index={viewedAt} onIndex={(next) => setViewing(pictures[next].id)} onClose={() => setViewing(undefined)} />}
      </ViewerContext.Provider>
      </BasePathContext.Provider>
      </ButtonsContext.Provider>
      </AnnounceContext.Provider>
      </EntryStateContext.Provider>
    </ShowContext.Provider>
  );
}
