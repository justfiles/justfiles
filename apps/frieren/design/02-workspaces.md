# 2 · Workspaces & context switching

> Status: **design — exploratory.** A layer *above* the window model
> (`src/os/state.ts`). Additive: the default is one implicit workspace, so
> shipping without it costs nothing. This doc surveys proven systems, then
> distills a frieren-native model whose differentiator is a **resident agent per
> room**.

## The problem

Today there is one flat desktop: `windows`, `openOrder`, `focusStack`, one global
agent (`os/state.ts`). Everything you're doing — and everything the agent knows —
lives in a single undifferentiated space. Real work is many tasks; switching
between them means manually hiding/showing windows and re-explaining context to
the agent every time.

We want **context switching as a first-class feature**: switch the whole scene —
windows *and* agent context — in one gesture.

## Research: how powerful systems do it

A survey of window/workspace models worth stealing from.

| System | Model | What to steal | What to avoid |
|--------|-------|---------------|---------------|
| **macOS Spaces + Mission Control** | Fixed set of full-screen spaces; zoom-out overview to see/move windows. | The **overview** as the switcher + spatial map. | Spaces are app-agnostic; no notion of a task. Fiddly to reorganize. |
| **GNOME (Activities + dynamic workspaces)** | **Dynamic** workspaces: created on demand, always one empty at the end, destroyed when emptied. Activities overview is search + overview fused. | **Dynamic create/destroy** (no "manage workspaces" chore) and **overview = search + spatial map fused** — ties straight into our omnibar. | Vertical-only strip can feel rigid. |
| **i3 / sway** | Named/numbered workspaces; deterministic **tiling**; keyboard-first. | **Named** workspaces (a workspace *means* something) and **deterministic tiling** (an agent can place windows reproducibly). | Bare, manual; no concept of state beyond layout. |
| **niri (scrollable tiling)** | Infinite horizontal strip of columns; per-monitor workspaces; **zoom-out Overview** to see/drag windows across workspaces (touchpad/hot-corner/keys). | **Scrollable space** (no "which workspace is it on" bookkeeping) + a first-class **Overview** gesture. | Scroll model is unfamiliar to non-power users. |
| **tmux sessions** | Named, persistent sessions you attach/detach; survive across connections. | **Named, persistent, resumable** task contexts — the closest analog to "a room I return to." | Text-only; no spatial/visual layer. |
| **Arc Spaces / browser profiles** | Spaces bundle tabs + profile + theme per project/context. | **Bundle-per-project** (tabs↔windows, profile↔agent context). Visual identity per space aids memory. | Space switching can lose you if identity is weak. |

### Distilled principles

1. **Dynamic, not managed** (GNOME/niri): rooms are created on demand and reaped
   when empty. No "configure your workspaces" screen.
2. **Named/meaningful** (i3/tmux/Arc): a room stands for a *task* ("Q3 report"),
   not a number. The agent can name them.
3. **Overview is the switcher** (Mission Control/GNOME/niri): one zoom-out
   gesture to see everything, switch, and drag windows between rooms. It doubles
   as the "what's running" surface the omnibar deferred (doc 1).
4. **Persistent & resumable** (tmux/Arc): a room and its context survive restart
   and sync across devices.
5. **Deterministic layout helps the second actor** (i3/niri): when the agent
   places a window, tiling/slots make it reproducible where free-float does not.

## The frieren model: task-rooms with a resident agent

None of the surveyed systems have a second actor. That's our differentiator:

> A **workspace is a task-room**: a bundle of windows + focus + **its own agent
> thread/context**. Switching rooms swaps the scene *and* the agent's working
> memory. The agent in the "Q3 report" room knows it's the Q3 report and doesn't
> drag unrelated context in.

This is the single biggest agent-UX win in the redesign — better than any
layout change — because scoping context is exactly what makes an agent useful
per task instead of a muddled global assistant.

### Data model (sketch, above `os/state.ts`)

Two viable shapes:

**A. Per-workspace window maps** (workspace owns its windows):

```ts
type Workspace = {
	id: string
	name: string            // agent- or user-named; "" until named
	windows: Record<string, OsWindow>
	openOrder: string[]
	focusStack: string[]
	agentThreadId: string   // this room's agent context
}
type OsState = {
	version: 2
	booted: boolean
	workspaces: Record<string, Workspace>
	workspaceOrder: string[]
	activeWorkspaceId: string
}
```

**B. Flat windows tagged with `workspaceId`** (windows stay global, filtered by
active room). Less churn to the reducer; but focus/order become per-room views
that must be derived. Prefer **A** — it keeps each room self-contained, matches
how the reducer already nests window records, and makes "close a room" trivial.

Either way: **the agent session must not be a hard singleton.** Key it by
`agentThreadId` so a room carries its own thread. (This is the one thing doc 1's
"ship the global agent first" must not foreclose — see README principle 3.)

- The **soul** (`/system/soul.md`) stays shared — same persona everywhere.
- The **working context/thread** is per-room. Where threads persist and how they
  relate to the synced volume is an open question below.

### Dynamic lifecycle

- New room created on demand: from the omnibar ("New workspace"), by dragging a
  window out in the overview (niri), or **by the agent** ("set up a room for the
  Q3 report" → agent opens the relevant apps in a fresh room and names it).
- Always one empty room available (GNOME); empty rooms are reaped.
- Rooms are **named** — by the user, or inferred by the agent from what's in them.

### The overview

The zoom-out overview (Mission Control / GNOME / niri) is the switcher **and** the
"what's running" surface doc 1 deferred:

- One gesture (keyboard, hot corner, or trackpad swipe) zooms out to a spatial
  map of rooms and their windows.
- Drag windows between rooms; drop into a new room.
- Fused with omnibar search (GNOME Activities): start typing in the overview to
  filter/launch. This unifies "switch room", "find window", and "launch app"
  into one surface — the omnibar and the overview become two zoom levels of the
  same thing.

### Layout: floating now, tiling later

Keep today's free-floating windows **scoped per room** initially (least churn).
Note tiling as a future *within-room layout mode* (i3/niri): it's the layout that
lets the **agent place windows deterministically** ("put the draft in the right
column"), which pays off precisely because there are two actors. Not required for
v1; the data model above doesn't preclude it.

## Phasing

1. **Ship nothing** — one implicit workspace is the current behavior. Just make
   sure the agent session is keyable (not a singleton) so we don't paint
   ourselves in.
2. **Rooms + switcher** — the `Workspace` layer, create/switch/reap, per-room
   window scoping. Agent still global.
3. **Per-room agent context** — scope the agent thread to the active room. This
   is the payoff.
4. **Overview** — the zoom-out spatial switcher, fused with omnibar search.
5. **Tiling mode** (optional) — deterministic within-room layout for agent placement.

## Open questions

- **Where do per-room agent threads live?** In the synced volume (so rooms
  resume across devices) or local? How do they relate to the single agent
  connection today?
- **Sync semantics.** `os-state.json` already syncs and drops ephemeral windows
  (`persistence.ts`). Do rooms sync wholesale? What happens when two devices open
  different rooms?
- **How much identity** does a room need to avoid "where am I?" — name only, or
  color/wallpaper per room (Arc)?
- **Dynamic vs. pinned.** Pure dynamic (GNOME) vs. letting users pin a few
  long-lived rooms (tmux-style). Probably both: pinned + dynamic overflow.
- **Does the agent get to *reorganize* rooms** (move windows, split a task)? That
  is powerful and also a trust/undo surface — see doc 3.
