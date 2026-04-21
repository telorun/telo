import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";
import sidebars from "./sidebars";

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

  plugins: ["./plugins/llms-txt"],

  themeConfig: {
    navbar: {
      title: "⚡ Telo",
      items: [
        { to: "/kernel/", label: "Kernel", position: "left" },
        { to: "/modules/", label: "Modules", position: "left" },
        { to: "/sdk/", label: "SDK", position: "left" },
        {
          href: "https://github.com/telorun/telo",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      copyright: `Copyright © ${new Date().getFullYear()} DiglyAI. Released under the Fair-code License.`,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
