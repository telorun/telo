const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");

/**
 * Docusaurus plugin that generates llms.txt and per-page markdown files
 * from the docs include list. Uses the source markdown files directly
 * instead of crawling the filesystem.
 */
module.exports = function llmsTxtPlugin(context) {
  return {
    name: "llms-txt",

    async postBuild({ outDir, siteConfig }) {
      const docsConfig = siteConfig.presets
        .flat()
        .map((p) => (Array.isArray(p) ? p[1] : p))
        .find((opts) => opts?.docs)?.docs;

      if (!docsConfig) return;

      const docsPath = path.resolve(context.siteDir, docsConfig.path ?? "docs");
      const includeFiles = docsConfig.include ?? [];
      const siteUrl = siteConfig.url + (siteConfig.baseUrl ?? "/");

      const entries = [];

      for (const relPath of includeFiles) {
        const srcFile = path.join(docsPath, relPath);
        if (!fs.existsSync(srcFile)) continue;

        const raw = fs.readFileSync(srcFile, "utf8");
        const { data: frontmatter, content } = matter(raw);

        const title =
          frontmatter.title ||
          frontmatter.sidebar_label ||
          content.match(/^#\s+(.*)/m)?.[1] ||
          path.basename(relPath, ".md");

        // Determine the route path Docusaurus would use
        const slug = frontmatter.slug;
        let routePath;
        if (slug !== undefined) {
          routePath = slug.replace(/^\//, "");
        } else {
          routePath = relPath
            .replace(/\/README\.md$/, "")
            .replace(/\.md$/, "");
        }

        // Write a clean markdown file alongside the HTML
        const mdOutputPath = routePath
          ? path.join(outDir, routePath + ".md")
          : path.join(outDir, "index.md");

        fs.mkdirSync(path.dirname(mdOutputPath), { recursive: true });
        fs.writeFileSync(mdOutputPath, content.trim() + "\n", "utf8");

        const mdUrl = routePath
          ? `${siteUrl}${routePath}.md`
          : `${siteUrl}index.md`;

        const description = (frontmatter.description || "").replace(
          /\n/g,
          " "
        );

        entries.push({ title, url: mdUrl, description });
      }

      // Generate llms.txt
      const lines = [
        `# ${siteConfig.title}`,
        "",
        `> ${siteConfig.tagline}`,
        "",
      ];

      for (const entry of entries) {
        const desc = entry.description ? `: ${entry.description}` : "";
        lines.push(`- [${entry.title}](${entry.url})${desc}`);
      }

      lines.push("");

      fs.writeFileSync(path.join(outDir, "llms.txt"), lines.join("\n"), "utf8");

      console.log(
        `[llms-txt] Generated llms.txt with ${entries.length} entries`
      );
    },
  };
};
