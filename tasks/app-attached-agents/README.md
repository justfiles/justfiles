# App-attached agents

> Status: **Phases 1-7 implemented.** The shared browser
> component lives in `packages/ui`, the keyed session manager lives in
> `packages/agent`, and both hosts attach keyed conversations to app windows.
>
> Depends on doc 5 (the `/system/agents/<id>/` layout this fills in for the
> first time).

Source design set: [`platform/frieren/design/`](../../platform/frieren/design/) — read its
[README](../../platform/frieren/design/README.md) for the shared principles, and
[doc 5](../../platform/frieren/design/05-system-layout.md) for what this builds on.
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

Same component, same thread, same session. Each time the user opens the panel,
the host chooses the layout that fits the current window. Window size is the
first signal; screen work area and window position can refine the choice where a
host has them. There is no saved default. The footer is the constant affordance
in both layouts, the way the DevTools toggle stays in the browser toolbar no
matter where the panel is parked.

### One browser component, two window systems

The footer and both panel layouts belong to one controlled React component in
`packages/ui`, called `AttachedAgent` here. It receives the app body, the
conversation panel, mode, size and callbacks. It owns the footer markup, sheet
overlay, scrim, sidebar split, resize seam and mode switch. It does not know
about WebSockets, OS state or agent sessions.

Frieren renders `AttachedAgent` inside its React `Window`. Mac renders the same
component inside the app's existing `WKWebView`, with the app GUI mounted into
the component's app slot instead of directly into the document root. AppKit
still owns the native titlebar, traffic lights and window geometry. No Swift
copy of the footer or panel is needed.

The platform adapter supplies controlled state and a conversation panel. This
keeps the geometry identical without pretending Frieren's browser desktop and
macOS `NSWindow` are the same window system.

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

`AttachedAgent` renders the footer on **app windows only**. The conversation
window has no app to be about. Its styles live in `packages/design/design.css`
as `ds-window-footer`, following the titlebar's rules: the same `--surface` and
the same fade while the window is not focused.

```
├────────────────────────────────────┤
│                             [ ▲ ]  │   24px, --surface, 1px top rule
└────────────────────────────────────┘
  ↑ leading slot (empty in v1)   ↑ the agent button
```

- **Trailing:** the agent button — the face plus a chevron pointing where the
  panel will appear. It takes the accent tint while the panel is open and the
  chevron reverses. When a closed panel has a new result, a short notice may sit
  beside the button. The notice has no durable count or inbox.
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

**Sidebar** — a real split: the panel is a sibling of the shared app slot, taking
width the window had to spare. Frieren puts `AppViewport` in that slot; mac puts
the `gui.mount()` target there. Nothing is covered or dimmed, because the point
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
minimum width. If the current window cannot give both the app and sidebar enough
room, the button opens the **sheet**. A host may also consider free screen space
beside the window, but it must never resize or move the app merely to make a
sidebar fit. The narrow-width fallback remains active while the panel is open.

**Swapping.** The panel header carries one control — `⇥ side` in the sheet,
`⌄ sheet` in the sidebar — that hands the conversation over with the thread,
scroll position and composer draft intact. A manual switch applies to this
opening only. After the panel closes, the next open evaluates the current
geometry again.

## Behaviour

- **It never opens itself.** The agent's face may change expression — that
  channel already exists — and a finished turn may leave a notice in the app
  footer, but the panel appears because you pressed something.
- **Notifications stay in their app.** A per-app agent never sends its result to
  global notifications. If the owning app window is open, its footer
  may show a transient notice that opens the attached thread when pressed. If the
  app window is closed, discard the notice. Do not reopen the app and do not keep
  an unread queue for later.
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

On Frieren, keystrokes inside the app's sandboxed iframe never reach the shell.
`allow-scripts` without `allow-same-origin` means the parent document sees
nothing. The same limit already applies to `Window.tsx`'s
Escape-exits-fullscreen handler. Mac mounts its app and chrome in one document,
so a capture handler can see the key there, but the shared design cannot rely on
that. `⌘/` is opportunistic and the footer button is the primary control. The
sheet's scrim takes focus off the app, so Esc remains reliable in both hosts.

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

### One session manager

`createAgentSession` already owns the agent product: prompt construction,
identity, memory, tools, compaction, transcript storage, backend rebuilding,
notifications and classified errors. Both Frieren and mac call it today. The
remaining hard-coded singleton is the place where the id is decided:

```ts
// packages/agent/assistant.ts:107
const agentId = 'main'
```

`route()` already threads `MessageContext = { agentId }` everywhere below it.
Replace the singleton host API with one shared manager:

```ts
const agents = createAgentSessions({
	volume,
	backend,
	apps,
	osState,
	capabilities,
	notify,
	readDoc,
	timezone,
	expressions
})

agents.main()
agents.app(appId)
```

The manager memoizes both kinds lazily. `main()` selects the reserved `main`
session. `app(id)` derives `app.<id>`, adds the standard app-context block and
selects the app-session lifecycle. Platforms never construct agent ids, write
context prompt text or choose lifecycle flags. That policy belongs to
`packages/agent`, where both hosts use the exact same implementation.

The values passed to `createAgentSessions` are host adapters. The model and
credentials arrive through `AgentBackend`, but that is not the only platform
difference. Each host also supplies its `Volume`, `AppController`, notification
channel, docs reader, timezone source and optional capabilities. The package
owns the behaviour assembled from those adapters.

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
*"policy, not identity"* (`platform/frieren/src/os/reducer.ts`). If a second window per app ever
arrives, one thread per app is still the answer you want.

### The same agent in another session

A per-app agent directory holds `sessions/` and nothing else. The app agent is
not a smaller or separate assistant. It uses the same soul, user profile,
memory, system-prompt blocks and tools as `main`. The implementation reuses the
same prompt builder and runtime setup. It does not copy identity files into the
app directory.

The only separate data is the session history. After building the same system
prompt as `main`, `packages/agent` adds one short app-context block. It names
the app and tells the agent to inspect that app before it answers. This makes
the app agent the same companion in a different session, with a clear subject.

### Four rules that keep it from sprawling

1. **Maintenance is main's job.** `scheduleDailyAlarm` and memory consolidation
   stay pinned to `agents.main()`. The timer itself remains platform code because
   Cloudflare alarms and native timers are different. Ten app threads must not
   mean ten daily alarms.
2. **One socket per active thread.** Each host gives a keyed agent its own
   WebSocket. The agent id lives in the connection URL, so frames keep the
   existing untagged session protocol and inactive app threads hold no connection.
3. **The tools stay the same.** The app thread gets every tool available to
   `main`, with no per-app sandbox. We can narrow the tool set later if a real
   problem calls for it.
4. **App sessions grow and compact.** They do not use `main`'s six-hour idle
   retirement or create a journal summary. Normal context compaction keeps each
   session usable. `createAgentSessions` owns this distinction so the two hosts
   cannot drift.

## Shell state

The shared component is controlled. Panel size and restored sidebars are shell
facts, not UI or agent facts. Placement is a runtime decision. Each platform
adapter chooses it when the user opens the panel and keeps a manual override only
until that panel closes. The persisted shape is:

```ts
type AttachedAgentState = {
	size: { sheet: number; sidebar: number }  // px, remembered per mode
	open: Record<string, true>                // SIDEBAR only — a sheet is never restored
}
```

Frieren stores it as the `assistant` slice in `os-state.json` beside
`placements`. That file is already synced, keyed by window id and tolerant of
new fields. Mac stores the same values in its daemon-owned shell state, keyed by
app id; AppKit continues to own native window geometry. `packages/ui` only
receives values and callbacks.

`size` is two numbers rather than one on purpose: a comfortable sheet height and a
comfortable sidebar width are different numbers, and collapsing them means every
mode switch hands you a size that feels wrong once. There is no persisted mode.
`open` is sidebar-only because restoring a sheet on boot would put a window back
behind a scrim nobody asked for.

## Delivery plan

Each phase should merge on its own. Phases 1 and 2 change ownership without
changing behavior. Phase 3 builds the new chrome behind an absent-by-default
configuration, so production windows remain unchanged. Phases 5 and 6 turn the
feature on one host at a time.

```
1. shared app host ──> 3. shared chrome ──┐
                                          ├──> 5. Frieren ──┐
2. shared main agent -> 4. app sessions ──┤                 ├──> 7. adapt + parity
                                          └──> 6. mac ──────┘
```

### Phase 1: put both app bodies behind the shared component

This is the behavior-preserving UI extraction.

- Add `packages/ui/src/AttachedAgent.tsx` with one app slot. With no agent
  configuration it renders only that slot at the same size as its parent.
- Wrap Frieren's `AppViewport` with it inside `AppWindow`. Do not add a footer,
  state or agent imports.
- Change mac's app page from a direct `gui.mount(root, ...)` call to a React host.
  Keep the app's mount node named `root`, because app CSS may target `#root`.
  Mount the React host at a new outer node and pass the inner node to `gui.mount`.
- Preserve the GUI mount handle and call its `unmount` method when the host
  unmounts. Leave `Booter.swift`, the native titlebar and window sizing alone.

Done when Dictionary, Files and one stateful app render, update, resize and
unmount exactly as before on both hosts. The DOM gains a host wrapper, but no
visible pixels or network frames change.

### Phase 2: put both main agents behind one manager

This is the behavior-preserving agent extraction.

- Add `createAgentSessions(options)` in `packages/agent`. Its first version only
  exposes a lazy, memoized `main()` session built by the existing
  `createAgentSession`.
- Add a focused manager test proving repeated `main()` calls return one session
  and construction remains lazy.
- Replace Frieren's `private session` and mac's `sessionPromise` with the manager.
  Each host still supplies its existing backend, volume, app controller,
  notifications, docs, timezone and optional capabilities.
- Keep every main-agent behavior fixed: transcript path, system prompt, tools,
  expressions, notifications, maintenance and wire protocol.

Done when the existing agent tests pass unchanged and both current main-agent
UIs produce the same history and events. There is still no `app(id)` and no
protocol tag.

### Phase 3: build the attached chrome in `packages/ui`

Grow `AttachedAgent` without enabling it in either production host.

- Add one optional controlled configuration containing mode, open state, sizes,
  callbacks, footer content and the conversation-panel node. Omitting it keeps
  Phase 1's pass-through behavior.
- Add the footer, sheet, scrim, sidebar split, resize seam, close controls and
  mode switch. Put their styles in `packages/design/design.css`.
- Keep one panel DOM node and change its layout with CSS. Moving between sheet
  and sidebar must not remount it, because that would lose scroll position and
  composer draft.
- Compute an effective mode from the requested mode and available width. A
  narrow window falls back to sheet.
- Implement pointer resizing, keyboard resizing, Escape for the sheet and the
  minimum app width.
- Exercise the component in `packages/ui/dev` with a fake app and fake
  conversation. Cover narrow, wide, focused and inactive states in both themes.
- Unit-test the effective-mode calculation. Give the fake panel a draft and
  mount counter so a sheet/sidebar switch catches an accidental remount.

Done when the playground matches the mockups, mode changes preserve local panel
state, and both production hosts still omit the optional configuration and look
unchanged.

### Phase 4: add per-app sessions inside `packages/agent`

Keep this phase below the transport layer.

- Add `app(appId)` to `createAgentSessions`. It derives `app.<appId>` and
  memoizes one lazy session per app.
- Remove the hard-coded `main` id from `assistant.ts`. Pass the resolved session
  id, context block and lifecycle policy through package-internal calls.
- Reuse `main`'s backend resolver, soul, user profile, memory, prompt builder,
  skills, tools and capabilities. Platforms do not pass alternate prompt text
  or tool lists for app sessions.
- Build the app-context block in `packages/agent`. Resolve the app name through
  the injected `AppController` and tell the agent to inspect that app before it
  answers.
- Keep six-hour retirement, journal summaries and maintenance on `main`.
  App sessions resume their newest thread and rely on normal compaction.

Done when package tests prove that main and app sessions use the same injected
backend and tools, write to different transcript directories, survive a fresh
manager, and follow their respective retirement policies.

### Phase 5: connect Frieren

- Give every agent id its own connection URL. Keep the existing untagged prompt,
  abort, history and event frames inside that connection; omitting the id selects
  `main`.
- Change the browser client from one agent state block to state keyed by agent
  id. Keep the existing global provider and omnibar bound to `main`.
- Let `MessagesPanel` take an agent id and pass it as the panel node to
  `AttachedAgent`.
- Add the `assistant` slice to Frieren OS state. Persist both sizes and restored
  sidebar-open windows. Never restore a sheet open.
- Enable the controlled configuration only for app windows. Hold it open while
  its session is streaming.
- Keep alarm scheduling and daily memory maintenance pinned to
  `agents.main()`.

Done when two app panels and the global chat can run concurrent turns over their
keyed sockets, reload into their own histories, and update their app windows visibly.
The Frieren browser smoke check must cover sheet dismissal, sidebar resizing,
narrow-width fallback, mode switching and reload restoration.

### Phase 6: connect mac

- Add keyed agent connection URLs to mac while keeping `/agent` as `main`, so
  the launcher and its native composer do not change.
- Publish agent events by id and update `useAgentChat` to select one id. Do not
  give the app GUI's `mount` context an agent transport; the web host owns it.
- Add daemon-owned shell state for both sizes and restored sidebar-open app ids.
  Leave native window geometry in AppKit autosave.
- Pass the keyed conversation adapter and controlled state into the shared
  component installed in Phase 1.
- Keep the native booter unchanged. Footer, sheet and sidebar all render inside
  the existing app `WKWebView`.

Done when the launcher still shows `main`, two native app windows keep separate
threads, mode switching preserves panel state, and restarting an app restores
only its sidebar. Daemon protocol tests and a shipped mac build must pass.

### Phase 7: adaptive placement, local notifications and parity

Parity results and the expected host-only prompt differences are recorded in
[`PARITY.md`](./PARITY.md).

- Remove the stored mode preference introduced while connecting the two hosts.
  On every explicit open, choose sheet or sidebar from the current app viewport.
  Prefer the sidebar only when the app can keep its minimum width beside the
  remembered sidebar size. Otherwise use the sheet.
- Keep placement policy in a shared pure function. Window size is required.
  Screen work area and app-window position are optional host inputs that may
  improve the decision. Neither host adds a Settings control or persists the
  result. A manual mode switch lasts until the panel closes.
- Keep per-app agent notifications inside the owning open app. The footer is the
  place for a notice when the panel is closed; pressing it reveals the
  attached thread. Do not publish these notices to the global notification
  channel, persist them or open an app that is no longer running.
- Verify that the footer follows focus styling, a reply in flight cannot be
  dismissed, sheet state is never restored and sidebar state is restored.
- Run the same scripted conversation against Frieren and mac. Compare the
  shared prompt blocks, app orientation and transcript paths. Record expected
  differences caused by injected adapters, such as host-only capabilities,
  rather than requiring byte-identical complete prompts.

Done when both hosts make the same placement decision for the same geometry,
keep app-agent notices inside a live app window, and use the same `AttachedAgent`
component and `createAgentSessions` implementation. Platform code stays limited
to adapters, protocol delivery and persistence. The orientation test is the
final product check: "what am I looking at?" must work without naming the app.

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
