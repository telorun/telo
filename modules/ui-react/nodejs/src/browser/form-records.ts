import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { AutosaveWrites } from "./autosave-writes.js";
import type { Outcome } from "./mutation-call.js";
import { equal, validate, type JsonSchema } from "./validation.js";

/** What a query or listing naming a form reads of it: whether the form is
 *  placed on the page, and its settled, valid record — absent until it first holds one. */
export interface FormRoot {
  placed: boolean;
  record?: Record<string, unknown>;
}

const ABSENT: FormRoot = { placed: false };

/** The writes of a form: `onSubmit`'s or the default write, and `autosave`. */
export type FormWriteName = "submit" | "autosave";

/**
 * One form on one page, shared by every placement of it: what the placements
 * hold, the record `form` reads, and its writes and their last answers.
 */
export class FormSession {
  placements = 0;
  /** What the placements hold now, and which placement last changed it. */
  values?: { held: unknown; from: object };
  root: FormRoot = ABSENT;
  /** Which start the record belongs to: a start at another address discards it. */
  start?: string;
  autosave?: AutosaveWrites;
  /** Each write's last answer, drawn beneath the fields until it is cleared. */
  answers: Partial<Record<FormWriteName, Outcome>> = {};
  /** A submit press is being judged, flushed or sent. */
  submitting = false;
  /** Advanced on every change a placement draws. */
  version = 0;
}

/**
 * The forms drawn on one page, by form id — one per page, and one per page
 * opened over it, kept while that page is drawn. Two placements of one form
 * are one session: they share the values, the writes and what either settles,
 * which is the record every query and listing naming the form reads.
 */
export class FormRecords {
  private readonly sessions = new Map<string, FormSession>();
  private readonly listeners = new Map<string, Set<() => void>>();

  /** The session of a form, made the first time it is asked for. */
  session(id: string): FormSession {
    let session = this.sessions.get(id);
    if (!session) {
      session = new FormSession();
      this.sessions.set(id, session);
    }
    return session;
  }

  /** The session of a form placed now; nothing once its last placement has gone. */
  find(id: string): FormSession | undefined {
    return this.sessions.get(id);
  }

  /** Place a form; the returned function takes the placement away, and the last one everything the session held. */
  place(id: string): () => void {
    const session = this.session(id);
    session.placements += 1;
    if (session.placements === 1) this.publish(id, { ...session.root, placed: true });
    return () => {
      session.placements -= 1;
      if (session.placements > 0) return;
      session.autosave?.dispose();
      this.sessions.delete(id);
      this.notify(id);
    };
  }

  /** What `form` reads of a form now. */
  root(id: string): FormRoot {
    return this.sessions.get(id)?.root ?? ABSENT;
  }

  /**
   * A form starts from what it reads at `start` (the address its values come
   * from): a start other than the one its record was settled under discards
   * the record and what the placements held, so `form` holds nothing until the
   * form is valid again.
   */
  started(id: string, start: string): void {
    const session = this.session(id);
    if (session.start === start) return;
    const restarted = session.start !== undefined;
    session.start = start;
    if (!restarted) return;
    session.values = undefined;
    session.answers = {};
    session.autosave?.dispose();
    session.autosave = undefined;
    this.publish(id, { placed: session.root.placed });
  }

  /** A placement changed what the form holds: every other placement follows. */
  edit(id: string, held: unknown, from: object): void {
    this.session(id).values = { held, from };
    this.notify(id);
  }

  /**
   * The form's record settled: valid against its model, it is the record
   * `form` reads; invalid, `form` keeps the last valid one.
   */
  settle(id: string, schema: JsonSchema, record: Record<string, unknown>): void {
    const session = this.session(id);
    const settled = settledRecord(schema, session.root.record, record);
    if (settled.changed) this.publish(id, { placed: session.root.placed, record: settled.record });
  }

  /** Tell every placement of a form, and every reader of its record, that it changed. */
  notify(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.version += 1;
    for (const listener of [...(this.listeners.get(id) ?? [])]) listener();
  }

  readonly subscribe = (id: string, listener: () => void): (() => void) => {
    const listeners = this.listeners.get(id) ?? new Set();
    this.listeners.set(id, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(id);
    };
  };

  private publish(id: string, root: FormRoot): void {
    this.session(id).root = root;
    this.notify(id);
  }
}

/**
 * The record `form` holds once a form's record settles: the settled record
 * when the model holds it valid, else the one it held. `changed` says whether
 * that is another record. Held to `conformance/form-writes.json`.
 */
export function settledRecord(
  schema: JsonSchema,
  held: Record<string, unknown> | undefined,
  record: Record<string, unknown>,
): { record: Record<string, unknown> | undefined; changed: boolean } {
  if (validate(schema, record).length > 0) return { record: held, changed: false };
  return { record, changed: held === undefined || !equal(held, record) };
}

/** The forms of the page being drawn. */
export const FormRecordsContext = createContext(new FormRecords());

/** What `form` reads of the form `id` names on the page drawn; nothing named, nothing read. */
export function useFormRoot(id: string | null): FormRoot | undefined {
  const forms = useContext(FormRecordsContext);
  const subscribe = useCallback((listener: () => void) => (id === null ? () => {} : forms.subscribe(id, listener)), [forms, id]);
  return useSyncExternalStore(subscribe, () => (id === null ? undefined : forms.root(id)));
}
