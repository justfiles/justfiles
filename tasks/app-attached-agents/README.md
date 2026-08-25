# App-attached agents

> Status: **design — no code yet.** Additive over the window model
> (`apps/frieren/src/os/state.ts`) and the agent session (`packages/agent`). Adds one piece of
> window chrome (a **footer**), one panel with two modes (**sheet** /
> **sidebar**), and keys the agent session so a window can own a thread. The
> global agent and the omnibar are untouched.
>
> Depends on doc 5 (the `/system/agents/<id>/` layout this fills in for the
> first time).

Source design set: [`apps/frieren/design/`](../../apps/frieren/design/) — read its
[README](../../apps/frieren/design/README.md) for the shared principles, and
[doc 5](../../apps/frieren/design/05-system-layout.md) for what this builds on.
Visual mockups of both modes: [`mockups.html`](./mockups.html) — open it in a
browser.

## The problem

The agent is global. It lives at the bottom of the desktop, one thread for
everything, and it has no idea which window you are in. Every question about the
app in front of you starts with a sentence describing the app in front of you.

We want the opposite: an assistant that belongs to the window you are working in,
knows what that app holds, can act through the app's own actions, and stays out
of the way until you want it.

## The shape

Every app window grows a **footer** — a strip of chrome below the body, with the
agent button in its trailing corner. Pressing it opens one panel in one of two
modes:

- **Sheet** — rises over the app, dims it, closes on Esc. *"Let me just ask."*
- **Sidebar** — opens beside the app, changes nothing about it, stays until you
  close it. *"Let me work on this with you."*

Same component, same thread, same session. The mode is a preference with a
default, and the footer is the constant affordance in both — the way the DevTools
toggle stays in the browser toolbar no matter where the panel is parked.

### Why height is covered and width is split

The two modes are not the same gesture, and the reason is not taste.

The web has spent fifteen years teaching apps to survive a **narrow** viewport
and nothing at all about surviving a **short** one. A 500 × 700 app is a layout
somebody tested — it is a phone. A 900 × 280 app is a layout nobody has ever
seen. An app made narrower degrades along a path its author designed; an app made
shorter degrades along no path at all, and on a laptop the vertical budget is the
scarce one to begin with.

So: **the mode that takes height never takes it from the app, and the mode that
takes width is free to.** The sheet overlays. The sidebar splits. That asymmetry
is what separates the two jobs, and it is why this is not one panel with a
position setting.

## The footer

New chrome in `packages/design/design.css` (`ds-window-footer`), rendered on
**app windows only** — the conversation window has no app to be about. It follows
the rules the titlebar already follows: same `--surface`, same fade when the
window is not focused.

```
├────────────────────────────────────┤
│                             [ ▲ ]  │   24px, --surface, 1px top rule
└────────────────────────────────────┘
  ↑ leading slot (empty in v1)   ↑ the agent button
```

- **Trailing:** the agent button — the face plus a chevron pointing where the
  panel will appear. No label, no badge, no count. It takes the accent tint while
  the panel is open and the chevron reverses.
- **Leading:** deliberately empty. This is the **growth surface** — the slot an
  app's own status line (word count, sync state, cursor position) lands in when
  an app actually wants one. It needs an SDK surface, so it is documented here
  and not built.

## The two modes

|  | Sheet | Sidebar |
|---|---|---|
| The app | covered, dimmed, **unmoved** | untouched, full brightness |
| Layout | overlay + scrim | flex split + draggable seam |
| Dismiss | Esc, or click the scrim | the close button; stays otherwise |
| Remembered | never restored open | remembered per window |
| Job | a question | a workbench |

**Sheet** — the panel is absolutely positioned inside the window body, over a
scrim. The app keeps its whole layout behind it: the rows the sheet covers are
*hidden*, not reflowed, and they are exactly where you left them when it drops.

```
┌────────────────────────────────────┐
│ ● ●            Dictionary          │
├────────────────────────────────────┤
│ per·func·to·ry                     │  app: unmoved, recessed
│ 1. done routinely and with little  │
│┌──────────────────────────────────┐│
││ Frieren · Dictionary      ⇥ side ││  sheet, over the app
││ …conversation…                   ││
││ [ Ask about Dictionary        ↑ ]││
│└──────────────────────────────────┘│
├────────────────────────────────────┤
│                             [ ⌄ ]  │
└────────────────────────────────────┘
```

**Sidebar** — a real split: a sibling of `AppViewport` in the window body, taking
width the window had to spare. Nothing covered, nothing dimmed, because the point
is to use both at once — read the app while you type, copy something across, act
in the app and come back to say what happened.

```
┌────────────────────────────────────────────────┐
│ ● ●                Dictionary                  │
├─────────────────────────────┬──────────────────┤
│ per·func·to·ry              │ Frieren · Dict.  │
│ 1. done routinely and with  │ …conversation…   │
│ little interest or care.    │                  │
│ Similar  cursory · token    │ [ Ask …       ↑ ]│
├─────────────────────────────┴──────────────────┤
│                                         [ › ]  │
└────────────────────────────────────────────────┘
                              ↑ draggable seam
```

**One floor.** The sidebar can still break an app — by pushing it past a mobile
breakpoint mid-session, so the layout jumps to a stacked view. The app keeps a
minimum width; if the window is too narrow to give the sidebar its room without
crushing the app, the button opens the **sheet** instead. The mode is a
preference, not a promise.

**Swapping.** The panel header carries one control — `⇥ side` in the sheet,
`⌄ sheet` in the sidebar — that hands the conversation over with the thread,
scroll position and composer draft intact. Settings → Appearance sets the
default; this control is how people find the other mode, by outgrowing the one
they are in.

## Behaviour

- **It never opens itself.** The agent's face may change expression — that
  channel already exists — but the panel appears because you pressed something.
- **The thread is lazy.** No session is built when a window opens, only when you
  first send something. Opening ten apps costs nothing.
- **Acting is visible.** The agent dispatches the app's own actions, so the
  window re-renders in front of you (design README, principle 3). No ghost cursor, no
  confirmation theatre.
- **A reply in flight holds the surface open.** The omnibar already works this
  way; an accidental click must not throw away an answer you are waiting for.
- **Window blur does not close the panel.** The user closes it with Esc, the
  scrim, the close button or the footer button. Moving to another window must
  not dismiss a conversation.
- **Esc closes the panel, never the window.** Reliable in sheet mode — the scrim
  holds focus. See the keyboard note below for the sidebar.
- **Selection is never a prerequisite.** The panel is attached to the *app*, not
  to a text range. v1 needs **zero changes to the app SDK**: the agent orients
  itself with `app state <id>`, which works for every installed app today,
  including prebuilt bundles like Dictionary.

### The keyboard note

Keystrokes inside the app's sandboxed iframe never reach the shell —
`allow-scripts` without `allow-same-origin` means the parent document sees
nothing. So `⌘/` works only while the chrome has focus, and the footer button is
the **primary** control, not a fallback. (The same limit already applies to
`apps/frieren/src/components/Window.tsx`'s Escape-exits-fullscreen
handler.) One bonus: the sheet's scrim
takes focus off the app, so Esc is always reliable there.

## Session data

### The store is already generic

This was the part that looked like a redesign and is not. The transcript layer is
already parameterized by an agent id, end to end:

| | |
|---|---|
| `paths.ts` | `agentDir(id)`, `soul(id)`, `sessionsDir(id)`, `sessionShard(id, …)`, `sessionArchive(id, …)` |
| `session.manager.impl.ts` | `currentSession(volume, agentId)`, `session(volume, ref)` |
| `SessionRef` | `{ agentId, sessionId, startTs, deviceId }` |

Per-device sharding, union-by-id merge, and the *derived* current session (no
pointer file for two hosts to clobber) all come along unchanged.

### The one constant

There is exactly one place the id is decided:

```ts
// packages/agent/assistant.ts:107
const agentId = 'main'          // → a prop on createAssistant, defaulted to 'main'
```

`route()` already threads `MessageContext = { agentId }` everywhere below it. So
per-app agents are a thread-through, not a subsystem.

### The id scheme

Flat, one path segment, reserved prefixes. An id stays a single directory name,
so no code has to learn that it might contain a slash, and `ls /system/agents` is
the complete roster.

```
/system/agents/
  main/                          the overarching agent — reserved, seeded at boot
    soul.md                      the persona
    avatars/<id>/                the face
    sessions/                    its thread
  app.justfiles.dictionary/
    sessions/                    ← the ONLY thing a per-app agent owns
  app.justfiles.files/
    sessions/
```

App ids are already dotted (`justfiles.dictionary`), so `app.<appId>` reads
consistently and parses as "first segment is the kind". The alternative —
nesting as `agents/app/<appId>/` — groups more tidily in the Files app, but makes
an agent id stop being one path segment and makes "list every agent" a two-level
walk. Not worth it while the roster is small.

Keying on the **app** rather than the window is deliberate and currently free:
the reducer already uses the app id as the window id, and one-window-per-app is
*"policy, not identity"* (`apps/frieren/src/os/reducer.ts`). If a second window per app ever
arrives, one thread per app is still the answer you want.

### The same agent in another session

A per-app agent directory holds `sessions/` and nothing else. The app agent is
not a smaller or separate assistant. It uses the same soul, user profile,
memory, system-prompt blocks and tools as `main`. The implementation reuses the
same prompt builder and runtime setup. It does not copy identity files into the
app directory.

The only separate data is the session history. After building the same system
prompt as `main`, the host adds one short app-context block. It names the app
and tells the agent to inspect that app before it answers. This makes the app
agent the same companion in a different session, with a clear subject.

### Four rules that keep it from sprawling

1. **Maintenance is main's job.** `scheduleDailyAlarm` and memory consolidation
   stay pinned to `main`. Ten app threads must not mean ten daily alarms.
2. **One socket.** A thread is a tag on a frame, not a connection.
3. **The tools stay the same.** The app thread gets every tool available to
   `main`, with no per-app sandbox. We can narrow the tool set later if a real
   problem calls for it.
4. **App sessions grow and compact.** They do not use `main`'s six-hour idle
   retirement or create a journal summary. Normal context compaction keeps each
   session usable. Keep this policy isolated so it is easy to change later.

## Shell state

The mode preference and what is open are shell facts, so they live in
`os-state.json` beside `placements` — already synced, already keyed by window id,
and already tolerant of new fields (`loadSnapshot` validates a handful of keys and
`normalize`/`serializeOsState` spread the rest, so an older client round-trips
what it does not know).

```ts
placements: Record<string, WindowRect>
assistant: {
  mode: 'sheet' | 'sidebar'                 // one preference, whole desktop
  size: { sheet: number; sidebar: number }  // px, remembered per mode
  open: Record<string, true>                // SIDEBAR only — a sheet is never restored
}
```

`size` is two numbers rather than one on purpose: a comfortable sheet height and a
comfortable sidebar width are different numbers, and collapsing them means every
mode switch hands you a size that feels wrong once. `open` is sidebar-only
because restoring a sheet on boot would put a window back behind a scrim nobody
asked for.

## Code changes

| File | Change |
|------|--------|
| `packages/agent/assistant.ts` | Delete the `agentId` constant; take it as a prop defaulted to `'main'`. Reuse the full `main` system-prompt builder for every agent id, then append an optional context block. |
| `packages/agent/session.ts` | Add optional `agentId` and context prompt fields to `AgentSessionOptions`. Pass both down. Keep app sessions on grow-and-compact lifecycle policy. |
| `apps/frieren/worker/frieren.ts` | `this.session` → `Map<agentId, AgentSession>`; `getSession(agentId = 'main')`, built lazily. Give app sessions the same runtime and tools as `main`, plus the app-context prompt. Hibernation evicts the map, which is the right lifecycle — a thread costs a directory, not a process. Pin `scheduleDailyAlarm` to `main`. |
| `apps/frieren/worker/frieren.ts` (protocol) | `agent?: string` on `prompt`/`abort`, and on the `history`/`event` frames going back. Absent means `main`, so existing clients keep working. |
| `apps/frieren/src/os/client.ts` | The single block of agent state (messages / streaming / expression) becomes one entry per agent id; `client.agent` → `client.agent(id)`. |
| `apps/frieren/src/agent/MessagesPanel.tsx` | Takes an agent id; reused verbatim by both surfaces. |
| `packages/design/design.css` | `ds-window-footer` + the panel/scrim/seam chrome. |
| `apps/frieren/src/components/Window.tsx` | A `footer` slot. |
| `apps/frieren/src/os/AppWindow.tsx` | Render the footer + panel for `kind === 'app'`. |
| `apps/frieren/src/os/state.ts` | The `assistant` slice + its actions. |
| `packages/app-settings` | Appearance: the default mode. |

## Build order

1. **Key the session.** The thread-through above, end to end, no UI. *Done when
   two threads run over one socket and land in two directories.*
2. **Add the footer.** Chrome, slot, button, OS state. The button toggles the
   flag and nothing else yet. *Done when every app window has a footer that dims
   with the window and the flag survives a reload.*
3. **Raise the sheet.** An absolutely positioned panel plus a scrim inside the
   window body — no layout change to the app at all. *Done when you can hold a
   conversation about an app, close the window, reopen it, and the thread is
   still there, with the app's layout never having moved.*
4. **Add the sidebar.** The real split: seam drag, minimum app width with sheet
   fallback, the in-header swap control, the Settings default. *Done when
   swapping modes moves the panel and changes nothing else — same thread, same
   scroll position, same draft.*
5. **Teach the agent where it is.** Reuse the full `main` system prompt and tool
   setup, then add one context block that names the attached app and tells the
   agent to inspect its state. *Done when the app agent has the same soul and
   user information as `main`, and "what am I looking at?" is answered without
   the app being named.*

Steps 1–4 are plumbing and geometry. **Step 5 is where this succeeds or
disappoints** — what makes an attached agent feel attached is whether it
reliably orients itself before answering, and that is a prompt and a habit, not a
panel. Budget real time for it.

## Growth surfaces

- **An app's own status line** — the footer's leading slot. Needs an SDK surface,
  so not until an app wants one.
- **Pointing at something** — an optional referent channel: one
  `report({ text, ref })` beside `invoke`/`subscribe` on the GUI client, held in
  memory, never synced. The host bridge already has the unused hook for it
  (`guiHost`'s `onMessage`, `packages/app/iframe.ts`). It makes "what does *this*
  mean?" sharper; it is not what makes the panel work.
- **A third mode** — undocked: the panel as its own leashed window, for output
  too big for either dock or a second display. `mode` has room for the value.
