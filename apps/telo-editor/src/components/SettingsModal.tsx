import { useState } from 'react'
import type { AppSettings, RegistryServer } from '../model'
import { RunSettingsSection } from '../run'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'

interface SettingsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: AppSettings
  onChange: React.Dispatch<React.SetStateAction<AppSettings>>
}

export function SettingsModal({ open, onOpenChange, settings, onChange }: SettingsModalProps) {
  const [newUrl, setNewUrl] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [urlError, setUrlError] = useState<string | null>(null)

  function handleToggle(id: string) {
    onChange(s => ({
      ...s,
      registryServers: s.registryServers.map(server =>
        server.id === id ? { ...server, enabled: !server.enabled } : server
      ),
    }))
  }

  function handleDelete(id: string) {
    onChange(s => ({
      ...s,
      registryServers: s.registryServers.filter(server => server.id !== id),
    }))
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
    onChange(s => ({ ...s, registryServers: [...s.registryServers, server] }))
    setNewUrl('')
    setNewLabel('')
    setUrlError(null)
  }

  function handleUrlKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleAdd()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-120">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <div className="mb-6">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Run
          </p>
          <RunSettingsSection
            runners={settings.runners}
            activeRunnerId={settings.activeRunnerId}
            onChangeRunners={(runners) => onChange((s) => ({ ...s, runners }))}
            onChangeActiveRunner={(id) => onChange((s) => ({ ...s, activeRunnerId: id }))}
          />
        </div>

        <div>
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
                <Button
                  variant="ghost"
                  size="xs"
                  className="shrink-0 text-zinc-400 hover:text-red-600 dark:text-zinc-600 dark:hover:text-red-400"
                  onClick={() => handleDelete(server.id)}
                >
                  Remove
                </Button>
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
              onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
              className="rounded border border-zinc-300 bg-white px-3 py-1 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400"
            />
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={handleAdd}>
                Add
              </Button>
            </div>
          </div>
        </div>

        <div className="mt-6">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Manifest Cache
          </p>
          <p className="mb-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            Resolves <code>oci://</code> imports. Leave empty for the public default
            (manifests.telo.sh); point a self-hosted hub&apos;s bucket here.
          </p>
          <input
            type="text"
            placeholder="https://manifests.telo.sh"
            value={settings.manifestCacheUrl ?? ''}
            onChange={e => {
              const manifestCacheUrl = e.target.value
              onChange(s => ({ ...s, manifestCacheUrl: manifestCacheUrl || undefined }))
            }}
            className="w-full rounded border border-zinc-300 bg-white px-3 py-1 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400"
          />
        </div>

        <div className="mt-6">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Hub
          </p>
          <p className="mb-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            Federated import autocomplete (ref search &amp; version lists). Leave
            empty for the public default (telo.sh); point a self-hosted hub here.
          </p>
          <input
            type="text"
            placeholder="https://telo.sh"
            value={settings.hubUrl ?? ''}
            onChange={e => {
              const hubUrl = e.target.value
              onChange(s => ({ ...s, hubUrl: hubUrl || undefined }))
            }}
            className="w-full rounded border border-zinc-300 bg-white px-3 py-1 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400"
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
