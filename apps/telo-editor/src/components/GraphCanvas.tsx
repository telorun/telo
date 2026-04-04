"use client";

import { useState } from "react";
import type { MatcherSelection, ParsedResource } from "../model";
import { RouterTopologyCanvas } from "./RouterTopologyCanvas";

interface GraphCanvasProps {
  hasApplication: boolean;
  creating: boolean;
  graphResource: ParsedResource | null;
  graphTopology?: string;
  graphSchema?: Record<string, unknown>;
  onUpdateResource: (kind: string, name: string, fields: Record<string, unknown>) => void;
  onSelectMatcher: (selection: MatcherSelection) => void;
  onCreate: (name: string) => void;
  onCancelCreate: () => void;
  onNew: () => void;
  onOpen: () => void;
  onClearSelection: () => void;
}

export function GraphCanvas({
  hasApplication,
  creating,
  graphResource,
  graphTopology,
  graphSchema,
  onUpdateResource,
  onSelectMatcher,
  onCreate,
  onCancelCreate,
  onNew,
  onOpen,
  onClearSelection,
}: GraphCanvasProps) {
  const [name, setName] = useState("");

  function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setName("");
    onCreate(trimmed);
  }

  function handleCancel() {
    setName("");
    onCancelCreate();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleCreate();
    if (e.key === "Escape") handleCancel();
  }

  if (creating) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 bg-zinc-50 dark:bg-zinc-900">
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Application name
        </span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="MyApp"
          className="w-56 rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />
        <div className="flex gap-2">
          <button
            onClick={handleCreate}
            disabled={!name.trim()}
            className="rounded bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white disabled:opacity-40 hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Create
          </button>
          <button
            onClick={handleCancel}
            className="rounded px-4 py-1.5 text-xs font-medium text-zinc-500 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (!hasApplication) {
    return (
      <div className="flex h-full flex-1 items-center justify-center gap-3 bg-zinc-50 dark:bg-zinc-900">
        <button
          onClick={onNew}
          className="rounded border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
        >
          New application
        </button>
        <button
          onClick={onOpen}
          className="rounded border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
        >
          Open file
        </button>
      </div>
    );
  }

  if (graphTopology === "Router" && graphResource && graphSchema) {
    return (
      <RouterTopologyCanvas
        resource={graphResource}
        schema={graphSchema}
        onUpdateResource={onUpdateResource}
        onSelectMatcher={onSelectMatcher}
        onBackgroundClick={onClearSelection}
      />
    );
  }

  return (
    <div
      className="flex h-full flex-1 items-center justify-center bg-zinc-50 dark:bg-zinc-900"
      onClick={onClearSelection}
    >
      <span className="text-sm text-zinc-400 dark:text-zinc-600 pointer-events-none">
        {graphResource
          ? `${graphResource.kind} does not have a canvas renderer yet`
          : "Select a topology-aware resource to open its canvas"}
      </span>
    </div>
  );
}
