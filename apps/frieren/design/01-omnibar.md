# 1 · The omnibar

> Status: **design.** Replaces the dock (`src/components/Dock.tsx`) and the
> menubar's install/agent buttons with a single intent surface. Additive and
> low-risk: it reuses `useInstalledApps()` / `useAppCommands()` and the agent
> session, and does not touch the window model.

## The idea

One surface. You express intent — by typing, or later speaking — and it routes.
**v1 keeps this to two routes:**

- matches an installed app → **launch** it (`dispatch({ type: 'app.open', appId })`)
- otherwise → **ask** the agent (fall through to a prompt)

Launch ∪ ask, over one surface. This kills the dock (launching moves here) and
folds the agent chat, the "Install" button, and the app launcher into a single
thing.

The result list is a **growth surface**: v1 has two item types (apps, ask), but
the same list later gains commands, special commands, agent skills, and more (see
[Future](#future-the-result-list-is-a-growth-surface)). We keep the design
language for those here so v1 doesn't paint us in — but we ship the smallest thing
a non-technical user can grasp: pick an app, or talk to Frieren.

## Prior art: the spud-mac launcher

The native build already ships this. `apps/spud-mac/ui/launcher/main.tsx` is an
input that fuzzy-filters an app grid and **falls through to the agent when
nothing matches**:

```txt
noAppMatch = query !== '' && filtered.length === 0
showChat   = noAppMatch || (chatOpen && query === '')
```

Type "paint" → grid narrows to Paint; press Enter → launch. Type "what's on my
calendar" → no app match → the panel becomes the agent transcript and the text
is sent as a prompt. That single-input-routes-to-launch-or-ask mechanic is the
whole model. We port it, with three changes.

### Change 1 — launch targets a window, not a URL

spud-mac navigates `location.href = /app/<id>` because each app is a real macOS
window. In frieren, "launch" is an OS action:

```ts
launchApp(app) // → dispatch({ type: 'app.open', appId: app.id })
```

`useAppCommands().launchApp` and `useInstalledApps()` already exist and already
do exactly this from the dock. The omnibar is a near-verbatim port with this one
swap.

### Change 2 — discoverable, not hidden behind a shortcut

For spud-mac, a hidden `⌘K`/hotkey Raycast-style bar is correct: it can't add a
permanent element to macOS, so summon-on-shortcut is the only option, and its
users opted into a power tool.

**Frieren owns the entire desktop.** We should not assume anyone instinctively
presses `⌘K`. The omnibar is a **persistent, obvious, always-present element**,
not a summoned overlay:

- A visible **bar**, prominently placed on the desktop — the thing your eye lands
  on when the desktop is empty. Placeholder does the teaching: *"Search apps, or
  talk to Frieren…"*.
- **Just start typing** anywhere on the desktop focuses it (no click needed).
- A keyboard summon (`⌘K` / `⌘Space`) still exists for power users and for
  raising it over a full-screen app — but it is the accelerator, not the door.
- As windows fill the desktop the bar can recede (shrink to a corner affordance)
  but never disappears.

This is the inverse of Raycast's philosophy: **discoverable-by-default,
fast-by-shortcut**, rather than fast-by-shortcut-and-invisible-otherwise.

### Change 3 — bottom-anchored, unified with the chat surface

The omnibar is launcher **and** agent, and the agent half dominates the
interaction — so it obeys chat's learned convention, not Spotlight's. spud-mac
already does this: a bottom-anchored bar whose surface transitions seamlessly
between the app grid and the transcript because the input never has to move.

One rule makes both modes feel like one thing:

> **The input stays fixed at the bottom. All content grows upward from it, and
> the item nearest the input is the most relevant.**

- **Launcher mode:** the best/default match sits *just above* the input (so the
  Enter-target is where your eye already is); weaker matches stack above it. `↑`
  walks toward weaker matches.
- **Chat mode:** the latest message sits just above the input; older scrolls up.

Same spatial grammar in both modes, so switching launcher↔chat never reflows the
input or flinches the layout — the anti-jarring property that top-anchored
launchers lose the moment they try to host a conversation.

**Bottom-center also *serves* discoverability** (Change 2): it's where the old
dock lived (muscle memory) and where every chat app puts its input, so casual
users already know what to do with it.

**Mode ambiguity.** v1 has only two readings (launch vs. ask), so the
fall-through is unambiguous: app matches stack above a persistent **"Ask Frieren:
'…'"** row pinned directly above the input, and when nothing matches only that row
remains, sliding seamlessly into the transcript. The pinned-default pattern is
chosen now because it stays predictable as more item types (commands, skills)
join the list later — the input's location and the default action's location
never move.

## What the dock leaves behind

Deleting the dock loses one thing: the running-app indicators (`ds-dock-indicator`).
Move "what's running" to a **lightweight switcher** over the existing
`focusStack` — invoked (`⌘Tab`-style or a peek gesture), not always-on. This is
also the natural seam to grow into the workspace overview (doc 2).

## Surface & interaction sketch

Bottom-anchored; content grows **upward**, most-relevant nearest the input:

```txt
┌──────────────────────────────────────────────────────────┐
│  APPS                                                      │
│   ▸ Notes                                 (best match)     │   ← nearest input
│  ─────────────────────────────────────────────────────    │
│   ▸ Ask Frieren: "notes"                                   │   ← pinned default
├──────────────────────────────────────────────────────────┤
│  🔍  notes|                                                │   ← the bar (fixed)
└──────────────────────────────────────────────────────────┘
```

- **Idle vs. active display.** At rest (empty bar, no conversation) the surface
  is a **grid** of app icons — a friendly, glanceable home screen (like spud-mac /
  Launchpad), orderable by recents/frequency, good for discovery and casual
  users. The first keystroke (or an open conversation) switches it to the
  **vertical list** shown above — ranked app rows growing upward, sharing grammar
  with the transcript. That's one deliberate browse→active transition (à la iOS
  Spotlight: springboard grid → results list), not a per-keystroke or
  launcher↔chat flip. Do **not** filter-within-the-grid (Launchpad style) — it
  re-creates the grid→transcript jar the moment you fall through to chat.
- **Ranking direction.** The best/default match sits at the *bottom* of the
  list, adjacent to the input; weaker matches stack upward. "Ask Frieren" is
  pinned just above the input as the universal fall-through, and becomes the
  *only* option (sliding into the transcript) when nothing structured matches.
- **Enter** runs the default; **↑/↓** move; **Esc** dismisses (or clears back to
  launcher mode from a conversation).
- **The omnibar is the agent surface** — chat happens inline (like spud-mac's
  `ChatSurface`), not in a separate docked panel. A single escape hatch expands a
  long conversation into a full window so the bottom overlay never hosts a
  200-message transcript.
- **First-run hint.** A one-time coach mark on the bar for brand-new users.

## Future: the result list is a growth surface

v1 ships two item types (apps, ask). The list is designed to grow more without
changing its shape — new types slot in above the pinned "Ask Frieren" default.
Documented now so v1 doesn't foreclose them; **none of this is v1.**

### Commands (the app TUI, surfaced to humans)

Frieren apps expose a **typed, described command surface** — an app's `update`
actions and `procedures` each carry `description`, `examples`, `schema`, and
`audience` (see `packages/app-notes/src/app.ts`: `open`, `newNote`, `create`, …).
That registry is a ready-made command palette, and **it's the same registry the
agent uses** — so surfacing it costs no new system.

But that registry is designed as the **agent's** interface (the TUI half of
`reducer + GUI + TUI`), not the human's. Dumping raw actions into a launcher is
too much for a non-technical user, and risks conflating "the agent's control
surface" with "things a person picks from a menu." So commands are deferred, and
when we add them it is as **human-framed** entries (curated, friendly labels),
not a raw projection of the TUI.

- **Audience gates the list.** Only agent-safe (non-`gui`-only) actions are ever
  runnable this way; `audience: 'gui'` / destructive actions (e.g. notes'
  `remove`) are excluded or require confirmation — the boundary the agent already
  respects.
- **Commands need a running (or lazily-booted) app.** Dispatching `open` implies
  the reducer exists; the omnibar either targets open apps or boots one headless
  (the kernel loads reducers independently of the GUI).
- **Open:** routing when the target app isn't open (headless boot vs.
  launch-then-run); keeping commands from *many* apps legible (scope to open apps
  first?).

### Beyond commands

Special commands (system actions — new workspace, install, switch user), **agent
skills** as first-class list items, files/docs, recents. Each is a new item type
with the same ranking / pinned-default rules.

## Phasing

1. **v1 — launch + ask** — a direct port of spud-mac's `Launcher`, with the
   `app.open` swap and the bottom-anchored persistent bar. Two item types (apps,
   ask). Deletes the dock.
2. **Switcher** — running-window switcher over `focusStack` to fully replace the
   dock's indicators.
3. **Growth** — new item types in the list: commands, special commands, agent
   skills (see Future). Additive; the pinned-default layout already accommodates
   them.

## Open questions

- ~~Does the agent answer inline or hand off to a panel?~~ **Decided:** inline —
  the omnibar *is* the agent surface (Change 3), with an expand-to-window escape
  hatch for long conversations.
- Voice input: same routing, different door — in scope later or never?
- Where does "browse all apps" live — the omnibar's **idle grid**, or app icons on
  the desktop surface itself? (Leaning: omnibar grid, to keep the desktop clean
  and the omnibar the single home.)
- Does the persistent bar host **status** too (sync/connection, currently in the
  menubar), or stay purely an input?
