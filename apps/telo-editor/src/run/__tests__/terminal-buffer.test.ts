import { describe, expect, it } from "vitest";

import { TerminalBuffer } from "../terminal-buffer";
import type { RunIo, RunIoHandlers } from "../types";

function makeFakeIo() {
  let handlers: RunIoHandlers | null = null;
  let openCount = 0;
  let closed = false;
  const sent: Uint8Array[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];

  const io: RunIo = {
    open(h) {
      openCount += 1;
      handlers = h;
      return {
        send: (b) => sent.push(b),
        resize: (cols, rows) => resizes.push({ cols, rows }),
        close: () => {
          closed = true;
        },
      };
    },
  };

  return {
    io,
    push: (b: Uint8Array) => handlers?.onData(b),
    end: () => handlers?.onClose({ code: 1000, clean: true }),
    sent,
    resizes,
    get openCount() {
      return openCount;
    },
    get closed() {
      return closed;
    },
  };
}

const enc = (s: string) => new TextEncoder().encode(s);
function collect() {
  const chunks: Uint8Array[] = [];
  const onData = (b: Uint8Array) => chunks.push(b);
  const text = () => chunks.map((c) => new TextDecoder().decode(c)).join("");
  return { onData, text };
}

describe("TerminalBuffer", () => {
  it("replays the recorded transcript when a terminal attaches", () => {
    const fake = makeFakeIo();
    const buffer = new TerminalBuffer(fake.io);
    fake.push(enc("hello "));
    fake.push(enc("world"));

    const sink = collect();
    buffer.attach(sink.onData);
    expect(sink.text()).toBe("hello world");
  });

  it("opens the transport exactly once across repeated attaches", () => {
    // Regression: the old RunIo.open() was single-shot and threw on re-mount.
    // The buffer owns the one open(); attaching is always safe and replays.
    const fake = makeFakeIo();
    const buffer = new TerminalBuffer(fake.io);
    fake.push(enc("abc"));

    const first = collect();
    const detach = first.onData;
    const detachFn = buffer.attach(detach);
    detachFn();

    const second = collect();
    expect(() => buffer.attach(second.onData)).not.toThrow();
    expect(fake.openCount).toBe(1);
    expect(second.text()).toBe("abc");
  });

  it("streams live bytes to the currently attached terminal", () => {
    const fake = makeFakeIo();
    const buffer = new TerminalBuffer(fake.io);
    const sink = collect();
    buffer.attach(sink.onData);

    fake.push(enc("live"));
    expect(sink.text()).toBe("live");
  });

  it("passes input/resize through while live and drops them after close", () => {
    const fake = makeFakeIo();
    const buffer = new TerminalBuffer(fake.io);

    buffer.send(enc("x"));
    buffer.resize(80, 24);
    expect(fake.sent).toHaveLength(1);
    expect(fake.resizes).toEqual([{ cols: 80, rows: 24 }]);

    fake.end();
    buffer.send(enc("y"));
    expect(fake.sent).toHaveLength(1);
  });

  it("evicts oldest bytes past the cap and notes truncation on replay", () => {
    const fake = makeFakeIo();
    const buffer = new TerminalBuffer(fake.io, 8);
    fake.push(enc("aaaa"));
    fake.push(enc("bbbb"));
    fake.push(enc("cccc")); // total 12 > 8 → oldest "aaaa" evicted

    const sink = collect();
    buffer.attach(sink.onData);
    const text = sink.text();
    expect(text).toContain("truncated");
    expect(text.endsWith("bbbbcccc")).toBe(true);
    expect(text).not.toContain("aaaa");
  });

  it("closes the transport on dispose", () => {
    const fake = makeFakeIo();
    const buffer = new TerminalBuffer(fake.io);
    buffer.dispose();
    expect(fake.closed).toBe(true);
  });
});
