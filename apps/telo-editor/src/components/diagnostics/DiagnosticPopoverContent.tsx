import { useState } from "react";
import { DiagnosticSeverity, type AnalysisDiagnostic, type Range } from "@telorun/analyzer";
import { UNKNOWN_FILE_KEY } from "../../analysis";
import type { LocatedDiagnostic } from "../../diagnostics-aggregate";
import { Button } from "../ui/button";

interface Props {
  diagnostics: LocatedDiagnostic[];
  onNavigate?: (filePath: string, range?: Range) => void;
}

const SEVERITY_LABEL: Record<DiagnosticSeverity, string> = {
  [DiagnosticSeverity.Error]: "Error",
  [DiagnosticSeverity.Warning]: "Warning",
  [DiagnosticSeverity.Information]: "Info",
  [DiagnosticSeverity.Hint]: "Hint",
};

const SEVERITY_CHIP_CLASS: Record<DiagnosticSeverity, string> = {
  [DiagnosticSeverity.Error]: "bg-red-500/10 text-red-600 dark:text-red-400",
  [DiagnosticSeverity.Warning]: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  [DiagnosticSeverity.Information]: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  [DiagnosticSeverity.Hint]: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
};

function severityOf(d: AnalysisDiagnostic): DiagnosticSeverity {
  return d.severity ?? DiagnosticSeverity.Error;
}

function basename(path: string): string {
  const ix = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return ix >= 0 ? path.slice(ix + 1) : path;
}

function formatLocation(filePath: string, range: Range | undefined): string {
  const name = basename(filePath);
  if (!range) return name;
  return `${name}:${range.start.line + 1}:${range.start.character + 1}`;
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function onClick() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <Button type="button" variant="ghost" size="xs" onClick={onClick}>
      {copied ? "Copied" : label}
    </Button>
  );
}

function DiagnosticBlock({
  located,
  onNavigate,
}: {
  located: LocatedDiagnostic;
  onNavigate?: (filePath: string, range?: Range) => void;
}) {
  const { filePath, diagnostic: d } = located;
  const sev = severityOf(d);
  const sevLabel = SEVERITY_LABEL[sev];
  const isUnknown = filePath === UNKNOWN_FILE_KEY;
  const fieldPath =
    typeof (d.data as { path?: unknown } | undefined)?.path === "string"
      ? (d.data as { path: string }).path
      : null;

  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 text-[0.7rem] font-medium ${SEVERITY_CHIP_CLASS[sev]}`}
        >
          {sevLabel}
        </span>
        {d.code != null && (
          <span className="font-mono text-[0.7rem] text-muted-foreground">{d.code}</span>
        )}
        {d.source && (
          <span className="text-[0.7rem] text-muted-foreground">· {d.source}</span>
        )}
      </div>
      <pre
        className="whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[0.75rem] leading-relaxed text-foreground select-text"
        style={{ userSelect: "text" }}
      >
        {d.message}
      </pre>
      {fieldPath && (
        <div className="font-mono text-[0.7rem] text-muted-foreground">at {fieldPath}</div>
      )}
      <div className="flex items-center justify-end gap-1">
        {!isUnknown && onNavigate && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onNavigate(filePath, d.range)}
          >
            Open {formatLocation(filePath, d.range)}
          </Button>
        )}
        <CopyButton text={d.message} />
      </div>
    </div>
  );
}

function formatAll(diagnostics: LocatedDiagnostic[]): string {
  return diagnostics
    .map((l) => {
      const sev = SEVERITY_LABEL[severityOf(l.diagnostic)];
      const code = l.diagnostic.code != null ? ` ${l.diagnostic.code}` : "";
      return `[${sev}${code}] ${l.diagnostic.message}`;
    })
    .join("\n\n");
}

export function DiagnosticPopoverContent({ diagnostics, onNavigate }: Props) {
  return (
    <div className="flex max-h-[60vh] flex-col gap-3 overflow-auto">
      {diagnostics.map((l, i) => (
        <div key={i} className={i > 0 ? "border-t border-border/60 pt-3" : undefined}>
          <DiagnosticBlock located={l} onNavigate={onNavigate} />
        </div>
      ))}
      {diagnostics.length > 1 && (
        <div className="flex items-center justify-end border-t border-border/60 pt-2">
          <CopyButton text={formatAll(diagnostics)} label="Copy all" />
        </div>
      )}
    </div>
  );
}
