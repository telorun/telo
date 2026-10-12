---
"@telorun/studio": minor
---

Studio: a signed-in developer creates, deploys and watches a Telo Cloud application without leaving Studio. "New Telo Cloud project…" in the workspace menu creates a project — Telo Cloud gives it one stage, Production, on the hosting the form names, which starts on the organization's default — and opens it; an organization's first project has its registry namespace claimed in the same dialog. For an Application, "Publish and deploy" publishes it and has Telo Cloud deploy the published version to the stage picked, following the deployment step by step. A new Cloud tab shows the application in each stage of its project: the version that serves, the deployment under way or why the last one failed, the stage's variables and secrets, its recent deployments, and the actions deploy a published version, revert to the previous version, promote from another stage, restart and cancel. Stopping, deleting, scaling and stages stay in the Telo Cloud console, which each stage links to.

The desktop app asks for two more permissions at sign-in (creating projects and claiming the registry namespace), so a user signed in before this release signs in again to create a project.
