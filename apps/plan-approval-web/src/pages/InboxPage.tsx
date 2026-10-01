import * as React from "react";

import { PLAN_STATES, reviewApi, type InboxFilter } from "@/api/review-api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { OverdueBadge, PlanStateBadge, stateLabel } from "@/components/PlanStateBadge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FilterSelect } from "@/inbox/FilterSelect";
import { formatAge, formatTimestamp } from "@/lib/time-format";
import { useLoad } from "@/lib/use-load";
import { AppLink, paths } from "@/routing";

// Ages the server's `age` filter takes: plans whose latest revision is at least this old.
const AGES = [
  { value: "1h", label: "1 hour or older" },
  { value: "24h", label: "1 day or older" },
  { value: "72h", label: "3 days or older" },
  { value: "168h", label: "1 week or older" },
];

const FILTER_KEYS = ["product", "repo", "status", "age"] as const;

function filterFromLocation(): InboxFilter {
  const search = new URLSearchParams(window.location.search);
  return Object.fromEntries(FILTER_KEYS.map((key) => [key, search.get(key) ?? ""]));
}

export function InboxPage() {
  const [filter, setFilter] = React.useState<InboxFilter>(filterFromLocation);
  const [choices] = useLoad(() => Promise.all([reviewApi.listProducts(), reviewApi.listRepos()]), []);
  const [plans] = useLoad(() => reviewApi.listPlans(filter), [filter.product, filter.repo, filter.status, filter.age]);

  const update = (key: keyof InboxFilter, value: string) => {
    const next = { ...filter, [key]: value };
    setFilter(next);
    const search = new URLSearchParams();
    for (const k of FILTER_KEYS) if (next[k]) search.set(k, next[k]!);
    const text = search.toString();
    window.history.replaceState(null, "", text === "" ? paths.inbox() : `${paths.inbox()}?${text}`);
  };

  const products = choices.data?.[0].products ?? [];
  const repos = choices.data?.[1].repos ?? [];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Inbox</h1>
      {choices.status === "failed" && <ErrorNotice error={choices.error} />}
      <div className="flex flex-wrap gap-3">
        <FilterSelect
          id="filter-product"
          label="Product"
          value={filter.product ?? ""}
          options={products.map((p) => ({ value: p.slug, label: p.name }))}
          onChange={(value) => update("product", value)}
        />
        <FilterSelect
          id="filter-repo"
          label="Repository"
          value={filter.repo ?? ""}
          options={repos.map((r) => ({ value: r.slug, label: r.slug }))}
          onChange={(value) => update("repo", value)}
        />
        <FilterSelect
          id="filter-status"
          label="Status"
          value={filter.status ?? ""}
          options={PLAN_STATES.map((s) => ({ value: s, label: stateLabel(s) }))}
          onChange={(value) => update("status", value)}
        />
        <FilterSelect
          id="filter-age"
          label="Waiting"
          value={filter.age ?? ""}
          options={AGES}
          onChange={(value) => update("age", value)}
        />
      </div>
      {plans.status === "failed" && <ErrorNotice error={plans.error} />}
      {plans.status === "loading" && <p className="text-sm text-muted-foreground">Loading plans…</p>}
      {plans.status === "ready" && plans.data.plans.length === 0 && (
        <p className="text-sm text-muted-foreground">No plans match.</p>
      )}
      {plans.status === "ready" && plans.data.plans.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Plan</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>Repository</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Revision</TableHead>
              <TableHead>Latest revision</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plans.data.plans.map((plan) => (
              <TableRow key={plan.id}>
                <TableCell>
                  <AppLink href={paths.plan(plan.id)} className="font-medium hover:underline">
                    {plan.title}
                  </AppLink>
                  <div className="text-xs text-muted-foreground">{plan.loop}</div>
                </TableCell>
                <TableCell>{plan.product}</TableCell>
                <TableCell>{plan.repo}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <PlanStateBadge state={plan.state} />
                    {plan.overdue && <OverdueBadge />}
                  </div>
                </TableCell>
                <TableCell>{plan.latestRevision.seq}</TableCell>
                <TableCell title={formatTimestamp(plan.latestRevision.createdAt)}>
                  {formatAge(plan.latestRevision.createdAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
