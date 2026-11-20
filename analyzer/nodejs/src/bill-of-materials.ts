/**
 * A module artifact's stored bill of materials — the record its `sbom` layer
 * holds (`kernel/specs/module-artifact.md` §7): a CycloneDX 1.6 document listing
 * the third-party components the artifact ships, each with the layers it occurs
 * in, as the producers that built the payload reported them.
 *
 * This module owns the record's shape, its canonical bytes and the property
 * grammar; the producers (bundle attribution, staging) live with the builders.
 * Browser-safe, so the hub and the editor read a record through it too.
 */

import { selectorKey, type ArtifactSelector, type LayerRole } from "./artifact-selector.js";
import { teloFormatFailure } from "./telo-format.js";

/** The one file of the `sbom` layer, at the layer's root. */
export const BILL_OF_MATERIALS_FILE = "sbom.cdx.json";

/** What `sbom.cdx.json` holds. */
export const BILL_OF_MATERIALS_MEDIA_TYPE = "application/vnd.cyclonedx+json; version=1.6";

/** One per layer a component occurs in. */
export const LAYER_PROPERTY = "telo:layer";

/** On a stored record's subject, one per layer holding code no producer reported. */
export const INCOMPLETE_PROPERTY = "telo:incomplete";

export class BillOfMaterialsError extends Error {
  readonly code = "INVALID_BILL_OF_MATERIALS";

  constructor(detail: string) {
    super(detail);
    this.name = "BillOfMaterialsError";
  }
}

/** The value of a `telo:layer` / `telo:incomplete` property for one layer:
 *  `role=<role>`, then `;` and the selector's canonical key when it has one. */
export function layerOccurrence(role: LayerRole | string, selector?: ArtifactSelector): string {
  return selector ? `role=${role};${selectorKey(selector)}` : `role=${role}`;
}

// ---------------------------------------------------------------------------
// Canonical bytes
// ---------------------------------------------------------------------------

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Code-unit order, which is what JavaScript's string comparison is. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** How the members of an array are ordered, by the name of the member holding it. */
function arraySortKey(member: string | undefined): ((item: JsonValue) => string[]) | undefined {
  const field = (name: string) => (item: JsonValue) => [
    typeof item === "object" && item !== null && !Array.isArray(item) && typeof item[name] === "string"
      ? (item[name] as string)
      : canonicalJsonText(item),
  ];
  switch (member) {
    case "components":
      return field("bom-ref");
    case "dependencies":
      return field("ref");
    case "properties":
      return (item) => [...field("name")(item), ...field("value")(item)];
    case "dependsOn":
    case "assemblies":
      return (item) => [typeof item === "string" ? item : canonicalJsonText(item)];
    default:
      return undefined;
  }
}

function compareKeys(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = compareCodeUnits(a[i]!, b[i]!);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

/** The document with every array ordered and every empty array member dropped. */
function normalize(value: unknown, member: string | undefined, at: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new BillOfMaterialsError(`${at}: ${value} is not a JSON number.`);
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.map((item, index) => normalize(item, undefined, `${at}[${index}]`));
    const key = arraySortKey(member) ?? ((item: JsonValue) => [canonicalJsonText(item)]);
    return items
      .map((item) => ({ item, key: key(item) }))
      .sort((a, b) => compareKeys(a.key, b.key))
      .map(({ item }) => item);
  }
  if (typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child === undefined) continue;
      if (Array.isArray(child) && child.length === 0) continue;
      out[key] = normalize(child, key, `${at}.${key}`);
    }
    return out;
  }
  throw new BillOfMaterialsError(`${at}: a ${typeof value} is not a JSON value.`);
}

function assertWellFormed(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      throw new BillOfMaterialsError(`a string holds a lone surrogate, which RFC 8785 refuses.`);
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new BillOfMaterialsError(`a string holds a lone surrogate, which RFC 8785 refuses.`);
    }
  }
}

/** RFC 8785 (JCS) over an already-normalized value: object keys in UTF-16
 *  code-unit order, ECMAScript number and string serialization, no whitespace. */
function canonicalJsonText(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertWellFormed(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonText).join(",")}]`;
  const keys = Object.keys(value).sort(compareCodeUnits);
  return `{${keys
    .map((key) => {
      assertWellFormed(key);
      return `${JSON.stringify(key)}:${canonicalJsonText(value[key]!)}`;
    })
    .join(",")}}`;
}

/**
 * The canonical bytes of a CycloneDX document Telo writes: every array ordered
 * (`components` by `bom-ref`, `properties` by `name` then `value`,
 * `dependencies` by `ref`, `dependsOn` and `assemblies` by value, any other by
 * each element's canonical serialization, all in UTF-16 code-unit order), every
 * empty array member omitted, then RFC 8785 and one line feed. The stored
 * record and every document composed from records are written this way, and
 * the composed document's serial number is derived from it.
 */
export function canonicalBillOfMaterialsText(document: unknown): string {
  return `${canonicalJsonText(normalize(document, undefined, "document"))}\n`;
}

// ---------------------------------------------------------------------------
// The stored record
// ---------------------------------------------------------------------------

export type LicenseChoice =
  | { license: { id: string } }
  | { license: { name: string } }
  | { expression: string };

export interface CycloneDxProperty {
  name: string;
  value: string;
}

export interface CycloneDxComponent {
  type: string;
  "bom-ref"?: string;
  name: string;
  version?: string;
  purl?: string;
  cpe?: string;
  licenses?: LicenseChoice[];
  properties?: CycloneDxProperty[];
}

export interface CycloneDxDependency {
  ref: string;
  dependsOn?: string[];
}

export interface BillOfMaterials {
  bomFormat: "CycloneDX";
  specVersion: "1.6";
  serialNumber?: string;
  version: 1;
  metadata: { component: CycloneDxComponent };
  components?: CycloneDxComponent[];
  dependencies?: CycloneDxDependency[];
  compositions?: Array<{ aggregate: string; assemblies?: string[] }>;
}

/** What the record is about: the module itself. `data` is a built-in vocabulary
 *  archive, which ships no code. */
export interface RecordSubject {
  readonly type: "library" | "application" | "data";
  readonly name: string;
  readonly version?: string;
  readonly license?: string;
}

/** The repository and commit a component is built from. */
export interface ComponentVcs {
  /** `git+https://<host>/<path>`, no revision (`vcs-url` format). */
  readonly url: string;
  /** The full commit id (`vcs-revision` format). */
  readonly revision: string;
}

/** The purl qualifier a component's repository and commit are written in, valued
 *  `<url>@<revision>` (the purl specification's `vcs_url`). */
export const VCS_URL_QUALIFIER = "vcs_url";

/** One producer's report of one component in one layer. */
export interface ComponentReport {
  /** The versionless package URL. */
  readonly purl: string;
  readonly version: string;
  /** Written into the component's purl as the `vcs_url` qualifier. */
  readonly vcs?: ComponentVcs;
  /** The layer it occurs in, as `layerOccurrence` renders it. */
  readonly occurrence: string;
  readonly license?: string;
  readonly cpe?: string;
}

/** A package and what is linked or bundled into it, both `componentRef`s. */
export interface ContainsEdge {
  readonly from: string;
  readonly to: string;
}

export interface RecordInput {
  readonly subject: RecordSubject;
  readonly components: readonly ComponentReport[];
  readonly contains: readonly ContainsEdge[];
  /** Occurrence values of the layers holding code no producer reported. */
  readonly incomplete: readonly string[];
}

/** Percent-encoding of one purl component: everything but the unreserved set. */
function encodePurlComponent(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `pkg:npm/<name>` for an npm package name, its scope's `@` encoded. */
export function npmPackageUrl(packageName: string): string {
  const slash = packageName.startsWith("@") ? packageName.indexOf("/") : -1;
  if (slash > 0) {
    return `pkg:npm/${encodePurlComponent(packageName.slice(0, slash))}/${encodePurlComponent(packageName.slice(slash + 1))}`;
  }
  return `pkg:npm/${encodePurlComponent(packageName)}`;
}

function splitPurl(purl: string): { head: string; tail: string } {
  const cut = purl.search(/[?#]/);
  return cut < 0 ? { head: purl, tail: "" } : { head: purl.slice(0, cut), tail: purl.slice(cut) };
}

/** A purl's head, its qualifiers in order as written, and its subpath (`#…` or ""). */
function purlParts(purl: string): { head: string; qualifiers: Array<[string, string]>; subpath: string } {
  const hash = purl.indexOf("#");
  const beforeHash = hash === -1 ? purl : purl.slice(0, hash);
  const subpath = hash === -1 ? "" : purl.slice(hash);
  const query = beforeHash.indexOf("?");
  const head = query === -1 ? beforeHash : beforeHash.slice(0, query);
  const qualifiers: Array<[string, string]> = [];
  if (query !== -1 && query < beforeHash.length - 1) {
    for (const pair of beforeHash.slice(query + 1).split("&")) {
      const eq = pair.indexOf("=");
      qualifiers.push(eq === -1 ? [pair, ""] : [pair.slice(0, eq), pair.slice(eq + 1)]);
    }
  }
  return { head, qualifiers, subpath };
}

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const hexOctet = (octet: number) => `%${octet.toString(16).toUpperCase().padStart(2, "0")}`;

/** Every octet outside `A–Z a–z 0–9 - . _ ~` percent-encoded (§7.5). */
function encodeQualifierOctets(octets: readonly number[]): string {
  return octets.map((octet) => (octet < 0x80 && UNRESERVED.test(String.fromCharCode(octet)) ? String.fromCharCode(octet) : hexOctet(octet))).join("");
}

/** The octets of a qualifier value as written: `%XX` is one octet, any other
 *  character its UTF-8 encoding. */
function qualifierOctets(written: string): number[] {
  const octets: number[] = [];
  for (let i = 0; i < written.length; i++) {
    if (written[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(written.slice(i + 1, i + 3))) {
      octets.push(parseInt(written.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    const point = written.codePointAt(i)!;
    if (point > 0xffff) i++;
    octets.push(...new TextEncoder().encode(String.fromCodePoint(point)));
  }
  return octets;
}

/** The qualifiers in canonical form (§7.5): keys lower-case and sorted, every
 *  value octet outside the unreserved set percent-encoded. */
function canonicalQualifiers(qualifiers: ReadonlyArray<readonly [string, string]>): string {
  if (qualifiers.length === 0) return "";
  return `?${[...qualifiers]
    .map(([key, value]) => [key.toLowerCase(), value] as const)
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&")}`;
}

/**
 * A component's reference: its package URL with its version, and, for a
 * component declared with `vcs`, the `vcs_url` qualifier valued
 * `<url>@<revision>`. Qualifiers are written in canonical form.
 */
export function componentRef(purl: string, version: string, vcs?: ComponentVcs): string {
  const { head, qualifiers, subpath } = purlParts(purl);
  const written: Array<[string, string]> = qualifiers
    .filter(([key]) => !(vcs && key.toLowerCase() === VCS_URL_QUALIFIER))
    .map(([key, value]) => [key, encodeQualifierOctets(qualifierOctets(value))]);
  if (vcs) {
    written.push([VCS_URL_QUALIFIER, encodeQualifierOctets([...new TextEncoder().encode(`${vcs.url}@${vcs.revision}`)])]);
  }
  return `${head}@${encodePurlComponent(version)}${canonicalQualifiers(written)}${subpath}`;
}

/**
 * A purl with its `vcs_url` qualifier taken out and read back as the repository
 * and commit, split at the value's only `@`. A purl whose `vcs_url` does not read
 * as a `vcs-url` and a `vcs-revision` is returned unchanged, with no `vcs`.
 */
export function splitVcsQualifier(purl: string): { purl: string; vcs?: ComponentVcs } {
  const { head, qualifiers, subpath } = purlParts(purl);
  const found = qualifiers.find(([key]) => key.toLowerCase() === VCS_URL_QUALIFIER);
  if (!found) return { purl };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(qualifierOctets(found[1])));
  } catch {
    return { purl };
  }
  const parts = text.split("@");
  if (parts.length !== 2) return { purl };
  const [url, revision] = parts as [string, string];
  if (teloFormatFailure("vcs-url", url) || teloFormatFailure("vcs-revision", revision)) return { purl };
  const rest = qualifiers.filter((pair) => pair !== found);
  const query = rest.length === 0 ? "" : `?${rest.map(([key, value]) => `${key}=${value}`).join("&")}`;
  return { purl: `${head}${query}${subpath}`, vcs: { url, revision } };
}

/** The name a component is listed under: its purl's namespace and name, decoded. */
function purlDisplayName(purl: string): string {
  const { head } = splitPurl(purl);
  const segments = head.slice(head.indexOf("/") + 1).split("/");
  return segments.map((segment) => decodeURIComponent(segment)).join("/");
}

const LICENSE_ID = /^[A-Za-z0-9.+-]+$/;
const LICENSE_EXPRESSION = /^[()A-Za-z0-9.+:\- ]+$/;

/** A license as CycloneDX writes it: a single identifier as `license.id`, a
 *  compound SPDX expression as `expression`, anything else as `license.name`. */
export function licenseChoice(text: string): LicenseChoice {
  const trimmed = text.trim();
  if (LICENSE_ID.test(trimmed) && trimmed.toUpperCase() !== "UNLICENSED") {
    return { license: { id: trimmed } };
  }
  if (LICENSE_EXPRESSION.test(trimmed) && /\s(AND|OR|WITH)\s/.test(trimmed)) {
    return { expression: trimmed };
  }
  return { license: { name: trimmed } };
}

/**
 * The stored record of one module, from its producers' reports: one component
 * per package and version with the union of its occurrences, the license any
 * report gave, and the edges from a package to what it contains. It holds no
 * fact that depends on where the artifact lives — no `bom-ref` on the subject,
 * no hashes, no module nodes, no serial number, no timestamp.
 */
export function buildModuleRecord(input: RecordInput): BillOfMaterials {
  const byRef = new Map<
    string,
    { purl: string; version: string; license?: string; cpe?: string; occurrences: Set<string> }
  >();
  for (const report of input.components) {
    const ref = componentRef(report.purl, report.version, report.vcs);
    let entry = byRef.get(ref);
    if (!entry) {
      entry = { purl: report.purl, version: report.version, occurrences: new Set() };
      byRef.set(ref, entry);
    }
    entry.occurrences.add(report.occurrence);
    entry.license ??= report.license;
    entry.cpe ??= report.cpe;
  }
  const components: CycloneDxComponent[] = [...byRef].map(([ref, entry]) => ({
    type: "library",
    "bom-ref": ref,
    name: purlDisplayName(entry.purl),
    version: entry.version,
    purl: ref,
    ...(entry.cpe ? { cpe: entry.cpe } : {}),
    ...(entry.license ? { licenses: [licenseChoice(entry.license)] } : {}),
    properties: [...entry.occurrences].map((value) => ({ name: LAYER_PROPERTY, value })),
  }));
  const edges = new Map<string, Set<string>>();
  for (const { from, to } of input.contains) {
    if (!byRef.has(from) || !byRef.has(to)) continue;
    const targets = edges.get(from) ?? new Set<string>();
    targets.add(to);
    edges.set(from, targets);
  }
  const subject = input.subject;
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: subject.type,
        name: subject.name,
        ...(subject.version !== undefined ? { version: subject.version } : {}),
        ...(subject.license ? { licenses: [licenseChoice(subject.license)] } : {}),
        properties: [...new Set(input.incomplete)].map((value) => ({ name: INCOMPLETE_PROPERTY, value })),
      },
    },
    components,
    dependencies: [...edges].map(([ref, targets]) => ({ ref, dependsOn: [...targets] })),
  };
}

/** The stored record's bytes. */
export function serializeModuleRecord(input: RecordInput): string {
  return canonicalBillOfMaterialsText(buildModuleRecord(input));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a stored record: a CycloneDX 1.6 document with a subject. Only the
 * members Telo reads are checked; a member it does not know is kept.
 */
export function readBillOfMaterials(text: string, describe = BILL_OF_MATERIALS_FILE): BillOfMaterials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new BillOfMaterialsError(
      `${describe} is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isObject(parsed) || parsed.bomFormat !== "CycloneDX" || parsed.specVersion !== "1.6") {
    throw new BillOfMaterialsError(`${describe} is not a CycloneDX 1.6 document.`);
  }
  if (!isObject(parsed.metadata) || !isObject(parsed.metadata.component)) {
    throw new BillOfMaterialsError(`${describe} names no subject (metadata.component).`);
  }
  for (const [field, value] of [
    ["components", parsed.components],
    ["dependencies", parsed.dependencies],
  ] as const) {
    if (value !== undefined && !Array.isArray(value)) {
      throw new BillOfMaterialsError(`${describe}: ${field} must be an array.`);
    }
  }
  return parsed as unknown as BillOfMaterials;
}

/** The `telo:incomplete` values of a record's subject: empty for a complete one. */
export function incompleteLayersOf(record: BillOfMaterials): string[] {
  return (record.metadata.component.properties ?? [])
    .filter((property) => property.name === INCOMPLETE_PROPERTY)
    .map((property) => property.value);
}
