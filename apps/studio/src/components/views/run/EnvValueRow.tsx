import { Eye, EyeOff, Lock, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

export interface EnvValueRowProps {
  /** The declared name, the env var it binds and a short type label. */
  name: string;
  envVar: string;
  label: string;
  secret?: boolean;
  /** The resolved value; undefined when no env file sets it. */
  value: string | undefined;
  /** The workspace-relative file the value comes from. */
  source: string | undefined;
  /** What an unset value means for a run. */
  unsetNote: string;
  /** Unset with no default: a run is refused until it is set. */
  blocking: boolean;
  /** `telo run`'s warning for a secret read from a file not marked sensitive. */
  warning?: string;
  /** Why an unset value cannot be written anywhere. */
  unwritable?: string;
  /** A refusal of the draft before anything is written. */
  validate?: (draft: string) => string | null;
  placeholder: string;
  inputMode?: "numeric";
  disabled: boolean;
  /** Writes the value — empty clears it — rejecting with the reason. */
  onCommit: (next: string) => Promise<void>;
  footer?: ReactNode;
}

/** One declared input of the Application: its value and the file it comes from,
 *  edited in place. An edit is written when the field is left or Enter is
 *  pressed — a file per keystroke would re-read the files under the cursor. */
export function EnvValueRow(props: EnvValueRowProps) {
  const { secret, value, source, disabled, unwritable } = props;
  const [revealed, setRevealed] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);

  const shown = draft ?? value ?? "";
  const invalid = draft !== null && draft !== "" ? (props.validate?.(draft) ?? null) : null;
  const locked = disabled || writing || (value === undefined && unwritable !== undefined);

  async function commit() {
    if (draft === null) return;
    if (draft === (value ?? "") || invalid) {
      if (!invalid) setDraft(null);
      return;
    }
    setWriting(true);
    setFailure(null);
    try {
      await props.onCommit(draft);
      setDraft(null);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setWriting(false);
    }
  }

  return (
    <div className="flex flex-col gap-1 rounded-md border border-zinc-200 bg-zinc-50/40 p-2 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex flex-wrap items-center gap-1.5">
        {secret && <Lock className="size-3 text-zinc-500" aria-label="Secret — redacted in logs" />}
        <span className="font-mono text-xs font-medium text-zinc-700 dark:text-zinc-200">
          {props.name}
        </span>
        <span className="rounded bg-zinc-200 px-1 font-mono text-[10px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          {props.envVar}
        </span>
        <span className="text-[10px] text-zinc-500">{props.label}</span>
        <span className="flex-1" />
        {source !== undefined ? (
          <span className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400" title="The file this value comes from">
            {source}
          </span>
        ) : (
          <span
            className={`text-[10px] ${props.blocking ? "text-red-600 dark:text-red-400" : "text-zinc-500 dark:text-zinc-400"}`}
          >
            {props.unsetNote}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          placeholder={props.placeholder}
          value={shown}
          inputMode={props.inputMode}
          disabled={locked}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") {
              setDraft(null);
              setFailure(null);
            }
          }}
          className="flex-1 font-mono text-xs"
          type={secret && !revealed ? "password" : "text"}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid !== null || failure !== null}
        />
        {secret && (
          <Button
            size="icon"
            variant="ghost"
            type="button"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? "Hide secret value" : "Reveal secret value"}
            aria-pressed={revealed}
            className="size-7 shrink-0"
          >
            {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </Button>
        )}
      </div>
      {props.warning && (
        <span className="flex items-start gap-1 text-[10px] text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
          {props.warning}
        </span>
      )}
      {value === undefined && unwritable && (
        <span className="text-[10px] text-red-600 dark:text-red-400">{unwritable}</span>
      )}
      {(invalid ?? failure) && (
        <span className="text-[10px] text-red-600 dark:text-red-400">{invalid ?? failure}</span>
      )}
      {props.footer}
    </div>
  );
}
