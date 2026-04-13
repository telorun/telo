import Editor from "@monaco-editor/react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

const STORAGE_KEY = "telo-editor:yaml-state-collapsed";

interface Snapshot {
  filePath: string;
  yaml: string;
}

interface YamlStateViewerProps {
  snapshots: Snapshot[];
  activeFilePath: string | null;
}

export function YamlStateViewer({ snapshots, activeFilePath }: YamlStateViewerProps) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) === "true") setCollapsed(true);
    } catch {}
  }, []);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(STORAGE_KEY, String(next)); } catch {}
      return next;
    });
  }

  const defaultPath = useMemo(() => {
    if (snapshots.length === 0) return undefined;
    if (activeFilePath && snapshots.some((s) => s.filePath === activeFilePath)) return activeFilePath;
    return snapshots[0].filePath;
  }, [snapshots, activeFilePath]);

  if (collapsed) {
    return (
      <div className="flex h-full shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center border-b border-zinc-200 px-2 py-2 dark:border-zinc-800">
          <Button variant="ghost" size="icon-xs" onClick={toggleCollapsed} title="Expand YAML State">
            ‹
          </Button>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <span
            className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500"
            style={{ writingMode: "vertical-rl" }}
            onClick={toggleCollapsed}
          >
            YAML State
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-136 shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          YAML State
        </div>
        <Button variant="ghost" size="icon-xs" onClick={toggleCollapsed} title="Collapse YAML State">
          ›
        </Button>
      </div>

      <Tabs defaultValue={defaultPath} orientation="vertical" className="min-h-0 flex-1 !flex-row gap-0">
        <TabsList variant="line" className="h-auto w-48 shrink-0 flex-col items-stretch justify-start overflow-y-auto rounded-none border-r border-zinc-200 p-0 dark:border-zinc-800">
          {snapshots.map((snapshot) => (
            <TabsTrigger
              key={snapshot.filePath}
              value={snapshot.filePath}
              className="h-auto flex-none justify-start rounded-none border-b border-zinc-100 px-2 py-2 text-left text-xs data-[state=active]:bg-zinc-100 data-[state=active]:text-zinc-900 dark:border-zinc-800 dark:data-[state=active]:bg-zinc-800 dark:data-[state=active]:text-zinc-100"
              title={snapshot.filePath}
            >
              <span className="line-clamp-2 break-all">{snapshot.filePath}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        {snapshots.map((snapshot) => (
          <TabsContent key={snapshot.filePath} value={snapshot.filePath} className="min-h-0 min-w-0">
            <Editor
              height="100%"
              language="yaml"
              value={snapshot.yaml}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                wordWrap: "on",
                scrollBeyondLastLine: false,
                automaticLayout: true,
              }}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
