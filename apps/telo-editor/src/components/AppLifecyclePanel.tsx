import { useState } from "react";
import { Button } from "./ui/button";

interface AppLifecyclePanelProps {
  hasApplication: boolean;
  creating: boolean;
  onCreate: (name: string) => void;
  onCancelCreate: () => void;
  onNew: () => void;
  onOpen: () => void;
}

export function AppLifecyclePanel({
  hasApplication,
  creating,
  onCreate,
  onCancelCreate,
  onNew,
  onOpen,
}: AppLifecyclePanelProps) {
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
          <Button size="sm" onClick={handleCreate} disabled={!name.trim()}>
            Create
          </Button>
          <Button variant="ghost" size="sm" onClick={handleCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-1 items-center justify-center gap-3 bg-zinc-50 dark:bg-zinc-900">
      <Button variant="outline" onClick={onNew}>
        New application
      </Button>
      <Button variant="outline" onClick={onOpen}>
        Open file
      </Button>
    </div>
  );
}
