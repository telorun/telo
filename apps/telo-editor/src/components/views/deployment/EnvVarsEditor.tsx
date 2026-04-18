import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

interface EnvVarsEditorProps {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

interface Row {
  /** Stable across edits so typing in a key field doesn't remount the input
   *  (which would blur it on every keystroke if rows were keyed by their map
   *  key). */
  rowId: number;
  key: string;
  value: string;
}

let nextRowIdCounter = 0;
const newRowId = () => ++nextRowIdCounter;

function rowsFromMap(map: Record<string, string>): Row[] {
  return Object.entries(map).map(([key, value]) => ({
    rowId: newRowId(),
    key,
    value,
  }));
}

function rowsToMap(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (!row.key) continue;
    out[row.key] = row.value;
  }
  return out;
}

function serializeMap(map: Record<string, string>): string {
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("|");
}

export function EnvVarsEditor({ value, onChange }: EnvVarsEditorProps) {
  // Local working state: rows can have empty keys / duplicates during edit.
  // The reconciled map is pushed up on every commit via `commit()`.
  const [rows, setRows] = useState<Row[]>(() => rowsFromMap(value));

  // Reseed rows when the external map changes identity (app switch), but
  // ignore the echo of our own `onChange` — the ref below tracks which
  // serialization we last pushed up so we don't thrash.
  const externalKey = useMemo(() => serializeMap(value), [value]);
  const lastCommittedKey = useRef(externalKey);
  useEffect(() => {
    if (lastCommittedKey.current !== externalKey) {
      lastCommittedKey.current = externalKey;
      setRows(rowsFromMap(value));
    }
  }, [externalKey, value]);

  function commit(nextRows: Row[]) {
    setRows(nextRows);
    const map = rowsToMap(nextRows);
    lastCommittedKey.current = serializeMap(map);
    onChange(map);
  }

  function update(index: number, patch: Partial<Row>) {
    commit(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeRow(index: number) {
    commit(rows.filter((_, i) => i !== index));
  }

  function addRow() {
    commit([...rows, { rowId: newRowId(), key: "", value: "" }]);
  }

  const duplicates = useMemo(
    () => findDuplicates(rows.map((r) => r.key).filter(Boolean)),
    [rows],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide dark:text-zinc-400">
          Environment variables
        </span>
        <Button size="sm" variant="outline" onClick={addRow}>
          + Add variable
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          No environment variables defined. Variables set here are passed as{" "}
          <code className="rounded bg-zinc-100 px-1 font-mono text-[10px] dark:bg-zinc-800">
            -e KEY=VALUE
          </code>{" "}
          when the Application runs.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((row, i) => {
            const isDup = row.key !== "" && duplicates.has(row.key);
            return (
              <div key={row.rowId} className="flex items-start gap-2">
                <div className="flex-1">
                  <Input
                    placeholder="KEY"
                    value={row.key}
                    onChange={(e) => update(i, { key: e.target.value })}
                    className="font-mono text-xs"
                    aria-invalid={isDup}
                  />
                  {isDup && (
                    <p className="mt-0.5 text-[10px] text-red-600 dark:text-red-400">
                      Duplicate key — only the last value will be used.
                    </p>
                  )}
                </div>
                <Input
                  placeholder="value"
                  value={row.value}
                  onChange={(e) => update(i, { value: e.target.value })}
                  className="flex-1 font-mono text-xs"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => removeRow(i)}
                  aria-label="Remove variable"
                >
                  ×
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function findDuplicates(keys: string[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return dup;
}
