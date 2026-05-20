import { Eye, EyeOff, Lock } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

export interface DeclaredEnvEntry {
  /** Logical name as declared in `variables:` / `secrets:` (e.g. `port`). */
  name: string;
  /** Host env var the value comes from (e.g. `PORT`). */
  envVar: string;
  /** Declared type from the manifest entry. */
  type: "string" | "integer" | "number" | "boolean" | "object" | "array";
  /** Default rendered as a muted hint, never used as a real value here. */
  defaultText?: string;
  /** One-line summary of the residual schema's extra constraints. */
  constraints?: string;
  /** True for entries under `secrets:`. */
  secret: boolean;
}

export interface DeclaredEnvEditorProps {
  /** Application's parsed manifest entries projected via `extractDeclaredEnvEntries`. */
  entries: DeclaredEnvEntry[];
  /** Current run-config env values (the same map the free-form editor edits). */
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

export function DeclaredEnvEditor({ entries, value, onChange }: DeclaredEnvEditorProps) {
  const variables = useMemo(() => entries.filter((e) => !e.secret), [entries]);
  const secrets = useMemo(() => entries.filter((e) => e.secret), [entries]);

  if (entries.length === 0) return null;

  function update(envVar: string, next: string): void {
    if (next === "") {
      const { [envVar]: _omitted, ...rest } = value;
      onChange(rest);
      return;
    }
    onChange({ ...value, [envVar]: next });
  }

  return (
    <div className="flex flex-col gap-4">
      {variables.length > 0 && (
        <Section
          label="Variables"
          description="Declared in the Application's variables: block. Values supplied here are exported as the named env var when the Application runs."
          entries={variables}
          value={value}
          onUpdate={update}
        />
      )}
      {secrets.length > 0 && (
        <Section
          label="Secrets"
          description="Declared in the Application's secrets: block. Redacted from logs at runtime."
          entries={secrets}
          value={value}
          onUpdate={update}
        />
      )}
    </div>
  );
}

interface SectionProps {
  label: string;
  description: string;
  entries: DeclaredEnvEntry[];
  value: Record<string, string>;
  onUpdate: (envVar: string, next: string) => void;
}

function Section({ label, description, entries, value, onUpdate }: SectionProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide dark:text-zinc-400">
          {label}
        </span>
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{description}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {entries.map((entry) => (
          <Row
            key={entry.name}
            entry={entry}
            currentValue={value[entry.envVar] ?? ""}
            onUpdate={onUpdate}
          />
        ))}
      </div>
    </div>
  );
}

interface RowProps {
  entry: DeclaredEnvEntry;
  currentValue: string;
  onUpdate: (envVar: string, next: string) => void;
}

function Row({ entry, currentValue, onUpdate }: RowProps) {
  const [revealed, setRevealed] = useState(false);
  const placeholder =
    entry.defaultText !== undefined ? `default: ${entry.defaultText}` : `${entry.type} value`;
  const inputType = entry.secret && !revealed ? "password" : "text";
  return (
    <div className="flex flex-col gap-1 rounded-md border border-zinc-200 bg-zinc-50/40 p-2 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 items-center gap-1.5">
          {entry.secret && (
            <Lock
              className="size-3 text-zinc-500"
              aria-label="Secret — redacted in logs"
            />
          )}
          <span className="font-mono text-xs font-medium text-zinc-700 dark:text-zinc-200">
            {entry.name}
          </span>
          <span className="rounded bg-zinc-200 px-1 font-mono text-[10px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {entry.envVar}
          </span>
          <span className="text-[10px] text-zinc-500 dark:text-zinc-500">{entry.type}</span>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          placeholder={placeholder}
          value={currentValue}
          onChange={(e) => onUpdate(entry.envVar, e.target.value)}
          className="flex-1 font-mono text-xs"
          type={inputType}
          spellCheck={false}
          autoComplete="off"
        />
        {entry.secret && (
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
      {entry.constraints && (
        <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
          {entry.constraints}
        </span>
      )}
    </div>
  );
}
