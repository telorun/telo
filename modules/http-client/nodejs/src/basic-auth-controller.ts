import { InvokeError } from "@telorun/sdk";
import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { requireCredentialMaterial, type CredentialOutputs } from "./credential-material.js";

interface BasicAuthManifest {
  metadata: { name: string; module?: string };
  username?: string;
  password?: string;
}

/** RFC 7617: `Authorization: Basic base64(username:password)`, UTF-8 encoded. */
class BasicAuth implements ResourceInstance<unknown, CredentialOutputs> {
  constructor(private readonly resource: BasicAuthManifest) {}

  async invoke(): Promise<CredentialOutputs> {
    const name = this.resource.metadata.name;
    const username = requireCredentialMaterial(
      this.resource.username,
      "Http.BasicAuth",
      name,
      "username",
    );
    if (username.includes(":")) {
      throw new InvokeError(
        "ERR_INVALID_CREDENTIAL",
        `Http.BasicAuth "${name}": 'username' must not contain ':'.`,
      );
    }
    const password = this.resource.password ?? "";
    const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    return { headers: { authorization: `Basic ${encoded}` } };
  }

  /** The username is configuration and readable; the password is not. */
  snapshot(): Record<string, unknown> {
    return { username: this.resource.username ?? "" };
  }
}

export function register(): void {}

export async function create(
  resource: BasicAuthManifest,
  _ctx: ResourceContext,
): Promise<BasicAuth> {
  return new BasicAuth(resource);
}
