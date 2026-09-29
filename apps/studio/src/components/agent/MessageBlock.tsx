import { Fragment, useMemo, useState } from "react";
import { Brain, ChevronDown, CircleStop, RotateCw, ScrollText, TriangleAlert } from "lucide-react";
import { describeTurnError, splitAgentText } from "@/agent";
import type { AssistantMessage, ChatMessage, CheckDiagnostic, ToolCallView, TurnError, UserMessage } from "@/agent";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolUIState,
} from "@/components/ai-elements/tool";
import { Loader } from "@/components/ai-elements/loader";
import { QuestionCard } from "./QuestionCard";
import { MessageActions, type MessageActionHandlers } from "./MessageActions";

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

  return (
    <Message from="assistant">
      <MessageContent>
        {parts.map((part, i) => {
          if (part.kind === "thinking") {
            return (
              <ReasoningCard
                key={`thinking-${i}`}
                text={part.text}
                streaming={!!message.pending && i === parts.length - 1}
              />
            );
          }
          if (part.kind === "tool") return <ToolCallCard key={`tool-${i}`} tool={part.tool} />;
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
        })}
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

/** A diagnostic as the agent's own rendering spells it. */
function diagnosticLine(d: CheckDiagnostic): string {
  return `${d.file}:${d.line}:${d.column}${d.code ? ` ${d.code}` : ""} ${d.message}`;
}

function CheckVerdict({ diagnostics, seen }: { diagnostics: CheckDiagnostic[]; seen?: string }) {
  return (
    <div className="space-y-2 p-2">
      {diagnostics.length > 0 && (
        <ul className="font-mono">
          {diagnostics.map((d, i) => (
            <li key={i}>{diagnosticLine(d)}</li>
          ))}
        </ul>
      )}
      {seen && (
        <div className="space-y-1 text-muted-foreground">
          <div className="text-[10px] uppercase tracking-wide">What the model saw</div>
          <pre className="whitespace-pre-wrap font-mono">{seen}</pre>
        </div>
      )}
    </div>
  );
}

/**
 * One tool call. The verdict is the structured result's: a write, edit or
 * check whose `telo check` exited non-zero is an error card listing its
 * diagnostics. The rendered text the model was given is shown as the result,
 * except for a tool that failed outright, whose text is its error.
 */
function ToolCallCard({ tool }: { tool: ToolCallView }) {
  const checkFailed = tool.checkExitCode != null && tool.checkExitCode !== 0;
  const toolFailed = tool.state === "error";
  const errored = toolFailed || checkFailed;
  const state: ToolUIState =
    tool.state === "running" ? "input-available" : errored ? "output-error" : "output-available";
  const seen = typeof tool.output === "string" ? tool.output : undefined;
  const errorText = toolFailed ? seen : checkFailed ? `telo check exited with ${tool.checkExitCode}` : undefined;
  const output = toolFailed ? undefined : checkFailed ? (
    <CheckVerdict diagnostics={tool.diagnostics ?? []} seen={seen} />
  ) : (
    tool.output
  );

  return (
    <Tool defaultOpen={errored}>
      <ToolHeader type={`tool-${tool.name}`} title={tool.name} state={state} />
      <ToolContent>
        {tool.args != null && <ToolInput input={tool.args} />}
        <ToolOutput output={output} errorText={errorText} />
      </ToolContent>
    </Tool>
  );
}
