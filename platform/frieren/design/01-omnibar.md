# 1 · The omnibar

> Status: **v1.3 shipped.** Replaces the dock (`src/components/Dock.tsx`, now
> deleted) and the menubar's agent button with a single intent surface
> (`src/shell/Omnibar.tsx`). v1.1 added the **engagement model** (see below):
> at rest the omnibar is just the pill; the sheet (grid / list / chat) exists
> only while engaged, and the desktop dims + recedes behind it. v1.2 added the
> first **presence** slice: the pill glows while the agent works, and pulses +
> shows the pending question when the agent needs the user. v1.3 ships the
> **conversation window**: a real `OsWindow` (drag, resize, z-order,
> fullscreen) replacing the `AgentSidebar` overlay (now deleted), with the
> window layer made kind-generic (`kind: 'app' | 'agent'`) along the way.
>
> **Deviations / deferred:** the menubar **Install** button stays (it's a
> *special command* — Future, not v1, so there's nothing to fold it into yet).
> The earlier "recede-to-corner" idea is **superseded** by the engagement
> model (the sheet collapses to the pill; nothing shrinks to a corner), and
> the earlier "graduation" idea is **superseded** by the conversation-window
> model (one session, two views; no auto-expand). Not yet built: the first-run
> coach mark, recents/frequency ordering of the idle grid, the `⌘Tab`
> switcher, the conversation window's **new-session command**, and the rest of
> **presence / answers-as-actions**.

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

The native build already ships this. `platform/spud-mac/ui/launcher/main.tsx` is an
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
- As windows fill the desktop, only the **pill** (the bare input bar) stays
  resident — dock-sized, never disappears. Everything above it is transient
  (see the engagement model).

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

## The engagement model — three durations, three surfaces

*(v1.1, shipped.)* v1 made the sheet (grid / chat) **resident**: it permanently
occupied a large slab of screen height floating above the app windows. That
exposed the real principle:

> **Occlusion isn't the problem — *unrequested* occlusion is.** Spotlight,
> Raycast, and `⌘Tab` occlude everything and nobody minds, because they exist
> only during a moment of declared intent and vanish when it passes.

Two tempting fixes were considered and **rejected**:

- **Put the sheet behind the windows.** Never. A half-covered interactive
  surface is the worst of both worlds — it still costs attention but can't be
  reliably used. A surface is either collapsed (gone) or engaged
  (unambiguously on top); nothing in between.
- **Reserve layout space** (windows can't overlap the sheet's lane, dock-style
  insets). That re-creates the dock's tax and makes it *bigger*.
  Time-multiplexing (modes) beats space-multiplexing — that's the piece of
  desktop-OS baggage worth throwing away.

The omnibar conflates three interactions with very different lifespans. Each
gets its own permanence budget:

1. **Ambient (always) — the pill.** Just the input bar. The one permanently
   resident element, sitting where the dock used to sit, roughly dock-sized,
   always on top. Typing anywhere focuses it; `⌘K`/`⌘Space` summon it over a
   full-screen app. This is the discoverability anchor and the lineage anchor
   with spud-mac (bottom-fixed input, content grows upward).
2. **Transient (seconds) — the sheet.** Focus (click, summon, or just typing)
   expands the surface — idle grid, search list, or chat — *above* the
   windows. Blur, `Esc`, or launching collapses it back to the pill. While the
   sheet is up, the desktop **dims and slightly recedes** (scale + brightness
   on the windows layer) — the "turn to talk" gesture: you turn from the desk
   to face your partner, then turn back. Engaged-mode occlusion is the visible
   signature of a mode you invoked and can leave instantly, so "how do I talk
   to the agent when windows cover everything?" dissolves: just start typing.
   One exception keeps the sheet up without focus: a **streaming reply**, so an
   in-flight answer is never lost to a stray click.
3. **Durable (minutes) — the conversation window.** A working *session* with
   the agent deserves negotiated screen space like any other work — a real
   window, not a floating occluder. Opened by the user, never automatically.
   Shipped in v1.3 (see below).

Implementation notes (v1.1): the omnibar root carries `data-expanded`;
`.frn-desktop:has(.frn-omnibar[data-expanded='true'])` dims/scales the
`.frn-desktop-windows` layer (windows live in their own layer so the transform
never touches the omnibar). `mousedown` on the sheet is `preventDefault`ed so
clicks inside it don't blur the input and collapse it mid-click — inline text
selection in the transcript is knowingly sacrificed; expand-to-window is the
copy escape hatch. Conversation state (`chatOpen`) survives collapse: click
the pill again and the transcript is still there.

## The conversation window — one session, two views *(window shipped in v1.3)*

*(This replaces the earlier "graduation" design. Nothing graduates — there is
no state transition at all. The session has one durable home the user can open
on demand, and one quick-access view. Auto-graduation triggers were considered
and **dropped**: with the engagement model, a long transcript in the sheet is
no longer a standing occlusion problem, just a cramped reading choice — and
auto-spawning a window mid-conversation changes the world while the user is
mid-thought, exactly the surprise the rest of the design avoids.)*

**Invariants:**

- **One current session per workspace, at all times.** The session is kernel
  state, not window state. The UI never manages sessions; it *shows* the
  current one. (A multi-workspace setup with per-workspace sessions may come
  later; not now.)
- **Session refresh is a dedicated command**, not a side effect of any window
  action — a *special command* in the omnibar ("new session") plus a button in
  the conversation window header. Being kernel-level, the same command is
  naturally available to both GUI and TUI.

**The two views:**

- **The sheet (quick access)** *(✅ shipped)*: renders only the **recent tail**
  of the transcript — the last few exchanges, lightly scrollable. The "no
  200-message overlay" rule is enforced in the *rendering cap*, not by
  window-spawning behavior. When the transcript grows past the cap, an **"Open
  in window ↗"** affordance appears *at the top of the tail* — precisely where
  the eye lands when scrolling up for history, which is exactly the moment a
  window is wanted. The invitation escalates; the behavior never does.
- **The window (durable home)** *(✅ shipped, v1.3)*: opened **only by explicit
  user action** — the expand affordance, never automatically. A normal
  `OsWindow` (`kind: 'agent'`, singleton id) that participates fully in window
  management: drag, resize, z-order, fullscreen, persisted rect. It defaults
  to a right-docked position (the old sidebar's one virtue, kept as the
  starting rect, not a constraint). Closing it just closes the view — the
  session persists (there is always a current session), and the pill is the
  way back in. The `AgentSidebar` overlay is deleted.

**Coexistence rule** *(✅ shipped, v1.3)*: while the window is open, the sheet
stays in **launcher mode** — no duplicated live transcript. The pill still
*sends* to the session (it is the universal input, never dead); replies land
in the window, and a needs-you focus lands on the window instead of the sheet.
When a query matches no app while the window is open, the pinned ask row stays
put and gains an *“in conversation ↗”* hint — implying the send lands over in
the window rather than sliding the sheet into a second transcript. Division of
labour: the omnibar is the fastest way to **send**, the window is where you
**read**.

**Reaching the conversation on demand** *(✅ shipped)*: two paths keep a
dismissed session from ever being stranded. (1) Following spud-mac, a query
that matches **no app** is read as intent to talk — the sheet slides straight
into the transcript (this realises the “only that row remains, sliding
seamlessly into the transcript” line above), unless the window owns it. (2) A
persistent **chat button** on the pill (shown once a session exists) opens the
transcript, or focuses the conversation window when it owns the transcript —
the discoverable, always-visible way back in.

**The window layer went kind-generic to make this fit** *(v1.3)*: `OsWindow`
gained `kind: 'app' | 'agent'` (the shell picks the body renderer by kind) and
`appId` became a property rather than the window's identity — one window per
app is now a *policy* in `app.open` (lookup by `appId`), not an identity
constraint. App windows still use the app id as their window id because it
doubles as the app-host stage key and the server sync key; multi-window per
app later is an additive change (a new action + an app-model answer to "what
does a second window show"), not a window-layer rework. Non-app windows are
invisible to the app host and the server (no stage, no `app_open`/`app_close`
echo) — the agent window is pure shell state.

## Presence & answers-as-actions *(first slice shipped in v1.2)*

The co-op framing — one core, GUI for the human, TUI for the agent — points
past "where do we put the chat panel." In a co-op game you don't read a text
log of your partner; you **watch them play**. The agent acts through the same
reducers whose state the windows already render, so the transcript is not the
interface — it's the audit log.

Presence on the pill has **two channels**, layered rather than either/or:

- **Glow is the state channel** (✅ shipped, v1.2). A Siri-style rotating
  conic-gradient ring on the pill's border: glanceable, non-verbal, and it
  never competes with the input. States: no glow = `idle`; steady spin =
  `working` (a reply is streaming); spin + breathing pulse = `needs-you` (the
  last message is an unanswered multiple-choice question). `needs-you` earns
  the stronger treatment because it's a *request*, not a status.
- **Text is the detail channel** (shipped only for `needs-you`, v1.2). Status
  text lives in the placeholder slot, which is only visible when the input is
  empty and unfocused — so it never *functionally* blocks the launcher; the
  first keystroke replaces it, and focusing reverts to the teaching
  placeholder. v1.2 ships the highest-value slice: the pending **question**
  shows in the pill ("Frieren: which folder?"), and focusing lands on the
  transcript with the options ready — typing anywhere answers it. Routine
  activity narration ("editing Trip Plan…") is future.

**Rules for the text channel** (when narration comes): update on **action
boundaries**, never character-by-character — churning text at the bottom of
the screen is a permanent attention magnet, worse than the resident grid we
killed. And the narration can be **derived, not reported**: agent dispatches
carry the action registry's `description` fields, so the TUI's own vocabulary
narrates the agent's play with no new status system.

The rest of the north star, still unbuilt:

- **Activity glow on windows.** Windows the agent is currently acting on get a
  subtle highlight — the agent's "cursor" in the shared world. The kernel
  already knows which app an agent-originated dispatch targets; surfacing
  `appId → window chrome` is the whole mechanism.
- **Answers-as-app-actions.** "What's on my calendar?" should not be three
  paragraphs in a bubble — it's the calendar window opening/focusing with
  today highlighted, plus a one-line caption above the pill. The GUI *is* the
  reply. Chat bubbles become the fallback for answers with no app-shaped home.
- **Consequence:** the transcript demotes over time to a summonable audit log,
  and the conversation window becomes less necessary, not more. This is the
  real payoff of `reducer + GUI + TUI`: both users share one world, and each
  watches the other through it.

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

- **Idle vs. active display.** When engaged with an empty bar (and no
  conversation) the surface
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
`audience` metadata.
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

1. **v1 — launch + ask** ✅ **shipped** — a direct port of spud-mac's `Launcher`,
   with the `app.open` swap and the bottom-anchored persistent bar. Two item
   types (apps, ask). Deletes the dock.
2. **v1.1 — engagement model** ✅ **shipped** — pill at rest, sheet only while
   engaged, desktop dim + recede behind the sheet, streaming keeps the sheet up.
3. **v1.2 — presence glow** ✅ **shipped** — pill glows while a reply streams;
   pulses + shows the pending question when the agent waits on the user;
   focusing then lands on the question.
4. **v1.3 — conversation window** ✅ **shipped** — a real `OsWindow` replaces
   the `AgentSidebar`; window layer goes kind-generic; coexistence rule
   (window open ⇒ sheet stays in launcher mode). The sheet's **capped tail +
   escalating "Open in window" invitation** shipped too. Still pending from
   this design: the dedicated "new session" command.
5. **Switcher** — running-window switcher over `focusStack` to fully replace the
   dock's indicators.
6. **Growth** — new item types in the list: commands, special commands, agent
   skills (see Future). Additive; the pinned-default layout already accommodates
   them.
7. **Presence & answers-as-actions, the rest** — activity narration in the pill
   (action-boundary updates, derived from action descriptions), activity glow
   on windows, app-shaped answers.

## Open questions

- ~~Does the agent answer inline or hand off to a panel?~~ **Decided:** inline —
  the omnibar *is* the agent surface (Change 3), with an expand-to-window escape
  hatch for long conversations.
- Voice input: same routing, different door — in scope later or never?
- ~~Where does "browse all apps" live — the omnibar's **idle grid**, or app icons on
  the desktop surface itself?~~ **Decided: omnibar grid.** The focused-empty grid
  gains an **App Store** tile (shown whenever the catalog is non-empty)
  that flips the sheet into a browse list of not-installed catalog apps, reusing
  the store-row renderer and the existing consent-install path. The tile stays in
  the grid whenever the catalog exists — even after every app is installed (browse
  then shows an all-installed empty state). Keeps the desktop
  clean and the omnibar the single home; a menubar/desktop entry was rejected as
  system chrome, not intent.
- Does the persistent bar host **status** too (sync/connection, currently in the
  menubar), or stay purely an input? (*Partially decided by v1.2: agent
  presence lives on the pill. **Notifications decided** — the pill is the
  ambient notification banner and the sheet gains a notification-center mode;
  `needs-you` folds into the general notification model
  (`src/notifications/`). System **toggles** (DND) and sync/connection status
  stay in the menubar — system chrome there, intent + presence here.*)
