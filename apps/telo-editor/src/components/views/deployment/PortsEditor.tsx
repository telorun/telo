import { useEffect, useMemo, useRef, useState } from "react";
import type { PortMapping } from "../../../model";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";

interface PortsEditorProps {
  value: PortMapping[];
  onChange: (next: PortMapping[]) => void;
}

interface Row {
  /** Stable across edits so typing in a field doesn't remount the input. */
  rowId: number;
  port: string;
  protocol: "tcp" | "udp";
}

let nextRowIdCounter = 0;
const newRowId = () => ++nextRowIdCounter;

function rowsFromMappings(mappings: PortMapping[]): Row[] {
  return mappings.map((m) => ({
    rowId: newRowId(),
    port: String(m.port),
    protocol: m.protocol,
  }));
}

function rowsToMappings(rows: Row[]): PortMapping[] {
  const out: PortMapping[] = [];
  for (const row of rows) {
    const port = Number(row.port);
    if (!Number.isFinite(port) || port <= 0) continue;
    out.push({ port, protocol: row.protocol });
  }
  return out;
}

function serializeMappings(mappings: PortMapping[]): string {
  return mappings.map((m) => `${m.port}/${m.protocol}`).join("|");
}

function isValidPort(s: string): boolean {
  if (s === "") return false;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 && n <= 65535;
}

export function PortsEditor({ value, onChange }: PortsEditorProps) {
  const [rows, setRows] = useState<Row[]>(() => rowsFromMappings(value));

  const externalKey = useMemo(() => serializeMappings(value), [value]);
  const lastCommittedKey = useRef(externalKey);
  useEffect(() => {
    if (lastCommittedKey.current !== externalKey) {
      lastCommittedKey.current = externalKey;
      setRows(rowsFromMappings(value));
    }
  }, [externalKey, value]);

  function commit(nextRows: Row[]) {
    setRows(nextRows);
    const mappings = rowsToMappings(nextRows);
    lastCommittedKey.current = serializeMappings(mappings);
    onChange(mappings);
  }

  function update(index: number, patch: Partial<Row>) {
    commit(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeRow(index: number) {
    commit(rows.filter((_, i) => i !== index));
  }

  function addRow() {
    commit([...rows, { rowId: newRowId(), port: "", protocol: "tcp" }]);
  }

  const duplicates = useMemo(
    () =>
      findDuplicates(
        rows
          .filter((r) => isValidPort(r.port))
          .map((r) => `${r.port}/${r.protocol}`),
      ),
    [rows],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide dark:text-zinc-400">
          Exposed ports
        </span>
        <Button size="sm" variant="outline" onClick={addRow}>
          + Add port
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          No ports exposed. Ports listed here are made reachable on the host
          when the Application runs.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((row, i) => {
            const portInvalid = row.port !== "" && !isValidPort(row.port);
            const isDup =
              isValidPort(row.port) &&
              duplicates.has(`${row.port}/${row.protocol}`);
            return (
              <div key={row.rowId} className="flex items-start gap-2">
                <div className="flex-1">
                  <Input
                    placeholder="port"
                    inputMode="numeric"
                    value={row.port}
                    onChange={(e) => update(i, { port: e.target.value })}
                    className="font-mono text-xs"
                    aria-invalid={portInvalid || isDup}
                  />
                  {isDup && (
                    <p className="mt-0.5 text-[10px] text-red-600 dark:text-red-400">
                      Duplicate port for this protocol.
                    </p>
                  )}
                  {portInvalid && !isDup && (
                    <p className="mt-0.5 text-[10px] text-red-600 dark:text-red-400">
                      Enter a port between 1 and 65535.
                    </p>
                  )}
                </div>
                <Select
                  value={row.protocol}
                  onValueChange={(v) =>
                    update(i, { protocol: v as "tcp" | "udp" })
                  }
                >
                  <SelectTrigger size="sm" className="w-20 font-mono text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tcp">tcp</SelectItem>
                    <SelectItem value="udp">udp</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => removeRow(i)}
                  aria-label="Remove port"
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
