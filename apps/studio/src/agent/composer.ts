import type { Attachment } from "./types";

/** A file on the composer. `key` names the chip; an uploaded one has the
 *  agent's `id`, and only an uploaded one is ever stored or sent. */
export type ComposerAttachment =
  | (Attachment & { key: string; state: "uploaded" })
  | { key: string; state: "uploading"; name: string; mediaType: string; size: number }
  | { key: string; state: "failed"; name: string; mediaType: string; size: number; reason: string };

/** A message waiting for the running turn to end. */
export interface QueuedMessage {
  text: string;
  attachments: Attachment[];
}

/** What the user has written and not sent, for one conversation. Held by the
 *  agent context rather than the panel: editor entry points write into it, and
 *  it outlives the panel being closed. */
export interface ComposerState {
  text: string;
  attachments: ComposerAttachment[];
  queued: QueuedMessage | null;
}

export const EMPTY_COMPOSER: ComposerState = { text: "", attachments: [], queued: null };

/** The composer's uploaded files, as a message carries them, in chip order. */
export function uploadedAttachments(attachments: ComposerAttachment[]): Attachment[] {
  return attachments.flatMap((a) =>
    a.state === "uploaded" ? [{ id: a.id, name: a.name, mediaType: a.mediaType, size: a.size }] : [],
  );
}

/** What of a composer is kept across a reload or a switch: its text, its
 *  uploaded files' descriptors and its queue. A file still uploading, or one
 *  that failed, is the session's alone. */
export function storedComposer(composer: ComposerState): {
  text: string;
  attachments: Attachment[];
  queued: QueuedMessage | null;
} {
  return { text: composer.text, attachments: uploadedAttachments(composer.attachments), queued: composer.queued };
}

/** Whether a submit is held: a file is still uploading, or one failed and has
 *  to be removed or retried first. */
export function composerHold(composer: ComposerState): "uploading" | "failed" | null {
  if (composer.attachments.some((a) => a.state === "uploading")) return "uploading";
  return composer.attachments.some((a) => a.state === "failed") ? "failed" : null;
}

/** Whether the composer holds a message: text, or files alone. */
export function hasMessage(composer: ComposerState): boolean {
  return composer.text.trim() !== "" || composer.attachments.length > 0;
}

/** Where a composer is stored: under its conversation, or under the workspace
 *  while no conversation exists yet. Null with no workspace open. */
export function composerKey(workspaceKey: string | null, conversationId: string | null): string | null {
  if (conversationId) return `conversation:${conversationId}`;
  return workspaceKey ? `workspace:${workspaceKey}` : null;
}

/** `addition` after `text`, a blank line between them. */
export function appendBlock(text: string, addition: string): string {
  const before = text.replace(/\s+$/, "");
  if (addition.trim() === "") return before;
  return before === "" ? addition : `${before}\n\n${addition}`;
}

/** The composer's message moved into the queue — after what is queued already,
 *  its files after the queued ones. */
export function queueComposerMessage(composer: ComposerState): ComposerState {
  if (!hasMessage(composer)) return composer;
  const text = composer.text.trim();
  const attachments = uploadedAttachments(composer.attachments);
  return {
    text: "",
    attachments: [],
    queued: composer.queued
      ? { text: appendBlock(composer.queued.text, text), attachments: [...composer.queued.attachments, ...attachments] }
      : { text, attachments },
  };
}

/** The queued message moved back into the composer, ahead of what was typed
 *  and attached since. */
export function unqueueIntoComposer(composer: ComposerState): ComposerState {
  if (!composer.queued) return composer;
  return {
    text: appendBlock(composer.queued.text, composer.text),
    attachments: [
      ...composer.queued.attachments.map((a) => ({ ...a, key: a.id, state: "uploaded" as const })),
      ...composer.attachments,
    ],
    queued: null,
  };
}
