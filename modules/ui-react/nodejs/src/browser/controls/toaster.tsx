import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import type { CloseReason, ToasterProps, ToastTone } from "../../contract/ui-react-controls.js";
import { admitToaster, holdToaster, LAYER, tabbables } from "./layers.js";

const TOAST = '[data-telo-part="toast"]';
/** How far a toast is dragged sideways before letting go dismisses it. */
const SWIPE = 50;
/** How long an announcement stays in its live region. */
const ANNOUNCED_MS = 1000;

/** Read aloud and never drawn. */
const unseen = {
  position: "absolute",
  width: "1px",
  height: "1px",
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
} as const;

const assertive = (tone: ToastTone) => tone === "danger";

/** The words an element reads as, its pieces of text joined by spaces. */
function wordsOf(element: Element): string {
  const words: string[] = [];
  const walker = element.ownerDocument.createTreeWalker(element, 4);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const piece = text.textContent?.trim();
    if (piece) words.push(piece);
  }
  return words.join(" ");
}

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The application's notifications at the end of `<body>`: a layer outside the
 * stack, which no key, press or focus inside it reaches. Posting moves no
 * focus; F8 brings the focus in, Tab walks the buttons and leaving either end
 * gives the focus back where F8 took it from, and Escape dismisses the toast
 * holding the focus. Each toast is announced once as it arrives.
 */
export function Toaster({ items, side, align, label, dismissLabel, onDismiss, onPauseChange }: ToasterProps) {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const latest = useRef({ onDismiss, onPauseChange });
  latest.current = { onDismiss, onPauseChange };
  // The visit F8 started, and where it took the focus from.
  const visit = useRef<{ from: HTMLElement | null } | null>(null);
  const pause = useRef({ pointer: false, focus: false, reported: false });
  const elements = useRef(new Map<string, HTMLElement>());
  const announced = useRef(new Set<string>());
  const [announcement, setAnnouncement] = useState({ polite: "", assertive: "" });

  const reportPause = () => {
    const held = pause.current;
    const paused = held.pointer || held.focus;
    if (paused === held.reported) return;
    held.reported = paused;
    latest.current.onPauseChange(paused);
  };

  const giveBack = () => {
    const back = visit.current?.from;
    visit.current = null;
    admitToaster(false);
    if (back?.isConnected) back.focus();
    else (document.activeElement as HTMLElement | null)?.blur?.();
  };

  useEffect(() => (root ? holdToaster(root) : undefined), [root]);

  useEffect(() => {
    if (!root) return;
    const enter = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "F8" || root.contains(document.activeElement) || !root.querySelector(TOAST)) return;
      const active = document.activeElement;
      visit.current = { from: active instanceof HTMLElement && active !== document.body ? active : null };
      admitToaster(true);
      root.focus();
    };
    document.addEventListener("keydown", enter);
    return () => document.removeEventListener("keydown", enter);
  }, [root]);

  // A visit whose toast went from under the focus stays in the toaster while it holds one.
  useLayoutEffect(() => {
    if (!root || visit.current === null || root.contains(document.activeElement)) return;
    if (root.querySelector(TOAST)) root.focus();
    else giveBack();
  }, [items, root]);

  useLayoutEffect(() => {
    const keys = new Set(items.map((item) => item.key));
    for (const key of announced.current) if (!keys.has(key)) announced.current.delete(key);
    const fresh = items.filter((item) => !announced.current.has(item.key));
    if (fresh.length === 0) return;
    const said = { polite: [] as string[], assertive: [] as string[] };
    for (const item of fresh) {
      announced.current.add(item.key);
      const body = elements.current.get(item.key);
      if (body) said[assertive(item.tone) ? "assertive" : "polite"].push(wordsOf(body));
    }
    setAnnouncement((now) => ({
      polite: said.polite.length > 0 ? said.polite.join(" ") : now.polite,
      assertive: said.assertive.length > 0 ? said.assertive.join(" ") : now.assertive,
    }));
  }, [items]);

  useEffect(() => {
    if (announcement.polite === "" && announcement.assertive === "") return;
    const timer = window.setTimeout(() => setAnnouncement({ polite: "", assertive: "" }), ANNOUNCED_MS);
    return () => window.clearTimeout(timer);
  }, [announcement]);

  /** Dismiss the toast drawn as `toast`, the focus held in it moving to another toast, else back. */
  const dismiss = (toast: HTMLElement, key: string, reason: CloseReason) => {
    const held = toast.contains(document.activeElement);
    const toasts = [...(root?.querySelectorAll<HTMLElement>(TOAST) ?? [])];
    const at = toasts.indexOf(toast);
    const next = toasts[at + 1] ?? toasts[at - 1];
    latest.current.onDismiss(key, reason);
    if (!held) return;
    if (next) next.focus();
    else if (visit.current !== null) giveBack();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!root) return;
    const active = document.activeElement as HTMLElement | null;
    if (event.key === "Escape") {
      const toast = active?.closest<HTMLElement>(TOAST);
      const key = toast ? [...elements.current].find(([, element]) => element === toast)?.[0] : undefined;
      if (toast && key !== undefined) dismiss(toast, key, "escape");
      else giveBack();
    } else if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const order = tabbables(root);
      const following = (element: HTMLElement) => !!active && (active.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      const next = event.shiftKey ? order.filter((element) => !following(element) && element !== active && !element.contains(active)).at(-1) : order.find(following);
      if (next) next.focus();
      else giveBack();
    }
  };

  return createPortal(
    <section
      data-telo-part="toaster"
      {...{ [LAYER]: "" }}
      data-side={side}
      data-align={align}
      role="region"
      aria-label={label}
      tabIndex={-1}
      ref={setRoot}
      onKeyDown={onKeyDown}
      onPointerEnter={() => {
        pause.current.pointer = true;
        reportPause();
      }}
      onPointerLeave={() => {
        pause.current.pointer = false;
        reportPause();
      }}
      onFocus={() => {
        pause.current.focus = true;
        reportPause();
      }}
      onBlur={(event) => {
        if (root?.contains(event.relatedTarget as Node | null)) return;
        pause.current.focus = false;
        visit.current = null;
        admitToaster(false);
        reportPause();
      }}
    >
      <div role="status" aria-live="polite" style={unseen}>
        {announcement.polite}
      </div>
      <div role="alert" aria-live="assertive" style={unseen}>
        {announcement.assertive}
      </div>
      {items.map((item) => (
        <Toast
          key={item.key}
          item={item}
          dismissLabel={dismissLabel}
          register={(element) => (element ? elements.current.set(item.key, element) : elements.current.delete(item.key))}
          onDismiss={dismiss}
        />
      ))}
    </section>,
    document.body,
  );
}

function Toast({
  item,
  dismissLabel,
  register,
  onDismiss,
}: {
  item: ToasterProps["items"][number];
  dismissLabel: string;
  register(element: HTMLElement | null): void;
  onDismiss(toast: HTMLElement, key: string, reason: CloseReason): void;
}) {
  const element = useRef<HTMLDivElement | null>(null);
  const swipe = useRef<{ from: number; moved: number } | null>(null);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    swipe.current = { from: event.clientX, moved: 0 };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const held = swipe.current;
    if (!held) return;
    held.moved = event.clientX - held.from;
    if (!reducedMotion() && element.current) element.current.style.translate = `${held.moved}px 0`;
  };
  const onPointerUp = () => {
    const held = swipe.current;
    swipe.current = null;
    if (element.current) element.current.style.translate = "";
    if (!held || Math.abs(held.moved) < SWIPE || !element.current) return;
    // The press a swipe ended on is no press of its own.
    element.current.addEventListener("click", (event) => event.preventDefault(), { once: true, capture: true });
    onDismiss(element.current, item.key, "close");
  };
  return (
    <div
      data-telo-part="toast"
      data-state="open"
      data-tone={item.tone}
      tabIndex={-1}
      ref={(node) => {
        element.current = node;
        register(node);
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {item.children}
      <button type="button" aria-label={dismissLabel} onClick={(event) => onDismiss(event.currentTarget.closest(TOAST) as HTMLElement, item.key, "close")}>
        <X data-telo-part="icon" aria-hidden="true" focusable="false" />
      </button>
    </div>
  );
}
