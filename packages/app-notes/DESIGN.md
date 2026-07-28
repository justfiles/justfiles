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
| `rename({ from, to })` | procedure | both | Rename **is** move: retitle, drag into a folder, or move a whole folder. An occupied destination is deduped, never overwritten; returns where it landed |
| `list({})` | procedure | both | Fresh recursive listing: every note + every folder, newest first |
| `create({ text, dir? })` | procedure | both | New note; filename from the first line, `dir` defaults to `/` |
| `mkdir({ path })` | procedure | both | Only reason to exist: an **empty** folder (`writeFile` auto-creates parents) |
| `readNote({ path })` | procedure | both | Body as text |
| `importNotes({ dir?, files })` | procedure | both | Bulk write, relative to `dir` (default `/`); merges folders, numbers a clashing note rather than overwriting — the vault-import half (§9) |
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
  near-identical actions. It is a **procedure, not an edge**, because it must probe the destination first:
  `volume.rename` has POSIX replace semantics (the IndexedDB backend frees the displaced inode), so
  dragging `Kyoto.md` into a folder that already holds one would destroy the user's note. It dedups to
  `Kyoto 2.md` instead — the same `freePath` probe `create` and the importer use — and commits `openPath`
  through an internal `moved` edge once the real destination is known.
- **Both revision counters are optional.** They were added after the first release and persisted state is
  loaded verbatim (`init` is not re-merged, docs/app.md §3), so every reader defaults them: `undefined + 1`
  would pin a counter at `NaN` and the tree would refresh exactly once, then never again.
- **The import plan is a LIST, never a map keyed by path.** Two files dropped from different folders share a
  basename; a map keeps the last one and the report still says success. Duplicates ride through planning and
  the write-side claim numbers the second.
- **Naming dedup is a CLAIM, not a probe** (`claimPath`). `exists()` then `writeFile` is a TOCTOU: the
  agent, Files or a second window can take the name in between, and `writeFile` then overwrites a note the
  user just made. So the create *is* the check — `volume.writeFile(…, { exclusive: true })`, which throws
  EEXIST from the backend's atomic create (`O_EXCL`, one IndexedDB transaction) — and on EEXIST we number up
  and claim again. `rename` cannot be made exclusive, so a move claims an empty placeholder at the
  destination first and then renames over its own placeholder; holding the name is what makes it safe.

### Two invariants, learned the hard way

Review of this work turned up eight defects. Six of them were two mistakes made twice, so both are written
down as rules rather than patched case by case.

**1 · The app owns destination policy; the capability owns none of it.** `volume` is `Volume` reused
verbatim, which means POSIX semantics reach the app unfiltered: `rename` *replaces* an existing
destination, and it will happily rebind a folder's inode beneath its own descendant and strand the subtree.
Both were reachable from an ordinary drag. So every rule about *where something may land* lives in one pure
place — `illegalMove` (refuse) and `freePath` (dedup) in `src/notes.ts` — applied at **one** site, the
`rename` procedure. The GUI, the tree's drag-and-drop and the agent inherit it; none of them can forget it.
The same `freePath` is what `create` and `importNotes` use, so "nothing in `/notes` is ever silently
overwritten" is one function, not three policies.

**1a · A lexical path rule is only true of a path the volume agrees with — so accept ONE spelling.**
`illegalMove` compares strings, but `/Other/../Trips/Sub` is not under `/Trips` to a string comparison and
*is* to the volume that resolves it — enough to strand a folder inside itself. Refusing dot segments at
`pathSchema` fixed that, and was still the wrong shape: `/Trips/`, `//Trips` and `/Trips/.` all name the
directory `/Trips`, so the same guard was fooled again by a spelling the blacklist hadn't met yet. The rule is
not "reject the tricks", it is **the path we validate must be the path the volume writes**, and the only way
to say that once is to demand the single spelling the volume itself produces (`isCanonicalPath`). Refused,
never repaired: normalizing would put two spellings of one location into circulation and make every
comparison, cache key and stored `openPath` a question of which spelling arrived. Notes are named literally
(§4), so nothing legitimate needs another spelling.

An import is the exception that proves it: `files[].path` is *relative*, so it is judged as the path it will
become (`isCanonicalPath('/' + path)`) — same rule, no second policy. And because an archive is untrusted
input, an entry the volume would respell is **screened out and reported** rather than sent on to be refused:
one odd name must not cost the user the other thousand notes.

**1b · A check is not a guarantee unless it is the operation.** The first version of "never overwrite" was
`exists()` + `writeFile`, which reads as safe and isn't: it is only a *hint* about a moment that has already
passed. `Volume` turned out to have the real primitive all along — every backend's `atomicCreate` is an
exclusive create — it was just being discarded by `writeFile` resolving the path first. Exposing it as
`writeFile(…, { exclusive: true })` is 3 lines in `packages/fs` and deletes the probe from three call sites.

**2 · Never keep a second pointer to a location — derive it and validate on use.** "Which folder do new
notes go in" started as GUI state (`activeDir`), and every mutation then had to maintain it: deleting that
folder left it dangling, and `writeFile`'s parent-creation silently *resurrected* the folder the user had
just deleted; renaming it did the same. That is a bug per mutation, forever. It is now derived at the moment
of use: the folder last clicked in the tree is a **hint**, honoured only while it is still present in the
listing (which comes from disk), else the open note's folder, else the root. Deleting, renaming and moving
need no bookkeeping at all — the class is gone, not fixed.

"Validate on use" means *every* candidate, and the fallback is a candidate too: `openPath` is also a pointer
that outlives its folder, so `parentDir(openPath)` goes through the same liveness check, and the last resort
is the root — which cannot go missing. Both live behind one `liveDir()` gate that every "create in here" path
calls, including the one the tree hands a folder to, because the *last* moment before `writeFile` recreates a
parent is the only honest place to ask. This is §3's "the disk is the only source of
truth" applied to a *selection* rather than to the listing.

**3 · Bound untrusted input at the seam, and charge the bound with what is REAL.** A dropped zip is
attacker-shaped input. The archive is **streamed**, never read whole: `arrayBuffer()` on a 2 GB vault of
photos would kill the tab before a single limit was consulted, so entries are judged from their headers as
they arrive and only the notes we keep are held (a 400 MB archive imports its two notes with
`Blob.prototype.arrayBuffer` poisoned to throw). Per-entry limits are not a bound either — a thousand legal
4 MB notes is 4 GB — so a `Screen` ledger carries `MAX_FILES`/`MAX_TOTAL_BYTES` across the whole drop,
reports `stopped` ("Partly imported … the rest was left out"), and abandons the stream once spent.

The per-entry cap sits in a **decoder of our own**, because an entry cannot be aborted from outside:
`UnzipInflate` has no `terminate`, and the stream keeps feeding whichever decoder is active — so clearing the
buffer stops the memory but not the work, and a bomb that declares nothing would still be inflated in full.
Past the cap the decoder stops pushing, so the compressed remainder is walked rather than expanded, and the
entry never reaches `final` and so is never admitted. An 800 MB entry declaring nothing costs 1.6s and the
notes either side of it still import.

The split that matters is between the two questions, because collapsing them produced a P1: **a header is a
claim, a buffer is a fact.** `screenEntry(path, declaredSize)` is the pure, free pre-check that decides
whether bytes may be read at all; `Screen.charge(path, actualBytes)` is the ledger, and it is only ever
called with a length that exists. A zip written by a streaming writer declares its sizes in a trailing data
descriptor, so `originalSize` is `undefined` — charging the claim would charge zero for every entry and the
ceiling would never arrive, with every buffer still in memory. `admit` is the one place the two meet and the
only place the budget moves, so both readers, and duplicate paths, are counted the same way. Nothing is
memoized: two entries can share a path, and each costs.

A drop that mixes an archive with other files is refused whole: an archive is one vault and its root is
stripped on the way in, a rule that means nothing for two of them.

The remaining defects were genuinely separate ground — defaulting counters absent from persisted state,
bounding an untrusted zip before decompressing it, coalescing watch-event fan-out — and none of them were in
the pure modules. Rules belong in pure functions; the stateful layer should only sequence them.

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

### The tree (the docked pane)

The pane is a `@pierre/trees` `FileTree` (`src/tree.tsx`) — the same tree `app-code` uses, so the OS has
one tree idiom. It owns virtualized rows, expansion, drag-and-drop and the context-menu trigger; the app
owns only the seam:

- **The model is a projection, never the truth.** Paths in, gestures out: each gesture dispatches an
  action, and the `treeRevision` watch re-lists `/notes` and `resetPaths`. A write that fails therefore
  self-heals on the next scan — same rule as §3, one step further out.
- **Filtering is ours, not the library's.** The bar's field feeds `matchNotes` and the tree is handed the
  matching paths, so the dropdown and the tree rank identically and there is no second search session to
  keep in sync. Folders are implied by their children, so a filtered view feeds notes only.
- **CRUD is the row menu, and naming happens *in* the menu.** New note / New folder / Rename… / Delete…
  render as a `ds-menu` that swaps to a small text field or a confirm step. Two reasons it is not the
  library's inline rename: the inline input does not survive the context menu's own close/focus path, and
  — more importantly — a new note's name must be its **first line**, which the same field gives us for free
  (`onCreate(dir, title)` → `create({ text: title })`). Sandboxed iframes have no `allow-modals`, so
  `prompt()`/`confirm()` were never options.
- **The menu is portaled to the body**, pinned to the trigger's `anchorRect` and flipped up near the
  bottom edge. Rendered in place (the library slots it into the tree's light DOM) it is both clipped by the
  tree host's `overflow: hidden` and painted *under* the editor — it is a static, z-index-less child of the
  pane. The portaled root carries `data-file-tree-context-menu-root`, which is how the tree knows clicks
  inside it are not outside clicks.
- **The pane is resizable**: a `role="separator"` splitter, pointer-captured so the drag survives passing
  over the editor and the tree's shadow root, arrow-key adjustable, double-click to reset. Width is
  clamped (150–480) and persisted next to the pane toggle — GUI-local, never reducer state.
- **Dragging a row into a folder is `rename`** (`{ from, to }`), one per dragged path — dispatched from
  *both* `onDropComplete` and `onDropError`. The model's move is optimistic **and** collision-strict: a drop
  onto a folder that already holds that name throws inside its store (`collision: 'error'`), so
  `onDropComplete` never fires and the drag would look like a silent no-op. Persisting from both paths lets
  the reducer dedup and the watch redraw what actually landed; the GUI says so ("moved as “Trips/Kyoto 2”"). Dragging onto the
  **blank space below the rows moves the item to the top level** — the tree only resolves a drop target
  from row elements, so past the last row it resolves to nothing. The pane's tree wrapper is that zone: the
  drags are native HTML5 and carry the path as `text/plain`, drag events cross the shadow boundary, and
  `composedPath()` says whether the drop landed on a row (the tree owns it) or on blank space (we do).
  Dropping onto a root-level *row* already means root, so the two paths together cover a full tree.
- **Selecting a folder** sets the folder new notes land in; selecting a note opens it.
- **Both surfaces that show the listing keep it live**, and for both reasons it can go stale: a structural
  change anywhere (`treeRevision`) and a write to the open note (`revision`, which moves it in a
  newest-first list). The docked pane and the dropdown palette are the same list, so a palette left open
  while the agent writes must not sit on a dead listing.
- **One thing a listing cannot promise is freshness against a content write to a note that is not open.**
  The storage's change feed carries a `path` only for dirent mutations (`packages/fs/storage.ts`), so a
  recursive CONTENT watch could not be scoped to `/notes` — it would wake this app on every write anywhere in
  the storage, including every other app's state file. That is why `list()` promises newest-first *as of the
  call* and every surface re-lists on appearing, rather than trusting a listing to stay ordered.
- **Refreshes are coalesced and ordered.** A bulk writer — an import, or the agent — bumps `treeRevision`
  once per file, and a full recursive scan per note would swamp the app (301 notes went from ~301 growing
  scans to **2**). Each bump resets a 250ms timer, so the scan runs when the writes stop; opening the pane
  is not a bump, so it still lists immediately. `refresh` also carries a token, because scans overlap and an
  older, smaller listing must never overwrite a newer one.
- **Settle the buffer before changing the open note's path.** The editor buffer is GUI-local while the path
  is reducer state, so every path change races the pending autosave: a move **flushes** it to the OLD path
  first (else the late save recreates the file we just moved, or the read effect replaces the buffer with the
  last saved body), and a delete **discards** it (else the save writes the note straight back). One rule,
  three call sites — the alternative, putting body bytes in reducer state, is rejected by §3.
- **Where a new note goes is derived, never stored** — see §3's second invariant.
- **Rows show real filenames**, extension included — the tree is the file-first surface (the search
  dropdown is the title-first one). A rename that drops the extension keeps it (`renameTarget`), so a note
  cannot silently stop being a note.

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
  to a `ds-palette` (composed from the existing `ds-menu` rows) once there's a second consumer. The file
  tree is the same rule already applied: it is `@pierre/trees` (shared with `app-code`), themed through
  `--trees-*` variables pointed at the design tokens — not a local tree. Rule of thumb: **system-level look
  → `packages/design`; only Notes-specific layout (the editor/tree split) stays local.**

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
| `importNotes` | both | Bulk write, merging into the KB and never overwriting (§9). The agent can use it to land a batch it fetched; the GUI uses it for dropped vaults. |
| `list` | both | Fresh listing on demand — the agent's view of the KB is the filesystem, never cached state. |
| `newNote` | both | Harmless; mostly GUI-driven. |
| `readNote` | both | Convenience; the agent can also read the file directly. |
| `remove` | **gui** | Destructive. `/notes` is the user's — the agent never deletes user notes blindly (mirrors `app-code`'s gui-only `remove`). |

<a id="scope-v1"></a>

## 7 · Scope & non-goals

**In:** blank editor; the bar (search-or-create + docked-tree toggle + New) + derived listing +
path-aware filter; **nested folders** (recursive listing, `.md` default with `.txt` still read); human
filenames; debounced autosave + flush-on-transition; a docked file tree with full CRUD (create note /
create folder / rename / move by drag / delete) and open-on-select; **drop-a-zip vault import** (§9); live
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

**The import: drop a file on the window.** OS file drops DO reach the app through frieren's
opaque-origin `sandbox="allow-scripts allow-forms"` iframe — `DataTransfer.files` arrives and the bytes
read — so the gesture needs no host plumbing. The app root is the drop zone (dashed outline, copy cursor),
so it works wherever the file lands; the tree's own row/blank-space drops carry `text/plain`, not `Files`,
so the two never collide.

The split is: **the GUI unzips and plans, the reducer writes.**

- `planImport(entries, zipName)` (`src/import.ts`) is pure — entry names + bytes in, notes-to-write and
  skips out — so every rule below is a unit test rather than a thing you discover during someone's
  migration.
- `importNotes({ dir?, files })` writes one batch, `dir` defaulting to the KB root. Batches of 50 keep the
  round trips down and the status line moving.

What it does:

- **In:** `.md` / `.txt`, folder structure preserved, filenames **verbatim** (only NFC-normalized — macOS
  zips carry decomposed unicode, and skipping that step yields visually-duplicate notes).
- **The vault MERGES into the KB root — no wrapper folder.** `Compress` on `~/Documents/notes` produces a
  zip whose every entry starts `notes/`; that single shared root folder is *the archive's packaging*, not
  part of the user's structure, so it is stripped and `notes/Trips/Kyoto.md` lands at `/Trips/Kyoto.md`.
  Anything else would put the whole vault one level deeper than it was in Obsidian, which breaks the
  "these are just my notes" feeling and every relative markdown link with it. Only ONE level is stripped:
  past that, a single top folder is indistinguishable from a vault that genuinely keeps everything in one
  folder, and guessing would silently flatten real structure.
- **A name clash never overwrites.** Folders merge (importing `Trips/` into an existing `Trips/` is what
  the user means), and a note whose exact path is taken lands beside it as `Kyoto 2.md` — the same
  `freePath` probe `create` uses. The count comes back from the procedure so the status line can say
  "3 renamed to avoid a clash": the user keeps both copies and decides.
- Loose `.md`/`.txt` files dropped without a zip take the same path.
- **Screened before decompression.** `screenEntry(name, originalSize)` runs as the unzip `filter`, i.e.
  against the archive's central directory, so an attachment or an absurd entry is rejected from its
  **header** and never inflated. Otherwise a picture-heavy vault — or a zip bomb — would be decompressed
  into the tab in full just to be thrown away. The same rule is re-applied in `planImport`, since loose
  dropped files never went through a central directory.
- **Skipped, and reported** (never silently dropped — the count is in the status line, the detail in the
  console): any dotted segment (`.obsidian/`, `.trash/`, `.git/`), `__MACOSX/`, `.DS_Store`, `* (conflicted
  copy)*`, and everything that isn't a note — attachments, `.canvas`, `.base`, plugin data. Attachments are
  out because the GUI→reducer seam carries JSON-safe values, so the importer ships **strings**; the day we
  want binaries they need base64 or a host-level file-drop capability, which is a separate decision.
- **The root is computed over kept paths only.** A macOS zip carries `__MACOSX/` beside the vault folder;
  counting it would look like a second root and leave the whole vault nested one level too deep.
- **Not ported at all:** canvas, bases, Dataview/Templater code, plugins, `.obsidian` config. Their text is
  kept as-is where it lives inside a note; nothing is rewritten.
