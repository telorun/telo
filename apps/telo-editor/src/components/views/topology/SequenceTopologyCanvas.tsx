import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "../../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../../ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { useEffect, useRef, useState, useMemo } from "react";
import type { Selection, ParsedResource } from "../../../model";
import { summarizeResource } from "../../../diagnostics-aggregate";
import { DiagnosticBadge } from "../../diagnostics/DiagnosticBadge";
import {
  useActiveFilePaths,
  useDiagnosticsState,
} from "../../diagnostics/DiagnosticsContext";
import {
  buildEditableSchema,
  getTopologyRole,
  getStepSchema,
  getVariantSymbol,
  getVariants,
  matchVariant,
  resolveRef,
  type VariantMeta,
} from "../../../schema-utils";
import { isRecord } from "../../../lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SequenceTopologyCanvasProps {
  resource: ParsedResource;
  schema: Record<string, unknown>;
  onUpdateResource: (kind: string, name: string, fields: Record<string, unknown>) => void;
  onSelect: (selection: Selection) => void;
  onBackgroundClick: () => void;
}

interface StepItem {
  id: string;
  stepData: Record<string, unknown>;
  variant: VariantMeta | null;
}

type ContainerMap = Record<string, StepItem[]>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

let idSeq = 0;
const uid = () => `s${++idSeq}`;

function getStepName(step: Record<string, unknown>): string {
  return typeof step.name === "string" && step.name ? step.name : "Unnamed";
}

function formatInvoke(invoke: unknown): string {
  if (typeof invoke === "string") return invoke || "—";
  if (isRecord(invoke)) {
    const kind = typeof invoke.kind === "string" ? invoke.kind : null;
    const name = typeof invoke.name === "string" ? invoke.name : null;
    if (kind && name) return `${kind} · ${name}`;
    if (name) return name;
    if (kind) return kind;
  }
  return "—";
}

function getConditionExpr(item: StepItem): string | null {
  const { variant, stepData } = item;
  if (!variant) return null;
  const field = variant.predicateFields[0] ?? variant.discriminatorFields[0] ?? null;
  if (!field) return null;
  return typeof stepData[field] === "string" ? (stepData[field] as string) : null;
}

function getControlFlowKeyword(variant: VariantMeta): string {
  const title = variant.title.trim();
  if (!title) return "";
  if (variant.predicateFields.length > 0 || variant.discriminatorFields.length > 0) {
    return title.split("/")[0].trim();
  }
  return title;
}

function buildNewStep(variant: VariantMeta, name: string): Record<string, unknown> {
  const step: Record<string, unknown> = { name };
  const skipRoles = new Set(["branch", "case-map", "branch-list", "invoke", "inputs"]);
  for (const f of variant.requiredFields) {
    if (f === "name") continue;
    const prop = isRecord(variant.schema.properties) ? variant.schema.properties[f] : undefined;
    const role = getTopologyRole(prop);
    if (typeof role === "string" && skipRoles.has(role)) continue;
    step[f] = "";
  }
  return step;
}

function formatVariantMenuLabel(variant: VariantMeta, index: number): string {
  const title = variant.title.trim();
  return title || `Variant ${index + 1}`;
}

// ─── Container map ────────────────────────────────────────────────────────────

function stepsToContainerMap(
  steps: unknown[],
  variants: VariantMeta[],
  root: unknown,
): ContainerMap {
  const map: ContainerMap = {};

  function process(steps: unknown[], containerId: string) {
    const items: StepItem[] = [];
    for (const step of steps) {
      const id = uid();
      const r = isRecord(step) ? step : {};
      const variant = matchVariant(r, variants);

      // Collect topology-structural field names for this variant
      const structuralFields = new Set<string>();
      if (variant) {
        for (const f of variant.branchFields) structuralFields.add(f);
        for (const f of variant.caseMaps) structuralFields.add(f);
        for (const f of variant.branchLists) structuralFields.add(f);
      }

      const stepData = Object.fromEntries(
        Object.entries(r).filter(([k]) => !structuralFields.has(k)),
      );
      items.push({ id, stepData, variant });

      if (variant) {
        // branch fields → one container each
        for (const f of variant.branchFields) {
          process(Array.isArray(r[f]) ? (r[f] as unknown[]) : [], `${id}.${f}`);
        }
        // case-map fields → one container per key + default
        for (const f of variant.caseMaps) {
          const cases = isRecord(r[f]) ? r[f] : {};
          for (const [key, val] of Object.entries(cases)) {
            process(Array.isArray(val) ? val : [], `${id}.${f}.${key}`);
          }
        }
        // branch-list fields (elseif): store predicates in stepData, branches in containers
        for (const f of variant.branchLists) {
          const entries = Array.isArray(r[f]) ? (r[f] as unknown[]) : [];
          // Predicates already captured in stepData (branch field stripped the `then`)
          // Re-capture: stepData[f] holds the list with branch fields stripped
          const variantSchemaProps = isRecord(variant.schema.properties) ? variant.schema.properties : {};
          const predicates = entries.map((entry) => {
            if (!isRecord(entry)) return {};
            const entryVariantProps = isRecord(variantSchemaProps[f]) ? variantSchemaProps[f] : {};
            const itemsSchema = resolveRef(
              isRecord(entryVariantProps) ? entryVariantProps.items : undefined,
              root,
            );
            const branchRoles = new Set(["branch", "case-map", "branch-list"]);
            const branchFieldsInEntry = isRecord(itemsSchema) && isRecord(itemsSchema.properties)
              ? Object.entries(itemsSchema.properties as Record<string, unknown>)
                  .filter(([, p]) => branchRoles.has(getTopologyRole(p) ?? ""))
                  .map(([k]) => k)
              : [];
            return Object.fromEntries(
              Object.entries(entry).filter(([k]) => !branchFieldsInEntry.includes(k)),
            );
          });
          stepData[f] = predicates;
          entries.forEach((entry, i) => {
            if (!isRecord(entry)) { map[`${id}.${f}.${i}`] = []; return; }
            // find branch field in entry (first property with role: branch)
            const branchKey = (() => {
              const entryVariantProps: Record<string, unknown> = isRecord(variantSchemaProps[f]) ? variantSchemaProps[f] : {};
              const itemsSchema = resolveRef(entryVariantProps.items, root);
              if (!isRecord(itemsSchema) || !isRecord(itemsSchema.properties)) return "then";
              for (const [k, p] of Object.entries(itemsSchema.properties as Record<string, unknown>)) {
                if (getTopologyRole(p) === "branch") return k;
              }
              return "then";
            })();
            process(Array.isArray(entry[branchKey]) ? (entry[branchKey] as unknown[]) : [], `${id}.${f}.${i}`);
          });
        }
      }
    }
    map[containerId] = items;
  }

  process(steps, "root");
  return map;
}

function containerMapToSteps(
  map: ContainerMap,
  variants: VariantMeta[],
  root: unknown,
  containerId = "root",
): unknown[] {
  return (map[containerId] ?? []).map((item) => {
    const step: Record<string, unknown> = { ...item.stepData };
    const { variant } = item;
    if (!variant) return step;

    for (const f of variant.branchFields) {
      step[f] = containerMapToSteps(map, variants, root, `${item.id}.${f}`);
    }
    for (const f of variant.caseMaps) {
      const cases: Record<string, unknown[]> = {};
      const prefix = `${item.id}.${f}.`;
      for (const key of Object.keys(map)) {
        if (key.startsWith(prefix)) {
          cases[key.slice(prefix.length)] = containerMapToSteps(map, variants, root, key);
        }
      }
      step[f] = cases;
    }
    for (const f of variant.branchLists) {
      const predicates = Array.isArray(item.stepData[f]) ? (item.stepData[f] as unknown[]) : [];
      // Find branch field name from the branch-list items schema
      const variantProps2 = isRecord(variant.schema.properties) ? variant.schema.properties : {};
      const entryVariantProps: Record<string, unknown> = isRecord(variantProps2[f]) ? variantProps2[f] : {};
      const itemsSchema = resolveRef(
        entryVariantProps.items,
        root,
      );
      const branchKey = (() => {
        if (!isRecord(itemsSchema) || !isRecord(itemsSchema.properties)) return "then";
        for (const [k, p] of Object.entries(itemsSchema.properties as Record<string, unknown>)) {
          if (getTopologyRole(p) === "branch") return k;
        }
        return "then";
      })();
      step[f] = predicates.map((pred, i) => ({
        ...(isRecord(pred) ? pred : {}),
        [branchKey]: containerMapToSteps(map, variants, root, `${item.id}.${f}.${i}`),
      }));
    }

    return step;
  });
}

function findContainer(id: string, map: ContainerMap): string | null {
  if (id in map) return id;
  for (const [cid, items] of Object.entries(map)) {
    if (items.some((i) => i.id === id)) return cid;
  }
  return null;
}

function resolveBranchKey(variant: VariantMeta, field: string, root: unknown): string {
  const vProps = isRecord(variant.schema.properties) ? variant.schema.properties : {};
  const listProp: Record<string, unknown> = isRecord(vProps[field]) ? vProps[field] : {};
  const itemsSchema = resolveRef(listProp.items, root);
  if (isRecord(itemsSchema) && isRecord(itemsSchema.properties)) {
    for (const [k, p] of Object.entries(itemsSchema.properties as Record<string, unknown>)) {
      if (getTopologyRole(p) === "branch") return k;
    }
  }
  return "then";
}

function resolvePointer(
  itemId: string,
  map: ContainerMap,
  root: unknown,
): string | null {
  const segments: (string | number)[] = [];
  let currentId = itemId;

  for (;;) {
    const containerId = findContainer(currentId, map);
    if (!containerId) return null;

    const items = map[containerId] ?? [];
    const idx = items.findIndex((i) => i.id === currentId);
    if (idx < 0) return null;

    segments.unshift(idx);

    if (containerId === "root") {
      segments.unshift("steps");
      break;
    }

    const dotIdx = containerId.indexOf(".");
    if (dotIdx < 0) return null;

    const parentItemId = containerId.slice(0, dotIdx);
    const rest = containerId.slice(dotIdx + 1);

    const parentContainerId = findContainer(parentItemId, map);
    if (!parentContainerId) return null;
    const parentItem = (map[parentContainerId] ?? []).find((i) => i.id === parentItemId);
    if (!parentItem?.variant) {
      segments.unshift(...rest.split("."));
      currentId = parentItemId;
      continue;
    }

    const variant = parentItem.variant;

    if (variant.branchFields.includes(rest)) {
      segments.unshift(rest);
    } else {
      let handled = false;
      for (const f of variant.caseMaps) {
        if (rest === f || rest.startsWith(f + ".")) {
          const key = rest.slice(f.length + 1);
          segments.unshift(f, key);
          handled = true;
          break;
        }
      }
      if (!handled) {
        for (const f of variant.branchLists) {
          if (rest.startsWith(f + ".")) {
            const branchIdx = rest.slice(f.length + 1);
            const branchKey = resolveBranchKey(variant, f, root);
            segments.unshift(f, branchIdx, branchKey);
            handled = true;
            break;
          }
        }
      }
      if (!handled) {
        segments.unshift(...rest.split("."));
      }
    }

    currentId = parentItemId;
  }

  return "/" + segments.join("/");
}

function initBranchContainers(id: string, variant: VariantMeta): ContainerMap {
  const map: ContainerMap = {};
  for (const f of variant.branchFields) map[`${id}.${f}`] = [];
  for (const f of variant.caseMaps) map[`${id}.${f}.default`] = [];
  return map;
}

// ─── Step card content ────────────────────────────────────────────────────────

function StepCardContent({
  item,
  overlay = false,
  onRemove,
  dragHandleProps,
}: {
  item: StepItem;
  overlay?: boolean;
  onRemove?: () => void;
  dragHandleProps?: Record<string, unknown>;
}) {
  const { variant, stepData } = item;
  const symbol = variant ? getVariantSymbol(variant) : null;
  const isControlFlow = symbol !== null && variant?.invokeField === null;
  const condExpr = getConditionExpr(item);
  const keyword = isControlFlow && variant ? getControlFlowKeyword(variant) : null;
  const hasKeyword = keyword !== null || variant?.invokeField !== null;

  return (
    <div className={`flex items-center gap-3 px-4 py-3 ${overlay ? "opacity-90" : ""}`}>
      {isControlFlow && keyword ? (
        <>
          <span className="shrink-0 font-mono text-sm font-semibold text-violet-600 dark:text-violet-400">
            {keyword}
          </span>
          {condExpr ? (
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-zinc-600 dark:text-zinc-300">
              {condExpr}
            </span>
          ) : (
            <span className="min-w-0 flex-1" />
          )}
        </>
      ) : variant?.invokeField ? (
        <>
          <span className="shrink-0 font-mono text-sm font-semibold text-violet-600 dark:text-violet-400">
            invoke
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-sm text-zinc-600 dark:text-zinc-300">
            {formatInvoke(stepData[variant.invokeField])}
          </span>
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {getStepName(stepData)}
        </span>
      )}
      {hasKeyword && (
        <span className="shrink-0 truncate text-xs text-zinc-400 dark:text-zinc-600">
          {getStepName(stepData)}
        </span>
      )}
      {onRemove && !overlay && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:text-zinc-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
          aria-label="Delete step"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3.5 4.5h9" strokeLinecap="round" />
            <path d="M6.5 2.5h3" strokeLinecap="round" />
            <path d="M5 4.5v7.25a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M6.75 6.75v3.5M9.25 6.75v3.5" strokeLinecap="round" />
          </svg>
        </Button>
      )}
      <span
        className="ml-1 shrink-0 cursor-grab select-none text-base text-zinc-300 dark:text-zinc-700"
        {...dragHandleProps}
      >
        ⠿
      </span>
    </div>
  );
}

// ─── Branch section ────────────────────────────────────────────────────────────

interface BranchSectionProps {
  label: string;
  containerId: string;
  containerMap: ContainerMap;
  depth: number;
  variants: VariantMeta[];
  root: unknown;
  onAdd: (containerId: string, variant: VariantMeta, afterId?: string) => void;
  onRemove: (itemId: string, containerId: string) => void;
  onSelect: (item: StepItem, containerId: string) => void;
}

function BranchSection({
  label,
  containerId,
  containerMap,
  depth,
  variants,
  root,
  onAdd,
  onRemove,
  onSelect,
}: BranchSectionProps) {
  const items = containerMap[containerId] ?? [];
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-zinc-100 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="font-mono text-xs font-medium text-zinc-400 dark:text-zinc-500">
          {label}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="xs">
              + step
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {variants.map((v, i) => (
              <DropdownMenuItem key={i} onClick={() => onAdd(containerId, v)}>
                {formatVariantMenuLabel(v, i)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="px-2 pb-2">
        <StepList
          containerId={containerId}
          items={items}
          containerMap={containerMap}
          depth={depth}
          variants={variants}
          root={root}
          onAdd={onAdd}
          onRemove={onRemove}
          onSelect={onSelect}
        />
      </div>
    </div>
  );
}

// ─── Sortable step card ────────────────────────────────────────────────────────

interface SortableStepCardProps {
  item: StepItem;
  containerId: string;
  containerMap: ContainerMap;
  depth: number;
  variants: VariantMeta[];
  root: unknown;
  onAdd: (containerId: string, variant: VariantMeta, afterId?: string) => void;
  onRemove: (itemId: string, containerId: string) => void;
  onSelect: (item: StepItem, containerId: string) => void;
}

function SortableStepCard({
  item,
  containerId,
  containerMap,
  depth,
  variants,
  root,
  onAdd,
  onRemove,
  onSelect,
}: SortableStepCardProps) {
  const { variant } = item;
  const symbol = variant ? getVariantSymbol(variant) : null;
  const isControlFlow = symbol !== null && variant?.invokeField === null;

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });

  const dragHandleProps = { ref: setActivatorNodeRef, ...attributes, ...listeners };

  const branchProps = { containerMap, depth: depth + 1, variants, root, onAdd, onRemove, onSelect };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={{
            transform: CSS.Transform.toString(transform),
            transition,
            opacity: isDragging ? 0.3 : undefined,
          }}
          className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
        >
          <div
            className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(item, containerId);
            }}
          >
            <StepCardContent item={item} onRemove={() => onRemove(item.id, containerId)} dragHandleProps={dragHandleProps} />
          </div>

          {isControlFlow && variant && (
            <div className="border-t border-zinc-100 px-3 pb-3 pt-1 dark:border-zinc-800">
              {variant.branchFields.map((f) => (
                <BranchSection
                  key={f}
                  label={f}
                  containerId={`${item.id}.${f}`}
                  {...branchProps}
                />
              ))}
              {variant.caseMaps.map((f) => {
                const prefix = `${item.id}.${f}.`;
                const keys = Object.keys(containerMap)
                  .filter((k) => k.startsWith(prefix))
                  .map((k) => k.slice(prefix.length));
                return keys.map((key) => (
                  <BranchSection
                    key={`${f}.${key}`}
                    label={`case: ${key}`}
                    containerId={`${item.id}.${f}.${key}`}
                    {...branchProps}
                  />
                ));
              })}
              {variant.branchLists.map((f) => {
                const predicates = Array.isArray(item.stepData[f])
                  ? (item.stepData[f] as unknown[])
                  : [];
                const predField = (() => {
                  const vProps = isRecord(variant.schema.properties) ? variant.schema.properties : {};
                  const listProp: Record<string, unknown> = isRecord(vProps[f]) ? vProps[f] : {};
                  const itemsSchema = resolveRef(isRecord(listProp) ? listProp.items : undefined, root);
                  if (!isRecord(itemsSchema) || !isRecord(itemsSchema.properties)) return "if";
                  for (const [k, p] of Object.entries(itemsSchema.properties as Record<string, unknown>)) {
                    if (getTopologyRole(p) === "predicate") return k;
                  }
                  return "if";
                })();
                return predicates.map((pred, i) => {
                  const expr = isRecord(pred) && typeof pred[predField] === "string"
                    ? (pred[predField] as string)
                    : "";
                  return (
                    <BranchSection
                      key={`${f}.${i}`}
                      label={`${f}: ${expr || "…"}`}
                      containerId={`${item.id}.${f}.${i}`}
                      {...branchProps}
                    />
                  );
                });
              })}
            </div>
          )}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Add step after</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {variants.map((v, i) => (
              <ContextMenuItem key={i} onClick={() => onAdd(containerId, v, item.id)}>
                {formatVariantMenuLabel(v, i)}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => onRemove(item.id, containerId)}>
          Remove step
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ─── Step list ────────────────────────────────────────────────────────────────

interface StepListProps {
  containerId: string;
  items: StepItem[];
  containerMap: ContainerMap;
  depth: number;
  variants: VariantMeta[];
  root: unknown;
  onAdd: (containerId: string, variant: VariantMeta, afterId?: string) => void;
  onRemove: (itemId: string, containerId: string) => void;
  onSelect: (item: StepItem, containerId: string) => void;
}

function StepList({
  containerId,
  items,
  containerMap,
  depth,
  variants,
  root,
  onAdd,
  onRemove,
  onSelect,
}: StepListProps) {
  const { setNodeRef, isOver } = useDroppable({ id: containerId });
  return (
    <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
      <div
        ref={setNodeRef}
        className={`flex min-h-10 flex-col gap-2 rounded-lg p-1 transition-colors ${
          isOver && items.length === 0
            ? "bg-violet-50 ring-1 ring-inset ring-violet-300 dark:bg-violet-950/20 dark:ring-violet-700"
            : ""
        }`}
      >
        {items.map((item) => (
          <SortableStepCard
            key={item.id}
            item={item}
            containerId={containerId}
            containerMap={containerMap}
            depth={depth}
            variants={variants}
            root={root}
            onAdd={onAdd}
            onRemove={onRemove}
            onSelect={onSelect}
          />
        ))}
      </div>
    </SortableContext>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export function SequenceTopologyCanvas({
  resource,
  schema,
  onUpdateResource,
  onSelect,
  onBackgroundClick,
}: SequenceTopologyCanvasProps) {
  const steps = Array.isArray(resource.fields.steps) ? resource.fields.steps : [];
  const diagState = useDiagnosticsState();
  const filePaths = useActiveFilePaths();
  const sequenceSummary = summarizeResource(diagState, filePaths, resource.name);

  const stepSchema = useMemo(() => getStepSchema(schema), [schema]);
  const variants = useMemo(
    () => (stepSchema ? getVariants(stepSchema, schema) : []),
    [stepSchema, schema],
  );

  const isInternalUpdate = useRef(false);
  const [containerMap, setContainerMap] = useState(() =>
    stepsToContainerMap(steps, variants, schema),
  );
  const [activeItem, setActiveItem] = useState<StepItem | null>(null);

  const stepsJson = JSON.stringify(steps);
  useEffect(() => {
    if (isInternalUpdate.current) {
      isInternalUpdate.current = false;
      return;
    }
    setContainerMap(stepsToContainerMap(steps, variants, schema));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepsJson]);

  function commit(map: ContainerMap) {
    isInternalUpdate.current = true;
    onUpdateResource(resource.kind, resource.name, {
      ...resource.fields,
      steps: containerMapToSteps(map, variants, schema),
    });
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  function handleDragStart({ active }: DragStartEvent) {
    const cid = findContainer(active.id as string, containerMap);
    if (!cid) return;
    setActiveItem(containerMap[cid]?.find((i) => i.id === active.id) ?? null);
  }

  function handleDragOver({ active, over }: DragOverEvent) {
    if (!over) return;
    const activeId = active.id as string;
    const overId = over.id as string;
    const srcCid = findContainer(activeId, containerMap);
    const dstCid = findContainer(overId, containerMap);
    if (!srcCid || !dstCid || srcCid === dstCid) return;

    setContainerMap((prev) => {
      const srcItems = prev[srcCid] ?? [];
      const dstItems = prev[dstCid] ?? [];
      const dragged = srcItems.find((i) => i.id === activeId)!;
      const overIdx = dstItems.findIndex((i) => i.id === overId);
      const insertAt = overIdx >= 0 ? overIdx : dstItems.length;
      return {
        ...prev,
        [srcCid]: srcItems.filter((i) => i.id !== activeId),
        [dstCid]: [...dstItems.slice(0, insertAt), dragged, ...dstItems.slice(insertAt)],
      };
    });
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveItem(null);
    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    let mapToCommit: ContainerMap | null = null;

    setContainerMap((prev) => {
      const srcCid = findContainer(activeId, prev);
      const dstCid = findContainer(overId, prev);
      if (!srcCid || !dstCid || srcCid !== dstCid || activeId === overId) {
        mapToCommit = prev;
        return prev;
      }
      const items = prev[srcCid] ?? [];
      const oldIdx = items.findIndex((i) => i.id === activeId);
      const newIdx = items.findIndex((i) => i.id === overId);
      if (oldIdx < 0 || newIdx < 0 || oldIdx === newIdx) {
        mapToCommit = prev;
        return prev;
      }
      const next = { ...prev, [srcCid]: arrayMove(items, oldIdx, newIdx) };
      mapToCommit = next;
      return next;
    });

    if (mapToCommit) commit(mapToCommit);
  }

  function handleAdd(containerId: string, variant: VariantMeta, afterId?: string) {
    const totalItems = Object.values(containerMap).reduce((n, arr) => n + arr.length, 0);
    const name = `Step${totalItems + 1}`;
    const newId = uid();
    const newStep = buildNewStep(variant, name);
    const newItem: StepItem = { id: newId, stepData: newStep, variant };
    const containerItems = containerMap[containerId] ?? [];
    const insertAt =
      afterId !== undefined
        ? containerItems.findIndex((i) => i.id === afterId) + 1
        : containerItems.length;
    const next: ContainerMap = {
      ...containerMap,
      ...initBranchContainers(newId, variant),
      [containerId]: [
        ...containerItems.slice(0, insertAt),
        newItem,
        ...containerItems.slice(insertAt),
      ],
    };
    setContainerMap(next);
    commit(next);
  }

  function handleRemove(itemId: string, containerId: string) {
    const next: ContainerMap = { ...containerMap };
    next[containerId] = (next[containerId] ?? []).filter((i) => i.id !== itemId);
    for (const key of Object.keys(next)) {
      if (key.startsWith(`${itemId}.`)) delete next[key];
    }
    setContainerMap(next);
    commit(next);
  }

  function handleSelect(item: StepItem) {
    const pointer = resolvePointer(item.id, containerMap, schema);
    if (!pointer) return;

    const editableSchema =
      item.variant && stepSchema
        ? buildEditableSchema(stepSchema, item.variant, schema)
        : { type: "object", properties: {} };

    onSelect({
      resource: { kind: resource.kind, name: resource.name },
      pointer,
      schema: editableSchema,
    });
  }

  const rootItems = containerMap["root"] ?? [];
  const listProps = {
    containerMap,
    depth: 0,
    variants,
    root: schema,
    onAdd: handleAdd,
    onRemove: handleRemove,
    onSelect: handleSelect,
  };

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-900">
      <div className="border-b border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600 dark:text-violet-300">
              Sequence Topology
            </p>
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                {resource.name}
              </h2>
              <DiagnosticBadge summary={sequenceSummary} size="md" stopPropagation={false} />
            </div>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{resource.kind}</p>
          </div>
          <div className="rounded-full bg-violet-100 px-3 py-1 text-xs font-medium text-violet-800 dark:bg-violet-900/50 dark:text-violet-200">
            {steps.length} step{steps.length === 1 ? "" : "s"}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="border-violet-300 bg-violet-50 text-violet-800 hover:bg-violet-100 dark:border-violet-700 dark:bg-violet-950/50 dark:text-violet-200 dark:hover:bg-violet-900/60"
              >
                + Add step
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {variants.map((v, i) => (
                <DropdownMenuItem key={i} onClick={() => handleAdd("root", v)}>
                  {formatVariantMenuLabel(v, i)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-5" onClick={onBackgroundClick}>
        {rootItems.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400">
            No steps defined yet.
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
          >
            <StepList containerId="root" items={rootItems} {...listProps} />
            <DragOverlay dropAnimation={null}>
              {activeItem && (
                <div className="overflow-hidden rounded-xl border border-zinc-300 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-950">
                  <StepCardContent item={activeItem} overlay />
                </div>
              )}
            </DragOverlay>
          </DndContext>
        )}
      </div>
    </div>
  );
}
