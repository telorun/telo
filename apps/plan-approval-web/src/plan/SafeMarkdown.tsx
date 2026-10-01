import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** Markdown with raw HTML disabled: an HTML tag in the source renders as its text. */
export function SafeMarkdown({ source, components }: { source: string; components?: Components }) {
  return (
    <div className="plan-markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </Markdown>
    </div>
  );
}
