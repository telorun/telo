---
"@telorun/runner-core": minor
---

Add `loadAgentFromObject`, which builds the co-resident agent from a configuration file a runner has already parsed. It takes the same settings as the `AGENT_*` variables (`image` / `moduleRef`, `port`, `pullPolicy`, `tokenEnv`, `title`, `description`, `env`), validates them the same way, and names the file's keys in each refusal. The file is closed — an unknown key is refused — and holds no secret: `secretEnv` lists names, each read from the `AGENT_SECRET_<NAME>` variable, and an unset one is refused. `loadAgentFromEnv` is unchanged and shares the validation. `sessionContainersConfig` completes session-container settings a runner read itself with `RUNNER_INTERNAL_URL`, naming the setting that turned them on when the URL is missing.
