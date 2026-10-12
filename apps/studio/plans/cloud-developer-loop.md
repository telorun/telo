# The developer loop in Studio: create, publish, deploy, observe

A signed-in developer does everything a developer needs of Telo Cloud without
leaving Studio: creates a project, publishes an application, deploys it to a
stage and watches it run. The Cloud console keeps what is not a developer's
daily work. This extends `plans/cloud-projects.md`, whose transport, session
and working-copy rules are unchanged.

## What Studio does

- **New Telo Cloud project** (workspace menu, "Open from Telo Cloud", "Copy to
  Telo Cloud project", the closed-workspace screen): name, slug, and where the
  project runs. Telo Cloud gives every new project one stage, `Production`, on
  that place. The form shows the choice Cloud would make for a request that
  names none — the organization's default placement, else its only place — and
  asks only when there are several and no default. With no hosting the project
  is created without a stage and the form says so first. An organization's
  first project needs its registry namespace, claimed in the same dialog by
  those who may; the claim is permanent and the dialog says so.
- **Publish and deploy** (the project bar, for an Application): the publication
  names a stage (`deploy: {stageId}`) and Telo Cloud starts the deployment once
  the module is published. Studio only watches: the publication until its
  `deploy` is `started`, `failed` or `skipped`, then the deployment.
- **The Cloud view** (a view tab of an Application while a Cloud project is
  open): one card per stage with what serves, the deployment under way, and the
  actions deploy a published version, revert to the previous version, promote
  from another stage, restart, apply changed variables, cancel a deployment not
  yet applying; the stage's variables and secrets; its recent deployments.

## Decisions

- **Telo Cloud chains publish and deploy, not Studio.** A deployment Studio
  started after polling a publication would be lost with the tab.
- **Studio never stops or deletes.** Suspending, resuming and deleting an
  environment, an app or a project, scaling, stages and hosting stay in the
  console; each stage's card links there. Going back is "revert to the previous
  version" (Cloud's rollback), which removes nothing.
- **A deployment is followed over its event stream, through the one
  transport.** The stream is a response body like any other, so both builds
  read it without a second channel. It is reopened after the last event seen
  when it ends early (a dropped connection, the credential's expiry), and the
  deployment is read again on every step. The overview is polled (10 s, 3 s
  while a deployment runs, and on focus), because the console and other people
  change it too.
- **What a session may do is read from its permissions, never guessed.**
  `cloud:projects.create` gates the form, `cloud:registry.manage` the claim;
  both builds' clients ask for them, and a token carries only those the user's
  organization role holds. A sign-in from before this release lacks them until
  the user signs in again, and the dialog says that.
- **The console's address comes from the session** (`consoleUrl` of
  `GET /api/session`, and of `GET /api/v1/principal` through the desktop shell),
  never from a setting or a link.
- **A secret is write-only in Studio as in Cloud.** Its value is replaced,
  never shown; the input is cleared after it is sent.

## Outside Studio

Telo Cloud provides: `POST /api/v1/projects` with the automatic first stage and
the optional `placement`; `GET /api/v1/project-placements`; the registry
namespace routes; `deploy` on a publication; the stage, deployment-state,
deployment, config and event-stream routes; the scopes on both Studio clients.

Not built yet, in either repository: an environment's runtime logs.
