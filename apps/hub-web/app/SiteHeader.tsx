import * as React from "react";
import {
  BookOpen,
  Bot,
  GitBranch,
  Monitor,
  Moon,
  PackagePlus,
  Search,
  Sun,
} from "lucide-react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ModuleAvatar } from "@/ModuleAvatar";
import { moduleLabel, modulePagePath } from "@/module-ref";
import { ProductSwitcher, type TeloProduct } from "@/ProductSwitcher";
import { SessionControl } from "@/SessionControl";
import { fetchRefSuggestions, type RefSuggestion } from "@/api";
import hubMark from "@/telo-hub-mark.svg";

const DOCS_URL = "https://telo.run";
const SOURCE_URL = "https://github.com/telorun/telo";

/** The catalogue pages carry their own, larger search input. */
function isCatalog(pathname: string): boolean {
  return pathname === "/" || pathname.startsWith("/category/");
}

/** The bar every page keeps: where you are, the way back to the catalogue, and
 *  a search that works from anywhere. `browserApiOrigin` is absent only when
 *  the root loader itself failed, and then the bar goes without its search.
 *  Without a product list from accounts it goes without the product switcher. */
export function SiteHeader({
  browserApiOrigin,
  products,
}: {
  browserApiOrigin: string | null;
  products: TeloProduct[] | null;
}) {
  const { pathname } = useLocation();
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-[88rem] items-center gap-3 px-4 sm:px-6">
        <Link
          to="/"
          className="flex shrink-0 items-center gap-2 rounded-md font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <img src={hubMark} alt="" className="size-7" />
          {/* The product family's wordmark: the product's own name in its own hue. */}
          <span>
            Telo <span className="text-product">Hub</span>
          </span>
        </Link>

        <div className="flex flex-1 justify-center">
          {browserApiOrigin && !isCatalog(pathname) && <HeaderSearch origin={browserApiOrigin} />}
        </div>

        <nav className="flex items-center gap-0.5" aria-label="Site">
          <HeaderLink to="/" icon={<Search />} active={isCatalog(pathname)}>
            Browse
          </HeaderLink>
          <HeaderLink to="/mcp" icon={<Bot />}>
            MCP
          </HeaderLink>
          <HeaderLink to="/register" icon={<PackagePlus />}>
            Register
          </HeaderLink>
          <HeaderAnchor href={DOCS_URL} icon={<BookOpen />}>
            Docs
          </HeaderAnchor>
          <HeaderAnchor href={SOURCE_URL} icon={<GitBranch />}>
            GitHub
          </HeaderAnchor>
          <ThemeToggle />
          {products && products.length > 0 && <ProductSwitcher products={products} />}
          <SessionControl className={HEADER_LINK} />
        </nav>
      </div>
    </header>
  );
}

const HEADER_LINK =
  "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4";

/** A label beside its icon, the label dropping away on a narrow screen. */
function HeaderLink({
  to,
  icon,
  active,
  children,
}: {
  to: string;
  icon: React.ReactNode;
  active?: boolean;
  children: string;
}) {
  return (
    <NavLink
      to={to}
      end
      aria-label={children}
      className={({ isActive }) =>
        cn(HEADER_LINK, (active ?? isActive) && "bg-muted font-medium text-foreground")
      }
    >
      {icon}
      <span className="hidden md:inline">{children}</span>
    </NavLink>
  );
}

function HeaderAnchor({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={children}
      className={cn(HEADER_LINK, "hidden sm:flex")}
    >
      {icon}
      <span className="hidden md:inline">{children}</span>
    </a>
  );
}

const SUGGEST_DEBOUNCE_MS = 150;
const MAX_SUGGESTIONS = 6;

/**
 * Search from any page. Enter runs the catalogue search; the list under the
 * input is a second, cheaper thing — registered modules whose ref resembles
 * what was typed, for jumping straight to one whose name is half-remembered.
 */
function HeaderSearch({ origin }: { origin: string }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [query, setQuery] = React.useState("");
  const [suggestions, setSuggestions] = React.useState<RefSuggestion[]>([]);
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const listId = React.useId();

  // A new page starts with an empty box.
  React.useEffect(() => {
    setQuery("");
    setOpen(false);
  }, [pathname]);

  React.useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetchRefSuggestions(origin, trimmed, controller.signal)
        .then((refs) => {
          // Only a ref with a page can be jumped to.
          setSuggestions(refs.filter((r) => modulePagePath(r.ref)).slice(0, MAX_SUGGESTIONS));
          setActive(-1);
        })
        .catch(() => {
          // Aborted by a newer keystroke — that run owns the list.
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [origin, query]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const shown = open && suggestions.length > 0;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      setOpen(false);
    } else if (event.key === "ArrowDown" && shown) {
      event.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (event.key === "ArrowUp" && shown) {
      event.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const picked = shown ? suggestions[active] : undefined;
      if (picked) navigate(modulePagePath(picked.ref)!);
      else if (query.trim()) navigate(`/?${new URLSearchParams({ q: query.trim() })}`);
    }
  };

  return (
    <div
      className="relative w-full max-w-md"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search modules…"
        aria-label="Search modules"
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        className="h-9 bg-card pl-9"
      />
      {shown && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Modules by name"
          className="absolute inset-x-0 top-full z-50 mt-1.5 flex flex-col overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-lg"
        >
          {suggestions.map((suggestion, i) => (
            <li key={suggestion.ref} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
              <Link
                to={modulePagePath(suggestion.ref)!}
                tabIndex={-1}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-2 py-1.5 outline-none",
                  i === active && "bg-accent",
                )}
              >
                <ModuleAvatar module={suggestion} className="size-7 text-xs" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">{moduleLabel(suggestion.ref)}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {suggestion.ref}
                  </span>
                </span>
              </Link>
            </li>
          ))}
          <li className="border-t border-border px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
            Press Enter to search for <q>{query.trim()}</q> by what it does
          </li>
        </ul>
      )}
    </div>
  );
}

type Theme = "system" | "light" | "dark";
const THEMES: Theme[] = ["system", "light", "dark"];
const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon };

/** The stored choice the pre-paint script in the root layout also reads. */
export const THEME_KEY = "hub.theme";

function applyTheme(theme: Theme) {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

/** Cycles system → light → dark. Reads the stored choice after hydration, so
 *  the server render — which cannot know it — never disagrees with the client. */
function ThemeToggle() {
  const [theme, setTheme] = React.useState<Theme>("system");

  React.useEffect(() => {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") setTheme(stored);
  }, []);

  // While following the system, follow it live.
  React.useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const Icon = THEME_ICONS[theme];
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 text-muted-foreground"
      aria-label={`Colour theme: ${theme}. Switch theme`}
      title={`Theme: ${theme}`}
      onClick={() => {
        const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
        setTheme(next);
        if (next === "system") window.localStorage.removeItem(THEME_KEY);
        else window.localStorage.setItem(THEME_KEY, next);
        applyTheme(next);
      }}
    >
      <Icon />
    </Button>
  );
}
