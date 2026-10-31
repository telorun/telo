import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * A family member keeps its name when `kernel.reconcile()` re-creates a templated
 * instance no `targets:` chain holds: it is named by its family and its element's
 * key, whatever the element's position, in the registry, in spans and in events.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.resolve(here, "../../../modules/run");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const app = (jobs: string) => `kind: Telo.Application
metadata: { name: FamilyReconcile }
imports:
  Run: ${RUN}
logging:
  sinks:
    - kind: Telo.ConsoleSink
      destination: stdout
      encoding: json
tracing:
  sinks:
    - kind: Telo.LogTraceSink
---
kind: Telo.Definition
metadata: { name: Values }
capability: Telo.Service
schema:
  type: object
  required: [items]
  properties:
    items:
      type: object
      additionalProperties:
        type: object
        required: [text]
        properties:
          text: { type: string }
resources:
  - !for-each
    metadata: { name: vals }
    in: !cel "self.items"
    emit:
      kind: Run.Value
      value: !cel "each.value.text"
---
kind: Self.Values
metadata: { name: instance }
items:
${jobs}
`;

const item = (key: string, text: string) => `  ${key}: { text: ${text} }\n`;

async function bootApp(text: string) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telo-family-reconcile-")));
  dirs.push(dir);
  const appPath = path.join(dir, "telo.yaml");
  await fs.writeFile(appPath, text);
  const chunks: string[] = [];
  const stdout = { write: (chunk: string) => void chunks.push(String(chunk)) } as never;
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {}, stdout });
  const events: string[] = [];
  kernel.on("*", (event) => void events.push(String(event.name)));
  await kernel.load(appPath);
  await kernel.boot();
  const spanNames = () =>
    chunks
      .join("")
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((record) => record.event_name === "telo.span")
      .map((record) => record.attributes?.["telo.resource.name"] as string);
  return { kernel, appPath, events, spanNames };
}

/** The contexts registering the family's members: the instance's child context. */
function holder(kernel: Kernel): any {
  const walk = (context: any): any => {
    for (const key of context.resourceInstances.keys() as Iterable<string>) if (key.includes("vals[")) return context;
    for (const child of context.children) {
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  };
  return walk((kernel as unknown as { rootContext: any }).rootContext);
}

const members = (kernel: Kernel): string[] =>
  [...(holder(kernel)?.resourceInstances.keys() as Iterable<string>)].filter((k) => k.includes("vals[")).sort();

/** Dispatch member `a` through the context that holds it. */
const invokeA = (kernel: Kernel): Promise<unknown> => holder(kernel).invoke("Run.Value", "vals['a']", {});

describe("a family member's identity across kernel.reconcile()", () => {
  it("is the same text in the registry, spans and events after an edit, an insertion before it and a removal", async () => {
    const { kernel, appPath, events, spanNames } = await bootApp(app(item("a", "one") + item("b", "two")));
    try {
      expect(members(kernel)).toEqual(["vals['a']", "vals['b']"]);
      expect(await invokeA(kernel)).toBe("one");

      const reconcileTo = async (items: string) => {
        await fs.writeFile(appPath, app(items));
        const outcome = await kernel.reconcile();
        expect(outcome.restartRequired).toBeUndefined();
        expect(outcome.reinitialized).toContain("instance");
        return outcome;
      };

      // A field edit.
      await reconcileTo(item("a", "uno") + item("b", "two"));
      expect(members(kernel)).toEqual(["vals['a']", "vals['b']"]);
      expect(await invokeA(kernel)).toBe("uno");

      // An element inserted before `a`.
      await reconcileTo(item("z", "zed") + item("a", "uno") + item("b", "two"));
      expect(members(kernel)).toEqual(["vals['a']", "vals['b']", "vals['z']"]);
      expect(await invokeA(kernel)).toBe("uno");

      // `b` removed: gone, and `a`, re-registered each time, carries no withdrawal mark.
      await reconcileTo(item("z", "zed") + item("a", "uno"));
      expect(members(kernel)).toEqual(["vals['a']", "vals['z']"]);
      expect(await invokeA(kernel)).toBe("uno");

      expect(new Set(spanNames())).toEqual(new Set(["vals['a']"]));
      const eventNames = events.filter((name) => name.includes("vals["));
      expect(eventNames.length).toBeGreaterThan(0);
      expect(eventNames.every((name) => /vals\['[abz]'\]/.test(name))).toBe(true);
      expect(eventNames.some((name) => name.includes("vals['a']"))).toBe(true);
      expect(eventNames.some((name) => name.includes("vals['b']") && name.endsWith(".Teardown"))).toBe(true);
    } finally {
      await kernel.teardown();
    }
  }, 60_000);
});
