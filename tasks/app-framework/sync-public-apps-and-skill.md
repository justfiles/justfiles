---
project: packages/app, justfiles/app-*, justfiles/skills
status: todo
---

# Keep the public apps and the authoring skill on the current SDK

## TL;DR

The published authoring skill tells agents to learn from `justfiles/app-notes` and
`justfiles/app-icon`. Both pin SDKs from August and use `app.invoke`, which 0.16 removed. The
skill's own reference still documents `app.invoke`. An agent following the official path learns a
removed API from two stale examples. For an agent, examples are the API; until they are current,
every other framework improvement is invisible.

## Proposed change

No SDK interface change. Process and tooling:

1. Move every `justfiles/app-*` repository to the current `@justfiles/app` and `@justfiles/design`,
   replacing `app.invoke(...)` with `app.cap.<name>.<method>(...)`. Cut a release of each.
2. Make `docs/app.md` the single source for the model, and have the skill's `app-model.md` and
   `gui-and-hosts.md` be generated from it or link to it at a pinned SDK version. One document
   describes the API.
3. Add a check to the SDK release pipeline: build the `create-app` templates and at least one
   public app against the release candidate. A breaking change that the examples do not compile
   against does not ship.
4. When a breaking change does ship, the same PR updates the skill and the named example apps.

## Why

- **The feedback loop the framework promises starts with reading.** The design goal is that an agent
  can build an app quickly with fast feedback. The first feedback an agent gets is whether the code
  it copied from the recommended example compiles. If that answer is no, the loop is broken before
  the framework is even exercised.
- **Examples carry more weight than reference docs.** An agent pattern-matches on working code. A
  stale example teaches the stale API more effectively than the reference teaches the new one.
- **Breaking changes are only cheap if the ecosystem moves with them.** The SDK has had four
  breaking releases in six weeks. That cadence is acceptable at this stage, but only if the public
  apps and the skill move in the same change. Otherwise each break creates a permanent fork
  between what is documented and what is demonstrated.
- **Robustness of the framework includes its reference material.** A framework whose canonical
  examples do not build against its canonical version has an integration bug, even if every line
  of the framework is correct.
