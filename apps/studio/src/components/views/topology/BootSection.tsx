import type { AnalysisRegistry, GraphRow, ModuleGraph } from "@telorun/analyzer";
import { Braces, ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";
import type { ParsedResource, Selection } from "../../../model";
import {
  BOOT_FIELD,
  bootConstraint,
  bootEntries,
  bootEntryLabel,
  bootEntryPointer,
  bootMarkers,
  bootRows,
  withBootTarget,
  type BootEntry,
} from "./boot-targets";
import { entrySchemaFor } from "./module-graph-view/entry-schema";
import { jsonPointer } from "./module-graph-view/field-pointer";
import { referenceableTargets, referenceName } from "./module-graph-view/wire";
import { Chip, isSelected, type ChipAction } from "./ModuleBarChip";
import { Section } from "./ModuleBarSection";

/**
 * The Application's boot sequence, `targets:`, in order.
 *
 * Every entry is listed whatever its spelling — a bare reference, a gated one,
 * an inline invoke step — because the canvas marks only the resources an entry
 * STARTS, and an entry nothing marks would otherwise be visible nowhere but the
 * source. Order is behaviour, so it is edited as a sequence: moved and removed
 * in place, never rewritten from values, so each entry keeps its tag and its
 * comments.
 */
export function BootSection({
  root,
  moduleGraph,
  registry,
  moduleSchema,
  readOnly,
  selection,
  onWrite,
  onMoveField,
  onRemoveField,
  onSelect,
  onSelectResource,
}: {
  root: ParsedResource;
  moduleGraph: ModuleGraph | null;
  registry: AnalysisRegistry | null;
  moduleSchema: Record<string, unknown> | undefined;
  readOnly: boolean;
  selection: Selection | null;
  onWrite: (next: Record<string, unknown>) => void;
  onMoveField?: (target: { kind: string; name: string }, pointer: string, toIndex: number) => void;
  onRemoveField?: (target: { kind: string; name: string }, pointer: string) => void;
  onSelect: (selection: Selection) => void;
  onSelectResource: (kind: string, name: string) => void;
}) {
  const fields = root.fields;
  const entries = bootEntries(fields[BOOT_FIELD]);
  const rows = moduleGraph ? bootRows(entries, moduleGraph) : new Map<number, GraphRow>();
  const host = { kind: root.kind, name: root.name };

  // What may be added: every resource the `targets` slot accepts that no entry
  // starts yet — the same rule the canvas's toggle and a wire read.
  const refs = moduleGraph ? bootConstraint(moduleGraph) : undefined;
  const started = new Set(moduleGraph ? bootMarkers(entries, moduleGraph).keys() : []);
  const candidates =
    moduleGraph && registry && refs && refs.length > 0
      ? [
          ...new Set(
            referenceableTargets({ refs }, moduleGraph.nodes, registry)
              .filter((node) => !started.has(node.id))
              .map(referenceName),
          ),
        ].sort()
      : [];

  const entryActions = (entry: BootEntry): ChipAction[] => {
    const out: ChipAction[] = [];
    const pointer = bootEntryPointer(entry.index);
    const value = Array.isArray(fields[BOOT_FIELD])
      ? (fields[BOOT_FIELD] as unknown[])[entry.index]
      : undefined;
    // The entry's own configuration — a guard, a step's name — typed by the
    // branch of the union it is written in. A bare reference has none.
    const entrySchema = entrySchemaFor(moduleSchema, BOOT_FIELD, value);
    if (entrySchema) {
      out.push({
        key: "edit",
        icon: <SlidersHorizontal className="size-3.5" />,
        title: "Edit this entry",
        onClick: () => onSelect({ resource: host, pointer, schema: entrySchema }),
      });
    }
    // A step's arguments, typed by what its target declares it takes — the
    // contract `telo check` validates the call against.
    const row = rows.get(entry.index);
    if (row?.inputs) {
      const target = row.targetNode ? moduleGraph?.nodeById(row.targetNode) : undefined;
      const targetKind = target ? (target.canonicalKind ?? target.kind) : undefined;
      const schema = (targetKind ? registry?.inputTypeForKind(targetKind) : undefined) ?? {
        type: "object",
        additionalProperties: true,
      };
      out.push({
        key: "inputs",
        icon: <Braces className="size-3.5" />,
        title: "Edit this step's arguments",
        onClick: () =>
          onSelect({ resource: host, pointer: jsonPointer(row.inputs!), schema, celEval: "runtime" }),
      });
    }
    if (!readOnly && onMoveField && entry.index > 0) {
      out.push({
        key: "up",
        icon: <ChevronUp className="size-4" />,
        title: "Start earlier",
        onClick: () => onMoveField(host, pointer, entry.index - 1),
      });
    }
    if (!readOnly && onMoveField && entry.index < entries.length - 1) {
      out.push({
        key: "down",
        icon: <ChevronDown className="size-4" />,
        title: "Start later",
        onClick: () => onMoveField(host, pointer, entry.index + 1),
      });
    }
    return out;
  };

  /** The resource an entry runs, on the canvas — the entry's own form when it
   *  names nothing the graph resolved. */
  const openEntry = (entry: BootEntry): (() => void) | undefined => {
    const nodeId = rows.get(entry.index)?.targetNode;
    const node = nodeId ? moduleGraph?.nodeById(nodeId) : undefined;
    if (node && !node.root) return () => onSelectResource(node.kind, node.name);
    const value = Array.isArray(fields[BOOT_FIELD])
      ? (fields[BOOT_FIELD] as unknown[])[entry.index]
      : undefined;
    const schema = entrySchemaFor(moduleSchema, BOOT_FIELD, value);
    return schema
      ? () => onSelect({ resource: host, pointer: bootEntryPointer(entry.index), schema })
      : undefined;
  };

  return (
    <Section
      title="Boot"
      addTitle="Start a resource at boot"
      addMenu={
        readOnly || candidates.length === 0
          ? undefined
          : candidates.map((name) => ({
              name,
              onSelect: () =>
                onWrite({ ...fields, [BOOT_FIELD]: withBootTarget(fields[BOOT_FIELD], name) }),
            }))
      }
    >
      {entries.map((entry) => {
        const details = [
          ...(entry.form === "step" && entry.name && entry.target ? [`invoke ${entry.target}`] : []),
          ...(entry.when !== undefined ? [`when ${entry.when}`] : []),
        ];
        return (
          <Chip
            key={entry.index}
            chip={{
              name: `${entry.index + 1}. ${bootEntryLabel(entry)}`,
              ...(details.length > 0 ? { detail: details.join(" · ") } : {}),
            }}
            {...(entry.form === "step" ? { badge: "invoke" } : {})}
            active={isSelected(selection, root, bootEntryPointer(entry.index))}
            onOpen={openEntry(entry)}
            actions={entryActions(entry)}
            onRemove={
              readOnly || !onRemoveField
                ? undefined
                : () => onRemoveField(host, bootEntryPointer(entry.index))
            }
          />
        );
      })}
    </Section>
  );
}
