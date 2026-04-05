import { useEffect, useRef, useState } from "react";
import { toPascalCase } from "../loader";
import type { AvailableKind, ParsedManifest, RegistryServer } from "../model";

interface RegistryResult {
  id: string;
  namespace: string;
  name: string;
  version: string;
  description: string | null;
}

interface SidebarProps {
  activeManifest: ParsedManifest | null;
  selectedResource: { kind: string; name: string } | null;
  graphContext: { kind: string; name: string } | null;
  registryServers: RegistryServer[];
  availableKinds: AvailableKind[];
  onSelectResource: (kind: string, name: string) => void;
  onNavigateResource: (kind: string, name: string) => void;
  onOpenModule: (filePath: string) => void;
  // null means not supported in current environment (e.g. single-file browser)
  onPickModuleFile: (() => Promise<{ source: string; suggestedAlias: string } | null>) | null;
  onAddModule: (source: string, alias: string) => Promise<void>;
  onAddImport: (source: string, alias: string) => Promise<void>;
  onRemoveImport: (name: string) => void;
  onCreateResource: () => void;
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
  );
}

function EmptyHint({ text }: { text: string }) {
  return <div className="px-4 py-1 text-xs italic text-zinc-400 dark:text-zinc-600">{text}</div>;
}

export function Sidebar({
  activeManifest,
  selectedResource,
  graphContext,
  registryServers,
  availableKinds,
  onSelectResource,
  onNavigateResource,
  onOpenModule,
  onPickModuleFile,
  onAddModule,
  onAddImport,
  onRemoveImport,
  onCreateResource,
}: SidebarProps) {
  const moduleImports = activeManifest?.imports.filter((i) => i.importKind === "submodule") ?? [];
  const remoteImports =
    activeManifest?.imports.filter(
      (i) => i.importKind === "remote" || i.importKind === "external",
    ) ?? [];
  const definitions = activeManifest?.resources.filter((r) => r.kind === "Kernel.Definition") ?? [];
  const userResources =
    activeManifest?.resources.filter((r) => !r.kind.startsWith("Kernel.")) ?? [];
  const localKinds =
    activeManifest?.resources
      .filter((resource) => resource.kind === "Kernel.Definition")
      .map((resource) => ({
        fullKind: `${resource.module ?? activeManifest.metadata.name}.${resource.name}`,
        alias: resource.module ?? activeManifest.metadata.name,
        kindName: resource.name,
        capability:
          typeof resource.fields.capability === "string" ? resource.fields.capability : "",
        topology:
          typeof resource.fields.topology === "string" ? resource.fields.topology : undefined,
        schema: (resource.fields.schema ?? {}) as Record<string, unknown>,
      })) ?? [];
  const kindsByFullKind = new Map(
    [...availableKinds, ...localKinds].map((kind) => [kind.fullKind, kind]),
  );

  const [addingModule, setAddingModule] = useState(false);
  const [moduleSource, setModuleSource] = useState("");
  const [moduleAlias, setModuleAlias] = useState("");
  const [moduleAliasEdited, setModuleAliasEdited] = useState(false);
  const [moduleSubmitting, setModuleSubmitting] = useState(false);

  const [addingImport, setAddingImport] = useState(false);
  const [importSource, setImportSource] = useState("");
  const [importAlias, setImportAlias] = useState("");
  const [importAliasEdited, setImportAliasEdited] = useState(false);
  const [importSubmitting, setImportSubmitting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<RegistryResult[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressFetchRef = useRef(false);

  // Fetch suggestions from all enabled registries, debounced
  useEffect(() => {
    if (!addingImport || suppressFetchRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const query = importSource.trim();
    if (!query) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const enabled = registryServers.filter((s) => s.enabled);
      if (!enabled.length) return;
      const results = await Promise.allSettled(
        enabled.map((server) =>
          fetch(`${server.url.replace(/\/$/, "")}/search?id=${encodeURIComponent(query)}`)
            .then((r) =>
              r.ok ? (r.json() as Promise<{ results: RegistryResult[] }>) : { results: [] },
            )
            .then((data) => data.results ?? [])
            .catch(() => [] as RegistryResult[]),
        ),
      );
      const merged: RegistryResult[] = [];
      const seen = new Set<string>();
      for (const r of results) {
        if (r.status === "fulfilled") {
          for (const item of r.value) {
            if (!seen.has(item.id)) {
              seen.add(item.id);
              merged.push(item);
            }
          }
        }
      }
      setSuggestions(merged);
      setSuggestionIndex(-1);
      setShowSuggestions(merged.length > 0);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [importSource, addingImport, registryServers]);

  function selectSuggestion(result: RegistryResult) {
    suppressFetchRef.current = true;
    setImportSource(result.id);
    if (!importAliasEdited) setImportAlias(deriveAlias(result.id));
    setShowSuggestions(false);
    setSuggestions([]);
    suppressFetchRef.current = false;
  }

  const rowBase = "flex items-center gap-1.5 px-4 py-0.5 cursor-default select-none";
  const rowHover = "hover:bg-zinc-100 dark:hover:bg-zinc-900";

  // ---------------------------------------------------------------------------
  // Module add form logic
  // ---------------------------------------------------------------------------

  async function handleStartAddModule() {
    if (onPickModuleFile) {
      // Tauri: open file picker immediately, pre-fill form
      const picked = await onPickModuleFile();
      if (!picked) return;
      setModuleSource(picked.source);
      setModuleAlias(picked.suggestedAlias);
      setModuleAliasEdited(false);
    } else {
      setModuleSource("");
      setModuleAlias("");
      setModuleAliasEdited(false);
    }
    setAddingModule(true);
  }

  async function handleSubmitModule() {
    const source = moduleSource.trim();
    const alias = moduleAlias.trim();
    if (!source || !alias) return;
    setModuleSubmitting(true);
    try {
      await onAddModule(source, alias);
      setAddingModule(false);
      setModuleSource("");
      setModuleAlias("");
    } finally {
      setModuleSubmitting(false);
    }
  }

  function handleCancelModule() {
    setAddingModule(false);
    setModuleSource("");
    setModuleAlias("");
  }

  // ---------------------------------------------------------------------------
  // Import add form logic
  // ---------------------------------------------------------------------------

  function deriveAlias(source: string): string {
    // acme/user-service@1.0.0 → UserService
    // https://cdn.example.com/lib/module.yaml → Module
    const name =
      source
        .split("/")
        .pop()
        ?.split("@")[0]
        ?.replace(/\.ya?ml$/, "") ?? "";
    return toPascalCase(name) || "";
  }

  function handleImportSourceChange(value: string) {
    setImportSource(value);
    if (!importAliasEdited) setImportAlias(deriveAlias(value));
  }

  async function handleSubmitImport() {
    const source = importSource.trim();
    const alias = importAlias.trim();
    if (!source || !alias) return;
    setImportSubmitting(true);
    setImportError(null);
    try {
      await onAddImport(source, alias);
      setAddingImport(false);
      setImportSource("");
      setImportAlias("");
      setImportAliasEdited(false);
      setSuggestions([]);
      setShowSuggestions(false);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImportSubmitting(false);
    }
  }

  function handleCancelImport() {
    setAddingImport(false);
    setImportSource("");
    setImportAlias("");
    setImportAliasEdited(false);
    setImportError(null);
    setSuggestions([]);
    setShowSuggestions(false);
  }

  const inputCls =
    "w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100";
  const btnPrimary =
    "rounded bg-zinc-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-40 hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
  const btnGhost =
    "rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800";

  return (
    <div className="flex h-full w-56 flex-col overflow-y-auto border-r border-zinc-200 bg-white text-sm dark:border-zinc-800 dark:bg-zinc-950">
      {/* Modules */}
      <div className="pb-1 pt-3">
        <SectionHeader label="Modules" onAdd={activeManifest ? handleStartAddModule : undefined} />
        {moduleImports.length === 0 && !addingModule && <EmptyHint text="No submodules" />}
        {moduleImports.map((imp) => (
          <div
            key={imp.name}
            className={`group ${rowBase} ${rowHover} cursor-pointer text-zinc-700 dark:text-zinc-300`}
            onClick={() => imp.resolvedPath && onOpenModule(imp.resolvedPath)}
          >
            <span className="text-zinc-400">⊟</span>
            <span className="flex-1 truncate">{imp.name}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemoveImport(imp.name);
              }}
              className="invisible rounded px-1 text-zinc-400 hover:text-red-500 group-hover:visible dark:hover:text-red-400"
            >
              ×
            </button>
          </div>
        ))}

        {addingModule && (
          <div className="mx-3 mt-1 flex flex-col gap-1.5">
            {/* In browser (no file picker) show a source text input */}
            {!onPickModuleFile && (
              <input
                autoFocus
                value={moduleSource}
                onChange={(e) => {
                  setModuleSource(e.target.value);
                  if (!moduleAliasEdited) {
                    const dir = e.target.value.split("/").pop() ?? "";
                    setModuleAlias(toPascalCase(dir));
                  }
                }}
                placeholder="./path/to/module"
                className={inputCls}
              />
            )}
            <input
              autoFocus={!!onPickModuleFile}
              value={moduleAlias}
              onChange={(e) => {
                setModuleAlias(e.target.value);
                setModuleAliasEdited(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmitModule();
                if (e.key === "Escape") handleCancelModule();
              }}
              placeholder="Alias"
              className={inputCls}
            />
            <div className="flex gap-1">
              <button
                onClick={handleSubmitModule}
                disabled={!moduleSource.trim() || !moduleAlias.trim() || moduleSubmitting}
                className={btnPrimary}
              >
                Add
              </button>
              <button onClick={handleCancelModule} className={btnGhost}>
                Cancel
              </button>
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
        {remoteImports.map((imp) => (
          <div
            key={imp.name}
            className={`group ${rowBase} ${rowHover} text-zinc-500 dark:text-zinc-400`}
          >
            <span className="flex-1 truncate">{imp.name}</span>
            <button
              onClick={() => onRemoveImport(imp.name)}
              className="invisible rounded px-1 text-zinc-400 hover:text-red-500 group-hover:visible dark:hover:text-red-400"
            >
              ×
            </button>
          </div>
        ))}

        {addingImport && (
          <div className="mx-3 mt-1 flex flex-col gap-1.5">
            <div className="relative">
              <input
                autoFocus
                value={importSource}
                onChange={(e) => handleImportSourceChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSuggestionIndex((i) => Math.min(i + 1, suggestions.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSuggestionIndex((i) => Math.max(i - 1, -1));
                  } else if (e.key === "Enter") {
                    if (suggestionIndex >= 0 && suggestions[suggestionIndex]) {
                      selectSuggestion(suggestions[suggestionIndex]);
                    } else {
                      handleSubmitImport();
                    }
                  } else if (e.key === "Escape") {
                    if (showSuggestions) {
                      setShowSuggestions(false);
                    } else {
                      handleCancelImport();
                    }
                  }
                }}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                onFocus={() => {
                  if (suggestions.length > 0) setShowSuggestions(true);
                }}
                placeholder="acme/module@1.0.0 or https://…"
                className={inputCls}
              />
              {showSuggestions && suggestions.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-10 mt-0.5 max-h-48 overflow-y-auto rounded border border-zinc-200 bg-white shadow-md dark:border-zinc-700 dark:bg-zinc-900">
                  {suggestions.map((result, i) => (
                    <button
                      key={result.id}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectSuggestion(result);
                      }}
                      className={`flex w-full flex-col px-2 py-1.5 text-left ${i === suggestionIndex ? "bg-zinc-100 dark:bg-zinc-800" : "hover:bg-zinc-50 dark:hover:bg-zinc-800"}`}
                    >
                      <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200">
                        {result.id}
                      </span>
                      {result.description && (
                        <span className="truncate text-xs text-zinc-400 dark:text-zinc-500">
                          {result.description}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <input
              value={importAlias}
              onChange={(e) => {
                setImportAlias(e.target.value);
                setImportAliasEdited(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmitImport();
                if (e.key === "Escape") handleCancelImport();
              }}
              placeholder="Alias"
              className={inputCls}
            />
            {importError && (
              <p className="text-xs text-red-500 dark:text-red-400">{importError}</p>
            )}
            <div className="flex gap-1">
              <button
                onClick={handleSubmitImport}
                disabled={!importSource.trim() || !importAlias.trim() || importSubmitting}
                className={btnPrimary}
              >
                {importSubmitting ? "Adding…" : "Add"}
              </button>
              <button onClick={handleCancelImport} disabled={importSubmitting} className={btnGhost}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="mx-3 border-t border-zinc-100 dark:border-zinc-800" />

      {/* Resources */}
      <div className="pb-1 pt-2">
        <SectionHeader label="Resources" onAdd={activeManifest ? onCreateResource : undefined} />
        {userResources.length === 0 && <EmptyHint text="No resources" />}
        {userResources.map((r) => (
          <div
            key={`${r.kind}/${r.name}`}
            className={`${rowBase} ${selectedResource?.kind === r.kind && selectedResource?.name === r.name ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100" : graphContext?.kind === r.kind && graphContext?.name === r.name ? "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" : `text-zinc-600 dark:text-zinc-400 ${rowHover}`} cursor-pointer`}
            onClick={() => {
              const kind = kindsByFullKind.get(r.kind);
              if (kind?.topology) {
                onNavigateResource(r.kind, r.name);
                return;
              }
              onSelectResource(r.kind, r.name);
            }}
          >
            <span className="min-w-0 truncate">
              <span className="text-zinc-400 dark:text-zinc-500">{r.kind.split(".")[0]}.</span>
              {r.name}
            </span>
            {kindsByFullKind.get(r.kind)?.topology && (
              <span className="ml-auto rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-900/60 dark:text-amber-200">
                {kindsByFullKind.get(r.kind)?.topology}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="mx-3 border-t border-zinc-100 dark:border-zinc-800" />

      {/* Definitions */}
      <div className="pb-1 pt-2">
        <SectionHeader label="Definitions" />
        {definitions.length === 0 && <EmptyHint text="No definitions" />}
        {definitions.map((r) => (
          <div
            key={r.name}
            className={`${rowBase} ${selectedResource?.name === r.name ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100" : `text-zinc-600 dark:text-zinc-400 ${rowHover}`}`}
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
  );
}
