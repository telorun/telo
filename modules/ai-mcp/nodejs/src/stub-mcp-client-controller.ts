import type { InvokeContext, ResourceInstance } from "@telorun/sdk";
import { ERR_INVOKE_CANCELLED, InvokeError } from "@telorun/sdk";

/**
 * Test-support Mcp.Client stub. Implements the Mcp.Client JSON-RPC contract with canned
 * responses so AiMcp.ToolProvider's discovery/dispatch can be tested without a live MCP
 * server. Advertises `echo_text` (echoes its `text` argument) and `snapshot_image`
 * (returns an MCP image content block, whose `mimeType` the provider normalizes to the
 * Ai contract's `mediaType`), `wait_for_cancel` (never answers; rejects when the call's
 * context is cancelled, counting it) and `cancelled_count` (how many calls were
 * cancelled so far, so a test can prove the cancellation reached the client).
 *
 * It also offers prompts, listed over two pages: `review` (two arguments, rendered as a
 * user text message and an assistant image message), then `summary` (no arguments)
 * and `hang` (never answers; counted like `wait_for_cancel` when cancelled).
 * `malformation` makes the list, or every render, answer in one malformed way.
 */
interface StubInvokeInput {
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown>; cursor?: string };
}

type Malformation =
  | "promptsMissing"
  | "promptNameMissing"
  | "argumentsMalformed"
  | "cursorNotString"
  | "cursorRepeated"
  | "cursorsEndless"
  | "messagesMissing"
  | "contentMissing";

interface StubMcpClientResource {
  malformation?: Malformation;
}

class StubMcpClient implements ResourceInstance {
  private cancelledCalls = 0;
  private endlessPage = 0;

  constructor(private readonly resource: StubMcpClientResource) {}

  async invoke({ method, params }: StubInvokeInput, ctx?: InvokeContext): Promise<unknown> {
    if (method === "prompts/list") {
      const malformed = this.malformedPromptList();
      if (malformed !== undefined) return malformed;
      if (params?.cursor === undefined) {
        return {
          prompts: [
            {
              name: "review",
              description: "Asks for a code review.",
              arguments: [
                { name: "language", description: "Language the code is written in.", required: true },
                { name: "focus" },
              ],
            },
          ],
          nextCursor: "page-2",
        };
      }
      if (params.cursor === "page-2") {
        return {
          prompts: [
            { name: "summary", description: "Summarises the conversation." },
            { name: "hang", description: "Never answers; ends when the call is cancelled." },
          ],
        };
      }
      throw new InvokeError("ERR_MCP_JSON_RPC_ERROR", `unknown cursor ${params.cursor}`);
    }
    if (method === "prompts/get") {
      if (params?.name === "hang") return this.waitForCancel(ctx);
      if (this.resource.malformation === "messagesMissing") return { description: "no messages" };
      if (this.resource.malformation === "contentMissing") return { messages: [{ role: "user" }] };
      if (params?.name === "summary") {
        return { messages: [{ role: "user", content: { type: "text", text: "Summarise." } }] };
      }
      const args = params?.arguments ?? {};
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Review this ${String(args.language)} code for ${String(args.focus ?? "correctness")}.`,
            },
          },
          { role: "assistant", content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" } },
        ],
      };
    }
    if (method === "tools/list") {
      return {
        tools: [
          {
            name: "echo_text",
            description: "Echo the provided text.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["text"],
              properties: { text: { type: "string" } },
            },
          },
          {
            name: "snapshot_image",
            description: "Return a canned image.",
            inputSchema: { type: "object", additionalProperties: false, properties: {} },
          },
          {
            name: "wait_for_cancel",
            description: "Never answers; ends when the call is cancelled.",
            inputSchema: { type: "object", additionalProperties: false, properties: {} },
          },
          {
            name: "cancelled_count",
            description: "How many calls were cancelled so far.",
            inputSchema: { type: "object", additionalProperties: false, properties: {} },
          },
        ],
      };
    }
    if (method === "tools/call") {
      if (params?.name === "wait_for_cancel") return this.waitForCancel(ctx);
      if (params?.name === "cancelled_count") {
        return { content: [{ type: "text", text: String(this.cancelledCalls) }] };
      }
      if (params?.name === "snapshot_image") {
        return { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] };
      }
      const text = (params?.arguments?.text as string) ?? "";
      return { content: [{ type: "text", text: `echoed: ${text}` }] };
    }
    return {};
  }

  private malformedPromptList(): unknown {
    switch (this.resource.malformation) {
      case "promptsMissing":
        return { items: [] };
      case "promptNameMissing":
        return { prompts: [{ description: "A prompt without a name." }] };
      case "argumentsMalformed":
        return { prompts: [{ name: "review", arguments: "language" }] };
      case "cursorNotString":
        return { prompts: [], nextCursor: 7 };
      case "cursorRepeated":
        return { prompts: [], nextCursor: "again" };
      case "cursorsEndless":
        return { prompts: [], nextCursor: `page-${++this.endlessPage}` };
      default:
        return undefined;
    }
  }

  private waitForCancel(ctx: InvokeContext | undefined): Promise<never> {
    const token = ctx?.cancellation;
    if (!token) throw new Error("a never-answering call needs an invocation context to end");
    return new Promise((_, reject) => {
      // Stands for the open connection a real in-flight call holds, which is
      // what keeps the process alive while it waits.
      const inFlight = setInterval(() => undefined, 60_000);
      token.onCancelled((reason) => {
        clearInterval(inFlight);
        this.cancelledCalls++;
        reject(new InvokeError(ERR_INVOKE_CANCELLED, `cancelled (${reason})`));
      });
    });
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: StubMcpClientResource): Promise<StubMcpClient> {
  return new StubMcpClient(resource);
}

