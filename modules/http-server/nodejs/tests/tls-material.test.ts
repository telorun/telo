import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TlsMaterialError, resolveHttpsOptions } from "../src/tls-material.js";

const dir = fileURLToPath(new URL("../../tests/__fixtures__/tls/", import.meta.url));
const text = (name: string) => readFileSync(dir + name, "utf8");
const server = { cert: { pem: text("server.pem") }, key: { pem: text("server.key") } };

describe("resolveHttpsOptions", () => {
  it("serves plain TLS without asking for client certificates", () => {
    const options = resolveHttpsOptions(server);
    expect(options.requestCert).toBeUndefined();
  });

  it("requires client certificates when asked", () => {
    const clientCa = [{ pem: text("ca.pem") }];
    expect(resolveHttpsOptions({ ...server, clientCa, clientCertificate: "required" })).toMatchObject({
      requestCert: true,
      rejectUnauthorized: true,
    });
  });

  it("refuses inconsistent settings", () => {
    expect(() => resolveHttpsOptions({ ...server, clientCertificate: "required" })).toThrow(/clientCa/);
    expect(() => resolveHttpsOptions({ ...server, clientCa: [{ pem: text("ca.pem") }] })).toThrow(/'none'/);
  });

  it("refuses a mismatched key without echoing it", () => {
    const key = text("client.key");
    try {
      resolveHttpsOptions({ cert: server.cert, key: { pem: key } });
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(TlsMaterialError);
      expect((err as Error).message).not.toContain(key.split("\n")[1]);
    }
  });
});
