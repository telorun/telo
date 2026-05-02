/**
 * Console markup language — chalk-template-style `{style content}` syntax.
 *
 *   {red error}                      red text "error"
 *   {red.bold ERROR}                 red bold "ERROR"
 *   {red.bgWhite warning}            red on white "warning"
 *   {#ff8800 highlight}              hex foreground
 *   hi {red {bold WORLD}!}           nested
 *   literal: \{red\} not a tag       escaped braces
 *
 * Render modes: ANSI SGR for TTY, plain text (markup stripped) otherwise.
 *
 * Limitations:
 *   - Each frame slot reset uses the SGR axis-reset (e.g. \x1b[39m for
 *     foreground). Nesting same-axis styles (`{red {green X}} more red`)
 *     reverts to terminal default after the inner close, not to the
 *     parent's value. Avoid same-axis nesting; nest cross-axis instead.
 *   - Unknown styles (typos, future grammar additions) render the whole
 *     tag as literal text — the consumer sees what they wrote, no crash.
 */

interface LiteralNode {
  type: "literal";
  text: string;
}

interface StyledNode {
  type: "styled";
  styles: string[];
  children: Node[];
  /**
   * Verbatim source slice from `{` through the matching `}`. Captured at
   * parse time so the unknown-style fallback can emit the original tag
   * literally — including any nested markup — without re-rendering
   * children (which would honour known styles inside unknown wrappers
   * and break the "render as literal" contract).
   */
  raw: string;
}

type Node = LiteralNode | StyledNode;

const COLOR_FG: Record<string, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  grey: 90,
  brightBlack: 90,
  brightRed: 91,
  brightGreen: 92,
  brightYellow: 93,
  brightBlue: 94,
  brightMagenta: 95,
  brightCyan: 96,
  brightWhite: 97,
};

const COLOR_BG: Record<string, number> = {
  black: 40,
  red: 41,
  green: 42,
  yellow: 43,
  blue: 44,
  magenta: 45,
  cyan: 46,
  white: 47,
  gray: 100,
  grey: 100,
  brightBlack: 100,
  brightRed: 101,
  brightGreen: 102,
  brightYellow: 103,
  brightBlue: 104,
  brightMagenta: 105,
  brightCyan: 106,
  brightWhite: 107,
};

const ATTRIBUTES: Record<string, [number, number]> = {
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  reverse: [7, 27],
  strikethrough: [9, 29],
};

interface SgrPair {
  open: string;
  close: string;
}

function styleToSgr(style: string): SgrPair | null {
  // Hex foreground: #RRGGBB
  const hex = /^#([0-9a-fA-F]{6})$/.exec(style);
  if (hex) {
    const [r, g, b] = [hex[1].slice(0, 2), hex[1].slice(2, 4), hex[1].slice(4, 6)].map((h) =>
      parseInt(h, 16),
    );
    return { open: `\x1b[38;2;${r};${g};${b}m`, close: "\x1b[39m" };
  }

  // Hex background: bg#RRGGBB
  const bgHex = /^bg#([0-9a-fA-F]{6})$/.exec(style);
  if (bgHex) {
    const [r, g, b] = [bgHex[1].slice(0, 2), bgHex[1].slice(2, 4), bgHex[1].slice(4, 6)].map(
      (h) => parseInt(h, 16),
    );
    return { open: `\x1b[48;2;${r};${g};${b}m`, close: "\x1b[49m" };
  }

  // Named background: bg<Color>
  if (style.startsWith("bg") && style.length > 2) {
    const colorName = style[2].toLowerCase() + style.slice(3);
    const code = COLOR_BG[colorName];
    if (code !== undefined) return { open: `\x1b[${code}m`, close: "\x1b[49m" };
  }

  // Named foreground
  const fg = COLOR_FG[style];
  if (fg !== undefined) return { open: `\x1b[${fg}m`, close: "\x1b[39m" };

  // Attribute
  const attr = ATTRIBUTES[style];
  if (attr) return { open: `\x1b[${attr[0]}m`, close: `\x1b[${attr[1]}m` };

  return null;
}

function isStyleChar(c: string): boolean {
  return /[a-zA-Z0-9#]/.test(c);
}

interface ParseState {
  input: string;
  pos: number;
}

function appendLiteral(nodes: Node[], text: string): void {
  if (!text) return;
  const last = nodes[nodes.length - 1];
  if (last && last.type === "literal") {
    last.text += text;
  } else {
    nodes.push({ type: "literal", text });
  }
}

function tryParseStyles(state: ParseState): string[] | null {
  const start = state.pos;
  const styles: string[] = [];
  let current = "";
  while (state.pos < state.input.length) {
    const c = state.input[state.pos];
    if (c === ".") {
      if (!current) {
        state.pos = start;
        return null;
      }
      styles.push(current);
      current = "";
      state.pos++;
      continue;
    }
    if (c === " ") {
      if (current) styles.push(current);
      return styles.length ? styles : null;
    }
    if (isStyleChar(c)) {
      current += c;
      state.pos++;
      continue;
    }
    state.pos = start;
    return null;
  }
  state.pos = start;
  return null;
}

function parseNodes(state: ParseState, stopAtCloseTag: boolean): { nodes: Node[]; ok: boolean } {
  const nodes: Node[] = [];
  while (state.pos < state.input.length) {
    const ch = state.input[state.pos];

    if (stopAtCloseTag && ch === "}") {
      state.pos++;
      return { nodes, ok: true };
    }

    if (ch === "\\" && state.pos + 1 < state.input.length) {
      const next = state.input[state.pos + 1];
      if (next === "{" || next === "}" || next === "\\") {
        appendLiteral(nodes, next);
        state.pos += 2;
        continue;
      }
    }

    if (ch === "{") {
      const tagStart = state.pos;
      state.pos++;
      const styles = tryParseStyles(state);
      if (styles && state.pos < state.input.length && state.input[state.pos] === " ") {
        state.pos++;
        const inner = parseNodes(state, true);
        if (inner.ok) {
          const raw = state.input.slice(tagStart, state.pos);
          nodes.push({ type: "styled", styles, children: inner.nodes, raw });
          continue;
        }
      }
      // Malformed tag — fall back to literal
      const literal = state.input.slice(tagStart, state.pos);
      appendLiteral(nodes, literal);
      continue;
    }

    appendLiteral(nodes, ch);
    state.pos++;
  }

  if (stopAtCloseTag) return { nodes, ok: false };
  return { nodes, ok: true };
}

export function parse(input: string): Node[] {
  const state: ParseState = { input, pos: 0 };
  return parseNodes(state, false).nodes;
}

function renderNodes(nodes: Node[], isTty: boolean): string {
  return nodes.map((n) => renderNode(n, isTty)).join("");
}

function renderNode(node: Node, isTty: boolean): string {
  if (node.type === "literal") return node.text;

  const sgrPairs = node.styles.map(styleToSgr);
  const allKnown = sgrPairs.every((p): p is SgrPair => p !== null);

  if (!allKnown) {
    // Unknown style — emit the verbatim source slice. We do NOT recurse
    // into children: doing so would honour known styles inside an unknown
    // wrapper (`{notARealStyle {red hi}}` would still ANSI-color "hi"),
    // which contradicts the documented "render as literal" promise.
    return node.raw;
  }

  if (!isTty) return renderNodes(node.children, isTty);

  const opens = (sgrPairs as SgrPair[]).map((p) => p.open).join("");
  const closes = (sgrPairs as SgrPair[])
    .map((p) => p.close)
    .reverse()
    .join("");
  return opens + renderNodes(node.children, isTty) + closes;
}

/**
 * Render a markup string. TTY → ANSI SGR codes; non-TTY → plain text.
 */
export function render(input: string, isTty: boolean): string {
  return renderNodes(parse(input), isTty);
}

/**
 * Best-effort TTY detection on a writable. Falls back to false for
 * non-Node streams (test fakes, in-memory buffers).
 */
export function isTtyStream(stream: { isTTY?: boolean } | undefined | null): boolean {
  return !!stream && stream.isTTY === true;
}
