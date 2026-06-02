# app-code redesign — Source/App live loop

This document consolidates the simpler app-code interaction model into the
current implementation direction. It is a design note, not an implementation
commitment yet.

## Goal

Make app-code feel less like a traditional IDE and more like a small app for
reviewing and shaping an app with agent help.

The core model:

> Source is always trying to become App.

There is no normal user-facing Run button. The app rebuilds when a client asks
for it: the GUI asks automatically once edits settle, and an agent asks once it
has finished a batch of writes. If the current source fails to build, the last
working app stays mounted, while the state and bottom message explain what
happened.

## Top-level UI

The entire app has one toolbar at the top.

```text
┌────────────────────────────────────────────────────┐
│ Live                    [ Source | App ]   Install │
├────────────────────────────────────────────────────┤
│                                                    │
│ Source view: file tree + editor                    │
│ App view: full live app region                     │
│                                                    │
├────────────────────────────────────────────────────┤
│ Latest build/status message and diagnostics         │
└────────────────────────────────────────────────────┘
```

### Toolbar

Left: state indicator only.

Examples:

- `Live`
- `Updating`
- `Building`
- `Needs fixes`
- `Crashed`
- `Installing` (transient)

These are display labels derived from the build record (see Status meanings).
The toolbar should not show a full sentence. It is just a colored state label.
Detailed text belongs in the bottom message area.

Middle: view switch.

```text
[ Source | App ]
```

Use `Source` and `App`, not `Editor` and `Preview`. `App` reinforces that this
is the real running draft app, not a fake preview.

Right: primary shipping action.

```text
Install
```

`Install` is disabled unless the current source is what is running and the app is
not crashed.

`Pack` is uncommon and should move to a menu.

### Source view

The area below the toolbar is split:

```text
[file tree] [file editor]
```

Selecting a file switches/stays in Source view and loads that file into the
editor.

### App view

The area below the toolbar is the live app region. No file tree, no editor
chrome, no fake window chrome by default.

The implementation still uses a stable `[data-preview-slot]`, but the user-facing
name is App.

If the source is broken, the last working app remains visible. The toolbar state
and bottom message indicate that the current source is not what is running.

### Bottom message area

The bottom area shows the latest meaningful build message:

- successful build
- failed build
- runtime crash
- install success/failure
- selected diagnostic

Examples:

```text
App build successful.
```

```text
Build failed. Showing last working app.
```

```text
src/gui.ts:42 Expected ")"
```

The message comes from the `build` record (and the in-flight install), so agents
can inspect it and decide what to do next.

## State model

The state changes from pane/run terminology to Source/App, and replaces the
run-time fields with a single build **record**. The reframe that drives the
shape: the build outcome is not live runtime state — it is a log entry about a
past event ("we built `abc123`, it worked" / "it failed, here is the error"). A
record is fine to persist. What keeps it honest rather than stale is a content
**hash** of the source it describes: compare `build.hash` to the current
`sourceHash` to know whether that build is the source you would run *now*
(current) or an earlier one (previous).

The two genuinely runtime things leave the model entirely:

- `previewId` is `` `preview.${slug}` `` (`devkit.capability.ts`) — a pure
  function of the slug, derived where needed, never stored.
- the running App is reconstructed by `open` re-running; there is no handle worth
  persisting.

Current state:

```ts
export type CodePane = 'editor' | 'preview'

export type CodeState = {
	slug: string
	files: string[]
	selectedPath: string | null
	dirty: boolean
	rightPane: CodePane
	previewId: string | null
	diagnostics: string[]
}
```

Proposed state:

```ts
export type CodeView = 'source' | 'app'

// The last build, tagged with the hash of the source it compiled. `result`
// covers a runtime crash too (Phase 5) — a crash is still a fact about the
// version that was built.
export type CodeBuild = {
	hash: string
	result: 'ok' | 'failed' | 'crashed'
	diagnostics: string[]
	message: string
	at: number
}

export type CodeState = {
	// persisted document — what Xcode persists: open project, selected file, view
	slug: string
	selectedPath: string | null
	view: CodeView
	// content identity + last build; both are honest functions of the files on disk
	files: string[] // cache of the disk scan, refreshed by open/refresh
	sourceHash: string // hash of the current source on disk
	build: CodeBuild | null
}
```

Initial state:

```ts
export const initialState: CodeState = {
	slug: 'untitled',
	selectedPath: null,
	view: 'app',
	files: [],
	sourceHash: '',
	build: null
}
```

### Current vs previous

`sourceHash` is the content hash of the current source on disk. `write`
recomputes it after persisting (re-reading the small source set is cheap); `open`
computes it after seeding/scanning. **`write` owns `sourceHash`; `run` owns
`build`** — they never write the same field.

`build.hash` is the hash of the source the last `run` compiled.

The comparison is the whole signal:

- `build.hash === sourceHash` → the running App is the current source.
- `build.hash !== sourceHash` → source has moved on; the App is the previous
  version, still mounted, while you decide to re-run.

This also makes interleaving self-correcting: if you keep typing while a run is in
flight, `write` advances `sourceHash`, the run records the older hash it actually
compiled, and the derived status comes out `updating` → the client runs again. No
stale-result guard needed.

Because it is a content hash, it detects out-of-band edits and gives every build
a stable identity ("built from `abc123`") — the same identity a future
snapshot/history feature would key on, so this is the first increment toward that
without committing to it now.

### Status is derived, not stored

There is no stored status field. The GUI and an agent derive the label from the
build record, the hash comparison, and whether a `run` is in flight:

```ts
export type CodeStatus =
	| 'idle'
	| 'updating'
	| 'building'
	| 'live'
	| 'needs-fixes'
	| 'crashed'

function statusOf(state: CodeState, running: boolean): CodeStatus {
	if (running) return 'building' // a run is in flight (client-local)
	if (!state.build) return 'idle'
	if (state.build.hash !== state.sourceHash) return 'updating'
	if (state.build.result === 'failed') return 'needs-fixes'
	if (state.build.result === 'crashed') return 'crashed'
	return 'live'
}
```

`dirty` stays client-local (an agent writes whole files and is never dirty);
`installing` is a transient of the one-off `install` call.

Install is enabled only when:

```ts
function canInstall(state: CodeState): boolean {
	return state.build?.result === 'ok' && state.build.hash === state.sourceHash
}
```

False right after a `write` (source ahead of the last build) until a `run`
lands — exactly right. The GUI additionally gates its button on its own
unsaved-buffer flag; the agent never needs that because it writes whole files.

## Status meanings

The toolbar label is derived; nothing here is a stored field.

| Toolbar label | Derived from                                              | Color      |
| ------------- | --------------------------------------------------------- | ---------- |
| (idle)        | `build === null`                                          | gray       |
| `Updating`    | `build.hash !== sourceHash`, no run in flight             | muted blue |
| `Building`    | a `run` is in flight (client-local)                       | blue       |
| `Live`        | `build.result === 'ok'` and `build.hash === sourceHash`   | green      |
| `Needs fixes` | `build.result === 'failed'` and `build.hash === sourceHash` | amber/red |
| `Crashed`     | `build.result === 'crashed'`                              | red        |
| `Installing`  | an `install` is in flight (client-local)                  | blue       |

`crashed` is in the model now, but nothing sets it until Phase 5 adds a
host/devkit runtime-error reporting hook.

## Reducer actions

The reducer exposes small semantic actions. File contents stay on disk, not in
state. Clients (the GUI and an agent) only ever *write files* and *run*; the
build is never a button and is not stoppable.

### Actions

- `open({ slug })` — seed a starter (the counter) on first use, scan files,
  validate `selectedPath`, compute `sourceHash`, then run the initial build so
  the App is live on open.
- `select({ path })`
- `readFile({ path })` — query
- `write({ path, content })` — persist bytes and recompute `sourceHash`. Fast; no
  compile; does not touch `build`. Clients write as many files as they need.
- `run({ reset? })` — read the current source, hash it, compile + mount via
  `devkit.run`, and write the `build` record. The one source→App verb. `reset`
  wipes the draft's persisted state for a clean boot (used by `restart`).
- `setView({ view })` — UI only; switching Source/App never builds.
- `install({})` — one-off; returns `{ id }`; touches neither `build` nor
  `sourceHash`. (Phase 4.)
- `pack({})` — returns `{ zip }`; lives in a menu.
- `reportCrash({ message })` — sets `build.result = 'crashed'`. (Phase 5.)

`edit` and `setPane` are removed (dirty is client-local; pane became `view`).
`stop` survives only as internal cleanup on unmount (using `` `preview.${slug}` ``),
not a user gesture.

### Keeping `write` and `run` separate

`write` does not build. An agent typically writes several files (with thinking in
between) before it is done, and a half-written project should not flash spurious
failures — write `app.ts`, and `gui.ts` momentarily references a type that does
not exist yet. So the client writes its whole batch, then `run`s once. The GUI
gets the same control and simply chooses to chain `write → run` after its
debounce.

### The `run` handler

`run` reads the freshest source from disk, hashes it, compiles + mounts via
`devkit.run`, and records the outcome — tagged with the hash it built. It leaves
`sourceHash` alone (that is `write`'s field), so a write that lands mid-run simply
shows up as `updating` afterward.

```ts
const files = await readSource(volume, state.slug)
const hash = hashSource(files)
const { diagnostics } = await devkit.run({ slug: state.slug, files, reset })
return {
	...state, // sourceHash untouched — write owns it
	build: {
		hash,
		result: diagnostics.length === 0 ? 'ok' : 'failed',
		diagnostics,
		message: diagnostics.length === 0 ? 'App build successful.' : 'Build failed. Showing last working app.',
		at: Date.now()
	}
}
```

On compile failure `devkit.run` returns diagnostics and keeps the last-good app
mounted; the record just says `failed` and carries the diagnostics. On success
the App is the new version and `build.hash === sourceHash`, so the derived status
is `live`. `hashSource` hashes the sorted path→content map; for a few small files
it is negligible.

## Live build pipeline

Clients change files and decide when to run. The build is the consequence of a
`run`, never an automatic side effect of `write`.

GUI behavior:

1. User edits source.
2. GUI debounces about one second after typing stops. (Debounce is a keystroke
   concern and lives in the GUI; an agent does not debounce.)
3. GUI `write`s the file (advancing `sourceHash`), then chains `run` once the
   write resolves.
4. On success the App updates atomically and the derived status is `live`.
5. On failure the App stays the last working version and the status is
   `needs-fixes`.

Agent behavior:

1. `write` each changed file.
2. `run` once when the batch is done.
3. Read `build.result` / `build.diagnostics` (or the `build.hash` vs `sourceHash`
   comparison) to decide what to do next.

Switching between Source and App never starts or stops the App. It only changes
what the user is looking at.

### Single-flight

Runs must not overlap. The current app runtime can clobber state if multiple
long-running handlers write state out of order; the existing app-code already
works around this in one place by chaining `setPane` and `run`. The redesign
preserves that discipline.

Recommended v1 rule:

> GUI-originating run operations are single-flight and ordered.

If a `run` is in flight and more writes land, the client issues the next run only
after the current one finishes, then runs the latest source. The hash comparison
guarantees correctness regardless: each run records the hash it actually built,
so the toolbar always tells the truth about current vs previous. Single-flight is
just to avoid two `devkit.run`s clobbering the same `preview.<slug>`.

For a more robust later design, the platform could add a non-persisting `effect`
action kind so the machine itself owns the debounced run. Until then, keep runs
client-ordered and keep state transitions short.

## Install behavior

The toolbar `Install` button is enabled only when `canInstall(state)` is true.

Disabled cases:

- no successful build yet
- source written but not yet run (`build.hash !== sourceHash`)
- current source failed (`needs-fixes`) or crashed
- the GUI's editor buffer has unsaved keystrokes (GUI-local gate)

Install is a one-off action, like exporting from an image editor: it ships the
current source but changes no lasting app state. On click:

1. call `devkit.install` with the current source files
2. show transient progress (`Installing`), then a success/failure message
3. neither `build` nor `sourceHash` changes — the App stays `live` throughout

`Pack` uses the same `canInstall` rule but lives in a menu. `restart` is also a
menu item: `run({ reset: true })`, which clears the draft's persisted runtime
state for a clean boot — the only remaining use of `reset`, since there is no Run
button.

## Runtime crash behavior

Compile failures are already returned by `devkit.run` as diagnostics. Runtime
crashes need a separate reporting path. Possible implementation:

- host catches mount/update/runtime errors for the child app
- devkit reports the error back to app-code
- app-code dispatches `reportCrash({ message })`

The crash is a fact about the version that was built, so it updates the existing
record rather than introducing new fields (the last-good App stays mounted, so
the hash is unchanged):

```ts
build: state.build && { ...state.build, result: 'crashed', message, at: Date.now() }
```

Install remains disabled while crashed (`canInstall` requires `result === 'ok'`).

This can be phase two. The `result` union includes `crashed` from the start.

## Migration from current state

The build is now a hash-keyed record, and `open` always rebuilds it, so almost
nothing migrates. `normalizeState` keeps the persisted document fields and resets
the rest.

| Old field              | New field        |
| ---------------------- | ---------------- |
| `rightPane: 'editor'`  | `view: 'source'` |
| `rightPane: 'preview'` | `view: 'app'`    |

Everything else (`dirty`, `previewId`, `diagnostics`) is dropped: `dirty` is now
client-local, and the preview/diagnostics belonged to a session that did not
survive the reload. `build` starts `null` and `sourceHash` starts `''`; `open`
recomputes the hash and runs the initial build.

## Implementation phases

### Phase 1 — State model

- add `CodeView`, `CodeBuild`, and the derived `CodeStatus` / `statusOf`
- replace `rightPane` with `view`
- drop `dirty`, `previewId`, `diagnostics`, and the `edit` / `setPane` actions
- add `sourceHash` (owned by `write`/`open`) and the `build` record (owned by
  `run`)
- update `normalizeState`: map `rightPane`, reset `build` / `sourceHash`

### Phase 2 — Layout

- make shell vertical
- move toolbar above both views
- left toolbar state text (from `statusOf`)
- center `Source | App` segmented control
- right `Install` button
- source area = file tree + editor
- app area = full stable `[data-preview-slot]`
- bottom area = `build.message` + diagnostics

### Phase 3 — Automatic live loop

- remove the Run button
- `open` runs an initial build (App live on open, showing the seeded counter)
- GUI debounces around one second, `write`s, then chains `run`
- keep runs single-flight in the GUI
- keep the last-good App mounted on failure

### Phase 4 — Install and menus

- wire `Install` enablement to `canInstall(state)`
- `install` returns `{ id }` and shows transient progress; leaves `build`
- put `Pack` and `restart` (`run({ reset: true })`) in a menu

### Phase 5 — Crash reporting

- add host/devkit runtime error reporting
- dispatch `reportCrash`, setting `build.result = 'crashed'`
- disable Install while crashed

## Design summary

The simplified product rule is:

> App-code always has one draft app. A client writes files and then runs; the GUI
> runs automatically after edits settle, an agent runs after a batch. The toolbar
> state is derived by comparing the last build's hash to the current source, the
> bottom message explains details, and the App view always shows the best working
> app available.
