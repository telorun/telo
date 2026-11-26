export type TermsBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] };

const LIST_ITEM = /^[-*]\s+(.*)$/;

/**
 * Reflows a runner's hard-wrapped terms body: blank lines separate paragraphs,
 * a line starting `- ` / `* ` begins a list item, any other line continues the
 * current paragraph or item.
 */
export function reflowRunnerTerms(body: string): TermsBlock[] {
  const blocks: TermsBlock[] = [];
  let paragraph: string[] = [];
  let items: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const flushList = () => {
    if (items) blocks.push({ kind: "list", items });
    items = null;
  };

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") {
      flushParagraph();
      flushList();
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flushParagraph();
      (items ??= []).push(item[1]);
    } else if (items) {
      items[items.length - 1] += ` ${line}`;
    } else {
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}
