---
title: 'Notes — design'
description: A built-in Notes app over a shared /notes knowledge base, with a deliberate agent (TUI) interface.
---

# Notes — a freeform knowledge base shared by the user and the agent

`app-notes` is a built-in (macOS-Notes-style) app: a blank editor, a `Cmd+K` palette over a
recency-sorted list, debounced autosave, and filenames derived from the first line. Its content lives
in a **shared, top-level `/notes`** volume path that the agent reads, searches, and (on request) writes
— so a single store serves both the human's notes and the agent's "remember / find" loop.

Read `docs/app.md` first — this doc only covers what's specific to Notes. Framework idioms (edges,
procedures, capabilities, the two-faces model) are assumed.

**Contents**

1. [Architecture context — one KB, two tiers](#context)
2. [Where notes live & scoping](#scope)
3. [The state machine](#machine)
4. [Filenames & autosave](#files)
5. [The GUI](#gui)
6. [The agent (TUI) interface](#agent)
7. [v1 scope & non-goals](#scope-v1)
8. [Agent-runtime touch-points (out of this package)](#runtime)

<a id="context"></a>

## 1 · Architecture context — one KB, two tiers

Everything in the system is files on the Volume. Two memory surfaces, split by **nature and ownership**,
not by access (the agent is trusted and already reads the whole Volume):

| | `/notes` (this app) | `/system` (agent memory) |
|----|----|----|
| **Owner** | the user | the agent runtime |
| **Shape** | freeform — folders/files however the user likes | structured, schema'd, machine-managed |
| **Writes** | user, or agent **only on request** | the agent, autonomously |
| **GUI** | the Notes app | none (inspect via Files/Settings) |

**The merge happens at *search*, not at *storage*.** Storage stays cleanly owned; the unified "brain"
appears at query time because the trusted agent reads across both trees. `/notes` is one source among
`/system/*`.

Write routing is by **intent**:

- *"Remember this / keep in mind…"* → agent memory (`/system`). The user is telling the agent to hold it.
- *"Note this down / save as a note"* or the **`/note`** skill → `/notes`. The user wants a durable
  artifact they own and can browse.

The agent never *proactively* writes into `/notes`; it writes there only on explicit request, and treats
`/notes` as read-mostly (always searched). This keeps `/notes` trustworthy: it contains only what the
user put there or asked for — the "I got everything here" guarantee that built-in auto-memory (ChatGPT /
Claude memory) lacks.

<a id="scope"></a>

## 2 · Where notes live & scoping

`/notes` is a **top-level Volume path**, parallel to `/system`, `/data`, `/applications` — *not*
`/data/app-notes`. A scoped `/data/<id>` would frame it as one app's private data; top-level frames it as
a first-class user substrate that survives the app and that other tools (Files, the agent) share.

The app declares a **prefix scope**, not `system`:

```ts
capabilities: { volume: volume({ scopes: ['/notes'] }) }
```

Per `capabilities/volume/host.ts`, a `/prefix` scope chroots the app at that prefix and **still hard-blocks
`/system`**. So the Notes app sees the whole KB as its root but *cannot* reach the agent's private
transcripts, soul, or other apps' data — least privilege, unlike `app-files` which needs the broad
`system` scope. Inside the chroot the app's `/` **is** `/notes`, so it uses plain root-relative paths
(`/remember_the_milk.txt` lands at `/notes/remember_the_milk.txt`); no `/notes` prefix in app code, no
`mkdir` (writeFile auto-creates parents).

> Notes is a built-in. Prefix scopes aren't allowlist-gated today; if the host later wants to restrict who
> may bind `/notes`, that's a host-allowlist concern, not an app change.

<a id="machine"></a>

## 3 · The state machine

The discipline (docs/app.md §3): reducer state is **semantic, persistable, agent-inspectable**; transient
interaction stays GUI-local. The body bytes never enter state — they live in the file and are re-read on
demand (the `app-files` pattern).

| Lives in **reducer state** (app-session facts) | Lives **outside** reducer state |
|----|----|
| `openPath` — which note is shown ("what is the user viewing"); a *pointer*, not a copy of disk | the editor's in-progress text buffer (GUI-local) |
| `revision` — bumped when the open file changes on disk | `dirty` flag; `Cmd+K` palette open + filter query; cursor / scroll (GUI-local) |
| `error` | **the note list** — derived from `/notes` on demand via `list()`, never cached (see below) |

```ts
type State = {
	openPath: string | null  // null = blank scratch — the agent's "what is the user viewing"
	revision: number         // bumped when the open file changes on disk (external/agent edit)
	error: string | null
}
// The note list is NOT state — it is derived from /notes on demand (the `list` procedure).
type Note = { path: string; title: string; mtime: number }   // the shape `list` returns
```

### Action surface

Illustrative shape (not a compilable file). Edges are pure/sync; all IO is in procedures or via `t.cmd`.

```ts
export const app = defineApp({
	init: { notes: [], openPath: null, revision: 0, error: null } as State,
	capabilities: { volume: volume({ scopes: ['/notes'] }) },

	update: (t) => ({
		// — pure mutations (agent-visible) —
		open: t.on(v.object({ path: v.string() }),
			(s, { path }) => ({ ...s, openPath: path }),
			{ description: 'Open a note in the editor — surfaces it in the user’s window.',
			  examples: [{ params: { path: '/remember_the_milk.txt' } }] }),
		newNote: t.on(v.object({}), (s) => ({ ...s, openPath: null }),
			{ description: 'Start a fresh blank note (clears the editor).' }),

		// — autosave for an existing note (GUI dispatches on a debounced pause) —
		save: t.on(v.object({ path: v.string(), text: v.string() }),
			(s, { path, text }) => [s, t.cmd('volume', 'writeFile', path, enc.encode(text)).to('saved')],
			{ description: 'Overwrite a note’s body.',
			  examples: [{ params: { path: '/groceries.txt', text: 'eggs, milk' } }] }),
		saved: t.fromResult('volume', 'writeFile',
			(s, r) => (r.ok ? { ...s, error: null } : { ...s, error: r.error.message })),

		// — rename = re-slug + move the file (only fixes openPath; there is no cached list) —
		rename: t.on(v.object({ from: v.string(), title: v.string() }),
			(s, { from, title }) => {
				const to = `/${slug(title)}.txt`
				return [{ ...s, openPath: s.openPath === from ? to : s.openPath },
					t.cmd('volume', 'rename', from, to).to('renamed')]
			}, { description: 'Rename a note (its filename is derived from the new title).' }),
		renamed: t.fromResult('volume', 'rename', (s, r) => (r.ok ? s : { ...s, error: r.error.message })),

		// — external change to the OPEN file (the agent or Files edits it on disk) —
		fileChanged: t.fromEvent('volume', 'watch', (s) => ({ ...s, revision: s.revision + 1 }))
	}),

	// watch ONLY the open file, so its body stays live. The folder is not watched and the listing
	// is not cached — `list` re-reads /notes fresh whenever the palette opens.
	subscriptions: (s, sub) =>
		s.openPath ? [sub.capability('volume', 'watch', { path: s.openPath }).to('fileChanged')] : [],

	procedures: (p) => ({
		// the recency index — scanned fresh, RETURNED to the caller, never folded into state
		list: p.procedure({ description: 'List notes newest-first (path, title, mtime).',
			schema: v.object({}),
			async run(_a, app) {
				const entries = await app.invoke('volume', 'scan', { path: '/' })
				const out: Note[] = []
				for (const e of entries) {
					if (e.type !== 'file' || !e.path.endsWith('.txt')) continue
					const st = await app.invoke('volume', 'stat', e.path)
					out.push({ path: e.path, title: e.path.slice(1, -4), mtime: Number(st.mtimeNs) })
				}
				return out.sort((a, b) => b.mtime - a.mtime)
			} }),

		create: p.procedure({ description: 'Create a note from text; filename = slug of the first line.',
			schema: v.object({ text: v.string() }),
			examples: [{ params: { text: 'Remember the milk' } }],
			async run({ text }, app) {
				const path = await freePath(app, slug(firstLine(text) || 'untitled'))  // dedup via exists()
				await app.invoke('volume', 'writeFile', path, enc.encode(text))
				return app.settled((await app.dispatch({ type: 'open', params: { path } })).seq)
			} }),

		readNote: p.procedure({ description: 'Read a note’s body as text.',
			schema: v.object({ path: v.string() }),
			async run({ path }, app) {
				if (!(await app.invoke('volume', 'exists', path))) return { path, text: '' }
				return { path, text: dec.decode(await app.invoke('volume', 'readFile', path)) }
			} }),

		remove: p.procedure({ description: 'Delete a note.',
			audience: 'gui',          // destructive — the human deletes; the agent must not delete blindly
			schema: v.object({ path: v.string() }),
			async run({ path }, app) { await app.invoke('volume', 'rm', path, { force: true }) } })
	})
})
export type NotesApp = typeof app
```

Notes on choices:

- **The list is derived, not cached.** `/notes` is a *shared, multi-writer* store — the user (via this
  app), the agent (directly), and Files all write it — so caching its index in one writer's reducer state
  would drift the instant anyone else writes. `list` scans on demand instead; **the disk is the only
  source of truth.** This is a deliberate deviation from `app-files` (which caches `files` in state): there
  the store is effectively single-writer, here multi-writer makes drift a core case, not an edge one.
- **Only app-session facts live in state:** `openPath` (a *pointer/selection*, not a copy of disk contents
  — app.md §3 endorses "what is the user looking at"), `revision`, `error`. Re-deriving the list also gives
  true `mtime` recency on every call — no stale cache, no optimistic-mtime hack, no `loaded`/`created`
  landing edges.
- **`create` / `list` / `remove` are procedures** (async IO; `list`/`create` return to the caller rather
  than into state). `save` stays a cheap debounced edge; `rename` only moves the file and fixes `openPath`.
  Filename dedup is a `freePath` `exists()` probe, not a lookup in a cached list.

<a id="files"></a>

## 4 · Filenames & autosave

**Filename = `slug(first non-empty line)` — no AI.** `"Remember the milk"` → `remember_the_milk.txt`. Slug
= lowercase, runs of non-alphanumerics → `_`, trimmed, length-capped; collisions get `_2`, `_3`. Empty
first line → `untitled.txt` (deduped). Assigned **once** at first persist; later edits don't re-slug (the
user/agent renames deliberately). The agent searches *content*, not filenames, so filenames are a
human-browsing nicety — not worth AI latency/cost/nondeterminism. (AI naming as a fallback for unsuitable
first lines is a possible future, explicitly out of v1.)

**The threshold is the boundary where scratch becomes a file.** Two regimes:

- **Below threshold** (~40 chars): ephemeral scratch — never written, **discarded** on switch/close.
- **Above threshold**: a real file (slug name + first persist via `create`); from then on a **dirty buffer
  always flushes** on switch/close (even if later shrunk — that's undo's job).

So debounced autosave is purely a performance optimization: correctness comes from **flush-if-dirty on
every transition** (switch note, `Cmd+N`, window close). No data loss either way.

**Webview flush gotcha (must design for):** saves are async RPC round-trips to `quayd`. On `Cmd+W`/close
the window can tear down *before* the write lands. The close path must **await the final flush**
(`windowShouldClose` / flush-on-blur), not fire-and-forget — otherwise "save if dirty" isn't true.

<a id="gui"></a>

## 5 · The GUI

Renders state, dispatches actions, owns transient state (docs/app.md §9). Deliberately minimal:

- **Launch = blank editor.** On mount, dispatch `newNote` (guarantees `openPath: null` + an accurate agent
  view). Reopen is always blank — on-brand for capture-first; above-threshold notes are safe (autosaved,
  one `Cmd+K` away).
- **Type** → update local buffer. Debounced (~800ms): if `openPath` → `save({ openPath, text })`; if blank
  scratch and `text.length ≥ threshold` → `create({ text })`, then adopt `openPath` from settled state.
- **`Cmd+K`** → palette: call `list()` for a fresh listing, filter by query (title contains; content search
  is later), Enter opens. Re-fetched on every open, so it never shows a stale set. `Cmd+P` stays free for
  printing. (`Cmd+K` won't clash — plain-text editor has no insert-link.)
- **`Cmd+N`** → flush-if-dirty, then blank.
- **Delete** from the palette (delete key) → `remove` (GUI-only).
- **`revision` bump** (open file changed on disk) → GUI re-reads via `readNote`, so an agent/Files edit to
  the open note shows live.

### Styling — native by default, promote what's shared

The whole app must read as macOS-native by **leaning on `@justfiles/design`**, not by styling itself.
There is no Notes "look".

- **Write plain semantic markup.** The editor is a full-bleed `<textarea>`; the palette filter is an
  `<input>`; actions are `<button>`. `mac.css` styles these with zero-specificity `:where()` defaults
  (native control fill, border, radius, focus ring) — so they look right untouched. **Don't restyle bare
  controls.**
- **Consume tokens; never hardcode.** Any layout CSS goes through `injectStyle(css, 'app-notes')` (app.md
  §9), scoped under a root class, using `var(--window-bg)`, `var(--text)`, `var(--rule)`, `var(--focus)`,
  `var(--space)`, `--font-ui`, `--text-ui`, … This is also how the app gets **dark mode for free** — the
  tokens re-point under `prefers-color-scheme: dark`; a single hardcoded colour breaks that.
- **Reuse `ds-*` where it already fits.** The `Cmd+K` palette's result rows are exactly a menu list —
  render them as `.ds-menu` / `.ds-menu-item`, which already carry the macOS selection highlight
  (`--focus` / `--on-focus`), hover/active, and dark mode. An optional File menu is the `menu` named export
  (app.md §9); the host renders it via `.ds-menubar` / `.ds-menu`, so it matches every other app.
- **Promote, don't fork.** If Notes needs a primitive the system lacks, add it to `packages/design`, not to
  `app-notes`. The clear candidate is a **command/search palette** (floating panel + filter input +
  keyboard-navigable, selectable list): the `Cmd+K` palette here, the launcher's fuzzy app search, and the
  slash-command menu are the same affordance. Promote it to a `ds-palette` (composed from the existing
  `ds-menu` rows) once there's a second consumer. Rule of thumb: **system-level look → `packages/design`;
  only Notes-specific layout (the editor/list split) stays local.**

<a id="agent"></a>

## 6 · The agent (TUI) interface

The agent has **two channels**, by design — keep them distinct:

1. **Direct Volume access** (the agent's own file/search tools over `/notes`). The canonical KB path:
   *"note this down"* = write a file; *"find me…"* = search `/notes ∪ /system`. Works whether or not the
   app is open. This is where the *knowledge* flows.
2. **The Notes app TUI** (state + actions). For coordinating with the user's **live view** — this is where
   the *app as a surface* flows.

Because the app **watches the open file**, an agent edit to the note the user is *currently viewing*
re-reads live (a `revision` bump). Writes to *other* notes need no pushing — the palette re-reads `/notes`
fresh on every open, so they appear the next time the user looks. So the agent rarely drives the app to
*create* a note; it writes the file and the app reflects it. The action unique to the TUI is **`open`** —
focusing a specific note in the user's window, which a file write can't do.

What the agent sees (docs/app.md §8): `state` as JSON (`openPath` = *what the user is viewing now*; the
note list is **not** in state — call `list()` for a fresh one, or read `/notes` directly) plus the action
surface below. `description` + `examples` are its UI — written above.

| Action | Audience | Why |
|----|----|----|
| `open` | both | **The** coordinating action — put a note in front of the user. |
| `create`, `save`, `rename` | both | Available, but the agent usually writes files directly. |
| `list` | both | Fresh listing on demand — the agent's view of the KB is the filesystem, never cached state. |
| `newNote` | both | Harmless; mostly GUI-driven. |
| `readNote` | both | Convenience; the agent can also read the file directly. |
| `remove` | **gui** | Destructive. `/notes` is the user's — the agent never deletes user notes blindly (mirrors `app-code`'s gui-only `remove`). |

<a id="scope-v1"></a>

## 7 · v1 scope & non-goals

**In:** blank editor; `Cmd+K` palette + recency list (derived) + title filter; debounced autosave +
flush-on-transition; slug filenames; create/open/save/rename/delete; live re-read of the open note on
external edits; the agent TUI above.

**Out (deferred, not one-way doors):**

- **Folder navigation.** v1 is a flat recency list + filter; the filesystem under `/notes` stays freeform,
  so Files/agent can make folders and folder-nav can land later with no migration.
- **AI filenames** (slug only); **content search** in the palette (title only); **rich text / tags / links
  UI**; **resume-where-you-left-off** (always-blank reopen is intentional).

Tolerate old persisted shapes (docs/app.md §3): new `Note`/`State` fields must be optional — `init` is not
re-merged into already-persisted state.

<a id="runtime"></a>

## 8 · Agent-runtime touch-points (out of this package)

These live in `packages/agent`, not `app-notes`, but the design depends on them:

- **`/note` skill** — writes user-directed captures to `/notes` (the `/notes` write path of §1). Fits the
  existing slash-command menu + `/system/skills`.
- **`/system` memory partition** — resolve today's `MEMORY.md` ≈ `profiles/user.md` overlap with a crisp
  rule: *subject is the user* → `profiles/user.md`; *anything else* → `MEMORY.md`. The two distillation
  passes (`reflection-system`, `memory-consolidation`) must both apply it so they stop double-writing user
  facts.
- **`/consolidate` + `/reflect` as manual-only skills** — the on-demand memory-maintenance path runs in the
  agent loop with tools (read → classify → dedup → write), the in-product twin of ghostore's
  `enrich`/`summarize-logs`. The automatic background pass stays a cheap one-shot **sharing the same body**;
  it graduates to invoking the tool-using skill once `MEMORY.md` outgrows a single context window. Needs a
  `manual: true` skill flag so `skillRegistry.index()` doesn't advertise these for autonomous mid-chat
  pickup.
