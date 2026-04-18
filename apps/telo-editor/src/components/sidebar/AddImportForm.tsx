import { useEffect, useRef, useState } from "react";
import { toPascalCase } from "../../loader";
import type { RegistryServer } from "../../model";
import { Button } from "../ui/button";
import { inputCls } from "./primitives";

interface RegistryResult {
  id: string;
  namespace: string;
  name: string;
  version: string;
  description: string | null;
}

interface AddImportFormProps {
  registryServers: RegistryServer[];
  onSubmit: (source: string, alias: string) => Promise<void>;
  onCancel: () => void;
}

function deriveAlias(source: string): string {
  const name =
    source
      .split("/")
      .pop()
      ?.split("@")[0]
      ?.replace(/\.ya?ml$/, "") ?? "";
  return toPascalCase(name) || "";
}

export function AddImportForm({ registryServers, onSubmit, onCancel }: AddImportFormProps) {
  const [source, setSource] = useState("");
  const [alias, setAlias] = useState("");
  const [aliasEdited, setAliasEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<RegistryResult[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressFetchRef = useRef(false);

  useEffect(() => {
    if (suppressFetchRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const query = source.trim();
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
  }, [source, registryServers]);

  function handleSourceChange(value: string) {
    setSource(value);
    if (!aliasEdited) setAlias(deriveAlias(value));
  }

  function selectSuggestion(result: RegistryResult) {
    suppressFetchRef.current = true;
    setSource(result.id);
    if (!aliasEdited) setAlias(deriveAlias(result.id));
    setShowSuggestions(false);
    setSuggestions([]);
    suppressFetchRef.current = false;
  }

  async function handleSubmit() {
    const s = source.trim();
    const a = alias.trim();
    if (!s || !a) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(s, a);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-3 mt-1 flex flex-col gap-1.5">
      <div className="relative">
        <input
          autoFocus
          value={source}
          onChange={(e) => handleSourceChange(e.target.value)}
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
                handleSubmit();
              }
            } else if (e.key === "Escape") {
              if (showSuggestions) {
                setShowSuggestions(false);
              } else {
                onCancel();
              }
            }
          }}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          onFocus={() => {
            if (suggestions.length > 0) setShowSuggestions(true);
          }}
          placeholder="./path, acme/module@1.0.0, https://…"
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
                className={`flex w-full flex-col px-2 py-1.5 text-left ${
                  i === suggestionIndex
                    ? "bg-zinc-100 dark:bg-zinc-800"
                    : "hover:bg-zinc-50 dark:hover:bg-zinc-800"
                }`}
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
        value={alias}
        onChange={(e) => {
          setAlias(e.target.value);
          setAliasEdited(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSubmit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Alias"
        className={inputCls}
      />
      {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
      <div className="flex gap-1">
        <Button
          size="xs"
          onClick={handleSubmit}
          disabled={!source.trim() || !alias.trim() || submitting}
        >
          {submitting ? "Adding…" : "Add"}
        </Button>
        <Button variant="ghost" size="xs" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
