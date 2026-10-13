import * as React from "react";
import { Link } from "react-router";

import { Checkbox } from "@/components/ui/checkbox";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { catalogPath, type CatalogFilters } from "@/catalog-filters";
import { cn } from "@/lib/utils";
import type { CategoryFacet, ModuleType, PublisherFacet, RuntimeFilter } from "@/api";

const ANY_RUNTIME = "any";

/** How the hub's kernel labels read in the filter. */
const RUNTIME_OPTIONS: { value: RuntimeFilter | typeof ANY_RUNTIME; label: string }[] = [
  { value: ANY_RUNTIME, label: "Any" },
  { value: "nodejs", label: "Node" },
  { value: "rust", label: "Rust" },
];

/** Every module is a library or an application; the hint says what each is for. */
const TYPE_OPTIONS: { value: ModuleType; label: string; hint: string }[] = [
  { value: "all", label: "All", hint: "Every module: libraries to import, applications to run." },
  { value: "library", label: "Libraries", hint: "Imported for the kinds and instances they export." },
  { value: "application", label: "Applications", hint: "Run as they are, by pinned ref — never imported." },
];

/**
 * Every control that narrows the catalogue. Rendered twice from one definition:
 * as the rail beside the list on a wide screen, and inside a bottom sheet on a
 * narrow one.
 *
 * A category is a link, because it is a page of its own; the rest are controls
 * over the current page's query string.
 */
export function CatalogFilterControls({
  category,
  filters,
  facets,
  publishers,
  total,
  onChange,
}: {
  category: string;
  filters: CatalogFilters;
  facets: CategoryFacet[];
  publishers: PublisherFacet[];
  /** How many modules the unfiltered catalogue holds, when known. */
  total: number | null;
  onChange: (patch: Partial<CatalogFilters>) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Group title="Type">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          value={filters.type}
          onValueChange={(value) => {
            if (value) onChange({ type: value as ModuleType });
          }}
          className="w-full"
        >
          {TYPE_OPTIONS.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              className="flex-auto px-1.5 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {TYPE_OPTIONS.find((option) => option.value === filters.type)?.hint}
        </p>
      </Group>

      <Group title="Category">
        <ul className="flex flex-col">
          <CategoryLink
            to={catalogPath("", filters)}
            active={!category}
            label="All categories"
            count={total}
          />
          {facets.map((facet) => (
            <CategoryLink
              key={facet.category}
              to={catalogPath(facet.category, filters)}
              active={facet.category === category}
              label={facet.label || facet.category}
              count={facet.modules}
            />
          ))}
        </ul>
      </Group>

      {publishers.length > 0 && (
        <Group title="Publisher">
          <ul className="flex flex-col">
            <CategoryLink
              to={catalogPath(category, { ...filters, publisher: "" })}
              active={!filters.publisher}
              label="All publishers"
              count={null}
            />
            {publishers.map((facet) => (
              <CategoryLink
                key={facet.publisher}
                to={catalogPath(category, { ...filters, publisher: facet.publisher })}
                active={facet.publisher === filters.publisher}
                label={facet.publisher}
                count={facet.modules}
                mono
              />
            ))}
          </ul>
        </Group>
      )}

      <Group title="Runs on">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          disabled={filters.type === "application"}
          value={filters.runtime || ANY_RUNTIME}
          onValueChange={(value) => {
            if (value) onChange({ runtime: value === ANY_RUNTIME ? "" : (value as RuntimeFilter) });
          }}
          className="w-full"
        >
          {RUNTIME_OPTIONS.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              className="flex-1 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {(filters.type === "application" || (filters.type === "all" && filters.runtime)) && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {filters.type === "application"
              ? "The hub does not index which kernels an application runs on."
              : "Applications are left out: the hub does not index which kernels one runs on."}
          </p>
        )}
      </Group>

      {filters.type !== "application" && (
        <Group title="Display">
          <Check
            checked={filters.showDeprecated}
            onChange={(showDeprecated) => onChange({ showDeprecated })}
          >
            Show deprecated modules
          </Check>
          <Check
            checked={filters.hideContractOnly}
            onChange={(hideContractOnly) => onChange({ hideContractOnly })}
          >
            Hide contract-only modules
          </Check>
        </Group>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h2>
      {children}
    </section>
  );
}

function CategoryLink({
  to,
  active,
  label,
  count,
  mono,
}: {
  to: string;
  active: boolean;
  label: string;
  count: number | null;
  mono?: boolean;
}) {
  return (
    <li>
      <Link
        to={to}
        preventScrollReset
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
          active ? "bg-accent font-medium text-accent-foreground" : "text-foreground/80",
        )}
      >
        <span className={cn("truncate", mono && "font-mono text-xs")}>{label}</span>
        {count != null && (
          <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
        )}
      </Link>
    </li>
  );
}

/** The controls render twice at once on a narrow screen (the hidden rail and
 *  the open sheet), so a checkbox takes a generated id, never a fixed one. */
function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-sm">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      {children}
    </label>
  );
}
