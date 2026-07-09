import { useState } from "react";
import { Send, Square, SquarePen, X, ChevronDown } from "lucide-react";
import { useAgent } from "@/agent";
import type { ChatMessage, ToolCallView } from "@/agent";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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

export function AgentPanel({ className }: { className?: string }) {
  const agent = useAgent();
  const [draft, setDraft] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const submit = () => {
    const text = draft.trim();
    if (!text || agent.locked) return;
    agent.send(text);
    setDraft("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const startOver = () => {
    if (agent.messages.length) {
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
    <div className={cn("flex min-w-0 flex-col border-l border-border bg-background", className)}>
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="flex-1 truncate text-sm font-medium">Authoring agent</span>
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
        </div>
      )}

      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="gap-4 px-3 py-3">
          {agent.messages.length === 0 && (
            <ConversationEmptyState
              title="Describe what you want to build"
              description="The agent edits your workspace and validates every change."
            />
          )}
          {agent.messages.map((m) => (
            <MessageBlock key={m.id} message={m} />
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {agent.error && (
        <div className="border-t border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {agent.error}
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
            placeholder={agent.conversationId ? "Message the agent…" : "Open a workspace first"}
            disabled={agent.locked || !agent.conversationId}
            rows={2}
            className="max-h-40 resize-none"
          />
          {agent.locked ? (
            <Button variant="destructive" size="icon" onClick={agent.stop} title="Stop">
              <Square className="size-4" />
            </Button>
          ) : (
            <Button size="icon" onClick={submit} disabled={!draft.trim() || !agent.conversationId} title="Send">
              <Send className="size-4" />
            </Button>
          )}
        </div>
      </div>

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

function MessageBlock({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <Message from="user">
        <MessageContent>
          <div className="whitespace-pre-wrap">{message.text}</div>
        </MessageContent>
      </Message>
    );
  }
  return (
    <Message from="assistant">
      <MessageContent>
        {message.tools.map((t) => (
          <ToolCallCard key={t.toolCallId} tool={t} />
        ))}
        {message.text && <MessageResponse>{message.text}</MessageResponse>}
        {message.pending && !message.text && message.tools.length === 0 && (
          <Loader size={16} className="text-muted-foreground" />
        )}
        {message.error && <div className="text-sm text-destructive">{message.error}</div>}
      </MessageContent>
    </Message>
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
