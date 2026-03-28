import { Loader } from '@telorun/analyzer'
import type { ManifestAdapter } from '@telorun/analyzer'
import type { ResourceManifest } from '@telorun/sdk'
import type { Application, ImportKind, ParsedImport, ParsedManifest, ParsedResource } from './model'

// ---------------------------------------------------------------------------
// Path utilities (avoids a browser polyfill dependency)
// ---------------------------------------------------------------------------

function pathDirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? '.' : i === 0 ? '/' : p.slice(0, i)
}

function pathExtname(p: string): string {
  const base = p.split('/').pop() ?? ''
  const i = base.lastIndexOf('.')
  return i <= 0 ? '' : base.slice(i)
}

function pathResolve(base: string, rel: string): string {
  if (rel.startsWith('/')) return normalizePath(rel)
  const combined = pathDirname(base) + '/' + rel
  return normalizePath(combined)
}

function pathRelative(from: string, to: string): string {
  const fromParts = from.split('/').filter(Boolean)
  const toParts = to.split('/').filter(Boolean)
  let i = 0
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++
  const ups = fromParts.length - i
  const rel = [...Array(ups).fill('..'), ...toParts.slice(i)].join('/')
  return rel || '.'
}

function normalizePath(p: string): string {
  const abs = p.startsWith('/')
  const parts = p.split('/')
  const stack: string[] = []
  for (const seg of parts) {
    if (seg === '..') stack.pop()
    else if (seg !== '' && seg !== '.') stack.push(seg)
  }
  return (abs ? '/' : '') + stack.join('/')
}

// ---------------------------------------------------------------------------
// Public path/string utilities
// ---------------------------------------------------------------------------

export function toPascalCase(s: string): string {
  return s.split(/[-_\s]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
}

// Returns the source string to store in Kernel.Import — relative path from
// fromPath's directory to toPath's directory (directory form, no extension).
export function toRelativeSource(fromPath: string, toPath: string): string {
  const fromDir = pathDirname(fromPath)
  const toDir = pathDirname(toPath)
  const rel = pathRelative(fromDir, toDir)
  return rel === '.' ? '.' : rel.startsWith('.') ? rel : './' + rel
}

// Reads a manifest file and returns the metadata.name from its Kernel.Module doc.
export async function readModuleMetadata(
  filePath: string,
  adapter: ManifestAdapter
): Promise<string | null> {
  try {
    const loader = new Loader([adapter])
    const docs = await loader.loadModule(filePath) as ResourceManifest[]
    const moduleDoc = docs.find(d => d.kind === 'Kernel.Module')
    return (moduleDoc?.metadata.name as string | undefined) ?? null
  } catch {
    return null
  }
}

// Adds a new import to a module in-memory and loads the submodule if local.
export async function addModuleImport(
  app: Application,
  fromPath: string,
  imp: ParsedImport,
  adapter: ManifestAdapter
): Promise<Application> {
  const modules = new Map(app.modules)
  const importGraph = new Map(app.importGraph)
  const importedBy = new Map(app.importedBy)

  // Update the importing module's import list
  const fromModule = modules.get(fromPath)!
  modules.set(fromPath, { ...fromModule, imports: [...fromModule.imports, imp] })

  const deps = new Set(importGraph.get(fromPath) ?? [])

  if (imp.importKind === 'submodule' && imp.resolvedPath) {
    deps.add(imp.resolvedPath)
    importGraph.set(fromPath, deps)

    if (!importedBy.has(imp.resolvedPath)) importedBy.set(imp.resolvedPath, new Set())
    importedBy.get(imp.resolvedPath)!.add(fromPath)

    // Recursively load the new submodule and its dependencies
    const loader = new Loader([adapter])
    async function visit(filePath: string): Promise<void> {
      if (modules.has(filePath)) return
      const docs = await loader.loadModule(filePath) as ResourceManifest[]
      const parsed = buildParsedManifest(filePath, docs)
      modules.set(filePath, parsed)
      const subDeps = new Set<string>()
      importGraph.set(filePath, subDeps)
      for (const subImp of parsed.imports) {
        if (subImp.importKind !== 'submodule') continue
        const depPath = resolveImportPath(adapter, filePath, subImp.source)
        subImp.resolvedPath = depPath
        subDeps.add(depPath)
        if (!importedBy.has(depPath)) importedBy.set(depPath, new Set())
        importedBy.get(depPath)!.add(filePath)
        try { await visit(depPath) } catch (err) {
          console.error(`Failed to load submodule ${depPath}:`, err)
        }
      }
    }
    try { await visit(imp.resolvedPath) } catch (err) {
      console.error(`Failed to load submodule ${imp.resolvedPath}:`, err)
    }
  } else {
    importGraph.set(fromPath, deps)
  }

  return { rootPath: app.rootPath, modules, importGraph, importedBy }
}

// ---------------------------------------------------------------------------
// TauriAdapter — uses the read_file Rust command
// ---------------------------------------------------------------------------

class TauriAdapter implements ManifestAdapter {
  supports(url: string): boolean {
    return !url.startsWith('http') && !url.startsWith('pkg:')
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    const { invoke } = await import('@tauri-apps/api/core')
    const text = await invoke<string>('read_file', { path: url })
    return { text, source: url }
  }

  resolveRelative(base: string, relative: string): string {
    const resolved = pathResolve(base, relative)
    if (!pathExtname(resolved)) return resolved + '/module.yaml'
    return resolved
  }
}

// ---------------------------------------------------------------------------
// WebFsAdapter — uses File System Access API (Chrome/Edge, localhost)
// ---------------------------------------------------------------------------

class WebFsAdapter implements ManifestAdapter {
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  supports(url: string): boolean {
    return !url.startsWith('http') && !url.startsWith('pkg:')
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    const relPath = url.startsWith('/') ? url.slice(1) : url
    const parts = relPath.split('/').filter(Boolean)
    let dir: FileSystemDirectoryHandle = this.root
    for (const part of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part)
    }
    const fileHandle = await dir.getFileHandle(parts[parts.length - 1])
    const file = await fileHandle.getFile()
    const text = await file.text()
    return { text, source: url }
  }

  resolveRelative(base: string, relative: string): string {
    const resolved = pathResolve(base, relative)
    if (!pathExtname(resolved)) return resolved + '/module.yaml'
    return resolved
  }
}

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

export function isInTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function supportsDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

// ---------------------------------------------------------------------------
// SingleFileAdapter — fallback for browsers without File System Access API.
// Can only serve the one file that was opened; submodule imports fail silently.
// ---------------------------------------------------------------------------

class SingleFileAdapter implements ManifestAdapter {
  constructor(private readonly text: string, private readonly filePath: string) {}

  supports(url: string): boolean {
    return url === this.filePath
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    return { text: this.text, source: url }
  }

  resolveRelative(_base: string, relative: string): string {
    return relative
  }
}

// ---------------------------------------------------------------------------
// File open
// ---------------------------------------------------------------------------

async function findRootManifest(dir: FileSystemDirectoryHandle): Promise<string | null> {
  const names: string[] = []
  for await (const [name] of dir.entries()) {
    names.push(name as string)
  }
  return (
    names.find(n => n === 'module.yaml') ??
    names.find(n => n === 'manifest.yaml') ??
    names.find(n => n.endsWith('.yaml') || n.endsWith('.yml')) ??
    null
  )
}

function openFileViaInput(): Promise<{ text: string; name: string } | null> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.yaml,.yml'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) { resolve(null); return }
      resolve({ text: await file.text(), name: file.name })
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}

export async function openRootManifest(): Promise<{ adapter: ManifestAdapter; rootPath: string } | null> {
  if (isInTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const result = await open({ filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }] })
    if (!result || typeof result !== 'string') return null
    return { adapter: new TauriAdapter(), rootPath: result }
  }

  if (supportsDirectoryPicker()) {
    // Chrome/Edge: full directory access — submodule imports work
    const dirHandle = await window.showDirectoryPicker()
    const rootFile = await findRootManifest(dirHandle)
    if (!rootFile) return null
    return { adapter: new WebFsAdapter(dirHandle), rootPath: '/' + rootFile }
  }

  // Firefox/Safari fallback: single-file picker — submodule imports won't load
  const picked = await openFileViaInput()
  if (!picked) return null
  const rootPath = '/' + picked.name
  return { adapter: new SingleFileAdapter(picked.text, rootPath), rootPath }
}

// ---------------------------------------------------------------------------
// Manifest parsing helpers
// ---------------------------------------------------------------------------

function classifyImport(source: string): ImportKind {
  if (source.startsWith('pkg:') || /^https?:\/\//.test(source)) return 'remote'
  return 'submodule'
}

function buildParsedManifest(filePath: string, docs: ResourceManifest[]): ParsedManifest {
  const moduleDoc = docs.find(r => r.kind === 'Kernel.Module')

  const imports: ParsedImport[] = docs
    .filter(r => r.kind === 'Kernel.Import')
    .map(r => ({
      name: r.metadata.name as string,
      source: (r as Record<string, unknown>).source as string,
      importKind: classifyImport((r as Record<string, unknown>).source as string),
      variables: (r as Record<string, unknown>).variables as Record<string, unknown> | undefined,
      secrets: (r as Record<string, unknown>).secrets as Record<string, unknown> | undefined,
    }))

  const resources: ParsedResource[] = docs
    .filter(r => r.kind !== 'Kernel.Module' && r.kind !== 'Kernel.Import')
    .map(r => {
      const { kind, metadata, ...rest } = r as Record<string, unknown> & {
        kind: string
        metadata: { name: string; module?: string }
      }
      return {
        kind,
        name: metadata.name,
        module: metadata.module,
        fields: rest as Record<string, unknown>,
      }
    })

  const targets: string[] = (moduleDoc as Record<string, unknown> | undefined)?.targets as string[] ?? []

  return {
    filePath,
    metadata: {
      name: (moduleDoc?.metadata.name as string | undefined) ?? filePath.split('/').pop()?.replace(/\.ya?ml$/, '') ?? 'unknown',
      version: moduleDoc?.metadata.version as string | undefined,
      description: moduleDoc?.metadata.description as string | undefined,
    },
    targets,
    imports,
    resources,
  }
}

function resolveImportPath(adapter: ManifestAdapter, base: string, source: string): string {
  return adapter.resolveRelative(base, source)
}

// ---------------------------------------------------------------------------
// Application loader
// ---------------------------------------------------------------------------

export async function loadApplication(rootPath: string, adapter: ManifestAdapter): Promise<Application> {
  const loader = new Loader([adapter])
  const modules = new Map<string, ParsedManifest>()
  const importGraph = new Map<string, Set<string>>()
  const importedBy = new Map<string, Set<string>>()
  const visited = new Set<string>()

  async function visit(filePath: string): Promise<void> {
    if (visited.has(filePath)) return
    visited.add(filePath)

    const docs = await loader.loadModule(filePath) as ResourceManifest[]
    const parsed = buildParsedManifest(filePath, docs)
    modules.set(filePath, parsed)

    const deps = new Set<string>()
    importGraph.set(filePath, deps)

    for (const imp of parsed.imports) {
      if (imp.importKind !== 'submodule') continue
      const depPath = resolveImportPath(adapter, filePath, imp.source)
      imp.resolvedPath = depPath
      deps.add(depPath)
      if (!importedBy.has(depPath)) importedBy.set(depPath, new Set())
      importedBy.get(depPath)!.add(filePath)
      try {
        await visit(depPath)
      } catch (err) {
        // Record the failure but continue loading other imports
        console.error(`Failed to load submodule ${depPath}:`, err)
      }
    }
  }

  await visit(rootPath)
  return { rootPath, modules, importGraph, importedBy }
}

// ---------------------------------------------------------------------------
// New application
// ---------------------------------------------------------------------------

// The `new://` scheme marks an in-memory application that has not been saved.
export function createApplication(name: string): Application {
  const filePath = `new://${name}/module.yaml`
  const manifest: ParsedManifest = {
    filePath,
    metadata: { name, version: '1.0.0' },
    targets: [],
    imports: [],
    resources: [],
  }
  return {
    rootPath: filePath,
    modules: new Map([[filePath, manifest]]),
    importGraph: new Map([[filePath, new Set()]]),
    importedBy: new Map(),
  }
}
