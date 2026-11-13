/** Fetching from a registry, with a refusal that names the URL and the reason. */

export class RegistryError extends Error {}

const USER_AGENT = "telorun-release (https://github.com/telorun/telo)";

/** The response, or `undefined` for a 404; any other failure throws. */
export async function fetchOrAbsent(url: string, headers: Record<string, string> = {}): Promise<Response | undefined> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { "user-agent": USER_AGENT, ...headers } });
  } catch (err) {
    throw new RegistryError(`${url} cannot be reached: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (response.status === 404) return undefined;
  if (!response.ok) throw new RegistryError(`${url} answered ${response.status} ${response.statusText}.`);
  return response;
}

export async function fetchBytes(url: string, headers: Record<string, string> = {}): Promise<Uint8Array> {
  const response = await fetchOrAbsent(url, headers);
  if (!response) throw new RegistryError(`${url} answered 404.`);
  return new Uint8Array(await response.arrayBuffer());
}
