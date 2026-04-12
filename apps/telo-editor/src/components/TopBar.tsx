import type { Application, NavigationEntry } from '../model'
import { Button } from './ui/button'

interface TopBarProps {
  application: Application | null
  navigationStack: NavigationEntry[]
  onNew: () => void
  onOpen: () => void
  onPopTo: (index: number) => void
  onOpenSettings: () => void
}

export function TopBar({ application, navigationStack, onNew, onOpen, onPopTo, onOpenSettings }: TopBarProps) {
  const moduleEntries = navigationStack.filter(e => e.type === 'module')

  return (
    <div className="flex h-10 items-center border-b border-zinc-200 bg-white px-4 text-sm dark:border-zinc-800 dark:bg-zinc-950">
      <span className="font-semibold text-zinc-900 dark:text-zinc-100">Telo Editor</span>

      <div className="mx-4 flex flex-1 items-center gap-1 text-zinc-500 dark:text-zinc-400 overflow-hidden">
        {moduleEntries.map((entry, i) => {
          if (entry.type !== 'module') return null
          const manifest = application?.modules.get(entry.filePath)
          const name = manifest?.metadata.name ?? entry.filePath.split('/').pop() ?? '?'
          const isLast = i === moduleEntries.length - 1
          return (
            <span key={entry.filePath} className="flex items-center gap-1 min-w-0">
              {i > 0 && <span className="text-zinc-300 dark:text-zinc-700">›</span>}
              {isLast ? (
                <span className="truncate text-zinc-700 dark:text-zinc-300">{name}</span>
              ) : (
                <button
                  onClick={() => onPopTo(navigationStack.indexOf(entry))}
                  className="truncate hover:text-zinc-900 dark:hover:text-zinc-100"
                >
                  {name}
                </button>
              )}
            </span>
          )
        })}
      </div>

      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={onNew}>
          New
        </Button>
        <Button variant="ghost" size="sm" onClick={onOpen}>
          Open
        </Button>
        <Button variant="ghost" size="sm" disabled>
          Save
        </Button>
        <Button variant="ghost" size="sm" disabled>
          Run
        </Button>
        <Button variant="ghost" size="sm" onClick={onOpenSettings}>
          Settings
        </Button>
      </div>
    </div>
  )
}
