import type { OwnText } from "../ui-error.js";
import { ChatFailure, problemFailure, type Attachment, type ChatApi, type ChatSpec } from "./chat-protocol.js";
import type { Say } from "../texts.js";

type Offer = NonNullable<ChatSpec["attachments"]>;

/** Whether a media type is one of a list, which may hold `type/*` and `*` . */
const accepted = (mediaTypes: readonly string[], mediaType: string): boolean =>
  mediaTypes.some((each) => {
    const pattern = each.toLowerCase();
    const actual = mediaType.toLowerCase();
    return pattern === "*/*" || pattern === actual || (pattern.endsWith("/*") && actual.startsWith(pattern.slice(0, -1)));
  });

/** A size in bytes as a person reads it, in the page's language. */
export function sizeText(bytes: number, lang: string): string {
  const units = [
    ["gigabyte", 1024 ** 3],
    ["megabyte", 1024 ** 2],
    ["kilobyte", 1024],
  ] as const;
  const [unit, size] = units.find(([, each]) => bytes >= each) ?? (["byte", 1] as const);
  const format = (language: string) =>
    new Intl.NumberFormat(language, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: 1 }).format(bytes / size);
  try {
    return format(lang);
  } catch {
    // A tag the platform does not know (`und`).
    return format("en");
  }
}

/**
 * Why a file may not be attached, as the renderer's text naming it, or nothing
 * when it may: judged against the endpoint's offer before anything is uploaded.
 */
export function refusalOf(file: { name: string; type: string; size: number }, offer: Offer, held: number, lang: string): OwnText | undefined {
  if (held >= offer.maxPerMessage) return { key: "chatAttachmentTooMany", values: { limit: offer.maxPerMessage } };
  const entry = offer.accepts.find((each) => accepted(each.mediaTypes, file.type));
  if (!entry) return { key: "chatAttachmentWrongType", values: { name: file.name } };
  if (file.size > entry.maxBytes) return { key: "chatAttachmentTooLarge", values: { name: file.name, limit: sizeText(entry.maxBytes, lang) } };
  return undefined;
}

/** What an upload in progress reports. */
export interface UploadHandle {
  done: Promise<Attachment>;
  abort(): void;
}

/**
 * `POST /attachments`, one file as `multipart/form-data`, reporting progress.
 * A request cannot report its upload through `fetch`, so this one is an
 * `XMLHttpRequest`, sent to the same address with the page's credentials.
 */
export function uploadFile(api: ChatApi, file: File, say: Say, onProgress: (percent: number) => void): UploadHandle {
  const request = new XMLHttpRequest();
  const done = new Promise<Attachment>((resolve, reject) => {
    request.open("POST", api.url("/attachments"));
    request.withCredentials = false;
    request.setRequestHeader("accept", "application/json");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.min(99, Math.floor((event.loaded / event.total) * 100)));
    };
    request.onerror = () => reject(new ChatFailure("ERR_UI_REQUEST_FAILED", say("requestFailed", { reason: request.statusText || "network error" })));
    request.onabort = () => reject(new DOMException("aborted", "AbortError"));
    request.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(request.responseText);
      } catch {
        // A body that is not JSON: the status alone is the report.
      }
      if (request.status < 200 || request.status >= 300) return reject(problemFailure(request.status, body, say));
      if (body === undefined) return reject(new ChatFailure("ERR_UI_RESPONSE_INVALID", say("answerNotJson"), request.status));
      try {
        resolve(api.attachmentOf(body));
      } catch (error) {
        reject(error);
      }
    };
    const form = new FormData();
    form.append("file", file, file.name);
    request.send(form);
  });
  return { done, abort: () => request.abort() };
}
