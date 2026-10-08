import { useId, useState, type FormEvent } from "react";
import { resolveBinding, styleAttribute, type Binding } from "./bindings.js";
import { useHost, type Host } from "./host.js";
import { ErrorNode, type SpecNode } from "./nodes.js";
import { enteredRecord, enteredValues, fieldFindings, Fields, refusalOf, type EnteredValues, type Field } from "./record-fields.js";
import { errorSpec, networkError, responseError, UiError, type ErrorSpec } from "./ui-error.js";
import type { JsonSchema } from "./validation.js";
import { Presented } from "./value-cell.js";

interface ListColumn {
  header: string;
  value: Binding;
  present?: { type?: unknown; format?: unknown };
}

interface List {
  heading?: string;
  rows: Binding;
  columns: ListColumn[];
}

type Answer = Record<string, unknown>;

/** The action contract's request: one `POST` with a JSON body. Whatever the
 *  operation answered is returned; no answer at all is a `UiError`. */
export async function requestAction(host: Host, path: string, record: Record<string, unknown>): Promise<Response> {
  try {
    return await host.fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(record) });
  } catch (error) {
    throw networkError(error);
  }
}

/** What lists are drawn from: the body of a success, which must be a JSON object. */
async function answerOf(response: Response): Promise<Answer> {
  const invalid = (found: string) => new UiError("ERR_UI_RESPONSE_INVALID", `The operation answered with ${found}, and its lists are read from a JSON object.`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Whatever the parser said, the finding is the same one.
    throw invalid("a body that is not JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw invalid(Array.isArray(body) ? "a list" : body === null ? "null" : `a ${typeof body}`);
  return body as Answer;
}

/** One list of an answer, drawn as a table's grid is. */
function AnswerList({ list, result }: { list: List; result: Answer }) {
  const resolved = resolveBinding(list.rows, { result });
  const rows: unknown[] = Array.isArray(resolved) ? resolved : [];
  return (
    <div data-telo-part="list">
      {list.heading !== undefined && <h3 data-telo-part="list-heading">{list.heading}</h3>}
      <div data-telo-part="table-frame">
        <table data-telo-part="table-grid">
          <thead data-telo-part="table-head">
            <tr>
              {list.columns.map((column, index) => (
                <th key={index} data-telo-part="table-header-cell">
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody data-telo-part="table-body">
            {rows.map((row, index) => (
              <tr key={index} data-telo-part="table-row">
                {list.columns.map((column, cell) => (
                  <td key={cell} data-telo-part="table-cell">
                    <Presented value={resolveBinding(column.value, { row, result })} present={column.present} />
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td data-telo-part="table-empty" colSpan={list.columns.length}>
                  No rows.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * A button that runs an operation: the record its fields hold is checked in
 * the page against the input model, sent, and the lists the node declares are
 * drawn from the answer. The fields keep what they hold.
 */
export function Action({ node }: { node: SpecNode }) {
  const host = useHost();
  const id = useId();
  const schema = node.schema as JsonSchema;
  const fields = node.fields as Field[];
  const lists = node.lists as List[];
  const [values, setValues] = useState<EnteredValues>(() => enteredValues(schema, fields));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [failure, setFailure] = useState<ErrorSpec>();
  const [result, setResult] = useState<Answer>();
  const [state, setState] = useState<"idle" | "submitting" | "error">("idle");

  const refuse = (byField: Record<string, string>, other: string[]) => {
    setFieldErrors(byField);
    setFormError(other.length > 0 ? other.join(" ") : undefined);
    setState("error");
  };

  const run = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(undefined);
    setResult(undefined);
    const record = enteredRecord(schema, fields, values);
    const invalid = fieldFindings(schema, fields, record);
    if (Object.keys(invalid).length > 0) return refuse(invalid, []);
    setFieldErrors({});
    setFormError(undefined);
    setState("submitting");
    try {
      const response = await requestAction(host, node.path, record);
      if (response.status === 400) {
        const { byField, other } = refusalOf(await response.json(), fields);
        return refuse(byField, other);
      }
      if (!response.ok) throw await responseError(response);
      // An action that draws nothing does not read what the operation answered.
      if (lists.length > 0) setResult(await answerOf(response));
    } catch (error) {
      setFailure(errorSpec(error, "ERR_UI_REQUEST_FAILED"));
      setState("error");
      return;
    }
    setState("idle");
  };

  return (
    <div data-telo-part="action" data-state={state} data-style={styleAttribute(node.style)}>
      <form data-telo-part="form" autoComplete="off" noValidate onSubmit={run}>
        <Fields
          id={id}
          schema={schema}
          fields={fields}
          values={values}
          errors={fieldErrors}
          onChange={(property, next) => setValues((current) => ({ ...current, [property]: next }))}
        />
        {formError && (
          <div data-telo-part="form-error" role="alert">
            {formError}
          </div>
        )}
        <div data-telo-part="form-actions">
          <button data-telo-part="submit" type="submit" disabled={state === "submitting"}>
            {node.label}
          </button>
        </div>
      </form>
      {failure && <ErrorNode error={failure} />}
      {result && (
        <div data-telo-part="action-result">
          {lists.map((list, index) => (
            <AnswerList key={index} list={list} result={result} />
          ))}
        </div>
      )}
    </div>
  );
}
