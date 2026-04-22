# Docker Port Forwarding

Expose container ports from the editor's Docker run adapter via per-environment
deployment config. Ports are literal integers chosen by the operator, stored
alongside `env`.

## Data model

`apps/telo-editor/src/model.ts`:

```ts
export interface PortMapping {
  port: number;
  protocol: "tcp" | "udp";
}

export interface DeploymentEnvironment {
  id: string;
  name: string;
  env: Record<string, string>;
  ports?: PortMapping[]; // NEW, optional
}
```

Single-port mapping, no host/container split — containerisation semantics
stay inside the runner. A Docker runner publishes `-p port:port/proto`; a
native runner (if we ever ship one) just binds to `port` directly.

Optional field — old `telo-editor-deployments-v1` localStorage entries
deserialise unchanged, no migration.

## Touchpoints

| Layer | File | Change |
| --- | --- | --- |
| Types | `src/model.ts` | Add `PortMapping`, extend `DeploymentEnvironment` |
| Mutator | `src/deployment.ts` | Add `setActiveEnvironmentPorts` |
| Editor state | `src/components/Editor.tsx` | `handleSetDeploymentPorts`; include `environment.ports` in run request |
| View props | `src/components/views/types.ts` | Add `onSetPorts` + ports on the `deployment` prop |
| View layout | `src/components/views/deployment/DeploymentView.tsx` | Render `PortsEditor` under env-vars table |
| UI editor | `src/components/views/deployment/PortsEditor.tsx` (new) | Mirror `EnvVarsEditor.tsx`; columns: host / container / protocol |
| Run request | `src/run/types.ts` | `RunRequest.ports?: PortMapping[]` (top-level, like `env`) |
| Adapter protocol | `src/run/adapters/tauri-docker/protocol.ts` | Add `ports` to `RunStartPayload` |
| Adapter forwarder | `src/run/adapters/tauri-docker/adapter.ts` | Forward `request.ports` into `invoke("run_start", ...)` |
| Rust handler | `src-tauri/src/run/mod.rs` + `src-tauri/src/run/docker.rs` | `ports` param; push `-p H:C/proto` args; resolve runner host (`localhost` by default, derived from `dockerHost` if remote) and emit it once the container starts |
| Run UI | `src/run/context.tsx` + `src/run/ui/RunView.tsx` | Carry `runnerHost` + `ports` on `ActiveRun`; render one chip per port as `{host}:{port}`, clickable as `http://{host}:{port}` when protocol is `tcp` |
| http-server default | `modules/http-server/telo.yaml` | `host` default → `0.0.0.0` |

## Transport

`ports` rides top-level on `RunStartPayload` alongside `env` — it comes from
the per-app environment, not from global `TauriDockerConfig`.
