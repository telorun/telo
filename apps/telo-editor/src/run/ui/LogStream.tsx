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
    <div className="flex h-full flex-1 flex-col bg-zinc-950 font-mono text-xs text-zinc-200">
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

// Why the selection rules are duplicated onto descendants AND use `!`:
// <Ansi> renders inline `style="color: ..."` on spans. Some browsers honor
// that during selection and drop the ancestor's ::selection rule, so the
// highlighted text kept its ANSI color but the selection background never
// appeared. `[&_*]:` hits descendants' ::selection; `!` forces the color past
// inline-style specificity so ANSI spans can't win during selection.
const SELECTION_CLASSES =
  "selection:bg-amber-400 selection:!text-black [&_*]:selection:bg-amber-400 [&_*]:selection:!text-black";

function LogRow({ line }: { line: LogLine }) {
  // Both stdout and stderr render in the same base color so ANSI escapes
  // drive the actual text colors. Stderr gets a subtle red left border as a
  // visual hint without hijacking the text color (many CLIs, including pino,
  // write all output to stderr — coloring the whole row red would make the
  // log view monochrome red).
  const borderClass =
    line.stream === "stderr" ? "border-l-2 border-red-500/60" : "border-l-2 border-transparent";
  return (
    <div className={`whitespace-pre-wrap break-words px-3 py-[1px] ${borderClass} ${SELECTION_CLASSES}`}>
      <Ansi>{line.text}</Ansi>
    </div>
  );
}
