import { SILENT_MESSAGE_TYPE } from "@/silent-authorization";

/** Where the provider lands a silent sign-in check, inside a hidden frame. It
 *  hands the response to the page that framed it and is nothing else: no app,
 *  so no second check starts inside the frame. */
const PAGE = `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Telo Hub</title><script>if(window.parent!==window)window.parent.postMessage({type:${JSON.stringify(SILENT_MESSAGE_TYPE)},search:location.search},location.origin)</script>`;

export function loader() {
  return new Response(PAGE, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
