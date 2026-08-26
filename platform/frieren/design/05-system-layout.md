# 5 · The `/system` layout

> Status: **applied.** Unlike the other docs this changed *existing* behavior:
> it moved files that `packages/agent` and both hosts read. No data migration —
> there were no live volumes, so the paths changed in place and the old
> locations simply never exist. Root level of the Volume is untouched; this is
> only about what's inside `/system`.

## The problem

`/system` grew by accretion. The agent's identity, the user's identity, and
the agent's memory all sit loose at the root, while the agent's *sessions*
are already properly namespaced per agent:

```
/system/
  soul.md                      main agent's persona        (agent-defaults.ts)
  profiles/user.md             the human                   (agent-defaults.ts)
  MEMORY.md                    agent long-term memory      (packages/agent)
  memory/daily/YYYY-MM-DD.md   agent daily notes           (packages/agent)
  agents/main/sessions/…       session state — per-agent!  (packages/agent)
  skills/                      user-authored skills        (packages/agent)
  accounts/*.json              user credentials            (packages/app)
  tmp/app-installs/            kernel scratch              (packages/app)
  os-state.json                shell state                 (frieren)
```

Three smells:

1. **The identity files are stragglers.** `packages/agent` already keys
   sessions by a reserved agent id `main` (`assistant.ts`), but `soul.md` and
   the memory files sit unparameterized at the root. The multi-agent shape was
   half-adopted.
2. **`profiles/user.md`** is a plural directory wrapping exactly one file
   whose name adds nothing. A volume is one account's store (multi-user lives
   above the volume, via Switch User), so the human is volume-level.
3. The summoning ritual (doc 4) is about to add a face — a second loose
   agent-owned root file — and the workspace/per-app agent ideas (doc 2) would
   force a `agents/<id>/soul.md` convention that contradicts the root
   `soul.md`. (Shipped as `agents/<id>/avatars/<avatar-id>/`: an avatar is a
   directory, so a pack and an authored expression need no new concept — #357.)

## The layout

> **The root of `/system` is knowledge about or belonging to the user, shared
> by all agents. `agents/<id>/` is one agent's perspective and state.**

```
/system/
  user.md                  the human — structured identity card
                           (frontmatter: schema, name?, birth_date?, gender?)
  memory/                  shared knowledge base — the team wiki of the user
    core.md                curated durable memory (consolidated nightly)
    daily/YYYY-MM-DD.md    append-only journal of session jottings
  context/                 derived, rebuildable, purpose-limited projections
    learning.json          learner-aware view for educational apps (issue #272)
  skills/                  user-authored skills, available to every agent
  agents/
    main/                  the overarching agent — reserved id, seeded at boot
      soul.md              persona (frontmatter + prose system prompt)
      avatars/<id>/        one avatar per directory: resting.png + a file per
                           expression, `.gen/<hash>/` for model-derived art
                           (the soul's `avatar:` names one, or `builtin/<id>`)
      sessions/            session state (already lives here)
    <future-id>/           a workspace/per-app agent — same shape, nothing special
  accounts/                user-level credentials (accounts capability)
  connections/             user-level, planned (app-settings design)
  tmp/                     host scratch
  os-state.json            shell state
```

Renames from the current tree — the whole change is three moves:

| From | To |
|------|----|
| `/system/profiles/user.md` | `/system/user.md` |
| `/system/soul.md` | `/system/agents/main/soul.md` |
| `/system/MEMORY.md` | `/system/memory/core.md` |

Everything else (`memory/daily/`, `agents/main/sessions/`, `skills/`,
`accounts/`, `tmp/`, `os-state.json`) already lives where it belongs.

## Rationale

- **"There is always one main agent" is a role, not a shape.** It's expressed
  as the reserved id `main` — seeded at boot, never reaped — exactly how
  sessions already spell it. A root-level `soul.md` would mean two code paths
  for the same concept the day a second agent exists.
- **An agent is a directory.** Soul, face, sessions — one `rm -r` resets an
  agent, one directory copy shares one. Multi-agent (per-workspace, per-app
  subagents — undecided) costs nothing now; the layout just stops foreclosing
  it. Same "don't paint ourselves in" principle as doc 2's keyable session.
- **Memory is communal, not main's diary.** It's a wiki of the user the whole
  team serves. The existing pipeline already has the right editorial shape:
  sessions → `takeNotes` → append to the **journal** (`daily/`), nightly
  consolidation → the **wiki** (`core.md`). Multi-agent slots in without new
  machinery: *any agent may append to the journal; only the consolidation job
  — run as `main`, the librarian — edits the wiki.* Contribution is cheap and
  low-trust by design; curation is single-writer. Subagent journal entries get
  an agent-id prefix when that day comes.
- **The root reads as a sentence in the Files app**: the human (`user.md`),
  what we know about them (`memory/`), what they taught us (`skills/`), who
  serves them (`agents/`), what they're signed into (`accounts/`).

## `context/` — purpose-scoped projections (issue #272)

Apps increasingly need model output adapted to a situation *without* receiving
the user's raw profile or memory. `context/` holds **derived, rebuildable,
purpose-limited caches** for exactly this — never authoritative data. Deleting
the directory is always safe; each projection regenerates lazily from its
sources (`user.md` + `memory/core.md`) the next time a scoped AI call needs it.

Each file is one *purpose*, named for the purpose (`learning.json`, not
`learner.json`), with its own privacy boundary, consent scope, and payload
schema. There is deliberately **no** universal `context.json` and **no**
registry/plugin framework — a single all-purpose document would become a shadow
profile and widen accidental disclosure. A second projection is added only when
a real consumer exists.

All files share a small envelope; each purpose owns its `data` payload:

```ts
type ContextProjection<T> = {
  schema: string       // e.g. 'frieren/context/learning/v1'
  generatedAt: string  // ISO timestamp
  sourceHash: string   // deterministic hash of the current sources
  data: T
}
```

A projection is reused only while its `schema` is current, its `sourceHash`
matches the live sources, and it is younger than a max age (learning: 7 days) —
otherwise it is regenerated (single-flight per user + purpose) and written
atomically. The host composes a prompt-safe fragment from the projection and
prepends it to the app's system prompt inside the `ai` capability; the app sees
only the final model output. See `packages/agent/learning-context.ts` and
`packages/app/capabilities/ai/host.ts`.

## Code changes

| File | Change |
|------|--------|
| `packages/agent/assistant.ts` | `PATHS.soul` → `agents/main/soul.md` (parameterize by agent id, like `sessions` already is), `PATHS.profile` → `/system/user.md`, `PATHS.memory` → `/system/memory/core.md`. `daily`/`sessions` unchanged. |
| `packages/agent/timezone.ts` | `PROFILE_PATH` → `/system/user.md`. |
| `packages/agent/assistant.test.ts` | Fixture paths. |
| `platform/frieren/shared/agent-defaults.ts` | `SOUL_PATH`/`PROFILE_PATH` constants, seed `mkdir` of `/system/agents/main` instead of `/system/profiles`. |
| `platform/frieren/worker/frieren.ts` | The two `readFrontmatter` literals — import the constants from `agent-defaults` instead of repeating paths. |
| `platform/frieren/src/personalize/state.ts` | Nothing — it imports the constants. |
| `packages/app/capabilities/volume/host.test.ts` | A test fixture scopes `/system/profiles`; update or leave (it's an arbitrary scope). |
| Comments | `packages/agent/index.ts`, `packages/app/capabilities/accounts/store.ts`, `packages/agent/prompts.ts` ("MEMORY.md" wording) mention old paths — sweep while there. |

spud-mac's daemon needs no path change of its own — it consumes
`packages/agent`, so it inherits the new tree. It has no identity seeding
today; that arrives with doc 4's whisper slice.

## Open questions

- **Shared journal appends.** Two agents (or two devices) appending the same
  daily file could last-writer-wins each other under volume sync. Moot with
  one agent; per-agent daily files (`daily/<date>-<agentId>.md`) is the escape
  hatch if it ever bites.
- **Skills scope.** `skills/` is root-level (shared) today. If per-agent
  skills ever matter, `agents/<id>/skills/` can overlay the shared set —
  deferred until an actual need.
