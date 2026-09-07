import * as React from "react";
import { AlertCircle, CheckCircle2, Loader2, PackagePlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  registerModule,
  registrationStatus,
  type RegisterResult,
  type RegistrationStatus,
} from "@/api";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | {
      kind: "done";
      result: RegisterResult;
      progress?: RegistrationStatus;
      /** False once the page has stopped asking — a settled status, or the
       *  budget spent. Carried because a spinner that keeps spinning after the
       *  last request claims the page is watching something it is not. */
      polling?: boolean;
    };

/** How long to keep polling after an accepted registration. A cold ingest is an
 *  origin read, a bucket write and an embedding call; past this the page stops
 *  asking and says so — the durable run outlives this tab either way. */
const POLL_INTERVAL_MS = 2000;
const POLL_LIMIT = 60;

export function RegisterModule() {
  const [ref, setRef] = React.useState("");
  const [agreed, setAgreed] = React.useState(false);
  const [status, setStatus] = React.useState<Status>({ kind: "idle" });

  const trimmed = ref.trim();
  const submitting = status.kind === "submitting";
  const canSubmit = Boolean(trimmed) && agreed && !submitting;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setStatus({ kind: "submitting" });
    const result = await registerModule(trimmed);
    setStatus({ kind: "done", result });
  }

  // `/register` answers 202 — the ref is recorded and the indexing is scheduled
  // — so the page reports progress instead of claiming the module is
  // searchable. Cancelled on unmount and on a new submission, so a stale poll
  // never writes over a newer result.
  const acceptedRef = status.kind === "done" && status.result.ok ? status.result.ref : null;
  React.useEffect(() => {
    if (!acceptedRef) return;
    let cancelled = false;
    let polls = 0;
    const tick = async () => {
      const progress = await registrationStatus(acceptedRef);
      if (cancelled) return;
      polls += 1;
      // A settled status stops the poll; `unavailable` does NOT — the hub being
      // briefly unreachable says nothing about the ingest, so the page keeps
      // asking and reports that it currently cannot see.
      const settled = progress.status === "ready" || progress.status === "failed";
      const polling = !settled && polls < POLL_LIMIT;
      setStatus((s) => (s.kind === "done" && s.result.ok ? { ...s, progress, polling } : s));
      if (!polling) return;
      timer = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };
    setStatus((s) => (s.kind === "done" && s.result.ok ? { ...s, polling: true } : s));
    let timer = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [acceptedRef]);

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Add a module ref to the federated discovery hub so it becomes searchable across
        every host and transport. The hub tracks the ref&apos;s versions and indexes each
        resource kind — it stores only discovery metadata, never your artifacts. Installs
        and runs always resolve against your own host.
      </p>

      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label htmlFor="ref" className="text-sm font-medium">
          Module ref
        </label>
        <Input
          id="ref"
          value={ref}
          onChange={(e) => {
            setRef(e.target.value);
            if (status.kind === "done") setStatus({ kind: "idle" });
          }}
          placeholder="oci://ghcr.io/acme/telo-s3 · https://host/path/telo.yaml"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={submitting}
          aria-invalid={status.kind === "done" && !status.result.ok}
          className="font-mono text-[0.8rem]"
        />
        <label
          htmlFor="agree"
          className="mt-1 flex cursor-pointer items-start gap-2.5 text-sm leading-relaxed text-muted-foreground"
        >
          <Checkbox
            id="agree"
            checked={agreed}
            onCheckedChange={(v) => setAgreed(v === true)}
            disabled={submitting}
            className="mt-0.5"
          />
          <span>
            I confirm this module is publicly available and agree that its public metadata —
            versions, resource kinds, and descriptions — may be indexed for discovery. The hub
            stores only metadata, never artifacts, and does not vouch for the module&apos;s
            content.
          </span>
        </label>
        <Button type="submit" size="lg" disabled={!canSubmit} className="self-start">
          {submitting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <PackagePlus className="size-4" />
          )}
          {submitting ? "Validating…" : "Register module"}
        </Button>
      </form>

      {status.kind === "done" && (
        <Result result={status.result} progress={status.progress} polling={status.polling} />
      )}
    </div>
  );
}

function Result({
  result,
  progress,
  polling,
}: {
  result: RegisterResult;
  progress?: RegistrationStatus;
  polling?: boolean;
}) {
  if (result.ok) {
    const done = progress?.status === "ready";
    const failed = progress?.status === "failed";
    const unreachable = progress?.status === "unavailable";
    // The page stopped asking without reaching a settled status. Saying so is
    // the point: the run keeps going, but this view is no longer watching it.
    const gaveUp = polling === false && !done && !failed;
    return (
      <div
        role="status"
        className={
          failed
            ? "flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            : "flex items-start gap-3 rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm text-success"
        }
      >
        {done ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
        ) : failed ? (
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
        ) : gaveUp ? (
          <PackagePlus className="mt-0.5 size-4 shrink-0" />
        ) : (
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
        )}
        {/* min-w-0 lets the column shrink below the ref's intrinsic width —
            without it a long URL sets the flex item's minimum and overflows. */}
        <div className="flex min-w-0 flex-col gap-0.5 text-foreground">
          <span className="font-medium">
            {done
              ? "Indexed"
              : failed
                ? "Indexing failed"
                : gaveUp
                  ? "Registered — still indexing"
                  : unreachable
                    ? "Registered — cannot reach the hub"
                    : "Registered — indexing"}
          </span>
          <span className="break-all text-muted-foreground">
            <code className="font-mono break-all">{result.ref}</code>{" "}
            {done ? (
              <>is indexed — its resource kinds are searchable now.</>
            ) : failed ? (
              <>could not be indexed: {progress?.error || "the last attempt failed"}.</>
            ) : gaveUp ? (
              <>is recorded and still being indexed — reload to check again.</>
            ) : unreachable ? (
              <>
                is recorded. The hub is not answering right now, so this page cannot say how
                far the indexing has got — it keeps running either way.
              </>
            ) : (
              <>
                is recorded. Its resource kinds are being indexed
                {progress && progress.versionsIngested > 0
                  ? ` (${progress.versionsIngested} of ${progress.versionsKnown} versions)`
                  : ""}
                {" "}— this keeps running whether or not you stay on the page.
              </>
            )}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-col gap-0.5 text-foreground">
        <span className="font-medium">Could not register</span>
        {/* Server messages can carry an unbroken ref/URL — break anywhere so a
            long one wraps instead of widening the alert. */}
        <span className="break-all text-muted-foreground">{result.error}</span>
      </div>
    </div>
  );
}
