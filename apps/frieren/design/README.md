# Frieren shell redesign

> Status: **design — no code yet.** Three related docs that reimagine the desktop
> shell away from its Snow Leopard lineage (menubar + free-floating windows +
> dock + chat sidebar) toward an **agent-native desktop**: two actors — the human
> and the agent — sharing one workspace.

The guiding reframe: a classic OS assumes a single actor. Frieren has two. The
dock, the launcher, and the agent chat are all single-actor artifacts. These
docs redesign the three pieces that change most under that reframe.

| # | Doc | What it decides | Depends on |
|---|-----|-----------------|------------|
| 1 | [`01-omnibar.md`](./01-omnibar.md) | Replace the dock with one intent surface. v1: launch ∪ ask; commands/skills documented as a growth surface. | nothing — ship first |
| 2 | [`02-workspaces.md`](./02-workspaces.md) | Task-rooms with resident agent context; context switching as a first-class feature. | additive over the window model |
| 3 | [`03-undo-history.md`](./03-undo-history.md) | Whether/how undo changes our state model (snapshot timeline vs. inverse ops vs. event log vs. CRDT). | app-framework state layer |
| 4 | [`04-summoning-ritual.md`](./04-summoning-ritual.md) | Opt-in agent personalization: the permanent "default persona" whisper + a JRPG character-creation ritual for `soul.md` / `user.md` / the avatar. | 1 (omnibar/chat surfaces), 5 (paths) |
| 5 | [`05-system-layout.md`](./05-system-layout.md) | The `/system` tree: root = shared knowledge of the user, `agents/<id>/` = one agent's perspective. Moves `soul.md`, `user.md`, `MEMORY.md` — changes existing code paths. | nothing — apply first |
| 6 | [`06-app-agents.md`](./06-app-agents.md) | Per-app agents: a window footer, one panel in two modes (sheet / sidebar), and the keyed session that gives a window its own thread. | 2 (keyable session), 5 (paths) |

**Order of attack:** 1 first (additive, low-risk, doesn't touch the window
model). 2 is a layer above windows and can wait. 3 is the deepest — it may touch
the app-framework state substrate — so it gets the most design before any code.

## Shared principles (apply to all three)

1. **Two actors, one workspace.** Design for co-presence. The human and the
   agent act on the *same* state through *different doors* (GUI vs. TUI).
2. **The agent is text/TUI, never a puppet cursor.** `app = reducer + GUI +
   TUI`. The reducer is the pure machine; the GUI is the human interface; the
   TUI (the app's typed, described actions + procedures) is the agent interface.
   The agent dispatches actions — it does not click pixels.
3. **The GUI is a live projection of reducer state**, so co-presence is free:
   when the agent dispatches `open(...)`, the human's window re-renders. No ghost
   cursor needed.
4. **One registry, two callers.** The command surface the omnibar *will* expose
   (a growth phase, not v1) is the same action/procedure registry the agent
   routes through. We don't build a command system; we surface the one we have.
5. **Discoverable by default.** We own the whole desktop (unlike the native
   macOS build), so we don't hide behind `⌘K`. A teenager or a 60-year-old
   should see what to do without being told a shortcut.
