import { modelContentUnsupported } from "./model-failure.js";
import type { ContentPart, MediaPart } from "./content.js";
import type { InvokeError } from "@telorun/sdk";

/**
 * What a model takes beside text — `Ai.AcceptedContent`. Absent means text only.
 * A media type is exact (`image/png`) or every subtype of a type (`image/*`).
 */
export interface AcceptedContentEntry {
  type: "image" | "audio" | "video" | "file";
  mediaTypes: string[];
  /** The largest a part carrying its bytes may be; a part by reference is not measured. */
  maxBytes?: number | bigint;
}

export type AcceptedContent = AcceptedContentEntry[];

/** A media type without its parameters, lowercased. */
function essence(mediaType: string): string {
  return (mediaType.split(";")[0] ?? "").trim().toLowerCase();
}

function admits(mediaTypes: string[], mediaType: string): boolean {
  const type = essence(mediaType);
  return mediaTypes.some(
    (entry) => entry === type || (entry.endsWith("/*") && type.startsWith(entry.slice(0, -1))),
  );
}

function byteLength(data: Uint8Array | string): number {
  if (typeof data !== "string") return data.length;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/** The accepted list a resource declares, `[]` (text only) when it declares none. */
export function acceptedOf(resource: { accepts?: AcceptedContent | undefined }): AcceptedContent {
  return resource.accepts ?? [];
}

/** What a model instance publishes as `accepts`; text only for one that publishes none. */
export function acceptedByModel(model: unknown): AcceptedContent {
  const snapshot = (model as { snapshot?: () => unknown } | null | undefined)?.snapshot;
  if (typeof snapshot !== "function") return [];
  const reading = snapshot.call(model) as { accepts?: AcceptedContent } | undefined;
  return reading?.accepts ?? [];
}

/**
 * The refusal of a media part outside `accepts`, or `undefined` when it is inside:
 * its type is not listed, its media type is outside the entry's, or its bytes are
 * over the entry's bound. Raised by the provider while it builds the request, so
 * nothing has been sent.
 */
export function unacceptedPart(
  accepts: AcceptedContent,
  part: MediaPart,
  label: string,
): InvokeError | undefined {
  const entries = accepts.filter((entry) => entry.type === part.type);
  const entry = entries.find((candidate) => admits(candidate.mediaTypes, part.mediaType));
  const data = { partType: part.type, mediaType: part.mediaType };
  if (entry === undefined) {
    const takes =
      entries.length === 0
        ? `This model's 'accepts' lists no '${part.type}'.`
        : `This model's 'accepts' takes '${part.type}' only as ${entries
            .flatMap((candidate) => candidate.mediaTypes)
            .join(", ")}.`;
    return modelContentUnsupported(
      `${label}: a '${part.type}' content part of media type '${part.mediaType}' is not accepted. ${takes}`,
      data,
    );
  }
  if (entry.maxBytes !== undefined && part.data !== undefined) {
    const size = byteLength(part.data);
    if (size > Number(entry.maxBytes)) {
      return modelContentUnsupported(
        `${label}: a '${part.type}' content part of media type '${part.mediaType}' is ${size} bytes, ` +
          `over this model's 'accepts' bound of ${entry.maxBytes} bytes.`,
        data,
      );
    }
  }
  return undefined;
}

/** Throws {@link unacceptedPart}'s refusal for a media part; text and every other part pass. */
export function requireAccepted(
  accepts: AcceptedContent,
  part: ContentPart,
  label: string,
): void {
  if (part.type === "text" || !("mediaType" in part)) return;
  const refusal = unacceptedPart(accepts, part, label);
  if (refusal) throw refusal;
}
