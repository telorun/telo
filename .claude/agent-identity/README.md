# Agent identity

The campaign skills (`backlog`, `rust-parity`) act on GitHub as `telorun-agent[bot]`, a GitHub App
installed on `telorun/telo`, never as the user who runs them. Their PRs, comments, pushes and
commits are the bot's; each commit credits the user with one `Co-authored-by:` trailer, and the
user reviews and merges.

## Setup (once per machine)

1. The app's private key at `~/.config/telorun-agent/app.pem`, mode `600` (org Settings →
   Developer settings → GitHub Apps → telorun-agent → Generate a private key).
2. `~/.config/telorun-agent/config.json`:
   - `appId` — the app's App ID;
   - `botLogin` — `telorun-agent[bot]`;
   - `botUserId` — `gh api '/users/telorun-agent%5Bbot%5D' --jq .id`;
   - `owner` — the GitHub login whose PR comments the skills take as instructions;
   - `coAuthor` — `Name <email>` for the trailer; the email must be verified on `owner`'s account.

`TELORUN_AGENT_HOME` points at another directory holding both files.

## Commands

`node agent-identity.mjs <command>`:

- `configure` — run inside a skill's worktree. Gives that worktree alone the bot's author and
  committer, an HTTPS push URL and this script as its only GitHub credential helper, proves a
  token can be minted, and prints the bot identity, `owner` and `coAuthor`. Refuses the main
  checkout.
- `gh <args…>` — runs `gh` authenticated as the app.
- `credential <get|store|erase>` — the git credential helper `configure` installs.
- `token` — prints an installation token.

Tokens last an hour and are scoped to `telorun/telo`; one is cached in
`~/.cache/telorun-agent/token.json` and replaced when under ten minutes remain.

The app's repository permissions: Contents, Pull requests, Issues and Actions read/write; Checks
and Commit statuses read.
