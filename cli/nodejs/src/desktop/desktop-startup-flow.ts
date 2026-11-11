import type { UnavailableContext, UnavailableResponse, UnresolvedApplicationInput } from "@telorun/kernel";
import { randomBytes } from "node:crypto";

import type { InputPrompter } from "../application-input-prompt.js";
import type { AdmissionRequest, HostBodyRequest, HostResponse } from "./desktop-admission.js";
import { sameSecret } from "./desktop-control-channel.js";
import {
  ANSWERS_PATH,
  fieldName,
  inputFormView,
  notServedView,
  refusalView,
  startupView,
  STARTUP_PATH,
  TOKEN_FIELD,
} from "./desktop-startup-pages.js";

/**
 * What the host's own window shows while the application starts
 * (`kernel/specs/desktop-host.md` §5.8): one state, read by the startup window's
 * pages on the host origin and by the `503` of a connection no server can take.
 *
 * - `starting` — the startup view;
 * - `asking` — the kernel asked for inputs: the form, holding a single-use token;
 * - `failed` — the boot-refusal view;
 * - `done` — startup ended: the startup pages are `404`.
 */

type State =
  | { kind: "starting" }
  | {
      kind: "asking";
      token: string;
      inputs: readonly UnresolvedApplicationInput[];
      values: ReadonlyMap<string, string>;
      answer: (answers: ReadonlyMap<string, string> | undefined) => void;
    }
  | { kind: "failed"; diagnostics: string }
  | { kind: "done" };

const MAX_ANSWERS_BYTES = 64 * 1024;
const FORM_TYPE = "application/x-www-form-urlencoded";

export class DesktopStartupFlow {
  private state: State = { kind: "starting" };
  private lastValues: ReadonlyMap<string, string> = new Map();

  constructor(private readonly productName: string) {}

  /** A startup page on the host origin; `undefined` for any other path. `404` once startup ended. */
  page(request: AdmissionRequest): HostResponse | HostBodyRequest | undefined {
    if (request.path !== STARTUP_PATH && request.path !== ANSWERS_PATH) return undefined;
    if (this.state.kind !== "done") {
      if (request.path === STARTUP_PATH && (request.method === "GET" || request.method === "HEAD")) return this.view();
      if (request.path === ANSWERS_PATH && request.method === "POST") return this.answers(request);
    }
    return { status: 404, reason: "Not Found", headers: noStore() };
  }

  /** The `503` body of a connection nothing serves: the refusal once startup failed, else the startup view. */
  unavailable(context: UnavailableContext): UnavailableResponse {
    const html =
      this.state.kind === "failed"
        ? refusalView(this.productName, this.state.diagnostics)
        : context.failure !== undefined
          ? refusalView(this.productName, context.failure instanceof Error ? context.failure.message : String(context.failure))
          : this.state.kind === "done"
            ? notServedView(this.productName)
            : startupView(this.productName);
    return { contentType: "text/html; charset=utf-8", body: html };
  }

  /** The prompter the load asks its missing inputs through: one form for all of them. */
  prompter(): InputPrompter {
    return {
      ask: () => Promise.reject(new Error("the desktop host asks every missing input in one form")),
      askAll: (inputs) => this.ask(inputs),
      // Nothing is saved from a window: there is no env file a person chose.
      confirm: () => Promise.resolve(false),
      say: () => undefined,
    };
  }

  /** The user closed the window while a form waited: the inputs are declined. */
  declineAsk(): void {
    if (this.state.kind !== "asking") return;
    const { answer } = this.state;
    this.state = { kind: "starting" };
    answer(undefined);
  }

  fail(diagnostics: string): void {
    this.declineAsk();
    if (this.state.kind !== "done") this.state = { kind: "failed", diagnostics };
  }

  complete(): void {
    this.declineAsk();
    this.state = { kind: "done" };
  }

  get failed(): boolean {
    return this.state.kind === "failed";
  }

  get asking(): boolean {
    return this.state.kind === "asking";
  }

  get ended(): boolean {
    return this.state.kind === "done";
  }

  private ask(inputs: readonly UnresolvedApplicationInput[]): Promise<ReadonlyMap<string, string> | undefined> {
    return new Promise((resolve) => {
      this.state = { kind: "asking", token: randomBytes(18).toString("base64url"), inputs, values: this.lastValues, answer: resolve };
    });
  }

  private view(): HostResponse {
    const html =
      this.state.kind === "asking"
        ? inputFormView(this.productName, this.state.inputs, this.state.values, this.state.token)
        : this.state.kind === "failed"
          ? refusalView(this.productName, this.state.diagnostics)
          : startupView(this.productName);
    return { status: 200, reason: "OK", headers: [["Content-Type", "text/html; charset=utf-8"], ...noStore()], body: html };
  }

  private answers(request: AdmissionRequest): HostResponse | HostBodyRequest {
    const types = request.headers.get("content-type") ?? [];
    if (types.length !== 1 || types[0].split(";")[0].trim().toLowerCase() !== FORM_TYPE) {
      return { status: 415, reason: "Unsupported Media Type", headers: noStore() };
    }
    return {
      maxBytes: MAX_ANSWERS_BYTES,
      onBody: (body) => {
        this.take(new URLSearchParams(body.toString("utf8")));
        // Whatever the token said, the window goes back to the page that shows the state now.
        return { status: 303, reason: "See Other", headers: [["Location", STARTUP_PATH], ...noStore()] };
      },
    };
  }

  /** Answers a form once: a token that is not the current form's is ignored, which is what a second submission is. */
  private take(form: URLSearchParams): void {
    const state = this.state;
    if (state.kind !== "asking") return;
    const given = form.get(TOKEN_FIELD);
    if (given === null || !sameSecret(given, state.token)) return;
    const answers = new Map<string, string>();
    const values = new Map<string, string>();
    state.inputs.forEach((input, index) => {
      const value = form.get(fieldName(index)) ?? "";
      answers.set(input.id, value);
      if (!input.sensitive) values.set(input.id, value);
    });
    // A refused answer is asked again with these values kept.
    this.lastValues = values;
    this.state = { kind: "starting" };
    state.answer(answers);
  }
}

function noStore(): Array<readonly [string, string]> {
  return [["Cache-Control", "no-store"], ["Referrer-Policy", "no-referrer"]];
}
