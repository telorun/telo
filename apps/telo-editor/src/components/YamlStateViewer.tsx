"use client";

import Editor from "@monaco-editor/react";
import { useMemo, useState } from "react";

interface Snapshot {
  filePath: string;
  yaml: string;
}

interface YamlStateViewerProps {
  snapshots: Snapshot[];
  activeFilePath: string | null;
}

export function YamlStateViewer({ snapshots, activeFilePath }: YamlStateViewerProps) {
  const [userSelectedPath, setUserSelectedPath] = useState<string | null>(null);

  const selectedPath = useMemo(() => {
    if (snapshots.length === 0) return null;
    const snapshotPaths = new Set(snapshots.map((s) => s.filePath));
    if (userSelectedPath && snapshotPaths.has(userSelectedPath)) return userSelectedPath;
    if (activeFilePath && snapshotPaths.has(activeFilePath)) return activeFilePath;
    return snapshots[0].filePath;
  }, [snapshots, activeFilePath, userSelectedPath]);

  const selected = useMemo(
    () => snapshots.find((snapshot) => snapshot.filePath === selectedPath) ?? null,
    [snapshots, selectedPath],
  );

  if (snapshots.length === 0) {
    return (
      <div className="flex h-full w-136 shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="border-b border-zinc-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          YAML State
        </div>
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-400 dark:text-zinc-600">
          Open or create an application to view YAML state.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-136 shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="border-b border-zinc-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        YAML State
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-48 shrink-0 overflow-y-auto border-r border-zinc-200 dark:border-zinc-800">
          {snapshots.map((snapshot) => {
            const selectedRow = snapshot.filePath === selectedPath;
            return (
              <button
                key={snapshot.filePath}
                type="button"
                onClick={() => setUserSelectedPath(snapshot.filePath)}
                className={`w-full border-b border-zinc-100 px-2 py-2 text-left text-xs dark:border-zinc-800 ${
                  selectedRow
                    ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                    : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-900"
                }`}
                title={snapshot.filePath}
              >
                <span className="line-clamp-2 break-all">{snapshot.filePath}</span>
              </button>
            );
          })}
        </div>

        <div className="min-h-0 min-w-0 flex-1">
          <Editor
            height="100%"
            language="yaml"
            value={selected?.yaml ?? ""}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              automaticLayout: true,
            }}
          />
        </div>
      </div>
    </div>
  );
}
