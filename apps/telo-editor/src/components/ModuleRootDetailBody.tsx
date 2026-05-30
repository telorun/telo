import { isRecord } from "../lib/utils";
import { refTargetName } from "./views/topology/overview-graph";

interface ModuleRootDetailBodyProps {
  fields: Record<string, unknown>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
        {title}
      </div>
      {children}
    </div>
  );
}

/** Read-only summary of a module root (Application / Library) for the detail
 *  panel. Applications show `targets` (visually editable as edges on the canvas);
 *  Libraries have none, so that section is omitted. Variables / secrets are
 *  JSON-Schema declarations edited in Source. */
export function ModuleRootDetailBody({ fields }: ModuleRootDetailBodyProps) {
  // `targets` is present (possibly empty) only on Applications.
  const targets = Array.isArray(fields.targets) ? (fields.targets as unknown[]) : null;
  const variables = isRecord(fields.variables) ? fields.variables : {};
  const secrets = isRecord(fields.secrets) ? fields.secrets : {};

  return (
    <div className="p-3 text-xs">
      {targets && (
        <Section title="Targets">
          {targets.length === 0 ? (
            <p className="text-zinc-400 dark:text-zinc-600">
              No targets — work is carried by auto-starting services.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {targets.map((t, i) => (
                <li
                  key={i}
                  className="rounded border border-zinc-200 bg-zinc-50 px-2 py-1 font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                >
                  {refTargetName(t) ?? String(t)}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <Section title="Variables">
        <KeyList record={variables} emptyLabel="No variables declared." />
      </Section>

      <Section title="Secrets">
        <KeyList record={secrets} emptyLabel="No secrets declared." />
      </Section>

      <p className="mt-2 text-[11px] text-zinc-400 dark:text-zinc-600">
        Variables and secrets are edited in Source.
      </p>
    </div>
  );
}

function KeyList({ record, emptyLabel }: { record: Record<string, unknown>; emptyLabel: string }) {
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return <p className="text-zinc-400 dark:text-zinc-600">{emptyLabel}</p>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {keys.map((k) => {
        const v = record[k];
        const env = isRecord(v) && typeof v.env === "string" ? v.env : null;
        return (
          <li key={k} className="flex items-center gap-2">
            <span className="font-medium text-zinc-700 dark:text-zinc-200">{k}</span>
            {env && (
              <span className="rounded bg-zinc-100 px-1 text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                env: {env}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
