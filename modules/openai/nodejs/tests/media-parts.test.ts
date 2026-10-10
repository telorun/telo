import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentPart, Message } from "@telorun/ai";

import * as chat from "../src/openai-chat-controller.js";
import * as responses from "../src/openai-responses-controller.js";

// Which media parts each dialect carries, how each lands on the wire, and what
// is refused before anything is sent. The stub is the injected `Http.Request`:
// it records the request the controller built, so "no request was made" is an
// assertion about the stub rather than an inference.

let requestMock: ReturnType<typeof vi.fn>;

const CHAT_ANSWER = {
  choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};
const RESPONSES_ANSWER = {
  status: "completed",
  output: [],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};

const resource = () =>
  ({ metadata: { name: "T" }, model: "gpt-test", request: { invoke: requestMock } }) as never;

const kinds = {
  chat: () => chat.create(resource(), {} as never),
  chatStream: () => chat.createStream(resource(), {} as never),
  responses: () => responses.create(resource(), {} as never),
  responsesStream: () => responses.createStream(resource(), {} as never),
};

function sentBody(): Record<string, unknown> {
  const call = requestMock.mock.calls.at(-1);
  if (!call) throw new Error("the request was not invoked");
  return (call[0] as { body: Record<string, unknown> }).body;
}

const user = (...content: ContentPart[]): Message[] => [{ role: "user", content }];

const PNG: ContentPart = { type: "image", mediaType: "image/png", data: "aGk=" };
const PDF: ContentPart = {
  type: "file",
  mediaType: "application/pdf",
  name: "report.pdf",
  data: new Uint8Array([104, 105]),
};
const IMAGE_URL = "https://example.com/a%20b.png?sig=A%2Fb&x=1#frag";
const FILE_URL = "http://example.com/files/report.pdf?v=2";

const toolTurn = (...content: ContentPart[]): Message[] => [
  { role: "user", content: "fetch it" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "fetch", arguments: {} }] },
  { role: "tool", toolCallId: "c1", content },
];

beforeEach(() => {
  requestMock = vi.fn(async (input: { url: string }) => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input.url === "/responses" ? RESPONSES_ANSWER : CHAT_ANSWER),
  }));
});

describe("media parts on the chat-completions dialect", () => {
  it("carries an image by bytes or by its URL as written, and a file by bytes under its name", async () => {
    const model = await kinds.chat();
    await model.invoke({
      messages: user(PNG, { type: "image", mediaType: "image/png", uri: IMAGE_URL }, PDF),
    });

    expect(sentBody().messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
          { type: "image_url", image_url: { url: IMAGE_URL } },
          {
            type: "file",
            file: { filename: "report.pdf", file_data: "data:application/pdf;base64,aGk=" },
          },
        ],
      },
    ]);
  });

  it("carries a tool result's media in the user message that follows the tool message", async () => {
    const model = await kinds.chat();
    await model.invoke({ messages: toolTurn(PDF) });

    expect((sentBody().messages as unknown[]).slice(2)).toEqual([
      { role: "tool", tool_call_id: "c1", content: expect.any(String) },
      {
        role: "user",
        content: [
          {
            type: "file",
            file: { filename: "report.pdf", file_data: "data:application/pdf;base64,aGk=" },
          },
        ],
      },
    ]);
  });
});

describe("media parts on the responses dialect", () => {
  it("carries an image and a file, each by bytes or by its URL as written", async () => {
    const model = await kinds.responses();
    await model.invoke({
      messages: user(
        PNG,
        { type: "image", mediaType: "image/png", uri: IMAGE_URL },
        PDF,
        { type: "file", mediaType: "application/pdf", uri: FILE_URL },
      ),
    });

    expect(sentBody().input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,aGk=" },
          { type: "input_image", image_url: IMAGE_URL },
          {
            type: "input_file",
            filename: "report.pdf",
            file_data: "data:application/pdf;base64,aGk=",
          },
          { type: "input_file", file_url: FILE_URL },
        ],
      },
    ]);
  });

  it("carries each tool result's media in that tool's own output, with no user message after", async () => {
    const model = await kinds.responses();
    await model.invoke({
      messages: [
        { role: "user", content: "fetch both" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "c1", name: "fetch", arguments: {} },
            { id: "c2", name: "fetch", arguments: {} },
          ],
        },
        { role: "tool", toolCallId: "c1", content: [PNG, { type: "text", text: "the chart" }] },
        {
          role: "tool",
          toolCallId: "c2",
          content: [{ type: "file", mediaType: "application/pdf", uri: FILE_URL }, PDF],
        },
        { role: "tool", toolCallId: "c3", content: [{ type: "text", text: "plain" }] },
      ],
    });

    expect((sentBody().input as unknown[]).slice(3)).toEqual([
      {
        type: "function_call_output",
        call_id: "c1",
        output: [
          { type: "input_image", image_url: "data:image/png;base64,aGk=" },
          { type: "input_text", text: "the chart" },
        ],
      },
      {
        type: "function_call_output",
        call_id: "c2",
        output: [
          { type: "input_file", file_url: FILE_URL },
          {
            type: "input_file",
            filename: "report.pdf",
            file_data: "data:application/pdf;base64,aGk=",
          },
        ],
      },
      { type: "function_call_output", call_id: "c3", output: "plain" },
    ]);
  });
});

describe("a part the dialect cannot carry", () => {
  const AUDIO: ContentPart = { type: "audio", mediaType: "audio/wav", data: "aGk=" };

  it.each(Object.keys(kinds) as Array<keyof typeof kinds>)(
    "%s refuses audio at the call, before any request",
    async (kind) => {
      const model = await kinds[kind]();
      await expect(model.invoke({ messages: user(AUDIO) })).rejects.toMatchObject({
        code: "ERR_MODEL_CONTENT_UNSUPPORTED",
        data: { partType: "audio" },
      });
      expect(requestMock).not.toHaveBeenCalled();
    },
  );

  const refused: Array<[string, keyof typeof kinds, Message[], Record<string, string>, RegExp]> = [
    [
      "video",
      "chat",
      user({ type: "video", mediaType: "video/mp4", uri: "https://example.com/a.mp4" }),
      { partType: "video", mediaType: "video/mp4" },
      /'video' content part of media type 'video\/mp4'.*takes text, images and files/,
    ],
    [
      "video",
      "responses",
      user({ type: "video", mediaType: "video/mp4", data: "aGk=" }),
      { partType: "video", mediaType: "video/mp4" },
      /'video' content part of media type 'video\/mp4'/,
    ],
    [
      "an image by a file: URI",
      "chat",
      user({ type: "image", mediaType: "image/png", uri: "file:///tmp/a.png" }),
      { partType: "image", scheme: "file", mediaType: "image/png" },
      /'image' content part of media type 'image\/png' cannot be sent by a 'file:' URI.*http\(s\) URL/,
    ],
    [
      "a file by an s3: URI",
      "responses",
      user({ type: "file", mediaType: "application/pdf", uri: "S3://bucket/report.pdf" }),
      { partType: "file", scheme: "s3", mediaType: "application/pdf" },
      /by a 's3:' URI/,
    ],
    [
      "a file by URL",
      "chat",
      user({ type: "file", mediaType: "application/pdf", uri: FILE_URL }),
      { partType: "file", mediaType: "application/pdf" },
      /'file' content part of media type 'application\/pdf'.*as bytes only/,
    ],
    [
      "a tool result's audio",
      "chat",
      toolTurn(AUDIO),
      { partType: "audio", mediaType: "audio/wav" },
      /'audio' content part/,
    ],
    ...(["chat", "chatStream", "responses", "responsesStream"] as const).map(
      (kind): (typeof refused)[number] => [
        "a file by bytes with no name",
        kind,
        user({ type: "file", mediaType: "application/pdf", data: "aGk=" }),
        { partType: "file", mediaType: "application/pdf" },
        /'file' content part of media type 'application\/pdf'.*sent by bytes needs 'name'/,
      ],
    ),
    [
      "a tool result's file by bytes with no name",
      "chat",
      toolTurn({ type: "file", mediaType: "application/pdf", data: "aGk=" }),
      { partType: "file", mediaType: "application/pdf" },
      /needs 'name'/,
    ],
    [
      "a tool result's file by bytes with no name",
      "responses",
      toolTurn({ type: "file", mediaType: "application/pdf", data: "aGk=" }),
      { partType: "file", mediaType: "application/pdf" },
      /needs 'name'/,
    ],
    [
      "a tool result's video",
      "responses",
      toolTurn({ type: "video", mediaType: "video/mp4", data: "aGk=" }),
      { partType: "video", mediaType: "video/mp4" },
      /'video' content part/,
    ],
    [
      "a part a model produces",
      "responses",
      user({ type: "reasoning", text: "thinking" }),
      { partType: "reasoning" },
      /produced by a model/,
    ],
  ];

  it.each(refused)("%s is refused by %s", async (what, kind, messages, data, message) => {
    const model = await kinds[kind]();
    const error = await model.invoke({ messages }).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: "ERR_MODEL_CONTENT_UNSUPPORTED", data });
    // Exactly the declared payload: no scheme unless a scheme is the reason, and
    // a media type only where the part has one.
    expect((error as { data: unknown }).data).toEqual(data);
    expect((error as Error).message).toMatch(message);
    expect(requestMock).not.toHaveBeenCalled();
  });
});
