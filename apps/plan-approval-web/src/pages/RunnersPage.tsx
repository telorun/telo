import { reviewApi } from "@/api/review-api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatAge, formatTimestamp } from "@/lib/time-format";
import { useLoad } from "@/lib/use-load";
import { AppLink, paths } from "@/routing";

export function RunnersPage() {
  const [loaded] = useLoad(() => reviewApi.listRunners(), []);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Runners</h1>
      {loaded.status === "failed" && <ErrorNotice error={loaded.error} />}
      {loaded.status === "loading" && <p className="text-sm text-muted-foreground">Loading runners…</p>}
      {loaded.status === "ready" && loaded.data.runners.length === 0 && (
        <p className="text-sm text-muted-foreground">No runner has reported yet.</p>
      )}
      {loaded.status === "ready" && loaded.data.runners.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Runner</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead>Repositories</TableHead>
              <TableHead>Active sessions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loaded.data.runners.map((runner) => (
              <TableRow key={runner.name}>
                <TableCell>
                  <AppLink href={paths.runner(runner.name)} className="font-medium hover:underline">
                    {runner.name}
                  </AppLink>
                </TableCell>
                <TableCell title={formatTimestamp(runner.lastSeenAt)}>{formatAge(runner.lastSeenAt)}</TableCell>
                <TableCell>{runner.repos.join(", ")}</TableCell>
                <TableCell>{runner.activeSessions.length}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
