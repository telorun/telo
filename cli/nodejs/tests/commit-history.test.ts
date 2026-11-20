import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CommitHistoryReader, RepositoryUnreadableError } from "../src/commit-reachability/commit-history.js";
import { FakeGitHost, fakeHistory } from "./__fixtures__/commit-history/fake-git-host.js";

const history = fakeHistory();
const host = new FakeGitHost(history.all, {
  "refs/heads/main": { id: history.head.id },
  "refs/tags/v1": { id: "1".repeat(40), peeled: history.tagged.id },
});
const URL = "git+https://git.test/acme/repo";
const reader = (limits?: { refsBytes?: number }) => new CommitHistoryReader({ fetch: host.fetch, sleep: async () => {}, limits });

beforeAll(() => host.start());
afterAll(() => host.stop());

describe("reading a repository's history over smart HTTP", () => {
  it("reaches a branch tip, a tag's commit and their ancestors, reading the history once", async () => {
    host.mode = "ok";
    host.requests.length = 0;
    const read = reader();
    expect(await read.reachable(URL, history.head.id)).toBe(true);
    expect(await read.reachable(URL, history.tagged.id)).toBe(true);
    expect(await read.reachable(URL, history.root.id)).toBe(true);
    expect(host.requests).toEqual([
      "GET /acme/repo/info/refs?service=git-upload-pack",
      "POST /acme/repo/git-upload-pack",
      "POST /acme/repo/git-upload-pack",
    ]);
  });

  it("does not reach a commit the host holds but no branch or tag of the repository reaches", async () => {
    host.mode = "ok";
    expect(await reader().reachable(URL, history.fork.id)).toBe(false);
  });

  it.each([
    ["version-0", "does not speak version 2 of git's protocol"],
    ["no-filter", "offers no filter"],
    ["missing", "answered HTTP 404"],
    ["failing", "no answer after 3 attempts"],
  ] as const)("refuses a host that is %s, naming the host and the cause", async (mode, cause) => {
    host.mode = mode;
    const failure = await reader().reachable(URL, history.head.id).catch((error) => error);
    expect(failure).toBeInstanceOf(RepositoryUnreadableError);
    expect(failure.host).toBe("git.test");
    expect(failure.message).toContain(cause);
  });
});

describe("what the reader follows and what it refuses", () => {
  afterEach(() => {
    delete process.env.TELO_EGRESS;
  });

  it("follows an https redirect of info/refs and sends the commands where it led", async () => {
    host.mode = "redirect-git";
    host.requests.length = 0;
    expect(await reader().reachable(URL, history.root.id)).toBe(true);
    expect(host.requests).toEqual([
      "GET /acme/repo/info/refs?service=git-upload-pack",
      "GET /acme/repo.git/info/refs?service=git-upload-pack",
      "POST /acme/repo.git/git-upload-pack",
      "POST /acme/repo.git/git-upload-pack",
    ]);
  });

  it("refuses a redirect of info/refs to plain http before following it", async () => {
    host.mode = "redirect-http";
    host.requests.length = 0;
    const failure = await reader().reachable(URL, history.head.id).catch((error) => error);
    expect(failure).toBeInstanceOf(RepositoryUnreadableError);
    expect(failure.message).toContain("redirected to http://git.test/acme/repo/info/refs?service=git-upload-pack: it is not an https address");
    expect(host.requests).toEqual(["GET /acme/repo/info/refs?service=git-upload-pack"]);
  });

  it("refuses a redirect of a command, once, as git does", async () => {
    host.mode = "redirect-post";
    host.requests.length = 0;
    const failure = await reader().reachable(URL, history.head.id).catch((error) => error);
    expect(failure).toBeInstanceOf(RepositoryUnreadableError);
    expect(failure.message).toContain("answered with a redirect, which git follows only for info/refs");
    expect(host.requests).toEqual(["GET /acme/repo/info/refs?service=git-upload-pack", "POST /acme/repo/git-upload-pack"]);
  });

  it("stops reading an answer past its byte limit", async () => {
    host.mode = "huge";
    const failure = await reader({ refsBytes: 16 * 1024 }).reachable(URL, history.head.id).catch((error) => error);
    expect(failure).toBeInstanceOf(RepositoryUnreadableError);
    expect(failure.message).toContain("is larger than the 16384-byte limit");
  });

  it("refuses a private address under TELO_EGRESS=public-only before any request", async () => {
    process.env.TELO_EGRESS = "public-only";
    const fetchSpy = vi.fn(host.fetch);
    const failure = await new CommitHistoryReader({ fetch: fetchSpy as typeof fetch, sleep: async () => {} })
      .reachable("git+https://10.0.0.5/acme/repo", history.head.id)
      .catch((error) => error);
    expect(failure).toBeInstanceOf(RepositoryUnreadableError);
    expect(failure.host).toBe("10.0.0.5");
    expect(failure.message).toContain("Egress to '10.0.0.5' denied");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
