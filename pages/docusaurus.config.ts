import path from "node:path";

import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";

import { generateExamplesIndex } from "./lib/generate-examples-index";
import sidebars from "./sidebars";

const repoRoot = path.resolve(__dirname, "..");
generateExamplesIndex(path.join(repoRoot, "examples"), path.join(repoRoot, "examples", "INDEX.md"));

function collectDocIds(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const ids: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      ids.push(item);
    } else if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      if (rec.type === "doc" && typeof rec.id === "string") {
        ids.push(rec.id);
      } else if (rec.type === "category") {
        ids.push(...collectDocIds(rec.items));
      }
    }
  }
  return ids;
}

const docInclude = collectDocIds(sidebars.docs).map((id) => `${id}.md`);

const config: Config = {
  title: "Telo",
  tagline: "The ultimate kernel for declarative backends.",
  url: "https://telo.run",
  baseUrl: process.env.BASE_URL ?? "/",
  trailingSlash: false,

  onBrokenLinks: "warn",

  markdown: {
    format: "detect",
    // Inject route slugs for co-located docs at build time. Keeps
    // Docusaurus-only annotations out of the markdown files (project rule)
    // so READMEs and module docs stay clean for GitHub + IDE consumers.
    parseFrontMatter: async ({ filePath, fileContent, defaultParseFrontMatter }) => {
      const result = await defaultParseFrontMatter({ filePath, fileContent });
      if (result.frontMatter.slug !== undefined) return result;
      const normalized = filePath.replace(/\\/g, "/");

      // Pages promoted out of their module into the top-level Deploy
      // group get an explicit `/deploy/` slug; everything else under
      // modules/ falls through to the `/reference/std/` catch-all below.
      const lambdaDeployingMatch = normalized.match(/\/modules\/lambda\/docs\/deploying\.md$/);
      if (lambdaDeployingMatch) {
        result.frontMatter.slug = "/deploy/lambda";
        return result;
      }

      const stdMatch = normalized.match(/\/modules\/(.+\.md)$/);
      if (stdMatch) {
        let rel = stdMatch[1].replace(/\.md$/, "");
        if (rel === "README") {
          rel = "";
        } else {
          rel = rel.replace(/\/README$/, "");
        }
        result.frontMatter.slug = rel ? `/reference/std/${rel}` : "/reference/std";
        return result;
      }

      const kernelMatch = normalized.match(/\/kernel\/(README|docs\/.+)\.md$/);
      if (kernelMatch) {
        const rel = kernelMatch[1] === "README" ? "" : kernelMatch[1].replace(/^docs\//, "");
        result.frontMatter.slug = rel ? `/reference/kernel/${rel}` : "/reference/kernel";
        return result;
      }

      const sdkMatch = normalized.match(/\/sdk\/(README|nodejs\/README|rust\/README)\.md$/);
      if (sdkMatch) {
        const tail = sdkMatch[1];
        let rel: string;
        if (tail === "README") rel = "";
        else if (tail === "nodejs/README") rel = "nodejs";
        else rel = "rust";
        result.frontMatter.slug = rel ? `/extend/sdk/${rel}` : "/extend/sdk";
        return result;
      }

      const templatingMatch = normalized.match(/\/templating\/nodejs\/docs\/(.+)\.md$/);
      if (templatingMatch) {
        result.frontMatter.slug = `/extend/sdk/nodejs/${templatingMatch[1]}`;
        return result;
      }

      if (/\/cli\/README\.md$/.test(normalized)) {
        result.frontMatter.slug = "/learn/installation-and-cli";
        return result;
      }

      if (/\/tests\/README\.md$/.test(normalized)) {
        result.frontMatter.slug = "/build/testing";
        return result;
      }

      const docsGuideMatch = normalized.match(/\/docs\/guides\/(.+)\.md$/);
      if (docsGuideMatch) {
        result.frontMatter.slug = `/learn/${docsGuideMatch[1]}`;
        return result;
      }

      if (/\/docs\/coding-agents\.md$/.test(normalized)) {
        result.frontMatter.slug = "/build/coding-agents";
        return result;
      }

      return result;
    },
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },

  presets: [
    [
      "classic",
      {
        docs: {
          // Read directly from original markdown files — no copies
          path: "..",
          routeBasePath: "/",
          include: docInclude,
          sidebarPath: "./sidebars.ts",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      "./plugins/llms-txt",
      {
        sections: [{ sidebar: sidebars.docs, docsPath: "..", urlBasePath: "" }],
      },
    ],
  ],

  themeConfig: {
    navbar: {
      title: "⚡ Telo",
      items: [
        { to: "/learn/getting-started", label: "Learn", position: "left" },
        { to: "/build", label: "Build", position: "left" },
        { to: "/deploy", label: "Deploy", position: "left" },
        { to: "/extend/sdk", label: "Extend", position: "left" },
        { to: "/reference/kernel", label: "Reference", position: "left" },
        { to: "/examples", label: "Examples", position: "left" },
        {
          href: "https://github.com/telorun/telo",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      copyright: `Copyright © ${new Date().getFullYear()} CodeNet Sp. z o.o. Released under the Sustainable Use License.`,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
