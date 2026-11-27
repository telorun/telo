import { resolveAddress } from "./address-wire.js";
import { readBinding, type Binding } from "./bindings.js";
import type { DestinationWire } from "./destination.js";
import type { EffectSpec, MutationSpec } from "./mutation-call.js";
import type { WireText } from "./texts.js";

export type ToastTone = "info" | "success" | "warning" | "danger";

/** A mutation a toast's button runs: it asks nothing and draws no tree. */
export interface MutationPressWire {
  mutation: MutationSpec;
  inputs: Record<string, Binding>;
  label: WireText;
  onSuccess: EffectSpec[];
  onFailure: EffectSpec[];
}

/** A toast effect as the page document carries it, its tone filled by the list holding it. */
export interface ToastWire {
  type: "toast";
  text: WireText;
  tone: ToastTone;
  link?: { to: DestinationWire; label: WireText };
  call?: MutationPressWire;
}

/** A toast posted: its effect, and the roots of the list that posted it, read when it is drawn and pressed. */
export interface PostedToast {
  key: string;
  effect: ToastWire;
  roots: Readonly<Record<string, unknown>>;
  /** Closes the opened surface the posting call ran in, if it is still open. */
  close?: () => void;
  /** Whether its call is pending. */
  busy: boolean;
}

/** How long a toast with nothing to operate stays, in milliseconds. */
export const TOAST_LIFETIME = 6000;

/** The most toasts shown at once. */
export const TOAST_LIMIT = 3;

/** Whether a toast leaves on its own: `info` / `success` with no button to operate. */
export const isTimed = (effect: ToastWire): boolean => (effect.tone === "info" || effect.tone === "success") && effect.link === undefined && effect.call === undefined;

/** How a text is formatted, which two toasts are equal by. */
export type ToastFormat = (text: WireText, roots: Readonly<Record<string, unknown>>) => string;

const structural: ToastFormat = (text, roots) => {
  const values = "set" in text ? undefined : Object.fromEntries(Object.entries(text.values ?? {}).map(([name, binding]) => [name, readBinding(binding, roots)]));
  return JSON.stringify([text, values]);
};

interface Timer {
  left: number;
  since?: number;
  handle?: ReturnType<typeof setTimeout>;
}

/**
 * The application's toasts, oldest first: one board for the application and
 * every page opened over it, so a toast outlives the page and the surface that
 * posted it. It owns the timers, the limit and the deduplication.
 */
export class ToastBoard {
  private shown: readonly PostedToast[] = [];
  private issued = 0;
  private readonly watchers = new Set<() => void>();
  private readonly timers = new Map<string, Timer>();
  private pointer = false;
  private hidden = false;
  private format: ToastFormat = structural;

  readonly subscribe = (watcher: () => void): (() => void) => {
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  };

  readonly snapshot = (): readonly PostedToast[] => this.shown;

  /** Take text as the application's language formats it, for telling two toasts apart. */
  formatWith(format: ToastFormat): void {
    this.format = format;
  }

  /** Whether the toaster reports a pause (pointer or focus inside it): timers stand still. */
  setPaused(paused: boolean): void {
    this.pointer = paused;
    this.retime();
  }

  /** Whether the document is hidden: timers stand still. */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.retime();
  }

  /**
   * Show a toast over the roots it was posted with; answers its key. One equal
   * to a toast shown is not added again, and the shown one restarts its timer.
   * A fourth drops the oldest timed toast, else the oldest.
   */
  post(effect: ToastWire, roots: Readonly<Record<string, unknown>>, close?: () => void): string {
    const identity = this.identity(effect, roots);
    const equal = this.shown.find((toast) => this.identity(toast.effect, toast.roots) === identity);
    if (equal !== undefined) {
      if (this.timers.has(equal.key)) this.arm(equal.key, TOAST_LIFETIME);
      return equal.key;
    }
    const key = `toast-${++this.issued}`;
    let kept = this.shown;
    if (kept.length >= TOAST_LIMIT) {
      const dropped = kept.find((toast) => isTimed(toast.effect)) ?? kept[0];
      this.stop(dropped.key);
      kept = kept.filter((toast) => toast !== dropped);
    }
    this.shown = [...kept, { key, effect, roots: { ...roots }, close, busy: false }];
    if (isTimed(effect)) this.arm(key, TOAST_LIFETIME);
    this.notify();
    return key;
  }

  /** Take a toast away; one already gone changes nothing. */
  withdraw(key: string): void {
    if (!this.shown.some((toast) => toast.key === key)) return;
    this.stop(key);
    this.shown = this.shown.filter((toast) => toast.key !== key);
    this.notify();
  }

  /**
   * Run a toast's call: it is busy while pending; a success withdraws the
   * toast, a failure leaves it pressable again. `run` tells `answered` what the
   * write came to before its lists run, so the toast is gone before they post.
   * Withdrawing the toast meanwhile aborts nothing: the call answers all the same.
   */
  async press(key: string, run: (answered: (ok: boolean) => void) => Promise<{ ok: boolean }>): Promise<void> {
    if (this.shown.find((toast) => toast.key === key)?.busy !== false) return;
    this.patch(key, true);
    const answered = (ok: boolean) => {
      this.patch(key, false);
      if (ok) this.withdraw(key);
    };
    try {
      answered((await run(answered)).ok);
    } catch (error) {
      this.patch(key, false);
      throw error;
    }
  }

  private patch(key: string, busy: boolean) {
    if (!this.shown.some((toast) => toast.key === key)) return;
    this.shown = this.shown.map((toast) => (toast.key === key ? { ...toast, busy } : toast));
    this.notify();
  }

  private identity(effect: ToastWire, roots: Readonly<Record<string, unknown>>): string {
    const link = effect.link && {
      to: [effect.link.to.type, resolveAddress(effect.link.to.href, roots, "toast link")],
      label: this.format(effect.link.label, roots),
    };
    const call = effect.call && {
      mutation: effect.call.mutation.id,
      inputs: Object.fromEntries(Object.entries(effect.call.inputs).map(([name, binding]) => [name, readBinding(binding, roots)])),
      label: this.format(effect.call.label, roots),
    };
    return JSON.stringify([effect.tone, this.format(effect.text, roots), link, call]);
  }

  private get paused(): boolean {
    return this.pointer || this.hidden;
  }

  /** (Re)start a toast's timer with `left` milliseconds, running only while nothing pauses. */
  private arm(key: string, left: number) {
    this.stop(key);
    const timer: Timer = { left };
    this.timers.set(key, timer);
    if (!this.paused) this.run(key, timer);
  }

  private run(key: string, timer: Timer) {
    timer.since = Date.now();
    timer.handle = setTimeout(() => this.withdraw(key), timer.left);
  }

  private stop(key: string) {
    const timer = this.timers.get(key);
    if (timer?.handle !== undefined) clearTimeout(timer.handle);
    this.timers.delete(key);
  }

  private retime() {
    for (const [key, timer] of this.timers) {
      if (this.paused && timer.handle !== undefined) {
        clearTimeout(timer.handle);
        timer.handle = undefined;
        timer.left -= Date.now() - (timer.since ?? Date.now());
      } else if (!this.paused && timer.handle === undefined) this.run(key, timer);
    }
  }

  private notify() {
    for (const watcher of [...this.watchers]) watcher();
  }
}
