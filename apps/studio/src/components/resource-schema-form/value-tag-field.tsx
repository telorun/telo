import { makeTaggedSentinel, normalizeIncludePath } from "@telorun/templating";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CelEvalMode } from "./cel-utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { tagOf, tagSourceOf, type ValueTagOption } from "./value-tag";

/** The untagged option. Not an engine, so it carries no entry in the authoring
 *  table — but it is always a choice, and the picker has to name it. */
const PLAIN = "plain";

interface ValueTagFieldProps {
  /** Tags offerable here, from `offeredValueTags`. Never empty when rendered. */
  options: ValueTagOption[];
  /** When the field is CEL-eligible: whether its expressions run at load or per
   *  invocation. Shown beside `!cel`, since the same expression means different
   *  things in the two. */
  evalMode: CelEvalMode | null;
  value: unknown;
  onValueChange: (next: unknown) => void;
  onBlur: () => void;
  /** The ordinary widget for an untagged value. */
  children: React.ReactNode;
}

/**
 * Chooses how a field's value is WRITTEN, and edits it accordingly.
 *
 * This replaced a two-state CEL toggle, which had a defect the shape made
 * unavoidable: "expression mode" wrote a raw string containing `${{ }}`, the one
 * spelling manifests must never carry. The formatter normalizes it to `!cel`,
 * and on round trip it has been silently rewritten into a broken `!ref`. Writing
 * the tag itself is not a fix applied here — it is what a tag picker does, so
 * the spelling cannot come back.
 *
 * Each tag keeps its OWN draft while the field is open, so moving between them
 * and back returns what you had rather than clearing it. Drafts are per mount,
 * not persisted: they exist so a switch is reversible, not so a field remembers
 * an abandoned edit.
 */
export function ValueTagField({
  options,
  evalMode,
  value,
  onValueChange,
  onBlur,
  children,
}: ValueTagFieldProps) {
  const [active, setActive] = useState<string>(() => tagOf(value) ?? PLAIN);
  const drafts = useRef<Map<string, string>>(new Map());
  // The untagged value, held across a detour through a tag so switching back
  // restores it — a typed value is not recoverable from an expression's text.
  const plainValue = useRef<unknown>(tagOf(value) ? undefined : value);

  // The manifest is the authority: an edit from anywhere else (Source view, the
  // agent, an undo) re-selects the tag actually written.
  useEffect(() => {
    const tag = tagOf(value);
    setActive(tag ?? PLAIN);
    if (tag) drafts.current.set(tag, tagSourceOf(value));
    else plainValue.current = value;
  }, [value]);

  function select(next: string) {
    setActive(next);
    if (next === PLAIN) {
      onValueChange(plainValue.current);
      return;
    }
    onValueChange(makeTaggedSentinel(next, drafts.current.get(next) ?? ""));
  }

  function write(source: string) {
    drafts.current.set(active, source);
    onValueChange(makeTaggedSentinel(active, source));
  }

  const option = options.find((o) => o.id === active);
  const source = tagSourceOf(value);
  // Reported for a path as it is typed rather than at save: an escaping or
  // absolute path is refused by the analyzer, and finding that out from a
  // diagnostic on another line is finding out too late.
  const pathError =
    option?.editor === "path" && source ? normalizeIncludePath(source).diagnostic?.message : undefined;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                option
                  ? "bg-violet-100 text-violet-700 hover:bg-violet-200 dark:bg-violet-900/50 dark:text-violet-300"
                  : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400"
              }`}
              title="How this value is written"
            >
              <span className="font-mono">{option?.label ?? "value"}</span>
              <ChevronDown className="size-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-auto min-w-64">
            <DropdownMenuItem className="text-xs" onSelect={() => select(PLAIN)}>
              <span className="flex flex-col gap-0.5">
                <span className="font-mono">value</span>
                <span className="text-[10px] text-zinc-400">
                  Written as itself, with no tag.
                </span>
              </span>
            </DropdownMenuItem>
            {options.map((o) => (
              <DropdownMenuItem key={o.id} className="text-xs" onSelect={() => select(o.id)}>
                <span className="flex flex-col gap-0.5">
                  <span className="font-mono">{o.label}</span>
                  <span className="text-[10px] text-zinc-400">{o.hint}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Only `!cel` is evaluated per scope, so only it is qualified by when.
            Saying "compile" beside `!literal` would describe the field, not the
            value, and the value is what the tag is about. */}
        {active === "cel" && evalMode && (
          <span className="text-[10px] text-violet-500 dark:text-violet-400">{evalMode}</span>
        )}
      </div>

      {!option ? (
        children
      ) : (
        <>
          <input
            type="text"
            value={source}
            onChange={(e) => write(e.target.value)}
            onBlur={onBlur}
            placeholder={option.editor === "path" ? "./assets/schema.sql" : "variables.value"}
            className={`w-full rounded border px-3 py-1 font-mono text-sm outline-none ${
              pathError
                ? "border-red-400 bg-red-50/50 text-red-900 dark:border-red-700 dark:bg-red-950/30 dark:text-red-100"
                : "border-violet-300 bg-violet-50/50 text-violet-900 placeholder:text-violet-300 focus:border-violet-500 dark:border-violet-700 dark:bg-violet-950/30 dark:text-violet-100 dark:placeholder:text-violet-700"
            }`}
          />
          {pathError && (
            <span className="text-[10px] leading-tight text-red-500">{pathError}</span>
          )}
          {option.editor === "path" && !pathError && (
            // The rule that is not guessable from the input: a path is measured
            // from the MODULE ROOT, not from the file the value is written in,
            // because publish inlines every partial into one manifest and a
            // per-file path would silently move.
            <span className="text-[10px] leading-tight text-zinc-400">
              Relative to the module root, and must stay inside it.
            </span>
          )}
        </>
      )}
    </div>
  );
}
