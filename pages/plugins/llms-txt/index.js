const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");

/**
 * Docusaurus plugin that generates llms.txt, llms-full.txt, and per-page
 * markdown files from the docs sidebar. Sections in llms.txt mirror the
 * top-level sidebar categories; nested categories are flattened under their
 * top-level parent (the llms.txt spec only allows one level of H2 sections
 * with a flat bullet list beneath each).
 */
module.exports = function llmsTxtPlugin(context, options = {}) {
  const sidebar = Array.isArray(options.sidebar) ? options.sidebar : [];

  return {
    name: "llms-txt",

    async postBuild({ outDir, siteConfig }) {
      const docsConfig = siteConfig.presets
        .flat()
        .map((p) => (Array.isArray(p) ? p[1] : p))
        .find((opts) => opts?.docs)?.docs;

      if (!docsConfig) return;

      const docsPath = path.resolve(context.siteDir, docsConfig.path ?? "docs");
      const siteUrl = siteConfig.url + (siteConfig.baseUrl ?? "/");

      const sections = walkSidebar(sidebar);
      const resolvedSections = [];
      let totalEntries = 0;

      for (const section of sections) {
        const entries = [];
        for (const doc of section.items) {
          const entry = resolveDoc(doc, { docsPath, outDir, siteUrl });
          if (entry) entries.push(entry);
        }
        if (entries.length) {
          resolvedSections.push({ title: section.title, entries });
          totalEntries += entries.length;
        }
      }

      writeLlmsTxt(outDir, siteConfig, resolvedSections);
      writeLlmsFullTxt(outDir, siteConfig, resolvedSections);

      console.log(
        `[llms-txt] Generated llms.txt (${totalEntries} entries across ${resolvedSections.length} sections) and llms-full.txt`
      );
    },
  };
};

function walkSidebar(sidebar) {
  // First section has no title: entries before the first H2 in llms.txt (the
  // spec allows unsectioned link lists between the blockquote and first H2).
  const sections = [{ title: null, items: [] }];

  const collectDocs = (items, bucket) => {
    for (const item of items) {
      if (typeof item === "string") {
        bucket.push({ id: item, label: null });
      } else if (item && typeof item === "object") {
        if (item.type === "doc" && typeof item.id === "string") {
          bucket.push({ id: item.id, label: item.label ?? null });
        } else if (item.type === "category" && Array.isArray(item.items)) {
          collectDocs(item.items, bucket);
        }
      }
    }
  };

  for (const item of sidebar) {
    if (typeof item === "string") {
      sections[0].items.push({ id: item, label: null });
    } else if (item && typeof item === "object") {
      if (item.type === "doc" && typeof item.id === "string") {
        sections[0].items.push({ id: item.id, label: item.label ?? null });
      } else if (item.type === "category" && Array.isArray(item.items)) {
        const section = { title: item.label || "Section", items: [] };
        collectDocs(item.items, section.items);
        sections.push(section);
      }
    }
  }

  if (sections[0].items.length === 0) sections.shift();
  return sections;
}

function resolveDoc({ id, label }, { docsPath, outDir, siteUrl }) {
  const srcFile = path.join(docsPath, `${id}.md`);
  if (!fs.existsSync(srcFile)) return null;

  const raw = fs.readFileSync(srcFile, "utf8");
  const { data: frontmatter, content } = matter(raw);

  const rawTitle =
    label ||
    frontmatter.title ||
    frontmatter.sidebar_label ||
    content.match(/^#\s+(.*)/m)?.[1] ||
    path.basename(id);
  const title = cleanTitle(rawTitle);

  const slug = frontmatter.slug;
  let routePath;
  if (slug !== undefined) {
    routePath = slug.replace(/^\//, "");
  } else {
    routePath = id.replace(/\/README$/, "");
  }

  const mdOutputPath = routePath
    ? path.join(outDir, routePath + ".md")
    : path.join(outDir, "index.md");
  fs.mkdirSync(path.dirname(mdOutputPath), { recursive: true });
  fs.writeFileSync(mdOutputPath, content.trim() + "\n", "utf8");

  const url = routePath ? `${siteUrl}${routePath}` : siteUrl;
  const description = (frontmatter.description || "").replace(/\n/g, " ").trim();

  return { title, url, description, content: content.trim() };
}

function writeLlmsTxt(outDir, siteConfig, sections) {
  const lines = [
    `# ${siteConfig.title}`,
    "",
    `> ${siteConfig.tagline}`,
    "",
  ];

  for (const section of sections) {
    if (section.title) lines.push(`## ${section.title}`, "");
    for (const entry of section.entries) {
      const desc = entry.description ? `: ${entry.description}` : "";
      lines.push(`- [${entry.title}](${entry.url})${desc}`);
    }
    lines.push("");
  }

  fs.writeFileSync(path.join(outDir, "llms.txt"), lines.join("\n"), "utf8");
}

function writeLlmsFullTxt(outDir, siteConfig, sections) {
  const lines = [
    `# ${siteConfig.title}`,
    "",
    `> ${siteConfig.tagline}`,
    "",
  ];

  for (const section of sections) {
    if (section.title) lines.push(`## ${section.title}`, "");
    for (const entry of section.entries) {
      lines.push(`### ${entry.title}`, "");
      if (entry.description) lines.push(entry.description, "");
      lines.push(`Source: ${entry.url}`, "");
      lines.push(bumpHeadings(stripLeadingH1(entry.content), 2), "");
    }
  }

  fs.writeFileSync(path.join(outDir, "llms-full.txt"), lines.join("\n"), "utf8");
}

function cleanTitle(s) {
  const stripped = s.replace(/^[\s\p{Extended_Pictographic}]+/gu, "").trim();
  return stripped || s.trim();
}

function stripLeadingH1(content) {
  return content.replace(/^\s*#\s+.*\n+/, "");
}

function bumpHeadings(content, offset) {
  const lines = content.split(/\r?\n/);
  let fenceChar = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^(`{3,}|~{3,})/);
    if (fence) {
      const char = fence[1][0];
      if (fenceChar === null) fenceChar = char;
      else if (char === fenceChar) fenceChar = null;
      continue;
    }
    if (fenceChar !== null) continue;
    const heading = line.match(/^(#+)(\s)(.*)$/);
    if (!heading) continue;
    const level = Math.min(heading[1].length + offset, 6);
    lines[i] = "#".repeat(level) + heading[2] + heading[3];
  }
  return lines.join("\n");
}
