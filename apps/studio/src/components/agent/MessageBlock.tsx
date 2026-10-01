import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Brain, ChevronDown, CircleStop, ListTree, Play, RotateCw, ScrollText, TriangleAlert } from "lucide-react";
import { describeTurnError, splitAgentText } from "@/agent";
import type { AssistantMessage, AssistantPart, ChatMessage, TurnError, UserMessage } from "@/agent";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Loader } from "@/components/ai-elements/loader";
import { QuestionCard } from "./QuestionCard";
import { MessageActions, type MessageActionHandlers } from "./MessageActions";
import { ToolCard, toolFailed } from "./ToolCard";

export interface MessageBlockProps {
  message: ChatMessage;
  questionCards: boolean;
  answerable: boolean;
  onAnswer: (message: string) => void;
  /** Absent when this turn is not the one to resume. */
  onRetry?: () => void;
  /** The hover actions this message offers; none without. */
  actions?: MessageActionHandlers;
  /** Turns a summary is shown after; a summary of a turn not among them is
   *  shown where it was journaled. */
  summaryAnchors?: ReadonlySet<string>;
  /** Show each write's and edit's own diff on its card. */
  diffs?: boolean;
  /** Present on a turn that spent its step budget and may be continued. */
  onContinue?: () => void;
}

export function MessageBlock({ message, ...props }: MessageBlockProps) {
  return message.role === "user" ? (
    <UserMessageBlock message={message} actions={props.actions} />
  ) : (
    <AssistantMessageBlock message={message} {...props} />
  );
}

function UserMessageBlock({ message, actions }: { message: UserMessage; actions?: MessageActionHandlers }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <Message from="user">
      <MessageContent className={cn(editing !== null && "w-full")}>
        {editing === null ? (
          <div className="whitespace-pre-wrap">{message.text}</div>
        ) : (
          <EditResend
            text={editing}
            onChange={setEditing}
            onCancel={() => setEditing(null)}
            onSend={() => {
              const text = editing.trim();
              if (!text) return;
              setEditing(null);
              actions?.onEditResend?.(text);
            }}
          />
        )}
      </MessageContent>
      {actions && editing === null && (
        <MessageActions
          {...actions}
          copyText={message.text}
          onEdit={actions.onEditResend ? () => setEditing(message.text) : undefined}
          className="justify-end"
        />
      )}
    </Message>
  );
}

function EditResend({
  text,
  onChange,
  onCancel,
  onSend,
}: {
  text: string;
  onChange: (text: string) => void;
  onCancel: () => void;
  onSend: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label="Edit message"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
        autoFocus
        rows={3}
        className="resize-none"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" onClick={onSend} disabled={!text.trim()}>
          Send
        </Button>
      </div>
    </div>
  );
}

/** The agent summarized every turn up to here for its model: the turns stay in
 *  the transcript, and the summary is what the model reads in their place. */
export function SummaryDivider({ summary }: { summary: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Separator className="flex-1" />
        <CollapsibleTrigger className="flex shrink-0 items-center gap-1.5 underline-offset-2 hover:underline">
          <ScrollText className="size-3" />
          Earlier turns were summarized for the agent
          <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
        </CollapsibleTrigger>
        <Separator className="flex-1" />
      </div>
      <CollapsibleContent className="mt-1 whitespace-pre-wrap border-l pl-3 text-xs text-muted-foreground">
        {summary}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Naming the conversation failed in this turn; the turn itself did not. */
function TitleErrorNotice({ error }: { error: TurnError }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <TriangleAlert className="mt-0.5 size-3 shrink-0" />
      <span>
        Couldn't name this conversation — {error.code ?? "error"}: {error.message}. Rename it from the conversation list.
      </span>
    </p>
  );
}

/** The turn's parts in the order they streamed: thinking, cards and text where
 *  each happened. */
function AssistantMessageBlock({
  message,
  questionCards,
  answerable,
  onAnswer,
  onRetry,
  actions,
  summaryAnchors,
  diffs,
  onContinue,
}: Omit<MessageBlockProps, "message"> & { message: AssistantMessage }) {
  const { parts } = message;
  // Only the last text segment can hold an answerable question: anything the
  // turn wrote before a later tool call was not where it ended.
  const lastText = parts.findLastIndex((part) => part.kind === "text");
  const lastTextPart = parts[lastText];
  const questionText = lastTextPart?.kind === "text" ? lastTextPart.text : null;
  // With the cards off the reply renders whole, question block and all, as the
  // markdown it already is. Keyed on the setting so flipping it re-renders the
  // messages already in the transcript rather than only the next ones.
  const segments = useMemo(
    () => (questionCards && questionText !== null ? splitAgentText(questionText) : null),
    [questionText, questionCards],
  );

  const renderPart = (part: AssistantPart, i: number): ReactNode => {
    if (part.kind === "thinking") {
      return (
        <ReasoningCard key={`thinking-${i}`} text={part.text} streaming={!!message.pending && i === parts.length - 1} />
      );
    }
    if (part.kind === "tool") {
      return <ToolCard key={`tool-${i}`} tool={part.tool} diffs={diffs} />;
    }
    if (part.kind === "continued") return <ContinuedDivider key={`continued-${i}`} />;
    if (part.kind === "title-error") return <TitleErrorNotice key={`title-${i}`} error={part.error} />;
    if (part.kind === "summary") {
      return summaryAnchors?.has(part.throughTurnId) ? null : (
        <SummaryDivider key={`summary-${i}`} summary={part.summary} />
      );
    }
    if (i !== lastText || !segments) {
      return <MessageResponse key={`text-${i}`}>{part.text}</MessageResponse>;
    }
    return (
      <Fragment key={`text-${i}`}>
        {segments.map((segment, j) =>
          segment.kind === "text" ? (
            <MessageResponse key={j}>{segment.text}</MessageResponse>
          ) : segment.kind === "questions" ? (
            <QuestionCard
              key={j}
              questions={segment.questions}
              interactive={answerable && !message.pending}
              onAnswer={onAnswer}
            />
          ) : (
            <Loader key={j} size={16} className="text-muted-foreground" />
          ),
        )}
      </Fragment>
    );
  };

  return (
    <Message from="assistant">
      <MessageContent>
        {stepRuns(parts).map(({ from, to }) =>
          to - from < 2 ? (
            renderPart(parts[from], from)
          ) : (
            <StepGroup
              key={`steps-${from}`}
              count={to - from}
              failed={parts.slice(from, to).filter((part) => part.kind === "tool" && toolFailed(part.tool)).length}
              streaming={!!message.pending}
            >
              {parts.slice(from, to).map((part, offset) => renderPart(part, from + offset))}
            </StepGroup>
          ),
        )}
        {message.pending && parts.length === 0 && <Loader size={16} className="text-muted-foreground" />}
        {message.stopped && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CircleStop className="size-3" />
            Stopped
          </div>
        )}
        {message.error && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-destructive">
            <span>{describeTurnError({ code: message.errorCode, message: message.error })}</span>
            {onRetry && (
              <Button variant="outline" size="xs" onClick={onRetry}>
                <RotateCw className="size-3" />
                Resume
              </Button>
            )}
          </div>
        )}
        {onContinue && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>The agent used up its steps for this turn.</span>
            <Button variant="outline" size="xs" onClick={onContinue}>
              <Play className="size-3" />
              Continue
            </Button>
          </div>
        )}
      </MessageContent>
      {actions && <MessageActions {...actions} copyText={replyText(message)} />}
    </Message>
  );
}

/** What Copy takes from a reply: its answer text, without thinking or tools. */
function replyText(message: AssistantMessage): string {
  return message.parts
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join("\n\n");
}

/** Where an interrupted turn was continued: the same turn goes on below. */
function ContinuedDivider() {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Separator className="flex-1" />
      <span className="flex shrink-0 items-center gap-1.5">
        <RotateCw className="size-3" />
        Continued after an interruption
      </span>
      <Separator className="flex-1" />
    </div>
  );
}

/**
 * One segment of the model's summary of its own thinking, where it happened.
 *
 * Open while it is the part still streaming and collapsed once anything follows
 * it, because that is when it stops being the interesting half — unless the
 * reader says otherwise, which is what the override holds. A `defaultOpen` could
 * not do this: the block mounts while it streams, so every finished segment
 * would stay expanded.
 */
function ReasoningCard({ text, streaming }: { text: string; streaming: boolean }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? streaming;

  return (
    <Collapsible open={open} onOpenChange={setOverride}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-2 hover:underline">
        <Brain className="size-3" />
        {streaming ? "Thinking…" : "Thought process"}
        <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 whitespace-pre-wrap border-l pl-3 text-xs text-muted-foreground">
        {text}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The turn's parts as the runs they render in: each stretch of consecutive
 *  tool calls and thinking — what happened between two pieces of the reply —
 *  is one run, and every other part a run of its own. */
function stepRuns(parts: AssistantPart[]): Array<{ from: number; to: number }> {
  const runs: Array<{ from: number; to: number }> = [];
  const isStep = (part: AssistantPart) => part.kind === "tool" || part.kind === "thinking";
  for (let i = 0; i < parts.length; ) {
    let to = i + 1;
    if (isStep(parts[i])) while (to < parts.length && isStep(parts[to])) to++;
    runs.push({ from: i, to });
    i = to;
  }
  return runs;
}

/**
 * Two or more steps in a row, folded into one line. Open while the turn
 * streams — that is where the work is — and folded once it has ended, when the
 * reply is what is read; the reader's own toggle overrides either.
 */
function StepGroup({
  count,
  failed,
  streaming,
  children,
}: {
  count: number;
  failed: number;
  streaming: boolean;
  children: ReactNode;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? streaming;

  return (
    <Collapsible open={open} onOpenChange={setOverride}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-2 hover:underline">
        <ListTree className="size-3" />
        {count} steps
        {failed > 0 && <span className="text-destructive">· {failed} failed</span>}
        <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex flex-col gap-2 border-l pl-3">{children}</CollapsibleContent>
    </Collapsible>
  );
}
