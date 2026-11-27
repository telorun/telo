import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MutationRunner, type MutationSpec } from "../src/browser/mutation-call.js";
import { pressToast } from "../src/browser/toaster-host.js";
import { ToastBoard, type ToastWire } from "../src/browser/toasts.js";
import { mutationSpec } from "./spec-nodes.js";

interface Descriptor {
  tone: ToastWire["tone"];
  text: string;
  link?: { label: string; to: string };
  call?: { label: string; mutation: string; inputs: Record<string, unknown>; onSuccess?: Descriptor[]; onFailure?: Descriptor[] };
}

type Step = (
  | { post: Descriptor }
  | { elapse: number }
  | { pause: boolean }
  | { hidden: boolean }
  | { dismiss: string }
  | { press: string }
  | { answer: "success" | "failure" }
) & { shown: string[]; busy?: string[] };

/** `ui`'s conformance rows: the lifetime, limit, deduplication and press of a toaster's board. */
const { rows } = JSON.parse(readFileSync(new URL("../../../ui/conformance/toasts.json", import.meta.url), "utf8")) as { rows: { name: string; steps: Step[] }[] };

const words = (text: string) => ({ message: [text], lang: "en" });
const wireOf = (toast: Descriptor): ToastWire => ({
  type: "toast",
    text: words(toast.text),
    tone: toast.tone,
    ...(toast.link && { link: { label: words(toast.link.label), to: { type: "navigate" as const, href: { path: { value: toast.link.to }, pathParams: {}, queryParams: {} } } } }),
    ...(toast.call && {
      call: {
        mutation: mutationSpec(`/api/${toast.call.mutation}`, {}) as MutationSpec,
        inputs: Object.fromEntries(Object.entries(toast.call.inputs).map(([name, value]) => [name, { value }])),
        label: words(toast.call.label),
        onSuccess: (toast.call.onSuccess ?? []).map((next) => wireOf(next)),
        onFailure: (toast.call.onFailure ?? []).map((next) => wireOf(next)),
      },
    }),
});

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("the toast board, held to ui's conformance rows", () => {
  it.each(rows.map((row) => [row.name, row] as const))("%s", async (_name, row) => {
    const board = new ToastBoard();
    const runner = new MutationRunner();
    // Each call is a real press on the runner; the fetch it waits on is answered by a step.
    const waiting: ((response: Response) => void)[] = [];
    const host = { fetch: () => new Promise<Response>((resolve) => waiting.push(resolve)), notifyChanged: () => {} };
    const destinations = { store: { toasts: board, notifyRefresh: () => {}, toast: () => ({ dismiss: () => {} }) }, prefix: "", pages: [], pageHost: null };
    const env = { host, prefix: "", say: (key: string) => key, destinations, naming: "" } as never;
    const post = (toast: Descriptor) => board.post(wireOf(toast), {});
    const text = (key: string) => (board.snapshot().find((toast) => toast.key === key)?.effect.text as { message: string[] } | undefined)?.message[0] as string;
    for (const [index, step] of row.steps.entries()) {
      if ("post" in step) post(step.post);
      else if ("elapse" in step) await vi.advanceTimersByTimeAsync(step.elapse);
      else if ("pause" in step) board.setPaused(step.pause);
      else if ("hidden" in step) board.setHidden(step.hidden);
      else if ("dismiss" in step) board.withdraw(board.snapshot().find((toast) => text(toast.key) === step.dismiss)!.key);
      else if ("press" in step) void pressToast(board, runner, board.snapshot().find((each) => text(each.key) === step.press)!, env);
      else waiting.shift()!(new Response(null, { status: step.answer === "success" ? 204 : 500 }));
      await vi.advanceTimersByTimeAsync(0);
      const at = `step ${index + 1}`;
      expect([at, board.snapshot().map((toast) => text(toast.key))]).toEqual([at, step.shown]);
      if (step.busy !== undefined) expect([at, board.snapshot().filter((toast) => toast.busy).map((toast) => text(toast.key))]).toEqual([at, step.busy]);
    }
  });
});
