'use client'

import { useEffect, useRef, useState } from 'react'
import { openRootManifest, loadApplication, createApplication } from '../loader'
import type { EditorState } from '../model'
import { saveState, loadState } from '../storage'
import { TopBar } from './TopBar'
import { Sidebar } from './Sidebar'
import { GraphCanvas } from './GraphCanvas'
import { DetailPanel } from './DetailPanel'

const INITIAL_STATE: EditorState = {
  application: null,
  activeModulePath: null,
  navigationStack: [],
  selectedResource: null,
  panelStack: [],
  diagnosticsByResource: new Map(),
}

export function Editor() {
  const [state, setState] = useState<EditorState>(INITIAL_STATE)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  // isHydrated tracks whether the post-mount restore has run.
  // Effects run in definition order, so the save effect (defined second) checks
  // this flag and skips the initial render before the restore has happened.
  const isHydrated = useRef(false)

  useEffect(() => {
    if (isHydrated.current) saveState(state)
  }, [state])

  useEffect(() => {
    const saved = loadState()
    if (saved) setState(s => ({ ...s, ...saved }))
    isHydrated.current = true
  }, [])

  const activeManifest = state.application && state.activeModulePath
    ? (state.application.modules.get(state.activeModulePath) ?? null)
    : null

  // ---------------------------------------------------------------------------
  // Application lifecycle
  // ---------------------------------------------------------------------------

  function handleCreate(name: string) {
    const application = createApplication(name)
    setCreating(false)
    setState({
      ...INITIAL_STATE,
      application,
      activeModulePath: application.rootPath,
      navigationStack: [{ type: 'module', filePath: application.rootPath, graphContext: null }],
    })
  }

  async function handleOpen() {
    setError(null)
    setLoading(true)
    try {
      const opened = await openRootManifest()
      if (!opened) return
      const application = await loadApplication(opened.rootPath, opened.adapter)
      setState({
        ...INITIAL_STATE,
        application,
        activeModulePath: opened.rootPath,
        navigationStack: [{ type: 'module', filePath: opened.rootPath, graphContext: null }],
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  function handleOpenModule(filePath: string) {
    setState(s => ({
      ...s,
      activeModulePath: filePath,
      selectedResource: null,
      panelStack: [],
      navigationStack: [...s.navigationStack, { type: 'module', filePath, graphContext: null }],
    }))
  }

  function handlePopTo(index: number) {
    setState(s => {
      const entry = s.navigationStack[index]
      if (!entry || entry.type !== 'module') return s
      const newStack = s.navigationStack.slice(0, index + 1)
      return {
        ...s,
        navigationStack: newStack,
        activeModulePath: entry.filePath,
        selectedResource: null,
        panelStack: [],
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Resource selection
  // ---------------------------------------------------------------------------

  function handleSelectResource(kind: string, name: string) {
    setState(s => ({
      ...s,
      selectedResource: { kind, name },
      panelStack: [{ type: 'resource', kind, name }],
    }))
  }

  function handleClearSelection() {
    setState(s => ({ ...s, selectedResource: null, panelStack: [] }))
  }

  // ---------------------------------------------------------------------------
  // Panel drill-in / back
  // ---------------------------------------------------------------------------

  function handleDrillIn(path: string[], label: string) {
    setState(s => ({
      ...s,
      panelStack: [...s.panelStack, { type: 'item', fieldPath: path, label }],
    }))
  }

  function handleBack() {
    setState(s => {
      if (s.panelStack.length <= 1) return s
      return { ...s, panelStack: s.panelStack.slice(0, -1) }
    })
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-white dark:bg-zinc-950">
      <TopBar
        application={state.application}
        navigationStack={state.navigationStack}
        onNew={() => setCreating(true)}
        onOpen={handleOpen}
        onPopTo={handlePopTo}
      />

      {error && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}
      {loading && (
        <div className="border-b border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-400">
          Loading…
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          activeManifest={activeManifest}
          selectedResource={state.selectedResource}
          onSelectResource={handleSelectResource}
          onClearSelection={handleClearSelection}
          onOpenModule={handleOpenModule}
        />
        <GraphCanvas
          hasApplication={state.application !== null}
          creating={creating}
          onCreate={handleCreate}
          onCancelCreate={() => setCreating(false)}
          onNew={() => setCreating(true)}
          onOpen={handleOpen}
          onClearSelection={handleClearSelection}
        />
        <DetailPanel
          panelStack={state.panelStack}
          activeManifest={activeManifest}
          onDrillIn={handleDrillIn}
          onBack={handleBack}
        />
      </div>
    </div>
  )
}
