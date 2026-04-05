import { useState } from 'react'
import type { AppSettings, RegistryServer } from '../model'

interface SettingsModalProps {
  settings: AppSettings
  onClose: () => void
  onChange: (settings: AppSettings) => void
}

export function SettingsModal({ settings, onClose, onChange }: SettingsModalProps) {
  const [newUrl, setNewUrl] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [urlError, setUrlError] = useState<string | null>(null)

  function handleToggle(id: string) {
    onChange({
      ...settings,
      registryServers: settings.registryServers.map(s =>
        s.id === id ? { ...s, enabled: !s.enabled } : s
      ),
    })
  }

  function handleDelete(id: string) {
    onChange({
      ...settings,
      registryServers: settings.registryServers.filter(s => s.id !== id),
    })
  }

  function handleAdd() {
    const trimmedUrl = newUrl.trim()
    if (!trimmedUrl) {
      setUrlError('URL is required')
      return
    }
    try {
      new URL(trimmedUrl)
    } catch {
      setUrlError('Enter a valid URL')
      return
    }
    const server: RegistryServer = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      url: trimmedUrl,
      label: newLabel.trim() || undefined,
      enabled: true,
    }
    onChange({ ...settings, registryServers: [...settings.registryServers, server] })
    setNewUrl('')
    setNewLabel('')
    setUrlError(null)
  }

  function handleUrlKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleAdd()
    if (e.key === 'Escape') onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-[480px] max-w-full rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-950">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Settings</span>
          <button
            onClick={onClose}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Registry Servers
          </p>

          {/* Server list */}
          <div className="mb-3 flex flex-col gap-1">
            {settings.registryServers.length === 0 && (
              <p className="text-xs text-zinc-400 dark:text-zinc-600">No servers configured.</p>
            )}
            {settings.registryServers.map(server => (
              <div
                key={server.id}
                className="flex items-center gap-2 rounded border border-zinc-100 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900"
              >
                <input
                  type="checkbox"
                  checked={server.enabled}
                  onChange={() => handleToggle(server.id)}
                  className="shrink-0 accent-zinc-700 dark:accent-zinc-300"
                />
                <div className="min-w-0 flex-1">
                  {server.label && (
                    <p className="truncate text-xs font-medium text-zinc-700 dark:text-zinc-300">{server.label}</p>
                  )}
                  <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{server.url}</p>
                </div>
                <button
                  onClick={() => handleDelete(server.id)}
                  className="shrink-0 rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-200 hover:text-red-600 dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-red-400"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          {/* Add server form */}
          <div className="flex flex-col gap-1.5 border-t border-zinc-100 pt-3 dark:border-zinc-800">
            <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Add server</p>
            <input
              type="text"
              placeholder="https://registry.example.com"
              value={newUrl}
              onChange={e => { setNewUrl(e.target.value); setUrlError(null) }}
              onKeyDown={handleUrlKeyDown}
              className="rounded border border-zinc-300 bg-white px-3 py-1 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400"
            />
            {urlError && <p className="text-xs text-red-500">{urlError}</p>}
            <input
              type="text"
              placeholder="Label (optional)"
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') onClose() }}
              className="rounded border border-zinc-300 bg-white px-3 py-1 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400"
            />
            <div className="flex justify-end">
              <button
                onClick={handleAdd}
                className="rounded px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
