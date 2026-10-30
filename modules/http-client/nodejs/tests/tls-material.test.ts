import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rootCertificates } from "node:tls";
import { describe, expect, it } from "vitest";
import { TlsMaterialError, resolveConnectOptions } from "../src/tls-material.js";

const dir = fileURLToPath(new URL("../../tests/__fixtures__/tls/", import.meta.url));
const text = (name: string) => readFileSync(dir + name, "utf8");

describe("resolveConnectOptions", () => {
  it("replaces the system roots by default and adds to them on request", () => {
    const ca = { pem: text("ca.pem") };
    expect(resolveConnectOptions({ ca: [ca] }).ca).toEqual([text("ca.pem").trim()]);
    const added = resolveConnectOptions({ ca: [ca], caMode: "add" }).ca!;
    expect(added).toHaveLength(rootCertificates.length + 1);
  });

  it("reads files and inline text alike", () => {
    const options = resolveConnectOptions({
      cert: { file: dir + "client.pem" },
      key: { pem: text("client.key") },
      serverName: "x.test",
    });
    expect(options.servername).toBe("x.test");
    expect(options.key).toBe(text("client.key"));
  });

  it("refuses a key that does not match the certificate, without echoing the key", () => {
    const key = text("rogue-client.key");
    let thrown: unknown;
    try {
      resolveConnectOptions({ cert: { pem: text("client.pem") }, key: { pem: key } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TlsMaterialError);
    expect((thrown as Error).message).toContain("does not match");
    expect((thrown as Error).message).not.toContain(key.split("\n")[1]);
  });

  it("refuses unparseable PEM and unreadable files", () => {
    expect(() => resolveConnectOptions({ ca: [{ pem: "nonsense" }] })).toThrow(/no PEM certificate/);
    expect(() =>
      resolveConnectOptions({ ca: [{ pem: "-----BEGIN CERTIFICATE-----\nxx\n-----END CERTIFICATE-----" }] }),
    ).toThrow(/not valid PEM/);
    expect(() => resolveConnectOptions({ ca: [{ file: dir + "missing.pem" }] })).toThrow(/cannot read/);
    expect(() => resolveConnectOptions({ cert: { pem: text("client.pem") }, key: { pem: "junk" } })).toThrow(
      /not a valid PEM private key/,
    );
  });

  it("needs cert and key together, and exactly one source per item", () => {
    expect(() => resolveConnectOptions({ cert: { pem: text("client.pem") } })).toThrow(/together/);
    expect(() => resolveConnectOptions({ ca: [{ pem: "a", file: "b" }] })).toThrow(/exactly one/);
  });

  it("turns verification off only when asked", () => {
    expect(resolveConnectOptions({}).rejectUnauthorized).toBeUndefined();
    expect(resolveConnectOptions({ insecureSkipVerify: true }).rejectUnauthorized).toBe(false);
  });
});
