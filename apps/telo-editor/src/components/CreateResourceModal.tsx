import { useState } from "react";
import type { AvailableKind } from "../model";

interface CreateResourceModalProps {
  kinds: AvailableKind[];
  onClose: () => void;
  onCreate: (kind: string, name: string, fields: Record<string, unknown>) => void;
}

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function capabilityLabel(capability: string): string {
  return capability.replace("Kernel.", "");
}

export function CreateResourceModal({ kinds, onClose, onCreate }: CreateResourceModalProps) {
  const [selectedKind, setSelectedKind] = useState<AvailableKind | null>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);

  function handleSelectKind(kind: AvailableKind) {
    setSelectedKind(kind);
    setName("");
    setNameError(null);
  }

  function handleSubmit() {
    if (!selectedKind) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError("Name is required");
      return;
    }
    if (!NAME_RE.test(trimmedName)) {
      setNameError("Only letters, digits, and underscores; must not start with a digit");
      return;
    }

    onCreate(selectedKind.fullKind, trimmedName, {});
  }

  const inputCls =
    "w-full rounded border border-zinc-300 bg-white px-3 py-1 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400";
  const btnPrimary =
    "rounded bg-zinc-900 px-3 py-1 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
  const btnGhost =
    "rounded px-3 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-110 max-w-full rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-950">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            {selectedKind && (
              <button
                onClick={() => setSelectedKind(null)}
                className="text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
              >
                ←
              </button>
            )}
            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {selectedKind ? `New ${selectedKind.fullKind}` : "Create Resource"}
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="p-4">
          {!selectedKind ? (
            // Step 1: Kind picker
            kinds.length === 0 ? (
              <p className="text-xs text-zinc-400 dark:text-zinc-600">
                No kinds available — add a module import first.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {kinds.map((kind) => (
                  <button
                    key={kind.fullKind}
                    onClick={() => handleSelectKind(kind)}
                    className="flex items-center justify-between rounded border border-zinc-100 bg-zinc-50 px-3 py-2 text-left hover:border-zinc-300 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
                  >
                    <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                      {kind.fullKind}
                    </span>
                    <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400">
                      {capabilityLabel(kind.capability)}
                    </span>
                  </button>
                ))}
              </div>
            )
          ) : (
            // Step 2: Resource name
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Name</label>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSubmit();
                    if (e.key === "Escape") onClose();
                  }}
                  placeholder="my_server"
                  className={inputCls}
                />
                {nameError && <p className="text-xs text-red-500">{nameError}</p>}
              </div>

              <p className="text-xs text-zinc-400 dark:text-zinc-500">
                The empty resource will be created first, then you can edit all fields in the right
                panel.
              </p>

              <div className="flex justify-end gap-2 pt-1">
                <button onClick={onClose} className={btnGhost}>
                  Cancel
                </button>
                <button onClick={handleSubmit} disabled={!name.trim()} className={btnPrimary}>
                  Create
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
