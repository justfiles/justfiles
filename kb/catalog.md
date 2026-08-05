# JustApps community catalog

Status: **planned, not started.**

## Decision

Create a dedicated public repository for the JustApps catalog (working name
`justapps/catalog`). Keep the runner and its dependencies in the private `justfiles`
monorepo until they can build and operate using only public dependencies.

When ready, publish the runner separately (working name `justapps/runner`). Do not plan to
move it into the catalog repository: the catalog is community governance and data, while the
runner is executable infrastructure with a different contributor group, release cycle and
security boundary. They can still be one project under a shared JustApps organization.

```text
Public now
└── justapps/catalog

Private for now
└── justfiles
    ├── apps/runner
    └── runner dependencies

Public later
├── justapps/catalog
├── justapps/runner
├── justapps/sdk                 # if needed
└── reusable runtime packages   # extracted only when their boundaries are clear
```

GitHub visibility is repository-wide, so `apps/runner` cannot be made public while the rest
of this monorepo remains private. A dedicated catalog repository gives the community a useful
public surface now without forcing a premature runner extraction or speculative package
interfaces.

## Goals

- Make app admission, ownership changes, deprecation and removal transparent.
- Let contributors propose apps through ordinary pull requests.
- Preserve an auditable history of every catalog decision.
- Avoid building a publisher dashboard or public publishing API initially.
- Keep the public catalog independent of the private runner implementation.
- Serve canonical, immutable snapshots from JustApps infrastructure rather than mutable
  upstream files.

## Non-goals

- The catalog does not contain app assets.
- Merging a catalog entry does not mean unreviewed code is immediately live.
- Catalog validation does not execute arbitrary build commands from contributors.
- The catalog repository is not the runner's runtime database.
- Opening the catalog does not require opening the whole monorepo.

## Precedents

[MELPA](https://github.com/melpa/melpa) is the closest governance model. Contributors add one
recipe per Emacs package. MELPA periodically fetches accepted upstream repositories, packages
the configured files, records the exact source commit, and hosts the resulting package
artifacts itself. Clients install from MELPA, not directly from the upstream repository.

Other community-driven projects split the same responsibilities in different ways:

- [Flathub](https://docs.flathub.org/docs/for-app-authors/submission) reviews manifests in Git,
  runs test builds, and centrally publishes successful official builds.
- [F-Droid](https://f-droid.org/en/docs/Build_Server_Setup/) keeps per-app source/build metadata,
  builds untrusted source in throwaway machines, and centrally hosts the resulting repository.
- [HACS](https://www.hacs.xyz/docs/publish/include/) and Obsidian's
  [community plugin list](https://github.com/obsidianmd/obsidian-releases/blob/master/community-plugins.json)
  maintain public Git catalogs but download release assets from GitHub.
- [Packagist](https://packagist.org/about) indexes upstream repositories and recommends webhooks
  for prompt updates, with periodic crawling as reconciliation.

The common direction is to use Git as the transparent control plane. Projects that promise
stable installation or asset URLs generally snapshot or build artifacts into infrastructure
they control. JustApps needs that second property because it promises URLs such as
`https://app1.justapps.run/gui.js`.

## Public catalog shape

Keep the repository small and use one file per app to avoid a single conflict-prone list.

```text
justapps/catalog
├── README.md
├── CONTRIBUTING.md
├── LICENSE
├── SECURITY.md
├── CODE_OF_CONDUCT.md
├── schema/
│   └── app.schema.json
├── apps/
│   ├── app1.json
│   └── calendar.json
└── .github/
    ├── CODEOWNERS
    ├── pull_request_template.md
    └── workflows/
        └── validate.yml
```

A catalog entry should contain only information needed for admission and release discovery.
Execution metadata and entry points belong in the app manifest inside the release bundle.

```json
{
  "schemaVersion": 1,
  "id": "app1",
  "source": {
    "provider": "github",
    "repository": "owner/app1"
  },
  "release": {
    "strategy": "github-release",
    "asset": "justapp.zip"
  }
}
```

Start with one source provider and one release strategy. Do not add generic URLs, custom build
scripts or provider abstractions until a real accepted app requires them.

## Community workflow

### New app

```text
Contributor opens catalog PR
        ↓
Read-only schema and ownership checks
        ↓
Catalog maintainer review
        ↓
Merge registers the app source
        ↓
Private importer notices the catalog commit
        ↓
Release is downloaded, validated and staged
        ↓
First publication is explicitly approved
```

A submitter must prove control of the upstream repository. Initially require either the PR to
come from its owner/major contributor or a JustApps verification file committed upstream.
Define policies for app-ID reservation, repository moves, ownership transfer, abandonment,
typosquatting, trademarks and takedowns before accepting broad community submissions.

### Updates

Use a periodic pull from the private importer first. Record the last processed catalog commit
SHA so reconciliation is idempotent. Webhooks can reduce latency later, but scheduled scanning
should remain as a fallback for missed events.

Prefer tagged GitHub releases over tracking the default branch. Resolve every tag to an exact
commit and record the source commit and artifact SHA-256. Start with reviewed or explicitly
approved updates; trusted apps may gain automatic publication after the operational and abuse
model is proven.

Changes to an app ID, source repository, ownership, release strategy, entry points or requested
capabilities always require review.

## Import and publication

Git is desired state, not the serving database. After an accepted release is found:

1. Resolve the immutable upstream release and commit.
2. Download the release ZIP.
3. Calculate and record its SHA-256 and provenance.
4. Store the original ZIP in private R2 storage.
5. Validate and extract it into immutable per-release R2 objects.
6. Mark the release ready only after every file succeeds.
7. Publish atomically by changing the app's active-release pointer.

Example storage layout:

```text
packages/{appId}/{releaseId}.zip
releases/{appId}/{releaseId}/files/gui.js
releases/{appId}/{releaseId}/files/images/logo.png
releases/{appId}/{releaseId}/manifest.json
```

A request for `https://app1.justapps.run/gui.js` resolves the hostname to the app, looks up its
active release, and reads
`releases/app1/{activeReleaseId}/files/gui.js`. Never overwrite mutable
`app1/current/*` objects one at a time: a failed upload would expose files from two releases.

Do not serve or reverse-proxy GitHub files at request time. JustApps needs its own snapshot for
availability, correct content metadata, atomic releases, rollback, takedowns and proof of the
exact bytes previously served.

Deleting a catalog file must not immediately delete an app or its R2 objects. Deprecation and
removal should be explicit, reviewable states with a reason; artifact cleanup is a separate
retention process.

## Security boundary

Catalog pull requests are untrusted input.

PR validation must:

- use a read-only `GITHUB_TOKEN`;
- have no Cloudflare, R2 or production credentials;
- never deploy or publish;
- reject unknown fields and malformed app IDs;
- avoid interpolating contributor-controlled values into shell commands;
- avoid privileged `pull_request_target` workflows that check out PR content; and
- pin third-party GitHub Actions to full commit SHAs.

The private post-merge importer has narrowly scoped staging permissions. Production publication
is a separate operation that changes only the active-release pointer. Catalog changes must not
trigger deployment of runner code.

Treat every source repository and ZIP as hostile. Restrict source hosts initially and defend
against path traversal, absolute paths, symlinks, duplicate/case-colliding names, archive bombs,
excessive file counts and unsupported file types. If JustApps later runs arbitrary upstream
build commands, run each build in a disposable sandbox with no signing or publication secrets.

Use separate code ownership for catalog entries, catalog schema and workflows. Protect the
main branch from direct pushes, force pushes and deletion, and require passing checks plus
catalog-owner review.

Rehosting also requires an explicit redistribution licence or permission from the app owner.
Keep credentials, user data, private abuse reports, embargoed vulnerabilities and production
logs outside the public repository.

## Opening the runner later

Do not split the runner merely to make it public before it can stand alone. Continue developing
it in this monorepo until real dependency boundaries emerge.

1. Publish the bundle structure, manifest schema, app-ID rules and security restrictions as the
   first stable public contracts.
2. Extract only genuinely independent leaf modules, such as manifest parsing or bundle
   validation, when they have clear standalone value.
3. Make the runner build exclusively from public dependencies.
4. Audit its current files and full Git history for secrets, private data, licences and internal
   assumptions.
5. Publish it as a separate repository, preserving filtered history or starting from a clean
   public commit as appropriate.

The production deployment configuration, credentials, user data and operational state remain
private even when all implementation code is open source.

## Rollout

### Phase 1 — Public contract

- Create the public catalog repository under the intended long-lived organization.
- Choose licences for repository code and contributed catalog data.
- Add the minimal app schema, contribution rules and ownership verification.
- Mark the catalog experimental and state whether submissions are open.

### Phase 2 — Private ingestion

- Make the private runner/importer reconcile catalog `main` periodically.
- Record catalog commit, source commit, artifact digest and release ID.
- Require explicit approval for first publication and updates.

### Phase 3 — Community operation

- Accept outside submissions.
- Add automated release discovery and update proposals.
- Document transfer, deprecation, removal, moderation and appeal processes.
- Grant trusted applications narrowly defined automatic-update policies if needed.

### Phase 4 — Open runtime

- Open-source reusable dependencies as their boundaries become clear.
- Publish the independently buildable runner in its own repository.
- Keep the catalog and runner separate unless a demonstrated operational reason justifies
  combining them.

## Open decisions

1. Final GitHub organization and repository names.
2. JSON versus another manifest format; JSON plus JSON Schema is the current default.
3. Exact upstream ownership-verification mechanism.
4. Whether accepted updates require a catalog PR or an approval in the service.
5. Licence and redistribution requirements for app bundles and catalog metadata.
6. Initial cache and rollback policy for stable asset URLs.
