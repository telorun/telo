/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the hub API (telo.sh). Overridable for local dev against the
   *  docker-compose hub (VITE_HUB_API=http://localhost:8040). */
  readonly VITE_HUB_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
