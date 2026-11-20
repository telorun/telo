/**
 * Which occurrences a bill of materials keeps under `--platform` / `--abi`.
 *
 * The flags are spelled as on `telo install`, and mean something narrower: they
 * FILTER the layers a record names rather than name a target to warm. An
 * occurrence is kept when its layer has no selector or matches every axis the
 * flags name, so an axis the flags leave out keeps every value — where
 * `telo install` reads a missing `--abi` as a host that loads no abi layer.
 */

import {
  LAYER_PROPERTY,
  normalizeAxisValue,
  type BillOfMaterials,
  type CycloneDxComponent,
  type PlatformAxis,
} from "@telorun/analyzer";
import { parsePlatformTriple } from "../bundle/warm-layers.js";

/** The axes the flags name; an axis absent here keeps every value. */
export type OccurrenceScope = Partial<Record<PlatformAxis, string>>;

/** The scope two flags name, refusing a malformed value as `telo install` does. */
export function parseOccurrenceScope(platform: string | undefined, abi: string | undefined): OccurrenceScope {
  const scope: OccurrenceScope = {};
  if (platform !== undefined) {
    const triple = parsePlatformTriple(platform);
    for (const axis of ["os", "arch", "libc"] as const) {
      if (triple[axis] !== undefined) scope[axis] = normalizeAxisValue(axis, triple[axis], "--platform");
    }
  }
  if (abi !== undefined) scope.abi = normalizeAxisValue("abi", abi, "--abi");
  return scope;
}

/** `every selector`, or what the flags named: `linux/amd64/gnu node-141`. */
export function describeOccurrenceScope(scope: OccurrenceScope): string {
  const triple = [scope.os, scope.arch, scope.libc].filter((part): part is string => part !== undefined);
  const parts = [...(triple.length > 0 ? [triple.join("/")] : []), ...(scope.abi ? [scope.abi] : [])];
  return parts.length > 0 ? parts.join(" ") : "every selector";
}

/** Whether a `telo:layer` value names a layer the scope keeps. */
export function occurrenceInScope(value: string, scope: OccurrenceScope): boolean {
  const pairs = new Map<string, string>();
  for (const part of value.split(";").slice(1)) {
    const at = part.indexOf("=");
    if (at > 0) pairs.set(part.slice(0, at), part.slice(at + 1));
  }
  for (const [axis, wanted] of Object.entries(scope)) {
    const stated = pairs.get(axis);
    if (stated !== undefined && stated !== wanted) return false;
  }
  return true;
}

/** A record's components and edges within a scope: each component keeps the
 *  occurrences the scope keeps, one left with none is dropped, and so is every
 *  edge to or from it. */
export function scopedRecord(
  record: BillOfMaterials,
  scope: OccurrenceScope,
): { components: CycloneDxComponent[]; contains: Map<string, string[]> } {
  const components: CycloneDxComponent[] = [];
  for (const component of record.components ?? []) {
    const properties = component.properties ?? [];
    const kept = properties.filter(
      (property) => property.name !== LAYER_PROPERTY || occurrenceInScope(property.value, scope),
    );
    if (!kept.some((property) => property.name === LAYER_PROPERTY)) continue;
    components.push({ ...component, properties: kept });
  }
  const refs = new Set(components.map((component) => component["bom-ref"]));
  const contains = new Map<string, string[]>();
  for (const dependency of record.dependencies ?? []) {
    if (!refs.has(dependency.ref)) continue;
    const targets = (dependency.dependsOn ?? []).filter((ref) => refs.has(ref));
    if (targets.length > 0) contains.set(dependency.ref, targets);
  }
  return { components, contains };
}
