import { useState } from 'react'
import type { ParsedManifest } from '../model'
import { toPascalCase } from '../loader'

interface SidebarProps {
  activeManifest: ParsedManifest | null
  selectedResource: { kind: string; name: string } | null
  onSelectResource: (kind: string, name: string) => void
  onClearSelection: () => void
  onOpenModule: (filePath: string) => void
  // null means not supported in current environment (e.g. single-file browser)
  onPickModuleFile: (() => Promise<{ source: string; suggestedAlias: string } | null>) | null
  onAddModule: (source: string, alias: string) => Promise<void>
  onAddImport: (source: string, alias: string) => void
}

function SectionHeader({ label, onAdd }: { label: string; onAdd?: () => void }) {
  return (
    <div className="flex items-center justify-between px-3 py-1">
      <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        {label}
      </span>
      {onAdd && (
        <button
          onClick={onAdd}
          className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 leading-none px-0.5"
        >
          +
        </button>
      )}
    </div>
  )
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="px-4 py-1 text-xs italic text-zinc-400 dark:text-zinc-600">{text}</div>
  )
}

export function Sidebar({
  activeManifest,
  selectedResource,
  onSelectResource,
  onClearSelection,
  onOpenModule,
  onPickModuleFile,
  onAddModule,
  onAddImport,
}: SidebarProps) {
  const moduleImports = activeManifest?.imports.filter(i => i.importKind === 'submodule') ?? []
  const remoteImports = activeManifest?.imports.filter(i => i.importKind === 'remote') ?? []
  const definitions = activeManifest?.resources.filter(r => r.kind === 'Kernel.Definition') ?? []

  const [addingModule, setAddingModule] = useState(false)
  const [moduleSource, setModuleSource] = useState('')
  const [moduleAlias, setModuleAlias] = useState('')
  const [moduleAliasEdited, setModuleAliasEdited] = useState(false)
  const [moduleSubmitting, setModuleSubmitting] = useState(false)

  const [addingImport, setAddingImport] = useState(false)
  const [importSource, setImportSource] = useState('')
  const [importAlias, setImportAlias] = useState('')
  const [importAliasEdited, setImportAliasEdited] = useState(false)

  const rowBase = 'flex items-center gap-1.5 px-4 py-0.5 cursor-default select-none'
  const rowHover = 'hover:bg-zinc-100 dark:hover:bg-zinc-900'

  // ---------------------------------------------------------------------------
  // Module add form logic
  // ---------------------------------------------------------------------------

  async function handleStartAddModule() {
    if (onPickModuleFile) {
      // Tauri: open file picker immediately, pre-fill form
      const picked = await onPickModuleFile()
      if (!picked) return
      setModuleSource(picked.source)
      setModuleAlias(picked.suggestedAlias)
      setModuleAliasEdited(false)
    } else {
      setModuleSource('')
      setModuleAlias('')
      setModuleAliasEdited(false)
    }
    setAddingModule(true)
  }

  async function handleSubmitModule() {
    const source = moduleSource.trim()
    const alias = moduleAlias.trim()
    if (!source || !alias) return
    setModuleSubmitting(true)
    try {
      await onAddModule(source, alias)
      setAddingModule(false)
      setModuleSource('')
      setModuleAlias('')
    } finally {
      setModuleSubmitting(false)
    }
  }

  function handleCancelModule() {
    setAddingModule(false)
    setModuleSource('')
    setModuleAlias('')
  }

  // ---------------------------------------------------------------------------
  // Import add form logic
  // ---------------------------------------------------------------------------

  function deriveAlias(source: string): string {
    // acme/user-service@1.0.0 → UserService
    // https://cdn.example.com/lib/module.yaml → Module
    const name = source.split('/').pop()?.split('@')[0]?.replace(/\.ya?ml$/, '') ?? ''
    return toPascalCase(name) || ''
  }

  function handleImportSourceChange(value: string) {
    setImportSource(value)
    if (!importAliasEdited) setImportAlias(deriveAlias(value))
  }

  function handleSubmitImport() {
    const source = importSource.trim()
    const alias = importAlias.trim()
    if (!source || !alias) return
    onAddImport(source, alias)
    setAddingImport(false)
    setImportSource('')
    setImportAlias('')
    setImportAliasEdited(false)
  }

  function handleCancelImport() {
    setAddingImport(false)
    setImportSource('')
    setImportAlias('')
    setImportAliasEdited(false)
  }

  const inputCls = 'w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100'
  const btnPrimary = 'rounded bg-zinc-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-40 hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300'
  const btnGhost = 'rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'

  return (
    <div className="flex h-full w-56 flex-col overflow-y-auto border-r border-zinc-200 bg-white text-sm dark:border-zinc-800 dark:bg-zinc-950">

      {/* Modules */}
      <div className="pb-1 pt-3">
        <SectionHeader
          label="Modules"
          onAdd={activeManifest ? handleStartAddModule : undefined}
        />
        {moduleImports.length === 0 && !addingModule && <EmptyHint text="No submodules" />}
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

        {addingModule && (
          <div className="mx-3 mt-1 flex flex-col gap-1.5">
            {/* In browser (no file picker) show a source text input */}
            {!onPickModuleFile && (
              <input
                autoFocus
                value={moduleSource}
                onChange={e => {
                  setModuleSource(e.target.value)
                  if (!moduleAliasEdited) {
                    const dir = e.target.value.split('/').pop() ?? ''
                    setModuleAlias(toPascalCase(dir))
                  }
                }}
                placeholder="./path/to/module"
                className={inputCls}
              />
            )}
            <input
              autoFocus={!!onPickModuleFile}
              value={moduleAlias}
              onChange={e => { setModuleAlias(e.target.value); setModuleAliasEdited(true) }}
              onKeyDown={e => { if (e.key === 'Enter') handleSubmitModule(); if (e.key === 'Escape') handleCancelModule() }}
              placeholder="Alias"
              className={inputCls}
            />
            <div className="flex gap-1">
              <button onClick={handleSubmitModule} disabled={!moduleSource.trim() || !moduleAlias.trim() || moduleSubmitting} className={btnPrimary}>
                Add
              </button>
              <button onClick={handleCancelModule} className={btnGhost}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="mx-3 border-t border-zinc-100 dark:border-zinc-800" />

      {/* Imports */}
      <div className="pb-1 pt-2">
        <SectionHeader
          label="Imports"
          onAdd={activeManifest ? () => setAddingImport(true) : undefined}
        />
        {remoteImports.length === 0 && !addingImport && <EmptyHint text="No imports" />}
        {remoteImports.map(imp => (
          <div key={imp.name} className={`${rowBase} text-zinc-500 dark:text-zinc-400`}>
            {imp.name}
          </div>
        ))}

        {addingImport && (
          <div className="mx-3 mt-1 flex flex-col gap-1.5">
            <input
              autoFocus
              value={importSource}
              onChange={e => handleImportSourceChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSubmitImport(); if (e.key === 'Escape') handleCancelImport() }}
              placeholder="acme/module@1.0.0 or https://…"
              className={inputCls}
            />
            <input
              value={importAlias}
              onChange={e => { setImportAlias(e.target.value); setImportAliasEdited(true) }}
              onKeyDown={e => { if (e.key === 'Enter') handleSubmitImport(); if (e.key === 'Escape') handleCancelImport() }}
              placeholder="Alias"
              className={inputCls}
            />
            <div className="flex gap-1">
              <button onClick={handleSubmitImport} disabled={!importSource.trim() || !importAlias.trim()} className={btnPrimary}>
                Add
              </button>
              <button onClick={handleCancelImport} className={btnGhost}>Cancel</button>
            </div>
          </div>
        )}
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
