import Editor from "@monaco-editor/react";
import { useMemo } from "react";
import { getMultiFileSnapshots } from "../../../loader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import type { ViewProps } from "../types";

export function SourceView({ viewData }: ViewProps) {
  const snapshots = useMemo(
    () => getMultiFileSnapshots(viewData.manifest),
    [viewData.manifest],
  );

  if (snapshots.length === 0) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-zinc-50 dark:bg-zinc-900">
        <span className="text-sm text-zinc-400 dark:text-zinc-600">No manifest to display</span>
      </div>
    );
  }

  // Single file — no tabs needed
  if (snapshots.length === 1) {
    return (
      <div className="flex h-full flex-1 flex-col overflow-hidden bg-white dark:bg-zinc-950">
        <div className="flex h-8 shrink-0 items-center border-b border-zinc-200 px-3 dark:border-zinc-800">
          <span className="truncate text-xs text-zinc-500 dark:text-zinc-400" title={snapshots[0].filePath}>
            {snapshots[0].filePath}
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <Editor
            height="100%"
            language="yaml"
            value={snapshots[0].yaml}
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
    );
  }

  // Multi-file — tabs for each file
  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-white dark:bg-zinc-950">
      <Tabs
        defaultValue={snapshots[0].filePath}
        orientation="vertical"
        className="min-h-0 flex-1 !flex-row gap-0"
      >
        <TabsList
          variant="line"
          className="h-auto w-48 shrink-0 flex-col items-stretch justify-start overflow-y-auto rounded-none border-r border-zinc-200 p-0 dark:border-zinc-800"
        >
          {snapshots.map((s) => (
            <TabsTrigger
              key={s.filePath}
              value={s.filePath}
              className="h-auto flex-none justify-start rounded-none border-b border-zinc-100 px-2 py-2 text-left text-xs data-[state=active]:bg-zinc-100 data-[state=active]:text-zinc-900 dark:border-zinc-800 dark:data-[state=active]:bg-zinc-800 dark:data-[state=active]:text-zinc-100"
              title={s.filePath}
            >
              <span className="line-clamp-2 break-all">{s.filePath}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        {snapshots.map((s) => (
          <TabsContent key={s.filePath} value={s.filePath} className="min-h-0 min-w-0">
            <Editor
              height="100%"
              language="yaml"
              value={s.yaml}
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
