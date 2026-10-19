import { useMemo } from "react";
import { EnvValueRow } from "./EnvValueRow";
import type { EnvRowFacts } from "./env-row-facts";

export interface DeclaredEnvEntry {
  /** Logical name as declared in `variables:` / `secrets:` (e.g. `port`). */
  name: string;
  /** Host env var the value comes from (e.g. `PORT`). */
  envVar: string;
  /** Declared type from the manifest entry. */
  type: "string" | "integer" | "number" | "boolean" | "object" | "array";
  /** Default rendered as a muted hint, never written as a value here. */
  defaultText?: string;
  /** One-line summary of the residual schema's extra constraints. */
  constraints?: string;
  /** True for entries under `secrets:`. */
  secret: boolean;
}

export interface DeclaredEnvEditorProps {
  /** Application's parsed manifest entries projected via `extractDeclaredEnvEntries`. */
  entries: DeclaredEnvEntry[];
  /** What the env files say about one env var, and how to write it. */
  facts: (envVar: string) => EnvRowFacts;
}

export function DeclaredEnvEditor({ entries, facts }: DeclaredEnvEditorProps) {
  const variables = useMemo(() => entries.filter((e) => !e.secret), [entries]);
  const secrets = useMemo(() => entries.filter((e) => e.secret), [entries]);

  if (entries.length === 0) return null;

  return (
    <div className="flex flex-col gap-4">
      {variables.length > 0 && (
        <Section
          label="Variables"
          description="Declared in the Application's variables: block, each read from its env var."
          entries={variables}
          facts={facts}
        />
      )}
      {secrets.length > 0 && (
        <Section
          label="Secrets"
          description="Declared in the Application's secrets: block. Redacted from logs at runtime; a new one is written to the env file the workspace marks sensitive."
          entries={secrets}
          facts={facts}
        />
      )}
    </div>
  );
}

function Section({
  label,
  description,
  entries,
  facts,
}: {
  label: string;
  description: string;
  entries: DeclaredEnvEntry[];
  facts: (envVar: string) => EnvRowFacts;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide dark:text-zinc-400">
          {label}
        </span>
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{description}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {entries.map((entry) => {
          const row = facts(entry.envVar);
          const required = entry.defaultText === undefined;
          return (
            <EnvValueRow
              key={entry.name}
              name={entry.name}
              envVar={entry.envVar}
              label={entry.type}
              secret={entry.secret}
              value={row.value}
              source={row.source}
              unsetNote={
                required ? "Unset — a run is refused until it is set" : `Unset — the default ${entry.defaultText} applies`
              }
              blocking={required}
              warning={row.warning}
              unwritable={row.unwritable}
              placeholder={required ? `${entry.type} value` : `default: ${entry.defaultText}`}
              disabled={row.disabled}
              onCommit={row.commit}
              footer={
                entry.constraints && (
                  <span className="text-[10px] text-zinc-500 dark:text-zinc-400">{entry.constraints}</span>
                )
              }
            />
          );
        })}
      </div>
    </div>
  );
}
