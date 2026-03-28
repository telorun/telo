import type { ParsedManifest } from '../model'

interface TopBarProps {
  activeManifest: ParsedManifest | null
  onNew: () => void
  onOpen: () => void
}

export function TopBar({ activeManifest, onNew, onOpen }: TopBarProps) {
  return (
    <div className="flex h-10 items-center border-b border-zinc-200 bg-white px-4 text-sm dark:border-zinc-800 dark:bg-zinc-950">
      <span className="font-semibold text-zinc-900 dark:text-zinc-100">Telo Editor</span>

      <div className="mx-4 flex-1 text-zinc-500 dark:text-zinc-400">
        {activeManifest && (
          <span>{activeManifest.metadata.name}</span>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={onNew}
          className="rounded px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          New
        </button>
        <button
          onClick={onOpen}
          className="rounded px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Open
        </button>
        <button
          disabled
          className="rounded px-3 py-1 text-xs font-medium text-zinc-400 dark:text-zinc-600"
        >
          Save
        </button>
        <button
          disabled
          className="rounded px-3 py-1 text-xs font-medium text-zinc-400 dark:text-zinc-600"
        >
          Run
        </button>
      </div>
    </div>
  )
}
