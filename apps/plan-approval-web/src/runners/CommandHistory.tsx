import { History } from "lucide-react";

import type { RunnerCommand } from "@/api/review-api";
import { stateLabel } from "@/components/PlanStateBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTimestamp } from "@/lib/time-format";
import { AppLink, paths } from "@/routing";

const STATE_VARIANT = {
  pending: "default",
  done: "outline",
  failed: "destructive",
  superseded: "secondary",
} as const;

function Target({ command }: { command: RunnerCommand }) {
  switch (command.type) {
    case "wake":
      return (
        <>
          {command.plan && (
            <AppLink href={paths.plan(command.plan)} className="hover:underline">
              plan {command.plan.slice(0, 8)}
            </AppLink>
          )}{" "}
          {command.decision && stateLabel(command.decision)}
          <div className="font-mono text-xs text-muted-foreground">{command.session}</div>
        </>
      );
    case "start":
      return (
        <>
          <div className="font-mono text-xs">{command.sessionName}</div>
          <div className="font-mono text-xs text-muted-foreground">{command.session ?? "session not reported yet"}</div>
          <div className="mt-1 line-clamp-3 text-xs whitespace-pre-wrap">{command.prompt}</div>
        </>
      );
    case "stop":
      return <div className="font-mono text-xs">{command.session}</div>;
  }
}

/** The runner's commands, newest first, with their outcomes: a window that
 *  "Load older" extends. */
export function CommandHistory({
  commands,
  exhausted,
  onLoadOlder,
}: {
  commands: RunnerCommand[];
  exhausted: boolean;
  onLoadOlder: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Command history</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {commands.length === 0 ? (
          <p className="text-sm text-muted-foreground">No command yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Repository</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Created / completed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {commands.map((command) => (
                <TableRow key={command.seq} className="align-top">
                  <TableCell>{command.seq}</TableCell>
                  <TableCell>{command.type}</TableCell>
                  <TableCell className="whitespace-normal">
                    <Badge variant={STATE_VARIANT[command.state]}>{command.state}</Badge>
                    {command.error && (
                      <div className="mt-1 text-xs text-destructive">
                        {command.error.code}: {command.error.message}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{command.repo}</TableCell>
                  <TableCell className="max-w-80 whitespace-normal">
                    <Target command={command} />
                  </TableCell>
                  <TableCell>{command.author ?? "server"}</TableCell>
                  <TableCell className="text-xs">
                    <div>{formatTimestamp(command.createdAt)}</div>
                    {command.completedAt && <div className="text-muted-foreground">{formatTimestamp(command.completedAt)}</div>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {!exhausted && (
          <Button variant="outline" size="sm" className="self-start" onClick={onLoadOlder}>
            <History />
            Load older
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
