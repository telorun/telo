import { EnvValueRow } from "./EnvValueRow";
import type { DeclaredPortEntry } from "./declared-ports";
import type { EnvRowFacts } from "./env-row-facts";

interface PortsEditorProps {
  /** Application's declared ports projected via `extractDeclaredPorts`. */
  entries: DeclaredPortEntry[];
  /** What the env files say about one env var, and how to write it. */
  facts: (envVar: string) => EnvRowFacts;
}

export function PortsEditor({ entries, facts }: PortsEditorProps) {
  if (entries.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide dark:text-zinc-400">
          Ports
        </span>
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
          Declared in the Application's ports: block. The value sets the bound env var and the port
          the Application is exposed on when it runs.
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {entries.map((entry) => {
          const row = facts(entry.envVar);
          return (
            <EnvValueRow
              key={entry.name}
              name={entry.name}
              envVar={entry.envVar}
              label={entry.protocol}
              value={row.value}
              source={row.source}
              unsetNote={
                entry.defaultText !== undefined
                  ? `Unset — the default ${entry.defaultText} applies`
                  : "Unset — no port is exposed for it"
              }
              blocking={false}
              unwritable={row.unwritable}
              validate={(draft) => (isValidPort(draft) ? null : "Enter a port between 1 and 65535.")}
              placeholder={entry.defaultText !== undefined ? `default: ${entry.defaultText}` : "port"}
              inputMode="numeric"
              disabled={row.disabled}
              onCommit={row.commit}
            />
          );
        })}
      </div>
    </div>
  );
}

function isValidPort(s: string): boolean {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 && n <= 65535;
}
