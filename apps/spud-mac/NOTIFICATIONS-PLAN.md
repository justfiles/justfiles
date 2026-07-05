_apps/quay · plan_

# Notifications — a portable `notify` capability, one channel per host

Proactively inform the user of important state when no surface is in front of them. The portable core
is a **`notify` capability** + a **shared `Notification` type** in `@justfiles/app`; each host
implements one **channel** that projects a notification onto its platform — quay → macOS
`UNUserNotificationCenter`, frieren → web push / in-tab toast. Same type, same producer code, same
capability across hosts; only the channel differs (as it must). See `DESIGN.md` §3 (daemon), §7
(capabilities & the trust boundary), §8 (agent), §12 (notifications are native-touching);
`NATIVE-LAUNCHER-PLAN.md` (the warm chat webview + bridges); and `packages/app/kernel.ts` (the host
seams this rides).

Two motivating use cases drive the design; only the first is in scope now:

1. **Realtime agent state (active).** Work done, the agent asking a question (with selectable
   options), and errors that need action (auth expired, token limit).
2. **System background jobs (deferred).** Scheduled cron jobs and reminders (a reminder/calendar app,
   important email) that fire with **no UI open**.

The active work is small. It's sliced so each lands and verifies on its own; the deferred phase is
sketched only enough that case 2 — and frieren as a second host — slot in without reshaping the seam.

## Why a capability, not the kernel

The kernel (`kernel.ts`) is a **pure app-state machine** — dispatch → reduce → commit → emit
`app.update`. Its portability comes from being *narrow*; it deliberately knows nothing about humans,
channels, or presentation. Notification *delivery* is the opposite: it reaches a person over a
platform-specific channel, and the right channel depends on the **deployment topology** (what's
running while the user is away). That topology even differs *within* frieren — the Durable Object
notifies via web push, the browser tab via an in-page toast — which is the clearest sign delivery is a
host concern, not a kernel one. The kernel also can't be the unifying point anyway: the biggest
producers (the agent, cron) aren't apps and never enter the kernel.

So we reuse the seam the system already has for cross-host services (`ai`, `volume`, `accounts`): a
**capability** with a shared contract and a per-host implementation. Bonus — because a capability is
**kernel-mediated**, the kernel attaches the calling app's *declared* scopes, so a notification is
**securely stamped `source = <appId>`** (an app can't spoof another's identity). That source is what
click-routing keys off, handed to us for free by the existing trust boundary (`DESIGN.md` §7).

> **Keep delivery and scheduling distinct.** Case 2 bundles "scheduled jobs," but *scheduling* is a
> separate portability story: a durable timer that re-enters as a `dispatch` is deterministic and
> app-state-shaped — genuinely kernel-material, and the kernel already reserves an (empty) `clock`
> seam for it (`kernel.ts:65`, `type Clock = object`). *Notifying* still goes out the capability.
> Don't let scheduling drag delivery into the kernel.

## Portability: one capability, two channels

| Piece | Where it lives | Portable? |
|---|---|---|
| `Notification` + `Route` type | `@justfiles/app/capabilities/notify` | **shared** |
| `notify` capability (`notifyHost(channel)`) | `@justfiles/app/capabilities/notify/host` | **shared** |
| Agent's notify-producing code (done/error/question) | `@justfiles/agent` (already shared by both hosts) | **shared** |
| The **channel** (the actual banner) | per host | host-specific |

The per-host **channel** is the convergence point; three producers feed it through one shape:

```
producers                                                              host channel        platform
  apps (reducers) --command--> notify capability (kernel: source=appId) --\
  agent (host service, trusted) ------------------------------------------- +--> Channel --> quay:    ws → UNUserNotificationCenter
  cron / system ----------------------------------------------------------- /                frieren: web push / in-tab toast
```

The agent and cron are trusted host services, so they call the channel **directly** (`source:'agent'`
/ `'system'`). Sandboxed apps reach the *same* channel through the `notify` capability — the kernel
stamps `source` for them. quay wires `notify: notifyHost(quayChannel)` into its registry now
(`host.ts:83`); frieren wires `notifyHost(webPushChannel)` against the identical contract later.

## Headline decisions

- **The channel delivers unconditionally; each host's sink suppresses by focus.** Whether to actually
  show a banner depends on whether the relevant surface is in front — which only the sink knows (quay:
  the panel is key; frieren: the tab is visible/focused). So producers never gate; the sink drops the
  banner when the chat surface is focused (the transcript already shows the result). Suppression is a
  per-source policy: case-1 agent notifications suppress when chat is focused; case-2 reminders ignore
  focus.
- **Questions are structured transcript messages, not blocking elicitation.** The agent does **not**
  suspend mid-turn (which would turn `prompt()` into a coroutine). It emits a message carrying
  `{question, options}`, the turn **completes**, and the user's pick is just the **next `prompt`**.
  Selections render in the shared `<Transcript/>`; the banner only announces + opens chat.
- **Case-1 durability is free.** The durable record of an agent notification's subject already lives
  in the **agent transcript** (the runtime persists the session to the Volume). The banner is a
  transient projection — a ping, not a store. A dedicated `/system/notifications` Volume store is only
  needed for case-2 system notifications that aren't part of a transcript (Phase 2).
- **Keep the model stingy (`CLAUDE.md`).** Implement only the fields a slice needs; do **not** add
  case-2 fields (`durable`, `scheduledAt`, `actions[]`) speculatively. The model is documented as
  extensible, grown per slice.

## The shared shape

One type, exported from `@justfiles/app/capabilities/notify`, imported by the agent and both hosts:

```ts
interface Notification {
  id: string
  source: string                 // 'agent' | <appId> | 'system'  — apps' set by the kernel
  kind: 'info' | 'error' | 'question'   // grows: 'progress' | 'reminder' (Phase 2)
  title: string
  body: string
  threadId?: string              // coalesce/replace key → the channel's native dedup id
  route?: Route                  // where a click goes
  // Phase 2 adds: durable?, scheduledAt?, actions[] — not before their slice.
}

type Route =
  | { kind: 'chat' }                         // summon the host's chat surface
  | { kind: 'app'; id: string }              // open a mini-app
  | { kind: 'settings'; pane?: string }      // e.g. accounts → reconnect
```

The capability is `notifyHost(channel: (n: Notification) => void)`: it receives a kernel-mediated
invocation, stamps `source = appId`, and hands the `Notification` to the host's channel. quay's
channel broadcasts `{ type: 'notification', notification }` to its launcher sockets; frieren's pushes
to the browser. The chat webview ignores the frame (its `onmessage` only handles `{type:'agent'}`);
the native `CatalogClient` handles it.

---

# Phase 1 — realtime agent state (active, quay channel)

## Slice 1 — the capability + the quay channel + native sink + "work done"  ⟵ end-to-end

**Goal:** the portable seam exists and is proven through quay: a `notify` capability + shared type, a
quay channel, a native sink, and the agent emitting an `info` notification when a turn finishes while
you're away. Click reveals the chat with the answer.

**Touches:**
- `packages/app/capabilities/notify/{types,host}.ts` (new) — the `Notification` + `Route` type; a
  `notifyHost(channel)` capability that stamps `source = appId` and forwards to the channel. A unit
  test: an app emitting a notify command → the channel receives it with the kernel-stamped source.
- `quayd/host.ts` — register `notify: notifyHost(channel)` in `capabilityRegistry` (`:83`); accept the
  channel as a deferred indirection (mirror `onInstalled`, defaulting to a no-op).
- `quayd/server.ts` — `serve` gains `served.notify(n)` broadcasting `{type:'notification', n}` to
  `launchers` (mirrors `broadcastCatalog`, `:119`); add `notify` to `Served`. This **is** the quay
  channel.
- `quayd/main.ts` — bind the channel after `serve()` (the deferred pattern, `:25,86`):
  `let channel = ()=>{}`, pass `(n)=>channel(n)` to both `createHost` and `createQuayAgent`, then
  `channel = served.notify`.
- `quayd/agent.ts` — `createQuayAgent(host, opts?)` takes the channel; in `prompt()` after pushing the
  assistant message (`:128`) emit a `done` notification (`kind:'info'`, `source:'agent'`,
  `route:{kind:'chat'}`, `threadId:'agent'`).
- `native/Notifier.swift` (new) — `UNUserNotificationCenter` wrapper: request authorization at launch,
  register categories (info/error/question), `post(Notification)` (request identifier from `threadId`
  so a re-post coalesces; `categoryIdentifier = kind`), delegate `didReceive` → resolve `route`.
- `native/Catalog.swift` — add `onNotification: ((Notification) -> Void)?`; handle `type ==
  "notification"` in `handle()` (`:79`).
- `native/Launcher.swift` — wire `catalog.onNotification`; **suppress** when `panel.isVisible &&
  panel.isKeyWindow`; route `{kind:'chat'}` via `show()` + `enterChat`.
- `native/build.sh` — add `Notifier.swift` to the `swiftc` sources; link `UserNotifications`.

**Verify:** `pnpm typecheck && pnpm test` green (incl. the capability test). Build (`cd
apps/quay/native && ./build.sh --launcher`), grant the one-time permission. Summon → ask the agent
something slow → click away (panel hides). On completion a banner appears; click → the panel returns
to chat showing the answer. With chat focused, **no** banner — the transcript just updates.

> **Spike first:** confirm `UNUserNotificationCenter` authorization works for the **ad-hoc-signed**
> (`codesign -s -`) launcher bundle before building on it (see Risks).

## Slice 2 — typed errors with a fix-it route (auth, token limit)

**Goal:** when a turn fails on something the user can act on, an `error` notification carries a
"Reconnect" route; the transcript shows an error block instead of a flattened string.

**Touches:**
- `quayd/agent.ts` — classify at the `prompt` catch (`:125`): auth/expired-token → `error` +
  `route:{kind:'settings', pane:'accounts'}`; token-limit → `error` (route to chat); else a generic
  `error`. Push a structured error message into the transcript.
- `@justfiles/ui` `Transcript` + `AgentMessage` — add a minimal error rendering (an `error?: true`
  flag on the message, an error-styled block). Stingy: one field, not a union.
- `native/Launcher.swift` + `Notifier.swift` — handle `{kind:'settings'}` (open the Settings app
  bundle, `pane` as a hint); optionally a "Reconnect" action on the `error` category.

**Verify:** expire/disconnect ChatGPT (or point the LLM at a dead endpoint) → prompt → an error banner
with Reconnect → click routes to Settings → Accounts; the transcript shows the error block.

## Slice 3 — questions with selectable options

**Goal:** the agent can ask a multiple-choice question; away, a `question` banner announces it; click
opens chat to the options; picking one resolves as a normal next turn.

**Touches:**
- `quayd/agent.ts` — register an `ask_user` tool (added to the tools array, `:87`) that records a
  structured question (`{question, options}`) as the assistant turn and emits a `question`
  notification (`route:{kind:'chat'}`), then **the turn completes** — no suspension.
- `@justfiles/ui` `Transcript` + `AgentMessage` — add `options?: { label: string }[]` and an
  `onOption?(label)` prop; render the options as clickable rows when present.
- `launcher-ui/chat.tsx` — wire `onOption` → `quaySend(label)` (the pick is just the next prompt,
  reusing the existing input bridge, `:79`).
- `native/Launcher.swift` — `question` route → summon chat (the options render inline). *Refinement
  (optional):* top options as banner action buttons (needs per-category dynamic registration — see
  Risks); v1 keeps selections in the transcript.

**Verify:** ask the agent something ambiguous so it calls `ask_user` → away → a question banner →
click → chat shows the options → pick one → it resolves as a normal turn. Frieren's chat (also using
the shared `Transcript`) renders the options block unchanged.

---

# Phase 2 — system background jobs + the second host (deferred)

Out of scope now; listed so the seam above is built to receive them. Each is a producer/channel/
lifecycle change, not a reshaping of the capability.

## Slice 4 — durability + replay + inbox

**Goal:** notifications that aren't part of a transcript (reminders, cron results) survive a swiped
banner and a daemon restart. Persist them to `/system/notifications` (Volume = truth, OS banner =
one-way projection — the `.app`-materialisation pattern, `DESIGN.md` §5); the channel queues for
disconnected sinks and **replays on connect** (the `CatalogClient` already reconnects); a small
notification-center inbox surfaces unread/pending items.

## Slice 5 — scheduling (the `clock` seam) + reminders

**Goal:** time-based triggers, kept *distinct* from delivery. A durable timer re-enters as a
`dispatch` via the kernel's reserved `clock` seam (`kernel.ts:65`) — portable, deterministic,
app-state-shaped. A reminder mini-app is then the **first real app producer**, notifying through the
`notify` capability (kernel-stamped `source = <its appId>`, so its banner routes back to it).

## Slice 6 — persistent lifecycle + the frieren channel

**Goal (lifecycle):** drop the idle-exit (`server.ts:54`, `DESIGN.md` §3/§12) — run `quayd` **and**
`Quay.app` as `launchd` LaunchAgents so jobs fire and banners post with **no UI open**. Because the
channel is already client-agnostic, this is a lifecycle swap, not a rewrite.

**Goal (portability payoff):** implement the **frieren channel** — `notifyHost(webPushChannel)`
against the identical contract: web push + service worker for the background case (the DO analogue of
quay's daemon), an in-tab toast when the tab is focused, and the same `Route` resolved by focusing/
opening the PWA. The agent's producer code and the `notify` capability are reused **verbatim**; only
this channel is new. This is where the capability framing pays off — quay and frieren run the same
notification system.

---

## Reuse vs. new

**Reused:** the capability registry + trust boundary (`host.ts:83`, `DESIGN.md` §7) for secure
`source` stamping; the launcher's `CatalogClient` socket + reconnect (`Catalog.swift`); the warm chat
webview + `quaySend`/`quayAbort` bridges; the shared `@justfiles/ui` `Transcript`; the deferred-binding
pattern (`onInstalled`, `main.ts`); the panel's own key/visibility state for suppression; the Settings
→ Accounts route target (`host.ts` accounts). For frieren (Slice 6): the entire shared layer — type,
capability, agent producers — unchanged.

**New (portable):** `@justfiles/app/capabilities/notify` (the type + `notifyHost`). **New (quay):**
`Served.notify` channel; the agent producers (`done`/`error`/`ask_user`); `Transcript`/`AgentMessage`
enrichment (error flag + options); native `Notifier.swift` (`UNUserNotificationCenter`) +
`Catalog.onNotification` + `Launcher` routing; the `UserNotifications` link in `build.sh`.

## Risks / decisions to lock

- **Ad-hoc signing × `UNUserNotificationCenter` auth.** Verify in Slice 1 before building on it.
  Fallback only if it proves unusable for ad-hoc bundles: the deprecated `NSUserNotification`.
- **LSUIElement click-to-activate.** Confirm a notification click brings the borderless panel forward
  cleanly given the resign-key auto-hide (`Launcher.swift:312`).
- **Banner action buttons.** macOS registers actions per category up front; arbitrary per-notification
  buttons need on-the-fly category registration. Keep selections in the `Transcript` for v1; banner
  buttons are a refinement.
- **Coalescing granularity.** `threadId` maps to the channel's native dedup id (macOS request
  identifier; web Notification `tag`) so a re-post replaces. Decide the grain — start with a single
  `'agent'` thread.
- **Source is the kernel's to stamp.** Apps never set `source`; the capability derives it from the
  kernel-attached `appId`. The agent/cron (trusted) set it directly.
- **Model stinginess.** Add fields per slice; do not pull in Phase-2 fields (`durable`,
  `scheduledAt`, `actions[]`) until their slice.

## Testing

After JS/TS changes: `pnpm format && pnpm typecheck && pnpm lint:fix && pnpm test` (the `notify`
capability gets a unit test in Slice 1). Native builds via `apps/quay/native/build.sh --launcher`
(then `./restart.sh`). Notification permission, the global hotkey, and click-through are **manual**
checks (synthetic events don't reach them).
