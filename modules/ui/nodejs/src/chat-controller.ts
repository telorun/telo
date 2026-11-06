import { canonicalTypeSchemaId, type ResourceContext, type ResourceInstance, type RuntimeResource } from "@telorun/sdk";
import { buttonSpec, providedButton, type ButtonDisplay, type ButtonSpec } from "./button-display.js";
import { addressSpec, type AddressConfig } from "./address-spec.js";
import { mergeAssets, type AssetFile, type Provided, type SpecNode } from "./composite.js";
import { isConversationSource } from "./conversation-source.js";
import { filledProvided } from "./fill-marking.js";
import { modelShape, type ShapeReader } from "./model-schema.js";
import { resolveNode, type AuthoredNode, type RootShapes } from "./node-resolution.js";
import { uiText } from "./spec-texts.js";

const SWITCHES = ["reasoning", "toolDetail", "usage", "copy"] as const;
const BUTTONS = ["copy", "edit", "regenerate", "attach", "send", "stop"] as const;
/** The commands a chat's header binds under `chat`. */
const COMMANDS = ["exportTranscript", "copyTranscript", "stop", "newConversation"] as const;
/** The buttons on a message, drawn as the look's glyph unless named. */
const MESSAGE_BUTTONS: readonly string[] = ["copy", "edit", "regenerate"];
type ButtonKey = (typeof BUTTONS)[number];

type ChatResource = RuntimeResource & {
  source: unknown;
  header?: AuthoredNode[] | null;
  placeholder?: unknown;
  starters?: unknown[] | null;
  show?: Partial<Record<(typeof SWITCHES)[number], boolean | null>> | null;
  buttons?: Partial<Record<ButtonKey, unknown>> | null;
  composer?: { actions?: "inside" | "outside" | null } | null;
  conversation?: { parameter: string } | null;
  refreshes?: AddressConfig[] | null;
};

/** The header drawn when the author writes none: a bar whose end holds the export command, drawn by its text (a command's default display). */
const DEFAULT_HEADER: AuthoredNode[] = [{ type: "bar", end: [{ type: "command", command: { root: "chat", path: ["exportTranscript"] }, text: uiText("chatExport") }] }];

const isStarterObject = (starter: unknown): starter is { prompt: unknown; onChoose?: "send" | "fill" } =>
  typeof starter === "object" && starter !== null && "prompt" in starter;

/** One conversation drawn as a chat: the spec the endpoint offers, where it is
 *  served, and every presentation member with `ui`'s defaults filled. */
class Chat implements ResourceInstance {
  constructor(
    private readonly resource: ChatResource,
    private readonly ctx: ResourceContext,
  ) {}

  /** Every button's display, a message button left out drawn as a glyph, any other as its text, and each icon file served. */
  private async buttons(owner: string, assets: AssetFile[]): Promise<Record<ButtonKey, ButtonSpec>> {
    const drawn = {} as Record<ButtonKey, ButtonSpec>;
    for (const key of BUTTONS) {
      const written = this.resource.buttons?.[key];
      const display: ButtonDisplay =
        written == null
          ? MESSAGE_BUTTONS.includes(key)
            ? { type: "icon", icon: null, label: "hidden" }
            : { type: "text" }
          : await providedButton(written, this.ctx, () => `'buttons.${key}' of ${owner}`);
      const button = await buttonSpec(display, owner, `buttons.${key}.icon`);
      assets.push(...button.assets);
      drawn[key] = button.spec;
    }
    return drawn;
  }

  /** The header's nodes over its two roots, each delivered one resolved and its files served. */
  private async header(owner: string, assets: AssetFile[]): Promise<SpecNode[]> {
    const reader: ShapeReader = { ctx: this.ctx, owner };
    const roots: RootShapes = {
      conversation: modelShape({ $ref: canonicalTypeSchemaId("Conversations", "ConversationSummary") }, reader, "header conversation"),
      chat: modelShape(
        {
          type: "object",
          properties: Object.fromEntries(COMMANDS.map((command) => [command, { $ref: canonicalTypeSchemaId("Ui", "Command") }])),
          additionalProperties: false,
        },
        reader,
        "header chat",
      ),
    };
    const nodes: SpecNode[] = [];
    for (const [index, written] of (this.resource.header ?? DEFAULT_HEADER).entries()) {
      const resolved = await resolveNode(written, this.ctx, `${owner} header[${index}]`, roots);
      if (!resolved?.node) continue;
      nodes.push(resolved.node);
      assets.push(...resolved.assets);
    }
    return nodes;
  }

  async provide(): Promise<Provided> {
    const resource = this.resource;
    const owner = `Ui.Chat '${resource.metadata.name}'`;
    const source = this.ctx.resolveRef(resource.source, isConversationSource, () => `'source' of ${owner}`, "Ui.ConversationSource");
    const show = resource.show ?? {};
    const assets: AssetFile[] = [];
    const buttons = await this.buttons(owner, assets);
    const header = await this.header(owner, assets);
    return filledProvided({
      node: {
        type: "chat",
        spec: await source.spec(),
        basePath: source.basePath,
        header,
        placeholder: resource.placeholder ?? null,
        starters: (resource.starters ?? []).map(starter => isStarterObject(starter) ? { prompt: starter.prompt, onChoose: starter.onChoose ?? "send" } : { prompt: starter, onChoose: "send" }),
        show: {
          reasoning: show.reasoning ?? true,
          toolDetail: show.toolDetail ?? true,
          usage: show.usage ?? true,
          copy: show.copy ?? true,
        },
        buttons,
        composer: { actions: resource.composer?.actions ?? "inside" },
        conversation: resource.conversation == null ? null : { parameter: resource.conversation.parameter },
        refreshes: (resource.refreshes ?? []).map((refresh, index) => addressSpec(refresh, this.ctx, `${owner} refreshes[${index}]`)),
      },
      assets: mergeAssets(assets),
    });
  }
}

export async function create(resource: ChatResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Chat(resource, ctx);
}
