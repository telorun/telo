import * as React from "react";
import { AlertCircle, CheckCircle2, Loader2, PackagePlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { registerModule, type RegisterResult } from "@/api";

type Status = { kind: "idle" } | { kind: "submitting" } | { kind: "done"; result: RegisterResult };

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
          placeholder="oci://ghcr.io/acme/telo-s3 · std/console · https://host/path/telo.yaml"
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

      {status.kind === "done" && <Result result={status.result} />}
    </div>
  );
}

function Result({ result }: { result: RegisterResult }) {
  if (result.ok) {
    return (
      <div
        role="status"
        className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm text-success"
      >
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
        {/* min-w-0 lets the column shrink below the ref's intrinsic width —
            without it a long URL sets the flex item's minimum and overflows. */}
        <div className="flex min-w-0 flex-col gap-0.5 text-foreground">
          <span className="font-medium">Registered</span>
          <span className="text-muted-foreground">
            <code className="font-mono break-all">{result.ref}</code> is indexed — its resource
            kinds are searchable now. Older versions are backfilled on the next tracking pass.
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
