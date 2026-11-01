---
"@telorun/cli": minor
---

The `telorun/node` image now runs as the unprivileged `node` user (uid 1000) with `/workspace` owned by it. A derived image copies its app with `COPY --chown=node:node` before `telo install`, and switches to `USER root` only around steps that need it (such as `apt-get`), returning to `USER node` afterwards.
