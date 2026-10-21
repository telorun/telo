import {
  readWrittenValue,
  type OutlineCatchAnswer,
  type OutlineDocument,
  type OutlineEdge,
  type OutlineEntryPoint,
  type OutlineInput,
  type OutlineListAnswer,
  type OutlineResource,
  type OutlineRow,
  type OutlineScopeRung,
  type WrittenValue,
} from "@telorun/analyzer";
import type { Palette } from "./output.js";

/**
 * The outline as text, section by section as the document has them: the
 * module, its inputs, its boot targets, its entry points — each named by the
 * path that reaches it, with the `catches:` entry rendering every code it can
 * throw — and the resources it reaches, as a tree from the roots. A resource is
 * expanded where it is first reached and named by a back-reference wherever it
 * is reached again, so the text grows with the module rather than with the
 * number of paths through it.
 */
export function renderOutline(doc: OutlineDocument, palette: Palette): string[] {
  return new OutlineText(doc, palette).render();
}

const STEP = " › ";

class OutlineText {
  private readonly resources = new Map<string, OutlineResource>();
  private readonly entryPoints = new Map<string, OutlineEntryPoint>();
  private readonly expanded = new Set<string>();
  /** Where the tree first reaches each entry point, as the labels on the way. */
  private readonly reachedAt = new Map<string, string>();
  private tree: string[] = [];

  constructor(
    private readonly doc: OutlineDocument,
    private readonly palette: Palette,
  ) {
    for (const r of doc.resources) this.resources.set(r.id, r);
    for (const e of doc.entryPoints) this.entryPoints.set(e.id, e);
  }

  render(): string[] {
    const { module } = this.doc;
    const lines: string[] = [];
    const section = (title: string, body: string[]) => {
      if (body.length > 0) lines.push("", title, ...body);
    };

    lines.push(`${module.name}  ${this.palette.dim(module.kind)}${module.version ? `  ${module.version}` : ""}`);
    for (const text of (module.description ?? "").trim().split("\n").filter(Boolean)) lines.push(`  ${text}`);

    // The tree first: it is where each entry point's path is learnt.
    for (const id of this.doc.roots) this.reference(1, "", id, id, [], "");

    section("Inputs", this.doc.inputs.flatMap((input) => this.input(input)));
    section(
      "Boot",
      this.doc.boot.map((target) => {
        const name = target.name ? `${target.name}: ` : "";
        const resource = target.target ? this.resources.get(target.target) : undefined;
        const what = resource ? this.title(resource) : (target.targetName ?? "?");
        const when = target.when !== undefined ? `  when ${valueText(target.when)}` : "";
        return `  ${target.index + 1}. ${name}${what}${when}`;
      }),
    );
    const booted = new Set(this.doc.boot.map((t) => t.target));
    section(
      this.doc.module.kind === "Telo.Library" ? "Exports" : "Started",
      this.doc.roots
        .filter((id) => !booted.has(id))
        .map((id) => `  ${this.resources.has(id) ? this.title(this.resources.get(id)!) : id}`),
    );
    section("Entry points", this.doc.entryPoints.flatMap((entryPoint) => this.entryPoint(entryPoint)));
    section("Resources", this.tree);
    section(
      "Unreached",
      this.doc.unreached.map((u) => `  ${u.name}  ${this.palette.dim(u.kind)}`),
    );
    return lines;
  }

  private line(depth: number, text: string): void {
    this.tree.push(`${"  ".repeat(depth)}${text}`);
  }

  private input(input: OutlineInput): string[] {
    const parts = [`${input.block}.${input.name}`];
    if (input.binding?.env) parts.push(`env ${input.binding.env}`);
    if (input.binding?.arg) parts.push(`arg ${input.binding.arg}`);
    if (input.type) parts.push(this.palette.dim(input.type));
    parts.push(input.required ? "required" : input.default !== undefined ? `default ${valueText(input.default, true)}` : "optional");
    const out = [`  ${parts.join("  ")}`];
    for (const [field, info] of Object.entries(input.fields ?? {})) {
      const marks = [info.required ? "required" : "optional", ...(info.sensitive ? ["sensitive"] : [])];
      out.push(`    ${field}${info.env ? `  ${info.env}` : ""}  ${this.palette.dim(marks.join(", "))}`);
    }
    for (const read of input.readBy) out.push(this.palette.dim(`    read by ${this.nameOf(read.resource)} at ${read.path}`));
    return out;
  }

  private entryPoint(entryPoint: OutlineEntryPoint): string[] {
    const at =
      this.reachedAt.get(entryPoint.id) ??
      `${this.nameOf(entryPoint.owner)}${STEP}${lastSegment(entryPoint.slot)}${entryPoint.match ? ` ${matchText(entryPoint.match)}` : ""}`;
    const out = [`  ${at} → ${entryPoint.handlerName}  ${this.palette.dim(`[${entryPoint.use.join(", ")}]`)}`];
    for (const answer of entryPoint.catches) {
      out.push(`    ${answer.code ?? "any other code"}  ${this.ladderText(answer)}`);
    }
    return out;
  }

  /** A line naming a resource, then its body the first time it is reached. */
  private reference(depth: number, label: string, id: string, fallback: string, path: string[], suffix: string): void {
    const resource = this.resources.get(id);
    if (!resource) {
      this.line(depth, `${label}${fallback}${suffix}${this.palette.dim("  (unresolved)")}`);
      return;
    }
    const again = this.expanded.has(resource.id);
    this.line(depth, `${label}${this.title(resource)}${suffix}${again ? this.palette.dim("  (see above)") : ""}`);
    if (again) return;
    this.expanded.add(resource.id);
    this.body(resource, depth + 1, [...path, resource.name]);
  }

  /** A resource by its name and kind — as written in this module, resolved for
   *  one another module declared, whose spelling means nothing here. */
  private title(resource: OutlineResource): string {
    const kind = resource.external ? (resource.canonicalKind ?? resource.kind) : resource.kind;
    const from = resource.external ? `  from ${resource.alias ?? resource.module}` : "";
    return `${resource.name}  ${this.palette.dim(kind)}${from}`;
  }

  private body(resource: OutlineResource, depth: number, path: string[]): void {
    if (resource.deprecated) this.line(depth, this.palette.dim(`deprecated: ${resource.deprecated.reason}`));
    if (resource.throws) {
      const codes = [...resource.throws.codes, ...(resource.throws.unbounded ? ["any other code"] : [])];
      this.line(depth, this.palette.dim(`throws ${codes.join(", ")}`));
    }
    for (const zone of resource.zones ?? []) {
      this.line(depth, this.palette.dim(`zone at ${zone.site}: ${Object.keys(zone.attributes).join(", ")}`));
    }
    const children = new Map<string, OutlineRow[]>();
    for (const row of resource.rows) pushTo(children, row.parent ?? "", row);
    for (const row of children.get("") ?? []) this.row(row, children, depth, path);
    for (const edge of resource.edges) this.edge(edge, depth, path);
  }

  private row(row: OutlineRow, children: Map<string, OutlineRow[]>, depth: number, path: string[]): void {
    const label =
      row.kind === "entry"
        ? `${row.path.replace(/\[\d+\]$/, "")}${row.match ? ` ${matchText(row.match)}` : ""}`
        : row.kind === "inline"
          ? `declares ${row.declares ?? "?"}`
          : (row.name ?? row.path);
    // What a step turns on says what it is; a step turning on nothing is named
    // by the keys of its grammar branch.
    const predicate =
      row.predicate !== undefined ? `  ${row.predicateField ?? ""} ${valueText(row.predicate)}`.trimEnd() : "";
    const variant =
      row.kind === "step" && row.variant && !predicate ? `  ${this.palette.dim(row.variant.split("+").join("/"))}` : "";
    this.line(depth, `${label}${variant}${predicate}`);
    const inner = row.kind === "entry" ? [...path, label] : path;
    for (const edge of row.edges) this.edge(edge, depth + 1, inner);
    const branches = new Map<string, OutlineRow[]>();
    for (const child of children.get(row.id) ?? []) pushTo(branches, child.branch ?? "", child);
    for (const [branch, rows] of branches) {
      if (branch) this.line(depth + 1, `${branch}:`);
      for (const child of rows) this.row(child, children, depth + (branch ? 2 : 1), inner);
    }
  }

  private edge(edge: OutlineEdge, depth: number, path: string[]): void {
    if (edge.class === "shape") return;
    const slot = edge.read
      ? `reads ${edge.read}`
      : edge.call
        ? `calls ${edge.call}`
        : lastSegment(edge.slot);
    const label = `${slot}${edge.match ? ` ${matchText(edge.match)}` : ""}`;
    if (this.entryPoints.has(edge.id) && !this.reachedAt.has(edge.id)) {
      this.reachedAt.set(edge.id, [...path, label].join(STEP));
    }
    const use = edge.use.length > 0 ? `  ${this.palette.dim(`[${edge.use.join(", ")}]`)}` : "";
    const inputs = edge.inputs !== undefined ? this.palette.dim(`inputs ${valueText(edge.inputs)}`) : undefined;
    if (!edge.target || !this.resources.has(edge.target)) {
      this.line(depth, `${label} → ${edge.targetName}${use}`);
      if (inputs) this.line(depth + 1, inputs);
      return;
    }
    const resource = this.resources.get(edge.target)!;
    const again = this.expanded.has(resource.id);
    this.line(depth, `${label} → ${this.title(resource)}${use}${again ? this.palette.dim("  (see above)") : ""}`);
    if (inputs) this.line(depth + 1, inputs);
    if (again) return;
    this.expanded.add(resource.id);
    this.body(resource, depth + 1, [...path, label, resource.name]);
  }

  private ladderText(answer: OutlineCatchAnswer): string {
    if (answer.own?.entry !== undefined) return listText(answer.own);
    const parts: string[] = [];
    if (answer.own) parts.push(`${listText(answer.own)} none`);
    parts.push(this.rungText(answer.scope));
    return `${answer.covered ? "" : "not covered: "}${parts.join("; ")}`;
  }

  /** One rung of the ladder: the resource's own scope list, then — when it
   *  renders nothing — every scope enclosing it. */
  private rungText(rung: OutlineScopeRung): string {
    const name = this.nameOf(rung.resource);
    if (rung.list?.entry !== undefined) return `${name} ${listText(rung.list)}`;
    const own = rung.list ? `${name} ${listText(rung.list)} none` : `${name} none`;
    if (rung.enclosers.length === 0) return own;
    return `${own}; ${rung.enclosers.map((e) => `via ${this.rungText(e)}`).join(" | ")}`;
  }

  private nameOf(id: string): string {
    return this.resources.get(id)?.name ?? (id.split("\0").pop() || id);
  }
}

/** `steps[].invoke` → `invoke`; `mounts[].router` → `router`. */
function lastSegment(slot: string): string {
  return slot.replace(/\[\]/g, "").split(".").pop() ?? slot;
}

function listText(answer: OutlineListAnswer): string {
  const at = answer.entry !== undefined ? `${answer.list}[${answer.entry}]` : answer.list;
  const undecided =
    answer.undecided.length > 0 ? ` (after ${answer.undecided.map((i) => `[${i}]`).join(", ")}, decided at run time)` : "";
  return `${at}${undecided}`;
}

function pushTo<T>(groups: Map<string, T[]>, key: string, item: T): void {
  const group = groups.get(key);
  if (group) group.push(item);
  else groups.set(key, [item]);
}

function matchText(match: Record<string, WrittenValue>): string {
  return Object.entries(match)
    .map(([key, value]) => `${key}=${valueText(value)}`)
    .join(" ");
}

/** A value as written: an expression or a reference by its tag, a mapping as
 *  `{k: v}`. A string is bare unless `quoted`; one inside a list or a mapping is
 *  always quoted, so `'!cel "x"'` or `'{a: b}'` cannot read as what it spells. */
function valueText(value: WrittenValue, quoted = false): string {
  const reading = readWrittenValue(value);
  switch (reading.form) {
    case "scalar":
      return typeof reading.value === "string" && !quoted ? reading.value : JSON.stringify(reading.value);
    case "list":
      return `[${reading.items.map((item) => valueText(item, true)).join(", ")}]`;
    case "tagged": {
      const source = reading.tag === "ref" ? reading.source : JSON.stringify(reading.source);
      return `!${reading.tag} ${source}${reading.type !== undefined ? ` : ${reading.type}` : ""}`;
    }
    case "map":
      return `{${reading.entries.map(([key, entry]) => `${key}: ${valueText(entry, true)}`).join(", ")}}`;
  }
}
