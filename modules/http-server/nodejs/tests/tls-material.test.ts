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
    expect(options.minVersion).toBe("TLSv1.2");
  });

  it("raises the protocol floor when asked", () => {
    expect(resolveHttpsOptions({ ...server, minVersion: "TLSv1.3" }).minVersion).toBe("TLSv1.3");
  });

  it("requires client certificates when asked", () => {
    const clientCa = [{ pem: text("ca.pem") }];
    expect(resolveHttpsOptions({ ...server, clientCa, clientCertificate: "required" })).toMatchObject({
      requestCert: true,
      rejectUnauthorized: false,
      requireVerifiedClient: true,
    });
  });

  it("asks for client certificates without refusing a connection under optional", () => {
    const clientCa = [{ pem: text("ca.pem") }];
    expect(resolveHttpsOptions({ ...server, clientCa, clientCertificate: "optional" })).toMatchObject({
      requestCert: true,
      rejectUnauthorized: false,
      requireVerifiedClient: false,
    });
  });

  it("refuses inconsistent settings", () => {
    expect(() => resolveHttpsOptions({ ...server, clientCertificate: "optional" })).toThrow(/clientCa/);
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
