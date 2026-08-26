_platform/frieren · plan_

# Notifications — the frieren channel, projected onto the omnibar

Proactively inform the user of important state when no surface is in front of them: the agent
finishing work, asking a question, or hitting an error that needs action — and later, background jobs
that fire with no tab open. The **model is already built and shared**; this plan wires the *frieren
host* into it and gives the system its **presentation**: the omnibar pill is the ambient banner, and
the omnibar dropup is the notification center.

This is the **second host** for the portable `notify` seam. quay (macOS) already rides it end-to-end
(`platform/spud-mac/NOTIFICATIONS-PLAN.md`, Slices 1–3 → `UNUserNotificationCenter`). frieren reuses the
type, the capability, and the agent's producer code **verbatim**; only the *channel* (delivery) and
the *presentation* (the pill/dropup) are new — as they must be, per host.

> **Read first:** `packages/app/capabilities/notify/{types,host,index}.ts` (the shared contract),
> `packages/agent/session.ts` (the agent producer + `ping`), `platform/spud-mac/NOTIFICATIONS-PLAN.md`
> (the sibling host, the same decisions), and `platform/frieren/design/01-omnibar.md` (the surface this
> rides — the pill's presence channels and the "sheet is a growth surface" model).

## What already exists (do not rebuild)

- **The shared shape + capability.** `packages/app/capabilities/notify/`:
  `Notification = { id, source, kind: 'info'|'error'|'question', title, body, threadId?, route? }`,
  `Route = {kind:'chat'} | {kind:'app',id} | {kind:'settings',pane?}`, and `notifyHost(channel)` —
  which stamps `source = appId` from the kernel's trusted identity (an app can't spoof another's
  source) and forwards the `Notification` to the host's `Channel`.
- **The agent producer.** `packages/agent/session.ts`: `createAgentSession({ …, notify?, title? })`.
  On turn-done it `ping`s `info`; on a classified failure `error` (with a fix-it `route`); on
  `ask_user` `question`. It only fires **if a `notify` channel is passed** — and frieren passes none
  today (`worker/frieren.ts:209`). Wiring the channel lights up the agent's notifications with zero
  producer changes.

## What frieren is missing

- `worker/frieren.ts:209` calls `createAgentSession` with **no `notify`** → the agent's pings die.
- `src/apps/capabilities.client.ts` `clientCapabilities` **does not register `notify`** → apps can't
  notify.
- **No presentation** — no banner, no center, no unread affordance, no web push. No host has built a
  universal notification UI yet; frieren builds the first one, on the omnibar.

## Why the omnibar (and not a corner banner)

The safe, macOS-clone choice is a stack of banners in the top-right that fade after a few seconds.
frieren already has a better-suited surface, and using it is not novelty for its own sake — it answers
a question `design/01-omnibar.md` explicitly left open (*"Does the persistent bar host status too… or
stay purely an input?"*) and **generalizes a mechanism the omnibar already ships**:

- The pill's **presence** already surfaces one agent notification — the `needs-you` state renders the
  pending `ask_user` **question** in the placeholder slot ("Frieren: which folder?"), and the first
  keystroke hands the slot back to the input. That is exactly the contention rule a notification
  needs; it exists and is documented. So "notifications on the pill" **folds `needs-you` into the
  general model** — a simplification, not a new system.
- A corner banner stack would re-introduce the *unrequested corner occlusion* the omnibar's
  engagement model deliberately rejected. The pill is always in view, never covers content, and is
  where routing already happens — so an actionable notification's click resolves **in place** (open
  the app, focus the chat at the answer, open Settings → Accounts), the frieren edge over an OS that
  bounces you to a separate app.

**Presentation is a per-host sink, not the model.** Everything in `@justfiles/app`/`@justfiles/agent`
is untouched. Only frieren's *browser sink* changes: instead of a corner overlay, it feeds the
omnibar's presence slot + the dropup. Swapping the sink can't reshape the seam.

## Portability: one capability, two frieren sinks, one UI

Within frieren the topology has two delivery points feeding one presentation:

```
producers                              sinks (per topology)               one UI (browser)
  apps (browser kernel) --notify-->     browser channel ─┐
  agent / cron (the DO) --/ws frame-->  ws frame handler ─┼─► notification store ─► pill (ambient banner)
                          web push -->  service worker ───┘     (ring buffer,      ─► dropup (center)
                          (no tab open → OS-level notification)   +DND, +seen)     ─► pill bell-badge
```

- **App notifications** run entirely in the browser (apps dispatch on the local kernel) → a `notify`
  channel in `clientCapabilities` writes straight to the store. No DO round-trip; **works offline**.
- **Agent / cron notifications** originate in the DO → its `notify` channel broadcasts a new
  `{ type: 'notification', notification }` frame over the existing `/ws` socket. When **no tab is
  connected** (Phase 2), the DO also fires **web push** → an OS-level notification; on reconnect the
  client **replays** unseen center entries.
- Both converge on **one store → one pill slot, one dropup, one badge.**

| Piece | Where | Portable? |
|---|---|---|
| `Notification` + `Route` type, `notifyHost` | `@justfiles/app/capabilities/notify` | **shared** (reused) |
| Agent's `done`/`error`/`question` producers | `@justfiles/agent` | **shared** (reused) |
| DO channel (`notify` → `/ws` frame; later web push) | `worker/frieren.ts` | frieren |
| Browser channel (`notifyHost` → store) | `src/apps/capabilities.client.ts` | frieren |
| Notification store + pill sink + dropup center | `src/notifications/`, `src/shell/Omnibar.tsx` | frieren |

## Headline decisions

- **The pill is the ambient banner; the dropup is the center.** Reuse the pill's two presence
  channels: the **glow ring** carries urgency (the existing `needs-you` pulse; `error` gets a distinct
  urgent ring), the **text slot** carries the notification title/body, and the **action button** sits
  on the pill's right edge — the slot `frn-omnibar-chat-toggle` already occupies. Clicking it runs the
  same route dispatch a banner click would. The dropup adds a 4th sheet mode (grid / list / transcript
  / **notifications**), newest nearest the input.
- **Contention is already solved.** A notification owns the pill only when the input is **empty and
  unfocused** (the shipped placeholder rule). Typing or focusing instantly reclaims the input; the
  notification recedes to the center with an unread badge. Non-negotiable, and already the `needs-you`
  behaviour.
- **Lifetime is driven by urgency, not a constant** (freedesktop `urgency`; dunst). `info` shows in
  the pill ~8s then recedes to history + badge; `error`/`question` are **sticky** — they hold the pill
  until acted on or dismissed (identical to `needs-you` today). The dismiss timer **pauses while the
  tab is hidden** (`document.hidden`) and on hover — so a notification is never lost to a glance away
  (dunst `pause_on_mouse_over` / `idle_threshold`).
- **The sink suppresses by focus; producers never gate** (same rule as quay). The browser sink drops
  the pill banner when the surface the click targets is already in front — an agent `info`/`question`
  with the chat window focused just updates the transcript, no banner. It still lands in the center.
  `error` and reminders ignore focus.
- **Coalescing by `threadId`** (freedesktop `replaces_id` / dunst stack tags). A re-post under the
  same `threadId` **replaces** the pill item and its center entry rather than stacking; the agent
  already uses `threadId:'agent'`. The pill shows the single most-urgent-then-newest item with a
  "+N" when more are queued; the dropup holds all.
- **Case-1 durability is free; the center is a lightweight log.** The agent transcript already holds
  the durable subject of an agent notification (the runtime persists the session). The center entry is
  a **pointer** (title/body/route/time/source), not a copy of the transcript. `transient: true`
  (freedesktop) shows a banner but is **never** logged — for ephemeral status that shouldn't clutter
  the center.
- **Where global toggles live: the menubar, not a button row.** DND and other system toggles go in
  the menubar's right-hand group (`DesktopShell`) — the conventional home for system chrome, and the
  answer `01-omnibar.md` leans toward for "system status." The **only** omnibar-side affordance is a
  contextual **bell-badge on the pill** that appears when there's unread history (mirroring how the
  chat toggle appears once a session exists). No permanent button row — it collides with "at rest the
  omnibar is just the pill" and the anti-dock-tax stance. Reach for contextual affordances first; add a
  toolbar only if real usage proves things undiscoverable.
- **Keep the model stingy (`CLAUDE.md`).** Implement only the fields a slice needs. `transient`,
  `urgency`, `actions[]`, `scheduledAt` are grown per slice — not pulled in speculatively.

## The shared shape (imported, not redefined)

```ts
interface Notification {
  id: string
  source: string                         // 'agent' | <appId> | 'system' — apps' set by the kernel
  kind: 'info' | 'error' | 'question'    // grows per slice
  title: string
  body: string
  threadId?: string                      // coalesce/replace key
  route?: Route                          // where a click goes
}
type Route =
  | { kind: 'chat' }                     // focus the agent window / open the sheet transcript
  | { kind: 'app'; id: string }          // launch/focus a mini-app window
  | { kind: 'settings'; pane?: string }  // open the Settings app (e.g. accounts → reconnect)
```

Route resolution reuses OS-store dispatches: `{kind:'chat'}` → `agent.openWindow` / `window.focus`
(`AGENT_WINDOW_ID`); `{kind:'app',id}` → `app.open`; `{kind:'settings'}` → `app.open` for
`computer.spud.settings`. Routing is *just a dispatch* — the store already knows how.

---

# Phase 1 — realtime agent state (active)

## Slice 1 — the frieren channel + the notification store + the pill sink + the dropup center

**Goal:** end-to-end proof through the agent. A `notify` channel on the DO, a client store, the pill
rendering the ambient banner, the dropup rendering history, focus suppression, and urgency lifetimes.
Away from chat, a finished turn shows in the pill; clicking routes to the answer. `error`/`question`
are sticky and route.

**Touches:**
- `worker/frieren.ts` — build a `notify` channel that broadcasts `{ type: 'notification', notification }`
  over `/ws` (mirrors `broadcast`, `:324`), and pass it (+ `title`) to `createAgentSession` (`:209`).
  Add `notification` to the `ServerMessage` union.
- `src/os/client.ts` — handle the `notification` frame in `handleFrame` → hand it to the store (a new
  `onNotification` sink on the client, mirroring `onRemoteWindow`). Add `notification` to `ServerFrame`.
- `src/notifications/store.ts` (new) — the client store (BehaviorSubject via `useSyncExternalStore`,
  like `os/client.ts`): a bounded ring buffer (~50), `notify(n)`, `list()`, `markSeen()`,
  `dismiss(id)`, `clear()`, and a derived **active** item (most-urgent-then-newest unseen, with
  `threadId` coalescing). In-memory this slice; persistence is Slice 3.
- `src/notifications/hooks.ts` (new) — `useNotifications()` / `useActiveNotification()`.
- `src/shell/Omnibar.tsx` — fold notifications into presence: the pill's **text slot** and **glow
  ring** read the active notification (generalizing the `needs-you` branch, which becomes the
  `question` case); an **action button** on the right runs the route; a **bell-badge** appears when
  unread history exists and opens the dropup. Add a **notifications mode** to the sheet
  (`showNotifications`) rendering the center list. **Focus suppression:** the sink skips the pill
  banner when the click target is already focused (chat window focused ⇒ agent `info`/`question`
  updates silently).
- `src/notifications/lifetime.ts` (new, small) — per-kind dismiss timers (`info` ~8s; `error`/
  `question` sticky), paused on `document.hidden` and hover.
- `src/app.css` — pill notification/action/badge styling + dropup list; reuse tokens (`--surface`,
  `--rule`, `--text`, `--focus`) and the existing `data-agent` glow.

**Verify:** ask the agent something slow, switch to another window → on completion the pill shows the
banner + a route button; click → the chat window focuses at the answer. With chat focused, **no**
banner — the transcript just updates. Force an error (AI off) → sticky pill banner + "Open Settings" →
routes to Settings → Accounts. `ask_user` → the question holds the pill (the old `needs-you` path,
now general); picking answers it. The dropup lists all, grouped by source, and clears.

## Slice 2 — the `notify` capability for apps

**Goal:** any sandboxed app can ping; the kernel stamps `source = appId`, and the pill/center attribute
it to that app and route clicks back to it.

**Touches:**
- `src/apps/capabilities.client.ts` — register `notify: notifyHost(browserChannel)` in
  `clientCapabilities`, where `browserChannel` writes to the notification store.

**Verify:** a test app calls `notify(...)` → pill banner + center entry attributed to the app; clicking
launches/focuses its window. An app cannot spoof another `source` (the capability's unit test already
covers the stamping).

---

# Phase 2 — durability + the background case (deferred)

Out of scope now; sketched so Slice 1's store is built to receive them. Each is a store/channel/
lifecycle change, not a reshaping of the seam.

## Slice 3 — Volume persistence + cross-device + replay-on-connect

Back the store with **`/system/notifications.json`** on the synced Volume (the `os/persistence.ts`
pattern — debounced persist effect, corrupt-safe load). Payoff: the center **survives reload**, **syncs
across devices for free** (dismiss on laptop → gone on phone — macOS needs iCloud for this), and the
client **replays** unseen entries on `/ws` (re)connect (the DO produced them while the tab was gone).

## Slice 4 — Do Not Disturb + `transient`

A DND toggle in the menubar's right group; `transient: true` short-circuits persistence (banner only);
`error` (and later `urgency: 'critical'`) **pierces** DND (freedesktop). Binary DND for v1 — dunst's
pause-*levels* are deferred until asked.

## Slice 5 — web push (true background, no tab open)

Service worker + push subscription; the DO fires web push from its `notify` channel (and the daily
`alarm()`, `:344`) when `ctx.getWebSockets()` has no live agent socket. This is the "no UI open" case —
the real second-host payoff, and where cron/reminders land. The producer code and capability are reused
unchanged; only this delivery path is new.

## Slice 6 — rich `actions[]`

Add the Phase-2 `actions[]` field; render buttons in the pill (beyond the single route) and in each
center row. A web UI shows real buttons where dunst can only show an indicator.

---

## Reuse vs. new

**Reused:** the `notify` capability + trust boundary (secure `source` stamping); the agent's
`done`/`error`/`ask_user` producers; the OS-store route dispatches (`app.open`, `agent.openWindow`,
`window.focus`) and the Settings app target; the omnibar's presence model (glow + placeholder slot) and
its contention rule; the sheet's multi-mode surface; the `/ws` broadcast + `os/client.ts` frame
handling; the `os/persistence.ts` Volume-snapshot pattern (Slice 3).

**New:** the DO `notify` channel + `notification` `ServerMessage` (Slice 1); the browser `notify`
channel (Slice 2); `src/notifications/` (store, hooks, lifetime); the omnibar pill sink + dropup center
+ bell-badge; Volume persistence (Slice 3); DND + `transient` (Slice 4); web push (Slice 5);
`actions[]` (Slice 6).

## Risks / decisions to lock

- **Fullscreen hides the omnibar** (`DesktopShell`: `{fullscreenId ? null : <Omnibar/>}`). A pill-only
  model surfaces nothing during a fullscreen app. **Decision:** accept it for v1 — the item waits in
  history + badge on exit, and web push (Slice 5) covers the truly-away case. Do **not** build a
  fullscreen overlay until a real critical-during-fullscreen need appears.
- **Single ambient slot.** The pill shows one item; the queue + "+N" + dropup covers the rest. Accepted
  as a feature (no corner pile-up), not a gap.
- **Attention for a non-fullscreen error.** The pill is subtler than a corner banner; the urgent glow +
  sticky behaviour + action button compensate. If proven too quiet, consider a one-shot overlay for
  `critical` only — not before.
- **`info` in the center or transient?** Lean **persisted** (the center is the "what happened while I
  was away" view) as a lightweight pointer, not a transcript copy. Errors/questions always persist.
- **Coalescing grain.** Keep the agent on a single `threadId:'agent'` (matching quay) initially.
- **Source is the kernel's to stamp.** Apps never set `source`; the capability derives it. Agent/cron
  (trusted) set it directly.

## Testing

After JS/TS changes: `pnpm format && pnpm typecheck && pnpm lint:fix && pnpm test`. The notification
store gets unit tests (coalescing by `threadId`, ring-buffer cap, urgency lifetime, seen/dismiss). For
the omnibar UI, do the LLM-driven smoke checks (`AGENTS.md` → `pnpm run verify:ui`), not full e2e:
away-from-chat banner + route click, focus suppression, sticky error, the dropup center, and the
bell-badge. Web push (Slice 5) permission is a manual check.
