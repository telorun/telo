// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { render, wireText, type Rendered } from "./harness.js";
import { address, dataNode, operation } from "./spec-nodes.js";
import { transcriptMarkdown } from "../src/browser/chat/chat-blocks.js";

// The markdown renderer is a chunk fetched on first use; transforming it is slower than a test waits.
await import("../src/browser/markdown/markdown-view.js");

// jsdom has no object URLs; a file's preview is named after it.
const revoked = vi.fn();
const nameObjectUrls = () => Object.assign(URL, { createObjectURL: (blob: Blob) => `blob:${(blob as File).name}`, revokeObjectURL: revoked });
nameObjectUrls();

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const ATTACHMENTS = { accepts: [{ type: "image", mediaTypes: ["image/png"], maxBytes: 1048576 }], maxPerMessage: 2 };

/** A `command` node over the chat's `chat` root. */
const command = (name: string, text: string, button: Record<string, unknown> = { type: "text" }) => ({
  type: "command",
  command: { root: "chat", path: [name] },
  text: wireText(text),
  button,
  fill: false,
});

/** The header `ui` fills when none is written: a bar whose end holds the export command. */
const DEFAULT_HEADER = [{ type: "bar", start: [], center: [], end: [command("exportTranscript", "Export")], fill: false }];

const chat = (spec: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "chat",
  spec,
  basePath: "/api/chat",
  header: DEFAULT_HEADER,
  placeholder: null,
  starters: [],
  show: { reasoning: true, toolDetail: true, usage: true, copy: true },
  buttons: {
    copy: { type: "text" },
    edit: { type: "text" },
    regenerate: { type: "text" },
    attach: { type: "text" },
    send: { type: "text" },
    stop: { type: "text" },
  },
  composer: { actions: "inside" },
  conversation: { parameter: "conversation" },
  refreshes: [],
  ...extra,
});

interface Call {
  method: string;
  path: string;
  search: string;
  headers: Headers;
  body?: any;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json" } });

/** A stream of events as a server writes them: each frame's `id` its position. */
const stream = (...frames: [string, string, Record<string, unknown>][]) =>
  new Response(frames.map(([id, type, data]) => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

/** Wait for what the page does on its own — a stream's events arriving — letting React draw between looks. */
async function eventually(check: () => void, timeout = 3000): Promise<void> {
  const until = Date.now() + timeout;
  for (;;) {
    try {
      return check();
    } catch (error) {
      if (Date.now() > until) throw error;
    }
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 25)));
  }
}

/** A stored entry as the endpoint answers it. */
const entry = (id: string, parent: string | null, role: "user" | "assistant", text: string, extra: Record<string, unknown> = {}) => ({
  id,
  parent,
  turn: "t0",
  siblings: { position: 1, count: 1, previous: null, next: null },
  role,
  parts: [{ type: "text", text }],
  ...extra,
});

/** A branch as pages of it read: newest first. */
const page = (rows: unknown[]) => json({ rows: [...rows].reverse(), total: rows.length, next: null });

/** Links a viewer follows to choose the conversation the page shows. */
const LINKS = [
  { type: "link", text: "to new", href: address("/") },
  { type: "link", text: "to c1", href: address("/", {}, { conversation: { value: "c1" } }) },
  { type: "link", text: "to c2", href: address("/", {}, { conversation: { value: "c2" } }) },
];

/** Follow the link choosing a conversation, or a new one. */
const go = (r: Rendered, id: string | undefined) => r.click(r.parts("link").find((each) => each.textContent === `to ${id ?? "new"}`) as Element);

/** Show a page holding `node`, with the conversation endpoint answered by `handler`. */
async function show(node: unknown, handler: (call: Call) => Response | Promise<Response> | undefined = () => undefined, options: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  rendered = await render({
    path: "/",
    pages: { "/": { title: "Chat", children: [...LINKS, ...(Array.isArray(node) ? node : [node])] as never } },
    answers: {
      "/api/chat": ({ method, url, init }) => {
        const call: Call = {
          method,
          path: url.pathname.slice("/api/chat".length),
          search: url.search,
          headers: new Headers(init?.headers),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        };
        calls.push(call);
        return handler(call) ?? json({ status: 404, code: "ERR_NOT_FOUND", detail: `${call.method} ${call.path}` }, 404);
      },
    },
    ...options,
  });
  return { r: rendered, calls };
}

const textarea = (r: Rendered) => r.container.querySelector<HTMLTextAreaElement>('[data-telo-part="chat-composer"] textarea') as HTMLTextAreaElement;
const say = async (r: Rendered, message: string) => {
  await r.enter(textarea(r), message);
  await r.commit(textarea(r), "enter");
};

describe("what the spec offers", () => {
  it("draws no upload control without attachments, and the stop control only while a reply is written", async () => {
    const { r } = await show(chat({ operations: ["cancel"] }));
    expect(r.parts("chat-composer")).toHaveLength(1);
    for (const part of ["chat-attach", "chat-drop", "chat-stop"]) expect(r.parts(part), part).toEqual([]);
    r.unmount();
    const offered = await show(chat({ attachments: ATTACHMENTS, operations: ["branch", "cancel"] }));
    expect(offered.r.parts("chat-attach")).toHaveLength(1);
    expect(offered.r.parts("chat-stop")).toEqual([]);
  });

  it("names the message box chatMessage in the request's language, whatever the placeholder", async () => {
    const { r } = await show(chat({ operations: [] }, { placeholder: wireText("Zapytaj o cokolwiek", "pl") }), undefined, {
      lang: "pl",
      messages: { chatMessage: wireText("Wiadomość", "pl") },
    });
    expect(textarea(r).getAttribute("aria-label")).toBe("Wiadomość");
    expect(r.part("chat-placeholder").textContent).toBe("Zapytaj o cokolwiek");
    expect(textarea(r).getAttribute("aria-describedby")).toContain(r.part("chat-placeholder").id);
  });
});

describe("the header", () => {
  const stored = (call: Call) => {
    if (call.path === "/conversations/c1") return json({ id: "c1", title: "Quarterly plan", archived: false, turn: "t0", running: false });
    if (call.path === "/conversations/c1/entries") return page([entry("e1", null, "user", "Hi"), entry("e2", "e1", "assistant", "Hello")]);
    return undefined;
  };
  const commandPart = (r: Rendered, name: string) => r.container.querySelector<HTMLButtonElement>(`[data-telo-part="command"][data-command="chat.${name}"]`);

  it("downloads the transcript as Markdown when the export command is pressed, once the transcript holds a message", async () => {
    const created: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => (created.push(blob), "blob:transcript"));
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const clicked: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });
    const { r } = await show(chat({ operations: [] }), stored);
    expect(commandPart(r, "exportTranscript")?.disabled).toBe(true);
    await go(r, "c1");
    await eventually(() => expect(commandPart(r, "exportTranscript")?.disabled).toBe(false));
    await r.click(commandPart(r, "exportTranscript") as Element);
    expect(clicked).toEqual(["conversation.md"]);
    const written = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(created[0]);
    });
    expect(written).toContain("Hello");
    click.mockRestore();
  });

  it("offers stop only where the endpoint cancels, and disables it while no reply is written", async () => {
    const header = [{ type: "bar", start: [], center: [], end: [command("stop", "Stop", { type: "icon", icon: null, label: "hidden" })], fill: false }];
    const without = await show(chat({ operations: [] }, { header }), stored);
    expect(commandPart(without.r, "stop")).toBeNull();
    without.r.unmount();
    const { r } = await show(chat({ operations: ["cancel"] }, { header }), stored);
    const stop = commandPart(r, "stop") as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    expect(stop.getAttribute("aria-label")).toBe("Stop");
    expect(stop.getAttribute("data-button")).toBe("icon");
  });

  it("reads the open conversation's summary, and opens a new conversation by clearing the parameter", async () => {
    const header = [
      {
        type: "bar",
        start: [{ type: "value", value: { root: "conversation", path: ["title"] }, present: { type: ["string", "null"] }, labels: [], style: "heading", fill: false }],
        center: [],
        end: [command("newConversation", "New conversation")],
        fill: false,
      },
    ];
    const { r } = await show(chat({ operations: [] }, { header }), stored);
    expect(commandPart(r, "newConversation")?.disabled).toBe(true);
    await go(r, "c1");
    await eventually(() => expect(r.part("bar-start").textContent).toBe("Quarterly plan"));
    await r.click(commandPart(r, "newConversation") as Element);
    await eventually(() => expect(window.location.search).toBe(""));
    await eventually(() => expect(r.part("bar-start").textContent).toBe(""));
  });

  it("binds conversation to null for a new conversation, and to nothing while an open one's summary is read", async () => {
    const header = [
      {
        type: "bar",
        start: [
          { type: "value", value: { root: "conversation", path: ["title"] }, present: { type: ["string", "null"] }, labels: [], style: "heading", fill: false },
          { type: "text", text: "New conversation", shown: { at: { root: "conversation", path: [] }, matches: { type: "null" } } },
        ],
        center: [],
        end: [],
        fill: false,
      },
    ];
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { r } = await show(chat({ operations: [] }, { header }), (call) =>
      call.path === "/conversations/c1" ? held.then(() => stored(call) as Response) : stored(call),
    );
    // A node a condition hides stays mounted, so what is drawn is read through its wrapper.
    const label = () => [...r.part("bar-start").querySelectorAll<HTMLElement>(":scope > div")].find((each) => each.textContent === "New conversation") as HTMLElement;
    expect(label().style.display).toBe("contents");
    await go(r, "c1");
    await eventually(() => expect(label().style.display).toBe("none"));
    expect(r.part("bar-start").textContent).toBe("New conversation");
    release();
    await eventually(() => expect(r.part("bar-start").textContent).toBe("Quarterly planNew conversation"));
    expect(label().style.display).toBe("none");
  });

  it("is not drawn when it holds no nodes", async () => {
    const { r } = await show(chat({ operations: [] }, { header: [] }));
    expect(r.parts("chat-header")).toEqual([]);
  });
});

describe("the buttons the page configures", () => {
  const stored = (call: Call) => {
    if (call.path === "/conversations/c1") return json({ id: "c1", title: "One", archived: false, turn: "t0", running: false });
    if (call.path === "/conversations/c1/entries") {
      return page([entry("e1", null, "user", "Hi"), entry("e2", "e1", "assistant", "Hello", { parts: [{ type: "text", text: "```js\nlet a;\n```" }] })]);
    }
    return undefined;
  };

  it("draws no message copy button when show.copy is off, and leaves a code block's own copy button", async () => {
    const show_ = { reasoning: true, toolDetail: true, usage: true, copy: false };
    const { r } = await show(chat({ operations: [] }, { show: show_ }), stored);
    await go(r, "c1");
    await eventually(() => expect(r.parts("chat-message")).toHaveLength(2));
    expect(r.parts("chat-copy")).toEqual([]);
    await eventually(() => expect(r.container.textContent).toContain("Copy code"));
  });

  it("makes each message focusable and moves the focus between messages with Page Down and Page Up", async () => {
    const { r } = await show(chat({ operations: [] }), stored);
    await go(r, "c1");
    await eventually(() => expect(r.parts("chat-message")).toHaveLength(2));
    const [first, second] = r.parts("chat-message");
    expect(first.getAttribute("tabindex")).toBe("-1");
    const press = (target: Element, key: string) => act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
    first.focus();
    await press(first, "PageDown");
    expect(document.activeElement).toBe(second);
    await press(second, "PageUp");
    expect(document.activeElement).toBe(first);
  });

  it("draws an icon the page supplies as a glyph served by its digest, its text the button's name and shown beside it on request", async () => {
    const buttons = {
      ...chat({ operations: ["branch"] }).buttons,
      regenerate: { type: "icon", icon: { digest: "dd", name: "mark.svg" }, label: "hidden" },
      edit: { type: "icon", icon: { digest: "dd", name: "mark.svg" }, label: "shown" },
    };
    const { r } = await show(chat({ operations: ["branch"] }, { buttons }), stored);
    await go(r, "c1");
    await eventually(() => expect(r.parts("chat-message")).toHaveLength(2));
    const regenerate = r.part("chat-regenerate");
    expect(regenerate.getAttribute("aria-label")).toBe("Regenerate");
    expect(regenerate.textContent).toBe("");
    expect(regenerate.querySelector<HTMLElement>('[data-telo-part="glyph"]')?.style.getPropertyValue("--ui-react-glyph")).toBe('url("/_telo/ui/assets/dd/mark.svg")');
    const edit = r.part("chat-edit");
    expect(edit.getAttribute("aria-label")).toBeNull();
    expect(edit.textContent).toBe("Edit message");
    expect(edit.querySelector('[data-telo-part="glyph"]')).not.toBeNull();
  });
});

describe("a copy button", () => {
  const stored = (call: Call) => {
    if (call.path === "/conversations/c1") return json({ id: "c1", title: "One", archived: false, turn: "t0", running: false });
    if (call.path === "/conversations/c1/entries") return page([entry("e1", null, "user", "Hi"), entry("e2", "e1", "assistant", "Hello")]);
    return undefined;
  };
  const buttons = { ...chat({ operations: [] }).buttons, copy: { type: "icon", icon: null, label: "hidden" } };
  const announcer = (r: Rendered) => r.part("chat-announcer").textContent;
  afterEach(() => vi.useRealTimers());

  it("draws a check mark named Copied and announces it once, then reverts; a failed copy draws the failure instead", async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { r } = await show(chat({ operations: [] }, { buttons }), stored);
    await go(r, "c1");
    await eventually(() => expect(r.parts("chat-copy")).toHaveLength(2));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const button = () => r.parts("chat-copy")[1];
    expect(button().getAttribute("aria-label")).toBe("Copy message");
    expect(button().querySelector(".lucide-copy")).not.toBeNull();
    await act(async () => button().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(writeText).toHaveBeenCalledWith("Hello");
    expect(button().getAttribute("aria-label")).toBe("Copied");
    expect(button().querySelector(".lucide-check")).not.toBeNull();
    expect(announcer(r)).toBe("Copied");
    await act(async () => void vi.advanceTimersByTime(2000));
    expect(button().getAttribute("aria-label")).toBe("Copy message");
    expect(button().querySelector(".lucide-copy")).not.toBeNull();
    expect(announcer(r)).toBe("");
    await act(async () => button().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(button().getAttribute("aria-label")).toBe("Copy message");
    expect(announcer(r)).toBe("");
    expect(r.container.textContent).toContain("ERR_UI_COPY_FAILED");
  });
});

describe("starters", () => {
  const starters = [
    { prompt: wireText("Say hi"), onChoose: "send" },
    { prompt: wireText("Summarise the attached PDF"), onChoose: "fill" },
  ];

  it("send at once, or only fill the message box, replacing the draft, focused with the caret at the end", async () => {
    const { r, calls } = await show(chat({ operations: [] }, { starters }), (call) => (call.method === "POST" ? json({ conversation: "c1", turn: "t1" }) : undefined));
    await r.enter(textarea(r), "a draft");
    const [, fill] = r.parts("chat-starter");
    await r.click(fill);
    expect(textarea(r).value).toBe("Summarise the attached PDF");
    expect(document.activeElement).toBe(textarea(r));
    expect(textarea(r).selectionStart).toBe("Summarise the attached PDF".length);
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);

    await r.click(r.parts("chat-starter")[0]);
    await eventually(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(1));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ message: "Say hi", attachments: [] });
  });
});

describe("a turn", () => {
  it("draws its events, resumes a dropped stream from the last id, and is resumed by an approval", async () => {
    let events = 0;
    const entries = [
      entry("e1", null, "user", "Hello"),
      entry("e2", "e1", "assistant", "Hello there Done"),
    ];
    const { r, calls } = await show(chat({ operations: ["cancel"] }), (call) => {
      if (call.method === "POST" && call.path === "/turns") return json({ conversation: "c1", turn: `t${calls.filter((each) => each.method === "POST").length}` });
      if (call.path.endsWith("/events")) {
        events += 1;
        if (events === 1) return stream(["1", "reasoning-delta", { text: "Thinking it over" }], ["2", "text-delta", { text: "Hello" }]);
        if (events === 2) {
          return stream(
            ["3", "text-delta", { text: " there" }],
            ["4", "tool-call", { name: "run", id: "call_1", arguments: { cmd: "ls" } }],
            ["5", "approval-request", { id: "a1", toolCallId: "call_1", name: "run", arguments: { cmd: "ls" } }],
            ["6", "turn-end", { reason: "approval" }],
          );
        }
        return stream(["7", "tool-result", { id: "call_1", result: "ok" }], ["8", "text-delta", { text: " Done" }], ["9", "turn-end", { reason: "stop" }]);
      }
      if (call.path === "/conversations/c1/entries") return page(entries);
      return undefined;
    });
    await say(r, "Hello");
    const sent = calls.find((call) => call.method === "POST") as Call;
    expect(sent.body).toEqual({ message: "Hello", attachments: [] });
    expect(sent.headers.get("idempotency-key")).toBeTruthy();

    await eventually(() => expect(r.parts("chat-approval")).toHaveLength(1));
    const eventCalls = calls.filter((call) => call.path.endsWith("/events"));
    expect(eventCalls.map((call) => call.headers.get("last-event-id"))).toEqual([null, "2"]);
    expect(r.part("chat-reasoning")).toBeTruthy();
    expect(r.part("chat-tool-name").textContent).toBe("Tool: run");
    expect(r.part("chat-approval-title").textContent).toBe("Approval needed to run run");
    expect(r.parts("chat-message").at(-1)?.textContent).toContain("Hello there");
    expect(r.part("chat-turn-note").textContent).toBe("Waiting for your approval.");

    await r.enter(r.container.querySelector('[data-telo-part="chat-approval"] input') as Element, "not needed");
    await r.click(r.part("chat-approve"));
    const resumed = calls.filter((call) => call.method === "POST").at(-1) as Call;
    expect(resumed.body).toEqual({ conversation: "c1", message: "", attachments: [], approvals: [{ id: "a1", approved: true }] });
    await eventually(() => expect(r.parts("chat-message").at(-1)?.textContent).toContain("Hello there Done"));
    expect(r.parts("chat-approval")).toEqual([]);
    expect(calls.filter((call) => call.path.endsWith("/events"))).toHaveLength(3);
  });

  it("sends on Enter from a box part that is not a native text area, and not from a button", async () => {
    const { r, calls } = await show(chat({ operations: [] }), (call) => (call.method === "POST" ? json({ conversation: "c1", turn: "t1" }) : undefined));
    await r.enter(textarea(r), "Hello");
    const box = r.part("chat-input");
    const custom = document.createElement("div");
    const button = document.createElement("button");
    box.append(custom, button);
    const press = (target: Element) => act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    await press(button);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    await press(custom);
    await eventually(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(1));
  });

  it("branches an edited message beside its parent", async () => {
    const entries = [
      entry("e1", null, "user", "Hi"),
      entry("e2", "e1", "assistant", "Hello"),
      entry("e3", "e2", "user", "Thanks"),
      entry("e4", "e3", "assistant", "Welcome"),
    ];
    const { r, calls } = await show(chat({ operations: ["branch"] }), (call) => {
      if (call.path === "/conversations/c1") return json({ id: "c1", title: "One", archived: false, turn: "t0", running: false });
      if (call.path === "/conversations/c1/entries") return page(entries);
      if (call.method === "POST") return json({ conversation: "c1", turn: "t1" });
      if (call.path.endsWith("/events")) return stream(["1", "turn-end", { reason: "stop" }]);
      return undefined;
    });
    await go(r, "c1");
    expect(r.parts("chat-edit")).toHaveLength(2);
    await r.click(r.parts("chat-edit")[1]);
    await r.enter(r.container.querySelector('[data-telo-part="chat-edit-form"] textarea') as Element, "Thanks a lot");
    await r.click(r.part("submit"));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ conversation: "c1", parent: "e2", message: "Thanks a lot", attachments: [] });
  });

  it("branches an edited root beside the existing roots with a null parent", async () => {
    const { r, calls } = await show(chat({ operations: ["branch"] }), (call) => {
      if (call.path === "/conversations/c1") return json({ id: "c1", title: "One", archived: false, turn: "t0", running: false });
      if (call.path === "/conversations/c1/entries") return page([entry("e1", null, "user", "Hi"), entry("e2", "e1", "assistant", "Hello")]);
      if (call.method === "POST") return json({ conversation: "c1", turn: "t1" });
      if (call.path.endsWith("/events")) return stream(["1", "turn-end", { reason: "stop" }]);
      return undefined;
    });
    await go(r, "c1");
    await r.click(r.part("chat-edit"));
    await r.enter(r.container.querySelector('[data-telo-part="chat-edit-form"] textarea') as Element, "Hey");
    await r.click(r.part("submit"));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ conversation: "c1", parent: null, message: "Hey", attachments: [] });
  });

  it("shows where a reloaded message stands among its siblings and reads the sibling's branch through it", async () => {
    const { r, calls } = await show(chat({ operations: ["branch"] }), (call) => {
      if (call.path === "/conversations/c1") return json({ id: "c1", title: "One", archived: false, turn: "t0", running: false });
      if (call.path === "/conversations/c1/entries") {
        if (call.search.includes("through=e1c")) return page([entry("e1", null, "user", "Hi"), entry("e1c", "e1", "assistant", "Third")]);
        return page([entry("e1", null, "user", "Hi"), entry("e1b", "e1", "assistant", "Second", { siblings: { position: 2, count: 3, previous: "e1a", next: "e1c" } })]);
      }
      return undefined;
    });
    await go(r, "c1");
    expect(r.part("chat-branch-position").textContent).toBe("2 of 3");
    await r.click(r.part("chat-branch-next"));
    await eventually(() => expect(r.parts("chat-message").at(-1)?.textContent).toContain("Third"));
    expect(calls.filter((call) => call.path.endsWith("/entries")).at(-1)?.search).toContain("through=e1c");
  });

  it("draws a pending approval after a reload and resumes the turn from the entry holding the call", async () => {
    const waiting = entry("e2", "e1", "assistant", "Running it", {
      toolCalls: [{ id: "call_1", name: "run", arguments: { cmd: "ls" }, approval: { id: "a1", decision: null } }],
    });
    const { r, calls } = await show(chat({ operations: ["cancel"] }), (call) => {
      if (call.path === "/conversations/c1") return json({ id: "c1", title: "One", archived: false, turn: "t0", running: false });
      if (call.path === "/conversations/c1/entries") return page([entry("e1", null, "user", "Go"), waiting]);
      if (call.method === "POST") return json({ conversation: "c1", turn: "t1" });
      if (call.path.endsWith("/events")) return stream(["1", "tool-result", { id: "call_1", result: "ok" }], ["2", "text-delta", { text: " Done" }], ["3", "turn-end", { reason: "stop" }]);
      return undefined;
    });
    await go(r, "c1");
    expect(r.parts("chat-approval")).toHaveLength(1);
    await r.click(r.part("chat-approve"));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ conversation: "c1", parent: "e2", message: "", attachments: [], approvals: [{ id: "a1", approved: true }] });
  });

  it("draws a reply stored as an entry of calls, one per result and one answer as one message, each call answered", async () => {
    const stored = [
      entry("e1", null, "user", "Convert it"),
      entry("e2", "e1", "assistant", "", {
        parts: [],
        toolCalls: [
          { id: "call_1", name: "convert", arguments: { to: "PLN" } },
          { id: "call_2", name: "convert", arguments: { to: "USD" } },
        ],
        usage: { inputTokens: 10, outputTokens: 2 },
      }),
      entry("e3", "e2", "assistant", "", { parts: [], toolResults: [{ id: "call_1", result: { amount: 1098 } }] }),
      entry("e4", "e3", "assistant", "", { parts: [], toolResults: [{ id: "call_2", result: "unavailable", isError: true }] }),
      entry("e5", "e4", "assistant", "Done.", { usage: { inputTokens: 20, outputTokens: 5 } }),
    ];
    const { r } = await show(chat({ operations: [] }), (call) => {
      if (call.path === "/conversations/c1") return json({ id: "c1", title: "One", archived: false, turn: "t0", running: false });
      if (call.path === "/conversations/c1/entries") return page(stored);
      return undefined;
    });
    await go(r, "c1");
    await eventually(() => expect(r.parts("chat-message").map((each) => each.getAttribute("data-role"))).toEqual(["user", "assistant"]));
    expect(r.parts("chat-tool").map((each) => each.getAttribute("data-status"))).toEqual(["done", "failed"]);
    expect(r.parts("chat-message").map((each) => each.getAttribute("aria-posinset"))).toEqual(["1", "2"]);
    expect(r.parts("chat-message")[1].textContent).toContain("Done.");
    expect(r.part("chat-usage").textContent).toContain("30");
    const markdown = transcriptMarkdown(stored as never, { user: "You", assistant: "Assistant" }, "/api/chat");
    expect(markdown.match(/## Assistant/g)).toHaveLength(1);
    expect(markdown).toContain('"amount": 1098');
  });

  it("draws a call's arguments each under its name, a text as written with its line breaks and anything nested as JSON", async () => {
    const waiting = entry("e2", "e1", "assistant", "Saving", {
      toolCalls: [{ id: "call_1", name: "save", arguments: { filename: "plan", content: "# Plan\n\n- one", options: { overwrite: true }, retries: 2 }, approval: { id: "a1", decision: null } }],
    });
    const { r } = await show(chat({ operations: ["cancel"] }), (call) => {
      if (call.path === "/conversations/c1") return json({ id: "c1", title: "One", archived: false, turn: "t0", running: false });
      if (call.path === "/conversations/c1/entries") return page([entry("e1", null, "user", "Go"), waiting]);
      return undefined;
    });
    await go(r, "c1");
    const card = r.part("chat-approval");
    const text = (part: string) => [...card.querySelectorAll(`[data-telo-part="${part}"]`)].map((each) => each.textContent);
    expect(text("chat-tool-label")).toEqual(["filename", "content", "options", "retries"]);
    expect(text("chat-tool-data")).toEqual(["plan", "# Plan\n\n- one", '{\n  "overwrite": true\n}', "2"]);
  });

  it("draws an approval as one line: unfolded while it waits, folded once decided, with its state as a glyph at the end", async () => {
    const call = (id: string, approval: Record<string, unknown>) => ({ id, name: "run", arguments: { cmd: id }, approval });
    const stored = entry("e2", "e1", "assistant", "", {
      parts: [],
      toolCalls: [
        call("c1", { id: "a1", decision: null }),
        call("c2", { id: "a2", decision: { approved: true } }),
        call("c3", { id: "a3", decision: { approved: false, reason: "too risky" } }),
      ],
    });
    const { r } = await show(chat({ operations: ["cancel"] }), (request) => {
      if (request.path === "/conversations/c1") return json({ id: "c1", title: "One", archived: false, turn: "t0", running: false });
      if (request.path === "/conversations/c1/entries") return page([entry("e1", null, "user", "Go"), stored]);
      return undefined;
    });
    await go(r, "c1");
    const cards = r.parts("chat-approval");
    const read = (card: Element) => ({
      status: card.getAttribute("data-status"),
      open: card.querySelector('[data-telo-part="chat-approval-toggle"]')?.getAttribute("aria-expanded"),
      data: card.querySelectorAll('[data-telo-part="chat-tool-data"]').length,
      state: card.querySelector('[data-telo-part="chat-approval-state"]')?.getAttribute("aria-label"),
      decision: card.querySelector('[data-telo-part="chat-approval-decision"]')?.textContent ?? null,
    });
    expect(cards.map(read)).toEqual([
      { status: "pending", open: "true", data: 1, state: "Waiting for your approval.", decision: null },
      { status: "approved", open: "false", data: 0, state: "Approved", decision: "Approved" },
      { status: "rejected", open: "false", data: 0, state: "Rejected: too risky", decision: "Rejected: too risky" },
    ]);
    await r.click(cards[1].querySelector('[data-telo-part="chat-approval-toggle"]') as Element);
    expect(read(r.parts("chat-approval")[1])).toMatchObject({ open: "true", data: 1 });
  });

  it("reopens a running turn by setting its entries aside and tailing its events from the start", async () => {
    let tail: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    const frame = (id: string, type: string, data: Record<string, unknown>) => encoder.encode(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    let finished = false;
    const { r, calls } = await show(chat({ operations: ["cancel"] }), (call) => {
      if (call.path === "/conversations/c1") return json({ id: "c1", title: "One", archived: false, turn: "t2", running: !finished });
      if (call.path === "/conversations/c1/entries") {
        const running = (id: string, parent: string | null, role: "user" | "assistant", text: string) => entry(id, parent, role, text, { turn: "t2" });
        return finished
          ? page([entry("e1", null, "user", "Earlier"), entry("e2", "e1", "assistant", "Earlier answer"), running("e3", "e2", "user", "Go on"), running("e4", "e3", "assistant", "Partial text")])
          : page([entry("e1", null, "user", "Earlier"), entry("e2", "e1", "assistant", "Earlier answer"), running("e3", "e2", "user", "Go on"), running("e4", "e3", "assistant", "Partial")]);
      }
      if (call.path === "/turns/t2/events") {
        return new Response(new ReadableStream<Uint8Array>({ start: (controller) => ((tail = controller), controller.enqueue(frame("1", "text-delta", { text: "Partial" }))) }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return undefined;
    });
    await go(r, "c1");
    await eventually(() => expect(r.parts("chat-message").at(-1)?.textContent).toContain("Partial"));
    expect(r.container.textContent?.split("Partial").length).toBe(2);
    expect(r.container.textContent).toContain("Go on");
    expect(calls.filter((call) => call.path === "/turns/t2/events").map((call) => call.headers.get("last-event-id"))).toEqual([null]);
    finished = true;
    await act(async () => {
      tail?.enqueue(frame("2", "text-delta", { text: " text" }));
      tail?.enqueue(frame("3", "turn-end", { reason: "stop" }));
      tail?.close();
    });
    await eventually(() => expect(r.container.textContent).toContain("Partial text"));
    expect(r.container.textContent?.split("Partial text").length).toBe(2);
  });

  it("shows a refused request with its findings, a failed one with its status's code, and a body the contract refuses", async () => {
    let posts = 0;
    const { r } = await show(chat({ operations: [] }), (call) => {
      if (call.method !== "POST") return undefined;
      posts += 1;
      if (posts === 1) {
        return json({ status: 400, code: "ERR_INPUT_INVALID", detail: "Refused.", data: { issues: [{ pointer: "/body/message", keyword: "required", params: { missingProperty: "message" } }] } }, 400);
      }
      if (posts === 2) return new Response(null, { status: 502 });
      return json({ nothing: true });
    });
    await say(r, "Hello");
    expect([r.part("error-code").textContent, r.part("error-message").textContent]).toEqual(["ERR_INPUT_INVALID", "message: Is required"]);
    await r.click(r.part("chat-retry"));
    expect(r.part("error-code").textContent).toBe("ERR_UI_REQUEST_FAILED");
    await r.click(r.part("chat-retry"));
    expect(r.part("error-code").textContent).toBe("ERR_UI_RESPONSE_INVALID");
  });

  it("keeps one idempotency key for a send, Try again included, and a new key for the next send", async () => {
    const { r, calls } = await show(chat({ operations: [] }), (call) => (call.method === "POST" ? new Response(null, { status: 502 }) : undefined));
    await say(r, "Hello");
    await r.click(r.part("chat-retry"));
    await say(r, "Again");
    const keys = calls.filter((call) => call.method === "POST").map((call) => call.headers.get("idempotency-key"));
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});

/** An upload, as the page makes one. */
class FakeUpload {
  static all: FakeUpload[] = [];
  upload: { onprogress?: (event: unknown) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  status = 0;
  statusText = "";
  responseText = "";
  withCredentials = false;
  method = "";
  url = "";
  body?: FormData;
  constructor() {
    FakeUpload.all.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader() {}
  send(body: FormData) {
    this.body = body;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 });
  }
  abort() {
    this.onabort?.();
  }
  answer(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

function file(name: string, type: string, size: number): File {
  const made = new File(["x"], name, { type });
  Object.defineProperty(made, "size", { value: size });
  return made;
}

async function drop(r: Rendered, files: File[]) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files } });
  await act(async () => r.part("chat-composer").dispatchEvent(event));
  await r.settle();
}

describe("attachments", () => {
  it("are checked before any upload, uploaded as multipart with progress, and sent by id", async () => {
    FakeUpload.all = [];
    (globalThis as any).XMLHttpRequest = FakeUpload;
    const { r, calls } = await show(chat({ attachments: ATTACHMENTS, operations: [] }), (call) => {
      if (call.method === "POST" && call.path === "/turns") return json({ conversation: "c1", turn: "t1" });
      if (call.path.endsWith("/events")) return stream(["1", "turn-end", { reason: "stop" }]);
      if (call.path.endsWith("/entries")) return page([]);
      return undefined;
    });
    await drop(r, [file("a.png", "image/png", 10), file("run.exe", "application/x-msdownload", 10), file("huge.png", "image/png", 2 * 1048576), file("b.png", "image/png", 10), file("c.png", "image/png", 10)]);

    expect(r.parts("chat-attachment-refusals")[0].textContent).toMatch(
      /^run\.exe is not an accepted file typehuge\.png is larger than 1\s?MBToo many files\. Limit per message: 2$/,
    );
    expect(FakeUpload.all.map((upload) => [upload.method, upload.url, (upload.body?.get("file") as File).name])).toEqual([
      ["POST", "/api/chat/attachments", "a.png"],
      ["POST", "/api/chat/attachments", "b.png"],
    ]);
    expect(r.parts("chat-attachment-progress").map((each) => each.getAttribute("aria-valuenow"))).toEqual(["25", "25"]);

    await act(async () => {
      FakeUpload.all[0].answer(200, { id: "att_1", mediaType: "image/png", size: 10 });
      FakeUpload.all[1].answer(400, { status: 400, code: "ERR_ATTACHMENT_REFUSED", detail: "Not today." });
    });
    await r.settle();
    expect(r.parts("chat-attachment-item").map((each) => each.getAttribute("data-status"))).toEqual(["done", "failed"]);
    expect(r.part("chat-attachment-problem").textContent).toBe("Uploading b.png failed: Not today.");

    await r.click(r.parts("chat-attachment-remove")[1]);
    await say(r, "See this");
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ message: "See this", attachments: ["att_1"] });
  });
});

describe("pictures", () => {
  beforeEach(() => void nameObjectUrls());
  const media = (id: string, name: string) => ({ type: "image", url: `conversations/c1/attachments/${id}`, mediaType: "image/png", name });
  const stored = (call: Call) => {
    if (call.path === "/conversations/c1") return json({ id: "c1", title: "One", archived: false, turn: "t0", running: false });
    if (call.path === "/conversations/c1/entries") {
      return page([
        entry("e1", null, "user", "Look", { parts: [{ type: "text", text: "Look" }, media("att_1", "a.png")] }),
        entry("e2", "e1", "assistant", "Seen", { parts: [{ type: "text", text: "Seen" }, media("att_2", "b.png"), media("att_3", "c.png")] }),
      ]);
    }
    return undefined;
  };
  const position = (r: Rendered) => r.part("media-viewer-position").textContent;
  const key = (name: string) => act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));

  it("show as a thumbnail from the file the moment it is attached, released when the chip goes", async () => {
    FakeUpload.all = [];
    (globalThis as any).XMLHttpRequest = FakeUpload;
    const { r } = await show(chat({ attachments: ATTACHMENTS, operations: [] }));
    await drop(r, [file("a.png", "image/png", 10)]);
    const thumbnail = r.part("chat-attachment-thumbnail");
    expect([thumbnail.getAttribute("src"), thumbnail.getAttribute("alt")]).toEqual(["blob:a.png", "a.png"]);
    await r.click(r.part("chat-attachment-remove"));
    expect(r.parts("chat-attachment-thumbnail")).toEqual([]);
    expect(revoked).toHaveBeenCalledWith("blob:a.png");
  });

  it("are on the message just sent before its reply ends", async () => {
    FakeUpload.all = [];
    (globalThis as any).XMLHttpRequest = FakeUpload;
    const { r } = await show(chat({ attachments: ATTACHMENTS, operations: [] }), (call) => {
      if (call.method === "POST" && call.path === "/turns") return json({ conversation: "c1", turn: "t1" });
      if (call.path.endsWith("/events")) return new Promise<Response>(() => undefined);
      return undefined;
    });
    await drop(r, [file("a.png", "image/png", 10)]);
    await act(async () => FakeUpload.all[0].answer(200, { id: "att_1", mediaType: "image/png", size: 10 }));
    await r.settle();
    await say(r, "See this");
    const sent = r.parts("chat-image");
    expect(sent.map((each) => [each.getAttribute("src"), each.getAttribute("alt")])).toEqual([["blob:a.png", "a.png"]]);
  });

  it("open a viewer over every picture of the conversation at the one pressed, stepped by buttons and keys, and Escape returns the focus", async () => {
    const { r } = await show(chat({ operations: [] }), stored);
    await go(r, "c1");
    await eventually(() => expect(r.parts("chat-image")).toHaveLength(3));
    expect(r.parts("chat-image").map((each) => each.getAttribute("src"))).toEqual([
      "/api/chat/conversations/c1/attachments/att_1",
      "/api/chat/conversations/c1/attachments/att_2",
      "/api/chat/conversations/c1/attachments/att_3",
    ]);
    const second = r.parts("chat-image")[1];
    await r.click(second);
    expect([position(r), r.part("media-viewer-image").getAttribute("alt")]).toEqual(["2 of 3", "b.png"]);
    await r.click(r.part("media-viewer-next"));
    expect([position(r), r.part("media-viewer-image").getAttribute("src")]).toEqual(["3 of 3", "/api/chat/conversations/c1/attachments/att_3"]);
    await r.click(r.part("media-viewer-next"));
    expect(position(r)).toBe("1 of 3");
    await key("ArrowLeft");
    expect(position(r)).toBe("3 of 3");
    await key("ArrowRight");
    expect(position(r)).toBe("1 of 3");
    expect(r.part("media-viewer-download").getAttribute("href")).toBe("/api/chat/conversations/c1/attachments/att_1");
    await r.escape();
    expect(r.parts("media-viewer")).toEqual([]);
    expect(document.activeElement).toBe(second);
  });

  it("open from a chip over the pictures of that message box", async () => {
    FakeUpload.all = [];
    (globalThis as any).XMLHttpRequest = FakeUpload;
    const { r } = await show(chat({ attachments: ATTACHMENTS, operations: [] }));
    await drop(r, [file("a.png", "image/png", 10), file("b.png", "image/png", 10)]);
    await r.click(r.parts("chat-attachment-thumbnail")[1]);
    expect([position(r), r.part("media-viewer-image").getAttribute("src")]).toEqual(["2 of 2", "blob:b.png"]);
  });
});

describe("editing a message with files", () => {
  const media = (id: string, name: string) => ({ type: "image", url: `/api/chat/conversations/c1/attachments/${id}`, mediaType: "image/png", name });
  const served = (call: Call) => {
    if (call.path === "/conversations/c1") return json({ id: "c1", title: "One", archived: false, turn: "t0", running: false });
    if (call.path === "/conversations/c1/entries") {
      return page([entry("e1", null, "user", "Look", { parts: [{ type: "text", text: "Look" }, media("att_1", "a.png"), media("att_2", "b.png")] }), entry("e2", "e1", "assistant", "Seen")]);
    }
    if (call.method === "POST") return json({ conversation: "c1", turn: "t1" });
    if (call.path.endsWith("/events")) return stream(["1", "turn-end", { reason: "stop" }]);
    return undefined;
  };
  const form = (r: Rendered) => r.container.querySelector('[data-telo-part="chat-edit-form"]') as HTMLElement;
  const within = (r: Rendered, part: string) => [...form(r).querySelectorAll<HTMLElement>(`[data-telo-part="${part}"]`)];
  const posted = (calls: Call[]) => calls.find((call) => call.method === "POST")?.body;

  it("shows the files, removes one and sends the rest", async () => {
    const { r, calls } = await show(chat({ attachments: ATTACHMENTS, operations: ["branch"] }), served);
    await go(r, "c1");
    await r.click(r.part("chat-edit"));
    expect(within(r, "chat-attachment-name").map((each) => each.textContent)).toEqual(["a.png", "b.png"]);
    await r.click(within(r, "chat-attachment-remove")[0]);
    await r.click(r.part("submit"));
    expect(posted(calls)).toEqual({ conversation: "c1", parent: null, message: "Look", attachments: ["att_2"] });
  });

  it("takes a dropped file, waits for its upload and sends it after the kept ones", async () => {
    FakeUpload.all = [];
    (globalThis as any).XMLHttpRequest = FakeUpload;
    const { r, calls } = await show(chat({ attachments: ATTACHMENTS, operations: ["branch"] }), served);
    await go(r, "c1");
    await r.click(r.part("chat-edit"));
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [file("c.png", "image/png", 10), file("d.png", "image/png", 10)] } });
    await act(async () => form(r).dispatchEvent(event));
    await r.settle();
    // Two files are kept, so the limit of two refuses both.
    expect(FakeUpload.all).toHaveLength(0);
    expect(within(r, "chat-attachment-refusals")[0].textContent).toContain("Too many files");
    await r.click(within(r, "chat-attachment-remove")[1]);
    await act(async () => form(r).dispatchEvent(event));
    await r.settle();
    expect(FakeUpload.all).toHaveLength(1);
    expect((r.part("submit") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => FakeUpload.all[0].answer(200, { id: "att_3", mediaType: "image/png", size: 10 }));
    await r.settle();
    expect((r.part("submit") as HTMLButtonElement).disabled).toBe(false);
    await r.click(r.part("submit"));
    expect(posted(calls)).toEqual({ conversation: "c1", parent: null, message: "Look", attachments: ["att_1", "att_3"] });
  });

  it("offers no files where the spec offers no attachments, and resends the ones it has", async () => {
    const { r, calls } = await show(chat({ operations: ["branch"] }), served);
    await go(r, "c1");
    await r.click(r.part("chat-edit"));
    expect([within(r, "chat-attach"), within(r, "chat-attachments")]).toEqual([[], []]);
    await r.click(r.part("submit"));
    expect(posted(calls)).toEqual({ conversation: "c1", parent: null, message: "Look", attachments: ["att_1", "att_2"] });
  });
});

describe("a transcript's images", () => {
  it("are drawn only from app-relative addresses; any other origin is its alt text", async () => {
    const text = "![kept](/api/chat/attachments/a) ![remote](https://evil.example/p.png)";
    const { r } = await show(chat({ operations: [] }), (call) => {
      if (call.path === "/conversations/c1") return json({ id: "c1", title: "One", archived: false, turn: "t0", running: false });
      if (call.path === "/conversations/c1/entries") return page([entry("e1", null, "assistant", text)]);
      return undefined;
    });
    await go(r, "c1");
    await eventually(() => expect(r.parts("markdown-image")).toHaveLength(1));
    expect(r.part("markdown-image").getAttribute("src")).toBe("/api/chat/attachments/a");
    expect(r.part("chat-message-body").textContent).toContain("remote");
  });
});

describe("an attachment reference relative to the endpoint", () => {
  const media = { type: "image", url: "conversations/c1/attachments/att_1", mediaType: "image/png", name: "dot.png" };

  it("is drawn from the source's basePath", async () => {
    const { r } = await show(chat({ operations: [] }), (call) => {
      if (call.path === "/conversations/c1") return json({ id: "c1", title: "One", archived: false, turn: "t0", running: false });
      if (call.path === "/conversations/c1/entries") return page([entry("e1", null, "user", "look", { parts: [{ type: "text", text: "look" }, media] })]);
      return undefined;
    });
    await go(r, "c1");
    await eventually(() => expect(r.parts("chat-image")).toHaveLength(1));
    expect(r.part("chat-image").getAttribute("src")).toBe("/api/chat/conversations/c1/attachments/att_1");
  });

  it("is exported under the basePath, a rooted address as it is", () => {
    const markdown = transcriptMarkdown(
      [entry("e1", null, "user", "look", { parts: [media, { ...media, type: "file", url: "/api/chat/conversations/c1/attachments/att_2", name: "a.pdf" }] }) as never],
      { user: "You", assistant: "Assistant" },
      "/api/chat/",
    );
    expect(markdown).toContain("![dot.png](/api/chat/conversations/c1/attachments/att_1)");
    expect(markdown).toContain("[a.pdf](/api/chat/conversations/c1/attachments/att_2)");
  });
});

const conversation = (id: string, title: string, running = false, turn = "t0") => ({ id, title, archived: false, updatedAt: "2026-11-01T10:00:00Z", turn, running });

interface World {
  summaries: Record<string, ReturnType<typeof conversation>>;
  entries: Record<string, unknown[]>;
  /** Answers asked before the conversations are. */
  first?: (call: Call) => Response | Promise<Response> | undefined;
}

/** The endpoint of conversations `summaries`, whose state a test changes as it goes. */
const served = (world: World) => (call: Call) => {
  const given = world.first?.(call);
  if (given) return given;
  const match = call.path.match(/^\/conversations\/([^/]+)(\/entries)?$/);
  if (match) return match[2] ? page(world.entries[match[1]] ?? []) : json(world.summaries[match[1]]);
  return undefined;
};

const deferred = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => (resolve = done));
  return { promise, resolve };
};

/** A turn's event stream a test writes to as the server would. */
function tail() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  return {
    response: () =>
      new Response(new ReadableStream<Uint8Array>({ start: (started) => (controller = started) }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    push: (id: string, type: string, data: Record<string, unknown>) => controller.enqueue(encoder.encode(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)),
    close: () => controller.close(),
  };
}

const quiet = (ms = 100) => act(async () => await new Promise((resolve) => setTimeout(resolve, ms)));

const pixels = (value: string) => Number.parseFloat(value) || 0;
const bodyText = (message: Element) => message.querySelector('[data-telo-part="chat-message-body"]')?.textContent ?? "";

/**
 * For one test, the layout jsdom does not do: the transcript a viewport `viewport` pixels tall with no padding
 * and no gap, each message as tall as `height` says, the transcript's `loading` notice 20 pixels and every other
 * part nothing, a message's inline block margins counted; `scrollTop` is held within the content and announced
 * by a scroll event, and each size observer reports on observing and on `resize()`.
 */
function laidOut(height: (message: HTMLElement) => number = () => 100, viewport = 400) {
  const observers = new Set<FakeObserver>();
  const part = (element: Element) => element.getAttribute("data-telo-part");
  const isTranscript = (element: Element) => part(element) === "chat-transcript";
  const own = (element: HTMLElement): number =>
    part(element) === "chat-message" ? height(element) : part(element) === "loading" && element.parentElement && isTranscript(element.parentElement) ? 20 : 0;
  const outer = (element: HTMLElement) => own(element) + pixels(element.style.marginTop) + pixels(element.style.marginBottom);
  const content = (element: Element) => [...element.children].reduce((sum, child) => sum + outer(child as HTMLElement), 0);
  const maxTop = (element: Element) => Math.max(0, content(element) - viewport);
  const entryOf = (target: Element) => {
    const size = (target as HTMLElement).offsetHeight;
    return { target, borderBoxSize: [{ blockSize: size, inlineSize: 0 }], contentBoxSize: [{ blockSize: size, inlineSize: 0 }], contentRect: { height: size, width: 0 } };
  };
  class FakeObserver {
    readonly targets = new Set<Element>();
    constructor(private readonly callback: (entries: unknown[], observer: unknown) => void) {
      observers.add(this);
    }
    observe(target: Element) {
      this.targets.add(target);
      setTimeout(() => this.report([target]));
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
      observers.delete(this);
    }
    report(targets: Element[]) {
      const observed = targets.filter((target) => this.targets.has(target) && target.isConnected);
      if (observed.length > 0) this.callback(observed.map(entryOf), this);
    }
  }
  const tops = new WeakMap<Element, number>();
  const prototype = HTMLElement.prototype;
  const names = ["offsetHeight", "clientHeight", "scrollHeight", "scrollTop", "scrollTo"];
  const saved = names.map((name) => Object.getOwnPropertyDescriptor(prototype, name));
  Object.defineProperties(prototype, {
    offsetHeight: { configurable: true, get: function (this: HTMLElement) { return isTranscript(this) ? viewport : own(this); } },
    clientHeight: { configurable: true, get: function (this: HTMLElement) { return isTranscript(this) ? viewport : 0; } },
    scrollHeight: { configurable: true, get: function (this: HTMLElement) { return isTranscript(this) ? Math.max(viewport, content(this)) : 0; } },
    scrollTop: {
      configurable: true,
      get: function (this: HTMLElement) { return Math.min(tops.get(this) ?? 0, maxTop(this)); },
      set: function (this: HTMLElement, value: number) {
        const before = this.scrollTop;
        tops.set(this, Math.max(0, Math.min(value, maxTop(this))));
        if (this.scrollTop !== before) setTimeout(() => this.dispatchEvent(new Event("scroll")));
      },
    },
    scrollTo: {
      configurable: true,
      value: function (this: HTMLElement, options: { top?: number }) {
        if (options.top !== undefined) this.scrollTop = options.top;
      },
    },
  });
  const scope = [globalThis, window] as { ResizeObserver?: unknown }[];
  const observerBefore = scope.map((each) => each.ResizeObserver);
  for (const each of scope) each.ResizeObserver = FakeObserver;
  onTestFinished(() => {
    names.forEach((name, at) => {
      const descriptor = saved[at];
      if (descriptor) Object.defineProperty(prototype, name, descriptor);
      else delete (prototype as unknown as Record<string, unknown>)[name];
    });
    scope.forEach((each, at) => (each.ResizeObserver = observerBefore[at]));
  });
  const transcript = () => document.querySelector('[data-telo-part="chat-transcript"]') as HTMLElement;
  return {
    transcript,
    atEnd: () => transcript().scrollTop === maxTop(transcript()) && maxTop(transcript()) > 0,
    /** Where a drawn message's top is, from the top of the viewport. */
    topOf(message: Element): number {
      let at = 0;
      for (const child of transcript().children) {
        if (child === message) return at + pixels((child as HTMLElement).style.marginTop) - transcript().scrollTop;
        at += outer(child as HTMLElement);
      }
      throw new Error("the message is not drawn");
    },
    /** Every observed element reports its size again. */
    resize: () => act(async () => {
      for (const observer of observers) observer.report([...observer.targets]);
    }),
    /** The viewer scrolls the transcript to `top`. */
    scrollTo: (top: number) =>
      act(async () => {
        transcript().scrollTop = top;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }),
  };
}

/** `count` stored entries from `from` on, users and assistants by turns, one after another. */
const conversationOf = (count: number, from = 0) =>
  Array.from({ length: count }, (_, at) => {
    const n = from + at;
    return entry(`m${n}`, n === 0 ? null : `m${n - 1}`, n % 2 === 0 ? "user" : "assistant", `Message ${n}.`);
  });

const messageWith = (r: Rendered, text: string) => r.parts("chat-message").find((each) => bodyText(each) === text) as HTMLElement;

describe("parallel conversations", () => {
  it("keeps the conversation shown when a send starts after a switch, and tails that turn when its conversation is opened again", async () => {
    const start = deferred();
    const world: World = {
      summaries: { c1: conversation("c1", "One"), c2: conversation("c2", "Two") },
      entries: { c1: [entry("a1", null, "user", "A question")], c2: [entry("b1", null, "user", "B text")] },
      first: (call) => {
        if (call.method === "POST" && call.path === "/turns") return start.promise;
        if (call.path === "/turns/t9/events") return stream(["1", "text-delta", { text: "Tail" }], ["2", "turn-end", { reason: "stop" }]);
        return undefined;
      },
    };
    const { r, calls } = await show(chat({ operations: [] }), served(world));
    await go(r, "c1");
    await eventually(() => expect(r.container.textContent).toContain("A question"));
    await say(r, "A follow-up");
    await go(r, "c2");
    await eventually(() => expect(r.container.textContent).toContain("B text"));

    world.summaries.c1 = conversation("c1", "One", true, "t9");
    await act(async () => start.resolve(json({ conversation: "c1", turn: "t9" })));
    await r.settle();
    expect(r.container.textContent).toContain("B text");
    expect(r.container.textContent).not.toContain("A follow-up");
    expect(window.location.search).toBe("?conversation=c2");
    // A body-less watch reads the turn's events while its conversation is not shown.
    await eventually(() => expect(calls.filter((call) => call.path === "/turns/t9/events")).toHaveLength(1));
    expect(calls.some((call) => call.path.endsWith("/cancel"))).toBe(false);

    await go(r, "c1");
    await eventually(() => expect(calls.filter((call) => call.path === "/turns/t9/events")).toHaveLength(2));
  });

  it.each([
    ["is read late", () => page([entry("a9", null, "user", "A late branch")])],
    ["fails late", () => json({ status: 400, code: "ERR_LATE", detail: "Too late." }, 400)],
  ])("leaves the view alone when the branch an ended turn re-reads %s after a switch", async (_name, late) => {
    const held = deferred();
    const events = tail();
    let ending = false;
    const world: World = {
      summaries: { c1: conversation("c1", "One", true, "t2"), c2: conversation("c2", "Two") },
      entries: { c1: [entry("a1", null, "user", "A question")], c2: [entry("b1", null, "user", "B text")] },
      first: (call) => {
        if (call.path === "/turns/t2/events") return events.response();
        if (ending && call.path === "/conversations/c1/entries") return held.promise;
        return undefined;
      },
    };
    const { r, calls } = await show(chat({ operations: [] }), served(world));
    await go(r, "c1");
    await eventually(() => expect(calls.some((call) => call.path === "/turns/t2/events")).toBe(true));
    ending = true;
    await act(async () => (events.push("1", "turn-end", { reason: "stop" }), events.close()));
    await eventually(() => expect(calls.filter((call) => call.path === "/conversations/c1/entries")).toHaveLength(2));
    await go(r, "c2");
    await eventually(() => expect(r.container.textContent).toContain("B text"));

    await act(async () => held.resolve(late()));
    await r.settle();
    expect(r.container.textContent).toContain("B text");
    expect(r.container.textContent).not.toContain("A late branch");
    expect(r.container.textContent).not.toContain("ERR_LATE");
    expect(r.parts("chat-retry")).toHaveLength(0);
  });

  it("does not prepend an earlier page of the conversation left to the one shown", async () => {
    const older = deferred();
    const world: World = {
      summaries: { c1: conversation("c1", "One"), c2: conversation("c2", "Two") },
      entries: { c2: [entry("b1", null, "user", "B text")] },
      first: (call) => {
        if (call.path !== "/conversations/c1/entries") return undefined;
        return call.search.includes("cursor=") ? older.promise : json({ rows: [entry("a2", "a1", "assistant", "A answer")], total: 2, next: "older" });
      },
    };
    laidOut();
    const { r, calls } = await show(chat({ operations: [] }), served(world));
    await go(r, "c1");
    // One message leaves the viewport unfilled, so the earlier page is read at once.
    await eventually(() => expect(calls.some((call) => call.search.includes("cursor="))).toBe(true));
    await go(r, "c2");
    await eventually(() => expect(r.container.textContent).toContain("B text"));

    await act(async () => older.resolve(json({ rows: [entry("a1", null, "user", "A first")], total: 2, next: null })));
    await r.settle();
    expect(r.container.textContent).toContain("B text");
    expect(r.container.textContent).not.toContain("A first");
    expect(r.parts("loading")).toHaveLength(0);
  });

  it("draws no frame of a stream that was closed by a switch, even one already on its way", async () => {
    const one = tail();
    const two = tail();
    const world: World = {
      summaries: { c1: conversation("c1", "One", true, "t1"), c2: conversation("c2", "Two", true, "t2") },
      entries: {},
      first: (call) => (call.path === "/turns/t1/events" ? one.response() : call.path === "/turns/t2/events" ? two.response() : undefined),
    };
    const { r, calls } = await show(chat({ operations: [] }), served(world));
    await go(r, "c1");
    await eventually(() => expect(calls.some((call) => call.path === "/turns/t1/events")).toBe(true));
    await act(async () => one.push("1", "text-delta", { text: "A live" }));
    await eventually(() => expect(r.container.textContent).toContain("A live"));
    await go(r, "c2");
    await eventually(() => expect(calls.some((call) => call.path === "/turns/t2/events")).toBe(true));
    await act(async () => two.push("1", "text-delta", { text: "B live" }));
    await eventually(() => expect(r.container.textContent).toContain("B live"));

    await act(async () => one.push("2", "text-delta", { text: " LEAKED" }));
    await quiet();
    expect(r.container.textContent).not.toContain("LEAKED");
    expect(r.container.textContent).not.toContain("A live");
    await act(async () => two.push("2", "text-delta", { text: " more" }));
    await eventually(() => expect(r.container.textContent).toContain("B live more"));
  });

  it("keeps the text and the attachments of a draft with its conversation across switches, an upload landing where it began", async () => {
    FakeUpload.all = [];
    (globalThis as any).XMLHttpRequest = FakeUpload;
    const world: World = {
      summaries: { c1: conversation("c1", "One"), c2: conversation("c2", "Two") },
      entries: {},
      first: (call) => {
        if (call.method === "POST" && call.path === "/turns") return json({ conversation: "c1", turn: "t1" });
        if (call.path === "/turns/t1/events") return stream(["1", "turn-end", { reason: "stop" }]);
        return undefined;
      },
    };
    const { r, calls } = await show(chat({ attachments: ATTACHMENTS, operations: [] }), served(world));
    await go(r, "c1");
    await r.enter(textarea(r), "draft A");
    await drop(r, [file("a.png", "image/png", 10)]);
    expect(r.parts("chat-attachment-item")).toHaveLength(1);

    await go(r, "c2");
    expect(textarea(r).value).toBe("");
    expect(r.parts("chat-attachment-item")).toHaveLength(0);
    await r.enter(textarea(r), "draft B");
    await act(async () => FakeUpload.all[0].answer(200, { id: "att_1", mediaType: "image/png", size: 10 }));
    await r.settle();
    expect(r.parts("chat-attachment-item")).toHaveLength(0);

    await go(r, "c1");
    expect(textarea(r).value).toBe("draft A");
    expect(r.parts("chat-attachment-item").map((each) => each.getAttribute("data-status"))).toEqual(["done"]);
    await go(r, "c2");
    expect(textarea(r).value).toBe("draft B");

    await go(r, "c1");
    await r.commit(textarea(r), "enter");
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ conversation: "c1", message: "draft A", attachments: ["att_1"] });
  });
});

const empty = { type: "object", properties: {} };

describe("the chat follows the page", () => {
  it("writes a conversation it creates into the address by replacing the entry, and does not open it again", async () => {
    const { r, calls } = await show(chat({ operations: [] }), (call) => {
      if (call.method === "POST") return json({ conversation: "c1", turn: "t1" });
      if (call.path.endsWith("/events")) return stream(["1", "turn-end", { reason: "stop" }]);
      if (call.path === "/conversations/c1") return json({ id: "c1", title: null, archived: false, updatedAt: "2026-11-01T10:00:00Z", turn: "t1", running: false });
      if (call.path === "/conversations/c1/entries") return page([entry("e1", null, "user", "Hi")]);
      return undefined;
    });
    const entries = window.history.length;
    await say(r, "Hi");
    await eventually(() => expect(window.location.search).toBe("?conversation=c1"));
    await eventually(() => expect(r.parts("chat-message")).toHaveLength(1));
    expect(window.history.length).toBe(entries);
    // Its record is read for the header when the turn starts and when it ends; its branch once, after the turn.
    await eventually(() => expect(calls.filter((call) => call.path === "/conversations/c1")).toHaveLength(2));
    expect(calls.filter((call) => call.path === "/conversations/c1/entries")).toHaveLength(1);
  });

  it("switches conversation when the parameter changes by a link, back and forward", async () => {
    const world: World = {
      summaries: { c1: conversation("c1", "One"), c2: conversation("c2", "Two") },
      entries: { c1: [entry("a1", null, "user", "A text")], c2: [entry("b1", null, "user", "B text")] },
    };
    const { r } = await show(chat({ operations: [] }), served(world), { path: "/?conversation=c1" });
    await eventually(() => expect(r.container.textContent).toContain("A text"));
    await go(r, "c2");
    await eventually(() => expect(r.container.textContent).toContain("B text"));
    await r.traverse(-1);
    await eventually(() => expect(r.container.textContent).toContain("A text"));
    expect(r.container.textContent).not.toContain("B text");
    await go(r, undefined);
    await eventually(() => expect(r.parts("chat-message")).toEqual([]));
    expect(window.location.search).toBe("");
  });

  it("draws a conversation that is not found in place, keeps the address and takes no message", async () => {
    const { r } = await show(chat({ operations: [] }), (call) =>
      call.path === "/conversations/cnv_missing" ? json({ status: 404, code: "ERR_CONVERSATION_NOT_FOUND", detail: "No conversation has the id cnv_missing." }, 404) : undefined,
    { path: "/?conversation=cnv_missing" });
    await eventually(() => expect(r.parts("error-code").map((each) => each.textContent)).toEqual(["ERR_CONVERSATION_NOT_FOUND"]));
    expect(r.part("error-message").textContent).toBe("No conversation has the id cnv_missing.");
    expect(window.location.search).toBe("?conversation=cnv_missing");
    await r.enter(textarea(r), "Hello");
    expect((r.part("chat-send") as HTMLButtonElement).disabled).toBe(true);
  });

  it("reads the shown conversation again when it is written, and draws it not found once it is deleted", async () => {
    let title = "One";
    let deleted = false;
    const bare = (label: string, method: string) =>
      operation("/api/chat/conversations/c1", label, empty, { request: { method, target: address("/api/chat/conversations/c1"), consumed: [] } });
    const { r, calls } = await show(
      [bare("Rename", "PATCH"), bare("Delete", "DELETE"), chat({ operations: [] })],
      (call) => {
        if (call.method === "PATCH") return ((title = "Two"), new Response(null, { status: 204 }));
        if (call.method === "DELETE") return ((deleted = true), new Response(null, { status: 204 }));
        if (call.path === "/conversations/c1") {
          return deleted ? json({ status: 404, code: "ERR_CONVERSATION_NOT_FOUND", detail: "Gone." }, 404) : json({ id: "c1", title, archived: false, turn: "t0", running: false });
        }
        if (call.path === "/conversations/c1/entries") return page([entry("e1", null, "user", "Hi")]);
        return undefined;
      },
      { path: "/?conversation=c1" },
    );
    await eventually(() => expect(r.parts("chat-message")).toHaveLength(1));
    const reads = () => calls.filter((call) => call.method === "GET" && call.path === "/conversations/c1").length;
    expect(reads()).toBe(1);
    await r.click(r.parts("submit")[0]);
    await eventually(() => expect(reads()).toBe(2));
    await r.click(r.parts("submit")[1]);
    await eventually(() => expect(r.parts("error-code").map((each) => each.textContent)).toContain("ERR_CONVERSATION_NOT_FOUND"));
    expect(window.location.search).toBe("?conversation=c1");
  });

  it("keeps the shown transcript drawn while it reads the conversation again after a write", async () => {
    const held = deferred();
    let reads = 0;
    const rename = operation("/api/chat/conversations/c1", "Rename", empty, { request: { method: "PATCH", target: address("/api/chat/conversations/c1"), consumed: [] } });
    const { r } = await show(
      [rename, chat({ operations: [] })],
      (call) => {
        if (call.method === "PATCH") return new Response(null, { status: 204 });
        if (call.path === "/conversations/c1") return ++reads === 1 ? json(conversation("c1", "One")) : held.promise;
        if (call.path === "/conversations/c1/entries") return page([entry("e1", null, "user", "Hi")]);
        return undefined;
      },
      { path: "/?conversation=c1" },
    );
    await eventually(() => expect(r.parts("chat-message")).toHaveLength(1));
    await r.click(r.parts("submit")[0]);
    await eventually(() => expect(reads).toBe(2));
    expect(r.parts("chat-message")).toHaveLength(1);
    await act(async () => held.resolve(json(conversation("c1", "Two"))));
    await r.settle();
    expect(r.parts("chat-message")).toHaveLength(1);
  });

  it("announces the end of a turn whose conversation was switched away from", async () => {
    const events = tail();
    const world: World = {
      summaries: { c1: conversation("c1", "One"), c2: conversation("c2", "Two") },
      entries: { c1: [entry("a1", null, "user", "A text")], c2: [entry("b1", null, "user", "B text")] },
      first: (call) => {
        if (call.method === "POST") return json({ conversation: "c1", turn: "t1" });
        if (call.path === "/turns/t1/events") return events.response();
        if (call.path === "/conversations") return json({ authorized: true });
        return undefined;
      },
    };
    const { r, calls } = await show([dataNode({ source: address("/api/chat/conversations") }), chat({ operations: [] }, { refreshes: [address("/api/chat/conversations")] })], served(world), {
      path: "/?conversation=c1",
    });
    const reads = () => calls.filter((call) => call.method === "GET" && call.path === "/conversations").length;
    await eventually(() => expect(r.container.textContent).toContain("A text"));
    await say(r, "Go");
    await eventually(() => expect(reads()).toBe(2));
    await go(r, "c2");
    await eventually(() => expect(r.container.textContent).toContain("B text"));
    await act(async () => (events.push("1", "turn-end", { reason: "stop" }), events.close()));
    await eventually(() => expect(reads()).toBe(3));
  });

  it("notifies its refreshes, over the conversation's id, when a send is admitted and when its turn ends", async () => {
    const events = tail();
    const readers = [dataNode({ source: address("/api/chat/conversations") }), dataNode({ source: address("/api/chat/conversations/c1") })];
    const refreshes = [address("/api/chat/conversations"), address("/api/chat/conversations/{id}", { id: { root: "conversation", path: ["id"] } })];
    const { r, calls } = await show(
      [...readers, chat({ operations: [] }, { refreshes })],
      (call) => {
        if (call.method === "POST") return json({ conversation: "c1", turn: "t1" });
        if (call.path === "/turns/t1/events") return events.response();
        if (call.path === "/conversations" || call.path === "/conversations/c1") return json({ authorized: true });
        if (call.path === "/conversations/c1/entries") return page([entry("e1", null, "user", "Hi")]);
        return undefined;
      },
    );
    const reads = (path: string) => calls.filter((call) => call.method === "GET" && call.path === path).length;
    expect([reads("/conversations"), reads("/conversations/c1")]).toEqual([1, 1]);
    await say(r, "Hi");
    // The record is read by its reader and, for the header, by the chat itself, when the turn starts and when it ends.
    await eventually(() => expect([reads("/conversations"), reads("/conversations/c1")]).toEqual([2, 3]));
    await act(async () => (events.push("1", "turn-end", { reason: "stop" }), events.close()));
    await eventually(() => expect([reads("/conversations"), reads("/conversations/c1")]).toEqual([3, 5]));
  });
});

describe("a long transcript", () => {
  const one = (entries: unknown[], first?: World["first"]): World => ({ summaries: { c1: conversation("c1", "One") }, entries: { c1: entries }, first });

  it("draws only the messages near its viewport, each with its place in the conversation", async () => {
    laidOut();
    const { r } = await show(chat({ operations: [] }), served(one(conversationOf(200))));
    await go(r, "c1");
    await eventually(() => expect(r.container.textContent).toContain("Message 199."));
    const drawn = r.parts("chat-message");
    expect(drawn.length).toBeLessThan(20);
    expect(r.container.textContent).not.toContain("Message 0.");
    expect(drawn.map((each) => [each.getAttribute("aria-posinset"), each.getAttribute("aria-setsize")])).toEqual(
      drawn.map((_, at) => [String(200 - drawn.length + 1 + at), "200"]),
    );
  });

  it("opens at its end and stays there as a message drawn grows", async () => {
    const heights = new Map<string, number>();
    const layout = laidOut((message) => heights.get(bodyText(message)) ?? 100);
    const { r } = await show(chat({ operations: [] }), served(one(conversationOf(10))));
    await go(r, "c1");
    await eventually(() => expect(layout.transcript().scrollTop).toBe(600));
    heights.set("Message 9.", 300);
    await layout.resize();
    await eventually(() => expect(layout.transcript().scrollTop).toBe(800));
    expect(layout.atEnd()).toBe(true);
  });

  it("reads the earlier page as the viewer nears the top, the message in view staying where it was", async () => {
    const layout = laidOut();
    const older = deferred();
    const pages = (call: Call) => {
      if (call.path !== "/conversations/c1/entries") return undefined;
      return call.search.includes("cursor=") ? older.promise : json({ rows: conversationOf(30, 20).reverse(), total: 50, next: "older" });
    };
    const { r, calls } = await show(chat({ operations: [] }), served(one([], pages)));
    const earlier = () => calls.filter((call) => call.search.includes("cursor="));
    await go(r, "c1");
    await eventually(() => expect(layout.atEnd()).toBe(true));
    await quiet();
    expect(earlier()).toHaveLength(0);

    await layout.scrollTo(150);
    await eventually(() => expect(earlier()).toHaveLength(1));
    await eventually(() => expect(r.parts("loading")).toHaveLength(1));
    await quiet();
    const offset = layout.topOf(messageWith(r, "Message 21."));

    await act(async () => older.resolve(json({ rows: conversationOf(20).reverse(), total: 50, next: null })));
    await eventually(() => expect(r.parts("loading")).toHaveLength(0));
    await quiet();
    const kept = messageWith(r, "Message 21.");
    expect(layout.topOf(kept)).toBe(offset);
    expect([kept.getAttribute("aria-posinset"), kept.getAttribute("aria-setsize")]).toEqual(["22", "50"]);
    expect(earlier()).toHaveLength(1);
  });

  it("keeps a message being edited drawn, with what was typed, while it is scrolled out of view", async () => {
    const layout = laidOut();
    const { r } = await show(chat({ operations: ["branch"] }), served(one(conversationOf(40))));
    await go(r, "c1");
    await eventually(() => expect(r.container.textContent).toContain("Message 39."));
    const edits = r.parts("chat-edit");
    await r.click(edits[edits.length - 1]);
    const box = () => r.part("chat-edit-form").querySelector("textarea") as HTMLTextAreaElement;
    await r.enter(box(), "Rewritten");

    await layout.scrollTo(0);
    await eventually(() => expect(r.container.textContent).toContain("Message 0."));
    expect(r.container.textContent).not.toContain("Message 30.");
    expect(r.parts("chat-edit-form")).toHaveLength(1);
    expect(box().value).toBe("Rewritten");
  });

  it("opens a tool call's panel again when its message is drawn again", async () => {
    const layout = laidOut();
    const entries = conversationOf(40);
    entries[39] = entry("m39", "m38", "assistant", "Message 39.", { toolCalls: [{ id: "call_1", name: "search", arguments: { q: "plan" } }], toolResults: [{ id: "call_1", result: { hits: 2 } }] });
    const { r } = await show(chat({ operations: [] }), served(one(entries)));
    await go(r, "c1");
    await eventually(() => expect(r.parts("chat-tool-toggle")).toHaveLength(1));
    await r.click(r.part("chat-tool-toggle"));
    expect(r.parts("chat-tool-detail")).toHaveLength(1);

    await layout.scrollTo(0);
    await eventually(() => expect(r.parts("chat-tool")).toHaveLength(0));
    // Messages measured on the way down are shorter than estimated, so the end is reached in more than one move.
    for (let moves = 0; moves < 10 && !messageWith(r, "Message 39."); moves++) {
      await layout.scrollTo(layout.transcript().scrollHeight);
      await quiet(50);
    }
    expect(r.parts("chat-tool-detail")).toHaveLength(1);
  });
});
