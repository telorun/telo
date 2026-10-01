import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCw, Send, Square, SquarePen, X, ChevronDown } from "lucide-react";
import {
  AGENT_PANEL_DEFAULT_WIDTH,
  AGENT_PANEL_MIN_WIDTH,
  CONTINUE_MESSAGE,
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
import { AgentIdentityDetails, NoAuthBadge, NoTestRunsBadge, UnsupportedFeatures } from "./AgentIdentity";
import { ConversationSwitcher } from "./ConversationSwitcher";
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
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Loader } from "@/components/ai-elements/loader";

/** Horizontal space the editor keeps while the panel is dragged wider — a panel
 *  dragged past the window would leave nothing to drag it back from. */
const MIN_EDITOR_WIDTH = 360;

export function AgentPanel({ className }: { className?: string }) {
  const agent = useAgent();
  const [draft, setDraft] = useState("");
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

  const submit = () => {
    const text = draft.trim();
    if (!text || agent.locked) return;
    agent.send(text);
    setDraft("");
  };

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
        onEditResend: (text) => turnActions.editResend(turn, text),
        onDeleteFrom: () => turnActions.deleteFrom(turn),
      };
    }
    const request = turnRequest(agent.messages, m.id);
    return {
      busy,
      onRetry: features.truncation && request !== null ? () => turnActions.retry(m.id, request) : undefined,
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
  const canCompose = (agent.conversationId !== null || agent.draft) && !archived;

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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
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
    setDraft("");
  };

  const confirmStartOver = () => {
    agent.clearConversation();
    setDraft("");
    setConfirmClear(false);
  };

  return (
    <div
      ref={frame}
      className={cn("relative flex min-w-0 flex-col border-l border-border bg-background", className)}
      style={{ width: draftWidth ?? agent.panelWidth }}
    >
      <div
        onPointerDown={startDrag}
        onDoubleClick={() => agent.setPanelWidth(AGENT_PANEL_DEFAULT_WIDTH)}
        // Overhangs the border on both sides: a 1px hit area is a border, not a
        // handle. Absolute so it costs the layout nothing.
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-blue-400/60"
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
          {agent.messages.length === 0 && (
            <ConversationEmptyState
              title="Describe what you want to build"
              description="The agent edits your workspace and validates every change."
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
        {agent.locked && (
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader size={14} />
            <span>
              {agent.status === "launching"
                ? "Launching agent…"
                : agent.status === "seeding"
                  ? "Syncing workspace…"
                  : agent.status === "stopping"
                    ? "Stopping…"
                    : "AI working…"}{" "}
              Editing is paused.
            </span>
          </div>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              archived
                ? "Archived — unarchive to continue"
                : canCompose
                  ? "Message the agent…"
                  : "Open a workspace first"
            }
            disabled={agent.locked || !canCompose}
            rows={2}
            className="max-h-40 resize-none"
          />
          {agent.locked ? (
            <Button
              variant="destructive"
              size="icon"
              onClick={agent.stop}
              disabled={agent.status === "stopping"}
              title="Stop"
            >
              <Square className="size-4" />
            </Button>
          ) : (
            <Button size="icon" onClick={submit} disabled={!draft.trim() || !canCompose} title="Send">
              <Send className="size-4" />
            </Button>
          )}
        </div>
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
