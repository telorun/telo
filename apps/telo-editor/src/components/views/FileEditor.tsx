import Editor from "@monaco-editor/react";
import { FileWarning } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isBinaryFile, languageForFile } from "../../file-types";
import { pathBasename } from "../../loader/paths";
import { useMonacoTheme } from "../../theme/color-mode";

const DEBOUNCE_MS = 500;

interface FileEditorProps {
  filePath: string;
  readFile: (path: string) => Promise<string>;
  saveFile: (path: string, text: string) => Promise<void>;
  /** True while the authoring agent holds the workspace — the buffer renders
   *  read-only (saves are also rejected upstream, but typing must be blocked
   *  visibly, not swallowed at save time). */
  readOnly?: boolean;
}

/** Raw-text editor for a non-telo workspace file. Loads content via the
 *  workspace adapter, edits in Monaco, and autosaves on a debounce. Binary
 *  files render a placeholder instead of feeding garbage into the editor.
 *  Keyed by `filePath` at the call site, so switching tabs remounts with the
 *  next file's content; an unsaved buffer is flushed on unmount. */
export function FileEditor({ filePath, readFile, saveFile, readOnly = false }: FileEditorProps) {
  const binary = isBinaryFile(filePath);
  const monacoTheme = useMonacoTheme();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest unsaved text, mirrored for the flush-on-unmount path (state is stale
  // inside the cleanup closure).
  const pendingRef = useRef<string | null>(null);

  useEffect(() => {
    if (binary) return;
    let cancelled = false;
    setText(null);
    setError(null);
    readFile(filePath)
      .then((content) => {
        if (!cancelled) setText(content);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, binary, readFile]);

  // Flush a pending edit when the editor unmounts (tab switch / close) so a
  // sub-debounce buffer isn't lost.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      const pending = pendingRef.current;
      if (pending !== null) {
        // Component is unmounting (tab switch/close), so we can't surface this
        // in the UI — log instead of swallowing so a failed final save is
        // visible rather than silent data loss.
        saveFile(filePath, pending).catch((err) =>
          console.error(`Failed to save ${filePath} on close:`, err),
        );
      }
      pendingRef.current = null;
    };
  }, [filePath, saveFile]);

  function handleChange(value: string | undefined) {
    if (value === undefined) return;
    setText(value);
    pendingRef.current = value;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      pendingRef.current = null;
      saveFile(filePath, value).catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
    }, DEBOUNCE_MS);
  }

  if (binary) {
    return (
      <Surface>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-zinc-400 dark:text-zinc-600">
          <FileWarning className="size-8" />
          <p className="text-sm">Can't preview this file type</p>
          <p className="text-xs">{pathBasename(filePath)}</p>
        </div>
      </Surface>
    );
  }

  if (error) {
    return (
      <Surface>
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-red-500 dark:text-red-400">
          {error}
        </div>
      </Surface>
    );
  }

  if (text === null) {
    return (
      <Surface>
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-400 dark:text-zinc-600">
          Loading…
        </div>
      </Surface>
    );
  }

  return (
    <Surface>
      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          theme={monacoTheme}
          language={languageForFile(filePath)}
          defaultValue={text}
          onChange={handleChange}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            wordWrap: "on",
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            readOnly,
            readOnlyMessage: { value: "Editing is paused while the agent is working." },
            fixedOverflowWidgets: true,
          }}
        />
      </div>
    </Surface>
  );
}

function Surface({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-white dark:bg-zinc-950">
      {children}
    </div>
  );
}
