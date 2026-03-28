import type { ParsedManifest } from '../model'

interface SidebarProps {
  activeManifest: ParsedManifest | null
  selectedResource: { kind: string; name: string } | null
  onSelectResource: (kind: string, name: string) => void
  onClearSelection: () => void
  onOpenModule: (filePath: string) => void
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
      {label}
    </div>
  )
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="px-4 py-1 text-xs italic text-zinc-400 dark:text-zinc-600">{text}</div>
  )
}

export function Sidebar({ activeManifest, selectedResource, onSelectResource, onClearSelection, onOpenModule }: SidebarProps) {
  const moduleImports = activeManifest?.imports.filter(i => i.importKind === 'submodule') ?? []
  const remoteImports = activeManifest?.imports.filter(i => i.importKind === 'remote') ?? []
  const definitions = activeManifest?.resources.filter(r => r.kind === 'Kernel.Definition') ?? []

  const rowBase = 'flex items-center gap-1.5 px-4 py-0.5 cursor-default select-none'
  const rowHover = 'hover:bg-zinc-100 dark:hover:bg-zinc-900'

  return (
    <div className="flex h-full w-56 flex-col overflow-y-auto border-r border-zinc-200 bg-white text-sm dark:border-zinc-800 dark:bg-zinc-950">

      {/* Modules */}
      <div className="pb-1 pt-3">
        <SectionHeader label="Modules" />
        {moduleImports.length === 0 && <EmptyHint text="No submodules" />}
        {moduleImports.map(imp => (
          <div
            key={imp.name}
            className={`${rowBase} ${rowHover} cursor-pointer text-zinc-700 dark:text-zinc-300`}
            onClick={() => imp.resolvedPath && onOpenModule(imp.resolvedPath)}
          >
            <span className="text-zinc-400">⊟</span>
            {imp.name}
          </div>
        ))}
      </div>

      <div className="mx-3 border-t border-zinc-100 dark:border-zinc-800" />

      {/* Imports */}
      <div className="pb-1 pt-2">
        <SectionHeader label="Imports" />
        {remoteImports.length === 0 && <EmptyHint text="No imports" />}
        {remoteImports.map(imp => (
          <div key={imp.name} className={`${rowBase} text-zinc-500 dark:text-zinc-400`}>
            {imp.name}
          </div>
        ))}
      </div>

      <div className="mx-3 border-t border-zinc-100 dark:border-zinc-800" />

      {/* Definitions */}
      <div className="pb-1 pt-2">
        <SectionHeader label="Definitions" />
        {definitions.length === 0 && <EmptyHint text="No definitions" />}
        {definitions.map(r => (
          <div
            key={r.name}
            className={`${rowBase} ${selectedResource?.name === r.name ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100' : `text-zinc-600 dark:text-zinc-400 ${rowHover}`}`}
            onClick={() => onSelectResource(r.kind, r.name)}
          >
            {r.name}
          </div>
        ))}
      </div>

      <div className="mx-3 border-t border-zinc-100 dark:border-zinc-800" />

      {/* Library */}
      <div className="pb-1 pt-2">
        <SectionHeader label="Library" />
        <EmptyHint text="(requires definition registry)" />
      </div>
    </div>
  )
}
