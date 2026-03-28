'use client'

import { useState } from 'react'
import { openRootManifest, loadApplication, createApplication } from '../loader'
import type { EditorState } from '../model'
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

  const activeManifest = state.application && state.activeModulePath
    ? (state.application.modules.get(state.activeModulePath) ?? null)
    : null

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

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-white dark:bg-zinc-950">
      <TopBar activeManifest={activeManifest} onNew={() => setCreating(true)} onOpen={handleOpen} />

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
        <Sidebar activeManifest={activeManifest} />
        <GraphCanvas
          hasApplication={state.application !== null}
          creating={creating}
          onCreate={handleCreate}
          onCancelCreate={() => setCreating(false)}
          onNew={() => setCreating(true)}
          onOpen={handleOpen}
        />
        <DetailPanel />
      </div>
    </div>
  )
}
