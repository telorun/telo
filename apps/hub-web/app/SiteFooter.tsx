import { Link } from "react-router";

const LINK =
  "text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring";

/** What the hub is and is not, said once for the whole site. */
export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid w-full max-w-[88rem] gap-8 px-4 py-10 text-sm sm:grid-cols-[2fr_1fr_1fr] sm:px-6">
        <div className="flex max-w-md flex-col gap-2">
          <span className="font-semibold tracking-tight">Telo Hub</span>
          <p className="leading-relaxed text-muted-foreground">
            Federated discovery for Telo modules. The hub indexes metadata only — refs, versions,
            kinds and descriptions — never artifacts, and does not vouch for a module&apos;s
            content. Installs and runs always resolve against the module&apos;s own host.
          </p>
        </div>

        <nav className="flex flex-col gap-2" aria-label="Hub">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Hub</span>
          <Link to="/" className={LINK}>
            Browse modules
          </Link>
          <Link to="/register" className={LINK}>
            Register a module
          </Link>
          <Link to="/mcp" className={LINK}>
            Connect over MCP
          </Link>
        </nav>

        <nav className="flex flex-col gap-2" aria-label="Telo">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Telo</span>
          <a href="https://telo.run" target="_blank" rel="noreferrer noopener" className={LINK}>
            Documentation
          </a>
          <a
            href="https://github.com/telorun/telo"
            target="_blank"
            rel="noreferrer noopener"
            className={LINK}
          >
            Source on GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
