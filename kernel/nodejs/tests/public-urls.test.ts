import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";
import { withoutHostValues } from "../src/host-values.js";

const app = (needs: string, ports = "  http: { env: PORT, default: 8080 }\n  admin: { env: ADMIN_PORT, default: 8081 }\n") =>
  `kind: Telo.Application
metadata:
  name: Shop
ports:
${ports}needs:
${needs}`;

const THREE = `  site:
    kind: Telo.PublicUrl
    parameters: { port: http, primary: true }
  admin:
    kind: Telo.PublicUrl
    parameters: { port: http }
  status:
    kind: Telo.PublicUrl
    parameters: { port: admin }
`;

const TEMPLATES = {
  TELO_HOST_PUBLIC_URL_TEMPLATE: "https://{port}-s1.example.dev",
  TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE: "https://{label}--{port}-s1.example.dev",
};

async function load(manifest: string, env: Record<string, string>): Promise<Kernel> {
  const memory = new MemorySource();
  memory.set("app", manifest);
  const kernel = new Kernel({ sources: [memory], env });
  await kernel.load("memory://app");
  return kernel;
}

async function failure(manifest: string, env: Record<string, string>): Promise<Error & { code?: string }> {
  try {
    await load(manifest, env);
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected the load to fail");
}

const hosts = (kernel: Kernel) => Object.fromEntries(kernel.addresses.map((a) => [a.need, a.host]));

describe("addresses derived from the host's templates", () => {
  it("gives the primary the base and every other need on that base the secondary template", async () => {
    const kernel = await load(app(THREE), TEMPLATES);
    expect(hosts(kernel)).toEqual({
      site: "8080-s1.example.dev",
      admin: "admin--8080-s1.example.dev",
      status: "8081-s1.example.dev",
    });
  });

  it("announces each port's addresses to a runner", async () => {
    const kernel = await load(app(THREE), TEMPLATES);
    const ports = Object.fromEntries(kernel.getResolvedPorts().map((p) => [p.name, p.publicUrls]));
    expect(ports).toEqual({
      http: [
        { need: "site", host: "8080-s1.example.dev" },
        { need: "admin", host: "admin--8080-s1.example.dev" },
      ],
      admin: [{ need: "status", host: "8081-s1.example.dev" }],
    });
  });

  it("reads a need's own env name before the templates", async () => {
    const kernel = await load(app(THREE), {
      ...TEMPLATES,
      TELO_NEED_ADMIN__URL: "https://admin.shop.example",
    });
    expect(hosts(kernel).admin).toBe("admin.shop.example");
    expect(hosts(kernel).site).toBe("8080-s1.example.dev");
  });

  it("gives no need the base when several share it and none is primary", async () => {
    const needs = THREE.replace(", primary: true", "");
    const kernel = await load(app(needs), TEMPLATES);
    expect(hosts(kernel)).toEqual({
      site: "site--8080-s1.example.dev",
      admin: "admin--8080-s1.example.dev",
      status: "8081-s1.example.dev",
    });
  });

  it("answers only the primary from a template with no {port}", async () => {
    const kernel = await load(app(THREE), {
      TELO_HOST_PUBLIC_URL_TEMPLATE: "https://shop.example",
      TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE: "https://{label}--shop.example",
    });
    expect(hosts(kernel)).toEqual({
      site: "shop.example",
      admin: "admin--shop.example",
      status: "status--shop.example",
    });
  });

  it("leaves a secondary need unanswered with no secondary template", async () => {
    const error = await failure(app(THREE), {
      TELO_HOST_PUBLIC_URL_TEMPLATE: TEMPLATES.TELO_HOST_PUBLIC_URL_TEMPLATE,
    });
    expect(error.code).toBe("ERR_NEED_UNMET");
    expect(error.message).toContain("TELO_NEED_ADMIN__URL");
    expect(error.message).not.toContain("TELO_NEED_SITE__URL");
  });

  it("refuses a template that is not an origin, naming the variable and never its value", async () => {
    const error = await failure(app(THREE), { TELO_HOST_PUBLIC_URL_TEMPLATE: "https://s1.example.dev/app" });
    expect(error.code).toBe("ERR_NEED_HOST_VALUE_INVALID");
    expect(error.message).toContain("TELO_HOST_PUBLIC_URL_TEMPLATE");
    expect(error.message).not.toContain("s1.example.dev/app");
  });

  it("refuses a secondary template without {label}", async () => {
    const error = await failure(app(THREE), {
      ...TEMPLATES,
      TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE: "https://x-{port}.example.dev",
    });
    expect(error.code).toBe("ERR_NEED_HOST_VALUE_INVALID");
    expect(error.message).toContain("{label}");
  });

  it("refuses {label} in the main template", async () => {
    const error = await failure(app(THREE), {
      ...TEMPLATES,
      TELO_HOST_PUBLIC_URL_TEMPLATE: "https://{label}-{port}-s1.example.dev",
    });
    expect(error.code).toBe("ERR_NEED_HOST_VALUE_INVALID");
    expect(error.message).toContain("TELO_HOST_PUBLIC_URL_TEMPLATE");
  });

  it("reads no template when the application declares no public URL", async () => {
    const memory = new MemorySource();
    memory.set("app", "kind: Telo.Application\nmetadata:\n  name: Plain\n");
    const kernel = new Kernel({ sources: [memory], env: { TELO_HOST_PUBLIC_URL_TEMPLATE: "not a url" } });
    await kernel.load("memory://app");
    expect(kernel.addresses).toEqual([]);
  });

  it("refuses a derived first label longer than a DNS label holds", async () => {
    const name = "a".repeat(60);
    const needs = `${THREE}  ${name}:\n    kind: Telo.PublicUrl\n    parameters: { port: http }\n`;
    const error = await failure(app(needs), TEMPLATES);
    expect(error.code).toBe("ERR_NEED_HOST_VALUE_INVALID");
    expect(error.message).toContain(`need '${name}'`);
  });
});

describe("addresses no host could route apart", () => {
  it("refuses two needs on one port with the same host, the port ignored", async () => {
    const error = await failure(app(THREE), {
      TELO_NEED_SITE__URL: "http://localhost:8080",
      TELO_NEED_ADMIN__URL: "http://LOCALHOST:9090",
      TELO_NEED_STATUS__URL: "http://localhost:8081",
    });
    expect(error.code).toBe("ERR_NEED_PUBLIC_URL_COLLISION");
    expect(error.message).toContain("'site' and 'admin'");
    expect(error.message).toContain("'localhost' on port 'http'");
  });

  it("refuses two needs on two ports with the same host and effective port", async () => {
    const error = await failure(app(THREE), {
      TELO_NEED_SITE__URL: "https://shop.example",
      TELO_NEED_ADMIN__URL: "https://admin.shop.example",
      TELO_NEED_STATUS__URL: "https://shop.example:443",
    });
    expect(error.code).toBe("ERR_NEED_PUBLIC_URL_COLLISION");
    expect(error.message).toContain("'site' and 'status'");
  });

  it("accepts one host on two ports reached on different ports", async () => {
    const kernel = await load(app(THREE), {
      TELO_NEED_SITE__URL: "http://localhost:8080",
      TELO_NEED_ADMIN__URL: "http://admin.localhost:8080",
      TELO_NEED_STATUS__URL: "http://localhost:8081",
    });
    expect(hosts(kernel)).toEqual({ site: "localhost", admin: "admin.localhost", status: "localhost" });
  });

  it("refuses two patterns on one port with the same suffix and form", async () => {
    const needs = `  a:
    kind: Telo.PublicHostPattern
    parameters: { port: http }
  b:
    kind: Telo.PublicHostPattern
    parameters: { port: http }
`;
    const error = await failure(app(needs), {
      TELO_NEED_A__PATTERN: "http://*.t.localhost:8080",
      TELO_NEED_B__PATTERN: "https://*.T.localhost",
    });
    expect(error.code).toBe("ERR_NEED_PUBLIC_URL_COLLISION");
    expect(error.message).toContain("host pattern '*.t.localhost'");
  });

  it("tells the two pattern forms apart", async () => {
    const needs = `  a:
    kind: Telo.PublicHostPattern
    parameters: { port: http }
  b:
    kind: Telo.PublicHostPattern
    parameters: { port: http }
`;
    const kernel = await load(app(needs), {
      TELO_NEED_A__PATTERN: "http://*.t.localhost:8080",
      TELO_NEED_B__PATTERN: "http://*-t.localhost:8080",
    });
    expect(kernel.addresses.map((a) => a.pattern)).toEqual([
      { form: "label", suffix: ".t.localhost" },
      { form: "prefix", suffix: "-t.localhost" },
    ]);
  });
});

describe("a URL that is not an origin", () => {
  it.each([
    ["a path", "http://shop.example/app", "its path must be one of /"],
    ["a query", "http://shop.example/?a=1", "it must have no query"],
    ["credentials", "http://me:pw@shop.example", "it must have no user"],
    ["another scheme", "ftp://shop.example", "its scheme must be one of http, https"],
  ])("refuses %s", async (_what, url, reason) => {
    const error = await failure(app("  site:\n    kind: Telo.PublicUrl\n    parameters: { port: http }\n"), {
      TELO_NEED_SITE__URL: url,
    });
    expect(error.code).toBe("ERR_MANIFEST_VALIDATION_FAILED");
    expect(error.message).toContain(reason);
  });
});

describe("a started child application", () => {
  it("inherits no address host value of its parent", () => {
    expect(withoutHostValues({ ...TEMPLATES, PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });
});
