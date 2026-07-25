import { useEffect, useState } from "react";
import { AlertCircle, Boxes, Check, FileText, Loader2, RotateCw } from "lucide-react";
import {
  fetchTemplateCatalog,
  ModuleExistsError,
  type NewModuleSelection,
  type TemplateCategory,
  type TemplateDescriptor,
} from "../loader";
import type { ModuleKind } from "../model";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

interface CreateModuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: ModuleKind;
  /** Resolved templates base URL the catalog is fetched from. */
  templatesBaseUrl: string;
  /** Creates the module; throws `ModuleExistsError` on an un-forced collision. */
  onCreate: (
    kind: ModuleKind,
    name: string,
    selection: NewModuleSelection,
    opts?: { overwrite?: boolean },
  ) => Promise<void>;
}

const BLANK_ID = "__blank__";
// metadata.name is the kind prefix; accept PascalCase (WeatherApi) and the
// kebab-case the stdlib uses (weather-api). The directory is slugified from it.
const NAME_RE = /^[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)*$/;

function categoryFor(kind: ModuleKind): TemplateCategory {
  return kind === "Application" ? "app" : "library";
}

export function CreateModuleDialog({
  open,
  onOpenChange,
  kind,
  templatesBaseUrl,
  onCreate,
}: CreateModuleDialogProps) {
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState<string>(BLANK_ID);
  const [templates, setTemplates] = useState<TemplateDescriptor[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState<{ relativeDir: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const category = categoryFor(kind);
  const kindLabel = kind === "Application" ? "application" : "library";

  // Load the catalog whenever the dialog opens (and on explicit retry).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingCatalog(true);
    setCatalogError(null);
    fetchTemplateCatalog(templatesBaseUrl)
      .then((catalog) => {
        if (cancelled) return;
        setTemplates(catalog.templates.filter((t) => t.category === category));
      })
      .catch((err) => {
        if (cancelled) return;
        setTemplates([]);
        setCatalogError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingCatalog(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, templatesBaseUrl, category, reloadKey]);

  function reset() {
    setName("");
    setSelectedId(BLANK_ID);
    setSubmitError(null);
    setOverwrite(null);
    setSubmitting(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function selectionFor(id: string): NewModuleSelection {
    if (id === BLANK_ID) return { type: "blank" };
    const template = templates?.find((t) => t.id === id);
    if (!template) return { type: "blank" };
    return { type: "template", template };
  }

  async function submit(force: boolean) {
    const trimmed = name.trim();
    if (!trimmed) {
      setSubmitError("Name is required");
      return;
    }
    if (!NAME_RE.test(trimmed)) {
      setSubmitError("Use letters, digits and hyphens, starting with a letter (e.g. WeatherApi)");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onCreate(kind, trimmed, selectionFor(selectedId), force ? { overwrite: true } : undefined);
      handleOpenChange(false);
    } catch (err) {
      if (err instanceof ModuleExistsError) {
        setOverwrite({ relativeDir: err.relativeDir });
      } else {
        setSubmitError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const options: { id: string; title: string; description: string }[] = [
    {
      id: BLANK_ID,
      title: `Blank ${kindLabel}`,
      description: "An empty module — just kind and metadata.",
    },
    ...(templates ?? []).map((t) => ({ id: t.id, title: t.title, description: t.description })),
  ];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-140">
        <DialogHeader>
          <DialogTitle>New {kindLabel}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Name</label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSubmitError(null);
                setOverwrite(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit(false);
              }}
              placeholder="WeatherApi"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Start from
            </span>
            {loadingCatalog && (
              <div className="flex items-center gap-2 px-1 py-2 text-xs text-zinc-500">
                <Loader2 className="size-3.5 animate-spin" /> Loading templates…
              </div>
            )}
            <div className="grid max-h-72 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
              {options.map((opt) => {
                const active = opt.id === selectedId;
                const isBlank = opt.id === BLANK_ID;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setSelectedId(opt.id)}
                    className={`flex items-start gap-2 rounded border px-3 py-2 text-left transition-colors ${
                      active
                        ? "border-zinc-500 bg-zinc-100 dark:border-zinc-400 dark:bg-zinc-800"
                        : "border-zinc-200 bg-zinc-50 hover:border-zinc-300 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
                    }`}
                  >
                    <span className="mt-0.5 text-zinc-400">
                      {isBlank ? (
                        <FileText className="size-4" />
                      ) : (
                        <Boxes className="size-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">
                        {opt.title}
                        {active && <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />}
                      </span>
                      <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
                        {opt.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {catalogError && (
              <div className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <div className="flex-1">
                  <p>Couldn't load templates. You can still start blank.</p>
                  <button
                    className="mt-1 inline-flex items-center gap-1 font-medium underline"
                    onClick={() => setReloadKey((k) => k + 1)}
                  >
                    <RotateCw className="size-3" /> Retry
                  </button>
                </div>
              </div>
            )}
          </div>

          {submitError && <p className="text-xs text-red-500 dark:text-red-400">{submitError}</p>}

          {overwrite ? (
            <div className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs dark:border-amber-900 dark:bg-amber-950">
              <p className="text-amber-800 dark:text-amber-300">
                <code>{overwrite.relativeDir}</code> already exists. Overwriting deletes the whole
                directory — every file in it — and replaces it. Continue?
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setOverwrite(null)} disabled={submitting}>
                  Cancel
                </Button>
                <Button variant="destructive" size="sm" onClick={() => void submit(true)} disabled={submitting}>
                  {submitting ? "Overwriting…" : "Overwrite"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => handleOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void submit(false)} disabled={!name.trim() || submitting}>
                {submitting ? "Creating…" : "Create"}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
