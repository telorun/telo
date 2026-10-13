import { Layers, Pin, Search } from "lucide-react";

import type { Route } from "./+types/mcp";
import { CodeBlock } from "@/CodeBlock";
import { useHubOrigins } from "@/hub-origins";
import { canonicalLink, MCP_DESCRIPTION, MCP_TITLE, shareTags } from "@/module-head";

export const meta: Route.MetaFunction = ({ matches }) => {
  const { siteOrigin } = matches[0].loaderData;
  return [
    { title: MCP_TITLE },
    { name: "description", content: MCP_DESCRIPTION },
    canonicalLink(siteOrigin, "/mcp"),
    ...shareTags(siteOrigin, "/mcp", MCP_TITLE, MCP_DESCRIPTION),
  ];
};

export function headers(): HeadersInit {
  return { "Cache-Control": "public, max-age=60, stale-if-error=86400" };
}

/** What an agent gets, in the order it uses them when composing a manifest. */
const ABILITIES = [
  {
    icon: Search,
    title: "Find what does the job",
    text: "Search kinds, ready-made instances and applications by what they do, across every registered host — several needs in one call.",
  },
  {
    icon: Layers,
    title: "Read the exact schemas",
    text: "Fetch the definitions of the kinds it chose, with every shape they reference, so it writes fields that exist instead of guessing them.",
  },
  {
    icon: Pin,
    title: "Pin what it imports",
    text: "List a module's versions with their integrity pins, the backends of a contract, and the modules already using one.",
  },
];

/** How to give an agent the hub. The endpoint is the hub API's own `/mcp`, on
 *  the origin the browser already calls — not a path of this site. */
export default function Mcp() {
  const endpoint = `${useHubOrigins().browserApiOrigin}/mcp`;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Connect your agent over MCP</h1>
        <p className="leading-relaxed text-muted-foreground">
          Everything this site shows is also served over the Model Context Protocol. Connect the
          hub to an AI agent and it finds modules, reads their schemas and pins their versions
          while it writes your manifest. No account, no key.
        </p>
      </header>

      <section className="flex flex-col gap-2">
        <SectionTitle>Endpoint</SectionTitle>
        <CodeBlock text={endpoint} label="Copy endpoint" />
        <p className="text-sm text-muted-foreground">Streamable HTTP, no authentication.</p>
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle>Claude Code</SectionTitle>
        <CodeBlock text={`claude mcp add --transport http telo-hub ${endpoint}`} label="Copy command" />
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle>Any other MCP client</SectionTitle>
        <CodeBlock
          text={JSON.stringify(
            { mcpServers: { "telo-hub": { type: "http", url: endpoint } } },
            null,
            2,
          )}
          label="Copy configuration"
        />
        <p className="text-sm text-muted-foreground">
          The key names differ between clients; the endpoint and the transport are what matter.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>What the agent can do</SectionTitle>
        <ul className="grid gap-3 sm:grid-cols-3">
          {ABILITIES.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon className="size-4" />
              </span>
              <span className="font-medium tracking-tight">{title}</span>
              <span className="text-sm leading-relaxed text-muted-foreground">{text}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{children}</h2>
  );
}
