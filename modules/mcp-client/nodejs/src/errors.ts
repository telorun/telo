import { InvokeError } from "@telorun/sdk";

export type McpErrorCode =
  | "ERR_MCP_TRANSPORT"
  | "ERR_MCP_PROTOCOL"
  | "ERR_MCP_JSON_RPC_ERROR"
  | "ERR_MCP_TOOL_ERROR"
  | "ERR_MCP_SESSION_INVALID";

export function transportError(message: string, data?: unknown): InvokeError {
  return new InvokeError("ERR_MCP_TRANSPORT", message, data);
}

export function protocolError(message: string, data?: unknown): InvokeError {
  return new InvokeError("ERR_MCP_PROTOCOL", message, data);
}

export function jsonRpcError(
  code: number,
  serverMessage: string,
  data?: unknown,
): InvokeError {
  return new InvokeError(
    "ERR_MCP_JSON_RPC_ERROR",
    `MCP server returned JSON-RPC error ${code}: ${serverMessage}`,
    { code, message: serverMessage, data },
  );
}

export function toolError(content: unknown): InvokeError {
  return new InvokeError(
    "ERR_MCP_TOOL_ERROR",
    "MCP tool call returned isError: true",
    { content },
  );
}

export function sessionInvalidError(message: string, data?: unknown): InvokeError {
  return new InvokeError("ERR_MCP_SESSION_INVALID", message, data);
}
