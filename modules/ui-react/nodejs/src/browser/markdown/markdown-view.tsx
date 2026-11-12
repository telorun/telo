/*!
 * Third-party code bundled into the markdown renderer's chunk, used under these licences.
 *
 * highlight.js 11 (through lowlight), BSD-3-Clause
 *
 * Copyright (c) 2006, Ivan Sagalaev.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * * Redistributions of source code must retain the above copyright notice, this
 *   list of conditions and the following disclaimer.
 *
 * * Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * * Neither the name of the copyright holder nor the names of its
 *   contributors may be used to endorse or promote products derived from
 *   this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * lowlight, mdast-util-*, micromark*, unist-util-*, markdown-table, ccount,
 * decode-named-character-reference, devlop, longest-streak, zwitch, MIT
 * Copyright (c) Titus Wormer <tituswormer@gmail.com>
 *
 * mdast-util-phrasing, MIT
 * Copyright (c) 2017 Victor Felder <victor@draft.li>
 *
 * escape-string-regexp, MIT
 * Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of the MIT-licensed software above and associated documentation files
 * (the 'Software'), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 * CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import type { AlignType, Definition, ListItem, Nodes, Root, RootContent, TableCell } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { createElement, Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { styleAttribute, type Style } from "../bindings.js";
import { useHostStore, type HostStore } from "../host.js";
import { linkAddress } from "../link-address.js";
import { ErrorNode } from "../nodes.js";
import { useSay } from "../texts.js";
import { errorSpec, type ErrorSpec } from "../ui-error.js";
import { tokenize } from "./code-tokens.js";
import type { MarkdownAnnotation, MarkdownImages } from "./markdown-node.js";

const ABSOLUTE_WEB = /^https?:\/\//;

/** CommonMark plus GFM tables, task lists, strikethrough and autolinks. */
export function parseMarkdown(source: string): Root {
  return fromMarkdown(source, {
    extensions: [gfmAutolinkLiteral(), gfmStrikethrough(), gfmTable(), gfmTaskListItem()],
    mdastExtensions: [
      gfmAutolinkLiteralFromMarkdown(),
      gfmStrikethroughFromMarkdown(),
      gfmTableFromMarkdown(),
      gfmTaskListItemFromMarkdown(),
    ],
  });
}

/** What drawing a tree reads outside it. */
interface Scope {
  store: HostStore;
  /** Whether an image is drawn only from an app-relative address; any other is its alt text. */
  localImagesOnly: boolean;
  definitions: ReadonlyMap<string, Definition>;
  /** The controls each block holding an annotated line draws, in order. */
  marks: ReadonlyMap<Nodes, ReactNode[]>;
}

function definitionsOf(root: Root): Map<string, Definition> {
  const found = new Map<string, Definition>();
  const visit = (node: Nodes) => {
    if (node.type === "definition" && !found.has(node.identifier)) found.set(node.identifier, node);
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(root);
  return found;
}

/** The item of a list, or of a list nested in it, holding a line. */
function itemAt(item: ListItem, line: number): Nodes {
  for (const child of item.children) {
    if (child.type !== "list" || !child.position || child.position.start.line > line || child.position.end.line < line) continue;
    const inner = child.children.find((each) => each.position && each.position.start.line <= line && each.position.end.line >= line);
    if (inner) return itemAt(inner, line);
  }
  return item;
}

/**
 * The block an annotated line is drawn on: the list item holding it, else the
 * block holding it — a quote's own block inside it — or, for a line between
 * blocks, the block after it. Nothing for a line past the text.
 */
function blockAt(blocks: readonly RootContent[], line: number): Nodes | undefined {
  for (const block of blocks) {
    // A definition draws nothing to hold a control.
    if (block.type === "definition" || !block.position || block.position.end.line < line) continue;
    if (block.position.start.line > line) return block;
    if (block.type === "list") {
      const item = block.children.find((each) => each.position && each.position.end.line >= line);
      return item ? (item.position!.start.line > line ? item : itemAt(item, line)) : block;
    }
    if (block.type === "blockquote") return blockAt(block.children, line) ?? block;
    return block;
  }
  return undefined;
}

/** Where each annotation is drawn: on the block holding its line, in order, or after the text. */
function placeAnnotations(root: Root, annotations: readonly MarkdownAnnotation[]): { marks: Map<Nodes, ReactNode[]>; unplaced: ReactNode[] } {
  const marks = new Map<Nodes, ReactNode[]>();
  const unplaced: ReactNode[] = [];
  for (const { line, control } of annotations) {
    const block = typeof line === "number" && Number.isInteger(line) && line >= 1 ? blockAt(root.children, line) : undefined;
    if (block === undefined) unplaced.push(control);
    else marks.set(block, [...(marks.get(block) ?? []), control]);
  }
  return { marks, unplaced };
}

/** The controls a block holds, in the element holding them; nothing when it holds none. */
function marksOf(node: Nodes, scope: Scope): ReactNode {
  const controls = scope.marks.get(node);
  return controls ? <span data-telo-part="markdown-annotations">{controls}</span> : null;
}

/** The plain text a node stands for, for an image that cannot be drawn. */
function textOf(node: Nodes): string {
  if ("value" in node) return node.value;
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  return "children" in node ? node.children.map(textOf).join("") : "";
}

const ALIGN: Record<NonNullable<AlignType>, string> = { left: "start", center: "center", right: "end" };

/** Where a node is drawn: among blocks, in a tight list item (no paragraph of its own), or in a line of text. */
type Place = "block" | "tight" | "inline";

function children(nodes: readonly RootContent[], scope: Scope, place: Place = "inline"): ReactNode[] {
  return nodes.map((node, index) => <Fragment key={index}>{draw(node, scope, place)}</Fragment>);
}

function link(url: string, title: string | null | undefined, content: ReactNode, scope: Scope): ReactNode {
  const href = linkAddress(scope.store, url);
  if (href === undefined) return content;
  const external = ABSOLUTE_WEB.test(href);
  return (
    <a
      data-telo-part="markdown-link"
      href={href}
      title={title ?? undefined}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {content}
    </a>
  );
}

function image(url: string, alt: string, title: string | null | undefined, scope: Scope): ReactNode {
  const src = url.startsWith("mailto:") || (scope.localImagesOnly && !url.startsWith("/")) ? undefined : linkAddress(scope.store, url);
  if (src === undefined) return alt;
  return <img data-telo-part="markdown-image" src={src} alt={alt} title={title ?? undefined} loading="lazy" referrerPolicy="no-referrer" />;
}

function listItem(item: ListItem, scope: Scope, place: Place): ReactNode {
  const task = typeof item.checked === "boolean";
  return (
    <li data-telo-part="markdown-list-item">
      {task ? (
        <span data-telo-part="markdown-task" role="checkbox" aria-checked={item.checked as boolean} aria-readonly="true" aria-label={textOf(item)} />
      ) : null}
      {children(item.children.slice(0, 1), scope, place)}
      {marksOf(item, scope)}
      {children(item.children.slice(1), scope, place)}
    </li>
  );
}

function cell(node: TableCell, header: boolean, align: AlignType, scope: Scope): ReactNode {
  return createElement(
    header ? "th" : "td",
    { "data-telo-part": header ? "markdown-table-header-cell" : "markdown-table-cell", "data-align": align ? ALIGN[align] : undefined },
    children(node.children, scope),
  );
}

function draw(node: RootContent, scope: Scope, place: Place): ReactNode {
  switch (node.type) {
    case "paragraph":
      return place === "tight" ? (
        <>
          {children(node.children, scope)}
          {marksOf(node, scope)}
        </>
      ) : (
        <p data-telo-part="markdown-paragraph">
          {children(node.children, scope)}
          {marksOf(node, scope)}
        </p>
      );
    case "heading":
      return createElement(
        `h${node.depth}`,
        { "data-telo-part": "markdown-heading", "data-level": String(node.depth) },
        children(node.children, scope),
        marksOf(node, scope),
      );
    case "thematicBreak":
      return (
        <>
          <hr data-telo-part="markdown-rule" />
          {marksOf(node, scope)}
        </>
      );
    case "blockquote":
      return (
        <blockquote data-telo-part="markdown-quote">
          {children(node.children, scope, "block")}
          {marksOf(node, scope)}
        </blockquote>
      );
    case "list": {
      const items = node.children.map((item, index) => <Fragment key={index}>{listItem(item, scope, item.spread ?? node.spread ?? false ? "block" : "tight")}</Fragment>);
      return (
        <>
          {node.ordered ? (
            <ol data-telo-part="markdown-list" start={node.start ?? undefined}>
              {items}
            </ol>
          ) : (
            <ul data-telo-part="markdown-list">{items}</ul>
          )}
          {marksOf(node, scope)}
        </>
      );
    }
    case "code":
      return <CodeBlock code={node.value} language={node.lang ?? undefined} marks={marksOf(node, scope)} />;
    case "html":
      // Raw markup is text: the renderer builds elements and inserts none.
      return place === "block" ? (
        <p data-telo-part="markdown-paragraph">
          {node.value}
          {marksOf(node, scope)}
        </p>
      ) : (
        <>
          {node.value}
          {marksOf(node, scope)}
        </>
      );
    case "table":
      return (
        <div data-telo-part="markdown-table-frame">
          <table data-telo-part="markdown-table">
            <thead data-telo-part="markdown-table-head">
              {node.children.slice(0, 1).map((row, index) => (
                <tr key={index} data-telo-part="markdown-table-row">
                  {row.children.map((each, column) => (
                    <Fragment key={column}>{cell(each, true, node.align?.[column] ?? null, scope)}</Fragment>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody data-telo-part="markdown-table-body">
              {node.children.slice(1).map((row, index) => (
                <tr key={index} data-telo-part="markdown-table-row">
                  {row.children.map((each, column) => (
                    <Fragment key={column}>{cell(each, false, node.align?.[column] ?? null, scope)}</Fragment>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {marksOf(node, scope)}
        </div>
      );
    case "text":
      return node.value;
    case "emphasis":
      return <em data-telo-part="markdown-emphasis">{children(node.children, scope)}</em>;
    case "strong":
      return <strong data-telo-part="markdown-strong">{children(node.children, scope)}</strong>;
    case "delete":
      return <del data-telo-part="markdown-strike">{children(node.children, scope)}</del>;
    case "inlineCode":
      return <code data-telo-part="markdown-code">{node.value}</code>;
    case "break":
      return <br data-telo-part="markdown-break" />;
    case "link":
      return link(node.url, node.title, children(node.children, scope), scope);
    case "linkReference": {
      const target = scope.definitions.get(node.identifier);
      const content = children(node.children, scope);
      return target ? link(target.url, target.title, content, scope) : content;
    }
    case "image":
      return image(node.url, node.alt ?? "", node.title, scope);
    case "imageReference": {
      const target = scope.definitions.get(node.identifier);
      return target ? image(target.url, node.alt ?? "", target.title, scope) : (node.alt ?? "");
    }
    case "definition":
      return null;
    default:
      // A node the profile does not include is drawn as the text it holds.
      return (
        <>
          {textOf(node)}
          {marksOf(node, scope)}
        </>
      );
  }
}

/** How long a copy confirmation stays. */
const CONFIRMATION_MS = 2000;

function CopyCode({ code }: { code: string }) {
  const say = useSay();
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState<ErrorSpec>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch (error) {
      setFailure(errorSpec(error, "ERR_UI_COPY_FAILED"));
      return;
    }
    setFailure(undefined);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), CONFIRMATION_MS);
  };
  return (
    <>
      {failure ? <ErrorNode error={failure} /> : null}
      <button data-telo-part="markdown-code-copy" type="button" aria-live="polite" onClick={copy}>
        {say(copied ? "chatCopied" : "chatCopyCode")}
      </button>
    </>
  );
}

function CodeBlock({ code, language, marks }: { code: string; language: string | undefined; marks: ReactNode }) {
  const tokens = useMemo(() => tokenize(code, language), [code, language]);
  const named = language?.trim().split(/\s+/)[0];
  return (
    <div data-telo-part="markdown-code-block">
      <div data-telo-part="markdown-code-header">
        {named ? <span data-telo-part="markdown-code-language">{named}</span> : null}
        <CopyCode code={code} />
      </div>
      <pre data-telo-part="markdown-code-pre" tabIndex={0}>
        <code data-telo-part="markdown-code-text">
          {tokens.map((token, index) =>
            token.kind === undefined ? (
              token.text
            ) : (
              <span key={index} data-telo-part="markdown-token" data-token={token.kind}>
                {token.text}
              </span>
            ),
          )}
        </code>
      </pre>
      {marks}
    </div>
  );
}

/**
 * The markdown renderer: the text drawn as elements this module builds, each
 * annotation's control on the block holding its line, and those whose line is
 * past the text after it.
 */
export default function MarkdownView({
  source,
  style,
  images = "any",
  fill = false,
  annotations = [],
}: {
  source: string;
  style?: Style;
  images?: MarkdownImages;
  fill?: boolean;
  annotations?: readonly MarkdownAnnotation[];
}) {
  const store = useHostStore();
  const tree = useMemo(() => parseMarkdown(source), [source]);
  const definitions = useMemo(() => definitionsOf(tree), [tree]);
  const { marks, unplaced } = placeAnnotations(tree, annotations);
  return (
    <div data-telo-part="markdown" data-state="idle" data-fill={fill ? "true" : undefined} data-style={styleAttribute(style)}>
      {children(tree.children, { store, definitions, marks, localImagesOnly: images === "app-relative" }, "block")}
      {unplaced.length > 0 && <div data-telo-part="markdown-unplaced-annotations">{unplaced}</div>}
    </div>
  );
}
