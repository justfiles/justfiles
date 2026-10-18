# 3 · Undo / redo & history

> Status: **design — deepest of the three.** The affordance ("agent did this —
> undo") is the small part. The real question, as raised: **does undo
> fundamentally change our data structure?** Do we keep one copy of state per app,
> or a timeline / action log / CRDT? This doc works through the options against
> frieren's actual state model before any code.

## What we have today

Two distinct kinds of mutable state, in two places:

1. **Reducer state** — one **authoritative snapshot per app**, in memory, written
   through to `/state/<id>.json` on every commit, with a monotonic `seq`
   (`packages/app/kernel.state.ts`). *Not* an event log — the previous value is
   overwritten. `seq` is recomputed from zero on boot.
2. **User data** — arbitrary files in `/data/<id>/`, written via the `volume`
   capability (paint bitmaps, note bodies, code). This lives on a
   **content-addressed blob layer** (`InodeMeta.contentHash`, lazy hydration).

Two things follow immediately:

- **Undo must cover both.** The interesting user work usually lives in the
  *data files* (the painting, the note body), not the little reducer snapshot.
  An undo model that only rewinds `/state/<id>.json` undoes almost nothing.
- **We already have `actor`.** Commands thread an `actor` field end-to-end
  (`kernel.command.ts`: `schedule(appId, command, actor)`, delivered results
  carry it). So "who did this — the user or the agent" is *already* capturable —
  the substrate for **selective, per-actor undo** is half-built.

There is also **OS-level state** (`os-state.json`: window layout, focus). Undo
there is nice-to-have; app data undo is the point. Scope this doc to per-app
undo.

## The options

### A. Snapshot timeline (memento)

Keep the last N committed states (and referenced data) as restorable checkpoints.

- **Pro:** trivial against today's model — the kernel already commits atomically
  with a `seq`, so it can checkpoint at each commit for free. **Data files are
  cheap to snapshot because the volume is content-addressed** — a checkpoint of a
  file is just its `contentHash`, not a copy of the bytes. This is the crucial
  fit: a checkpoint = `{ stateSeq, { path → contentHash } }`, all pointers.
- **Con:** coarse (whole-state granularity); retention policy needed; large
  binary edits still cost a blob per distinct version (fine — that's what
  content-addressing is for).

### B. Command + inverse (classic undo stack)

Each action declares how to invert itself; undo pushes the inverse.

- **Pro:** precise, minimal storage.
- **Con:** every action author must write a correct inverse — a real burden on
  the app API. Worse, **effects** (a `writeFile`, an `ai` call) need
  read-before-write to capture the inverse, which the current one-way
  transition→command→result flow doesn't capture. Invasive.

### C. Event sourcing (action log)

Persist the action stream; `state = fold(actions)`; undo = truncate + replay.

- **Pro:** time-travel and history for free; **attribution for free** (actions
  carry `actor`); aligns with the reducer being a pure fold.
- **Con, fatal in pure form:** transitions emit **effects** — `writeFile`, AI
  calls, email sends (`kernel.command.ts`). You **cannot** safely replay an AI
  call or re-send an email, and replaying `writeFile` re-touches the volume.
  Effects are non-deterministic and/or externally visible. Pure event sourcing
  breaks on the capability seam. Only viable as **snapshot + bounded log** (log
  since last snapshot, never replaying effects — restore the snapshot instead).

### D. CRDT (Yjs / Loro / Automerge)

Make state a CRDT document; get merge + a selective undo manager.

- **Why it's tempting here specifically:** we are **multi-writer** (user + agent)
  **and multi-device** (browser + DO, synced volume). CRDTs are the principled
  answer to both. And Yjs's `UndoManager` is **selective and per-origin**: you
  tag each change with an origin and scope undo to specific origins
  (`trackedOrigins`), merging rapid edits within a `captureTimeout` (~500ms).
  Map `origin = actor` and you get **"undo the agent's last change" without
  touching the user's edits** — exactly the two-actor affordance, for free, and
  it composes with cross-device merge.
- **Con:** adopting a CRDT as the state substrate is a big change from plain-JSON
  snapshots and the current reducer/commit model. And **data files aren't
  CRDTs** — a paint bitmap or opaque blob doesn't merge. CRDT undo shines for
  *structured/text* documents, not for the whole system.

## The multi-writer / multi-device wrinkle (why linear global undo is wrong)

With one actor on one device, `⌘Z` = "undo the last thing that happened."
Frieren breaks both assumptions:

- **Two actors:** if the agent edits a file while you edit another, a global
  "undo last change" undoes the *agent's* work when you meant *yours*. Undo must
  be **selective** — undo *my* last change, or explicitly *the agent's* last
  change.
- **Multi-device:** a linear global history can't survive concurrent edits from
  two replicas merging. This is precisely the collaborative-undo problem, and the
  known-good answer is **per-origin selective undo** (Yjs) rather than a single
  global stack.

So whatever we build, the history is **partitioned by actor/scope**, not one
global timeline. `actor` (already present) is the partition key.

## Recommendation: layered, not a rewrite

Do **not** convert the system to a CRDT now. Instead:

1. **Scope undo per app.** Each app owns its history. Global desktop undo is
   confusing and rarely wanted. (OS-layout undo can come later, separately.)
2. **Checkpoints over the content-addressed volume (option A as the base).** A
   checkpoint = `{ appId, seq, actor, dataHashes: { path → contentHash }, ts }`.
   Cheap because bytes are shared by hash. The kernel already has the atomic
   commit point (`stateStore.commit`) to hook, and the `seq` to key on.
   - Apps declare which `/data` paths are **documents** worth checkpointing
     (a small manifest field), so we snapshot the painting, not scratch files.
   - Undo/redo = restore a checkpoint (state snapshot + re-point the declared
     data paths to their checkpointed hashes). No effect replay.
3. **Attribute every checkpoint with `actor`.** Thread the existing `actor`
   through to the checkpoint so **selective undo** ("undo Frieren's last change")
   is possible from day one, even before any CRDT.
4. **Merge granularity like Yjs.** Coalesce rapid same-actor edits within a
   time-gap (Yjs uses ~500ms; `stopCapturing()` to force a boundary) so undo
   steps are meaningful, not per-keystroke.
5. **CRDT per-app, where it earns it.** For a genuine collaborative *document*
   editor (structured text/data that both actors edit concurrently), adopt a CRDT
   *inside that app* and use its native selective undo. Do **not** impose it
   system-wide. Frieren stays snapshot-based; individual document apps can be
   CRDT-backed under the same checkpoint umbrella.

This reuses infrastructure we already have (content-addressed blobs, atomic
commit + `seq`, the `actor` field) and defers the expensive substrate change to
the one place it pays off.

## Effects: undo vs. "cannot undo"

Some actions have **external** effects — send email, call the model, hit an
integration. These are **not undoable** in the restore-a-checkpoint sense. The
history must **classify** each step:

- **Reversible** (local state + volume writes) → real undo (restore checkpoint).
- **Irreversible** (external effect) → recorded in history for *provenance* and
  possibly a compensating action ("unsend"? usually not), but flagged as
  not-undoable rather than silently rewound.

The capability that ran the command is the natural place to declare
reversibility (it already knows if it's `volume` vs. `ai`/`integrations`).

## The affordance (the small part)

Once history is partitioned by actor and checkpointed:

- Standard `⌘Z` / `⌘⇧Z` within the focused app → undo/redo *my* last change.
- A distinct, explicit **"undo Frieren's last change"** (selective, per-actor) —
  surfaced where agent activity is shown (transcript / a room's activity log).
- Subtle attribution in the GUI when a change was agent-initiated (README
  principle 3: the GUI already re-renders; this just labels *who*).

## Open questions

- **Retention & storage.** How many checkpoints per app / how long? Content
  addressing makes bytes cheap, but the checkpoint index still grows.
- **Redo after divergence.** After a selective undo, what invalidates the redo
  stack when a *different* actor makes a new change? (Yjs has semantics here worth
  copying.)
- **Is undo history synced or device-local?** Most systems keep undo local to a
  session/device. Syncing it is possible (checkpoints are just hashes + JSON) but
  raises "undo something that happened on another device" questions. Lean
  device-local first.
- **Batch/transaction boundaries.** A procedure like notes' `create` fans out
  several commands — is that one undo step or several? (Argues for explicit
  transaction grouping, like Yjs `captureTimeout` / `stopCapturing`.)
- **Does OS-level state (windows/rooms) get undo** eventually, and does agent
  reorganization of rooms (doc 2) go through the same history?
