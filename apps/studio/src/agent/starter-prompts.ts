export interface StarterPrompt {
  id: string;
  label: string;
  prompt: string;
}

/** What an empty conversation offers: requests of the size and precision the
 *  agent works best from. One fills the composer for the user to edit. */
export const STARTER_PROMPTS: StarterPrompt[] = [
  {
    id: "webhook-ingest",
    label: "Receive signed webhooks and store each event exactly once",
    prompt:
      "Build an HTTP service that receives order webhooks at POST /webhooks/orders. " +
      "Verify each request's HMAC-SHA256 signature from the X-Signature header against a shared secret and answer 401 when it does not match. " +
      "Store every order in PostgreSQL exactly once, using the event's id as the idempotency key, and answer 200 to a repeated delivery without writing it again. " +
      "Add GET /orders with cursor pagination, and tests for a valid delivery, a bad signature and a repeat.",
  },
  {
    id: "ticket-api",
    label: "A REST API with validation, filters and pagination",
    prompt:
      "Build a REST API for support tickets on SQLite: create a ticket, read one, change its status (open, pending, solved) and assignee, and list tickets filtered by status and assignee with cursor pagination. " +
      "Validate request bodies, answer 404 for an unknown ticket and 422 with the failing field for an invalid one, and serve an OpenAPI reference page. " +
      "Include a test per route.",
  },
  {
    id: "scheduled-report",
    label: "A scheduled PDF report from a database",
    prompt:
      "Every weekday at 08:00 UTC, count yesterday's signups per plan from a PostgreSQL `signups` table, render a one-page PDF with a bar chart and a totals table, and keep it in a blob store under reports/<date>.pdf. " +
      "Expose GET /reports/{date} to download a report and answer 404 when that day has none. " +
      "Ask me for the table's columns before you write the query.",
  },
  {
    id: "document-qa",
    label: "Answer questions about uploaded PDFs",
    prompt:
      "Build a document question-answering service. " +
      "POST /documents takes a PDF upload of at most 20 MB, extracts its text, splits it into chunks and stores their embeddings in a vector store. " +
      "POST /ask takes a question, finds the most relevant chunks and streams an AI model's answer over SSE, followed by the passages it used with their document and page. " +
      "Refuse a file that is not a PDF, and keep the model's API key in a secret.",
  },
];
