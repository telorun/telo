---
"@telorun/cli": minor
---

Add `telo upgrade <paths..>` — scans the given manifest files for `Telo.Import` declarations whose `source` is a registry ref (`<namespace>/<name>@<version>`), queries the registry for the latest published version, and rewrites the source in place when a newer version is available.

The command uses the same registry-URL fallback as `install` / `run` (`--registry-url` flag > `TELO_REGISTRY_URL` > `https://registry.telo.run`). Pre-release versions are excluded by default; pass `--include-prerelease` to consider them. `--dry-run` reports the proposed upgrades without touching the file.

Non-registry sources (relative paths, HTTP URLs) and unparseable versions are skipped with a notice rather than treated as errors.
