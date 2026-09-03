---
"@telorun/k8s-runner": minor
---

Publish the Helm chart. It was hosted nowhere — `git clone` + `helm install
./chart` was the only install path — and `Chart.yaml` had never moved off
`version: 0.1.0` / `appVersion: "0.0.0"`, a placeholder nothing read.

It now ships as an OCI artifact at `oci://ghcr.io/telorun/charts/k8s-runner`,
pushed on the release path only, gated on the same "package version moved in this
commit" test that produces the immutable `telorun/k8s-runner:<version>` image tag
and ordered after that image job — so a chart can never name an image the run did
not just build.

**The chart's version is `@telorun/k8s-runner`'s version**, in both `version` and
`appVersion`. `scripts/stamp-chart-version.mjs` writes them from `package.json`
in the changesets Version PR (`pnpm run version-packages`) and `pnpm run
check:charts` fails a PR where the two disagree. A second number would only ever
be a way for the chart and the image to disagree about which runner is installed,
and a chart-only edit already forces a package bump anyway — the changeset gate
attributes any changed file to its nearest package directory. `version` therefore
jumps 0.1.0 → the runner's current version; nothing was published under the old
number.

**Chart renamed `telo-k8s-runner` → `k8s-runner`**, which is the OCI path's last
segment. It matches the image it installs (`telorun/k8s-runner`) and how this repo
already names OCI artifacts (`oci://ghcr.io/telorun/console`), and it is what
every comparable chart does — a chart takes its component's own name and does not
add a vendor prefix its image lacks. **No rendered object is renamed**: the name
helper returns a literal, not `.Chart.Name`, and that literal is also the runner's
default `RUNNER_MANAGED_BY` — the label its orphan reaper and the session
NetworkPolicy select on, so moving it would strand pods from a previous version.

**`image.tag` now defaults to empty and resolves to the chart's `appVersion`**,
with `pullPolicy: IfNotPresent` (was `latest` / `Always`). `--version 0.13.0` has
to install runner 0.13.0; with a floating tag it installed whatever `latest` had
moved to, independently of the chart. Set `image.tag` to run a different runner.
