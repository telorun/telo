import type { ParsedManifest } from './model'

// PersistenceAdapter abstracts how module changes are saved.
// The default InMemoryPersistenceAdapter is a no-op — all changes are held in
// EditorState and auto-persisted to localStorage via saveState.
// Future adapters (TauriWriteAdapter, RemoteWriteAdapter) will serialize
// ParsedManifest back to YAML and write to disk or a remote endpoint.
export interface PersistenceAdapter {
  saveModule(filePath: string, manifest: ParsedManifest): Promise<void>
}

export class InMemoryPersistenceAdapter implements PersistenceAdapter {
  async saveModule(_filePath: string, _manifest: ParsedManifest): Promise<void> {}
}
