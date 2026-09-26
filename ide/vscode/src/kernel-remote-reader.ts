import type { RemoteReader } from "@telorun/language-host";
import { defaultTransportRegistry } from "@telorun/kernel/transports";

/** Every non-`file:` read an engine asks for, origin-direct through the
 *  kernel's transports — exactly as `telo check` reads an `oci://` or
 *  `https://` module, pins verified. */
export function kernelRemoteReader(): RemoteReader {
  const transports = defaultTransportRegistry().sources();
  return async (uri) => {
    const transport = transports.find((t) => t.supports(uri));
    if (!transport) throw new Error(`the editor has no transport for '${uri}'.`);
    const { text, source } = await transport.read(uri);
    return { uri: source, text };
  };
}
