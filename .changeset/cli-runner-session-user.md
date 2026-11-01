---
"@telorun/cli": minor
---

`telo runner` refuses to start with `RUNNER_SESSION_USER` set (exit `2`, naming it): it is the container runners' session user, and a local runner's sessions run as whoever started it. The `telorun/node` image build context now excludes every `.env` / `.env.*` file, not only the checkout root's.
