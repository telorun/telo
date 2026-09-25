import { Fragment, useMemo, useState } from "react";
import { Brain, ChevronDown, RotateCw } from "lucide-react";
import { splitAgentText } from "@/agent";
import type { AssistantMessage, ChatMessage, ToolCallView, UserMessage } from "@/agent";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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

export interface MessageBlockProps {
  message: ChatMessage;
  questionCards: boolean;
  answerable: boolean;
  onAnswer: (message: string) => void;
  /** Absent when this turn is not the one to resume. */
  onRetry?: () => void;
}

export function MessageBlock({ message, ...props }: MessageBlockProps) {
  return message.role === "user" ? (
    <UserMessageBlock message={message} />
  ) : (
    <AssistantMessageBlock message={message} {...props} />
  );
}

function UserMessageBlock({ message }: { message: UserMessage }) {
  return (
    <Message from="user">
      <MessageContent>
        {message.resumedRequest !== undefined ? (
          // A resume message repeats the request and adds a report of what the
          // interrupted turn's tools already did. The request is what the user
          // wrote and stays in plain view; the report is collapsed, because it
          // is generated and long — but reachable, since it is what the agent
          // was actually sent.
          <Collapsible>
            <div className="whitespace-pre-wrap">{message.resumedRequest}</div>
            <CollapsibleTrigger className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
              Resumed after an interruption — show what the agent was told
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
              {message.text}
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <div className="whitespace-pre-wrap">{message.text}</div>
        )}
      </MessageContent>
    </Message>
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
        {message.error && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-destructive">
            <span>{message.error}</span>
            {onRetry && (
              <Button variant="outline" size="xs" onClick={onRetry}>
                <RotateCw className="size-3" />
                Resume
              </Button>
            )}
          </div>
        )}
      </MessageContent>
    </Message>
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

function ToolCallCard({ tool }: { tool: ToolCallView }) {
  const checkFailed = tool.checkExitCode != null && tool.checkExitCode !== 0;
  const errored = tool.state === "error" || checkFailed;
  const state: ToolUIState =
    tool.state === "running" ? "input-available" : errored ? "output-error" : "output-available";
  const errorText = errored
    ? (tool.checkOutput || (typeof tool.output === "string" ? tool.output : undefined))
    : undefined;
  const output = errored ? undefined : (tool.checkOutput || tool.output);

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
