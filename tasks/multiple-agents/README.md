# Multiple agents

> Status: **design — no code yet.** The design is settled and drawn in
> **[`3-the-cabinet.html`](3-the-cabinet.html) — that file is the spec.** This
> README summarises the decision and lists the build. The other two mockups are
> the exploration that got here.

## The decision

The shell grows a **rail** of physical keycaps welded to the right edge, one per
agent, faces out. Pressing a cap pulls that agent's chat drawer out from under
the desktop and holds the cap down; pressing it again pushes the drawer back in.

**The depressed cap is the only "who am I talking to" indicator.** No highlight
colour, no selected row — `packages/design/mac.css` already gives a button a
1.5px edge that it eats when pressed, and this is that vocabulary doing the job
it was built for.

**The drawer and the rail are one slab.** The desktop is cut once, at the
drawer's edge; everything behind that cut is a single piece of sunk material,
and the boundary between drawer and rail is a scored hairline — no groove, no
cast, no second background. Two planes, not three.

## Why the shell can't do this today

- `.frn-chat-panel` holds one `MessagesPanel`; `chatOpen` is a boolean.
- The dock ends in a single agent face with presence states — one door that can
  only point at one person.
- `AgentProvider` reads one soul and holds one avatar.

The volume is already ahead of the UI: `05-system-layout.md` put every agent in
`/system/agents/<id>/` with its own `soul.md`, `avatars/` and `sessions/`,
because *"an agent is a directory"* and `main` is a reserved id, not a special
shape. Only the shell is behind.

## The shape

The shell keeps **two children** — the fix makes the tree shallower, not deeper:

```text
.frn-shell                 display:flex
├─ .frn-desktop-frame      flex:1      — menubar + desktop, squishes
└─ .frn-cabinet            flex:none   — paints the seam and the lip, once
   ├─ .frn-chat-panel      0 → width   — travels; no material of its own
   └─ .frn-agent-rail      64px        — a scored hairline, nothing else
```

The full CSS is in [`3-the-cabinet.html`](3-the-cabinet.html). The rules it
encodes:

- **The desktop pushes; the rail never travels.** The menubar already travels
  with the desktop today and should keep doing so — it is captioned by the
  focused app, so it is the desktop's caption, not the machine's. *Exception:*
  in fullscreen there is nothing to push, so the drawer overlays instead. The
  panel already carries `z-index: 9001` for this.
- **The score line only exists while the drawer is out.** Shut, it would sit a
  pixel from the seam and read as a doubled edge.
- **The lip runs across the whole cabinet**, not just the drawer.
- **Only the pressed cap may break the score line** — it squares its left
  corners and slides over it. That is the mark that says *this cap opens into
  this drawer*.
- **Press, pull, fill — 80ms, 460ms, +40ms.** The last is the existing trick and
  must survive verbatim: `.frn-chat-body` is pinned at the open width and
  arrives a beat late with a 22px slide, which is what sells *"was already under
  there"* over *"grew out of the side"*.

One new token: `--cabinet-score: light-dark(rgb(0 0 0 / .11), rgb(255 255 255 / .11))`.
Deliberately not `--rule` — it sits on the sunk slab and must stay quieter than
the seam it lives behind.

## What changes in code

| File | Change |
|---|---|
| `src/shell/DesktopShell.tsx` | Wrap the panel and a new rail in `.frn-cabinet`. `chatOpen` becomes `openAgentId: string \| null`. `clampChatWidth()` subtracts the rail. Render the rail in fullscreen, unlike the dock. |
| `src/agent/AgentRail.tsx` | New. The caps, their states, and the `+` cap. |
| `src/agent/Provider.tsx` | `identity` becomes a map keyed by agent id; read `/system/agents/` rather than one soul. |
| `src/agent/identity.ts` | Add `listAgents(volume)`; widen `watchIdentity` to the `agents/` directory. |
| `src/agent/hooks.ts` | Mostly works already — `useAgentSession(agentId)` takes an id and keys `inputs` by it. |
| `src/shell/Omnibar.tsx` | Delete `.frn-dock-separator` and the `.frn-dock-agent` block; shrink `DOCK_FIXED_WIDTH`. The app row is untouched. |
| `src/app.css` | Move the panel's background and box-shadow up to `.frn-cabinet`; add `.frn-agent-rail` and `--cabinet-score`; delete the dock's agent rules. |
| `packages/design/design.css` | Nothing. The keycap recipe is already there. |

Cap states: resting, pressed, **working** (a breathing ring, taking over from
`.frn-dock-agent[data-agent="working"]`), **needs you** (a gold count badge,
taking over from `.frn-dock-notification-badge`), and a `+` cap under a
separator that opens the summoning ritual.

The dock loses its face because with five agents one face has to either lie
about who it is or become a menu — and a menu of people 40px from a rail of
people is the collision made permanent. The cost to accept: the dock face was
where a passing user discovered there *was* an agent.

## Rejected

Drawn in [`1-directions.html`](1-directions.html):

- **The House** — a Household window with a roster and threads. Scales best and
  is the wrong answer: it turns a desktop you live in with someone into an app
  where you manage staff. Steal its handoff chips; leave the window.
- **The Inhabitants** — agents as sprites on the wallpaper. The most
  distinctive, and worth prototyping later as a layer *over* the rail; long
  transcripts in speech bubbles are bad.
- **The Bench** — faces on the omnibar pill. Cheapest, but the sheet closes on
  Escape and a household living there feels provisional.
- **The Table** — a zoomed-out view of who is doing what. Blocked on a job model
  the shell doesn't have.

Rail variants — raised glass, split menubar, narrow status groove — are in
[`2-the-right-edge.html`](2-the-right-edge.html).

## Deferred

- **Two drawers open at once.** Build the open state as a **list capped at one**,
  not a boolean, and this becomes a flag rather than a rewrite.
  `MIN_DESKTOP_WIDTH` is already the rule a width allocator would enforce.
- **Group threads** — a welded double-cap over one braided transcript. Needs the
  agents to address each other first.
- **Raised-glass rail as a fullscreen mode**, since that is where the cabinet
  cannot push.

## Open questions

- Repeating the full-screen summoning ritual per agent may be too ceremonial the
  fifth time. A shorter "second agent" path may be needed.
- Does the rail scroll past ~8 caps? A scrolling rail stops reading as a set of
  people, which is the point of faces.
- What does the rail show at first boot, when only `main` exists?
- Per-agent unread state has no source yet — `notice` on the session snapshot is
  per-connection, not persisted.

## Files

| File | |
|---|---|
| [`index.html`](index.html) | Hub — open this |
| [`3-the-cabinet.html`](3-the-cabinet.html) | **The spec.** Cross-sections, the CSS, and a two-layer / three-layer toggle |
| [`2-the-right-edge.html`](2-the-right-edge.html) | How the three layout/material questions were settled, plus four rail variants |
| [`1-directions.html`](1-directions.html) | The five directions, and why the rail won |

Live CSS on the real tokens and the real keycap recipe — press the caps. UI
inside the screens is drawn oversized to stay readable; the cast is invented,
the paths and constants are not.
