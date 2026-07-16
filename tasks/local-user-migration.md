---
project: apps/frieren
---

# Description

When the user logged in for the first time, we need to detect whether this is a new account. Couple of potential ways:
1. getting that from clerk.
2. check user's DO, empty?

If it is the a new account, we should ask user whether they want to migrate the local account to the new account.
This is the flow where people play around with the site for a while, then decided to create an account.
whatever they did as a local user should be offered to migrate over to the new account to prevent data loss.

# Investigation Outcome

## How identity & storage work today

**Browser-local profiles own the data, not Clerk users** (`apps/frieren/src/fs.ts`).
- A *profile* is a browser-local identity holding one IndexedDB replica. The
  registry lives in `localStorage['frieren-profiles']` as `LocalProfile[]`
  (`{ id, remoteUserId?, lastOpenedAt }`).
- The signed-out workspace is the profile with `id: 'local'` (no `remoteUserId`).
- A signed-in account gets a **sibling** profile keyed by a random UUID with
  `remoteUserId` set — created lazily by `profileForUser(userId)` the first time
  that account is attached *on this browser*.
- Each profile's IDB db is `frieren-fs-profile-<profileId>`; only one is `active`
  at a time.
- `attachRemoteUser(userId, getToken)` switches to (or creates) the account
  profile and starts sync. It **explicitly does not merge** the local workspace
  into the account: "keep it separate and switch/create the account profile."
- `switchToLocalProfile()` returns to `local` on sign-out; account data stays on
  disk. `forgetActiveProfile()` is the only thing that deletes a replica.

**Server side** (`apps/frieren/worker/index.ts`, `worker/frieren.ts`).
- Each Clerk `userId` maps to a Durable Object via `FRIEREN.idFromName(userId)`.
  So the DO *is* the account's server volume.
- On every DO boot `reset()` seeds defaults idempotently:
  - `ensureAgentDefaults()` writes `/system/user.md` and
    `/system/agents/main/soul.md` **only if absent**, each stamped
    `seeded: true` in frontmatter (`shared/agent-defaults.ts`).
  - `ensureAccount(spud)` seeds `/system/accounts/spud.json` (the platform AI
    backend; accounts live under `/system/accounts/`, see
    `packages/app/capabilities/accounts/store.ts`).
- Built-in apps are **client-materialised** (`src/apps/seed.ts` `seedBuiltins` →
  `materialise`/`reconcile`) and pushed up; a never-touched DO has no
  `/applications/*` yet.

**So a brand-new account's server volume contains only:** a `seeded: true`
soul + `seeded: true` profile, `spud.json`, and the sync bookkeeping under
`/.state`. No user content.

## The sync layer is local-first

`synced()` (`packages/fs/synced.ts`) returns a usable local volume immediately
and runs the first bootstrap/pull in the background. After the account profile's
first sync settles, its **local IDB mirrors the DO** — so we can read the account
volume locally to learn what the server has, instead of a bespoke remote probe.
Status transitions `connecting → syncing → synced`; the first `synced` after
attach means the bootstrap pull is applied. (`fs.ts` already exposes
`activeStatus()` + `onActiveStatusChange()`.)

## This task is an anticipated, deferred decision

`apps/frieren/LOCAL_FIRST_PLAN.md`:
- Open decision **#6 (resolved):** sign-in switches to the account's sibling
  profile, **no automatic merge**.
- Open decision **#7 (open, Phase 4):** "Precise merge UX… **Safe default: do not
  auto-merge.**" — this is exactly this task.
- Phase 4a defers: "an opt-in *import my local files into this account* that
  re-writes local files **by path+content as new creates** (fresh UUID inos →
  pushed normally), with a per-path conflict policy."

So the intended mechanism is a deliberate, opt-in copy — not a silent merge.

## Detecting a "new account" — the two options in the task

1. **From Clerk.** `useAuth`/`useUser` do not cleanly expose "isNewUser". The only
   proxy is `user.createdAt` vs. now (fragile; and it says nothing about whether
   the account already has *data* from another device). Not reliable on its own.
2. **Check the account's DO/volume.** Robust and device-independent. The DO is
   never literally empty (always the seeded baseline), so "new" means **"only the
   seeded baseline, no user content"**. We do this by **waiting for the account
   profile's first sync to settle, then running the same content check on the
   account volume** — reusing one predicate on both sides.

**Chosen signal:** after the account's first `synced`, prompt iff
`hasUserContent(localProfileVolume)` **and** `!hasUserContent(accountVolume)`
**and** no decision recorded yet. This naturally skips the offer when the account
already has data (signed up earlier on another device) — we never clobber a real
account — so the "first attach on this browser" gate is not needed for
correctness.

## What counts as "user content" — a reserved-prefix denylist

Apps can claim **arbitrary top-level prefix scopes**, not just `/data/<id>`.
The notes app deliberately uses a `/notes` prefix scope
(`packages/app-notes/src/app.ts`): "Notes live in the shared, top-level `/notes`
knowledge base" that the agent and the Files app (`scopes: ['system']`) read and
edit. So a hardcoded `{/data, /notes}` allowlist is fragile — a future/third-party
prefix-scoped app writes elsewhere and gets missed.

Since third parties can't be forced into a layout, detection must be
layout-agnostic anyway. So define user content by a **denylist of reserved
runtime prefixes**, first-party-controlled and stable:

- ignore `/.state` (sync bookkeeping — must never leak between replicas)
- ignore `/applications` (app bytes — re-seeded)
- ignore `/state` (per-app UI state)
- ignore `/system` (platform: accounts, os-state, identity)

`hasUserContent(volume)` = **any top-level entry outside those four prefixes**
(covers `/data`, `/notes`, and any future prefix-scoped dir automatically), **OR**
`/system/agents/main/soul.md` / `/system/user.md` whose `seeded` frontmatter flag
is missing/false (the user personalized identity). Right after bootstrap the
account holds the DO's `seeded: true` soul/profile, which correctly reads as
*empty*.

> Decision: **do not** relocate `/notes` into `/data/<id>`. It's a deliberate
> shared knowledge-base namespace; moving it would silo it (deleted on uninstall,
> not browsable), require its own breaking data migration, and — since third
> parties still can't be forced — buy nothing for detection, because the denylist
> is required either way.

## What to copy / skip (during migration) — user data only

Resolved: **copy user data + personalized identity; do not copy apps.**

- Copy: everything under the non-reserved top-level prefixes (`/data/**`,
  `/notes/**`, …) plus a personalized `/system/user.md` +
  `/system/agents/main/soul.md` (+ avatar) + `/system/os-state.json`.
- Skip: `/.state/**` (sync bookkeeping — never copy between replicas),
  `/system/accounts/**` (platform/backend-managed; a local-only profile only has
  the default `spud`, which the DO already seeds), **`/applications/**` and
  `/state/**`** (built-ins are re-seeded on the account; no app bytes/state copy).
- Blobs: the `local` profile is local-only (never had a remote), so every blob is
  resident in IDB — reads are fully offline, no lazy-hydration concern on the
  source.

## Notification / omnibar surface (for the offer)

The offer is surfaced through frieren's existing notification system, not a boot
modal (`src/notifications/store.ts`, `src/shell/Omnibar.tsx`,
`packages/app/capabilities/notify/types.ts`):

- A `Notification` is a **transient projection** with `kind: 'info' | 'error' |
  'question'`, `title`, `body`, `threadId` (dedup/coalesce), and an optional
  `route` (`chat | app | settings`) — *where a click goes*.
- The omnibar pill surfaces the single most-urgent notification and renders **one**
  action button, derived from `route`. There is **no** multi-button `actions[]`
  and no arbitrary callback (that's a deferred Phase 2 addition). So a two-choice
  decision (migrate / start fresh) cannot live inside the pill itself.
- `notify()` coalesces by `threadId`, so re-posting the offer is idempotent.
- Dismissing/receding a pill is **not** a decision — it stays in the center as
  unread. So "ignored the pill" must not record an outcome.

Design that fits this: the pill **announces** (a `question` from
`source: 'system'`, `threadId: 'local-migration'`); **engaging it opens a small
confirm sheet** (mirroring `ConsentSheet`) that presents the explicit choice and
captures the one-time decision.

## Existing patterns to reuse

- `ConsentSheet.tsx` — the `createPortal` confirm-sheet style the migration sheet
  mirrors (busy state, backdrop, two buttons).
- `runNotification` / the pill action in `Omnibar.tsx` — where a click on our
  notification is handled (branch on `threadId`, frieren-local; no shared-contract
  change).
- `Volume.scan(path, visitor)` walks a subtree (dirs before contents) — the
  primitive for both the content check and the copy.

# Plan

Goal: when a user first attaches a **genuinely new** account on a browser that
has local work, offer a one-time, opt-in copy of that work into the new account.
Explicit, never silent (LOCAL_FIRST_PLAN #6/#7). Copy, don't move — the local
profile stays intact.

## 1. Content predicate (in `src/fs.ts`)

`hasUserContent(volume): Promise<boolean>` — the single reused predicate:
- reserved prefix denylist: `/.state`, `/applications`, `/state`, `/system`;
- true if any top-level `readdir('/')` entry is outside the denylist;
- else true if `/system/agents/main/soul.md` or `/system/user.md` exists with a
  missing/false `seeded` flag (parse frontmatter — reuse `parseFrontmatter` /
  the personalize `parseIdentityFile`);
- else false.

## 2. Detection flow (in `src/fs.ts` + `src/App.tsx`)

- After `attachRemoteUser` resolves, **await the account profile's first
  `synced`** (via `onActiveStatusChange`; resolve on first `synced`, give up
  quietly on `error`/offline).
- Open the `local` profile's IDB read-only as a source
  (`volume(idbStorage(dbName('local')))`, without disturbing `active`).
- Prompt iff: no decision recorded **and** `hasUserContent(localSource)` **and**
  `!hasUserContent(accountVolume)`.
- Offline / never reaches `synced` → don't prompt **and don't** record a decision
  → it re-checks on the next successful attach. (Never offer without a
  confirmed-settled account.)

## 3. One-time decision (never nag)

Add `migration?: 'migrated' | 'dismissed'` to the account's `LocalProfile`
registry entry. Either value means never ask again. Written **only** on an actual
accept/dismiss — never on "couldn't check".

## 4. Migration mechanism — explicit path+content copy (`src/fs.ts`)

`migrateLocalProfileInto(): Promise<void>` — **copies** (does not move; the local
profile stays intact) into the **active, synced** account volume so writes push
up normally (fresh UUID inos), per Phase 4a:
- open the `local` profile IDB read-only as source;
- `scan('/')` the source (dirs before contents); **skip** `/.state/**`,
  `/system/accounts/**`, `/applications/**`, `/state/**` (user data + identity
  only);
- recreate dirs (`mkdir -p`) and `writeFile` each file into the active account
  volume; for the seeded `soul.md`/`user.md`, overwrite the account default;
- finish with `flushActiveVolume()` so the copy replicates to the DO promptly;
- re-entrancy guard so a double-click can't run it twice.

(Alternative considered — seed the account IDB *before* first sync and let
`synced()`'s "adoption keep-local" push it up — is leaner but forces the
migrate/skip decision to block boot and is harder to make opt-in. Rejected in
favor of the explicit copy, which runs after the user is on their new desktop and
matches the documented plan.)

## 5. UX — notification pill + confirm sheet (non-blocking)

Surfaced on the **loaded desktop** via the notification system — never a boot
gate.

- When detection fires (and no decision recorded), post one `question`
  notification: `source: 'system'`, `threadId: 'local-migration'`, e.g.
  title "Bring your stuff over?", body "Move the notes and files you made before
  signing in into this account." Idempotent via `threadId`.
- Engaging it (pill action / center row) opens a small `MigrationSheet`
  (`createPortal`, `ConsentSheet` style) with the explicit choice:
  - "Bring it over" → `migrateLocalProfileInto()` (progress state), record
    `migration: 'migrated'`, dismiss the notification, close.
  - "Start fresh" → record `migration: 'dismissed'`, dismiss, close.
- Wiring: branch in `Omnibar.tsx` `runNotification` on
  `threadId === 'local-migration'` to open the sheet instead of `dispatchRoute` —
  frieren-local, so the shared `notify` contract is untouched (no new `Route`
  kind, no `actions[]`).
- Merely receding/ignoring the pill records **nothing** → it re-offers on the
  next qualifying attach until the user makes an explicit choice.
- On copy error: surface it, keep the sheet open to retry, don't record a decision.

## 6. Edge cases

- Account already has data (signed up elsewhere): `hasUserContent(accountVolume)`
  true → no offer, no clobber.
- Decline then sign in again: decision recorded → no re-prompt.
- Local profile empty / only defaults: `hasUserContent(localSource)` false → no
  offer.
- Offline at sign-in: never reaches `synced` → no offer, no decision → re-checks
  when sync later settles.

## 7. Testing

- Unit (`src/fs.ts`; extend `src/apps/profile-session.test.ts` style with mocked
  `idbStorage`/`synced`/`volume`):
  - `hasUserContent`: true for `/data` or `/notes` present, or non-`seeded`
    identity; false for seeded defaults only / reserved-prefix-only trees;
  - `migrateLocalProfileInto`: copies `/data` + `/notes` + personalized identity
    and **skips** `/.state` and `/system/accounts`;
  - decision field is written only on accept/dismiss.
- Full suite: `pnpm format && pnpm typecheck && pnpm lint:fix && pnpm test`.
- UI smoke (`apps/frieren`): `pnpm run dev` + `pnpm run verify:ui` — play as local
  user (create a note + some app data), sign up, confirm the omnibar pill
  announces the offer, open the sheet, "Bring it over", and the data shows in the
  new account; sign in again → no re-offer.

## 8. Suggested step order (each independently shippable)

1. `fs.ts`: `hasUserContent` + `migrateLocalProfileInto` + `migration` registry
   field + first-`synced` await helper (pure logic, unit-tested, dormant).
2. Detection + notification: post the `question` from the shell/`App.tsx` when
   detection fires; add the `runNotification` branch + `MigrationSheet`.
3. Polish: progress/error state, dismiss path, `verify:ui`.

## Product decisions (resolved)

- **Copy, not move** — the local profile is preserved. A later "forget local
  profile" cleanup is out of scope.
- **Surface on the loaded desktop via the notification system** (omnibar pill
  announces; a confirm sheet captures the choice). Non-blocking, never a boot gate.
- **Re-offer from Settings** (a manual "Import local data…" action) — later, out
  of scope.
- **Migrate user data only** — `/data`, `/notes` (and any non-reserved top-level)
  + personalized identity. **Not** `/applications` or `/state` (built-ins are
  re-seeded).
