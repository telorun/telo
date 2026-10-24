import { formatDisplayMessage, type TextRecord } from "@telorun/sdk";

/** The media type every problem is sent as (RFC 9457). */
export const PROBLEM_MEDIA_TYPE = "application/problem+json";

/** A failure as a transport renders it: its code, its data and the text a person is
 *  shown for it. Its developer `message` is never part of a problem. */
export interface CodedFailure {
  readonly code: string;
  readonly data?: unknown;
  readonly displayMessage?: TextRecord;
}

/**
 * An RFC 9457 problem. `detail` is present only when the failure has a display
 * message, `data` only when it carries data; an uncoded failure is `type`, `title`
 * and `status` alone.
 */
export interface ProblemDetails {
  readonly type: "about:blank";
  readonly title?: string;
  readonly status: number;
  readonly detail?: string;
  readonly code?: string;
  readonly data?: unknown;
}

/** The IANA HTTP Status Code Registry's reason phrases — RFC 9110's for the codes
 *  it defines. Never localized. */
const REASON_PHRASES: Readonly<Record<number, string>> = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Content Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  421: "Misdirected Request",
  422: "Unprocessable Content",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  511: "Network Authentication Required",
};

/** The registered reason phrase for `status`, or undefined for an unregistered one. */
export function httpReasonPhrase(status: number): string | undefined {
  return REASON_PHRASES[status];
}

/**
 * The problem a failure is rendered as under `status`: a coded failure's `code`,
 * `data` and its display message formatted in the language it is written in, with
 * `data` as its values; without `failure`, the bare problem of an uncoded one.
 */
export function problemDetails(status: number | bigint, failure?: CodedFailure): ProblemDetails {
  const code = Number(status);
  const title = httpReasonPhrase(code);
  const problem: { -readonly [K in keyof ProblemDetails]: ProblemDetails[K] } = {
    type: "about:blank",
    ...(title === undefined ? {} : { title }),
    status: code,
  };
  if (!failure) return problem;
  if (failure.displayMessage) problem.detail = formatDisplayMessage(failure.displayMessage, failure.data);
  problem.code = failure.code;
  if (failure.data !== undefined && failure.data !== null) problem.data = failure.data;
  return problem;
}
