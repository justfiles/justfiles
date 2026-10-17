# app-paint: persistent stroke-based drawing — design

Status: implemented. The drawing survives reload, stored compactly as a replayable operation log
and autosaved to the app's data volume.

Selection of individual strokes and real-time co-op are **explicitly deferred** —
but the data model is shaped so neither needs a format break later.

## 1. Where things stand

The drawing is pure raster and nothing about it is persisted:

- `gui.tsx` draws immediate-mode onto one `<canvas>` using `bitmap.ts`
  (`stampLine` Bresenham, `drawRect`, `drawEllipse`, `floodFill`, `fill`). The
  pixel look is locked in by `imageSmoothingEnabled = false` +
  `imageRendering: pixelated`.
- Undo/redo are full `ImageData` framebuffers in React refs (`UNDO_LIMIT = 30`),
  lost on unmount.
- Persisted app state (`PaintState`) is tiny and semantic only: `tool`, `size`,
  `color`, `lastSavedPath`, `lastError`.
- The only way pixels leave a session is `save` → rasterize to PNG → base64
  through the `save` action → `volume.writeFile`.

Two storage facts drive the design:

- **Kernel app state** is written to `/state/<appId>.json` on every handler
  dispatch (`kernel.ts`). The kernel deliberately keeps file *content* out of it
  (queries don't persist — "what keeps Files' readFile from ballooning
  state"). **Drawing data must not live in `/state`.**
- **Per-app data volume.** `volume({ scopes: [] })` — what paint already
  requests — binds the default `'app'` chroot at `/data/<appId>`
  (`volume/index.ts`, `dev-server.ts`). Uninstall wipes both `/state/<id>.json`
  and `/data/<id>`. **`/data/justfiles.paint/` is the lifecycle-correct home for
  autosaved/working drawing data, and needs no new scope.**

  (Note a current quirk to clean up separately: paint's `save` writes
  `/Paint/x.png`, which resolves under `/data/justfiles.paint/Paint/...` — sandboxed,
  not visible in Files.)

## 2. Why an operation log, not pixels and not an element scene

Borrowing from Excalidraw (scene = ordered array of `id`'d elements; `freedraw`
= `points` relative to origin; version-based deltas; tombstone deletes), but
**not** wholesale: Excalidraw is non-destructive vector, where every element
renders independently. MS Paint is **destructive raster** — flood fill and
eraser depend on the pixels already on the canvas. An independent-element scene
can't represent "fill whatever region happens to be bounded here."

So the model is an **ordered operation log (display list)**. The canvas is a
pure function of replaying the ops in order with smoothing off — byte-for-byte
the look we have today, reusing the existing `bitmap.ts` primitives.

This gives us, for free:

- **Pixel fidelity** — replay *is* the current draw path.
- **Correct `fill`/`eraser`** — they're order-dependent ops; deterministic
  replay reproduces them.
- **Compactness + delta transfer** — ops are immutable once committed at
  pointer-up; a "delta" is just the ops appended since some index.
- **Cheap undo/redo** — a cursor into the log, not 30 framebuffers.
- **Selection later** — each op has a stable `id`; select = pick an op, re-replay.

## 3. Data model (v1)

```ts
type PaintDoc = {
	type: 'justfiles/paint'
	version: 1
	width: number          // 800
	height: number         // 600
	background: string     // '#ffffff'
	ops: Op[]              // ordered; replay top→bottom === canvas
}

type Op =
	| { id: string; kind: 'stroke'; tool: 'pencil' | 'eraser'; size: Size; color: string; points: number[] }  // flat [x0,y0,x1,y1,…], integer px
	| { id: string; kind: 'line';    size: Size; color: string; x0: number; y0: number; x1: number; y1: number }
	| { id: string; kind: 'rect';    size: Size; color: string; x0: number; y0: number; x1: number; y1: number }
	| { id: string; kind: 'ellipse'; size: Size; color: string; x0: number; y0: number; x1: number; y1: number }
	| { id: string; kind: 'fill';    color: string; x: number; y: number }
	| { id: string; kind: 'clear';   color: string }   // the "New" action
```

Deliberately minimal:

- **Keep `id` per op.** Cheap, and it's the only thing deferred selection and
  deferred co-op both need. Keep ops as discrete structured records (never
  flatten the whole drawing into one blob).
- **Dropped for v1:** `version` / `versionNonce` / `isDeleted`. Those exist only
  for CRDT reconciliation; adding them now pre-pays for co-op we aren't
  building. They slot in cleanly when co-op arrives (§7).
- **Points** are integer pixels (canvas is pixelated anyway). Pointer-move
  coalescing (`getCoalescedEvents`) already feeds the polyline; optionally carry
  a parallel `pressures: number[]` later for brush dynamics — additive, no break.

### Encoding boundary (JSON now, swappable later)

All serialization goes through exactly one pair:

```ts
function encode(doc: PaintDoc): Uint8Array   // JSON for now — cat-able while debugging
function decode(bytes: Uint8Array): PaintDoc // validates type + version, else fresh doc
```

Every storage call site uses only these. The `version` field in the envelope
means a future binary format (CBOR/MsgPack) is a new version + a one-file
change. No call site knows the wire format.

## 4. Undo / redo

- The **persisted doc holds only the committed, visible ops** — exactly what's on
  the canvas.
- The **undo/redo cursor lives in memory**, not on disk. MS Paint doesn't
  resurrect undo history across reload either; this keeps the format clean.
- New op after an undo truncates the redo tail.
- Undo = drop the trailing op (or move cursor back) and re-replay; redo = the
  reverse. Re-replay of a few hundred ops on 800×600 is sub-millisecond, so no
  layer/snapshot caching is needed for v1.

## 5. Storage layout & autosave

```
/data/justfiles.paint/           ← app chroot (scopes: [])
	drafts/<docId>.json          ← autosaved working doc (the "cache/tmp" answer)
```

- **Kernel `/state/app-paint.json` keeps only pointer state**: `currentDocId`,
  `tool`, `size`, `color`, `lastError`. The drawing never goes through the
  action/state path — no state ballooning.
- **Autosave trigger:** on op-commit (pointer-up / fill / clear), *not* on every
  pointer-move.
- **Debounced write**, following Frieren's OS persistence pattern
  (`apps/frieren/src/os/effects.ts`): trailing-edge debounce ~300 ms,
  `maxWait` ~2 s, plus a string-equality guard to suppress no-op writes.
- Because committed ops are immutable, autosave can later become an *append*
  (NDJSON) that flushes only new ops — but start with whole-doc JSON writes;
  upgrade only if write size bites.

## 6. Save / open / edit real files — deferred (depends on shared folders)

Out of scope for v1, recorded so the model doesn't drift:

- **Source of truth becomes the op-doc**; "Export PNG" stays as a one-way
  rasterize (today's `canvasToPngBase64`), no longer the persistence path.
- **Save to a user-visible file** needs a host capability we're deliberately
  **deferring**: shared user folders (`/desktop`, `/documents`, …) that all apps
  can read/write. That's a host-level scope + permission + ownership design, its
  own project — not coupled to draft persistence. Drafts in `/data/justfiles.paint/`
  need none of it.
- When that lands: "Save"/"Open" read/write the `PaintDoc` JSON to the user
  volume; the `/data` draft becomes the scratch buffer for unsaved/new docs
  (mirrors `worker/scratch.ts`'s scratch-file → rename-into-place flow).

## 7. Co-op / CRDT — deferred, designed-for

The op-log is already CRDT-shaped (stable `id`, append-only, no positional
mutation). When co-op is wanted:

- Add `version` / `versionNonce` / `isDeleted` to `Op`; reconcile Excalidraw-style
  (broadcast ops past peer's last index; periodic full sync; tombstone deletes).
- Or wrap `ops` in a yjs `Y.Array` for conflict-free concurrent append — the
  model is unchanged, only the transport. Don't pay for it now.

## 8. GUI-local state

The drawing's working state (op log + undo cursor + debounced autosave) is GUI-local, not kernel
state. The standalone app carries the small synchronous store primitive it needs in `src/state.ts`;
the app framework remains responsible only for the durable reducer and host capabilities.

## 9. Phasing

1. **Model swap (local only).** Replace the live canvas with replay-from-op-log;
   op-log-based undo/redo. Pure refactor: no persistence, no visual change.
   Verify with `pnpm run verify:ui`.
2. **Add GUI-local state** — store + reducer for the op log, debounced persist effect to
   `/data/justfiles.paint/drafts/<docId>.json`;
   `/state` holds only pointer state. Reload resumes the drawing.
3. **Keep the persistence helper local** until another standalone consumer confirms the same shape.
4. **(Deferred) Stroke selection** — bbox highlight, delete/recolor via re-replay.
5. **(Deferred) Save/Open real files** — gated on the shared-user-folders host
   capability.
6. **(Deferred) Co-op** — op-deltas over the socket, then yjs if needed.

## Decisions locked

- Shared user folders (`/desktop`, `/documents`): **deferred**; drafts use the
  existing `/data/justfiles.paint/` app scope.
- Selection: **deferred**, but `id`-per-op kept so it needs no format break.
- On-disk encoding: **JSON now**, isolated behind `encode`/`decode` + a `version`
  field for a clean later swap.
- GUI state: keep the synchronous store and debounced persistence helper local to Paint.

## References

- Excalidraw JSON schema — https://docs.excalidraw.com/docs/codebase/json-schema
- freedraw points/pressures (PR #3512) — https://github.com/excalidraw/excalidraw/pull/3512
- scene serialization — https://deepwiki.com/excalidraw/excalidraw/6.2-scene-serialization-and-file-formats
- collaboration / version-based deltas — https://deepwiki.com/excalidraw/excalidraw/7-collaboration-system
- CRDT RFC #3537 — https://github.com/excalidraw/excalidraw/issues/3537
