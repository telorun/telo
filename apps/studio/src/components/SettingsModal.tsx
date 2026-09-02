import type { AppSettings } from '../model'
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

        <div className="mt-6">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Templates
          </p>
          <p className="mb-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            Starter-template gallery source (must serve <code>templates.json</code> and the
            referenced manifests over CORS). Leave empty for the built-in default.
          </p>
          <input
            type="text"
            placeholder="Custom templates base URL"
            value={settings.templatesBaseUrl ?? ''}
            onChange={e => {
              const templatesBaseUrl = e.target.value
              onChange(s => ({ ...s, templatesBaseUrl: templatesBaseUrl || undefined }))
            }}
            className="w-full rounded border border-zinc-300 bg-white px-3 py-1 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400"
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
