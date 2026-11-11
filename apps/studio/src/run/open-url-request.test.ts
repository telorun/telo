import { describe, expect, it } from "vitest";

import { openAddressFor, type OpenUrlEvent } from "./open-url-request";
import type { RunnerEndpoint } from "./types";

const request: OpenUrlEvent = {
  app: "a",
  generation: 1,
  url: "http://localhost:3000/docs/a?x=1#top",
  reach: "port",
  port: 3000,
};

describe("the address of an open request", () => {
  it("prefers the endpoint's url, joins the path it carries and keeps the request's path, query and fragment", () => {
    const endpoints: RunnerEndpoint[] = [{ host: "ignored", port: 3000, protocol: "tcp", url: "https://app.example.com/base/" }];
    expect(openAddressFor(request, endpoints, null)).toEqual({
      kind: "ready",
      address: "https://app.example.com/base/docs/a?x=1#top",
      host: "app.example.com",
    });
  });

  it("takes the request's scheme with the endpoint's host and port, filling an empty host from the runner", () => {
    const endpoints: RunnerEndpoint[] = [{ host: "", port: 3000, protocol: "tcp" }];
    expect(openAddressFor(request, endpoints, "http://runner.test:9000")).toEqual({
      kind: "ready",
      address: "http://runner.test:3000/docs/a?x=1#top",
      host: "runner.test:3000",
    });
  });

  it("waits while the port has no endpoint, never answering the runner-internal address", () => {
    expect(openAddressFor(request, [{ host: "h", port: 4000, protocol: "tcp" }], "http://runner.test")).toEqual({ kind: "waiting" });
  });

  it("refuses an address that is not http or https", () => {
    expect(openAddressFor({ ...request, url: "javascript:alert(1)" }, [], null).kind).toBe("refused");
  });
});
