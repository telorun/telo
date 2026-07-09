---
"@telorun/docker-runner": minor
---

Load `.env` / `.env.local` (dotenv-flow) from the runner package directory at
startup, so operator secrets like `OPENAI_API_KEY` (injected into app sessions
from the `RUNNER_APPS` catalog) can live in a file instead of being threaded
through the container's environment. Existing environment variables always take
precedence over file values.
