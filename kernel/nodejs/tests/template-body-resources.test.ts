import { isCelMap } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { TemplateBodyResources, type FamilyPlace } from "../src/template-body-resources.js";

const places = (entries: [string, FamilyPlace][]) => new Map(entries);

describe("a template instance's resources record", () => {
  it("gathers a family's members under its name by element key, and layers over the module's readings", () => {
    const record = new TemplateBodyResources();
    record.declareFamilies(
      places([
        ["crons['a']", { family: "crons", keys: ["a"] }],
        ["slots[0]", { family: "slots", keys: [0] }],
        ["ops['users']['list']", { family: "ops", keys: ["users", "list"] }],
      ]),
    );
    record.publish("crons['a']", { status: { n: 1 } });
    record.publish("slots[0]", { status: { n: 2 } });
    record.publish("ops['users']['list']", { status: { n: 3 } });
    record.publish("server", { url: "u" });

    const merged = record.merged({ server: { url: "module" }, other: { x: 1 } }) as Record<string, any>;
    expect(merged.crons.a).toEqual({ status: { n: 1 } });
    expect(isCelMap(merged.slots)).toBe(true);
    expect(merged.slots.entries.get(0n).value).toEqual({ status: { n: 2 } });
    expect(merged.ops.users.list).toEqual({ status: { n: 3 } });
    expect(merged.server).toEqual({ url: "u" });
    expect(merged.other).toEqual({ x: 1 });
    expect("crons['a']" in merged).toBe(false);
  });

  it("shows a republished reading on the next read, and shares nothing between instances", () => {
    const first = new TemplateBodyResources();
    const second = new TemplateBodyResources();
    for (const record of [first, second]) {
      record.declareFamilies(places([["f['k']", { family: "f", keys: ["k"] }]]));
      record.publish("f['k']", { v: 1 });
      record.publish("plain", { v: 1 });
    }
    const held = first.merged({}) as Record<string, any>;
    first.publish("f['k']", { v: 2 });
    first.publish("plain", { v: 2 });

    const now = first.merged({}) as Record<string, any>;
    expect(now.f.k).toEqual({ v: 2 });
    expect(now.plain).toEqual({ v: 2 });
    expect(held.f.k).toEqual({ v: 2 });
    expect((second.merged({}) as Record<string, any>).f.k).toEqual({ v: 1 });
  });

  it("lets a site bind its own record for a while, and restores the live one afterwards", () => {
    const record = new TemplateBodyResources();
    record.publish("a", { v: 1 });
    const descriptor = record.descriptor(() => ({}));
    const live = descriptor.get!() as Record<string, unknown>;
    const own = { own: true };

    descriptor.set!(own);
    expect(descriptor.get!()).toBe(own);
    descriptor.set!(live);
    record.publish("a", { v: 2 });
    expect((descriptor.get!() as Record<string, any>).a).toEqual({ v: 2 });
  });

  it("publishes a member in constant time whatever the family's size", () => {
    const time = (members: number): number => {
      const record = new TemplateBodyResources();
      const table = new Map<string, FamilyPlace>();
      for (let i = 0; i < members; i++) table.set(`f['k${i}']`, { family: "f", keys: [`k${i}`] });
      record.declareFamilies(table);
      const start = performance.now();
      for (let round = 0; round < 3; round++) {
        for (const name of table.keys()) record.publish(name, { status: { round } });
      }
      return performance.now() - start;
    };
    time(1000);
    const perMember = (members: number) => time(members) / members;
    const small = Math.max(perMember(10), perMember(10));
    expect(perMember(1000)).toBeLessThan(small * 20 + 0.01);
  });
});
