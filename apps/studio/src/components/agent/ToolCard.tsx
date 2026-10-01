import { useState, type ReactNode } from "react";
import { CheckCircleIcon, ChevronDownIcon, WrenchIcon, XCircleIcon } from "lucide-react";
import type { CheckDiagnostic, ToolCallView } from "@/agent";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { DiffHunks, LineCounts } from "./DiffHunks";
import { JsonTree } from "./JsonTree";
import { WorkspaceFileLink } from "./WorkspaceFileLink";

export interface ToolCardProps {
  tool: ToolCallView;
  /** Show a file tool's own diff — only an agent serving `turn-changes` sends one. */
  diffs?: boolean;
}

/** A call that did not do what it was asked: a tool error, a command that
 *  exited non-zero, or a write, edit or check whose `telo check` did. */
export function toolFailed(tool: ToolCallView): boolean {
  return (
    tool.state === "error" ||
    (tool.checkExitCode != null && tool.checkExitCode !== 0) ||
    (tool.run !== undefined && tool.run.exitCode !== 0)
  );
}

/**
 * One tool call, drawn by what its structured result HOLDS — never by the
 * tool's name, since the tools an agent reaches through MCP are not this
 * client's vocabulary: a check verdict (with the call's diff, when it has one),
 * a command's exit code and output, or any other structured result as a tree.
 * A call still running, one that failed outright and one whose agent reports no
 * structured result show the text the model was given.
 */
export function ToolCard({ tool, diffs = false }: ToolCardProps) {
  if (tool.state === "done") {
    if (tool.checkExitCode != null || (diffs && tool.changes !== undefined)) {
      return <FileToolCard tool={tool} diffs={diffs} />;
    }
    if (tool.run !== undefined) return <RunCard tool={tool} run={tool.run} />;
    if (tool.structured !== undefined) return <StructuredCard tool={tool} />;
  }
  return <TextCard tool={tool} />;
}

function TextCard({ tool }: { tool: ToolCallView }) {
  const failed = tool.state === "error";
  const seen = typeof tool.output === "string" ? tool.output : undefined;
  return (
    <Tool defaultOpen={failed}>
      <ToolHeader
        type={`tool-${tool.name}`}
        title={tool.name}
        state={tool.state === "running" ? "input-available" : failed ? "output-error" : "output-available"}
      />
      <ToolContent>
        {tool.args != null && <ToolInput input={tool.args} />}
        <ToolOutput output={failed ? undefined : tool.output} errorText={failed ? seen : undefined} />
      </ToolContent>
    </Tool>
  );
}

/** The card the structured results share: the name and its verdict stay in
 *  view, `aside` beside them, the rest behind the toggle. */
function Shell({
  tool,
  failed,
  aside,
  children,
}: {
  tool: ToolCallView;
  failed: boolean;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={failed} className="group/tool not-prose mb-4 w-full rounded-md border">
      <div className="flex items-center gap-2 p-3">
        <CollapsibleTrigger className="flex shrink-0 items-center gap-2">
          <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]/tool:rotate-180" />
          <WrenchIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">{tool.name}</span>
        </CollapsibleTrigger>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-xs">{aside}</div>
        {failed ? (
          <XCircleIcon className="size-4 shrink-0 text-red-600" aria-label="Failed" />
        ) : (
          <CheckCircleIcon className="size-4 shrink-0 text-green-600" aria-label="Completed" />
        )}
      </div>
      <CollapsibleContent className="space-y-2 px-3 pb-3 text-xs">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** An argument a headline can carry: a scalar, or a list of them. */
function headlineText(value: unknown): string | null {
  if (!Array.isArray(value)) return scalarText(value);
  const items = value.map(scalarText);
  return items.length > 0 && items.every((item) => item !== null) ? items.join(" ") : null;
}

function argumentEntries(args: unknown): Array<[string, unknown]> {
  return args && typeof args === "object" && !Array.isArray(args) ? Object.entries(args) : [];
}

/** The call's scalar arguments, as its headline. */
function Arguments({ args }: { args: unknown }) {
  const shown = argumentEntries(args).flatMap(([key, value]) => {
    const text = headlineText(value);
    return text === null ? [] : [{ key, text }];
  });
  if (shown.length === 0) return null;
  return (
    <span className="min-w-0 truncate text-muted-foreground">
      {shown.map(({ key, text }) => `${key}: ${text}`).join(" · ")}
    </span>
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
            <li key={i}>
              <WorkspaceFileLink path={d.file} line={d.line} column={d.column} className="text-inherit">
                {diagnosticLine(d)}
              </WorkspaceFileLink>
            </li>
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
 * A write, an edit, a check or a removal. The verdict is the structured
 * result's: a `telo check` that exited non-zero is an error listing its
 * diagnostics, each opening its file at its line; a clean one is one line.
 * With `diffs`, the call's own change replaces its parameters and the model's
 * text: the hunks of a write or an edit, the files of a removal — after the
 * diagnostics, which are what a failed check is opened for.
 */
function FileToolCard({ tool, diffs }: { tool: ToolCallView; diffs: boolean }) {
  const checkFailed = tool.checkExitCode != null && tool.checkExitCode !== 0;
  const changes = diffs ? tool.changes : undefined;
  const hunks = changes ? tool.hunks : undefined;
  const seen = typeof tool.output === "string" ? tool.output : undefined;

  return (
    <Shell
      tool={tool}
      failed={checkFailed}
      aside={
        <>
          {tool.path !== undefined ? (
            <WorkspaceFileLink path={tool.path} line={hunks?.[0]?.newStart} className="truncate font-mono" />
          ) : (
            changes && <span className="text-muted-foreground">{fileCount(changes.length)}</span>
          )}
          {changes?.length === 1 && <LineCounts change={changes[0]} />}
          {tool.checkExitCode != null &&
            (checkFailed ? (
              <Badge variant="destructive">check failed</Badge>
            ) : (
              <span className="text-muted-foreground">check: clean</span>
            ))}
        </>
      }
    >
      {!changes && tool.args != null && <ToolInput input={tool.args} className="p-0" />}
      {checkFailed && (
        <ToolOutput
          className="p-0"
          output={<CheckVerdict diagnostics={tool.diagnostics ?? []} seen={changes ? undefined : seen} />}
          errorText={`telo check exited with ${tool.checkExitCode}`}
        />
      )}
      {hunks && hunks.length > 0 && <DiffHunks hunks={hunks} />}
      {changes && tool.path !== undefined && changes.length === 0 && (
        <p className="text-muted-foreground">The file already held this content.</p>
      )}
      {changes && tool.path !== undefined && changes.length > 0 && hunks === null && (
        <p className="text-muted-foreground">No line diff: the file is not text, or is too large to compare.</p>
      )}
      {changes && tool.path === undefined && (
        <ul className="space-y-0.5">
          {changes.map((change) => (
            <li key={change.path} className="flex items-center gap-2">
              <span className="text-muted-foreground">{change.status}</span>
              {change.status === "deleted" ? (
                <span className="font-mono">{change.path}</span>
              ) : (
                <WorkspaceFileLink path={change.path} className="font-mono" />
              )}
              <LineCounts change={change} />
            </li>
          ))}
        </ul>
      )}
      {!changes && !checkFailed && <ToolOutput className="p-0" output={tool.output} />}
    </Shell>
  );
}

export function fileCount(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}

const TAIL_LINES = 20;

/** A command's result: its exit code, and the end of what it printed — where a
 *  run says how it went — with everything it printed, stderr included, behind
 *  the toggle. */
function RunCard({ tool, run }: { tool: ToolCallView; run: NonNullable<ToolCallView["run"]> }) {
  const [full, setFull] = useState(false);
  const lines = run.output.replace(/\n$/, "").split("\n");
  const more = lines.length > TAIL_LINES || run.messages !== "";
  const stdout = full ? run.output : lines.slice(-TAIL_LINES).join("\n");

  return (
    <Shell
      tool={tool}
      failed={run.exitCode !== 0}
      aside={
        <>
          <Arguments args={tool.args} />
          <Badge variant={run.exitCode === 0 ? "secondary" : "destructive"}>exit {run.exitCode}</Badge>
        </>
      }
    >
      {run.output === "" ? (
        <p className="text-muted-foreground">It printed nothing.</p>
      ) : (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono">{stdout}</pre>
      )}
      {full && run.messages !== "" && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">stderr</div>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono">{run.messages}</pre>
        </div>
      )}
      {more && (
        <Button variant="ghost" size="xs" onClick={() => setFull((shown) => !shown)}>
          {full ? "Show the last lines only" : "Show full output"}
        </Button>
      )}
    </Shell>
  );
}

type ContentPart = { type: "text"; text: string } | { type: "image"; mediaType?: string };

/** A result that is content parts — text and images — rather than data. */
function contentParts(value: unknown): ContentPart[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const parts: ContentPart[] = [];
  for (const item of value) {
    const part = item as { type?: unknown; text?: unknown; mediaType?: unknown } | null;
    if (part && part.type === "text" && typeof part.text === "string") parts.push({ type: "text", text: part.text });
    else if (part && part.type === "image") {
      parts.push({ type: "image", ...(typeof part.mediaType === "string" ? { mediaType: part.mediaType } : {}) });
    } else return null;
  }
  return parts;
}

/**
 * Any other structured result — what a lookup through MCP returns. The
 * headline is the call's scalar arguments; the result's text parts are shown
 * as text, and data as a tree.
 */
function StructuredCard({ tool }: { tool: ToolCallView }) {
  const parts = contentParts(tool.structured);
  const nested = argumentEntries(tool.args).filter(([, value]) => headlineText(value) === null);

  return (
    <Shell tool={tool} failed={false} aside={<Arguments args={tool.args} />}>
      {nested.length > 0 && <JsonTree value={Object.fromEntries(nested)} />}
      {parts ? (
        parts.map((part, i) =>
          part.type === "text" ? (
            <pre key={i} className="whitespace-pre-wrap break-words font-mono">
              {part.text}
            </pre>
          ) : (
            <p key={i} className="text-muted-foreground">
              An image{part.mediaType ? ` (${part.mediaType})` : ""}.
            </p>
          ),
        )
      ) : (
        <JsonTree value={tool.structured} />
      )}
    </Shell>
  );
}
