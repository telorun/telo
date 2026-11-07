/**
 * The fenced blocks of a model reply that an agent's `textTools` collect.
 *
 * A fence opens at column 0 with three or more backticks; it closes on a line
 * of only backticks, at least as many as the opener. Inside a fence every
 * other line is body, so a fence nested in a longer one opens nothing — which
 * is how a model shows a listed tag as an example. An opener whose info string
 * is a listed tag followed by `name=value` attributes is a block; any other
 * fence is ordinary text, but still hides what it holds — except a fence whose
 * tag is listed and whose attributes do not parse, which is reported as
 * malformed rather than read as text. A closing line may carry trailing
 * spaces or tabs. The body is the raw
 * text between the opener's line and the closing line, its final newline
 * included, never decoded.
 */

/** One block: its tag, its attributes in written order, its raw body. */
export interface TextBlock {
  tag: string;
  /** `[name, value]` in the order written; a later duplicate name replaces the value. */
  attributes: Array<[string, string]>;
  body: string;
}

/** A listed block that opened and never closed. */
export interface OpenBlock {
  tag: string;
  attributes: Array<[string, string]>;
}

/** A fence that opens with a listed tag but whose attributes do not parse. */
export interface MalformedBlock {
  tag: string;
  /** The first token that is not `name=value`, as written. */
  token: string;
}

export interface ExtractedBlocks {
  /** The complete blocks of listed tags, in reply order. */
  blocks: TextBlock[];
  /** Set when the reply ends inside a listed block. */
  open?: OpenBlock;
  /** The first malformed listed fence of the reply, if any. */
  malformed?: MalformedBlock;
}

export const TEXT_TOOL_TAG = /^[a-z][a-z0-9-]*$/;

const OPENER = /^(`{3,})(.*)$/;
const CLOSER = /^(`+)[ \t]*$/;
const ATTRIBUTE = /^([^=\s"']+)=([^\s"']*)$/;

/** A line without the carriage return a CRLF text ends it with. */
function lineText(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** The block an info string names, a malformed listed fence, or undefined when
 *  its tag is not listed. The tag is the leading `[a-z][a-z0-9-]*`; what follows
 *  must be empty or a space, else the whole remainder is the bad token. */
function readInfo(
  info: string,
  listed: ReadonlySet<string>,
): { block: OpenBlock } | { malformed: MalformedBlock } | undefined {
  const head = /^[a-z][a-z0-9-]*/.exec(info);
  const tag = head?.[0];
  if (tag === undefined || !listed.has(tag)) return undefined;
  const rest = info.slice(tag.length);
  if (rest !== "" && !rest.startsWith(" ")) return { malformed: { tag, token: rest } };
  const attributes: Array<[string, string]> = [];
  for (const token of rest.split(" ").filter((t) => t !== "")) {
    const match = ATTRIBUTE.exec(token);
    if (!match) return { malformed: { tag, token } };
    const [, name, value] = match as unknown as [string, string, string];
    const existing = attributes.findIndex(([key]) => key === name);
    if (existing === -1) attributes.push([name, value]);
    else attributes[existing] = [name, value];
  }
  return { block: { tag, attributes } };
}

/** The blocks of `text` whose tag is in `listed`. */
export function extractBlocks(text: string, listed: ReadonlySet<string>): ExtractedBlocks {
  const blocks: TextBlock[] = [];
  let malformed: MalformedBlock | undefined;
  let fence: { length: number; block?: OpenBlock; bodyStart: number } | undefined;
  let offset = 0;
  while (offset <= text.length) {
    const newline = text.indexOf("\n", offset);
    const end = newline === -1 ? text.length : newline;
    const line = lineText(text.slice(offset, end));
    const next = newline === -1 ? text.length + 1 : newline + 1;
    if (fence === undefined) {
      const opener = OPENER.exec(line);
      if (opener) {
        const info = readInfo(opener[2]!.trim(), listed);
        if (info && "malformed" in info) malformed ??= info.malformed;
        fence = {
          length: opener[1]!.length,
          block: info && "block" in info ? info.block : undefined,
          bodyStart: Math.min(next, text.length),
        };
      }
    } else if ((CLOSER.exec(line)?.[1]?.length ?? 0) >= fence.length) {
      if (fence.block) {
        blocks.push({ ...fence.block, body: text.slice(fence.bodyStart, offset) });
      }
      fence = undefined;
    }
    if (newline === -1) break;
    offset = next;
  }
  return {
    blocks,
    ...(fence?.block ? { open: fence.block } : {}),
    ...(malformed ? { malformed } : {}),
  };
}

/** How a block is named in a result header and a notice: its tag, then its
 *  attributes as written. */
export function blockLabel(block: OpenBlock): string {
  return [block.tag, ...block.attributes.map(([name, value]) => `${name}=${value}`)].join(" ");
}

/** A block's attributes as the map `blocks` binds. */
export function attributeMap(block: OpenBlock): Record<string, string> {
  return Object.fromEntries(block.attributes);
}
