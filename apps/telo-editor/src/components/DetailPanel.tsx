import type { ParsedManifest, PanelEntry } from '../model'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getValueAtPath(fields: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = fields
  for (const key of path) {
    if (current == null) return undefined
    if (Array.isArray(current)) current = current[Number(key)]
    else if (typeof current === 'object') current = (current as Record<string, unknown>)[key]
    else return undefined
  }
  return current
}

function isComplex(v: unknown): v is object {
  return v !== null && typeof v === 'object'
}

const CEL_RE = /^\$\{\{[\s\S]*\}\}$/

// ---------------------------------------------------------------------------
// FieldValue — renders a single value inline or as a drill-in trigger
// ---------------------------------------------------------------------------

function FieldValue({ value, onOpen }: { value: unknown; onOpen?: () => void }) {
  if (value === null || value === undefined) {
    return <span className="text-zinc-400 dark:text-zinc-600">—</span>
  }
  if (typeof value === 'boolean') {
    return <span className="font-mono text-xs text-amber-600 dark:text-amber-400">{String(value)}</span>
  }
  if (typeof value === 'number') {
    return <span className="font-mono text-xs text-blue-600 dark:text-blue-400">{value}</span>
  }
  if (typeof value === 'string') {
    if (CEL_RE.test(value)) {
      return <code className="rounded bg-violet-50 px-1 font-mono text-xs text-violet-700 dark:bg-violet-950 dark:text-violet-300">{value}</code>
    }
    if (value.includes('\n')) {
      return <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-zinc-700 dark:text-zinc-300">{value}</pre>
    }
    return <span className="text-zinc-700 dark:text-zinc-300">{value}</span>
  }
  if (Array.isArray(value)) {
    return (
      <button onClick={onOpen} className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700">
        [{value.length} items]
      </button>
    )
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as object)
    return (
      <button onClick={onOpen} className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700">
        {'{' + keys.length + ' keys}'}
      </button>
    )
  }
  return <span className="font-mono text-xs text-zinc-500">{String(value)}</span>
}

// ---------------------------------------------------------------------------
// FieldList — renders all entries of an object or array
// ---------------------------------------------------------------------------

interface FieldListProps {
  data: Record<string, unknown> | unknown[]
  basePath: string[]
  onDrillIn: (path: string[], label: string) => void
}

function FieldList({ data, basePath, onDrillIn }: FieldListProps) {
  const entries: [string, unknown][] = Array.isArray(data)
    ? data.map((v, i) => [String(i), v])
    : Object.entries(data as Record<string, unknown>)

  if (entries.length === 0) {
    return <div className="px-4 py-2 text-xs italic text-zinc-400 dark:text-zinc-600">empty</div>
  }

  return (
    <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {entries.map(([key, value]) => {
        const label = Array.isArray(data) ? `[${key}]` : key
        const path = [...basePath, key]
        return (
          <div key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2 px-4 py-1.5 text-xs">
            <span className="truncate font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
            <span className="min-w-0 wrap-break-word">
              <FieldValue
                value={value}
                onOpen={isComplex(value) ? () => onDrillIn(path, label) : undefined}
              />
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// DetailPanel
// ---------------------------------------------------------------------------

interface DetailPanelProps {
  panelStack: PanelEntry[]
  activeManifest: ParsedManifest | null
  onDrillIn: (path: string[], label: string) => void
  onBack: () => void
}

export function DetailPanel({ panelStack, activeManifest, onDrillIn, onBack }: DetailPanelProps) {
  if (panelStack.length === 0 || !activeManifest) return null

  const current = panelStack[panelStack.length - 1]
  const prev = panelStack.length > 1 ? panelStack[panelStack.length - 2] : null

  // Resolve the resource for this panel
  const rootEntry = panelStack[0]
  if (rootEntry.type !== 'resource') return null
  const resource = activeManifest.resources.find(r => r.name === rootEntry.name)
  if (!resource) return null

  // Resolve what data to display and the base path for drill-ins
  let data: Record<string, unknown> | unknown[]
  let title: string
  let basePath: string[]

  if (current.type === 'resource') {
    data = resource.fields
    title = resource.name
    basePath = []
  } else {
    const value = getValueAtPath(resource.fields, current.fieldPath)
    if (!isComplex(value)) return null
    data = value as Record<string, unknown> | unknown[]
    title = current.label
    basePath = current.fieldPath
  }

  const backLabel = prev == null
    ? null
    : prev.type === 'resource'
      ? prev.name
      : prev.label

  return (
    <div className="flex h-full w-72 flex-col overflow-hidden border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center border-b border-zinc-100 px-4 dark:border-zinc-800">
        {backLabel != null ? (
          <button
            onClick={onBack}
            className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            ← {backLabel}
          </button>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-xs font-semibold text-zinc-800 dark:text-zinc-200">{title}</span>
            <span className="shrink-0 rounded bg-zinc-100 px-1 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              {resource.kind.split('.').pop()}
            </span>
          </div>
        )}
      </div>

      {/* Field list */}
      <div className="flex-1 overflow-y-auto">
        <FieldList data={data} basePath={basePath} onDrillIn={onDrillIn} />
      </div>
    </div>
  )
}
