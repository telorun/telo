import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  future: {
    v8_middleware: true,
    // Without it the `.data` request for `/module/…/` reaches the loader with the
    // trailing slash stripped, and the canonicalising redirect fires on every
    // client navigation.
    v8_trailingSlashAwareDataRequests: true,
  },
} satisfies Config;
