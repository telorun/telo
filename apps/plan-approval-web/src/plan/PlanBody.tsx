import type { ElementType, HTMLAttributes, ReactNode } from "react";
import type { Components, ExtraProps } from "react-markdown";

import { bodyLines, itemIdsByLine } from "@/plan/item-grammar";
import { SafeMarkdown } from "@/plan/SafeMarkdown";

type ItemTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li";
const ITEM_TAGS: ItemTag[] = ["h1", "h2", "h3", "h4", "h5", "h6", "li"];

/** A revision body with `itemControl(id)` placed on each heading or list item
 *  whose line declares an ID in the server-stored `items` of that revision. */
export function PlanBody({
  body,
  items,
  itemControl,
}: {
  body: string;
  items: readonly string[];
  itemControl: (id: string) => ReactNode;
}) {
  const declared = itemIdsByLine(bodyLines(body));
  const stored = new Set(items);

  const itemAt = (line: number | undefined): string | undefined => {
    if (line === undefined) return undefined;
    const id = declared[line - 1];
    return id !== undefined && stored.has(id) ? id : undefined;
  };

  const components: Components = Object.fromEntries(
    ITEM_TAGS.map((tag) => [
      tag,
      ({ node, children, ...props }: HTMLAttributes<HTMLElement> & ExtraProps) => {
        const Tag: ElementType = tag;
        const id = itemAt(node?.position?.start.line);
        return (
          <Tag {...props} data-item={id}>
            {id !== undefined && itemControl(id)}
            {children}
          </Tag>
        );
      },
    ]),
  );

  return <SafeMarkdown source={body} components={components} />;
}
