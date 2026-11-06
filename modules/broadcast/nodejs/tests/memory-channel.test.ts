import type { ResourceContext } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { create, registeredChannelCount } from "../src/memory-channel-controller.js";

const resource = {
  metadata: { name: "bus" },
  name: "events",
  messageType: { schema: { type: "object" } },
};
const ctxOf = (kernelInstanceId?: string) => ({ kernelInstanceId }) as unknown as ResourceContext;

describe("MemoryChannel", () => {
  it("delivers within one kernel instance only and holds no entry once the last listener leaves", async () => {
    const heard: string[] = [];
    const listener = (label: string) => ({ receive: () => void heard.push(label), gap: () => {} });
    const first = await create(resource, ctxOf("app-1"));
    const sameApp = await create(resource, ctxOf("app-1"));
    const otherApp = await create(resource, ctxOf("app-2"));
    const handles = [
      first.subscribe(listener("first")),
      sameApp.subscribe(listener("same")),
      otherApp.subscribe(listener("other")),
    ];
    await first.publish("{}");
    expect(heard.sort()).toEqual(["first", "same"]);
    expect(registeredChannelCount()).toBe(2);
    for (const handle of handles) await handle.close();
    expect(registeredChannelCount()).toBe(0);
  });

  it("refuses a host that names no kernel instance", async () => {
    await expect(create(resource, ctxOf(undefined))).rejects.toMatchObject({
      code: "ERR_CONTROLLER_HOST_INCOMPATIBLE",
    });
  });
});
