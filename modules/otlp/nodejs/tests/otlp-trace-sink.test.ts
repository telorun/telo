import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  NOOP_LOGGER,
  type ResourceContext,
  type SpanRecord,
  type TraceSinkInstance,
} from "@telorun/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { create } from "../src/otlp-trace-sink-controller.js";

/** A collector's traces endpoint, running inside the test: every POST body it
 *  receives is kept, parsed. */
async function receiver(): Promise<{ url: string; bodies: any[]; server: Server }> {
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      bodies.push({ path: request.url, body: JSON.parse(text) });
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1/traces`, bodies, server };
}

function stubContext(): ResourceContext {
  return { logging: { recordDrop: () => {} }, log: NOOP_LOGGER } as unknown as ResourceContext;
}

let open: Server | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
});

describe("OTLP.TraceSink", () => {
  it("exports finished spans to the traces endpoint as OTLP/JSON", async () => {
    const collector = await receiver();
    open = collector.server;
    const sink = (await create(
      {
        endpoint: collector.url,
        resourceAttributes: { "service.name": "authoring-agent" },
        metadata: { name: "traces" },
      },
      stubContext(),
    )) as unknown as TraceSinkInstance;

    const span: SpanRecord = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      parentSpanId: "00f067aa0ba902b6",
      name: "execute_tool write_file",
      startTime: 1_770_000_000_123_456_000n,
      endTime: 1_770_000_000_223_456_000n,
      outcome: "rejected",
      attributes: { "gen_ai.tool.name": "write_file", "error.type": "ERR_PATH_OUTSIDE_WORKSPACE" },
    };
    sink.write(span);
    await sink.flush();
    await sink.close();

    expect(collector.bodies).toHaveLength(1);
    const { path, body } = collector.bodies[0];
    expect(path).toBe("/v1/traces");
    const resource = body.resourceSpans[0];
    expect(resource.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "authoring-agent" } },
    ]);
    expect(resource.scopeSpans[0].spans).toEqual([
      {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        parentSpanId: "00f067aa0ba902b6",
        name: "execute_tool write_file",
        kind: 1,
        // 64-bit times are decimal strings, as in every OTLP/JSON body.
        startTimeUnixNano: "1770000000123456000",
        endTimeUnixNano: "1770000000223456000",
        attributes: [
          { key: "gen_ai.tool.name", value: { stringValue: "write_file" } },
          { key: "error.type", value: { stringValue: "ERR_PATH_OUTSIDE_WORKSPACE" } },
          { key: "telo.span.outcome", value: { stringValue: "rejected" } },
        ],
        status: { code: 2, message: "ERR_PATH_OUTSIDE_WORKSPACE" },
      },
    ]);
  });
});
