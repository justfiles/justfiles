---
title: 'Notes — design'
description: A built-in Notes app over a shared /notes knowledge base, with a deliberate agent (TUI) interface.
---

# Notes — a freeform knowledge base shared by the user and the agent

`app-notes` is a built-in (nvAlt-style) app: a name field over a body under a single always-visible bar
— a list toggle and a search-or-create field over a recency-sorted list — debounced
autosave, and notes that are **named before they exist**. Its content lives
in a **shared, top-level `/notes`** volume path that the agent reads, searches, and (on request) writes
— so a single store serves both the human's notes and the agent's "remember / find" loop.

Read `docs/app.md` first — this doc only covers what's specific to Notes. Framework idioms (edges,
procedures, capabilities, the two-faces model) are assumed.

**Contents**

1. [Architecture context — one KB, two tiers](#context)
2. [Where notes live & scoping](#scope)
3. [The state machine](#machine)
4. [Names & autosave](#files)
5. [The GUI](#gui)
6. [The scratch buffer](#scratch)
7. [The agent (TUI) interface](#agent)
8. [v1 scope & non-goals](#scope-v1)
9. [Agent-runtime touch-points (out of this package)](#runtime)

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

The app declares a **prefix scope**, not `system` — and a second binding for its own data:

```ts
capabilities: {
	volume: volume({ scopes: ['/notes'] }),  // the shared knowledge base
	private: volume({ scopes: ['app'] })     // this app's /data/<id> — the scratch (§6)
}
```

Per `capabilities/volume/host.ts`, a `/prefix` scope chroots the app at that prefix and **still hard-blocks
`/system`**. So the Notes app sees the whole KB as its root but *cannot* reach the agent's private
transcripts, soul, or other apps' data — least privilege, unlike `app-files` which needs the broad
`system` scope. Inside the chroot the app's `/` **is** `/notes`, so it uses plain root-relative paths
(`/remember_the_milk.txt` lands at `/notes/remember_the_milk.txt`); no `/notes` prefix in app code, no
`mkdir` (writeFile auto-creates parents).

**Two bindings of one capability, because the app writes in two places with different owners.** A
capability is declared under a **local name** which the kernel maps to a trusted `{ id, scopes }`
(`packages/app/kernel.capability.ts`, and `caps.invoke` is then given `declared.id`), so a second scope
costs a second name and nothing else — no multi-root volume, no change to the capability. `resolveVolume`
resolves `'app'` to a chroot at `/data/<id>`, which is where the scratch file lives. The two roots stay
visibly separate at the call site (`app.invoke('volume', …)` vs `app.invoke('private', …)`), and the
manifest lists both, so the consent sheet tells the truth about what the app can reach.

> Notes is a built-in. Prefix scopes aren't allowlist-gated today; if the host later wants to restrict who
> may bind `/notes`, that's a host-allowlist concern, not an app change.

<a id="machine"></a>

## 3 · The state machine

The discipline (docs/app.md §3): reducer state is **semantic, persistable, agent-inspectable**; transient
interaction stays GUI-local. The body bytes never enter state — they live in the file and are re-read on
demand (the `app-files` pattern).

| Lives in **reducer state** (app-session facts) | Lives **outside** reducer state |
|----|----|
| `openPath` — which note is shown, or `null` for the scratch (§6) — "what is the user viewing"; a *pointer*, not a copy of disk | the editor's in-progress text buffer (GUI-local) — **both of them**: the note's and the scratch's |
| `revision` — bumped when the open file changes on disk | `dirty` flag; search query; docked-pane preference; which folders are expanded; the folder new notes land in; cursor / scroll (all GUI-local) |
| `treeRevision` — bumped when anything in `/notes` is created / removed / renamed | **the note list** — derived from `/notes` on demand via `list()`, never cached (see below) |
| | **the scratch's text** — a file in the app's own volume, re-read on demand like any other body (§6) |
| | **the last error** — a failed write is answered by whoever asked for it, while it still holds the buffer that failed to land (§1a‴), not filed in state for someone to notice later |

```ts
type NotesState = {
	openPath: string | null  // null = the SCRATCH is showing (§6) — the agent's "what is the user viewing"
	revision: number         // the OPEN file changed on disk (external/agent edit)
	treeRevision: number     // the SHAPE of /notes changed (create/remove/rename anywhere)
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
| `newNote({})` | edge | both | Close the open note and show the **scratch** (§6) |
| `save({ path, text })` | edge → `t.cmd` | both | Overwrite a body (the GUI's debounced autosave) |
| `readScratch({})` | procedure | both | The scratch's text — in the app's own volume, so this is the only way to it (§6) |
| `saveScratch({ text })` | procedure | **gui** | Overwrite the scratch. Not the agent's: it could erase words the user has not filed yet |
| `journal({ date, text })` | procedure | both | Append to the day's note (`/journal/<date>.md`), creating it once. `date` is the CALLER's local day — a procedure runs in UTC (§6) |
| `rename({ from, to })` | procedure | both | Rename **is** move: retitle, drag into a folder, or move a whole folder. An occupied destination is deduped, never overwritten; returns where it landed |
| `list({})` | procedure | both | Fresh recursive listing: every note + every folder, newest first |
| `create({ title, text?, dir? })` | procedure | both | New note **named** `title`; `text` is the body (empty by default — the title is not repeated in it), `dir` defaults to `/` |
| `mkdir({ path })` | procedure | both | Only reason to exist: an **empty** folder (`writeFile` auto-creates parents) |
| `readNote({ path })` | procedure | both | Body as text |
| `importNotes({ dir?, files })` | procedure | both | Bulk write, relative to `dir` (default `/`); merges folders, numbers a clashing note rather than overwriting — the vault-import half (§10) |
| `remove({ path })` | procedure | **gui** | Destructive: a note, or a folder and everything in it. Reports the deletion through an internal `deleted` edge, which clears the editor if the open note went with it |
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
  — app.md §3 endorses "what is the user looking at") and the two revisions. Re-deriving the list
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
  and claim again. A move cannot be that shape, because POSIX `rename` replaces and `packages/fs` offers no
  flag pretending otherwise (§1b): there the probe is ours, made inside the same `claimPath` chain, and on
  EEXIST we number up and try again.

### What kept going wrong, and where each rule now lives

Review of this work turned up twenty-three defects. That number is the interesting part: they are not
twenty-three independent mistakes, they are **four questions**, each asked at every site that touches it,
and every repeat was a *different site of a question already answered elsewhere*. So the fix that mattered
each time was moving the question to a single surface — never patching the site.

| The question | Where it lives now | Shape |
| --- | --- | --- |
| How is a path spelled, and what may a name contain? | `src/notes.ts` | pure, total (`isCanonicalPath`, `sanitizeName`, `illegalMove`) |
| What may a dropped archive contain, and how much of it? | `src/import.ts` | pure + one ledger per drop (`screenEntry`, `Screen`, `admit`) |
| **Who owns a name; is the check the operation?** | **create: `packages/fs` (`O_EXCL`). move: `claimPath`, here** | the fs offers only what POSIX has; claiming policy is the app's, in one chain (§1b) |
| Is this location still real, and is the buffer settled? | `src/gui.tsx` | `liveDir()` gate, `flush`/`discard` before a path change |

The third row is the one that cost the most, and it is the lesson worth carrying to the next app. **An app
cannot enforce a rule about a shared namespace from outside that namespace.** Notes wants one guarantee —
*putting something somewhere never destroys what is there* — and the volume offered two primitives that both
replace. So the app emulated the missing one, twice, and each emulation was a fresh source of defects:

- `exists()` + `writeFile` — a TOCTOU; the loser of the race has its note overwritten.
- claim a placeholder, then `rename` over it — worse, because it *looks* atomic. A placeholder is not a
  reservation in a store other writers share: an ordinary `writeFile` lands **inside** the claim, and the
  move then destroys the data it was meant to protect. And a file placeholder is the wrong *type* to rename
  a folder over, so on the Node backend every folder move failed with ENOTDIR.

The create's version disappeared into `packages/fs`, backed by a primitive that cannot be raced
(`atomicCreate`: `O_EXCL`, one IndexedDB transaction, one synchronous map mutation). The move's did not, and
after #330 it explicitly never will: POSIX `rename` replaces, so the fs exposes exactly that and the probe
stays here, on the chain that makes it truthful (§1b). What is left
in this app is its own *policy* — "on EEXIST, number up" (`claimPath`, six lines) and "never inside itself"
(`illegalMove`, pure) — which is all an app should ever hold. Rule of thumb for the next one: if a guarantee
needs two calls to express, it belongs one layer down; if it needs a cleanup path, it is already wrong.

### The invariants, learned the hard way

**1 · The app owns destination POLICY; the namespace owns the guarantee.** `volume` is `Volume` reused
verbatim, so POSIX semantics reach the app unfiltered: `rename` *replaces* an existing destination, and it
will happily rebind a folder's inode beneath its own descendant and strand the subtree. Both were reachable
from an ordinary drag. Policy — *may this land here, and where does it go if the name is taken* — lives in
one pure place (`illegalMove`, `numberedPath`) applied at one site per procedure, so the GUI, the tree's
drag-and-drop and the agent all inherit it. The **guarantee** that a write or a move cannot destroy what is
already there is not policy and does not live here at all: it is `{ exclusive: true }` in `packages/fs`. The
app's whole share of it is `claimPath` — try, and on EEXIST number up — which `create`, `rename` and
`importNotes` share, so "nothing in `/notes` is ever silently overwritten" is one loop over one primitive.

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

**1a′ · A valid path is not the same question as a path that NAMES something.** `isCanonicalPath` answers
"could the volume spell it this way"; `/` passes and is the knowledge base itself. Every operation that acts
on a *thing* has to refuse it, and the two cases that proved it are the two that would have hurt most:
`remove('/')` deleted every note in one call, and an import member of `''` joined to `/`, which `claimPath`
numbered into ` 2` — an invisible file the listing does not even show, because it is not a note. So there are
three schemas over two extra predicates: `pathSchema` (`namesEntry`) for anything that acts on a note *or*
folder, `dirSchema` for a *place to put* one (where the root is the default and perfectly valid), and
`noteSchema` for the actions that act on a note's BODY — because `list` returns folders too and the agent can
hand one straight back, and `open('/Trips')` used to leave the editor pointing at a directory whose read fails
EISDIR, with nothing to show and nothing to fix it. A relative import member is judged as what it becomes,
`namesEntry('/' + path)` *and* `isNotePath`, which is what refuses both the empty string and `image.png`.

The closure property behind all of it: **this app must not be able to produce a path it cannot then manage.**
`list` shows only `.md`/`.txt`, and `open`/`readNote`/`save` accept only those — so anything that *writes* a
path has to land inside that set, or the note it made is invisible and unsavable with no way back. That is why
`rename` carries the source's extension over a destination that has none (`renameTarget`, in the procedure
where the agent and the tree both pass through), and why an import member must be a note before it is written,
not merely a legal path.

**1a″ · A remembered path is a claim, and the WRITE is where it is proven.** The GUI holds `openPath` and
autosaves to it. Nothing keeps that path true: rename `/Trips` from Files or the agent while `Kyoto.md` is
open, and neither watch can say so — the recursive one is structural but carries no path, and the file's own
dentry never moved (its *parent* did). The old shape of this bug is what makes it nasty: a plain `writeFile`
**creates**, and the host helpfully creates missing parents too, so the next autosave rebuilt `/Trips` and left
a stale duplicate in it while the real note sat in `/Journeys`.

Tracking the path harder is the wrong answer (that is §2 again: a second pointer to a location). Instead the
write refuses to invent anything: `save` passes `update: true`, which is `open` without `O_CREAT` — ENOENT if
the path is not there, and no parent folders on the way. That check has no gap, because it happens in the call
that resolves the path. The host skips its `mkdir -p` for an update for the same reason.

`create` needs the other half of that, because it *does* create the file and must not create the folder: the
GUI picks the destination from its listing, which is a snapshot — the agent can have deleted that folder a
moment ago, and the host's convenience would rebuild it around the new note. So the capability grows the one
thing it adds to `Volume` (`parents: false` in `capabilities/volume/contract.ts`), the host declines its own
`mkdir -p`, and a vanished folder is an ENOENT at the write instead of a resurrection. The GUI answers that by
putting the note at the top level and saying so — "that folder is gone — saved at the top level instead" —
because the one thing that must not happen is losing the text. An import keeps `parents: true`: creating
folders is what an import is for.

ENOENT is then a *signal*, not just a failure: the note we were editing is gone, so the GUI detaches the
buffer from the dead path (`openPath` → null), marks it unsaved again — a failed write means the bytes are not
on disk, whatever `flush` optimistically assumed — and says so. The text becomes a scratch buffer, which the
next flush writes as a new note in a folder that exists. Nothing is resurrected, nothing is lost, and the user
is told which of the two happened.

**1a‴ · The buffer is a MACHINE, because it was a discipline and the discipline kept losing.** The text being
edited, whether it is saved, and where it belongs are one fact with one set of rules — and each rule arrived as
a separate defect:

1. Nothing may replace the buffer until it is **settled**, and "settled" is an answer a caller has to look at.
2. A write that did not land leaves the buffer **unsaved**. Always — including the create branch, which is the
   one I forgot, and which left text on screen looking saved while the next transition skipped the retry.
3. A failure is **not a diagnosis**: ENOENT/EISDIR mean nothing will ever save to that path (detach, keep the
   words, they become a new note); anything else is the same note with a temporary problem (stay attached, so
   the retry *updates* it rather than leaving a numbered duplicate beside it).
4. Writes never **overlap**, and keystrokes typed *during* a write are not lost — the buffer settles again
   instead of reporting a stale success. `dirty` is cleared on the way into a write, so a caller that raced one
   used to read that flag, conclude "settled", and clear the editor over words still in flight and about to
   fail.
5. A read that resolves after the buffer **moved on** is discarded — including a read whose note was deleted
   while its body was in flight, which is why the machine remembers what it is *about* to hold, not only what
   it holds.
6. A write never replaces a body the buffer **has not seen**. It remembers what it read, so a note that
   changed underneath is merged when the change was only an append, and otherwise becomes a question for the
   user — never a silent overwrite reported as a success (§1b).

Those rules lived across eight call sites in `gui.tsx` as five mutable refs plus a habit, which is why four
successive review rounds found four more instances of the same shape: every new failure mode was a new branch
to remember at each site. They now live in `src/buffer.ts` — no React, no volume, IO as three injected
functions — with the rules above as its unit tests (`buffer.test.ts`, including "keystrokes during a write are
not reported as saved" and "a settle during a write does not report the other write's optimism", which are the
two that no amount of care at call sites was going to get right). `gui.tsx` lost 100 lines and now only
*drives* it: `if (!(await settle())) return` before anything that changes what the editor shows, and one
`explain()` for how a failure is worded.

The exchange rate is worth stating: **a rule you have to remember is a defect with a delay.** The machine is
not fewer lines than the flags were — it is the same rules in a place where a test can reach them. The round
after the extraction proved the point twice over: four more findings arrived, and each one was a *rule the
machine did not yet state* rather than a call site that had forgotten it — so each fix was one place and one
test.

Three of those are worth naming, because they generalise:

- **Typing takes over the buffer.** A read already in flight would otherwise land on top of the keystrokes and
  mark the result clean. So `type()` invalidates a pending read, and `open` comes round again: it settles those
  words to the note they were typed into, *then* reads the note that was asked for. Nothing is dropped and the
  selection still lands where the user pointed it.
- **Only "it is gone" may detach.** That rule was applied to save failures and not to read failures, so an EIO
  during a refresh detached a dirty buffer and the next autosave forked a duplicate. `OpenOutcome` carries
  `gone` now, and a transient read failure changes *nothing at all*.
- **An operation that must un-happen needs a way back.** Deleting the open note discards its buffer *before*
  the delete lands (a pending write would put the note straight back), so a delete that fails has to restore
  what it emptied — `restore(snapshot)`, one method, one test, and the user keeps both the note and the edits.

And its sibling, found the same way: **a procedure's `app.state` is a snapshot, so a question about the
current selection cannot be answered inside one.** `remove` used to test containment itself and then dispatch
an unconditional `newNote`, which cleared a selection another client had moved elsewhere while `rm` was in
flight — and left a note *opened under the doomed folder* in that window selected. So the procedure reports
what it deleted (`deleted`) and the reducer, which sees the current queued state, decides what that means.
Same shape as `moved`: **procedures report facts, edges apply rules.**

Two more, both about **reading an answer out of something that only guarantees order**. `create` returned
`app.settled(seq)`, which resolves with the state after the app's queue drains — so another client's `open`
landing in that window renamed the bytes we had just written, and the user's next keystrokes went into a
stranger's note. The path we claimed is a local fact; `settled` is asked for sequencing and nothing else. And in
the palette, `filtered[active]` being `undefined` was read as "no results", when it also means "the results
moved under a selection that outlived them" — so a live listing shrinking made Enter create a duplicate named
after the query. **Creating belongs to an empty result set, never to a missing index**, and the index is clamped
rather than reset, because results vanishing under the user should move their place as little as it has to.

A smaller one, but the same family: **a listener that cannot be removed is a rule that outlives its buffer.**
The page-hide flush was registered anonymously, so an unmounted instance kept flushing — and a stale buffer
left dirty by a failed save could later land on top of what the live instance had written. Every listener the
GUI adds now comes off in the cleanup; the mount/unmount seam in `packages/app/react.ts` is a real lifecycle,
not a formality (verified by mounting and unmounting the GUI three times and counting: 1,2,3,4 before, 1,1,1,1
after).

Two more arrived the round after, and both are the same shape: **the way back must be offered only to the
buffer that was emptied** (`discard` returns the undo, `null` when it was holding something else — and the undo
*declines* if the user typed meanwhile, because their newest words outrank a snapshot taken before them), and
**a filesystem code is what the volume said, not text found in the message** (`failedWith` reads the code from
the front: a note called `ENOENT.md` that hit an EACCES is very much still there).

And one rule the reducer had to grow for: **`openPath` cannot say why it changed.** "The agent renamed the open
note" and "the agent opened something else" look identical to it, and they need opposite handling — the first
carries the buffer to the new address, the second settles it at the old one. So the `moved` edge records where the open
note *used to be* (`movedFrom`) and the GUI carries the buffer there; without that, an agent rename during an
unsaved edit tried to save to a path that no longer existed, detached on ENOENT, and left a duplicate.

That field is **a trail of the addresses this note has had**, not the last move that happened. A client sees
state, not each transition, and the two failures it has to survive pull in opposite directions: of two renames
it may have *missed both* (so the previous address is wrong) or *followed the first and missed the second* (so
the original address is wrong). Only the trail answers both — the GUI maps whatever address its buffer holds
forward to `openPath`. Bounded to the last eight, because a trail is not a log; only moves that carried *this*
note are recorded, because a signal an unrelated event can overwrite is not a signal.

The same round found its twin inside the machine: **a failure about an address the buffer has left is not a
diagnosis.** An autosave in flight to the old path fails ENOENT after a rename, and reading that as "the note is
gone" detaches the buffer *from its new address* and turns the unsaved words into a duplicate. So a write
carries the generation it started from, and a stale failure just means: write these words where the note lives
now.

**1a⁗ · A content write must not orphan, and must not resurrect.** `update: true` proves the path *at the
resolve*, and the bytes are stored a moment later — so the note can be deleted in between. Every backend
handled that by skipping the metadata update and returning success: the content went into the store attached
to nothing, and the editor cleared its unsaved marker over a note that no longer existed. Silent data loss
dressed as a successful save.

The requirement therefore lives where the content lands, not one layer up: `putBlob` throws ENOENT if the
inode is gone (`packages/fs/storage.ts`). Memory checks in the same synchronous step that writes, IndexedDB
reads the inode *first* inside the transaction that writes, and the native backend opens `r+` rather than `w`
— the OS resolves the path and hands back a handle to the file that is *there*, so a deleted note cannot be
written back into existence. Three backends, one sentence in the contract: **a write to something that is gone
is a failure, not a no-op.**

And on that backend, two more things a hand-written syscall sequence has to remember. **A pathname is not an
identity:** replace-under-the-same-name (a sync client, another editor's atomic save) leaves the name pointing
at a different inode, so the handle is asked what it actually opened (`handle.stat().ino`) before anything is
truncated — content is addressed by inode here, and only that inode may be written. **A write is not a write
until all of it is written:** `handle.write` may report fewer bytes than it was given, leaving a prefix of the
note on disk under a successful-looking save, so it is `handle.writeFile` (which loops) instead.

**1b · A check is not a guarantee unless it is the operation — WHERE THE OPERATION EXISTS.** The first
version of "never overwrite" was `exists()` + `writeFile`, which reads as safe and isn't: it is a *hint*
about a moment that has already passed. For a create, `Volume` had the real primitive all along — every
backend's `atomicCreate` is an exclusive create — it was just being discarded by `writeFile` resolving the
path first. Exposing it as `writeFile(…, { exclusive: true })` is 3 lines in `packages/fs`, deletes the probe
from three call sites, and makes the create *be* the check. Free, so take it.

A move is not free, and this is where I overreached twice. `rename` has no exclusive form: POSIX rename
always replaces, and `renameat2`/`renamex_np` are not reachable from Node. Attempt one emulated it in the app
— claim an empty placeholder at the destination, then rename over it — which is not a reservation in a store
shared with Files and the agent (an ordinary write lands *inside* the placeholder and the move then destroys
it) and is the wrong *type* for a folder move (ENOTDIR on the native backend). Attempt two pushed the same
emulation into the backend as `link` + `unlink`, which stops being a move at all: a crash between the two
leaves the file under both names.

**The right move was to size the problem before solving it.** Who actually races for a destination here? The
import loop is sequential (`for … await` over one chunk at a time), an agent tool call is one call, and the
GUI has exactly one gesture that produces several moves — a multi-item drop — which the tree applies one at a
time (`persistDrop`). So `rename(…, { exclusive: true })` became a check and *then* a move, documented as
exactly that, and the guarantee it gave — sequential writers never overwrite each other, whatever type holds
the name — is the guarantee the app needs.

**Round three (#330) started by finding a primitive one layer lower than POSIX — and ended by deciding not to
expose it.** Most stores here *do* have a transaction (mem a synchronous pass, IndexedDB and SQLite a real
one), so a no-replace move genuinely can be decided inside the commit that rebinds the entry. That worked. The
problem was the flag it needed: `rename(…, { exclusive: true })` would have promised something *different on
every backend* — settled by a transaction here, guessed at by a filesystem there, negotiated over a wire in
between — and a call site cannot reason about a guarantee that varies by who is underneath it. A flag like
that is worse than no flag, because it reads like a promise.

The review of that attempt is the evidence, and it is worth keeping in full. Four rounds, the same defect each
time: an in-process lock had been added under the native backend, and each round found a scope it did not
cover — per storage instance, per root path, per canonical root, and then "it must swallow every create too".
The next scopes are `rm`, and then the writers that actually share a user's directory: Finder, `mv`, a sync
client, a second copy of the app. An in-process mutex cannot reach those, so it charges everyone for a
guarantee no caller can lean on. Four rounds of review found the same thing four times, which is what a wrong
premise looks like from the inside.

**So `packages/fs` keeps the shape of a filesystem: `rename` replaces, and there is no flag.** `writeFile`'s
`exclusive` stays, because `O_EXCL` is a primitive every backend really has — that is the line. Everything
else about claiming a name is *policy*, and policy lives here, in `claimPath`: order the claims, probe the
destination, number up on EEXIST. Which is what every system in this position does — git takes a lock it owns
and can see (`index.lock`, `O_CREAT|O_EXCL`), Maildir gives files names that cannot collide, dpkg moves a
`.dpkg-tmp` into place. None of them hide mutual exclusion inside the filesystem layer.

The rule from rounds one and two therefore survives, sharpened rather than reversed: **push a guarantee down
to where the state is — if something down there can really keep it, and if it can keep it the same way for
every caller.** `O_EXCL`-shaped things can. A directory shared with other processes cannot.

What the backends *do* still owe, behind that unchanged interface, is not corrupting themselves while obeying
it — and holding them to it found a real bug that the flag had been hiding. `Storage.deleteInode` says a
backend must not free an inode another directory entry still names (sync replay leaves a transient second name
during a move). mem and SQLite honoured that on the displace path; **IndexedDB did not**, so a rename that
replaced one of two names for one inode left the survivor pointing at nothing — a dangling entry in the tree,
silent until read, on the backend the browser app actually runs. One condition fixed it, and
`packages/fs/displace.test.ts` now asks every owning backend the same question. That is the difference between
complexity that grows and complexity that doesn't: a minimal interface with one rule enforced identically
underneath, instead of a per-backend promise leaking through a flag.

"Sequential" is a claim about the app, though, and the app has to *make* it true rather than observe it: the
kernel runs procedures **off** its per-app queue, so a GUI drag and an agent tool call genuinely overlap. So
taking a name runs on one chain (`serially`), and every claim sees the previous one's result. Three lines, and
after #330 they are not a belt over braces — they are the mechanism: the probe and the move are two steps, so
the chain is the only thing that keeps the probe truthful. `concurrent renames to one name are ordered, not
raced` fails without it. Writers in *other processes* reaching for the same new name in the same instant can
still lose one — a knowingly accepted window, stated where the check is, and the same window git's lock file
has.

The chain belongs **inside `claimPath`**, not around one call site, and the reason is the mix rather than
either half: an exclusive create is atomic and needs no help, a move is not, and when the two race the atomic
one loses — the move sees a free destination, the import claims it exclusively, the move's second step lands on
top, and *both* callers report success. Serializing only moves protects moves from moves and leaves the import
to be silently overwritten. Taking a name is one serialized act however it is done. One level, too: wrapping a
`claimPath` in another `serially` deadlocks — it holds the chain while waiting for it — which is the ordinary
price of a mutex and the reason there is exactly one chain.

That chain has since taken two more riders, for the same reason rather than a new one: **`journal`'s append
and `save`** (§6). `appendFile` is read-merge-write in the volume, so anything that writes inside one loses —
two appends lose an entry, and a `save` inside one loses the user's typing while their buffer believes it
landed. They share the *same* chain as the name claims because all of them write into one namespace, so a
create taking a name, a body write and an append to that name must be ordered against each other. Still one
level: neither calls `claimPath`.

A test that asserts ordering has to be able to fail: the volume double had no `await` between its check and
its move, so it was accidentally atomic and the tests passed with the ordering removed. With the yield in
place, dropping the chain loses the imported note outright (`['the moved one']`), which is the defect stated
as an assertion. The double now yields
where the contract admits a gap, and two concurrent renames onto one name collapse to a single note without
`serially` — which is the point.

**Push a guarantee down when the primitive is already there. When it is not, remove the concurrency instead
of emulating the primitive** — ordering your own writes is cheap, and an emulated atomic is a defect surface
with a comment on top.

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

Three corollaries, each of which was a defect first:

- **A bound on what you KEEP is not a bound on what you RECORD.** Ceilings on accepted notes say nothing
  about an archive of 40,000 attachments: no bytes are charged, no note is kept, and the refusals themselves
  were the unbounded thing. So every *member* is counted (`MAX_MEMBERS`), refused or not, and the report is a
  **count plus a capped sample** — never one entry per refusal. "Every member" includes the ones that produce
  nothing at all and are not worth reporting: a zip's folder entries go through `screen.ignore()`, because a
  ceiling only what-we-keep can reach is no ceiling — an archive of a million empty directories walked to the
  end while the ledger stayed at zero.
- **The parser has its own limits, and they arrive before yours.** fflate's `Unzip.push` recurses once per
  entry header in the buffer it is handed, so a single chunk carrying tens of thousands of tiny entries
  overflowed the stack *before* any ledger was consulted — the drop died with "Maximum call stack size
  exceeded". The archive is now handed over in 64 KB slices, which bounds the recursion by the slice instead
  of by the archive. A budget you never reach is not a budget.
- **A write-as-you-go operation fails PARTIALLY, so say so.** An import that dies in its fourth chunk has
  already put three chunks on disk; reporting "Import failed" hides them, and a retry numbers them all as
  duplicates because an import never overwrites. Progress is therefore tracked outside the `try`
  ("Imported 120 of 300 notes, then stopped: …"), and one unwritable name is counted rather than thrown, so a
  single bad member cannot abandon the other forty-nine in its chunk.

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

## 4 · Names & autosave

**A note is named before it exists, and its body never repeats the name.** The editor is two fields: a
name field in a larger type over the body. What looks like the first line **is the filename** — exactly as
Obsidian's inline title looks like a first line while living outside the document (it is a separate
`div.inline-title`, and the `.md` on disk holds body only). `create({ title, text? })` takes the name;
nothing derives one from prose, and there is **no such thing as an unnamed note**.

> The **scratch is the one surface with no name field at all** — one field, not two (§6). It is not a file
> anyone named, so an empty name line above it would be a field for a thing that does not exist, permanently
> inviting the decision the surface exists to postpone. Its name is asked for once, at the moment it stops
> being a scratch.

This replaced "filename = the first non-empty line, assigned once at first persist", which failed three
ways. It **drifted** — fix a typo in the title and the filename keeps the typo forever, because the name
was a snapshot of a line that kept changing. It **duplicated** — our notes carried their title in the
body while an imported Obsidian note does not, so `/notes` held two shapes of note and every reader (the
editor, the agent, a future wikilink resolver) had to know which it was looking at. And the name was
**unreachable from the editor**: retitling meant the tree's context menu, so the commonest operation on a
note had no home in the surface you were looking at. §4's original argument — that imported names are
never sanitized, because the filename *is* the title and wikilinks address it byte-for-byte — is the same
argument one step further: our notes now have the vault's shape, not a shape of their own.

**The name is committed on Enter or blur, never on a keystroke.** Obsidian does the same, and here
per-keystroke would be actively harmful: every letter would be a `rename` through `claimPath`, which
numbers on collision (type `Kyoto` while `/Kyo.md` exists and you land on `Kyo 2.md` mid-word), every
letter would bump `treeRevision` and rescan, a 20-character title would overflow the 8-entry `movedFrom`
trail, and wikilink rewriting — when it lands — would rewrite *other notes* per letter. Enter also drops
the caret at the top of the body, which is what makes two fields read as one document; Esc abandons the
draft. (Both keys leave the field, so the draft is held in a ref as well as state — a blur handler reading
React state still sees the draft it was told to abandon.)

**A typed name is judged; a name that arrives as data is repaired.** `illegalName` (pure, mirroring
`illegalMove`) reports only what is genuinely unusable — `\ / # | ^ [ ]`, control characters, a leading
dot, over 100 characters — and stays quiet about tidying, because refusing `Kyoto  trip` over a double
space is obnoxious. `sanitizeName` then collapses whitespace and normalizes to NFC, so after a `yes` its
repair is faithful. The name field refuses (the field keeps focus on Enter, with the reason under it) and
`create`/`importNotes` repair, because there is nobody in a field to tell.

**A name already taken is refused too — but only as an affordance.** The GUI checks its listing before
committing, so someone is told while they are still in the field instead of finding their note moved to
`Kyoto 2`. That check reads a snapshot, so `claimPath` in the reducer stays the authority: it still
numbers rather than overwrites, and a name taken in the instant between the check and the write is
reported after the fact ("a note was already there — moved as …"). One policy in the reducer, one
affordance in the GUI; nothing new stands between the vault and an overwrite.

**Collisions on creation are numbered, not refused**, and imported names are written **verbatim** —
unchanged from the original design (§10), because an import is a batch of 400 that must not stop, and a
renamed import file destroys the links into it.

**`.md` is the default extension; `.txt` still reads.** They are the same thing — plain text — so both are
listed and opened, and notes written before the switch keep working with no migration. New notes are `.md`
because that is what every other tool (and the agent) expects, and because it leaves room for YAML
frontmatter later.

**New notes land in the folder of the note last opened** — Obsidian's "same folder as the current file".
That folder is GUI-local (it must survive `newNote`, which clears `openPath`), and `create({ dir })`
carries it to the reducer.

**Autosave is the body's business only.** The body is debounced (~800ms) and, because correctness cannot
rest on a timer, **flushed if dirty on every transition** — opening another note, renaming this one,
window close. Renames are their own commit (above) and do not wait for the debounce. There is no
"scratch becomes a file" threshold any more: the file exists from the moment it is named, so a save only
ever *edits* (`save` uses `update: true` and fails if the note is gone — §3).

The buffer creates a note in exactly **one** case: the note it was holding was deleted or moved out from
under it, and the words typed since have to land somewhere. That is what the remembered name is for — the
name the note had — since nothing derives one from a body any more.

**Webview flush gotcha (must design for):** saves are async RPC round-trips to `quayd`. On `Cmd+W`/close
the window can tear down *before* the write lands. The close path must **await the final flush**
(`windowShouldClose` / flush-on-blur), not fire-and-forget — otherwise "save if dirty" isn't true.

<a id="gui"></a>

## 5 · The GUI

Renders state, dispatches actions, owns transient state (docs/app.md §9). Deliberately minimal:

- **Launch = the scratch, with the caret in it.** On mount, dispatch `newNote` (guarantees
  `openPath: null` + an accurate agent view). Reopen is still always unfiled — on-brand for
  capture-first — but unfiled is now a **live surface** rather than a placeholder: the largest region on
  screen is a persistent scratch buffer you can type into immediately (§6). The search field is one key
  away (⌘O), and it is still where every *other* dead end lands (a deleted note, a scratch that could not
  be read).
- **Type in the body** → update local buffer, debounced (~800ms) → `save({ openPath, text })`, or
  `saveScratch({ text })` when the scratch is showing. **Type in the name field** → nothing until Enter or
  blur, then `rename` (§4). The scratch has no name field — it is named at the moment of keeping (§6).
- **The bar** (always visible — nothing behind a shortcut): a list toggle and a search-or-create field.
  Focusing the field calls `list()` and drops the recency list down — empty query = everything,
  newest first; typing filters. **Search is path-aware**: every whitespace/slash-separated token must
  appear somewhere in `Trips/Kyoto`, so `kyo trip` and `trips/kyo` both hit, a title match outranks a
  folder-only match, and recency breaks ties (`matchNotes` in `src/notes.ts`). Rows show the folder path,
  so two notes with the same title are told apart. Content search is still later. Enter opens the selected
  match; a **Create “…” row** sits after the matches whenever anything is typed, so search and create stay
  one gesture (the nvAlt move) — offered even when something matches, because `Kyoto trip` matching is
  exactly why `Kyoto` would otherwise be uncreatable, and reachable with ArrowDown so it costs no second
  shortcut. A **Scratch row** is pinned above the matches in both surfaces (§6). The dropdown scrolls, so
  arrowing keeps the highlight in view (`scrollIntoView({ block: 'nearest' })` on whichever row is
  selected) — the highlight is the only thing that says where Return will go, so it is never off screen.
  Esc hops editor → field and back. ☰ docks the tree as a left pane —
  and the bar folds into it: ☰ + search become the pane's header, so the editor side is
  pure content. The preference is GUI-local (localStorage where the host allows it; frieren's sandboxed
  iframe has no `allow-same-origin`, so there it degrades to per-session). The listing is re-fetched on
  every focus/open **and on every `treeRevision` bump**, so it never shows a stale set.
- **`Cmd+O` / `Cmd+N`** → focus the search field. They are the SAME shortcut: both mean "go to where a
  note is found or named", which is the only way a note begins. `Cmd+O` is the one that works everywhere —
  browsers **reserve** `Cmd+N` for a new window and never deliver the keydown, so `preventDefault` has
  nothing to prevent (the only escape hatch is the Keyboard Lock API: Chromium-only, fullscreen-only, and
  unavailable to our opaque-origin sandboxed iframe) — and `Cmd+N` costs two characters to keep for the
  hosts that do deliver it (desktop webview). A faint `⌘O` hint sits in the field until first use.
  `Cmd+K` belongs to the shell omnibar: the app runs in a sandboxed iframe, so keys typed in Notes never
  reach the shell — binding `Cmd+K` would *shadow* the omnibar whenever Notes has focus. Shortcuts attach
  to the app root, not `window`, so they fire only when focus is inside the app.
- **`Cmd+S`** = *keep this*, and **`Cmd+J`** = *jot* (back to the scratch). Both are **delivered and
  cancellable**, unlike `Cmd+N`: `Cmd+S`'s browser default (save the page) is suppressed by
  `preventDefault` — verified inside frieren's opaque-origin sandboxed iframe, not assumed — and the mac
  shell binds only `Cmd+W`/`Cmd+Q` natively (`apps/mac/…/Booter.swift`), so nothing upstream swallows
  them. On a note `Cmd+S` lands the buffer now and says "Saved": never anything destructive, so the reflex
  is safe wherever it is pressed. On the scratch it files (§6). Digits were the obvious pick for "go to the
  scratch" and are unusable — `Cmd+1`–`9` switches browser tabs and cannot be prevented. `Cmd+J` is never
  the ONLY way back: the Scratch row is (§6), and it displays this key.
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
  a new note needs a **name** before it exists (§4), which the same field gives us for free
  (`onCreate(dir, title)` → `create({ title })`). Sandboxed iframes have no `allow-modals`, so
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

<a id="scratch"></a>

## 6 · The scratch buffer

**The app opens on a persistent scratch buffer, not on a placeholder.** With no note open, the largest
region on screen used to be a read-only textarea with the words *"Find or name a note above, then write
here"* in it — the first thing every launch showed, and the one thing you could not do anything with. It is
now Emacs's `*scratch*`, except that ours persists: type immediately, and it is still there next launch.

This is the deliberate answer to what §4's naming-first rule costs. Naming-first is right for a *note* —
when you want to write something down you usually know what it is about, and if you don't, you are dumping
rather than filing — so the dump gets **one** well-known place instead of every note being capable of
namelessness. It is also the answer to the idea §4 keeps having to refuse (*"let the first line become the
name"*): the pressure that produces that idea is exactly this, and it now has somewhere to go.

### What other apps do, and what we took

| | |
|----|----|
| **Emacs `*scratch*`** | The reference. Not visiting a file; `C-x C-s` **prompts for a name and the buffer becomes that file** — saving is a *move*, not a copy. Vanilla Emacs does not persist it, which is why `persistent-scratch` exists. |
| **Heynote** | "A large persistent text buffer", one file in an app-owned dir. `Cmd+S` = *"move the current block to another (or new) buffer"* — filing part of the scratch out of it. |
| **JetBrains scratches** | Real files in a **reserved dir outside the project**, shown in their own tree node, never mixed into the project; `F6` moves one into the project. |
| **Tot** | Exactly 7 fixed dots, no names, no files. The constraint *is* the feature: zero decisions. |
| **Logseq / Roam / Obsidian daily notes** | No empty state because there is always *today's page*, appended to. |
| **Drafts, Raycast Notes, Stickies, VS Code hot exit** | Capture-first surfaces where text survives without ever being named. |

So: **one** scratch (Tot's and Heynote's discipline — "which scratch?" is a naming decision in disguise, and
the moment you want a second one you want a *note*, which this app makes trivial); **saving is a move**
(Emacs, Heynote, JetBrains all agree); and **the scratch lives outside the content tree** (JetBrains).
What we did *not* take: a first line that becomes a name (§4), and an inbox of `Untitled 3.md` (same).

### Where it lives, and why not in `/notes`

`/data/<app id>/scratch.md`, through the app's second volume binding (§2) — **not** in the knowledge base.
The scratch is words before anything has been decided about them, which is app-private data in the same
sense the state file is: not a note, named by nobody.

That is not tidiness, it is what makes *"the scratch cannot be renamed, deleted or collided with"* true **by
construction**. Inside `/notes` the same guarantee needed four separate guards — a refusal in `pathSchema`
(so `rename`/`remove` could not touch it), a filter in `list`, an exception to `save`'s `update: true`, and a
name the naming rules could never produce — and it would *still* have been permanently the newest note in a
recency-sorted list, with every autosave bumping `treeRevision` and rescanning the whole tree. Two of those
four were behavioural bugs, not chores. **A thing that is not a note should not be a path in the note
namespace.**

It is not reducer state either: the body bytes never enter state (§3), and that goes double for a buffer
people paste 40KB of JSON into — every commit would re-serialize it, broadcast it to every client, and push
it through sync.

### One machine, two instances

The scratch is driven by **the same buffer machine as a note** (`src/buffer.ts`), instantiated twice. Its IO
is injected, so the second instance is ~15 lines: `save` → `saveScratch`, `read` → `readScratch`.

The alternative was a third kind of *home* inside `BufferState` (`note` / `scratch` / `orphan`), and §1a‴ is
the reason not to: that machine is 290 lines of learned rules precisely because every new mode was a new
branch to remember at eight call sites. Two instances need none of them — every rule the machine keeps
(writes never overlap, a failed write stays dirty, a stale read is discarded, nothing replaces an unsettled
buffer) is a rule the scratch needs too, and the branches that do not apply to it are *unreachable* rather
than special-cased: it cannot be moved or deleted, so `moved`/`discard` are never called, and `create` means
"write and re-attach" rather than "make a new note".

Two consequences worth stating, because both are rules a reviewer will look for:

- **`openPath === null` means "the scratch is showing"**, and the GUI's own test for it is *"the note buffer
  holds nothing at all"* (`buffer.path === null && buffer.text === ''`) — which is exactly the old `blank`.
  That keeps the one case where the note buffer holds words with no path: a note deleted out from under it
  (§1a‴). Those words keep the screen until they land as a note of their own, rather than being shouldered
  aside by the scratch.
- **The editor is read-only until the scratch's text arrives** (a round trip after mount), and the initial
  focus waits for the same signal. Keystrokes typed over an unfinished read would be saved on top of the
  words being read — the one way a persistent scratch can lose data. A read that fails is *not* answered
  with an empty buffer for the same reason; the way back is the window-focus retry below.
- **And the same rule holds for every LATER read, which is where it was first got wrong.** Writing it for
  the mount read only left the more dangerous case open: a scratch that loaded once and then failed a
  re-read — after another window had written newer text — kept a stale buffer editable, and the next
  autosave put the stale text back over the newer one. **A read you did not get is not evidence that
  nothing changed**, so both reads go through one function and either failure makes the buffer read-only
  until a read succeeds. (`open` vs `reload` is then only about what the buffer holds: after a failed mount
  nothing is attached, and `reload` only ever replaces a clean *attached* buffer, so it would no-op
  forever.)
- **No watch.** A second window writing the same file is heard by re-reading on window focus (`reload` only
  ever replaces a CLEAN buffer, so it cannot land on top of unsaved words — and a dirty buffer is newer than
  the disk anyway). A capability stream just so one client can hear another is more machinery than
  app-private data is worth.

### Keeping something: three tiers, and the order is the rule

| | Gesture | Result |
|----|----|----|
| **Name it** | `Cmd+S` (or **Save as note…**) → name prompt → Return | `create` + `open`; the words **leave** the scratch |
| **Keep it, don't name it** | "Keep in today's note" | `journal` appends to `/journal/<date>.md`; the words leave the scratch |
| **Neither** | nothing | it stays, forever |

**The name is asked for at the moment of keeping, and nowhere else.** The scratch shows *only its content* —
the editor's other field is gone, not disabled — and the question *"what is this called"* appears in the
footer when, and only when, someone asks to keep it: `Cmd+S`, or the **Save as note…** button. The footer
swaps to a small text field in place, which is the idiom the tree's CRUD menu already uses (§5) and the only
kind of prompt available anyway — a sandboxed iframe has no `allow-modals`.

That is a change from the first cut, which reused the note's name field with the scratch showing. It was
wrong for the reason the whole feature exists: an empty name line sitting above the buffer is a field for a
file that does not exist, permanently asking the question the scratch is there to *defer*. Emacs's `*scratch*`
has no name line either — `C-x C-s` is where the name is asked for.

So `Cmd+S` has three answers on the scratch, and none of them invents a name: **no prompt yet** → open one;
**a name typed** → take it; **open but empty** → put the caret back in it. Return on an empty prompt is a
*cancel*, not a request for a nameless note (there is no such thing), and Esc cancels with the caret back at
the end of the words. Blur does **not** commit: clicking into the body is not a request to keep anything.

**One naming path, two inputs.** The prompt and the note's name field both go through `commitTitle`, so the
illegal-name rule, the "already exists" advisory and the three-answer failure handling (refused / did not
land / landed) cannot drift apart. The prompt is *derived from the draft* (`titleDraft !== null`) rather than
kept in a flag beside it — so every path that already drops a half-typed name (opening a note, creating one,
going back to the scratch) closes the prompt for free.

**And the advisory is not the authority.** It reads the listing, which can be empty (nothing has asked for
one yet) or stale, while `claimPath` in the reducer numbers rather than overwrites — so a name chosen at the
moment of filing can still be taken. Where the words actually went is then reported (*"a note called “Kyoto”
already existed — kept as “Kyoto 2”"*), the same thing `moveNote` says about a deduped rename. Found by
using it: asking for a name that existed silently produced `… 2`.

**A selection is the unit when there is one** (Heynote's move-a-block): a scratch accumulates several
unrelated things, and filing one of them must not file the other three. `splitSelection` is that rule, pure
and tested — no selection means the whole buffer.

**But the cut is applied to the LATEST text, not to the snapshot the offsets came from.** Filing is a round
trip — `create` even awaits a queue drain — and the user can type all the way through it: ⌘S pressed from the
body leaves focus there, which is exactly what the name-waits-in-the-field rule invites. Applying the
precomputed remainder then deletes those keystrokes, and they are in **neither** the note nor the scratch,
with the next autosave persisting the deletion.

Neither offsets nor content is safe on its own, which is what `cutKept` is for. Offsets alone describe a text
that may no longer exist. **Content alone cuts the first match, which is the wrong one when the kept words
appear twice** — select the second `todo`, type a character while the write is in flight, and searching would
remove the first, mangling an entry the gesture never touched. So the offsets are **mapped** through the edit
and then **verified**: the user's edit is confined to the span between the common prefix and the common suffix
of the two texts, so when that span does not touch the kept range, the range's new position is known exactly
(shifted if the edit was before it, unchanged if after), and the slice there is checked to still be the kept
words before anything is removed. Only an edit that overlaps the kept words falls back to content, and only
while that is unambiguous — one occurrence, or nothing is removed.

The read-modify-write also has no `await` inside it, so nothing can be typed into the middle of it.

And when the kept words cannot be identified at all, nothing is removed and the status says a copy stayed.
**Two copies are recoverable; a wrong cut is not**, so the ambiguous case resolves towards keeping too much.

**One keeping, however many times it is asked for.** Enter repeats while held and the journal button stays
clickable across the round trip, so two calls can read the same text before either has cut it — filing it
twice, as two numbered notes or the same entry appended twice. Same guard, same reason, as the Create row's
(§5): the second press is the same submission.

**The create lands before anything is cut.** A failure costs the gesture and nothing else, and the cut goes
through the buffer machine, so a remainder that fails to write stays dirty and on screen instead of
vanishing. This is §1a‴'s rule 2 applied to a new operation rather than re-learned.

**The date is the caller's**, not the reducer's: a procedure runs in the worker, where `new Date()` is UTC
and would file an evening entry under tomorrow. So `journal({ date, text })` takes the day as `YYYY-MM-DD`
(one spelling, checked — so the path is canonical by construction and cannot be steered) and the GUI reads
the user's clock. Folders this app creates for itself are lowercase: `/journal`.

**An append accumulates, so it rides the claim chain** (`serially`, §3) — and so does **every other
write this app makes into the KB**, `save` included. The first entry of a day creates the note with
`exclusive: true`, which settles who owns the name — but every entry after that is an `appendFile`, and
that is **read-merge-write** in the volume (`getBlob`, concat, `putBlob`), so anything that writes *inside*
one of those loses. Two appends lose an entry; **a `save` losing inside one is worse**: the append reads the
old body, the save writes the edited one, the append's write lands last, and the user's typing is gone from
disk while their buffer is **clean** — its save succeeded — so nothing ever retries it. Silent and
unrecoverable is the worst shape a loss can have.

Not hypothetical, and not out-of-model: procedures run *off* the kernel's queue and `journal` is `both`, so
the agent filing something while the user keeps a scratch entry — or edits today's journal note — is
precisely the interleaving §8 defends.

One chain, and the **same** one as `claimPath`'s, deliberately: these are all writes into one namespace, so a
create taking a name, a body write and an append to that name have to be ordered against each other and not
just against their own kind (§1b's atomic-loses-to-non-atomic case). One level still — neither `save` nor
`journal` calls `claimPath`. And the narrower version of this fix — *serialize saves whose path looks like a
journal note* — is the wrong shape: the journal note is not special as a **file**, it is special because we
do a read-modify-write on it, so the rule belongs to the operation and not to a spelling. A rule attached to
a spelling is one more thing to remember at the next call site.

**What ordering does not do**, stated plainly: it cannot make an appended entry survive a full-body `save`
that was composed before the append landed. The buffer's text never contained the entry, so writing it erases
it — ordered or not. The watch mitigates it (an external change re-reads the open note) *unless the buffer is
dirty* — i.e. everywhere except while the user is mid-word in that exact note, which is the one moment this
happens in.

So the write carries a **precondition**: `save({ path, text, base })` writes only over `base`, the body the
buffer last agreed with disk about. That is the answer every editor gives this — Emacs checks the visited
file's modtime before saving and asks; VS Code compares an etag and offers *Compare* / *Overwrite*; HTTP
spells it `If-Match`. A lock is not the answer, and nor is a CRDT: there is one user here, and the question
"whose words survive" has to reach them.

Three decisions inside that:

- **Compared on the body, not on an mtime.** Both backends stamp at millisecond granularity
  (`storage.idb.ts`, `storage.fs.ts`) and this interleaving is an in-memory append and a save inside one
  millisecond. VS Code's mtime+size etag has a standing data-loss bug for exactly this reason
  (microsoft/vscode#119002); git met it as *racily clean* and falls back to comparing content. `base` is
  free to carry — the buffer holds the text it read anyway — so there is no hash to compute and none to keep.
- **The check is the app's, not `packages/fs`'.** §1b's rule again: a promise whose strength varied per
  backend is not one a call site can reason about. None is needed here, because the read and the write ride
  `serially` with every other write this app makes — one act against *our* writers, which is the pair that
  produces this. Outside the chain is every writer that does not ride it: another app instance, and — in this
  very process — the sync engine's apply, which lands through the storage journal (`applyJournaled`) *below*
  `Volume.writeFile`, so a `writeFile` precondition would not cover that one either; the two writers never
  meet at that layer. A pull inside the read-then-write gap is therefore a stated window, as it is for
  `claimPath` — closing it means a lock the sync applier takes, or a compare-and-swap in the journal, which is
  a permanent mechanism bought for a millisecond.
- **A refusal is a value, not a throw.** `save` comes back `{ wrote: false, disk }` carrying what is there
  now. Nothing can be decided without those bytes, and reading them again would be a second guess at a
  moving target.

**Merged when it can be, asked when it cannot.** A refusal that always reached the user would be a bad trade
for the case that produces it: the agent APPENDS, so "reload or overwrite" would make the user throw away
either their sentence or the entry they just kept, for a change that conflicts with nothing. A pure append is
exactly recognisable — the body on disk still starts with `base` — and its merge is exactly determined
(`mergeAppend`): the user's text, then whatever arrived after the base. The buffer takes it and writes again,
conditional on *that* body, so a second append cannot be lost either. Anything less obvious is not
reconstructed: it becomes `conflict`, the buffer stops writing, and the editor shows the two answers —
**keep mine** (write with no base) or **use the file** (re-read, and only if that read lands). No diff, no
hunks, no three-way merge.

Not pushed down into `packages/fs` either: an atomic append means something different on every backend
(`O_APPEND` here, a transaction there), which is exactly the per-backend promise §1b decided a call site
cannot reason about. Ordering our own writes is cheap; the window that remains is another *process*, as it is
for every claim.

### The way back has to be VISIBLE

⌘J is the fast way back to the scratch; it cannot be the only way, because a shortcut you have to already
know is not an affordance. So the scratch is **a row pinned into both surfaces that show the listing** — the
dropdown under the bar, and the docked pane above the tree — as one element, exactly like the Create row
(§5), so a click and the key can never come to mean different things.

A row rather than another glyph in the bar, for three reasons that are really one — **only a row can carry
state**:

- It is the way back, **seen** rather than remembered.
- It says **what is in there**: the first line, or *empty*. So a scratch with words waiting is visible while
  a note is open, and "is there anything in my scratch?" is answered without going there. A button cannot
  do that.
- It carries **⌘J**, so the visible affordance is where the shortcut is learned — the convention every
  command palette already uses. The row teaches the key it replaces.

And it is bold (`data-open`) when the scratch is the current place, which is what makes it read as a *place*
in the list rather than a command.

**Deliberately outside the keyboard row set.** `rows`' indices are the filtered notes plus the Create row,
and the scratch is not a search result: arrowing through matches must not stop on it, Enter on an empty query
must still open the newest *note*, and ⌘J is already its key. Which also means the index arithmetic the
palette got wrong before (§5: "creating belongs to an empty result set, never to a missing index") was not
touched to add this. **Pinned, not filtered**, for the same reason: a place does not match a query. Typing
`rate` leaves the row where it is, above the one note that matched.

The pane's default is closed and localStorage is unavailable in frieren's sandboxed iframe, so the dropdown
is the surface that can be relied on — and it is the one every *deliberate* way out of the scratch already
passes through (⌘O, or clicking the field). The footer stays as it is: it says what the surface you are
**on** is; the row is how you get back to it.

### The agent's half

`readScratch` is `both` — *"what's in my scratch?"* is a fair question, and `openPath: null` already tells
the agent that is what the user is looking at. `saveScratch` is **gui-only**: overwriting the whole buffer
could erase words the user has not filed yet, and `journal`/`create` are the ways to move them somewhere
permanent. `journal` is `both`, because *"note this down"* is exactly what it is for (§1's on-request rule).

<a id="agent"></a>

## 7 · The agent (TUI) interface

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
| `create`, `save`, `rename`, `mkdir` | both | Available, but the agent usually writes files directly. `create` takes the **title** — nothing is derived from the body (§4). |
| `importNotes` | both | Bulk write, merging into the KB and never overwriting (§10). The agent can use it to land a batch it fetched; the GUI uses it for dropped vaults. |
| `list` | both | Fresh listing on demand — the agent's view of the KB is the filesystem, never cached state. |
| `newNote` | both | Closes the open note and shows the scratch (§6). Harmless; mostly GUI-driven. |
| `readNote` | both | Convenience; the agent can also read the file directly. |
| `remove` | **gui** | Destructive. `/notes` is the user's — the agent never deletes user notes blindly (mirrors `app-code`'s gui-only `remove`). |

<a id="scope-v1"></a>

## 8 · Scope & non-goals

**In:** a name field over a body (the name IS the filename); the bar (search-or-create + docked-tree
toggle) + derived listing + path-aware filter; **nested folders** (recursive listing, `.md` default with `.txt` still read); human
filenames; debounced autosave + flush-on-transition; a docked file tree with full CRUD (create note /
create folder / rename / move by drag / delete) and open-on-select; **drop-a-zip vault import** (§10); live
re-read of the open note on external edits; a structural watch so the tree tracks the disk; **the persistent
scratch buffer, and the two ways to keep something out of it** (§6); the agent TUI above.

**Out (deferred, not one-way doors):**

- **AI filenames**; **content search** in the search field (path/title only); **rich text**; **tags UI**;
  **`[[wikilink]]` navigation and backlinks** (imported links are preserved verbatim, so this can land
  later with no migration — see the reasoning in §10); **resume-where-you-left-off** (reopening on the
  scratch is intentional — §6).
- **More than one scratch** (Tot's seven, JetBrains' five). "Which scratch?" is a naming decision in
  disguise, and the moment you want a second one you want a note, which §6's first tier makes one gesture.
- **Blocks inside the scratch** (Heynote's unit). A selection is ours, and it needs no structure in the
  file — so the scratch stays plain text that any other tool can read.

### The concurrency model, stated as a boundary

Almost every rule in §3 exists because two writers disagreed, so it is worth writing down **which two
writers this app actually has** — the answer decides which findings are defects and which are hypotheses.

**In the model, and defended:**

- **The user and the agent, interleaved.** The agent renames, writes and creates while the user types. This is
  the real case and it is the origin of `movedFrom`, the buffer machine's generations, `claimPath`, and the
  `deleted`/`moved` commit edges. Every one of those was a reproduced defect.
- **The disk changing underneath, from outside the app.** An editor elsewhere, a sync daemon, `rm` in a
  terminal. Hence: watches, `update: true` / `parents: false`, per-backend `putBlob` ENOENT, the inode checks
  in `storage.fs`, `exclusive` writes. A write to something that is gone is a failure, not a no-op.
- **A body that changed under unsaved words.** The agent's append, an edit from Files, a sync pull — all one
  case, and the watch cannot answer it, because the buffer is dirty exactly when it matters. Hence `save`'s
  `base` precondition, `mergeAppend`, and the buffer's `conflict` (§1b). A sync-applied write arrives as an
  ordinary `volume.watch` event already tagged `source: 'remote'`, so it needs nothing of its own: the sync
  engine resolves its own replicas, and what reaches the note here is just another external writer — one
  `base` catches in the shape a pull actually has (it lands, and the save composed before it is refused).
- **The app racing itself.** Autosave against open, flush against rename, import against the tree's drag. These
  are ordered by construction: one flush chain, one claim chain, a sequential import loop.

**Out of the model, deliberately:**

- **Two clients mutating the same note inside one round trip.** There is one GUI per app window and one
  sequential agent; a second GUI editing the *same* note in the same millisecond is not a shape this product
  has. Where a rule can be honoured for free we honour it (the reducer answers containment questions from
  current state, not from a procedure's snapshot — that is cheaper *and* more correct; `save`'s precondition
  happens to cover a second window too, because it is a fact about the file rather than about who wrote it).
  Where it would cost a new mechanism — reservations, cross-client locks, undoing a local discard that a
  concurrent move made unnecessary — we do not pay: the mechanism would be permanent.
- **Merging two real edits.** A conflict is shown, never resolved: only an append is merged, because only an
  append can be reconstructed from what the buffer already knows. Diffing the two versions, offering hunks, or
  keeping both as `… (conflicted copy)` are all a second editor's worth of product, and the honest answer for
  one user with two versions of one note is to be asked which one they meant.
- **Emulating primitives the platform lacks.** POSIX has no atomic no-replace rename and Node reaches neither
  `renameat2` nor `renamex_np`, so the native backend looks before it renames and says so — no `link` +
  `unlink` (which stops being a move, and on macOS follows a symlink), and no in-process lock either, because
  the writers a real directory is shared with are other processes. Pushing a guarantee down is worth it when
  something down there can really keep it — `atomicCreate` could, and a transaction can (#330); a lock over
  somebody else's filesystem cannot.

If Notes ever gains real multi-client editing, the boundary moves and the deferred interleavings come back —
tracked as an issue rather than as unreachable code.

Tolerate old persisted shapes (docs/app.md §3): new `NotesState`/`Entry` fields must be optional — `init`
is not re-merged into already-persisted state. `treeRevision` was added this way.

<a id="runtime"></a>

## 9 · Agent-runtime touch-points (out of this package)

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

## 10 · Obsidian interop — what we take, and what we deliberately don't

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
- **The vault root is read from the archive's LAYOUT, not from the notes we kept.** Both of the obvious
  shortcuts are wrong in opposite directions: counting *every* member sees macOS's `__MACOSX/` beside the
  vault folder as a second root and leaves the vault a level too deep, while counting *only kept notes* sees
  a contents-zip's `.obsidian/` disappear and mistakes the user's own `Trips/` for packaging — flattening a
  folder they made, and with it any relative links. So every member is evidence **except OS packaging**, and
  the `Screen` witnesses it as the archive streams past, bounded to one remembered name (two different tops
  is already the answer). "Except OS packaging" has to be asked as exactly that question, too: coding it as
  "everything except the members we called junk" swept conflicted copies in with the zipper's debris, so a
  contents-zip with one root-level `Kyoto (conflicted copy).md` beside `Trips/` stripped the user's folder
  anyway. **Which members are interesting and which members describe the shape are different questions.** And a root is only stripped when the whole archive was **seen**: a drop that hit a
  ceiling was abandoned mid-stream, so "every member shares this top folder" is a claim about the prefix we
  read — the entry that would disprove it may be one of the ones we never looked at. A partial import
  therefore keeps the archive's own shape, one level deeper than a whole one (visible, and a drag from being
  fixed) rather than flattening a folder the user made. **Evidence gathered up to the point you stopped is
  evidence about the part you saw.**
- **Not ported at all:** canvas, bases, Dataview/Templater code, plugins, `.obsidian` config. Their text is
  kept as-is where it lives inside a note; nothing is rewritten.
