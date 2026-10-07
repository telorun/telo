import { toPlainJson } from "@telorun/sdk";
import { sha256Hex } from "./asset-store.js";

/** The version of the document shapes a renderer reads. */
export const SPEC_VERSION = 1;

/** JSON with every object's keys in order, so equal documents are equal text. */
export function canonicalJson(value: unknown): string {
  const ordered = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(ordered);
    if (node === null || typeof node !== "object") return node;
    return Object.fromEntries(
      Object.keys(node)
        .sort()
        .map((key) => [key, ordered((node as Record<string, unknown>)[key])]),
    );
  };
  return JSON.stringify(ordered(toPlainJson(value)));
}

export interface ServedDocument {
  digest: string;
  /** The response body. */
  text: string;
}

/** A document with its digest: a hash of everything else it holds. */
export function servedDocument(document: Record<string, unknown>): ServedDocument {
  const digest = sha256Hex(canonicalJson(document));
  return { digest, text: canonicalJson({ ...document, digest }) };
}

/** Whether a conditional request already holds this document. */
export function holdsCurrent(ifNoneMatch: string | string[] | undefined, digest: string): boolean {
  const header = [ifNoneMatch ?? ""].flat().join(",");
  return header
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === `"${digest}"` || tag === "*");
}
