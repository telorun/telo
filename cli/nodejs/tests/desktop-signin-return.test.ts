import { beforeEach, describe, expect, it } from "vitest";

import type { AdmissionRequest, HostBodyRequest, HostResponse } from "../src/desktop/desktop-admission.js";
import { MAX_RETURN_BODY_BYTES, SigninReturn } from "../src/desktop/desktop-signin-return.js";

/** The armed return's state machine, with no sockets: requests are built by hand and the window is a recorder. */

const ORIGIN = "http://127.0.0.1:5000";
const HOST_ORIGIN = "http://127.0.0.1:5001";

let now: number;
let calls: string[];
let events: unknown[];
let signin: SigninReturn;

beforeEach(() => {
  now = 1_000;
  calls = [];
  events = [];
  signin = new SigninReturn({
    origin: ORIGIN,
    hostOrigin: HOST_ORIGIN,
    callbackPaths: ["/auth/callback"],
    productName: "Notes <&>",
    focus: async (window) => void calls.push(`focus ${window}`),
    navigate: async (window, url) => void calls.push(`navigate ${window} ${url}`),
    report: (event) => events.push(event),
    codeTtlMs: 100,
    now: () => now,
  });
});

function request(method: string, target: string, headers: Record<string, string> = {}): AdmissionRequest {
  const question = target.indexOf("?");
  return {
    method,
    target,
    path: question < 0 ? target : target.slice(0, question),
    query: question < 0 ? "" : target.slice(question + 1),
    headers: new Map(Object.entries(headers).map(([name, value]) => [name, [value]])),
    peer: "127.0.0.1:1",
  };
}
const form = (target = "/auth/callback", length = 3) =>
  request("POST", target, { "content-type": "application/x-www-form-urlencoded", "content-length": String(length) });
const asBody = (answer: HostResponse | HostBodyRequest | undefined) => {
  expect(answer && "onBody" in answer).toBe(true);
  return answer as HostBodyRequest;
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("the armed return", () => {
  it("answers nothing while no return is armed, and nothing for an empty window name", () => {
    expect(signin.unadmitted(request("GET", "/auth/callback?code=1"))).toBeUndefined();
    signin.arm("");
    expect(signin.unadmitted(request("GET", "/auth/callback?code=1"))).toBeUndefined();
  });

  it("is used up by the first GET, which is replayed in the window that armed it, after focusing it", async () => {
    signin.arm("main");
    const answer = signin.unadmitted(request("GET", "/auth/callback?code=1&state=a%20b")) as HostResponse;
    expect(answer).toMatchObject({ status: 200, body: "<p>Return to Notes &lt;&amp;&gt; to finish signing in.</p>" });
    expect(answer.headers).toContainEqual(["Cache-Control", "no-store"]);
    expect(signin.unadmitted(request("GET", "/auth/callback?code=1"))).toBeUndefined();
    await settle();
    expect(calls).toEqual(["focus main", `navigate main ${ORIGIN}/auth/callback?code=1&state=a%20b`]);
    expect(events).toEqual(["used"]);
  });

  it("is replaced by a later navigation, and cleared only when its own window closes", () => {
    signin.arm("a");
    signin.arm("b");
    signin.windowClosed("a");
    expect(signin.unadmitted(request("GET", "/auth/callback"))).toBeDefined();
    signin.arm("a");
    signin.windowClosed("a");
    expect(signin.unadmitted(request("GET", "/auth/callback"))).toBeUndefined();
  });

  it("matches a callback path by its raw text alone, and a refused request leaves the return armed", () => {
    signin.arm("main");
    for (const target of [
      "/auth/callback/",
      "/AUTH/callback",
      "//auth/callback",
      "/auth%2Fcallback",
      "/auth/./callback",
      "/auth/callback%2F",
      "/elsewhere",
    ]) {
      expect(signin.unadmitted(request("GET", target)), target).toBeUndefined();
    }
    for (const method of ["PUT", "HEAD", "DELETE"]) expect(signin.unadmitted(request(method, "/auth/callback"))).toBeUndefined();
    expect(signin.unadmitted(request("GET", "/auth/callback"))).toBeDefined();
  });

  it("takes a POST only as a form of at most 64 KiB with its length stated, and refusing one keeps the return", () => {
    signin.arm("main");
    const refused = [
      request("POST", "/auth/callback", { "content-type": "application/json", "content-length": "3" }),
      request("POST", "/auth/callback", { "content-length": "3" }),
      request("POST", "/auth/callback", { "content-type": "application/x-www-form-urlencoded" }),
      request("POST", "/auth/callback", { "content-type": "application/x-www-form-urlencoded", "content-length": "abc" }),
      form("/auth/callback", MAX_RETURN_BODY_BYTES + 1),
      form("/elsewhere"),
    ];
    for (const one of refused) expect(signin.unadmitted(one)).toBeUndefined();
    const accepted = request("POST", "/auth/callback", {
      "content-type": "Application/X-WWW-Form-Urlencoded; charset=UTF-8",
      "content-length": String(MAX_RETURN_BODY_BYTES),
    });
    expect(asBody(signin.unadmitted(accepted)).maxBytes).toBe(MAX_RETURN_BODY_BYTES);
  });

  it("uses the return up when a POST is accepted, before its body arrives", () => {
    signin.arm("main");
    asBody(signin.unadmitted(form()));
    expect(signin.unadmitted(request("GET", "/auth/callback"))).toBeUndefined();
    expect(signin.unadmitted(form())).toBeUndefined();
  });

  it("replays a POST as a single-use code the host origin answers with a form of the stored fields, in order, escaped, posting to the app's origin", async () => {
    signin.arm("main");
    const body = "a=%3Cscript%3E%22x%27&b=1&a=2&%26n%3D=%C3%A9+%26";
    const answer = asBody(signin.unadmitted(form("/auth/callback", body.length))).onBody(Buffer.from(body));
    expect(answer.status).toBe(200);
    await settle();
    const navigated = calls.find((call) => call.startsWith("navigate"))!;
    const code = /code=([\w-]+)$/.exec(navigated)![1];
    expect(navigated).toBe(`navigate main ${HOST_ORIGIN}/return?code=${code}`);
    expect(calls[0]).toBe("focus main");

    const page = signin.page(request("GET", `/return?code=${code}`)) as HostResponse;
    expect(page.headers).toContainEqual(["Cache-Control", "no-store"]);
    expect(page.headers).toContainEqual(["Referrer-Policy", "no-referrer"]);
    expect(page.body).toBe(
      `<form method="post" action="${ORIGIN}/auth/callback">` +
        '<input type="hidden" name="a" value="&lt;script&gt;&quot;x&#39;">' +
        '<input type="hidden" name="b" value="1">' +
        '<input type="hidden" name="a" value="2">' +
        '<input type="hidden" name="&amp;n=" value="é &amp;">' +
        "</form><script>document.forms[0].submit()</script>",
    );
    expect(signin.page(request("GET", `/return?code=${code}`))).toBeUndefined();
  });

  async function storedCode(): Promise<string> {
    signin.arm("main");
    asBody(signin.unadmitted(form())).onBody(Buffer.from("k=v"));
    await settle();
    return /code=([\w-]+)$/.exec(calls.find((call) => call.startsWith("navigate"))!)![1];
  }

  it("serves nothing for an unknown, expired or closed-window code, another path, nor a second code in one query", async () => {
    const code = await storedCode();
    expect(signin.page(request("GET", "/return?code=guessed"))).toBeUndefined();
    expect(signin.page(request("GET", `/return?code=${code}&code=${code}`))).toBeUndefined();
    expect(signin.page(request("POST", `/return?code=${code}`))).toBeUndefined();
    expect(signin.page(request("GET", `/auth/callback?code=${code}`))).toBeUndefined();
    now += 101;
    expect(signin.page(request("GET", `/return?code=${code}`))).toBeUndefined();

    calls = [];
    const second = await storedCode();
    signin.windowClosed("main");
    expect(signin.page(request("GET", `/return?code=${second}`))).toBeUndefined();
  });

  it("reports a failed replay without the request's values", async () => {
    signin = new SigninReturn({
      origin: ORIGIN,
      hostOrigin: HOST_ORIGIN,
      callbackPaths: ["/auth/callback"],
      productName: "Notes",
      focus: async () => {
        throw new Error("window gone");
      },
      navigate: async () => undefined,
      report: (event) => events.push(event),
    });
    signin.arm("main");
    signin.unadmitted(request("GET", "/auth/callback?code=secret"));
    await settle();
    expect(events).toEqual(["used", { failed: new Error("window gone") }]);
  });

  it("never arms when the need declares no callback path", () => {
    signin = new SigninReturn({ origin: ORIGIN, hostOrigin: HOST_ORIGIN, callbackPaths: [], productName: "Notes", focus: async () => {}, navigate: async () => {}, report: () => {} });
    signin.arm("main");
    expect(signin.unadmitted(request("GET", "/auth/callback"))).toBeUndefined();
  });
});
