import * as React from "react";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { isRouteErrorResponse, Link } from "react-router";

import { Button } from "@/components/ui/button";

const HEADINGS: Record<number, { title: string; text: string }> = {
  404: { title: "Page not found", text: "Nothing on the hub lives at this address." },
  503: {
    title: "Hub unavailable",
    text: "The hub is not answering right now. Try again in a minute.",
  },
};

const FALLBACK = { title: "Something went wrong", text: "This page could not be rendered." };

/** The body every error status renders. It never shows error detail — that is
 *  logged on the server and stays there. */
export function StatusPage({
  status,
  heading,
  children,
}: {
  status: number;
  heading?: string;
  children?: React.ReactNode;
}) {
  const { title, text } = HEADINGS[status] ?? FALLBACK;
  return (
    <div className="flex flex-col gap-6">
      <Button variant="ghost" size="sm" className="self-start -ml-2" asChild>
        <Link to="/">
          <ArrowLeft className="size-3.5" /> All modules
        </Link>
      </Button>
      <div
        role="alert"
        className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm"
      >
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="font-medium">{heading ?? title}</h1>
          <span className="break-all text-muted-foreground">{children ?? text}</span>
        </div>
      </div>
    </div>
  );
}

/** The status an error boundary renders: a thrown status response's own, and
 *  500 for anything else. */
export function errorStatus(error: unknown): number {
  return isRouteErrorResponse(error) ? error.status : 500;
}
