import { createContext, useContext, type ReactNode } from "react";
import type { Range } from "@telorun/analyzer";
import { useDiagnosticsContext } from "@/components/diagnostics/DiagnosticsContext";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The editor's file for a path the agent named, or null when it names none.
 *  The panel provides the agent context's mapping; without one, no path is a
 *  file. */
export const EditorFileContext = createContext<(path: string) => string | null>(() => null);

/** Where the editor finds a line and column the agent counted from 1. */
function positionRange(line: number, column = 1): Range {
  const at = { line: Math.max(0, line - 1), character: Math.max(0, column - 1) };
  return { start: at, end: at };
}

/**
 * A path the agent named, opening its file in the editor — at `line` when it
 * has one. Plain text when the path names no editor file, and where there is
 * no editor to open it in.
 */
export function WorkspaceFileLink({
  path,
  line,
  column,
  className,
  children,
}: {
  path: string;
  line?: number | null;
  column?: number;
  className?: string;
  children?: ReactNode;
}) {
  const editor = useDiagnosticsContext();
  const file = useContext(EditorFileContext)(path);
  if (!editor || file === null) return <span className={className}>{children ?? path}</span>;
  return (
    <Button
      variant="link"
      size="xs"
      title={`Open ${path}`}
      className={cn("h-auto min-w-0 justify-start whitespace-normal p-0 text-left", className)}
      onClick={() => editor.navigate(file, line == null ? undefined : positionRange(line, column))}
    >
      {children ?? path}
    </Button>
  );
}
