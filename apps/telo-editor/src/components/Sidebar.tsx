import type { ParsedManifest } from '../model'

interface SidebarProps {
  activeManifest: ParsedManifest | null
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
    <div className="px-4 py-1 text-xs text-zinc-400 dark:text-zinc-600 italic">{text}</div>
  )
}

export function Sidebar({ activeManifest }: SidebarProps) {
  const submoduleImports = activeManifest?.imports.filter(i => i.importKind === 'submodule') ?? []
  const remoteImports = activeManifest?.imports.filter(i => i.importKind === 'remote') ?? []

  const flowResources = activeManifest?.resources.filter(
    r => r.kind !== 'Kernel.Definition'
  ) ?? []

  const definitions = activeManifest?.resources.filter(
    r => r.kind === 'Kernel.Definition'
  ) ?? []

  return (
    <div className="flex h-full w-56 flex-col overflow-y-auto border-r border-zinc-200 bg-white text-sm dark:border-zinc-800 dark:bg-zinc-950">

      {/* Imports */}
      <div className="pt-3 pb-1">
        <SectionHeader label="Imports" />
        {submoduleImports.length === 0 && remoteImports.length === 0 && (
          <EmptyHint text="No imports" />
        )}
        {submoduleImports.length > 0 && (
          <>
            <div className="px-3 py-0.5 text-xs text-zinc-400 dark:text-zinc-500">[Submodules]</div>
            {submoduleImports.map(imp => (
              <div key={imp.name} className="flex items-center gap-1.5 px-4 py-0.5 text-zinc-700 dark:text-zinc-300">
                <span className="text-zinc-400">⊟</span>
                {imp.name}
              </div>
            ))}
          </>
        )}
        {remoteImports.length > 0 && (
          <>
            <div className="px-3 py-0.5 text-xs text-zinc-400 dark:text-zinc-500">[Remote]</div>
            {remoteImports.map(imp => (
              <div key={imp.name} className="px-4 py-0.5 text-zinc-500 dark:text-zinc-400">
                {imp.name}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="mx-3 border-t border-zinc-100 dark:border-zinc-800" />

      {/* Flow */}
      <div className="pt-2 pb-1">
        <SectionHeader label="Flow" />
        {activeManifest && (
          <div className="flex items-center gap-1.5 px-4 py-0.5 font-medium text-zinc-800 dark:text-zinc-200">
            <span className="text-zinc-400">▶</span>
            {activeManifest.metadata.name}
          </div>
        )}
        {flowResources.length === 0 && !activeManifest && (
          <EmptyHint text="No manifest open" />
        )}
        {flowResources.map(r => (
          <div key={r.name} className="px-4 py-0.5 text-zinc-600 dark:text-zinc-400">
            <span className="mr-1.5 rounded bg-zinc-100 px-1 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              {r.kind.split('.').pop()}
            </span>
            {r.name}
          </div>
        ))}
      </div>

      <div className="mx-3 border-t border-zinc-100 dark:border-zinc-800" />

      {/* Definitions */}
      <div className="pt-2 pb-1">
        <SectionHeader label="Definitions" />
        {definitions.length === 0 && (
          <EmptyHint text="No definitions" />
        )}
        {definitions.map(r => (
          <div key={r.name} className="px-4 py-0.5 text-zinc-600 dark:text-zinc-400">
            {r.name}
          </div>
        ))}
      </div>

      <div className="mx-3 border-t border-zinc-100 dark:border-zinc-800" />

      {/* Library */}
      <div className="pt-2 pb-1">
        <SectionHeader label="Library" />
        <EmptyHint text="(requires definition registry)" />
      </div>
    </div>
  )
}
