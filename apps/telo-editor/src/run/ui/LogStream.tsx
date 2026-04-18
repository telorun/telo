import Ansi from "ansi-to-react";
import { Virtuoso } from "react-virtuoso";
import type { LogLine } from "../context";

interface LogStreamProps {
  lines: LogLine[];
  truncated: boolean;
  emptyLabel?: string;
}

export function LogStream({ lines, truncated, emptyLabel }: LogStreamProps) {
  if (lines.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-zinc-400 dark:text-zinc-500">
        {emptyLabel ?? "Waiting for output…"}
      </div>
    );
  }

  // Note: rendering one Virtuoso row per LogLine trades off pretty-printing
  // wrapping for scalability. Each row is a single line of stdout/stderr; a
  // line wrapping across the viewport stays on one virtuoso item (CSS
  // `whitespace-pre-wrap`) rather than being split into multiple.
  return (
    <div className="flex h-full flex-1 flex-col bg-zinc-950 font-mono text-xs text-zinc-200 selection:bg-amber-300 selection:text-zinc-950">
      {truncated && (
        <div className="border-b border-zinc-800 bg-zinc-900 px-3 py-1 text-[10px] text-zinc-500">
          (earlier output truncated — showing last {lines.length} lines)
        </div>
      )}
      <Virtuoso
        style={{ flex: 1 }}
        data={lines}
        computeItemKey={(_index, line) => line.id}
        followOutput="smooth"
        itemContent={(_index, line) => <LogRow line={line} />}
      />
    </div>
  );
}

function LogRow({ line }: { line: LogLine }) {
  const streamClass = line.stream === "stderr" ? "text-red-300" : "text-zinc-200";
  return (
    <div className={`whitespace-pre-wrap break-words px-3 py-[1px] ${streamClass}`}>
      <Ansi>{line.text}</Ansi>
    </div>
  );
}
