import { Input } from "../../ui/input";
import type { DeclaredPortEntry } from "./declared-ports";

interface PortsEditorProps {
  /** Application's declared ports projected via `extractDeclaredPorts`. */
  entries: DeclaredPortEntry[];
  /** Current run-config env values — the same map the env editors edit. */
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

export function PortsEditor({ entries, value, onChange }: PortsEditorProps) {
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
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide dark:text-zinc-400">
          Ports
        </span>
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
          Declared in the Application's ports: block. The value sets the bound env
          var and the port the Application is exposed on when it runs.
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {entries.map((entry) => (
          <Row
            key={entry.name}
            entry={entry}
            currentValue={value[entry.envVar] ?? ""}
            onUpdate={update}
          />
        ))}
      </div>
    </div>
  );
}

interface RowProps {
  entry: DeclaredPortEntry;
  currentValue: string;
  onUpdate: (envVar: string, next: string) => void;
}

function Row({ entry, currentValue, onUpdate }: RowProps) {
  const invalid = currentValue !== "" && !isValidPort(currentValue);
  const placeholder =
    entry.defaultText !== undefined ? `default: ${entry.defaultText}` : "port";
  return (
    <div className="flex flex-col gap-1 rounded-md border border-zinc-200 bg-zinc-50/40 p-2 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-xs font-medium text-zinc-700 dark:text-zinc-200">
          {entry.name}
        </span>
        <span className="rounded bg-zinc-200 px-1 font-mono text-[10px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          {entry.envVar}
        </span>
        <span className="text-[10px] text-zinc-500 dark:text-zinc-500">{entry.protocol}</span>
      </div>
      <Input
        placeholder={placeholder}
        inputMode="numeric"
        value={currentValue}
        onChange={(e) => onUpdate(entry.envVar, e.target.value)}
        className="font-mono text-xs"
        spellCheck={false}
        autoComplete="off"
        aria-invalid={invalid}
      />
      {invalid && (
        <span className="text-[10px] text-red-600 dark:text-red-400">
          Enter a port between 1 and 65535.
        </span>
      )}
    </div>
  );
}

function isValidPort(s: string): boolean {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 && n <= 65535;
}
