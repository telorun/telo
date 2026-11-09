import { afterEach, describe, expect, it, vi } from "vitest";

import { ArchiveFetchError, createArchiveReader } from "../src/bundle/source-staging.js";
import { makeTarGz } from "../src/bundle/tar.js";

const URL_A = "http://127.0.0.1:1/a.tgz";

afterEach(() => {
  vi.useRealTimers();
});

async function archiveBody(): Promise<Uint8Array> {
  return new Uint8Array(await makeTarGz([{ name: "f.txt", content: "x" }]));
}

/** A fetch answering each call from `answers`, the last one repeating. */
function scripted(answers: (() => Response | Promise<Response>)[]) {
  let calls = 0;
  const fetchImpl = (async () => {
    const answer = answers[Math.min(calls, answers.length - 1)]!;
    calls++;
    return answer();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

const ok = async () => new Response(await archiveBody(), { status: 200 });
const status = (code: number, text: string) => () => new Response(null, { status: code, statusText: text });
const options = { retryDelaysMs: [0, 0] };

describe("createArchiveReader", () => {
  it("fetches an archive once for every lookup while it is held", async () => {
    const { fetchImpl, calls } = scripted([ok]);
    const read = createArchiveReader({ fetchImpl, ...options });
    await Promise.all([read(URL_A, "tar.gz"), read(URL_A, "tar.gz")]);
    await read(URL_A, "tar.gz");
    expect(calls()).toBe(1);
  });

  it("does not cache a failed fetch", async () => {
    const { fetchImpl, calls } = scripted([status(404, "Not Found"), ok]);
    const read = createArchiveReader({ fetchImpl, ...options });
    await expect(read(URL_A, "tar.gz")).rejects.toBeInstanceOf(ArchiveFetchError);
    await expect(read(URL_A, "tar.gz")).resolves.toHaveLength(1);
    expect(calls()).toBe(2);
  });

  it("stages after a 504 then a 200", async () => {
    const { fetchImpl, calls } = scripted([status(504, "Gateway Time-out"), ok]);
    const read = createArchiveReader({ fetchImpl, ...options });
    await expect(read(URL_A, "tar.gz")).resolves.toHaveLength(1);
    expect(calls()).toBe(2);
  });

  it("retries a 429 and a network error", async () => {
    const { fetchImpl, calls } = scripted([
      status(429, "Too Many Requests"),
      () => {
        throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
      },
      ok,
    ]);
    const read = createArchiveReader({ fetchImpl, ...options });
    await expect(read(URL_A, "tar.gz")).resolves.toHaveLength(1);
    expect(calls()).toBe(3);
  });

  it("gives up after three attempts, saying so", async () => {
    const { fetchImpl, calls } = scripted([status(504, "Gateway Time-out")]);
    const read = createArchiveReader({ fetchImpl, ...options });
    const rejection = read(URL_A, "tar.gz");
    await expect(rejection).rejects.toBeInstanceOf(ArchiveFetchError);
    await expect(rejection).rejects.toThrow("answered 504 Gateway Time-out (3 attempts)");
    expect(calls()).toBe(3);
  });

  it("does not retry a 404", async () => {
    const { fetchImpl, calls } = scripted([status(404, "Not Found")]);
    const read = createArchiveReader({ fetchImpl, ...options });
    await expect(read(URL_A, "tar.gz")).rejects.toThrow(/answered 404 Not Found$/);
    expect(calls()).toBe(1);
  });

  it("does not retry a timeout", async () => {
    const { fetchImpl, calls } = scripted([
      () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      },
    ]);
    const read = createArchiveReader({ fetchImpl, ...options });
    await expect(read(URL_A, "tar.gz")).rejects.toThrow("no complete response within");
    expect(calls()).toBe(1);
  });

  it("keeps the last failed attempt as the cause", async () => {
    const { fetchImpl } = scripted([status(503, "Unavailable")]);
    const rejection = await createArchiveReader({ fetchImpl, ...options })(URL_A, "tar.gz").catch((e) => e);
    expect(rejection.cause).toBeInstanceOf(ArchiveFetchError);
    expect(rejection.cause.message).toContain("503");
  });

  it("waits 1 s then 3 s between attempts by default", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = scripted([status(503, "Unavailable")]);
    const read = createArchiveReader({ fetchImpl });
    const rejection = expect(read(URL_A, "tar.gz")).rejects.toThrow("(3 attempts)");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(3_000);
    await rejection;
    expect(calls()).toBe(3);
  });

  it("drops a decoded archive after the idle release, on an unref'd timer", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = scripted([ok]);
    const read = createArchiveReader({ fetchImpl, idleReleaseMs: 60_000, ...options });
    await read(URL_A, "tar.gz");
    await vi.advanceTimersByTimeAsync(59_000);
    await read(URL_A, "tar.gz");
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(59_000);
    await read(URL_A, "tar.gz");
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(61_000);
    await read(URL_A, "tar.gz");
    expect(calls()).toBe(2);
  });

  it("never releases an archive while its fetch is still pending", async () => {
    vi.useFakeTimers();
    const slow = async () => {
      await new Promise((resolve) => setTimeout(resolve, 90_000));
      return new Response(await archiveBody(), { status: 200 });
    };
    const { fetchImpl, calls } = scripted([slow]);
    const read = createArchiveReader({ fetchImpl, idleReleaseMs: 60_000, ...options });
    const first = read(URL_A, "tar.gz");
    await vi.advanceTimersByTimeAsync(90_000);
    await first;
    await read(URL_A, "tar.gz");
    expect(calls()).toBe(1);
  });

  it("holds no timer that keeps the process alive", async () => {
    const unref = vi.spyOn(globalThis, "setTimeout");
    const { fetchImpl } = scripted([ok]);
    await createArchiveReader({ fetchImpl, idleReleaseMs: 60_000, ...options })(URL_A, "tar.gz");
    const timer = unref.mock.results.at(-1)!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    unref.mockRestore();
  });
});
