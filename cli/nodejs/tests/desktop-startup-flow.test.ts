import type { UnresolvedApplicationInput } from "@telorun/kernel";
import { describe, expect, it } from "vitest";

import type { AdmissionRequest, HostBodyRequest, HostResponse } from "../src/desktop/desktop-admission.js";
import { DesktopStartupFlow } from "../src/desktop/desktop-startup-flow.js";
import { fieldKindOf } from "../src/desktop/desktop-startup-pages.js";

/** What the host's window shows while the application starts: its states, its form and its pages. */

const request = (method: string, path: string, headers: Record<string, string> = {}): AdmissionRequest => ({
  method,
  target: path,
  path,
  query: "",
  headers: new Map(Object.entries(headers).map(([name, value]) => [name, [value]])),
  peer: "127.0.0.1:1",
});

const input = (name: string, extra: Partial<UnresolvedApplicationInput> = {}): UnresolvedApplicationInput => ({
  id: `variables.${name}`,
  block: "variables",
  name,
  env: name.toUpperCase(),
  sensitive: false,
  type: "string",
  schema: { type: "string" },
  ...extra,
});

const html = (response: HostResponse | HostBodyRequest | undefined): string => {
  if (!response || "onBody" in response) throw new Error("not a page");
  return String(response.body);
};
const view = (text: string) => /data-view="([a-z-]+)"/.exec(text)?.[1];

describe("the startup flow", () => {
  it("shows the startup view with a retry marker, then the refusal with the diagnostics escaped", () => {
    const flow = new DesktopStartupFlow("Hello <App>");
    const starting = flow.unavailable({ port: 1 });
    expect(starting.contentType).toBe("text/html; charset=utf-8");
    expect(starting.body).toContain('<meta http-equiv="refresh" content="1">');
    expect(starting.body).toContain("Hello &#60;App&#62;");

    flow.fail("error  <b>x</b> & \"y\"");
    const failed = flow.unavailable({ port: 1 }).body;
    expect(view(failed)).toBe("refusal");
    expect(failed).not.toContain("refresh");
    expect(failed).toContain("error  &#60;b&#62;x&#60;/b&#62; &#38; &#34;y&#34;");
    expect(view(html(flow.page(request("GET", "/startup"))))).toBe("refusal");
  });

  it("serves its two pages until startup ends and 404 after, and answers no other path", () => {
    const flow = new DesktopStartupFlow("Hello");
    expect(view(html(flow.page(request("GET", "/startup"))))).toBe("startup");
    expect(flow.page(request("DELETE", "/startup"))).toMatchObject({ status: 404 });
    expect(flow.page(request("GET", "/app"))).toBeUndefined();
    flow.complete();
    expect(flow.page(request("GET", "/startup"))).toMatchObject({ status: 404 });
    expect(flow.page(request("POST", "/startup/answers"))).toMatchObject({ status: 404 });
    expect(view(flow.unavailable({ port: 1 }).body)).toBe("not-served");
  });

  it("asks every input in one form, once per token, keeping non-sensitive values when asked again", async () => {
    const flow = new DesktopStartupFlow("Hello");
    const inputs = [input("name", { title: "Your name" }), input("token", { sensitive: true, block: "secrets", id: "secrets.token" })];
    const asked = flow.prompter().askAll!(inputs);
    const page = html(flow.page(request("GET", "/startup")));
    expect(view(page)).toBe("form");
    expect(page).toContain("Your name");
    expect(page).toContain('type="password"');
    const token = /name="_telo\.token" value="([^"]+)"/.exec(page)![1];

    const submit = (body: string): HostResponse => {
      const answered = flow.page(request("POST", "/startup/answers", { "content-type": "application/x-www-form-urlencoded" }));
      if (!answered || !("onBody" in answered)) throw new Error("no body wanted");
      return answered.onBody(Buffer.from(body));
    };
    // Not the form's token: ignored, the window just goes back to the state.
    expect(submit("_telo.token=nope&a0=x&a1=y").status).toBe(303);
    expect(view(html(flow.page(request("GET", "/startup"))))).toBe("form");

    expect(submit(`_telo.token=${token}&a0=Ada&a1=hunter2`).status).toBe(303);
    expect(await asked).toEqual(
      new Map([
        ["variables.name", "Ada"],
        ["secrets.token", "hunter2"],
      ]),
    );
    // The same token again answers nothing: the flow is no longer asking.
    expect(submit(`_telo.token=${token}&a0=Eve&a1=x`).status).toBe(303);

    // Asked again after a refusal: the name is kept, the secret never.
    void flow.prompter().askAll!([input("name", { refusal: "too short" }), inputs[1]]);
    const again = html(flow.page(request("GET", "/startup")));
    expect(again).toContain('value="Ada"');
    expect(again).toContain("too short");
    expect(again).not.toContain("hunter2");
    expect(/name="_telo\.token" value="([^"]+)"/.exec(again)![1]).not.toBe(token);
  });

  it("declines the inputs when the window closes, and refuses a body that is not a form", async () => {
    const flow = new DesktopStartupFlow("Hello");
    const asked = flow.prompter().askAll!([input("name")]);
    expect(flow.page(request("POST", "/startup/answers", { "content-type": "application/json" }))).toMatchObject({ status: 415 });
    flow.declineAsk();
    expect(await asked).toBeUndefined();
  });

  it("reads each input's kind from its declaration", () => {
    expect(fieldKindOf(input("a"))).toEqual({ kind: "text", numeric: false });
    expect(fieldKindOf(input("a", { schema: { type: "integer" } }))).toEqual({ kind: "text", numeric: true });
    expect(fieldKindOf(input("a", { schema: { type: "boolean" } }))).toEqual({ kind: "select", options: ["true", "false"] });
    expect(fieldKindOf(input("a", { schema: { type: "string", enum: ["x", "y"] } }))).toEqual({ kind: "select", options: ["x", "y"] });
    expect(fieldKindOf(input("a", { sensitive: true }))).toEqual({ kind: "password" });
    expect(fieldKindOf(input("a", { schema: { type: "object" } }))).toEqual({ kind: "textarea" });
  });
});
