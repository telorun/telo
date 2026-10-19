import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Clock, ListPlus, Paperclip, RotateCw, Square, SquarePen, Upload, X, ChevronDown } from "lucide-react";
import {
  AGENT_PANEL_DEFAULT_WIDTH,
  AGENT_PANEL_MIN_WIDTH,
  CONTINUE_MESSAGE,
  FOCUS_COMPOSER_LABEL,
  MOD_KEY_LABEL,
  composerHold,
  formatBytes,
  hasMessage,
  selectionLabel,
  turnAttachments,
  turnIds,
  turnOfUserMessage,
  turnRequest,
  useAgent,
  type ChatMessage,
} from "@/agent";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MessageBlock, SummaryDivider } from "./MessageBlock";
import type { MessageActionHandlers } from "./MessageActions";
import { AgentEmptyState } from "./AgentEmptyState";
import { AgentIdentityDetails, NoAuthBadge, NoTestRunsBadge, UnsupportedFeatures } from "./AgentIdentity";
import { ComposerAttachments } from "./ComposerAttachments";
import { ConversationSwitcher } from "./ConversationSwitcher";
import { ComposerSelections } from "./ComposerSelections";
import { AttachmentLoaderContext } from "./MessageAttachments";
import { useTurnActions } from "./TurnActionConfirm";
import { TurnSummaryCard } from "./TurnSummaryCard";
import { EditorFileContext } from "./WorkspaceFileLink";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Loader } from "@/components/ai-elements/loader";

/** Horizontal space the editor keeps while the panel is dragged wider — a panel
 *  dragged past the window would leave nothing to drag it back from. */
const MIN_EDITOR_WIDTH = 360;

export function AgentPanel({ className }: { className?: string }) {
  const agent = useAgent();
  const composerInput = useRef<HTMLTextAreaElement | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  // The in-flight width lives HERE, not in the agent context: committing per
  // pointer-move would rebuild the context value and re-render every consumer
  // of it — the whole transcript included — on every pixel. The context learns
  // the width once, at the end of the drag. (Same shape as the run dock's.)
  const frame = useRef<HTMLDivElement | null>(null);
  const dragFrom = useRef<{ x: number; width: number } | null>(null);
  const [draftWidth, setDraftWidth] = useState<number | null>(null);
  // Mirrors draftWidth so the drag's end can read the last value without
  // reaching into a state updater for it.
  const draftWidthRef = useRef<number | null>(null);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    const from = dragFrom.current;
    if (!from) return;
    // The panel is on the right and the handle on its left edge, so dragging
    // LEFT grows it: the delta is inverted.
    const shell = frame.current?.parentElement?.getBoundingClientRect().width;
    const max = shell ? Math.max(AGENT_PANEL_MIN_WIDTH, shell - MIN_EDITOR_WIDTH) : Infinity;
    const next = Math.min(max, Math.max(AGENT_PANEL_MIN_WIDTH, from.width + (from.x - event.clientX)));
    draftWidthRef.current = next;
    setDraftWidth(next);
  }, []);

  const endDragRef = useRef<() => void>(() => undefined);
  // Added and removed by a STABLE identity. `endDrag` closes over the context,
  // so it is a new function on every render — and a drag re-renders on every
  // pixel, so removing by that identity would never match what was added and
  // each drag would leave a listener on `window`.
  const onPointerUp = useCallback(() => endDragRef.current(), []);
  const endDrag = useCallback(() => {
    const from = dragFrom.current;
    dragFrom.current = null;
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    if (!from) return;
    // Committed from the ref, never from inside a state updater: an updater must
    // be pure, and StrictMode runs it twice.
    const width = draftWidthRef.current;
    draftWidthRef.current = null;
    setDraftWidth(null);
    if (width !== null) agent.setPanelWidth(width);
  }, [agent, handlePointerMove, onPointerUp]);
  endDragRef.current = endDrag;

  const startDrag = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      dragFrom.current = { x: event.clientX, width: agent.panelWidth };
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [agent.panelWidth, handlePointerMove, onPointerUp],
  );

  // A drag outlives its component otherwise: closing the panel mid-drag left
  // both listeners on `window` until the next pointerup anywhere.
  useEffect(() => () => endDragRef.current(), []);

  // A request to focus the composer — the shortcut, or an entry point that
  // just wrote into it — lands with the caret after what is there.
  const { composerFocus } = agent;
  useEffect(() => {
    const input = composerInput.current;
    if (composerFocus === 0 || !input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [composerFocus]);

  const turnActions = useTurnActions();
  const { features, turnFeatures } = agent;
  // Copy is always offered; the rest only by an agent serving them, and never
  // on a bubble the agent has not admitted as a turn.
  const actionsFor = (m: ChatMessage): MessageActionHandlers => {
    const busy = agent.locked;
    if (m.local) return { busy };
    if (m.role === "user") {
      const turn = turnOfUserMessage(m.id);
      if (!turn || !features.truncation) return { busy };
      return {
        busy,
        onEditResend: (text) => turnActions.editResend(turn, text, m.attachments ?? []),
        onDeleteFrom: () => turnActions.deleteFrom(turn),
      };
    }
    const request = turnRequest(agent.messages, m.id);
    return {
      busy,
      onRetry: features.truncation && request !== null ? () => turnActions.retry(m.id, request, turnAttachments(agent.messages, m.id)) : undefined,
      onBranch: features.branching ? () => void agent.branchFrom(m.id) : undefined,
    };
  };

  // A summary shows after the last turn it covers, whichever turn journaled it.
  const summaries = useMemo(() => {
    const anchors = new Set(turnIds(agent.messages));
    const after = new Map<string, string[]>();
    for (const m of agent.messages) {
      if (m.role !== "assistant") continue;
      for (const part of m.parts) {
        if (part.kind !== "summary" || !anchors.has(part.throughTurnId)) continue;
        after.set(part.throughTurnId, [...(after.get(part.throughTurnId) ?? []), part.summary]);
      }
    }
    return { anchors, after };
  }, [agent.messages]);

  const archived = agent.conversation?.archived === true;
  const { canCompose, attachmentLimits } = agent;
  const { text, queued } = agent.composer;
  // The composer is as tall as its text, up to its CSS cap; wrapping depends
  // on the panel's width too.
  const panelWidth = draftWidth ?? agent.panelWidth;
  useLayoutEffect(() => {
    const input = composerInput.current;
    if (!input) return;
    input.style.height = "auto";
    if (input.scrollHeight > 0) input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`;
  }, [text, panelWidth]);
  const hold = composerHold(agent.composer);
  const canAttach = attachmentLimits !== null && canCompose;

  const filePicker = useRef<HTMLInputElement | null>(null);
  // Counted, not flagged: dragging across a child fires a leave for the parent.
  const dragDepth = useRef(0);
  const [dropping, setDropping] = useState(false);
  const carriesFiles = (event: React.DragEvent) => canAttach && event.dataTransfer.types.includes("Files");
  const endDrop = () => {
    dragDepth.current = 0;
    setDropping(false);
  };

  // A turn that spent its step budget ended in a wrap-up, and goes on as a NEW
  // turn — never a continue of the same one, which is what Resume does for an
  // interrupted turn. Only the conversation's last turn can be gone on from.
  const lastMessage = agent.messages[agent.messages.length - 1];
  const continuable =
    turnFeatures.conclusion &&
    canCompose &&
    !agent.locked &&
    lastMessage?.role === "assistant" &&
    lastMessage.completed === true &&
    lastMessage.limit === "max-steps"
      ? lastMessage.id
      : null;

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      agent.submitComposer();
      return;
    }
    if (e.key === "Escape" && agent.locked && agent.status !== "stopping") {
      e.preventDefault();
      agent.stop();
    }
  };

  const startOver = () => {
    // With an agent that keeps conversations nothing is discarded: the current
    // one stays in the list.
    if (agent.messages.length && !agent.features.conversations) {
      setConfirmClear(true);
      return;
    }
    agent.clearConversation();
  };

  const confirmStartOver = () => {
    agent.clearConversation();
    setConfirmClear(false);
  };

  return (
    <div
      ref={frame}
      // Phone width: over the whole editor rather than beside it, whatever
      // width the user dragged it to on a wider window.
      className={cn(
        "relative flex min-w-0 flex-col border-l border-border bg-background max-md:fixed max-md:inset-0 max-md:z-40 max-md:w-full! max-md:border-l-0",
        className,
      )}
      style={{ width: draftWidth ?? agent.panelWidth }}
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        dragDepth.current++;
        setDropping(true);
      }}
      onDragOver={(event) => {
        if (carriesFiles(event)) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event)) return;
        if (--dragDepth.current <= 0) endDrop();
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        endDrop();
        agent.addAttachments([...event.dataTransfer.files]);
      }}
    >
      {dropping && (
        <div
          role="status"
          className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-primary bg-background/85 text-sm font-medium"
        >
          <Upload className="size-6" />
          Drop files to attach
        </div>
      )}
      <div
        onPointerDown={startDrag}
        onDoubleClick={() => agent.setPanelWidth(AGENT_PANEL_DEFAULT_WIDTH)}
        // Overhangs the border on both sides: a 1px hit area is a border, not a
        // handle. Absolute so it costs the layout nothing.
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-blue-400/60 max-md:hidden"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the agent panel"
        title="Drag to resize — double-click to reset"
      />
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        {agent.features.conversations ? (
          <ConversationSwitcher />
        ) : (
          <span className="flex-1 truncate text-sm font-medium">Authoring agent</span>
        )}
        <NoAuthBadge identity={agent.identity} />
        <NoTestRunsBadge identity={agent.identity} />
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={startOver}
          disabled={agent.locked || !agent.conversationId}
          title="New conversation"
        >
          <SquarePen className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={() => setShowSettings((s) => !s)} title="Agent settings">
          <ChevronDown className={cn("size-4 transition-transform", showSettings && "rotate-180")} />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={agent.togglePanel} title="Close panel">
          <X className="size-4" />
        </Button>
      </header>

      {showSettings && (
        <div className="border-b border-border px-3 py-2">
          <label className="mb-1 block text-xs text-muted-foreground">
            Agent URL override (blank = launch on the active runner)
          </label>
          <Input
            value={agent.overrideUrl}
            onChange={(e) => agent.setOverrideUrl(e.target.value)}
            placeholder="e.g. http://localhost:8899 (dev)"
            spellCheck={false}
          />
          {agent.overrideUrl.trim() !== "" && (
            <>
              <label className="mt-2 mb-1 block text-xs text-muted-foreground">
                Token for that agent (kept for this session only)
              </label>
              <Input
                type="password"
                value={agent.overrideToken}
                onChange={(e) => agent.setOverrideToken(e.target.value)}
                placeholder="AGENT_TOKEN, when the agent sets one"
                autoComplete="off"
                spellCheck={false}
              />
            </>
          )}
          <div className="mt-2 space-y-2">
            <AgentIdentityDetails identity={agent.identity} />
            <UnsupportedFeatures identity={agent.identity} />
          </div>
          <label className="mt-3 flex items-start gap-2 text-xs">
            <Checkbox
              checked={agent.questionCards}
              onCheckedChange={(checked) => agent.setQuestionCards(checked === true)}
              className="mt-0.5"
            />
            <span>
              Clickable answer options
              <span className="block text-muted-foreground">
                Off, the agent's questions are shown as plain text and answered by typing.
              </span>
            </span>
          </label>
        </div>
      )}

      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="gap-4 px-3 py-3">
          <EditorFileContext.Provider value={agent.editorFile}>
          <AttachmentLoaderContext.Provider value={attachmentLimits ? agent.attachmentBlob : null}>
          {agent.messages.length === 0 && (
            <AgentEmptyState
              identity={agent.identity}
              // A starter is a whole request: it replaces what was typed.
              onPick={(prompt) => {
                agent.setComposerText(prompt);
                composerInput.current?.focus();
              }}
            />
          )}
          {agent.messages.map((m, i) => (
            <Fragment key={m.id}>
              <MessageBlock
                message={m}
                questionCards={agent.questionCards}
                // Only the last message's questions are still open: anything
                // earlier has been answered, or the user moved on without doing so.
                answerable={i === agent.messages.length - 1 && !agent.locked}
                onAnswer={agent.send}
                // Likewise for resuming: only the conversation's last turn can be
                // continued.
                onRetry={i === agent.messages.length - 1 && agent.canRetry ? agent.retry : undefined}
                actions={actionsFor(m)}
                summaryAnchors={summaries.anchors}
                diffs={turnFeatures.changes}
                onContinue={m.id === continuable ? () => agent.send(CONTINUE_MESSAGE) : undefined}
              />
              {turnFeatures.summary && m.role === "assistant" && m.summary && (
                <TurnSummaryCard turn={m} summary={m.summary} />
              )}
              {summaries.after.get(m.id)?.map((summary, j) => <SummaryDivider key={j} summary={summary} />)}
            </Fragment>
          ))}
          </AttachmentLoaderContext.Provider>
          </EditorFileContext.Provider>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {agent.error && (
        <div className="flex items-start gap-2 border-t border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span className="flex-1">{agent.error}</span>
          {agent.canRetry && (
            <Button variant="outline" size="xs" onClick={agent.retry} className="shrink-0">
              <RotateCw className="size-3" />
              Retry
            </Button>
          )}
        </div>
      )}

      <div className="border-t border-border p-3">
        {queued && (
          <div role="group" aria-label="Queued message" className="mb-2 rounded-md border border-border bg-muted/40 p-2 text-xs">
            <div className="flex items-center gap-1">
              <Clock className="size-3 shrink-0 text-muted-foreground" />
              <span className="flex-1 text-muted-foreground">Queued — sent when this turn finishes</span>
              <Button variant="ghost" size="xs" onClick={agent.editQueued}>
                Edit
              </Button>
              <Button variant="ghost" size="xs" onClick={agent.removeQueued}>
                Remove
              </Button>
            </div>
            {queued.text && <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words">{queued.text}</p>}
            {queued.selections.length > 0 && (
              <p className="mt-1 break-words text-muted-foreground">
                {queued.selections.map(selectionLabel).join(", ")}
              </p>
            )}
            {queued.attachments.length > 0 && (
              <p className="mt-1 break-words text-muted-foreground">
                {queued.attachments.map((a) => `${a.name} (${formatBytes(a.size)})`).join(", ")}
              </p>
            )}
          </div>
        )}
        <AttachmentLoaderContext.Provider value={attachmentLimits ? agent.attachmentBlob : null}>
          <ComposerAttachments
            attachments={agent.composer.attachments}
            fileOf={agent.attachmentFile}
            onRemove={agent.removeAttachment}
            onRetry={agent.retryAttachment}
          />
        </AttachmentLoaderContext.Provider>
        {canCompose && (
          <EditorFileContext.Provider value={agent.editorFile}>
            <ComposerSelections
              carried={agent.composer.selections}
              onRemoveCarried={agent.removeComposerSelection}
              onDropLive={agent.dropSelection}
            />
          </EditorFileContext.Provider>
        )}
        {agent.composerNotice && <p className="mb-2 text-xs text-destructive">{agent.composerNotice}</p>}
        <div className="rounded-xl border border-input bg-background p-1.5 transition-shadow focus-within:border-ring focus-within:ring-4 focus-within:ring-ring/20 has-[textarea:disabled]:opacity-60">
          <Textarea
            ref={composerInput}
            value={text}
            onChange={(e) => agent.setComposerText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              const files = [...event.clipboardData.files];
              if (!canAttach || files.length === 0) return;
              event.preventDefault();
              agent.addAttachments(files);
            }}
            aria-label="Message the agent"
            placeholder={
              archived
                ? "Archived — unarchive to continue"
                : !canCompose
                  ? "Open a workspace first"
                  : agent.locked
                    ? "Queue a message for when this turn finishes…"
                    : "Message the agent…"
            }
            disabled={!canCompose}
            rows={2}
            className="max-h-[50vh] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 disabled:opacity-100 dark:bg-transparent"
          />
          <div className="flex items-center gap-1">
            {canCompose && (
              <>
                <input
                  ref={filePicker}
                  type="file"
                  multiple
                  hidden
                  aria-label="Files to attach"
                  onChange={(event) => {
                    agent.addAttachments([...(event.target.files ?? [])]);
                    event.target.value = "";
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => filePicker.current?.click()}
                  disabled={!canAttach}
                  title={
                    attachmentLimits
                      ? `Attach files — up to ${attachmentLimits.maxPerMessage} per message, ${formatBytes(attachmentLimits.maxBytes)} each. Files can also be dropped on the panel or pasted.`
                      : agent.identity?.state === "known"
                        ? "This agent does not accept file attachments"
                        : "Attach files — available once the agent is running"
                  }
                  aria-label="Attach files"
                >
                  <Paperclip className="size-4" />
                </Button>
              </>
            )}
            {agent.locked && (
              <span
                className="flex min-w-0 items-center gap-1.5 px-1 text-xs text-muted-foreground"
                title="Editing is paused while the agent works."
              >
                <Loader size={12} className="shrink-0" />
                <span className="truncate">
                  {agent.status === "launching"
                    ? "Launching agent…"
                    : agent.status === "seeding"
                      ? "Syncing workspace…"
                      : agent.status === "stopping"
                        ? "Stopping…"
                        : "AI working…"}
                </span>
              </span>
            )}
            {agent.locked && (
              <Button
                variant="outline"
                size="icon-sm"
                onClick={agent.stop}
                disabled={agent.status === "stopping"}
                title="Stop (Esc)"
                aria-label="Stop"
                className="ml-auto rounded-full"
              >
                <Square className="size-3 fill-current" />
              </Button>
            )}
            <Button
              size="icon-sm"
              variant={agent.locked ? "outline" : "default"}
              className={agent.locked ? "rounded-full" : "ml-auto rounded-full"}
              onClick={agent.submitComposer}
              disabled={!hasMessage(agent.composer) || hold !== null || !canCompose}
              title={
                hold === "uploading"
                  ? "Waiting for the files to upload"
                  : hold === "failed"
                    ? "Remove or retry the file that failed first"
                    : agent.locked
                  ? `Queue for when this turn finishes (Enter or ${MOD_KEY_LABEL}Enter) · ${FOCUS_COMPOSER_LABEL} focuses this box`
                  : `Send (Enter or ${MOD_KEY_LABEL}Enter) · ${FOCUS_COMPOSER_LABEL} focuses this box`
              }
              aria-label={agent.locked ? "Queue message" : "Send"}
            >
              {agent.locked ? <ListPlus className="size-4" /> : <ArrowUp className="size-4" />}
            </Button>
          </div>
        </div>
        {/* Keys a phone does not have. */}
        <p className="mt-1.5 px-1 text-[11px] text-muted-foreground max-md:hidden">
          Enter sends · Shift+Enter adds a line
        </p>
      </div>

      {turnActions.dialog}

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start a new conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This clears the current chat and starts the agent over with no history. Your workspace files are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmStartOver}>
              Start over
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
