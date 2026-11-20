/**
 * The CycloneDX document a reader composes from stored records
 * (`kernel/specs/module-artifact.md` §7.7): the identities a record cannot hold
 * about itself added, every array in canonical order, and a serial number
 * derived from the bytes it numbers.
 */

import {
  canonicalBillOfMaterialsText,
  licenseChoice,
  type BillOfMaterials,
  type CycloneDxComponent,
  type CycloneDxDependency,
  type RecordSubject,
} from "@telorun/analyzer";
import { createHash } from "node:crypto";
import type { ApplicationClosure, ClosureModule } from "./module-closure.js";
import { scopedRecord, type OccurrenceScope } from "./platform-scope.js";

/** The name-based UUID namespace of every Telo bill of materials: the version-5
 *  UUID of `https://telo.run/sbom` in the URL namespace. */
export const SERIAL_NUMBER_NAMESPACE = "6e26d710-2125-542e-9bcb-b7aee122a299";

/** RFC 9562 version 5: SHA-1 over the namespace's bytes and the name. */
export function nameBasedUuid(namespace: string, name: Uint8Array): string {
  const space = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(space).update(name).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The document's canonical bytes with its `serialNumber`: a v5 UUID over the
 *  canonical bytes of the document without one. */
export function numberedDocumentText(document: BillOfMaterials): string {
  const unnumbered: BillOfMaterials = { ...document };
  delete unnumbered.serialNumber;
  const name = new TextEncoder().encode(canonicalBillOfMaterialsText(unnumbered));
  return canonicalBillOfMaterialsText({
    ...unnumbered,
    serialNumber: `urn:uuid:${nameBasedUuid(SERIAL_NUMBER_NAMESPACE, name)}`,
  });
}

/** A module as a component node: what its own `telo.yaml` says it is. */
function moduleComponent(ref: string, subject: RecordSubject): CycloneDxComponent {
  return {
    type: subject.type,
    "bom-ref": ref,
    name: subject.name,
    ...(subject.version !== undefined ? { version: subject.version } : {}),
    ...(subject.license ? { licenses: [licenseChoice(subject.license)] } : {}),
  };
}

/** The components of `components` no other of them contains. */
function topLevel(components: readonly CycloneDxComponent[], contains: Map<string, string[]>): string[] {
  const contained = new Set([...contains.values()].flat());
  return components.map((component) => component["bom-ref"]!).filter((ref) => !contained.has(ref));
}

/** One module's components and edges, qualified by its node's reference. */
function qualified(node: ClosureModule): { components: CycloneDxComponent[]; dependencies: CycloneDxDependency[] } {
  const q = (ref: string) => `${node.ref}#${ref}`;
  // What an unrecorded module contains is unknown, so it gets no edge of its own
  // unless it imports something.
  if (node.unrecorded) {
    return {
      components: [],
      dependencies: node.dependsOn.length > 0 ? [{ ref: node.ref, dependsOn: [...node.dependsOn] }] : [],
    };
  }
  return {
    components: node.components.map((component) => ({ ...component, "bom-ref": q(component["bom-ref"]!) })),
    dependencies: [
      { ref: node.ref, dependsOn: [...node.dependsOn, ...topLevel(node.components, node.contains).map(q)] },
      ...[...node.contains].map(([from, to]) => ({ ref: q(from), dependsOn: to.map(q) })),
    ],
  };
}

/** The modules a document marks incomplete, by reference. */
export function incompleteModules(closure: ApplicationClosure): ClosureModule[] {
  return closure.modules.filter((node) => node.unrecorded !== undefined);
}

/**
 * One document over the whole closure: the entry as the subject, one node per
 * module, each module's components qualified by the module carrying them and
 * never merged across modules, and each module with no complete record marked
 * `incomplete` in `compositions` — which the caller asks for only when told to
 * go on past one.
 */
export function composeApplicationDocument(closure: ApplicationClosure): string {
  const components: CycloneDxComponent[] = [];
  const dependencies: CycloneDxDependency[] = [];
  for (const node of closure.modules) {
    if (node !== closure.entry) components.push(moduleComponent(node.ref, node.subject));
    const own = qualified(node);
    components.push(...own.components);
    dependencies.push(...own.dependencies);
  }
  const incomplete = incompleteModules(closure).map((node) => node.ref);
  return numberedDocumentText({
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: { component: moduleComponent(closure.entry.ref, closure.entry.subject) },
    components,
    dependencies,
    ...(incomplete.length > 0 ? { compositions: [{ aggregate: "incomplete", assemblies: incomplete }] } : {}),
  });
}

/** One module's record as a document of its own: the stored record within the
 *  scope, its subject given `ref`, its own top-level components beneath it. */
export function composeModuleDocument(ref: string, record: BillOfMaterials, scope: OccurrenceScope): string {
  const { components, contains } = scopedRecord(record, scope);
  return numberedDocumentText({
    ...record,
    metadata: { ...record.metadata, component: { ...record.metadata.component, "bom-ref": ref } },
    components,
    dependencies: [
      { ref, dependsOn: topLevel(components, contains) },
      ...[...contains].map(([from, to]) => ({ ref: from, dependsOn: to })),
    ],
  });
}

/** How many third-party components a closure lists. */
export function componentCount(closure: ApplicationClosure): number {
  return closure.modules.reduce((sum, node) => sum + (node.unrecorded ? 0 : node.components.length), 0);
}
