import { useState } from "react";
import type { SentFile } from "./chat-blocks.js";
import type { Attachment } from "./chat-protocol.js";
import type { UploadHandle } from "./chat-files.js";

/** A file being attached, from the choice until it is sent or removed. */
export interface Pending {
  key: number;
  name: string;
  /** Whether it is a picture, drawn as a thumbnail. */
  image: boolean;
  /** A local object URL for a picture chosen here, shown before its upload ends; released with the file. */
  preview?: string;
  /** The server's address of a file an entry already carries (Edit & resend); an upload has none until a message sends it. */
  url?: string;
  status: "uploading" | "done" | "failed";
  percent: number;
  attachment?: Attachment;
  reason?: string;
  handle?: UploadHandle;
}

/** A file as the message sent with it shows it; the local preview passes to the message, which releases it. */
export const sentFile = (file: Pending): SentFile => ({
  name: file.name,
  image: file.image,
  ...(file.url ? { url: file.url } : {}),
  ...(file.preview ? { preview: file.preview } : {}),
});

/** Gives up a file that is not sent: its upload stops and its local preview is released. */
export function discard(file: Pending): void {
  file.handle?.abort();
  if (file.preview) window.URL.revokeObjectURL(file.preview);
}

/** What is being written for a conversation and not sent. */
export interface Draft {
  message: string;
  files: Pending[];
  /** Why the files last chosen were refused. */
  problems: string[];
}

export const EMPTY_DRAFT: Draft = { message: "", files: [], problems: [] };

/** The key of the conversation that has no id yet. */
export const NEW_DRAFT = "";

/**
 * The drafts of the page's conversations, kept for as long as the page is: each conversation has its own, a new one
 * included, and an upload keeps going into the draft that started it.
 */
export class Drafts {
  private readonly drafts = new Map<string, Draft>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): number => this.version;

  get(key: string): Draft {
    return this.drafts.get(key) ?? EMPTY_DRAFT;
  }

  patch(key: string, change: (draft: Draft) => Draft): void {
    this.drafts.set(key, change(this.get(key)));
    this.changed();
  }

  /** The draft of a conversation that was just given its id. */
  move(from: string, to: string): void {
    const draft = this.drafts.get(from);
    if (!draft || from === to) return;
    this.drafts.delete(from);
    this.drafts.set(to, draft);
    this.changed();
  }

  /** Give up every file still held, when the page leaves. */
  abortAll(): void {
    for (const draft of this.drafts.values()) for (const file of draft.files) discard(file);
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

export const useDrafts = (): Drafts => useState(() => new Drafts())[0];
