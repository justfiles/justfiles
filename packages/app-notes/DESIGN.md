---
title: 'Notes — design'
description: A built-in Notes app over a shared /notes knowledge base, with a deliberate agent (TUI) interface.
---

# Notes — a freeform knowledge base shared by the user and the agent

`app-notes` is a built-in (nvAlt-style) app: a blank editor under a single always-visible bar — a
list toggle, a search-or-create field over a recency-sorted list, and a New button — debounced
autosave, and filenames derived from the first line. Its content lives
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
| `revision` — bumped when the open file changes on disk | `dirty` flag; search query; docked-pane preference; which folders are expanded; the folder new notes land in; cursor / scroll (all GUI-local) |
| `treeRevision` — bumped when anything in `/notes` is created / removed / renamed | **the note list** — derived from `/notes` on demand via `list()`, never cached (see below) |
| `error` | |

```ts
type NotesState = {
	openPath: string | null  // null = blank scratch — the agent's "what is the user viewing"
	revision: number         // the OPEN file changed on disk (external/agent edit)
	treeRevision: number     // the SHAPE of /notes changed (create/remove/rename anywhere)
	error: string | null
}
// The listing is NOT state — it is derived from /notes on demand (the `list` procedure).
// Folders are included, so an empty folder exists and CRUD has something to act on.
type Entry = { path: string; type: 'file' | 'dir'; title: string; mtime: number }
```

### Action surface

The real thing is `src/app.ts` — this table is the contract, not a copy of the code. Edges are
pure/sync; all IO is in procedures or via `t.cmd`.

| Action | Kind | Audience | Meaning |
|----|----|----|----|
| `open({ path })` | edge | both | **The** coordinating action — put a note in front of the user |
| `newNote({})` | edge | both | Blank scratch |
| `save({ path, text })` | edge → `t.cmd` | both | Overwrite a body (the GUI's debounced autosave) |
| `rename({ from, to })` | edge → `t.cmd` | both | Rename **is** move: retitle, drag into a folder, or move a whole folder. `openPath` follows the file, or the folder it lives under |
| `list({})` | procedure | both | Fresh recursive listing: every note + every folder, newest first |
| `create({ text, dir? })` | procedure | both | New note; filename from the first line, `dir` defaults to `/` |
| `mkdir({ path })` | procedure | both | Only reason to exist: an **empty** folder (`writeFile` auto-creates parents) |
| `readNote({ path })` | procedure | both | Body as text |
| `remove({ path })` | procedure | **gui** | Destructive: a note, or a folder and everything in it. Clears the editor if the open note went with it |
| `fileChanged` / `treeChanged` | `t.fromEvent` | internal | The two watch signals below |

Notes on choices:

- **The list is derived, not cached.** `/notes` is a *shared, multi-writer* store — the user (via this
  app), the agent (directly), and Files all write it — so caching its index in one writer's reducer state
  would drift the instant anyone else writes. `list` scans on demand instead; **the disk is the only
  source of truth.** This is a deliberate deviation from `app-files` (which caches `files` in state): there
  the store is effectively single-writer, here multi-writer makes drift a core case, not an edge one.
- **One recursive `scan`, not an N+1 stat storm.** `list` is a single
  `scan({ path: '/', recursive: true })`: the host's tree walk already holds every entry's stat, so it
  hands back `mtimeNs` with each one (`VolumeEntry.mtimeNs`). A vault of thousands of notes therefore
  costs one capability round trip, and nesting costs nothing extra.
- **Two watches, two signals.** The open file is watched so its body stays live under an agent/Files
  edit (`revision`); `/notes` is watched recursively as a *structural* signal (`treeRevision`) so the
  tree and the list refresh when anything appears, disappears or moves — including an import. Neither
  event carries data; the GUI re-reads via `list`/`readNote`.
- **Only app-session facts live in state:** `openPath` (a *pointer/selection*, not a copy of disk contents
  — app.md §3 endorses "what is the user looking at"), the two revisions, `error`. Re-deriving the list
  also gives true `mtime` recency on every call — no stale cache, no optimistic-mtime hack.
- **`rename` is one op, deliberately.** Retitle, move-into-folder and folder-rename are the same
  filesystem operation; giving the agent (and the tree's drag/drop) one `{ from, to }` beats three
  near-identical actions.
- **Naming dedup is an `exists()` probe** (`freePath`), not a lookup in a cached list.

<a id="files"></a>

## 4 · Filenames & autosave

**Filename = the first non-empty line, kept human — no AI, no slug.** `"Remember the milk"` →
`Remember the milk.md`. Case and spaces survive; only genuinely unsafe characters are dropped (path
separators, control characters, and `# | ^ [ ]` — the ones Obsidian itself warns break links, so a title
stays addressable if we ever resolve `[[wikilinks]]`); length is capped at 100; collisions get ` 2`,
` 3`; an empty first line falls back to `Untitled`. Assigned **once** at first persist; later edits don't
re-name (the user/agent renames deliberately).

This is a deliberate reversal of the original `remember_the_milk.txt` slug. The store is now expected to
hold an **imported Obsidian vault**, where the filename *is* the title (`References/Kyoto.md`) and
wikilinks address notes by that exact name. Slugging would have made our own notes second-class citizens
in their own vault — and any rename of an imported file destroys links. So: **imported names are never
sanitized** (verbatim, byte-for-byte); sanitizing applies only to names *we* mint.

**`.md` is the default extension; `.txt` still reads.** They are the same thing — plain text — so both are
listed and opened, and notes written before the switch keep working with no migration. New notes are `.md`
because that is what every other tool (and the agent) expects, and because it leaves room for YAML
frontmatter later.

**New notes land in the folder of the note last opened** — Obsidian's "same folder as the current file".
That folder is GUI-local (it must survive `newNote`, which clears `openPath`), and `create({ dir })`
carries it to the reducer.

**The threshold is the boundary where scratch becomes a file.** Two regimes:

- **Below threshold** (~40 chars): ephemeral scratch — never written, **discarded** on switch/close.
- **Above threshold**: a real file (name from the first line + first persist via `create`); from then on a
  **dirty buffer always flushes** on switch/close (even if later shrunk — that's undo's job).

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
  one search away).
- **Type** → update local buffer. Debounced (~800ms): if `openPath` → `save({ openPath, text })`; if blank
  scratch and `text.length ≥ threshold` → `create({ text })`, then adopt `openPath` from settled state.
- **The bar** (always visible — nothing behind a shortcut): a list toggle, a search-or-create field, and a
  New button. Focusing the field calls `list()` and drops the recency list down — empty query = everything,
  newest first; typing filters. **Search is path-aware**: every whitespace/slash-separated token must
  appear somewhere in `Trips/Kyoto`, so `kyo trip` and `trips/kyo` both hit, a title match outranks a
  folder-only match, and recency breaks ties (`matchNotes` in `src/notes.ts`). Rows show the folder path,
  so two notes with the same title are told apart. Content search is still later. Enter opens the top
  match, or — with no match — creates a note whose first line is the query (the nvAlt move: search and
  create are one gesture). Esc hops editor → field and back. ☰ docks the tree as a left pane —
  and the bar folds into it: ☰ + search become the pane's header, New its footer, so the editor side is
  pure content. The preference is GUI-local (localStorage where the host allows it; frieren's sandboxed
  iframe has no `allow-same-origin`, so there it degrades to per-session). The listing is re-fetched on
  every focus/open **and on every `treeRevision` bump**, so it never shows a stale set.
- **`Cmd+O` / `Ctrl+O`** → focus the search field (a faint `⌘O` hint sits in the field until first use).
  `Cmd+K` belongs to the shell omnibar: the app runs in a sandboxed iframe, so keys typed in Notes never
  reach the shell — binding `Cmd+K` would *shadow* the omnibar whenever Notes has focus. Shortcuts attach
  to the app root, not `window`, so they fire only when focus is inside the app.
- **New button / `Cmd+N`** → flush-if-dirty, then blank. Browsers reserve `Cmd+N` (it never reaches the
  page), so the button and Enter-to-create are the real paths; the key still works on hosts that deliver
  it (desktop webview).
- **Delete** (forward-delete in the field) → `remove` (GUI-only).
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
- **Reuse `ds-*` where it already fits.** The search dropdown's result rows are exactly a menu list —
  render them as `.ds-menu` / `.ds-menu-item`, which already carry the macOS selection highlight
  (`--focus` / `--on-focus`), hover/active, and dark mode. An optional File menu is the `menu` named export
  (app.md §9); the host renders it via `.ds-menubar` / `.ds-menu`, so it matches every other app.
- **Promote, don't fork.** If Notes needs a primitive the system lacks, add it to `packages/design`, not to
  `app-notes`. The clear candidate is a **command/search palette** (floating panel + filter input +
  keyboard-navigable, selectable list): the `Cmd+K` palette here, the launcher's fuzzy app search, and the
  slash-command menu are the same affordance — here it is the bar's search field + dropdown. Promote it
  to a `ds-palette` (composed from the existing `ds-menu` rows) once there's a second consumer. Rule of thumb: **system-level look → `packages/design`;
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
re-reads live (a `revision` bump). Writes to *other* notes need no pushing — the list re-reads `/notes`
fresh on every focus/open, so they appear the next time the user looks. So the agent rarely drives the app to
*create* a note; it writes the file and the app reflects it. The action unique to the TUI is **`open`** —
focusing a specific note in the user's window, which a file write can't do.

What the agent sees (docs/app.md §8): `state` as JSON (`openPath` = *what the user is viewing now*; the
note list is **not** in state — call `list()` for a fresh one, or read `/notes` directly) plus the action
surface below. `description` + `examples` are its UI — written above.

| Action | Audience | Why |
|----|----|----|
| `open` | both | **The** coordinating action — put a note in front of the user. |
| `create`, `save`, `rename`, `mkdir` | both | Available, but the agent usually writes files directly. |
| `list` | both | Fresh listing on demand — the agent's view of the KB is the filesystem, never cached state. |
| `newNote` | both | Harmless; mostly GUI-driven. |
| `readNote` | both | Convenience; the agent can also read the file directly. |
| `remove` | **gui** | Destructive. `/notes` is the user's — the agent never deletes user notes blindly (mirrors `app-code`'s gui-only `remove`). |

<a id="scope-v1"></a>

## 7 · Scope & non-goals

**In:** blank editor; the bar (search-or-create + docked-tree toggle + New) + derived listing +
path-aware filter; **nested folders** (recursive listing, `.md` default with `.txt` still read); human
filenames; debounced autosave + flush-on-transition; create/open/save/rename/move/mkdir/delete; live
re-read of the open note on external edits; a structural watch so the tree tracks the disk; the agent TUI
above.

**Out (deferred, not one-way doors):**

- **AI filenames**; **content search** in the search field (path/title only); **rich text**; **tags UI**;
  **`[[wikilink]]` navigation and backlinks** (imported links are preserved verbatim, so this can land
  later with no migration — see the reasoning in §9); **resume-where-you-left-off** (always-blank reopen is
  intentional).

Tolerate old persisted shapes (docs/app.md §3): new `NotesState`/`Entry` fields must be optional — `init`
is not re-merged into already-persisted state. `treeRevision` was added this way.

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

<a id="obsidian"></a>

## 9 · Obsidian interop — what we take, and what we deliberately don't

`/notes` is meant to be able to *hold* someone's Obsidian vault, so the shape of that data is a design
input, not an afterthought.

**What a vault actually is.** A plain folder of UTF-8 `.md` files with optional YAML frontmatter, plus
attachments in-tree, plus `.obsidian/` (config only), plus `.canvas` (JSON) / `.base` (YAML) files. There
is **no export format — the vault *is* the export.** Everything we need is already the substrate we have:
files on the Volume.

**Backlinks do not exist on disk.** Obsidian parses every file into a metadata cache (in IndexedDB,
app-side, *not* in the vault) and folds it into a forward index `resolvedLinks: source → { dest: count }`;
backlinks are the *reverse of that index, computed at query time*, and the whole cache is disposable
("Rebuild metadata cache"). So an import loses nothing by ignoring it — but anything graph-shaped we want,
we re-derive ourselves.

**Why we're not building the graph.** Backlinks solved retrieval in a world with no search that
understands you. Here the agent has in-process bash over the Volume, so
`grep -rl '\[\[Kyoto\]\]' /notes` *is* the backlinks query — zero code, zero index, no drift. What
backlinks would add is *ambient human discovery while reading*, which is a reading-app feature; this is a
capture-first app. The cheap 80% we do commit to: **imported text is preserved verbatim**, so every
`[[wikilink]]`, `#tag`, block ref and frontmatter link survives byte-for-byte and stays greppable. If the
itch shows up, the next step is `[[...]]` *click-to-open* (navigation) via one pure resolver — exact path
→ relative to the source → unique basename — and still no stored index.

**What the import will and won't do** (implementation is the last step, see §7):

- **In:** `.md` / `.txt`, folder structure preserved, filenames verbatim (NFC-normalized — macOS zips carry
  decomposed unicode, and skipping that step yields visually-duplicate notes), landed under a single
  `/<VaultName>/` folder so it is contained and reversible.
- **Skipped:** `.obsidian/`, `.trash/`, `.git/`, `__MACOSX/`, `.DS_Store`, `* (conflicted copy)*`, and
  binary attachments — reported, not silently dropped. Attachments are out because the GUI→reducer seam
  carries JSON-safe values, so the importer ships **strings**; the day we want binaries they need base64 or
  a host-level file-drop capability, which is a separate decision.
- **Not ported at all:** canvas, bases, Dataview/Templater code, plugins, `.obsidian` config. Their text
  is kept as-is where it lives inside a note; nothing is rewritten.
