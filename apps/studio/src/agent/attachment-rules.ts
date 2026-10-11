import type { AttachmentLimits } from "./types";

/** What a file is sent as when the browser names no type for it — or names one
 *  the agent does not take, though the file is text. First accepted one wins. */
const TYPES_BY_EXTENSION: Record<string, string[]> = {
  yaml: ["application/yaml", "application/x-yaml", "text/yaml"],
  yml: ["application/yaml", "application/x-yaml", "text/yaml"],
  json: ["application/json", "text/plain"],
  md: ["text/markdown"],
  csv: ["text/csv"],
  sql: ["text/plain"],
  log: ["text/plain"],
  txt: ["text/plain"],
};

function bare(mediaType: string): string {
  return mediaType.split(";")[0].trim().toLowerCase();
}

/** Whether `mediaTypes` takes `mediaType`; `type/*` stands for every subtype. */
export function acceptsMediaType(mediaTypes: readonly string[], mediaType: string): boolean {
  const type = bare(mediaType);
  if (!type) return false;
  return mediaTypes.some((accepted) => {
    const pattern = bare(accepted);
    return pattern.endsWith("/*") ? type.startsWith(pattern.slice(0, -1)) : pattern === type;
  });
}

/** The media type a file's upload part declares: the browser's own when the
 *  agent takes it, else what its extension says. Empty when neither names one. */
export function uploadMediaType(file: { name: string; type: string }, mediaTypes: readonly string[]): string {
  const own = bare(file.type);
  if (own && acceptsMediaType(mediaTypes, own)) return own;
  const extension = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1].toLowerCase() ?? "";
  const candidates = TYPES_BY_EXTENSION[extension];
  if (!candidates) return own;
  return candidates.find((candidate) => acceptsMediaType(mediaTypes, candidate)) ?? (own || candidates[0]);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function isImageType(mediaType: string): boolean {
  return bare(mediaType).startsWith("image/");
}

/** Why the agent would not take this file, by its capability document — said
 *  before anything is sent. Null when the document allows it. */
export function fileRefusal(limits: AttachmentLimits, file: { size: number; mediaType: string }): string | null {
  if (file.size > limits.maxBytes) return `Larger than the ${formatBytes(limits.maxBytes)} limit.`;
  if (!acceptsMediaType(limits.mediaTypes, file.mediaType)) {
    return `${file.mediaType ? `${file.mediaType} files are` : "This file type is"} not accepted. Accepted: ${limits.mediaTypes.join(", ")}.`;
  }
  return null;
}

export function perMessageRefusal(max: number): string {
  return `A message takes at most ${max} ${max === 1 ? "file" : "files"}.`;
}

/** An upload the agent refused, in words — by its `code`, with the limit the
 *  refusal carries. */
export function uploadRefusal(refused: { code?: string; message: string; details: Record<string, unknown> }): string {
  const { details } = refused;
  const number = (key: string) => (typeof details[key] === "number" ? (details[key] as number) : null);
  switch (refused.code) {
    case "ERR_ATTACHMENT_TOO_LARGE":
    case "ERR_REQUEST_BODY_TOO_LARGE": {
      const max = number("maxBytes");
      return max === null ? "Too large for this agent." : `Larger than the ${formatBytes(max)} limit.`;
    }
    case "ERR_ATTACHMENT_TYPE_NOT_ACCEPTED": {
      const accepted = Array.isArray(details.accepted) ? ` Accepted: ${details.accepted.join(", ")}.` : "";
      return `${typeof details.mediaType === "string" ? `${details.mediaType} files are` : "This file type is"} not accepted.${accepted}`;
    }
    case "ERR_ATTACHMENT_MISLABELLED":
      return typeof details.mediaType === "string"
        ? `Its content is ${details.mediaType}, which does not match its type.`
        : "Its content does not match its type.";
    case "ERR_ATTACHMENT_LIMIT": {
      const max = number("max");
      return max === null ? "This conversation holds no more files." : `This conversation already holds ${max} files.`;
    }
    case "ERR_ATTACHMENT_MISSING":
      return "The agent received no file.";
    case "ERR_CONVERSATION_ARCHIVED":
      return "This conversation is archived.";
    case "ERR_CONVERSATION_NOT_FOUND":
    case "ERR_CONVERSATION_REMOVED":
      return "The agent no longer has this conversation.";
    default:
      return refused.message;
  }
}
