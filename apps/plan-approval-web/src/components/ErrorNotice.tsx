import { CircleAlert } from "lucide-react";

import { ReviewApiError } from "@/api/review-api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/** A failed request, shown with the server's code and message. */
export function ErrorNotice({ error }: { error: unknown }) {
  const title =
    error instanceof ReviewApiError ? `${error.code ?? "Request failed"} (${error.status})` : "Something went wrong";
  const message = error instanceof Error ? error.message : String(error);
  const data = error instanceof ReviewApiError ? error.data : undefined;
  return (
    <Alert variant="destructive" role="alert">
      <CircleAlert />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p className="whitespace-pre-wrap">{message}</p>
        {data !== undefined && data !== null && (
          <pre className="mt-1 text-xs whitespace-pre-wrap">{JSON.stringify(data, null, 2)}</pre>
        )}
      </AlertDescription>
    </Alert>
  );
}
