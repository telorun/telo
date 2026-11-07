import { describe, expect, it } from "vitest";
import { localUrlOf } from "../src/local-url.js";

describe("localUrlOf", () => {
  it.each([
    ["http", "0.0.0.0", 8080, "http://localhost:8080"],
    ["http", "::", 8080, "http://localhost:8080"],
    ["https", "0.0.0.0", 8443, "https://localhost:8443"],
    ["http", "127.0.0.1", 3000, "http://127.0.0.1:3000"],
    ["http", "::1", 3000, "http://[::1]:3000"],
    ["http", "fe80::33:50ff:fe8d:aa9f%br0", 8995, "http://[fe80::33:50ff:fe8d:aa9f]:8995"],
    ["http", "example.test", 80, "http://example.test:80"],
  ] as const)("%s %s:%d", (scheme, address, port, expected) => {
    expect(localUrlOf(scheme, address, port)).toBe(expected);
  });
});
