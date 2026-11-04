import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { DEFAULT_ATTACHMENT_BOUNDS } from "../src/conversation-controller.js";
import { DROPPED_PARTS, PART_EVENTS } from "../src/part-events.js";

function documents(path: string): Array<Record<string, any>> {
  const text = readFileSync(new URL(path, import.meta.url), "utf8");
  // Tags are irrelevant to the shapes read here; each tagged node reads as its text.
  const customTags = ["cel", "ref", "interpolate", "sql"].map((tag) => ({
    tag: `!${tag}`,
    resolve: (value: string) => value,
  }));
  return parseAllDocuments(text, { customTags }).map((doc) => doc.toJS() as Record<string, any>);
}

const named = (docs: Array<Record<string, any>>, name: string) => {
  const doc = docs.find((d) => d.metadata?.name === name);
  if (!doc) throw new Error(`no document named ${name}`);
  return doc;
};

const aiDocs = documents("../../../ai/telo.yaml");
const conversationDocs = documents("../../../conversation/telo.yaml");
const chatDocs = documents("../../telo.yaml");

describe("ai-chat against the manifests it serves", () => {
  it("maps every agent stream part type to an event, or drops it by name", () => {
    const partTypes: string[] = named(aiDocs, "AgentStreamPart").schema.properties.type.enum;
    const eventTypes = (named(conversationDocs, "Event").schema.oneOf as Array<Record<string, any>>).map(
      (branch) => branch.properties.type.const,
    );
    const mapped = Object.keys(PART_EVENTS);
    const dropped: readonly string[] = DROPPED_PARTS;
    expect(partTypes.filter((type) => !mapped.includes(type) && !dropped.includes(type))).toEqual([]);
    expect(mapped.filter((type) => dropped.includes(type))).toEqual([]);
    expect([...mapped, ...dropped].filter((type) => !partTypes.includes(type))).toEqual([]);
    expect(Object.values(PART_EVENTS).filter((type) => !eventTypes.includes(type))).toEqual([]);
  });

  it("takes exactly the conversation contract's turn request beside the idempotency key", () => {
    const own = structuredClone(named(chatDocs, "StartTurn").inputType.schema);
    delete own.properties.idempotencyKey;
    expect(own).toEqual(named(conversationDocs, "TurnRequest").schema);
  });

  it("holds the api's request bodies equal to the contract's shapes", () => {
    const routes = (named(chatDocs, "Api").resources as Array<Record<string, any>>).find((r) => r.kind === "Http.Api")!.routes;
    const body = (operationId: string) => routes.find((route: any) => route.operationId === operationId).request.schema.body;
    expect(body("startTurn")).toEqual(named(conversationDocs, "TurnRequest").schema);
    expect(body("updateConversation")).toEqual(named(conversationDocs, "ConversationPatch").schema);
  });

  it("applies the attachment bounds its schema declares as defaults", () => {
    const bounds = named(chatDocs, "Conversation").schema.properties.attachments.properties;
    expect({ maxBytes: bounds.maxBytes.default, maxPerMessage: bounds.maxPerMessage.default }).toEqual(
      DEFAULT_ATTACHMENT_BOUNDS,
    );
  });
});
