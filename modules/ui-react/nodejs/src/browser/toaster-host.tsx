import { Component, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { DestinationAnchor, resolveDestination, useDestinationContext } from "./destination.js";
import { useControl } from "./effective-controls.js";
import { useHost, useHostStore } from "./host.js";
import { linkAddress } from "./link-address.js";
import { boundRecord } from "./mutation-calls.js";
import type { CallEnvironment, MutationRunner } from "./mutation-call.js";
import { ErrorNode } from "./nodes.js";
import { RendererContext } from "./renderer-context.js";
import { formatText, TextsContext, useSay, useText } from "./texts.js";
import type { PostedToast, ToastBoard } from "./toasts.js";
import { errorSpec, type ErrorSpec } from "./ui-error.js";

/** Where the application's toaster sits: the application document's `toaster`. */
export interface ToasterPlacement {
  side: "top" | "bottom";
  align: "start" | "center" | "end";
}

/** Where the toaster sits when the application document names no place. */
export const DEFAULT_TOASTER: ToasterPlacement = { side: "bottom", align: "end" };

/** A toaster that cannot be drawn is drawn as its failure, in its place. */
class ToasterBoundary extends Component<{ children: ReactNode }, { error?: ErrorSpec }> {
  state: { error?: ErrorSpec } = {};

  static getDerivedStateFromError(error: unknown) {
    return { error: errorSpec(error, "ERR_UI_THEME_CONTROL_FAILED") };
  }

  render() {
    return this.state.error ? <ErrorNode error={this.state.error} /> : this.props.children;
  }
}

/**
 * The application's one toaster, drawn by the effective set's `Toaster` for as
 * long as the application is: every toast posted, by the page or a page opened
 * over it, with its text and its buttons.
 */
export function ToasterHost({ placement, runner }: { placement: ToasterPlacement; runner: MutationRunner }) {
  return (
    <ToasterBoundary>
      <Toasts placement={placement} runner={runner} />
    </ToasterBoundary>
  );
}

function Toasts({ placement, runner }: { placement: ToasterPlacement; runner: MutationRunner }) {
  const store = useHostStore();
  const board = store.toasts;
  const shown = useSyncExternalStore(board.subscribe, board.snapshot);
  const Toaster = useControl("Toaster");
  const say = useSay();
  const texts = useContext(TextsContext);
  // Two toasts are equal by their formatted text; timers stand still while the document is hidden.
  useEffect(() => board.formatWith((text, roots) => formatText(texts, text, roots)), [board, texts]);
  useEffect(() => {
    const hide = () => board.setHidden(document.visibilityState === "hidden");
    hide();
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [board]);
  return (
    <Toaster
      items={shown.map((toast) => ({ key: toast.key, tone: toast.effect.tone, children: <ToastContent toast={toast} runner={runner} /> }))}
      side={placement.side}
      align={placement.align}
      label={say("toaster")}
      dismissLabel={say("close")}
      onDismiss={(key) => board.withdraw(key)}
      onPauseChange={(paused) => board.setPaused(paused)}
    />
  );
}

/** A toast's text, then its link and its call, each over the roots it was posted with. */
function ToastContent({ toast, runner }: { toast: PostedToast; runner: MutationRunner }) {
  const { effect, roots } = toast;
  const store = useHostStore();
  const text = useText();
  const destination = effect.link === undefined ? undefined : resolveDestination(effect.link.to, roots, "toast link");
  const href = destination === undefined ? undefined : linkAddress(store, destination.address);
  const linkLabel = effect.link === undefined ? "" : text(effect.link.label, undefined, roots);
  const actions = (destination !== undefined && href !== undefined) || effect.call !== undefined;
  return (
    <>
      <p data-telo-part="toast-text">{text(effect.text, undefined, roots)}</p>
      {actions && (
        <div data-telo-part="toast-actions">
          {destination !== undefined && href !== undefined && (
            <DestinationAnchor destination={destination} href={href} naming={linkLabel} unplaced data-telo-part="link">
              {linkLabel}
            </DestinationAnchor>
          )}
          {effect.call !== undefined && <ToastCall toast={toast} runner={runner} />}
        </div>
      )}
    </>
  );
}

/**
 * Press a toast's call on the page's runner, so a serial mutation queues behind
 * the page's own runs of it. The board holds the press: a toast dismissed or
 * dropped meanwhile still answers and runs its lists, and a success withdraws
 * the toast before they run.
 */
export function pressToast(board: ToastBoard, runner: MutationRunner, toast: PostedToast, env: CallEnvironment): Promise<void> {
  const call = toast.effect.call!;
  return board.press(toast.key, (answered) => runner.execute(call, boundRecord(call, toast.roots), { ...env, placed: toast.roots, answered }));
}

/**
 * A toast's call: its record read from the roots the toast was posted with. A
 * success withdraws the toast and runs the call's `onSuccess`; a failure keeps
 * the toast, pressable again, and runs its `onFailure`.
 */
function ToastCall({ toast, runner }: { toast: PostedToast; runner: MutationRunner }) {
  const call = toast.effect.call!;
  const host = useHost();
  const store = useHostStore();
  const destinations = useDestinationContext();
  const say = useSay();
  const text = useText();
  const { prefix } = useContext(RendererContext);
  const label = text(call.label, undefined, toast.roots);
  const env = { host, prefix, say, destinations, naming: label, unplaced: true, close: toast.close };
  const press = () => void pressToast(store.toasts, runner, toast, env);
  return (
    <button type="button" data-telo-part="button" data-button="text" aria-busy={toast.busy || undefined} onClick={press}>
      {label}
    </button>
  );
}
