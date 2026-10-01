import { Bot, UserRound } from "lucide-react";
import type { ReactNode } from "react";

import type { TimelineEvent } from "@/api/review-api";
import { stateLabel } from "@/components/PlanStateBadge";
import { Badge } from "@/components/ui/badge";
import { formatTimestamp } from "@/lib/time-format";
import { SafeMarkdown } from "@/plan/SafeMarkdown";

const text = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="text-sm">
      <span className="text-muted-foreground">{label}: </span>
      {children}
    </div>
  );
}

function Plain({ value }: { value: unknown }) {
  return <p className="text-sm whitespace-pre-wrap">{text(value)}</p>;
}

function EventDetails({ event }: { event: TimelineEvent }) {
  const data = event.data;
  switch (event.type) {
    case "submitted":
      return <Field label="Title">{text(data.title)}</Field>;
    case "revised":
      return <Field label="Summary">{text(data.summary)}</Field>;
    case "approval_voided":
      return (
        <Field label="Approval voided">
          approval of hash {text(data.hash).slice(0, 12)} by revision {text(data.byRevision)}
        </Field>
      );
    case "withdrawn":
      return <Field label="Withdrawn from">{stateLabel(text(data.from))}</Field>;
    case "report":
      return (
        <>
          <Field label="Report">
            {text(data.kind)} · state {stateLabel(text(data.state))}
          </Field>
          <SafeMarkdown source={text(data.body)} />
        </>
      );
    case "link":
      return (
        <Field label={text(data.type)}>
          {text(data.url)} — {data.previous ? `${text(data.previous)} → ` : ""}
          {text(data.status)}
        </Field>
      );
    case "comment":
      return (
        <>
          {data.item ? <Field label="On item">{text(data.item)}</Field> : null}
          <Plain value={data.body} />
        </>
      );
    case "decision":
      return (
        <>
          <Field label="Decision">
            {stateLabel(text(data.decision))} of hash {text(data.hash).slice(0, 12)}
          </Field>
          {data.note ? <Plain value={data.note} /> : null}
        </>
      );
    default:
      return <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(data, null, 2)}</pre>;
  }
}

/** Every timeline entry in seq order, each marked with its source. */
export function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <ol className="flex flex-col gap-3">
      {events.map((event) => (
        <li key={event.seq} className="rounded-lg border p-3">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>#{event.seq}</span>
            <span className="font-medium text-foreground">{stateLabel(event.type)}</span>
            <Badge variant={event.source === "reviewer" ? "secondary" : "outline"}>
              {event.source === "reviewer" ? <UserRound /> : <Bot />}
              {event.source}
            </Badge>
            {event.author && <span>by {event.author}</span>}
            {event.revision !== null && <span>revision {event.revision}</span>}
            <span className="ml-auto">{formatTimestamp(event.createdAt)}</span>
          </div>
          <EventDetails event={event} />
        </li>
      ))}
    </ol>
  );
}
