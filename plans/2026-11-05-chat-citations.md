---
status: draft
priority: medium
depends-on: [2026-10-18-chat.md]
packages: [modules/ai, modules/anthropic, modules/openai, modules/conversation, modules/ai-chat, modules/ui, modules/ui-react, modules/ui-react-radix, modules/text-chunk, modules/retrieval, examples/cited-chat, apps/authoring-agent]
---

# Cited answers in the AI chat

## Problem

A chat reply cannot say where its answer came from. The chat can draw a "Sources" list, and the contract has a `citation` part, but nothing produces one:
- **Providers drop citations.** Anthropic's citations are kept only for replay and never yielded. No document is sent with citations enabled, and no search result block exists. OpenAI maps none.
- **Tool results cannot be cited.** A search or retrieval tool returns plain text to the model, with no way to mark a passage as citable.
- **Citations would vanish on reload.** The agent records a reply as plain text, so any part shown live is lost when the conversation is read back.
- **A citation needs a URL.** A document has no valid shape, and citations without one are dropped silently.
- **No retrieval.** Nothing splits a document into passages, indexes it, or turns a question into matching passages.

## Solution

**A source is something a reader can follow**: `{ url, title, mediaType? }`.
- For a web page, `url` and `title` are the page's.
- For a document, `title` is its filename and `url` downloads it; `mediaType` marks the link as a download.
- It is `Ai.Source` in `ai` and `Conversation.Source` in `conversation`; `ai-chat` translates between them (`attachment:<id>` ↔ `conversations/<conversation>/attachments/<id>`).

**A citation is a part** `{ type: citation, source, quote? }`, placed in the reply's ordered parts right after the text it supports, with no character offsets.

**The recorded assistant message keeps every part in order.** `Ai.Agent` and `Ai.AgentStream` fold the text and reasoning deltas and each content part into the message they record. Citations, reasoning and refusals then survive a reload.

**Citable content is any `text` or `file` part carrying `source`**: a tool result, a user's attachment, resolved content. The rest is per provider:
- **Anthropic:** maps a sourced text part to a `search_result` block and a sourced file to a document block, both with citations enabled. It yields each returned citation, resolved to the request's own source, after its text, with `cited_text` as `quote`.
- **Providers without native citations** (OpenAI chat and responses, any later one): use one shared source-marker codec from `@telorun/ai`. It numbers the request's sources `[src<n>]`, asks the model to cite with them, and turns the markers into citation parts as the text streams.
  - The codec's behaviour is pinned by vectors in `modules/ai/conformance/source-markers.json`.
- **Unoffered sources are refused:** the agent fails a run whose citation names a source its request never carried (`ERR_CONTRACT_VIOLATION`).

**Authors compose; the agent names no domain.**
- **Web search** is a `WebSearch.Engine` mounted through `Ai.Tools`, and **retrieval** is a `Retrieval.Search`, likewise.
- **Each tool's `result:` maps the answer to sourced parts.** `Ai.Tools.result` becomes typed (a string, a part, or a list of parts), so a misspelt `source` is refused before the app runs. A value meant as JSON is written `json(...)`.
- **Attachments are citable automatically:** `ai-chat` marks each upload it sends the model with its filename and `conversations/<conversation>/attachments/<id>` URL, a route that refuses a file of another conversation.

**Retrieval** comes as two new modules, both MIT, each with docs and a README.
- **`text-chunk`:**
  - `TextChunk.Split` cuts text into passages of `size` with `overlap`, counted in code points, at paragraph, line, sentence, then word boundaries.
  - An overlap not below the size is refused at check and at creation.
- **`retrieval`** (imports `embedding`, `vector-store`):
  - **`Retrieval.Corpus`** pairs one `Embedding.Model` with one `VectorStore.Store`, so a collection is always searched with the model that indexed it.
  - **`Retrieval.Index`** embeds a document's passages and stores each passage's text and source in the record. It replaces older revisions of the document, with no moment where the document is missing and no lock.
  - **`Retrieval.Search`** takes a question and answers the best passages with their sources.
  - **`Retrieval.Remove`** drops a document.
  - **Ingestion is a `Telo.Sequence`:** extract the text (`Pdf.Text`, `Ocr.Recognizer`, plain text), split it, index it.

**The chat UI** follows the Perplexity / ChatGPT pattern:
- **Markers:** numbered superscripts sit where each citation is. Each opens its source in a new tab, or downloads a document. The source's title is its accessible name, through the keyed text `chatCitation`.
- **Sources list:** a numbered list under the reply shows each source's title link and its quotes.
- **Numbering:** per reply, by first citation, one number per URL, never renumbered while streaming.
- **Switches:** `Ui.Chat.show.citations` and `Ui.Chat.show.sources`, both on by default.
- **Export:** the transcript export writes `[n]` markers and the numbered list.
- **New parts:** `chat-citation`, `chat-source-number`, styled by every theme.

## Decisions

- **Source separate from citation, anchored by position.** Offsets differ per kernel language and break while text streams. A per-message source list with citations by id stores numbering, which is presentation.
- **Native citations stay inside the provider.** Only the provider built the request, so only it can resolve its own locations. The agent owns no ids or numbering.
- **One codec for providers without native citations.** A copy per provider would drift; markers are `[src<n>]`, since `[n]` collides with footnotes and indexing.
- **`source` on existing parts, not a new citable part type.** A new type would leave attachments uncitable or need a third spelling.
- **Composition over agent slots.** `webSearch:` or `retrieval:` on the agent would make every new source of passages an agent change. A bridging tool kind per engine and store multiplies.
- **Web search uses Telo's own engines**, never a provider's built-in search tool. That is the user's decision. OpenAI's and Gemini's native annotations exist only for their built-in tools, so they do not apply.
- **Passage text lives in the vector record**, as in Chroma and Qdrant payloads. A separate store would add a join per search.
- **Chunking is its own module**, because splitting has consumers outside retrieval.
- **No URL is minted.** An attachment's URL is the conversation's existing attachment route and its guard; a corpus document's URL is the application's own route. There are no signed links.
- **Markers open the source, not the list entry.** In a chat the reader wants the source, and a list jump breaks when the list is hidden.
- **Left out:**
  - page-level citations, hover previews;
  - reranking, hybrid or keyword search, filters on search;
  - indexing chat attachments, crawling the web;
  - an embedding backend beyond OpenAI.
- **Refusals and floors:**
  - **The new shapes are refused in both halves** by their schemas and the modules' own rules: `SCHEMA_VIOLATION` / `ERR_INPUT_INVALID` / `ERR_OUTPUT_INVALID`, `CEL_TYPE_ERROR` / `ERR_AGENT_TOOL_RESULT_INVALID`, `TEXT_CHUNK_OVERLAP_TOO_LARGE` / `ERR_TEXT_CHUNK_OVERLAP_TOO_LARGE`, `REFERENCE_KIND_MISMATCH`.
  - **An Anthropic location naming no sourced block** is `ERR_MODEL_RESPONSE_INVALID`.
  - **No kernel or analyzer surface changes**, so no `requires:` floor, which is verified by execution.
- **Bookkeeping:**
  - **Docs:** `ai`, `anthropic`, `openai`, `conversation`, `ai-chat`, `ui-react` chat and styling, the two new modules.
  - **Primer and hub guides:** the authoring-agent primer, and the `build-ui` and `design-library` hub guides.
  - **Translations:** `chatCitation` in the fourteen `Ui.<language>Translations`.
  - **Benefits ledger:** "Cited answers" and "Search over your own documents".
  - **Release fragments:** one `Added` per module.
  - **In-repo mappings:** existing `result: !cel "result.body"` mappings become `json(result.body)`.

**Verify**
- **Reload:** a reply citing two sources reloads with text, citation, text, citation in streaming order, and a reasoning part survives too.
- **Providers agree:** the same agent against Anthropic and against OpenAI yields citations with equal sources.
- **Invented sources:** a fake provider citing an unoffered URL fails with `ERR_CONTRACT_VIOLATION`.
- **Typed `result:`:** a misspelt `source` in a `result:` mapping is refused at `telo check`, and a `dyn` value of the wrong shape fails the call.
- **Attachments:** `examples/chat`, unchanged, cites its PDF attachments.
- **Re-indexing:**
  - with fewer chunks it leaves exactly the new passages;
  - two racing revisions leave only the newer;
  - a search returns each passage's `source.url` as indexed.
- **Chat UI:**
  - a reply citing A, B, A shows markers 1, 2, 1 and a two-entry list;
  - with `show.sources: false` the markers still open their sources;
  - a document marker downloads.
- **Themes:** the default and Radix themes pass conformance with the new parts.

## Example

`examples/cited-chat`:
- **Agent:** Claude with two tools.
  - **Web search:** a `Brave.Engine` whose `result:` maps each hit to `{ type: text, text: snippet, source: { url, title } }`.
  - **Retrieval:** a `Retrieval.Search` over a memory corpus whose `result:` maps each passage to `{ type: text, text, source }`.
- **The corpus** is built at boot from a `documents/` directory, which `Http.Static` also serves, so each document's source URL is `/documents/<file>` and downloads it.
- **The page** is the chat example's, with both `show` switches left on.
- **Tests** use fixture engines and embeddings.
