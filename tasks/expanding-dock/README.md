# The expanding dock

> Status: **design — no code yet.** Replaces the omnibar's resting state
> (`platform/frieren/src/shell/Omnibar.tsx`) with a dock that carries a search
> field, the app icons and Frieren in one row. Supersedes the "one intent
> surface" framing in `platform/frieren/design/01-omnibar.md`, which assumed the
> agent lived in the bar.
>
> See [`mockups.html`](./mockups.html) for the rendered design — three live
> states, the measured anatomy, the transition storyboard and the edge cases.

## Why the omnibar stopped working

The omnibar earned its shape from one sentence: **launch ∪ ask, over one
surface.** Moving the conversation into the side drawer took `ask` away, and
four things broke at once.

1. **The unifying argument left with the chat.** What remains is a search field
   whose main job — opening things you could have pointed at — is the one job a
   text field is worst at. The ask row now ends in a hint reading
   `opens side panel`.
2. **Bottom-anchored was chat's convention.** `01-omnibar.md`'s Change 3 chose
   bottom-anchored, grow-upward because "the agent half dominates the
   interaction". That premise is gone.
3. **The agent has two faces.** One on the pill, one floating bottom-right
   (`DesktopShell.tsx`'s `.frn-agent-launcher`). Two anchors for one presence.
4. **The dock's job is still vacant.** `01-omnibar.md` knowingly dropped
   running-app indicators and promised a `⌘Tab`-style switcher over `focusStack`.
   It was never built.

The pill also accreted four payloads that are not launcher features — App Store
front door, notification banner, notification centre, presence glow — which is
why it can't simply be deleted. Each is re-homed below.

## The design

One row, three sections: **search · apps · Frieren.**

Click the search field and the app icons step aside so it can run the width of
the bar. Type to filter the apps; type anything else and `↩` sends it to
Frieren. `Esc` or a click outside puts the icons back.

**The field is present before, during and after.** It is the thing you clicked
and it simply got bigger — an interaction people already know from every mobile
search bar.

### Why not a morph

An earlier version turned the dock *into* a field. It was rejected:

- **Nothing survives the transition.** A morph reads as one object changing
  state only when the object persists. A dock is a set of spatial targets; a
  field is one linear target. There is no intuition to borrow.
- **The trigger has nowhere to live.** Clicking a dock already means *launch
  this app*, so the click that opens search has no home — which is why that
  design had to lean on a keystroke, and a keystroke has to be taught.
- **It hides the capability in the state people are usually in.** At rest,
  search would be invisible. Discoverable-by-default is the shell's own first
  principle.

### The icons don't vanish — they move up

As the field grows, the icons rise into the sheet and land as a labelled grid
holding every installed app. *"Where did my apps go?"* answers itself on first
use because you watch them arrive. Reverse on `Esc`.

### The outline never moves

The bar's box is identical in all three states. This is structural, not tuned:
the field is positioned over a fixed-size slot that holds its place in the flow,
and the icons keep their space when expanded — they only fade and lift. Nothing
in the flow changes, so the width *cannot* change.

## Geometry

| Part | Spec |
|------|------|
| Slab | 52px tall, 14px radius, 9px padding, 8px gaps, 20px off the screen bottom |
| Field | 132 × 34, 9px radius, inset. Placeholder at rest is one word: *Search* |
| Icons | 34px at 24% radius, stable order, running app carries a dot beneath |
| Rule | One hairline, cutting *apps* from *Frieren* |
| Frieren | 34px circle — a dock item, its own section at the end |

Width is `203 + 42n` for *n* icons: 203px of field, rule, face, padding and
border, then 42px per icon (34 + 8 gap). Six apps is **455px** — 185px narrower
than today's `min(640px, 92vw)` pill.

**The row is capped by the width available**, not by a constant:

```
n = clamp(3, floor((available - 203) / 42), 10)
```

where `available` is about 70% of the desktop. Ten is the ceiling because past
that you are scanning rather than pointing. The row **truncates from the end**;
it never re-orders, so position stays learnable. Anything hidden is one
keystroke away in the field and always present in the grid.

## Behaviour

| Gesture | Result | Bar afterwards |
|---------|--------|----------------|
| Click an app icon | Launches it, or focuses its window if running | Unchanged — never expands |
| Click the field | Expands; grid shows most-recent apps, App Store last | Open, empty |
| Type | Filters apps into a list, *Ask Frieren* pinned at the bottom | Open, with a query |
| `↩` on an app | Launches it | Collapses to rest |
| `↩` with no match | Sends to Frieren, opens the drawer, **moves focus into it** | Collapses to rest |
| Click Frieren | Opens the drawer on the current session, focuses its input | Collapses if open |
| `Esc` / click outside | Cancels; icons drop back into the row | Collapses to rest |
| `↑ ↓` | Walks results; best match nearest the field | Open |
| Right-click an icon | Open / Uninstall, as today | Unchanged |

**One rule underneath:** the icons are for pointing, the field is for typing, and
neither gesture triggers the other. Clicking an app never expands the bar; typing
never launches anything without `↩`. That separation is why this needs no
teaching.

## Settled

- **Grid order** — a grid, ranked by recency, capped at twelve. Keeps the grid
  shape but lands on recents without a second list.
- **Row length** — derived from the viewport, clamped 3–10. Truncates rather
  than re-orders.
- **App Store** — out of the bar, last tile in the grid. iOS doesn't put it in
  the dock, because the dock is for what you use daily. Buys back 51px and lets
  the row mean one clean thing: *your apps*.
- **After asking** — collapse, and move focus into the drawer. One input at a
  time; the drawer owns the conversation and the caret.
- **Running apps** — click focuses the window. No cycling, no
  minimise-on-second-click. One window per app today, so there is nothing to
  cycle through.
- **Presence** — on Frieren's face, not the slab. A rotating ring around a row of
  app icons reads as an error, and pulsing the whole bar while someone is trying
  to launch something is hostile.
- **Notifications** — a transient row *above* the bar, borrowing the sheet's
  grammar. A 132px field cannot carry the banner the 640px one could. `info`
  auto-recedes; `error` and `question` stay. Unread history badges the face.

### Two orderings, on purpose

The bar and the grid sort differently and must keep doing so. The **bar** is a
stable arrangement the user controls — muscle memory, never re-sorted. The
**grid** is ranked by recency — for finding your way back. Same icons, two jobs.
Getting this backwards makes the bar unusable.

## Consequences to handle

- **Held app updates lose their badge.** The store icon carried it and the store
  is now behind a click. Nothing else surfaces a held update (see the `held`
  computation in `Omnibar.tsx`), so it has to become a notification — an `info`
  in the banner row routing to the store tile. The machinery exists; it needs
  wiring.
- **Rank the grid on open, then freeze it.** If recency re-sorts live, icons move
  under the pointer between glancing and clicking. Compute the order when the
  sheet opens and hold it for that engagement.
- **The drawer takes width from the bar.** The bar is centred on the desktop and
  the drawer narrows the desktop rather than covering it, so opening it
  re-centres the bar and tightens the cap. No special case — the drawer is just
  another way the available width changes.
- **Retire the floating avatar.** `.frn-agent-launcher` in `DesktopShell.tsx`
  becomes redundant once the face is a dock item and the drawer's handle.

There is **no empty state to design**: `seedBuiltins` materialises the built-in
apps on every boot (`platform/frieren/src/apps/seed.ts`), so even an anonymous
account opens with a full row.

## A note on the keyboard

`Omnibar.tsx` listens for keystrokes on the host `window`, and app GUIs run in
opaque-origin sandboxed iframes (`src/apps/host.ts`, `sandbox="allow-scripts …"`,
no `allow-same-origin`) with no key forwarding in `packages/app/iframe.ts`. So
once focus is inside an app window, neither type-anywhere nor `⌘K` reaches the
shell today.

This is a pre-existing gap, not something this design introduces — but it is the
reason the bar must keep a **visible, clickable** text target rather than relying
on a shortcut. Fixing it properly means forwarding unhandled keys from
`guiFrameScript`, which is its own task.

## Deferred

- **Sorting the row by how active an app is.** Worth trying, but it trades
  positional constancy for relevance on the surface where constancy matters most
  — the opposite trade from the grid. Wants a prototype before a spec.
- **Horizontal scrolling for the hidden icons.** A refinement on the cap, not
  needed for v1.
- **Multi-window per app.** The click-to-focus rule is the one worth keeping when
  that arrives; the cycling question re-opens then.
