import type { RefFieldInfo } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { buildNodePorts } from "./node-ports";

const field = (
  path: string,
  capabilities: string[],
  isArray = path.includes("[]"),
  refs: string[] = ["mod#T"],
): RefFieldInfo => ({ path, isArray, refs, capabilities });

describe("buildNodePorts", () => {
  it("renders a single ref as one edge port, slot empty when unfilled", () => {
    const ports = buildNodePorts([field("client", ["Telo.Invocable"], false)], {});
    expect(ports).toEqual([
      {
        key: "client",
        label: "client",
        flavor: "edge",
        refs: ["mod#T"],
        capabilities: ["Telo.Invocable"],
        slots: [{ concretePath: "client", target: undefined }],
      },
    ]);
  });

  it("renders an ambient single ref as a picker port", () => {
    const ports = buildNodePorts([field("encoder", ["Telo.Provider"], false)], {
      encoder: { kind: "codec.Json", name: "e" },
    });
    expect(ports[0]).toMatchObject({ flavor: "picker", slots: [{ concretePath: "encoder", target: "e" }] });
  });

  it("renders an array-of-refs as a slot per item plus an add slot, folding anyOf sub-shapes", () => {
    const ports = buildNodePorts(
      [
        field("targets[]", ["Telo.Runnable"]),
        field("targets[].invoke", ["Telo.Invocable"]),
        field("targets[].ref", ["Telo.Runnable"]),
      ],
      { targets: ["w", { name: "step", invoke: { kind: "m.A", name: "x" } }] },
    );
    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatchObject({
      key: "targets[]",
      flavor: "edge",
      slots: [
        { concretePath: "targets[0]", target: "w" },
        { concretePath: "targets[1]", target: "x" },
      ],
      addPath: "targets[2]",
    });
  });

  it("renders a ref inside an array of objects as a slot per item plus an add slot", () => {
    const ports = buildNodePorts([field("mounts[].type", ["Telo.Mount"])], {
      mounts: [{ type: { kind: "m.Api", name: "a0" } }, { path: "/no-type" }],
    });
    expect(ports[0]).toMatchObject({
      key: "mounts[].type",
      // No schema → label falls back to the array field name, not the inner ref.
      label: "mounts",
      slots: [
        { concretePath: "mounts[0].type", target: "a0" },
        { concretePath: "mounts[1].type", target: undefined },
      ],
      addPath: "mounts[2].type",
    });
  });

  it("excludes refs that live under the node's step topology field", () => {
    const ports = buildNodePorts(
      [field("steps[].invoke", ["Telo.Invocable"])],
      { steps: [{ invoke: { name: "a" } }] },
      "steps",
    );
    expect(ports).toEqual([]);
  });

  it("drops fields whose constraint resolves to no node/ambient capability", () => {
    expect(buildNodePorts([field("opaque", [], false)], {})).toEqual([]);
  });

  it("labels a port from the schema title, preferring the wrapper over a dispatch key", () => {
    const schema = {
      type: "object",
      properties: {
        notFoundHandler: {
          title: "Not Found Handler",
          type: "object",
          properties: { invoke: { title: "Invoke" } },
        },
        encoder: { title: "Encoder" },
      },
    };
    const ports = buildNodePorts(
      [
        field("notFoundHandler.invoke", ["Telo.Invocable"], false),
        field("encoder", ["Telo.Provider"], false),
      ],
      {},
      null,
      schema,
    );
    expect(ports.find((p) => p.key === "notFoundHandler.invoke")?.label).toBe("Not Found Handler");
    expect(ports.find((p) => p.key === "encoder")?.label).toBe("Encoder");
  });
});
