import type { ResourceInstance } from "@telorun/sdk";
import { authorizationHeader, credentialMalformed, TOKEN68, type CredentialRequest } from "./credential-source.js";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function register(): void {}

export async function create(): Promise<ResourceInstance> {
  return {
    async invoke(inputs: Record<string, any>) {
      const header = authorizationHeader(inputs as CredentialRequest);
      if (!header || header.scheme.toLowerCase() !== "basic") return null;
      if (!TOKEN68.test(header.rest)) {
        throw credentialMalformed("The Authorization header names the Basic scheme but carries no credentials");
      }
      let decoded: string;
      try {
        decoded = UTF8.decode(Buffer.from(header.rest, "base64"));
      } catch {
        throw credentialMalformed("The Basic credentials are not UTF-8");
      }
      const colon = decoded.indexOf(":");
      if (colon < 0) throw credentialMalformed("The Basic credentials hold no ':' between user and password");
      return { type: "basic", username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
    },
    snapshot() {
      return { schemes: ["Basic"] };
    },
  };
}
