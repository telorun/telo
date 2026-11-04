/**
 * `x-telo-path-params-for: { template, through? }` — the annotation's single
 * reader, for `telo check` and for the kernel at creation and at definition
 * registration alike (the `browser-export-slot.ts` precedent).
 *
 * ```yaml
 * address:
 *   type: object
 *   properties:
 *     path:
 *       anyOf:
 *         - { type: string }
 *         - x-telo-ref: { kind: Self.Page, use: schema }
 *     pathParams:
 *       type: object
 *       additionalProperties: {}
 *       x-telo-path-params-for: { template: /path, through: path }
 * ```
 *
 * Written on a map whose keys name the variables of a path template. `template`
 * is a JSON Pointer, relative to the object holding the annotated field, to the
 * field holding the template; `through` names the field of the declaration a
 * reference there names that holds it (a JSON Pointer, or a bare field name).
 * A template is an app-relative path or an `http://`, `https://` or `mailto:`
 * address whose `{name}` variables are whole path segments — after the
 * authority for an absolute URL. An expression at the template field is a whole
 * address read from data and never expanded, so every entry of the map is
 * unused. An omitted map binds nothing: it is read as empty, so every
 * variable of a template is unbound.
 *
 * `PATH_TEMPLATE_INVALID`, `PATH_PARAMETER_UNBOUND` and `PATH_PARAMETER_UNUSED`
 * at a resource; `PATH_PARAMS_FOR_INVALID` at the kind writing a malformed or
 * misplaced annotation. The kernel raises each `ERR_`-prefixed from this file.
 * It names no kind.
 *
 * Browser-safe: no Node built-ins.
 */
import { isCompiledValue, parseCanonicalTypeSchemaId } from "@telorun/sdk";
import { isRefSentinel, isTaggedSentinel } from "@telorun/templating";
import { enclosingKeys, placeAt, type ReadPlace, type ReadReporter } from "./read-place.js";
import { resolveRefIn, type ExternalSchemaResolver } from "./schema-compat.js";
import { pointerSegments, renderValuePath, type ValuePath } from "./text-slot.js";

export const PATH_PARAMS_FOR_ANNOTATION = "x-telo-path-params-for";

const ANNOTATION_KEYS = ["template", "through"] as const;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ABSOLUTE_URL = /^(https?):\/\/([^/?#]*)(.*)$/i;
const MAILTO = /^mailto:(.*)$/i;

type Schema = Record<string, any>;

const isSchema = (node: unknown): node is Schema => !!node && typeof node === "object" && !Array.isArray(node);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** What a template reads: its variables in order, or why it is no template. */
export type PathTemplateReading =
  | { readonly variables: readonly string[] }
  | { readonly invalid: string };

/**
 * A path template's variables, or the reason it is not one. A variable is a
 * whole path segment `{<name>}`, `<name>` a Telo name, each named once; an
 * absolute URL's authority, its query and its fragment hold none.
 */
export function readPathTemplate(template: string): PathTemplateReading {
  let rest = template;
  const absolute = ABSOLUTE_URL.exec(template);
  if (absolute) {
    if (/[{}]/.test(absolute[2]!)) {
      return { invalid: `its authority '${absolute[2]}' holds a variable — only the path segments after the authority are variables` };
    }
    rest = absolute[3]!;
  } else {
    const mailto = MAILTO.exec(template);
    if (mailto) rest = mailto[1]!;
  }
  const tailAt = rest.search(/[?#]/);
  const path = tailAt === -1 ? rest : rest.slice(0, tailAt);
  const tail = tailAt === -1 ? "" : rest.slice(tailAt);
  if (/[{}]/.test(tail)) {
    return { invalid: `its query or fragment '${tail}' holds '{' or '}' — a variable is a whole path segment` };
  }
  const variables: string[] = [];
  for (const segment of path.split("/")) {
    if (!/[{}]/.test(segment)) continue;
    const whole = /^\{([^{}]*)\}$/.exec(segment);
    if (!whole) {
      return { invalid: `segment '${segment}' holds a variable beside other text — a variable is a whole segment, '/{<name>}/'` };
    }
    const name = whole[1]!;
    if (!VARIABLE_NAME.test(name)) {
      return { invalid: `'{${name}}' names no variable — a name matches /^[A-Za-z_][A-Za-z0-9_]*$/` };
    }
    if (variables.includes(name)) {
      return { invalid: `'{${name}}' appears twice — each variable names one segment` };
    }
    variables.push(name);
  }
  return { variables };
}

/** The annotation as the sites read it. Lenient: a part the strict half
 *  refuses is read as absent, so nothing beyond its own refusal follows. */
interface Annotation {
  readonly template: readonly string[];
  readonly through?: readonly string[];
}

function throughSegments(value: unknown): string[] | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return value.startsWith("/") ? pointerSegments(value) : [value];
}

function readAnnotation(raw: unknown): Annotation | undefined {
  if (!isPlainObject(raw)) return undefined;
  const template = pointerSegments(raw.template);
  if (!template || template.length === 0 || template.some((segment) => segment === "")) return undefined;
  const through = raw.through === undefined ? undefined : throughSegments(raw.through);
  if (raw.through !== undefined && !through) return undefined;
  return { template, ...(through ? { through } : {}) };
}

/** A value written in its place, read as nothing more than data: an expression
 *  of any tag, compiled or not. */
function isExpression(value: unknown): boolean {
  return isCompiledValue(value) || (isTaggedSentinel(value) && !isRefSentinel(value));
}

/** One annotated map of a resource, with the template field beside it. */
export interface PathParamsSite {
  /** Where the map is, the object holding it and the template field. */
  readonly path: ValuePath;
  readonly holderPath: ValuePath;
  readonly templatePath: ValuePath;
  readonly params: unknown;
  readonly template: unknown;
  readonly through?: readonly string[];
}

/**
 * Every annotated map `data` holds, found by walking `schema` and the value in
 * tandem: through `properties`, `patternProperties`, `additionalProperties`,
 * `items`, every `oneOf` / `anyOf` / `allOf` branch, a document-local `$ref` and
 * a named shape (`external`).
 */
export function pathParamsSites(
  schema: Schema,
  data: unknown,
  external?: ExternalSchemaResolver,
): PathParamsSite[] {
  if (!declaresPathParams(schema, external)) return [];
  const out = new Map<string, PathParamsSite>();
  const seen = new Map<Schema, Set<string>>();
  const walk = (
    node: unknown,
    root: Schema,
    value: unknown,
    path: ValuePath,
    holder: { value: Record<string, unknown>; path: ValuePath } | undefined,
  ): void => {
    if (!isSchema(node) || value === undefined) return;
    const key = renderValuePath(path);
    const entered = seen.get(node) ?? new Set<string>();
    if (entered.has(key)) return;
    entered.add(key);
    seen.set(node, entered);

    const annotation = readAnnotation(node[PATH_PARAMS_FOR_ANNOTATION]);
    if (annotation && holder && !out.has(key)) {
      let template: unknown = holder.value;
      for (const segment of annotation.template) template = isPlainObject(template) ? template[segment] : undefined;
      out.set(key, {
        path,
        holderPath: holder.path,
        templatePath: [...holder.path, ...annotation.template],
        params: value,
        template,
        ...(annotation.through ? { through: annotation.through } : {}),
      });
    }

    if (typeof node.$ref === "string") {
      const target = resolveRefIn(node, root, external);
      if (target.schema !== node) walk(target.schema, target.root, value, path, holder);
    }
    for (const union of ["oneOf", "anyOf", "allOf"] as const) {
      if (Array.isArray(node[union])) for (const branch of node[union]) walk(branch, root, value, path, holder);
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const items = Array.isArray(node.items) ? node.items[index] : node.items;
        walk(items, root, item, [...path, index], undefined);
      });
      return;
    }
    if (!isPlainObject(value)) return;
    const properties = isSchema(node.properties) ? node.properties : {};
    const here = { value, path };
    // An omitted map binds nothing: read it as empty so every variable is unbound.
    for (const [name, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, name) || !declaresPathParams(child as Schema, external)) continue;
      walk(child, root, {}, [...path, name], here);
    }
    for (const [name, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) {
        walk(properties[name], root, child, [...path, name], here);
        continue;
      }
      const pattern = Object.entries(isSchema(node.patternProperties) ? node.patternProperties : {}).find(([source]) =>
        new RegExp(source, "u").test(name),
      );
      if (pattern) walk(pattern[1], root, child, [...path, name], undefined);
      else if (isSchema(node.additionalProperties)) walk(node.additionalProperties, root, child, [...path, name], undefined);
    }
  };
  walk(schema, schema, data, [], undefined);
  return [...out.values()];
}

const declaring = new WeakMap<object, boolean>();

/**
 * True when `schema` writes the annotation anywhere it reaches — asked before a
 * resource is walked, since almost no kind does. A node reaching no named shape
 * is memoized; a named shape is resolved each time and memoized as a node.
 */
function declaresPathParams(schema: Schema, external: ExternalSchemaResolver | undefined): boolean {
  const open = new Set<object>();
  const scan = (node: unknown): { found: boolean; named: boolean } => {
    if (!node || typeof node !== "object") return { found: false, named: false };
    const known = declaring.get(node);
    if (known !== undefined) return { found: known, named: false };
    if (open.has(node)) return { found: false, named: false };
    open.add(node);
    let found = false;
    let named = false;
    if (Array.isArray(node)) {
      for (const item of node) {
        const child = scan(item);
        found ||= child.found;
        named ||= child.named;
      }
    } else {
      const record = node as Schema;
      if (PATH_PARAMS_FOR_ANNOTATION in record) found = true;
      if (typeof record.$ref === "string" && !record.$ref.startsWith("#")) {
        named = true;
        const target = external?.(record.$ref);
        if (target && scan(target).found) found = true;
      }
      for (const [key, child] of Object.entries(record)) {
        if (key === PATH_PARAMS_FOR_ANNOTATION) continue;
        const inner = scan(child);
        found ||= inner.found;
        named ||= inner.named;
      }
    }
    open.delete(node);
    if (found || !named) declaring.set(node, found);
    return { found, named };
  };
  return scan(schema).found;
}

/** A value the annotation refuses, in the wording both halves share. */
export interface PathParamsProblem {
  readonly code: "PATH_TEMPLATE_INVALID" | "PATH_PARAMETER_UNBOUND" | "PATH_PARAMETER_UNUSED";
  /** Where it is reported: the template field, or the map's entry. */
  readonly path: string;
  /** The object holding both, where the check is judged. */
  readonly judgedAt: string;
  readonly message: string;
}

/** What the reader needs of its host beyond the schema. */
export interface PathParamsHost {
  /** Named shapes, by id. */
  readonly external?: ExternalSchemaResolver;
  /** The declaration the value at a template field names — a reference, or an
   *  instance a reference was injected as — read in the scope of the declaration
   *  `holder` holding it; undefined when it names none the host can read. */
  declarationOf(value: unknown, holder: Record<string, any>): Record<string, any> | undefined;
}

const quoted = (names: readonly string[]) => names.map((name) => `'${name}'`).join(", ");

/** What a template field's value is read as, at one site. */
type TemplateSource =
  | { readonly kind: "template"; readonly text: string; readonly described: string }
  | { readonly kind: "expression" }
  | undefined;

function templateSource(site: PathParamsSite, resource: Record<string, any>, host: PathParamsHost): TemplateSource {
  const field = renderValuePath(site.templatePath);
  if (typeof site.template === "string") {
    return { kind: "template", text: site.template, described: `'${field}: ${site.template}'` };
  }
  if (isExpression(site.template)) return { kind: "expression" };
  if (!site.through || site.template === undefined || site.template === null) return undefined;
  const declaration = host.declarationOf(site.template, resource);
  if (!declaration) return undefined;
  let text: unknown = declaration;
  for (const segment of site.through) text = isPlainObject(text) ? text[segment] : undefined;
  if (typeof text !== "string") return undefined;
  const name = `'${String((declaration.metadata as { name?: unknown } | undefined)?.name)}'`;
  return {
    kind: "template",
    text,
    described: `the template '${site.through.join(".")}: ${text}' of ${name} (named at '${field}')`,
  };
}

/**
 * What is wrong with each annotated map `resource` holds: a template that is no
 * template, a variable no entry binds, an entry naming no variable — every
 * entry, when the template field holds an expression. An omitted map is empty;
 * a template field holding nothing decided is left alone.
 */
export function pathParamsProblems(
  schema: Schema,
  resource: Record<string, any>,
  host: PathParamsHost,
): PathParamsProblem[] {
  const out: PathParamsProblem[] = [];
  for (const site of pathParamsSites(schema, resource, host.external)) {
    const params = site.params;
    if (!isPlainObject(params)) continue;
    const source = templateSource(site, resource, host);
    if (!source) continue;
    const judgedAt = renderValuePath(site.holderPath);
    const field = renderValuePath(site.templatePath);
    const map = renderValuePath(site.path);
    const entries = Object.keys(params);
    if (source.kind === "expression") {
      for (const name of entries) {
        out.push({
          code: "PATH_PARAMETER_UNUSED",
          path: renderValuePath([...site.path, name]),
          judgedAt,
          message:
            `'${map}.${name}' is never read: '${field}' is an expression, read as a whole address and ` +
            `never expanded. Remove '${map}', or write '${field}' as a template.`,
        });
      }
      continue;
    }
    const reading = readPathTemplate(source.text);
    if ("invalid" in reading) {
      out.push({
        code: "PATH_TEMPLATE_INVALID",
        path: field,
        judgedAt,
        message: `${source.described} is not a path template: ${reading.invalid}.`,
      });
      continue;
    }
    for (const variable of reading.variables) {
      if (entries.includes(variable)) continue;
      out.push({
        code: "PATH_PARAMETER_UNBOUND",
        path: field,
        judgedAt,
        message: `${source.described} reads '{${variable}}', which '${map}' does not bind. Add '${variable}' to '${map}'.`,
      });
    }
    for (const name of entries) {
      if (reading.variables.includes(name)) continue;
      out.push({
        code: "PATH_PARAMETER_UNUSED",
        path: renderValuePath([...site.path, name]),
        judgedAt,
        message:
          `'${map}.${name}' names no variable of ${source.described}` +
          (reading.variables.length > 0 ? ` — it reads ${quoted(reading.variables)}` : `, which reads none`) +
          `. Remove the entry, or name the variable it fills.`,
      });
    }
  }
  return out;
}

/** A malformed or misplaced annotation, where the kind document writes it. */
export interface PathParamsAnnotationProblem {
  /** `schema.properties.pathParams.x-telo-path-params-for`. */
  readonly path: string;
  readonly message: string;
}

/** The schema nodes a property schema is, through references and unions. */
function alternativesOf(node: unknown, root: Schema, external: ExternalSchemaResolver | undefined): Schema[] {
  const out: Schema[] = [];
  const seen = new Set<object>();
  const visit = (n: unknown, r: Schema) => {
    if (!isSchema(n) || seen.has(n)) return;
    seen.add(n);
    out.push(n);
    if (typeof n.$ref === "string") {
      const target = resolveRefIn(n, r, external);
      if (target.schema !== n) visit(target.schema, target.root);
    }
    for (const union of ["oneOf", "anyOf", "allOf"] as const) {
      if (Array.isArray(n[union])) for (const branch of n[union]) visit(branch, r);
    }
  };
  visit(node, root);
  return out;
}

/** The schema nodes `segments` reaches from the object `holder`, through its
 *  properties at each step. */
function fieldNodes(
  holder: Schema,
  root: Schema,
  segments: readonly string[],
  external: ExternalSchemaResolver | undefined,
): Schema[] {
  let current: Schema[] = [holder];
  for (const segment of segments) {
    const next: Schema[] = [];
    for (const node of current) {
      for (const alternative of alternativesOf(node, root, external)) {
        const child = isSchema(alternative.properties) ? alternative.properties[segment] : undefined;
        if (isSchema(child)) next.push(child);
      }
    }
    current = next;
  }
  return current.flatMap((node) => alternativesOf(node, root, external));
}

const declaresObject = (node: Schema) =>
  node.type === "object" || (Array.isArray(node.type) && node.type.includes("object"));

/**
 * Every annotation a kind's `schema` reaches — through properties, map values,
 * list items, unions, document-local references and named shapes — that is not
 * `{ template: <JSON Pointer>, through?: <field> }` on a named property holding
 * an object, whose `template` names a field the holding object declares, and
 * whose `through` is written exactly when that field may hold a reference.
 */
export function pathParamsAnnotationProblems(
  kind: string,
  schema: unknown,
  resolveRef?: ExternalSchemaResolver,
  at: ValuePath = ["schema"],
): PathParamsAnnotationProblem[] {
  if (!isSchema(schema)) return [];
  const problems: PathParamsAnnotationProblem[] = [];
  const visited = new Set<object>();
  const shapeName = (ref: string) => parseCanonicalTypeSchemaId(ref)?.typeName ?? ref;
  const report = (path: ValuePath, shape: string | undefined, inner: ValuePath, reason: string) => {
    const where = renderValuePath(shape ? path : [...path, PATH_PARAMS_FOR_ANNOTATION]);
    const place = shape
      ? `'${where}', which reaches '${renderValuePath([...inner, PATH_PARAMS_FOR_ANNOTATION])}' in the named shape '${shape}' it names,`
      : `'${where}'`;
    problems.push({ path: where, message: `'${kind}' declares ${place} ${reason}` });
  };
  const shape = `The annotation is { template: <JSON Pointer to the field holding the template>, through?: <field of the declaration a reference there names> }.`;
  const judge = (
    node: Schema,
    root: Schema,
    holder: { node: Schema; name: string } | undefined,
    path: ValuePath,
    shapeOf: string | undefined,
    inner: ValuePath,
  ) => {
    const raw = node[PATH_PARAMS_FOR_ANNOTATION];
    const refuse = (reason: string) => report(path, shapeOf, inner, reason);
    if (!isPlainObject(raw)) {
      refuse(`as something other than an object. ${shape}`);
      return;
    }
    const unknown = Object.keys(raw).filter((key) => !(ANNOTATION_KEYS as readonly string[]).includes(key));
    if (unknown.length > 0) {
      refuse(`with ${quoted(unknown)}, read by nothing. ${shape}`);
      return;
    }
    const template = pointerSegments(raw.template);
    if (!template || template.length === 0 || template.some((segment) => segment === "")) {
      refuse(`with a 'template' that is no JSON Pointer ('/path') to the field holding the template. ${shape}`);
      return;
    }
    if (raw.through !== undefined && !throughSegments(raw.through)) {
      refuse(`with a 'through' that is neither a field name nor a JSON Pointer. ${shape}`);
      return;
    }
    if (!holder) {
      refuse(`on a node that is no named property: it belongs on the map of path variables, a property beside the field holding the template.`);
      return;
    }
    if (!declaresObject(node)) {
      refuse(`on a property that holds no object: it belongs on the map whose keys name the template's variables, declared 'type: object'.`);
      return;
    }
    if (template[0] === holder.name) {
      refuse(`with a 'template' naming the annotated map itself; name the field holding the template.`);
      return;
    }
    const fields = fieldNodes(holder.node, root, template, resolveRef);
    if (fields.length === 0) {
      refuse(`with a 'template' naming '${template.join("/")}', which the object holding '${holder.name}' does not declare.`);
      return;
    }
    const referenceSlot = fields.some((field) => "x-telo-ref" in field);
    if (raw.through !== undefined && !referenceSlot) {
      refuse(`with a 'through', but '${template.join("/")}' holds no reference: 'through' is read by nothing. Remove it, or let the field hold a reference.`);
    } else if (raw.through === undefined && referenceSlot) {
      refuse(`with no 'through', but '${template.join("/")}' may hold a reference: name the field of the declaration it names that holds the template.`);
    }
  };
  const visit = (
    node: unknown,
    root: Schema,
    holder: { node: Schema; name: string } | undefined,
    path: ValuePath,
    shapeOf: string | undefined,
    inner: ValuePath,
  ): void => {
    if (!isSchema(node) || visited.has(node)) return;
    visited.add(node);
    const step = (key: ValuePath): [ValuePath, ValuePath] => (shapeOf ? [path, [...inner, ...key]] : [[...path, ...key], inner]);
    if (PATH_PARAMS_FOR_ANNOTATION in node) judge(node, root, holder, path, shapeOf, inner);
    if (isSchema(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) {
        const [p, i] = step(["properties", key]);
        visit(child, root, { node, name: key }, p, shapeOf, i);
      }
    }
    for (const mapKey of ["patternProperties", "$defs", "definitions"] as const) {
      if (!isSchema(node[mapKey])) continue;
      for (const [key, child] of Object.entries(node[mapKey])) {
        const [p, i] = step([mapKey, key]);
        visit(child, root, undefined, p, shapeOf, i);
      }
    }
    for (const single of ["additionalProperties", "items", "then", "else"] as const) {
      if (isSchema(node[single])) {
        const [p, i] = step([single]);
        visit(node[single], root, undefined, p, shapeOf, i);
      }
    }
    for (const union of ["oneOf", "anyOf", "allOf"] as const) {
      if (Array.isArray(node[union])) {
        node[union].forEach((branch: unknown, index: number) => {
          const [p, i] = step([union, index]);
          visit(branch, root, holder, p, shapeOf, i);
        });
      }
    }
    if (typeof node.$ref === "string") {
      if (node.$ref.startsWith("#")) {
        const target = resolveRefIn(node, root);
        if (target.schema !== node) {
          visit(target.schema, root, holder, path, shapeOf, inner);
        }
      } else {
        const named = resolveRef?.(node.$ref);
        if (named) visit(named, named, holder, path, shapeOf ?? shapeName(node.$ref), shapeOf ? inner : []);
      }
    }
  };
  visit(schema, schema, undefined, at, undefined, []);
  return problems;
}

/** What `x-telo-path-params-for` reads: the template field beside the map, and
 *  through a reference there the field of the declaration it names. */
export const pathParamsForReads: ReadReporter = ({ value, at }) => {
  const annotation = readAnnotation(value);
  if (!annotation) return [];
  const keys = placeAt(enclosingKeys(at), `/${annotation.template.map((s) => s.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`);
  const places: ReadPlace[] = [{ kind: "value", keys }];
  if (annotation.through) {
    const through = annotation.through;
    places.push({ kind: "reference", keys, transitive: false, reads: () => [{ kind: "value", keys: through }] });
  }
  return places;
};
