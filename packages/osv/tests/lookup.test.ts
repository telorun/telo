import { describe, expect, it } from "vitest";
import { AdvisoryLookupError, isChecked, LookupCancelledError, lookupAdvisories, OSV_ECOSYSTEMS, OSV_VCS_ECOSYSTEMS } from "../src/index.js";

interface Call {
  url: string;
  body?: any;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

const sleeps: number[] = [];
const options = (fetchImpl: typeof fetch) => ({
  baseUrl: "https://osv.test/",
  fetch: fetchImpl,
  sleep: async (ms: number) => void sleeps.push(ms),
  random: () => 0.5,
});

const record = {
  id: "GHSA-1",
  aliases: ["CVE-1"],
  summary: "bad",
  severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N" }],
  affected: [
    {
      package: { ecosystem: "npm", name: "@fastify/static" },
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "10.1.1" }] }],
    },
    { package: { ecosystem: "npm", name: "other" }, ranges: [{ type: "SEMVER", events: [{ fixed: "9.9.9" }] }] },
  ],
};

function server(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const call: Call = { url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("lookupAdvisories", () => {
  it("shapes an advisory with the package's fixed versions and answers pkg:generic unchecked without asking", async () => {
    const { calls, fetchImpl } = server((c) =>
      c.url.endsWith("/v1/querybatch") ? json({ results: [{ vulns: [{ id: "GHSA-1" }] }] }) : json(record),
    );
    const answers = await lookupAdvisories(
      [
        { purl: "pkg:npm/%40fastify/static", version: "10.1.0" },
        { purl: "pkg:generic/sqlite", version: "3.51.3" },
      ],
      options(fetchImpl),
    );
    expect(answers).toEqual([
      {
        purl: "pkg:npm/%40fastify/static",
        version: "10.1.0",
        checked: true,
        advisories: [
          {
            id: "GHSA-1",
            aliases: ["CVE-1"],
            summary: "bad",
            severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N" }],
            component: "pkg:npm/%40fastify/static@10.1.0",
            fixed: ["10.1.1"],
            matchedBy: "version",
          },
        ],
      },
      { purl: "pkg:generic/sqlite", version: "3.51.3", checked: false, advisories: [] },
    ]);
    expect(calls[0].body.queries).toEqual([{ package: { purl: "pkg:npm/%40fastify/static@10.1.0" } }]);
  });

  it("returns an advisory that records no severity", async () => {
    const { fetchImpl } = server((c) =>
      c.url.endsWith("/v1/querybatch")
        ? json({ results: [{ vulns: [{ id: "X" }] }] })
        : json({ id: "X" }),
    );
    const [answer] = await lookupAdvisories([{ purl: "pkg:cargo/serde", version: "1.0.0" }], options(fetchImpl));
    expect(answer.advisories).toEqual([
      { id: "X", aliases: [], summary: "", severity: [], component: "pkg:cargo/serde@1.0.0", fixed: [], matchedBy: "version" },
    ]);
  });

  it("chunks more than 1000 queries and answers each in order", async () => {
    const { calls, fetchImpl } = server((c) =>
      c.url.endsWith("/v1/querybatch")
        ? json({ results: c.body.queries.map(() => ({})) })
        : json(record),
    );
    const input = Array.from({ length: 2500 }, (_, i) => ({ purl: "pkg:npm/p", version: `1.0.${i}` }));
    const answers = await lookupAdvisories(input, options(fetchImpl));
    expect(calls.map((c) => c.body.queries.length)).toEqual([1000, 1000, 500]);
    expect(answers.map((a) => a.version)).toEqual(input.map((i) => i.version));
  });

  it("follows page tokens until a query has no more", async () => {
    const { calls, fetchImpl } = server((c) => {
      if (!c.url.endsWith("/v1/querybatch")) return json({ id: c.url.split("/").pop() });
      const token = c.body.queries[0].page_token;
      if (token === undefined) return json({ results: [{ vulns: [{ id: "A" }], next_page_token: "t1" }] });
      if (token === "t1") return json({ results: [{ vulns: [{ id: "B" }], next_page_token: "t2" }] });
      return json({ results: [{ vulns: [{ id: "C" }] }] });
    });
    const [answer] = await lookupAdvisories([{ purl: "pkg:npm/p", version: "1.0.0" }], options(fetchImpl));
    expect(answer.advisories.map((a) => a.id)).toEqual(["A", "B", "C"]);
    expect(calls.filter((c) => c.url.endsWith("/v1/querybatch")).length).toBe(3);
  });

  it("retries a 429 after the Retry-After wait, then a 5xx with jittered backoff", async () => {
    sleeps.length = 0;
    let attempts = 0;
    const { fetchImpl } = server((c) => {
      if (!c.url.endsWith("/v1/querybatch")) return json({ id: "A" });
      attempts += 1;
      if (attempts === 1) return new Response("", { status: 429, headers: { "retry-after": "3" } });
      if (attempts === 2) return new Response("", { status: 503 });
      return json({ results: [{ vulns: [{ id: "A" }] }] });
    });
    const [answer] = await lookupAdvisories([{ purl: "pkg:npm/p", version: "1.0.0" }], options(fetchImpl));
    expect(answer.advisories).toHaveLength(1);
    expect(sleeps).toEqual([3000, 1000]);
  });

  it("fails with ADVISORY_LOOKUP_FAILED after four attempts, naming the endpoint and the cause", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      throw new Error("connect ECONNREFUSED 10.0.4.12:443");
    }) as unknown as typeof fetch;
    const failure = await lookupAdvisories([{ purl: "pkg:npm/p", version: "1" }], options(fetchImpl)).catch((e) => e);
    expect(failure).toBeInstanceOf(AdvisoryLookupError);
    expect(failure).toMatchObject({
      code: "ADVISORY_LOOKUP_FAILED",
      endpoint: "https://osv.test/v1/querybatch",
      attempts: 4,
      detail: "connect ECONNREFUSED 10.0.4.12:443",
    });
    expect(failure.message).toBe(
      "https://osv.test/v1/querybatch gave no answer after 4 attempts: connect ECONNREFUSED 10.0.4.12:443. No component was judged.",
    );
    expect(attempts).toBe(4);
  });

  it("fails the whole lookup when one page of several fails", async () => {
    const { fetchImpl } = server((c) => {
      if (!c.url.endsWith("/v1/querybatch")) return json({ id: "A" });
      return c.body.queries[0].page_token === undefined
        ? json({ results: [{ vulns: [{ id: "A" }], next_page_token: "t1" }] })
        : new Response("", { status: 500 });
    });
    const failure = await lookupAdvisories([{ purl: "pkg:npm/p", version: "1.0.0" }], options(fetchImpl)).catch((e) => e);
    expect(failure).toBeInstanceOf(AdvisoryLookupError);
    expect(failure.detail).toBe("HTTP 500");
  });

  it("does not retry a refusal that is not a 429 or a 5xx", async () => {
    const { calls, fetchImpl } = server(() => new Response("", { status: 400 }));
    const failure = await lookupAdvisories([{ purl: "pkg:npm/p", version: "1.0.0" }], options(fetchImpl)).catch((e) => e);
    expect(failure).toBeInstanceOf(AdvisoryLookupError);
    expect(calls).toHaveLength(1);
  });

  it("puts the version before a subpath or qualifiers in the purl it sends and the advisory's component", async () => {
    const goRecord = {
      id: "GHSA-2",
      affected: [{ package: { ecosystem: "Go", name: "google.golang.org/genproto" }, ranges: [{ type: "SEMVER", events: [{ fixed: "1.2.3" }] }] }],
    };
    const { calls, fetchImpl } = server((c) =>
      c.url.endsWith("/v1/querybatch") ? json({ results: [{ vulns: [{ id: "GHSA-2" }] }, { vulns: [{ id: "GHSA-2" }] }] }) : json(goRecord),
    );
    const answers = await lookupAdvisories(
      [
        { purl: "pkg:golang/google.golang.org/genproto#googleapis/api/annotations", version: "0.0.1" },
        { purl: "pkg:maven/org.apache.commons/commons-lang3?type=jar", version: "3.1" },
      ],
      options(fetchImpl),
    );
    expect(calls[0].body.queries).toEqual([
      { package: { purl: "pkg:golang/google.golang.org/genproto@0.0.1#googleapis/api/annotations" } },
      { package: { purl: "pkg:maven/org.apache.commons/commons-lang3@3.1?type=jar" } },
    ]);
    expect(answers[0].advisories[0].component).toBe("pkg:golang/google.golang.org/genproto@0.0.1#googleapis/api/annotations");
    expect(answers[0].advisories[0].fixed).toEqual(["1.2.3"]);
    expect(answers[1].advisories[0].component).toBe("pkg:maven/org.apache.commons/commons-lang3@3.1?type=jar");
  });

  it("rejects with the cancellation when the signal aborts mid-backoff, without another request", async () => {
    const { calls, fetchImpl } = server(() => new Response("", { status: 503 }));
    const controller = new AbortController();
    const failure = lookupAdvisories([{ purl: "pkg:npm/p", version: "1.0.0" }], {
      ...options(fetchImpl),
      sleep: () => new Promise<void>(() => {}),
      signal: controller.signal,
    }).catch((e) => e);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(await failure).toBeInstanceOf(LookupCancelledError);
    expect(calls).toHaveLength(1);
  });

  it("rejects with the cancellation when the signal aborts an in-flight request", async () => {
    const controller = new AbortController();
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const failure = lookupAdvisories([{ purl: "pkg:npm/p", version: "1.0.0" }], { ...options(fetchImpl), signal: controller.signal }).catch((e) => e);
    controller.abort();
    expect(await failure).toBeInstanceOf(LookupCancelledError);
  });
});

describe("package types", () => {
  it("answers checked from the ecosystem data alone", () => {
    expect(isChecked("pkg:npm/lodash")).toBe(true);
    expect(isChecked("pkg:generic/sqlite")).toBe(false);
    OSV_ECOSYSTEMS["testtype"] = "Test";
    try {
      expect(isChecked("pkg:testtype/x")).toBe(true);
    } finally {
      delete (OSV_ECOSYSTEMS as Record<string, string>)["testtype"];
    }
  });
});

describe("components checked by their revision", () => {
  const SQLITE = { url: "git+https://github.com/sqlite/sqlite", revision: "a5333afb9ad1aa473f8963b92caeaa955f47dc74" };
  const FORK = { url: "git+https://github.com/Balearica/tesseract", revision: "2a9c1c49c360462733c386d2a44fcd22c4e21411" };
  const gitRecord = {
    id: "CVE-2025-29087",
    summary: "concat_ws overflow",
    affected: [
      {
        ranges: [
          { type: "GIT", repo: "https://github.com/sqlite/sqlite.git", events: [{ introduced: "0" }, { fixed: "f00dfeedf00dfeedf00dfeedf00dfeedf00dfeed" }] },
          { type: "GIT", repo: "https://github.com/other/fork", events: [{ fixed: "1111111111111111111111111111111111111111" }] },
        ],
      },
    ],
  };
  const isProbe = (query: any) => query.package?.ecosystem === "GIT";

  it("probes each distinct repository once and answers a repository OSV records nothing about unchecked", async () => {
    const { calls, fetchImpl } = server((c) => json({ results: c.body.queries.map(() => ({})) }));
    const answers = await lookupAdvisories(
      [
        { purl: "pkg:generic/tesseract", version: "5.5.0", vcs: FORK },
        { purl: "pkg:generic/tesseract-copy", version: "5.5.0", vcs: FORK },
      ],
      options(fetchImpl),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.queries).toEqual([{ package: { ecosystem: "GIT", name: "https://github.com/Balearica/tesseract" } }]);
    expect(answers.map((a) => [a.checked, a.advisories, a.vcs])).toEqual([
      [false, [], FORK],
      [false, [], FORK],
    ]);
  });

  it("asks for the commit in a recorded repository, with the fixed commits of that repository's ranges", async () => {
    const { calls, fetchImpl } = server((c) => {
      if (!c.url.endsWith("/v1/querybatch")) return json(gitRecord);
      return json({
        results: c.body.queries.map((q: any) =>
          isProbe(q) ? (q.page_token ? { vulns: [{ id: "OSV-OLD" }] } : { vulns: [], next_page_token: "p2" }) : q.commit === SQLITE.revision ? { vulns: [{ id: "CVE-2025-29087" }] } : {},
        ),
      });
    });
    const [answer] = await lookupAdvisories([{ purl: "pkg:generic/sqlite", version: "3.51.3", vcs: SQLITE }], options(fetchImpl));
    expect(answer).toEqual({
      purl: "pkg:generic/sqlite",
      version: "3.51.3",
      vcs: SQLITE,
      checked: true,
      advisories: [
        { id: "CVE-2025-29087", aliases: [], summary: "concat_ws overflow", severity: [], component: "pkg:generic/sqlite@3.51.3", fixed: ["f00dfeedf00dfeedf00dfeedf00dfeedf00dfeed"], matchedBy: "revision" },
      ],
    });
    const batches = calls.filter((c) => c.url.endsWith("/v1/querybatch")).map((c) => c.body.queries);
    // An empty first probe page is followed to the page naming a record; then the commit is asked.
    expect(batches).toEqual([
      [{ package: { ecosystem: "GIT", name: "https://github.com/sqlite/sqlite" } }],
      [{ package: { ecosystem: "GIT", name: "https://github.com/sqlite/sqlite" }, page_token: "p2" }],
      [{ commit: SQLITE.revision }],
    ]);
  });

  it("adds the commit answer to the purl answer when the purl's type is matched too", async () => {
    const { calls, fetchImpl } = server((c) => {
      if (!c.url.endsWith("/v1/querybatch")) return json(c.url.endsWith("GHSA-1") ? record : gitRecord);
      return json({
        results: c.body.queries.map((q: any) => (isProbe(q) ? { vulns: [{ id: "X" }] } : q.commit ? { vulns: [{ id: "CVE-2025-29087" }] } : { vulns: [{ id: "GHSA-1" }] })),
      });
    });
    const [answer] = await lookupAdvisories([{ purl: "pkg:npm/%40fastify/static", version: "10.1.0", vcs: SQLITE }], options(fetchImpl));
    expect(answer!.checked).toBe(true);
    expect(answer!.advisories.map((a) => [a.id, a.fixed, a.matchedBy])).toEqual([
      ["GHSA-1", ["10.1.1"], "version"],
      ["CVE-2025-29087", ["f00dfeedf00dfeedf00dfeedf00dfeedf00dfeed"], "revision"],
    ]);
    expect(calls.filter((c) => c.url.endsWith("/v1/querybatch"))[1]!.body.queries).toEqual([
      { package: { purl: "pkg:npm/%40fastify/static@10.1.0" } },
      { commit: SQLITE.revision },
    ]);
  });

  it("probes a repository as OSV records it, however its location is spelled", async () => {
    const { calls, fetchImpl } = server((c) => json({ results: c.body.queries.map(() => ({})) }));
    await lookupAdvisories(
      [
        { purl: "pkg:generic/sqlite", version: "3.51.3", vcs: { url: "git+https://GitHub.com/sqlite/sqlite.git", revision: SQLITE.revision } },
        { purl: "pkg:generic/sqlite", version: "3.51.3", vcs: { url: "git+https://github.com/sqlite/sqlite/", revision: SQLITE.revision } },
      ],
      options(fetchImpl),
    );
    expect(calls[0]!.body.queries).toEqual([{ package: { ecosystem: "GIT", name: "https://github.com/sqlite/sqlite" } }]);
  });

  it("fails the lookup when a probe fails", async () => {
    const { fetchImpl } = server(() => new Response("", { status: 500 }));
    const failure = await lookupAdvisories([{ purl: "pkg:generic/sqlite", version: "3.51.3", vcs: SQLITE }], options(fetchImpl)).catch((e) => e);
    expect(failure).toBeInstanceOf(AdvisoryLookupError);
  });

  it("answers checked by revision from the tool data alone", async () => {
    const { fetchImpl } = server((c) => (c.url.endsWith("/v1/querybatch") ? json({ results: c.body.queries.map(() => ({ vulns: [{ id: "X" }] })) }) : json({ id: "X" })));
    const hg = { url: "hg+https://example.com/repo", revision: SQLITE.revision };
    const unknown = await lookupAdvisories([{ purl: "pkg:generic/x", version: "1", vcs: hg }], { ...options(fetchImpl), fetch: (async () => { throw new Error("no request expected"); }) as unknown as typeof fetch });
    expect(unknown[0]!.checked).toBe(false);
    (OSV_VCS_ECOSYSTEMS as Record<string, string>)["hg"] = "HG";
    try {
      const known = await lookupAdvisories([{ purl: "pkg:generic/x", version: "1", vcs: hg }], options(fetchImpl));
      expect(known[0]!.checked).toBe(true);
    } finally {
      delete (OSV_VCS_ECOSYSTEMS as Record<string, string>)["hg"];
    }
  });
});
