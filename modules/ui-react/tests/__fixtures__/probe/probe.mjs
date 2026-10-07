// Reads a served page the way a browser would resolve it, without running it.

const exportNames = (source) =>
  [...source.matchAll(/export\s*\{([^}]*)\}/g)]
    .flatMap((match) => match[1].split(","))
    .map((entry) => entry.trim().split(/\s+as\s+/).pop())
    .filter((name) => name && name !== "default")
    .sort();

const specifiers = (source) =>
  [...source.matchAll(/(?:^|[;\n])\s*(?:import|export)\s*(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']/g)].map((match) => match[1]);

/** The bare specifiers a script and every chunk it reaches import. */
async function bareImports(url, seen = new Set()) {
  if (seen.has(url)) return [];
  seen.add(url);
  const source = await (await fetch(url)).text();
  const found = [];
  for (const specifier of specifiers(source)) {
    if (specifier.startsWith(".") || specifier.startsWith("/")) found.push(...(await bareImports(new URL(specifier, url).href, seen)));
    else found.push(specifier);
  }
  return [...new Set(found)].sort();
}

export const ImportMap = {
  async create() {
    return {
      async invoke(resource) {
        const page = await fetch(resource.url);
        const html = await page.text();
        const map = JSON.parse(html.match(/<script type="importmap">(.*?)<\/script>/s)[1]).imports;
        const entries = {};
        for (const [specifier, address] of Object.entries(map)) {
          // Addresses of files, not of specifiers, say where a shared chunk loads from.
          if (specifier.startsWith("/")) continue;
          const response = await fetch(new URL(address, resource.url));
          entries[specifier] = {
            addressed: /\/_telo\/ui\/assets\/[0-9a-f]{64}\/[^/]+\.js$/.test(address),
            status: response.status,
            mediaType: (response.headers.get("content-type") ?? "").split(";")[0],
            cacheControl: response.headers.get("cache-control"),
            exports: exportNames(await response.text()),
          };
        }
        const renderer = new URL(html.match(/<script type="module" src="([^"]+)">/)[1], resource.url).href;
        return {
          status: page.status,
          entries,
          rendererImports: await bareImports(renderer),
          alsoImports: resource.alsoRead ? await bareImports(new URL(resource.alsoRead, resource.url).href) : [],
        };
      },
    };
  },
};

export const Diagnostics = {
  async create(resource, ctx) {
    return {
      async invoke() {
        const checked = await ctx.runtime.check(await ctx.resolveModuleFile(resource.source), { desugarImports: true });
        return { loadError: checked.loadError ?? null, codes: checked.diagnostics.map((diagnostic) => diagnostic.code) };
      },
    };
  },
};
