# JustApps community catalog

Status: **planned, not started.**

## Decision

Create a dedicated public repository, `justfiles/catalog`, in the `justfiles` GitHub
organization. Keep the runner and its dependencies in the private monorepo (also named
`justfiles`, and distinct from the organization) until they can build and operate using only
public dependencies.

**GitHub is the only distribution channel.** An author needs a GitHub account to open the
catalog pull request, so requiring anything else — an npm account, a second namespace, a
second account-recovery story — is a second barrier for no gain. One channel, done properly,
beats two channels done partially.

When ready, publish the runner separately (working name `justfiles/runner`). Do not plan to
move it into the catalog repository: the catalog is community governance and data, while the
runner is executable infrastructure with a different contributor group, release cycle and
security boundary. They remain one project under the shared organization.

```text
Public now
├── justfiles/catalog
├── justfiles/release           # reusable release workflow authors call
└── justfiles/app-draw          # first app out of the monorepo; the template

Private for now
└── the monorepo
    ├── apps/runner
    └── runner dependencies

Public later
├── justfiles/runner
├── justfiles/sdk               # if needed
└── reusable runtime packages  # extracted only when their boundaries are clear
```

GitHub visibility is repository-wide, so `apps/runner` cannot be made public while the rest
of this monorepo remains private. A dedicated catalog repository gives the community a useful
public surface now without forcing a premature runner extraction or speculative package
interfaces.

## Goals

- Make app admission, ownership changes, deprecation and removal transparent.
- Let contributors propose apps through ordinary pull requests.
- Preserve an auditable history of every catalog decision.
- Keep the marginal cost of a release at zero for both the author and the maintainer.
- Avoid building a publisher dashboard or public publishing API initially.
- Keep the public catalog independent of the private runner implementation.
- Serve canonical, immutable snapshots from JustApps infrastructure rather than mutable
  upstream files.

## Non-goals

- The catalog does not contain app assets.
- The catalog does not record versions. Releases are discovered, never declared.
- Merging a catalog entry does not mean unreviewed code is immediately live.
- JustApps never builds contributor source.
- The catalog repository is not the runner's runtime database.
- Opening the catalog does not require opening the whole monorepo.

## Precedents

This design is assembled from projects that run community catalogs without a corporate
operations team behind them. Each contributed one specific mechanism.

| Borrowed | From |
| --- | --- |
| Minimal entry; the filename is the ID and the repository is the source of truth | [MELPA](https://github.com/melpa/melpa), [Obsidian](https://github.com/obsidianmd/obsidian-releases) |
| Aliases for renamed apps (`:old-names`) | [MELPA](https://github.com/melpa/melpa) |
| Tombstones so a retired ID stays unclaimable | [npm](https://blog.npmjs.org/post/141905368000/changes-to-npms-unpublish-policy) |
| Auto-discovery from tags; no pull request per release | [Package Control](https://docs.sublimetext.io/reference/package-control/repository.html) |
| Prioritised download fallback ladder | [HACS](https://www.hacs.xyz/docs/publish/start/) |
| Commit-date versioning for untagged repositories | [MELPA](https://github.com/melpa/melpa) |
| `sha256` pinned per artifact in the index | [Krew](https://krew.sigs.k8s.io/docs/developer-guide/plugin-manifest/) |
| Contributor-runnable validation script | [Espanso](https://github.com/espanso/hub) |
| Central snapshot and rehost rather than upstream proxying | [MELPA](https://github.com/melpa/melpa), [Flathub](https://docs.flathub.org/docs/for-app-authors/submission) |

Deliberately **not** copied:

| Avoided | Why |
| --- | --- |
| A version field in the registry ([Zed](https://deepwiki.com/zed-industries/extensions/1.1-extension-registry-system)) | One pull request per release, forever |
| Exact tag-to-manifest string equality ([Obsidian](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)) | Pure author friction; failed submissions over a `v` prefix |
| Git submodules ([Zed](https://deepwiki.com/zed-industries/extensions/1.1-extension-registry-system)) | Hostile to contributors |
| Flat namespace plus a dispute process ([npm](https://docs.npmjs.com/policies/disputes/), [PyPI](https://www.python.org/dev/peps/pep-0541/)) | Unbounded maintainer cost — see below |
| Vendoring app source into the catalog ([Espanso](https://github.com/espanso/hub)) | Repository grows without bound |
| Building untrusted source ([F-Droid](https://f-droid.org/en/docs/Build_Server_Setup/)) | Needs a build-server fleet |

The common direction is to use Git as the transparent control plane. Projects that promise
stable installation or asset URLs generally snapshot artifacts into infrastructure they
control. JustApps needs that second property because it promises URLs such as
`https://app1.justapps.run/gui.js`.

## Public catalog shape

Keep the repository small, and use one flat file per app. Flat, because the reverse-DNS ID is
already the hierarchy: entries sort by namespace for free, and `apps/io.github.alice.*` is the
"everything by this author" query. Nesting by owner re-encodes information the name already
carries, and splits the ID across path segments that then have to be checked for agreement.

```text
justfiles/catalog
├── README.md                          # what this is, status, how to submit
├── CONTRIBUTING.md                    # the ladder, the rules, what the bot checks
├── CODE_OF_CONDUCT.md
├── SECURITY.md                        # how to report a malicious app
├── LICENSE                            # this repository's code
├── LICENSE-DATA                       # catalog entries; likely CC0
├── apps/
│   ├── io.github.alice.calendar.json
│   └── io.github.xiaoxing.notes.json
├── schema/
│   └── app.schema.json
├── .vscode/
│   └── settings.json                  # maps apps/*.json to the schema
└── .github/
    ├── CODEOWNERS                     # schema/ and workflows/ only — see below
    ├── pull_request_template.md
    ├── ISSUE_TEMPLATE/
    │   └── report-app.yml             # abuse and malware reports
    ├── scripts/
    │   └── validate.ts                # contributors run this before submitting
    └── workflows/
        └── validate.yml
```

**The filename is the ID.** MELPA's recipes work this way, and two checks disappear with it:
there is no ID field that can disagree with the filename, and the filesystem itself enforces
uniqueness, so two entries cannot claim the same ID. What remains is the pointer:

`apps/io.github.alice.calendar.json`

```json
{
  "repo": "alice/calendar"
}
```

There is **no version field**, no release strategy and no display metadata. Everything else is
discovered from the repository at import time, or lives in the app manifest inside the bundle.
Duplicating it here would go stale and generate pull-request churn, which lands on the maintainer.

The one optional field is `"asset"`, and it is an escape hatch rather than configuration — see
[Which asset, when rung 1 hits](#which-asset-when-rung-1-hits). Most entries never set it.

IDs must be lowercase. On a case-insensitive filesystem — macOS, where this is developed —
`Foo.json` and `foo.json` collide in a checkout but not in Git, so the validator has to reject
uppercase rather than let the problem surface later.

Lifecycle is a field, not a folder and not a deletion. `status` defaults to `active`:

```json
{ "repo": "alice/calendar", "status": "removed", "note": "malware, 2026-08-01" }
```

Keeping a removed entry preserves the audit trail *and* keeps the ID unclaimable, which is why
deletion is the wrong operation — npm does the equivalent with security placeholder packages.

Extend by adding defaulted fields, never by adding provider abstractions. When a second forge
eventually matters, `"repo": "gitlab:user/proj"` covers it — bare stays GitHub, no schema
version bump, nothing to design today.

`.vscode/settings.json` maps `apps/*.json` to the schema, so contributors get autocomplete and
inline errors without a `$schema` key in every file — mistakes get caught before the pull
request exists. `.github/scripts/validate.ts` lets contributors run the same checks locally,
following Espanso's example; it runs the credential-free subset (schema, ID shape, namespace,
repository reachable, ladder resolves) while the private importer does the rest.

### CODEOWNERS is not an ownership mechanism

It is tempting to nest entries per author so that `apps/io.github.alice/ @alice` can gate
review. This does not work: **CODEOWNERS entries only take effect for users with write access
to the repository**, which third-party authors will not have, so such entries are silently
inert. It would also grow the file by one line per author forever.

Ownership is enforced by the bot comparing the pull-request author against the proven
namespace. Keep CODEOWNERS for `schema/` and `.github/workflows/`, held by the catalog
maintainer's own account.

### Scale

Flat directories are fine well past the point this matters: MELPA holds thousands of recipes,
and Homebrew only sharded `Formula/` at around seven thousand files. The limit that arrives
first is GitHub's web UI truncating directory listings near a thousand entries, and the fix is
a mechanical `git mv` into `apps/io.github.a/…` at that point. Do not pay for it now.

The one change that would force a real restructure is per-app assets — icons or screenshots
would each need their own directory. That is an explicit non-goal, and it remains a mechanical
migration if it ever changes.

## Ownership without a dispute process

Reverse-DNS app IDs make name disputes structurally impossible, which is the single largest
saving available to a solo maintainer.

PyPI's [PEP 541](https://www.python.org/dev/peps/pep-0541/) defines abandonment as unreachable
owner, no release in twelve months, and no owner activity; they processed over 500 requests in
2025 after clearing a nine-month backlog. npm suspended transfers entirely in 2021 after a
mis-transfer and now [declines to move names on request](https://docs.npmjs.com/policies/disputes/).
That entire apparatus exists only because those namespaces are flat.

An ID must be reverse-DNS, and its namespace must be one the submitter can prove.

**Launch with one mechanism: `io.github.<user>.<app>`.** It is proven by a string comparison
against data already in the entry, because it points at `github.com/<user>/…`. No DNS, no HTTP,
no new failure modes, nothing that can flake. It costs the author nothing and the maintainer
nothing, and it is what `packages/create-app` should generate by default.

With this there is no name to squat, so there is no transfer policy, no abandonment policy and
no dispute queue to staff. Reserved first-party prefixes stay reserved so a retired first-party
ID cannot be claimed.

### Custom domains, deferred to Phase 3

`com.<domain>.<app>` is worth supporting eventually, but it is not earned at launch. Every
author without a domain is served by `io.github.*`, and because renames are supported, starting
there costs nothing later. Add it when a real accepted app needs it.

When it is added, use a DNS `TXT` record — `_justapps.<domain>` naming the GitHub account
entitled to the namespace — rather than `/.well-known/justapps.txt`. The HTTPS variant looks
simpler and is worse: many owned domains serve no HTTP at all (parked, email-only, apex without
`www`); following redirects cross-host is a genuine hole, so it needs same-registrable-domain
limits, a hop cap and TLS validation; and on shared platforms `/.well-known/` may be writable by
someone who is not the domain owner. DNS has none of that. Android's Digital Asset Links solve
exactly this problem — binding a reverse-DNS ID to a domain — and GitHub's own organization
verification is a DNS `TXT` challenge.

Three edges to plan for rather than discover:

- **Query over DoH, from two independent resolvers, and require agreement.** Plain `dig` on a
  runner trusts one resolver with no DNSSEC validation.
- **Negative caching will bite authors.** A lookup made before the record exists can cache the
  `NXDOMAIN` for the zone's negative TTL, often five to sixty minutes. The instruction must be
  *add the record first, then open the pull request*, and a re-run control is mandatory.
- **Reverse-DNS is ambiguous about where the domain ends.** `com.alice.tools.notes` could be
  `alice.com` plus app `tools.notes`, or `tools.alice.com` plus app `notes`. Try splits
  longest-first, accept the first that proves, and record which domain proved so it is pinned
  for later entries. Resolve against the Public Suffix List so a platform domain such as
  `github.io` is never treated as claimable.

This is also the only place CI performs network I/O against a host the contributor chooses,
which is a further reason to prefer a DNS lookup over fetching an arbitrary URL, and to keep the
workflow credential-free.

## Renaming an app

Renaming is a designed-in path, not a concession. It is what makes `io.github.*` safe to
recommend as the default: an author starts with zero setup and moves to a branded namespace
later, the same shape as the rung-4 to rung-3 graduation below. MELPA has run this for a decade
as `:old-names`.

The renamed entry declares its history, and the old path becomes a tombstone rather than a
deletion:

```json
// apps/com.aliceapps.notes.json
{ "repo": "alice/notes", "formerIds": ["io.github.alice.notes"] }
```

```json
// apps/io.github.alice.notes.json
{ "status": "renamed", "to": "com.aliceapps.notes" }
```

One pull request, two files. The bot verifies the two-way link — every `formerIds` entry has a
tombstone pointing back, every tombstone is claimed — which is purely mechanical.

**The tombstone is not optional.** Deleting the old file makes `io.github.alice.notes`
claimable, and it is an ID that installed devices already trust. Squatting an abandoned ID is
bad; squatting one with an existing install base is the worst outcome in the system. The
filesystem-as-uniqueness-constraint only holds while the file stays.

### The work is on the device, not in the catalog

The ID is the app's identity in installed state — `/applications/<id>`, plus whatever keys app
data and capability grants. Rename it naively and every existing install sees one app disappear
and an unrelated one appear: lost data, lost grants, a duplicate in the store.

So the compiled catalog carries an alias map, and reconcile gains one branch: if an installed ID
appears as a `formerId`, rewrite the local record to the new ID and keep everything else. That
slots into the reconcile pass that already runs, so it is a small addition — but it mutates
device state, and a botched rename orphans user data. This is the part to get right.

### Rules

- **Renames always require human review, never auto-merge.** This is the highest-risk operation
  in the catalog: it is precisely how an established app's install base would be hijacked.
- **Both namespaces must be proven by the same pull-request author** — the old one against the
  catalog's current repository pointer, the new one against the new pointer. An author also
  moving repositories should do that in a separate pull request, so the old proof still holds
  when it is checked.
- **Collapse chains.** For `a → b → c`, the entry for `c` lists `["a", "b"]`, so a device that
  has been offline since `a` jumps straight to `c` without walking the chain. The bot computes
  this by carrying the old entry's `formerIds` forward.
- **A manifest mismatch is a flag, not a failure.** After a rename the author's `manifest.json`
  names the new ID while older releases name the old one. The catalog filename wins; the
  mismatch is reported. This matches the tag-normalisation stance below.

Opaque permanent IDs — a serial assigned at admission, with reverse-DNS as display only — would
make renames free, and are not worth it: IDs stop being human-readable, `create-app` can no
longer generate one offline, and the readable name becomes a separate mutable thing that people
*can* fight over, giving back the dispute-process saving that motivated reverse-DNS.

## Release resolution

Releases are discovered, never declared. At import, resolve the bundle by walking down until
something matches. Each rung asks strictly less of the author than the one above.

| # | Condition | Bytes | Version | Author effort |
| --- | --- | --- | --- | --- |
| 1 | Latest release has a `*.zip` asset | that asset (selected below) | release tag | CI workflow |
| 2 | Latest release, no zip asset | repository tree at that tag | release tag | click *Publish release* |
| 3 | No releases, tags exist | repository tree at newest semver tag | that tag | `git tag v1 && git push --tags` |
| 4 | No tags at all | repository tree at default-branch `HEAD` | `YYYYMMDD.<sha7>` | `git push` |

Rung 1 is the TypeScript path: the author's build output is zipped by CI. Rung 4 is the MELPA
path — a vanilla-JavaScript app ships with a text editor and a GitHub account, no build, no CI,
no tags. Apps resolved at rung 4 are marked *rolling* in the store UI; pushing a tag graduates
them to rung 3 with no catalog change.

HACS's documentation warns that *"just publishing tags is not enough, you need to publish
releases."* That rule exists only because they did not implement rung 3. Implementing it
deletes the rule.

### Which asset, when rung 1 hits

Do not impose a filename convention. An author should be able to call their bundle `draw.zip`
because that is what it is. Resolve it the same way as everything else — a ladder, most specific
first:

| # | Rule |
| --- | --- |
| 1 | The entry sets `"asset"` and a release asset matches that name exactly |
| 2 | Exactly one `*.zip` asset exists — it must be the one |
| 3 | Several zips, one named `app.zip` |
| 4 | Otherwise fail, listing the assets that were found |

Rung 2 is the common case and costs the author nothing: one bundle, any name. Rung 1 exists only
for repositories that ship several archives — a source zip beside the bundle, or per-platform
artifacts later.

**A stale `asset` falls through rather than failing.** If the field is set but nothing matches,
continue down the ladder and *flag* it. An author who renames `draw.zip` to `draw-bundle.zip`
should not have their releases stop importing until a catalog pull request lands; that is exactly
the churn this design avoids everywhere else, and it matches the tag-mismatch stance above.

Do not add `${version}` or `${platform}` interpolation the way Package Control does. Versioned
names such as `draw-0.4.1.zip` are already handled by rung 2, since there is still only one zip.
Per-platform assets are the case that would need it, and JustApps bundles are platform-neutral.

### Rules deleted by discovery

Every rule an author can violate is a support burden. Three are removable:

**Bundle root.** Do not require a `content_in_root`-style declaration. Search for
`manifest.json` at `/`, `/dist`, `/build` and `/src`, and take its directory as the bundle root.
An optional `"root"` in the manifest is the escape hatch. This covers essentially every layout
with no configuration.

**Tag format.** Obsidian requires the release tag to equal the manifest version exactly, with no
`v` prefix — a rule that produces a steady stream of failed submissions. Instead normalise:
strip a leading `v`, parse semver. Where the tag and the manifest disagree, prefer the tag,
because it is the immutable thing, and *flag* the mismatch rather than failing the import.

**Release cadence.** No catalog pull request is needed for a new version, ever. Package Control
formalises this as `"tags": true` and explicitly forbids manually pinned releases in its default
channel. Take the same stance.

## Community workflow

### New app

```text
Contributor opens catalog PR
        ↓
Bot resolves the ladder and posts a report
        ↓
Maintainer answers one question: is this app legitimate?
        ↓
Merge registers the app
        ↓
Private importer notices the catalog commit
        ↓
Release is downloaded, validated and staged
        ↓
First publication is explicitly approved
```

The bot does everything mechanical before a human looks, so review is a judgement call rather
than an inspection:

```text
✓ id io.github.alice.calendar — namespace proven (repo owner)
✓ repo public, MIT licensed
✓ resolved via rung 2 — repo tree at tag v1.2.0 (a3f9c21)
✓ manifest.json at /  →  app.js present
✓ 6 files, 14 KB, no secrets detected
⚠ manifest version 1.2 ≠ tag v1.2.0 (using tag)
```

MELPA pushes this verification onto authors — contributors run `make recipes/<name>` before
submitting — which works for Emacs hackers and will not work here. CI is the right place. MELPA
maintainers have publicly hit burnout, and their mitigation was handing out more push access; a
solo project cannot do that, so automation has to carry the load instead.

### Updates

**Auto-merge on all-green.** Human review is required only for a new app, or for a change to
the app ID, the source repository, ownership, entry points or requested capabilities.

Reconcile by polling. The importer records the last processed catalog commit SHA, so
reconciliation is idempotent. Catalog merges are rare and a delay of minutes is invisible, so a
webhook buys little: it needs a public endpoint, a secret, signature verification and replay
handling, and Packagist's experience shows the periodic crawl has to stay anyway as a fallback.

If lower latency is wanted later, use a **ping, not a payload**: the catalog's post-merge
workflow sends one authenticated `POST /admin/reconcile`, and the service runs the same full
reconcile it runs on a schedule. No payload parsing, no signature scheme, and a dropped ping
simply waits for the next tick.

### Reading the catalog

Fetch the whole repository as one tarball rather than file by file:

```text
1. GET /repos/justfiles/catalog/commits/main   → head SHA
   unchanged → done (one request, the common case)
2. GET /repos/justfiles/catalog/tarball/{sha}  → whole catalog, one request
3. parse apps/*.json in memory, reconcile, record the SHA
```

Per-file `raw.githubusercontent.com` reads give a torn view — files can come from different
commits mid-merge, and raw is CDN-cached — while a tarball at a pinned SHA is atomic by
construction.

Authenticate even though the repository is public. Unauthenticated access is 60 requests per
hour *per IP*, and a Cloudflare Worker's egress IP is shared; a GitHub App installation token or
fine-grained PAT with `contents: read` gets 5,000.

## Import and publication

Git is desired state, not the serving database. After an accepted release is found:

1. Resolve the ladder to an immutable tag or commit.
2. Download the zip asset or the repository tarball at that exact SHA.
3. Calculate and record its SHA-256 and provenance.
4. Store the original archive in private R2 storage.
5. Validate and extract it into immutable per-release R2 objects.
6. Mark the release ready only after every file succeeds.
7. Publish atomically by changing the app's active-release pointer.

Resolve release assets through the API (`GET /repos/{o}/{r}/releases/tags/{tag}` → asset `id` →
`GET /repos/{o}/{r}/releases/assets/{id}`), not the friendly download URL, which is mutable — an
author can delete and re-upload under the same tag. Resolve `refs/tags/{tag}` to a commit
separately and record it, because tags move too.

Example storage layout:

```text
packages/{appId}/{releaseId}.zip
releases/{appId}/{releaseId}/files/gui.js
releases/{appId}/{releaseId}/files/images/logo.png
releases/{appId}/{releaseId}/manifest.json
```

A request for `https://app1.justapps.run/gui.js` resolves the hostname to the app, looks up its
active release, and reads `releases/app1/{activeReleaseId}/files/gui.js`. Never overwrite mutable
`app1/current/*` objects one at a time: a failed upload would expose files from two releases.

Do not serve or reverse-proxy GitHub files at request time. JustApps needs its own snapshot for
availability, correct content metadata, atomic releases, rollback, takedowns and proof of the
exact bytes previously served.

Deleting a catalog file must not immediately delete an app or its R2 objects. Deprecation and
removal should be explicit, reviewable states with a reason; artifact cleanup is a separate
retention process.

## Provenance

The bundle's relationship to its source commit must be verifiable, and the two byte sources
reach that differently.

**The repository-tree rungs (2–4) are self-evident.** The bundle *is* the tree at a commit. With
no build step there is no gap between the source anyone can read and the bytes served, and any
third party can reproduce the snapshot from the recorded SHA.

**The zip rung (1) needs attestation.** A zip has no verifiable link to the commit recorded
alongside it; a maintainer with a stolen token can attach anything. Because `justfiles/release`
supplies the workflow, it can call [`actions/attest`](https://github.com/actions/attest), and the
importer can verify the Sigstore bundle. Requiring it is a stronger stance than npm allows, where
provenance is opt-in.

Use `actions/attest@v4`, not `actions/attest-build-provenance`. As of v4 the latter is a thin
wrapper over the former, and both GitHub's documentation and the action's own README say new
implementations should use `actions/attest`. It needs `id-token: write` and `attestations: write`;
`artifact-metadata: write` is required only for `push-to-registry`, which does not apply to a zip.

Attestation is separate from *creating* the release, which these actions do not do. Cut the
release with the GitHub CLI (`gh release create`), which is preinstalled on runners — the
first-party `actions/create-release` has been archived, and reaching for a third-party action
would mean pinning it to a commit SHA for no gain.

The compiled catalog carries a `sha256` per file, matching what `CatalogFile` already records.
Krew pins `uri` plus `sha256` in its index for the same reason. Obsidian ships no integrity
checking at all; do not copy that.

## Making the easy path easy

Writing a release workflow is harder than creating an account on a package registry: the author
must get `on: push: tags` right, get `permissions: contents: write` right, zip the correct
directory with the correct root layout, and debug it in CI where every iteration is a push. The
account-count argument for GitHub-only distribution only holds if that cost is removed.

So publish `justfiles/release` as a reusable workflow, and reduce the author's release
configuration to this:

```yaml
jobs:
  release:
    uses: justfiles/release/.github/workflows/release.yml@v1
    with:
      build: pnpm build
      dist: dist
```

Pre-wire it into `packages/create-app` so scaffolded apps have it from the first commit. This is
load-bearing, not a convenience: without it, rung 1 is harder than publishing to npm, and the
central premise of this document fails.

## Security boundary

Catalog pull requests are untrusted input.

PR validation must:

- use a read-only `GITHUB_TOKEN`;
- have no Cloudflare, R2 or production credentials;
- never deploy or publish;
- reject unknown fields, malformed app IDs and unproven namespaces;
- avoid interpolating contributor-controlled values into shell commands;
- avoid privileged `pull_request_target` workflows that check out PR content; and
- pin third-party GitHub Actions to full commit SHAs.

The private post-merge importer has narrowly scoped staging permissions. Production publication
is a separate operation that changes only the active-release pointer. Catalog changes must not
trigger deployment of runner code.

Treat every source repository and archive as hostile. Defend against path traversal, absolute
paths, symlinks, duplicate and case-colliding names, archive bombs, excessive file counts and
unsupported file types.

**Cap extracted bytes, not the download.** Compressed size bounds nothing that matters — GitHub
serves the fetch and R2 egress is free — while extracted size is what a decompression bomb
attacks and what has to fit in a Worker's 128 MB isolate. Calibrate against a real app rather
than a round number: `app-draw` is 9.8 MB extracted and 2.7 MB zipped, almost all of it a single
`gui.js` carrying a bundled Excalidraw. A 10 MB cap would reject the first serious app in the
catalog. Cap extracted bytes at ~50 MB and file count at ~500, and leave compressed size alone.

Stream each entry straight into its R2 object, so peak memory is the largest single file rather
than the whole bundle; a ~20 MB per-file cap is what makes that bound meaningful. Enforce the
total against the running decompressed count, never against the sizes declared in the archive
header — those are attacker-controlled. Note also that `DecompressionStream` cannot read ZIP,
which is a container format: parse the central directory, then hand each entry's payload to
`DecompressionStream('deflate-raw')` so the inflate itself stays native.

Cap `app.js` separately and far lower (~1 MB). It is the only file that becomes executable
Worker code — `kernel.sandbox.ts` loads it as a module in a dynamically created Worker — whereas
`gui.js` is an inert static asset no matter how large. The two files carry completely different
risk and should not share a limit; for reference, `app-draw`'s reducer is 7.7 KB.

**Reject bundles containing secrets.** This is the one hazard the repository-tree rungs
introduce that a built `dist/` does not: a build step is a natural filter, and a raw tree has
none. Someone commits a local-dev `.env` and it gets rehosted at a public URL on a JustApps
domain. Hard-fail on `.env*`, `*.pem`, `id_rsa*`, `.npmrc` and `*.key`, with a clear message,
and document it in CONTRIBUTING.

Use separate code ownership for catalog entries, catalog schema and workflows. Protect the
main branch from direct pushes, force pushes and deletion, and require passing checks plus
catalog-owner review.

Rehosting also requires an explicit redistribution licence or permission from the app owner.
Keep credentials, user data, private abuse reports, embargoed vulnerabilities and production
logs outside the public repository.

## Effect on the existing store

The shipped community store discovers apps by npm keyword search and resolves bytes from
jsDelivr (`apps/frieren/worker/appstore/feed.ts`, `indexer.ts`). Under this design, discovery
becomes catalog-driven: read the catalog tarball, resolve each entry's ladder, snapshot to R2.

That is a net simplification. Open-admission keyword discovery is what forced the denylist, the
reserved-prefix guard and the two-way first-claim-wins binding in `indexer.ts`; a reviewed entry
with a proven namespace replaces all three. The npm path keeps working for existing first-party
apps during the transition and should not be extended.

The "free CDN" argument for npm does not survive either, since bundles are snapshotted into R2
in both cases and R2 egress is free.

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
- Add the entry schema, the contribution rules, and `io.github.*` namespace proof — the only
  proof mechanism at launch.
- Publish `justfiles/release` and wire it into `packages/create-app`.
- Mark the catalog experimental and state whether submissions are open.

### Phase 2 — Private ingestion

- Make the private importer reconcile catalog `main` on a schedule.
- Implement the resolution ladder and the secret, size and shape validators.
- Record catalog commit, source commit, artifact digest and release ID.
- Require explicit approval for first publication.

### Phase 3 — Community operation

- Accept outside submissions.
- Land the PR bot: namespace proof, ladder resolution report, auto-merge on all-green.
- Add custom-domain proof when a real accepted app needs it.
- Ship the alias map and the device-side rename migration.
- Document deprecation, removal, moderation and appeal processes.

### Phase 4 — Open runtime

- Open-source reusable dependencies as their boundaries become clear.
- Publish the independently buildable runner in its own repository.
- Keep the catalog and runner separate unless a demonstrated operational reason justifies
  combining them.

## Open decisions

1. Final GitHub organization and repository names.
2. Whether rung 4 (rolling, untagged) is open to third parties at launch, or only to
   first-party apps until the abuse model is proven.
3. Whether attestation is required or merely recorded for rung 1 at launch.
4. Whether capability grants carry across a rename, or the user is re-prompted. Carrying them
   is the current lean — a rename does not change what the app does, and re-prompting on every
   rename trains people to click through consent sheets, which costs more security than it
   buys. Human review of the rename pull request is the real gate.
5. Licence and redistribution requirements for app bundles and catalog metadata.
6. Initial cache and rollback policy for stable asset URLs.
7. Whether to adopt an Obsidian-style `versions.json` mapping app version to minimum runtime
   version, so older clients resolve an older compatible release instead of a broken one.
