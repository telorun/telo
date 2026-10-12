import { KeyRound, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { CloudApi, ConfigVar } from "../../../cloud/api";
import { CloudApiError } from "../../../cloud/api";
import { deploymentRefusalMessage } from "../../../cloud/deployment-progress";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";

interface ConfigEditorProps {
  api: CloudApi;
  projectId: string;
  environmentId: string;
  /** False for those who may only read the environment. */
  canEdit: boolean;
  /** Config or secrets changed: the environment says so from now on. */
  onChanged: () => void;
}

function configRefusalMessage(err: unknown): string {
  if (err instanceof CloudApiError) {
    if (err.code === "invalid_config_key")
      return "That is not a usable name: use an environment-variable name. Names starting with TELO_ or npm_config_, and DOCKER_CONFIG, are reserved.";
    if (err.code === "config_limit_exceeded")
      return "Too large: a value holds at most 32 KiB, and an environment's variables together at most 256 KiB.";
  }
  return deploymentRefusalMessage(err);
}

/**
 * The variables and secrets of one environment in Telo Cloud. A secret's value
 * is write-only: Cloud stores it encrypted and never sends it back, so it is
 * replaced, never shown. A change takes effect with the environment's next
 * deployment.
 */
export function ConfigEditor({
  api,
  projectId,
  environmentId,
  canEdit,
  onChanged,
}: ConfigEditorProps) {
  const [entries, setEntries] = useState<ConfigVar[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [isSecret, setIsSecret] = useState(false);

  const load = useCallback(async () => {
    try {
      setEntries(await api.listConfig(projectId, environmentId));
      setError(null);
    } catch (err) {
      setError(configRefusalMessage(err));
    }
  }, [api, environmentId, projectId]);

  useEffect(() => {
    setEntries(null);
    void load();
  }, [load]);

  async function change(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
      onChanged();
      return true;
    } catch (err) {
      setError(configRefusalMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const name = key.trim();
    if (name === "" || busy) return;
    if (await change(() => api.setConfig(projectId, environmentId, name, { value, isSecret }))) {
      setKey("");
      setValue("");
      setIsSecret(false);
    }
  }

  return (
    <div className="space-y-2 text-xs">
      {error && <p className="text-destructive">{error}</p>}
      {entries === null && !error && <p className="text-muted-foreground">Loading…</p>}
      {entries?.length === 0 && (
        <p className="text-muted-foreground">No variables or secrets are set in this stage.</p>
      )}
      {entries && entries.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {entries.map((entry) => (
            <li key={entry.key} className="flex items-center gap-2 px-2 py-1">
              <code className="w-48 shrink-0 truncate" title={entry.key}>
                {entry.key}
              </code>
              {entry.isSecret ? (
                <span className="flex min-w-0 flex-1 items-center gap-1 text-muted-foreground">
                  <KeyRound className="size-3" />
                  Secret — never shown
                </span>
              ) : (
                <code className="min-w-0 flex-1 truncate" title={entry.value ?? ""}>
                  {entry.value}
                </code>
              )}
              {canEdit && (
                <>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() => {
                      setKey(entry.key);
                      setValue(entry.isSecret ? "" : (entry.value ?? ""));
                      setIsSecret(entry.isSecret);
                    }}
                  >
                    {entry.isSecret ? "Replace" : "Edit"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={busy}
                    title={`Remove ${entry.key}`}
                    aria-label={`Remove ${entry.key}`}
                    onClick={() =>
                      void change(() => api.deleteConfig(projectId, environmentId, entry.key))
                    }
                  >
                    <Trash2 />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form
          autoComplete="off"
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => void save(event)}
        >
          <Input
            className="h-7 w-48 text-xs"
            autoComplete="off"
            aria-label="Name"
            placeholder="NAME"
            value={key}
            maxLength={128}
            disabled={busy}
            onChange={(event) => setKey(event.target.value)}
          />
          <Input
            className="h-7 min-w-40 flex-1 text-xs"
            autoComplete="off"
            aria-label="Value"
            placeholder={isSecret ? "Secret value" : "Value"}
            type={isSecret ? "password" : "text"}
            value={value}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
          />
          <label className="flex items-center gap-1.5">
            <Checkbox
              checked={isSecret}
              disabled={busy}
              onCheckedChange={(checked) => setIsSecret(checked === true)}
            />
            Secret
          </label>
          <Button type="submit" size="xs" disabled={busy || key.trim() === ""}>
            {entries?.some((entry) => entry.key === key.trim()) ? "Replace" : "Add"}
          </Button>
        </form>
      )}
      <p className="text-muted-foreground">
        A change takes effect with this stage's next deployment.
      </p>
    </div>
  );
}
