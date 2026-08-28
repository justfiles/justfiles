# The crease: folding the agent's interior

> Status: **Phase 4 implemented.** Both hosts render the same settled activity
> creases and load disposable detail only when opened. Missing detail expires
> cleanly, transcript scrolling stays with the opened disclosure, and daily
> maintenance bounds the detail cache by age and size.
>
> The implemented transport starts with one `snapshot` containing durable history
> and the current `TranscriptStatus`. Durable additions then arrive as `item`
> messages; `status` replaces only what the agent is doing now. Live activity
> remains disposable and settled history remains authoritative. The wire carries
> the shared presentation model, never raw session storage entries.

## Handoff after Phase 4

PR [#597](https://github.com/xiaoxinghu/justfiles/pull/597) merged the
session-message foundation on 2026-08-28 at `29184047`. PR
[#599](https://github.com/xiaoxinghu/justfiles/pull/599) implements Phase 1 on
that contract by recording completed activity runs. Phase 2 builds the shared
settled projection and detail reads on top. Phase 3 replaces raw browser events
with disposable live status. Phase 4 renders and retains that presentation model.
All four planned phases are implemented. Do not rebuild the lifecycle, recorder,
settled projector or live-status projector.

### What has landed

- `packages/agent/session.ts` now owns one `SessionStatus`, durable history and
  prompt admission. It publishes `snapshot`, `items` and `status` updates.
- `packages/agent/protocol.ts` maps session updates and prompt admission to five
  small messages: `snapshot`, `item`, `status`, `accepted` and `rejected`.
- A user entry is appended and published before model work. Completed output
  entries are published before the final idle status.
- Frieren uses one WebSocket per agent session at
  `/api/agents/:agentId/connect`. Its `/ws` socket now carries control traffic
  only. The shared session messages contain no agent ID.
- Mac's `/agent` socket represents its one agent session and uses the same
  session message types.
- Both clients apply `item` messages incrementally. A reconnect starts with a
  fresh `snapshot`; there is no replay log, revision or active-turn reducer.
- Snapshot, item and status sends are serialized per session. Prompt admission
  is sent before unrelated alarm storage work, so `accepted` cannot arrive
  behind a fast terminal status.
- `ActivityRunEntry`, `ActivitySummary` and `ActivityDetail` now describe the
  durable receipt and disposable body. Legacy thinking, tool-call and
  tool-result entries remain in the read union.
- `packages/agent/activity.ts` consumes a completed turn in chronological order.
  Text, questions, user messages and tool-produced images close the current run.
  Repeated tools and mixed thinking/tool runs keep their original order.
- Thinking and tool durations come from raw `AgentEvent`s inside
  `@justfiles/agent`. Clients do not rebuild durable activity from live events.
- Detail files live at
  `/private/cache/agent-activity/<agent>/<session>/<detail>.json`. The path is
  local, agent-scoped and session-scoped, outside synced session shards.
- The recorder writes each detail file before session history references it. If
  the detail write fails, it appends the receipt without a `detailId` and still
  persists the conversation.
- `ask_user` now persists as an assistant message with inline options. Its tool
  result is omitted from activity. Tool-produced image references stay on the
  activity receipt, outside the detail body.
- `buildSessionContext()` and `prepareCompaction()` ignore activity entries.
  Daily-note extraction and memory consolidation continue to consume their
  filtered conversation inputs and never read activity detail.
- `@justfiles/agent/protocol` owns `TranscriptItem`, `TranscriptActivity`,
  `TranscriptStatus` and `sessionEntriesToTranscriptItems()`.
- Snapshot and incremental item messages have one fixed `TranscriptItem` payload.
  `SessionServerMessage` can no longer be instantiated with raw `SessionEntry`.
- The projector keeps settled entry IDs, strips expression tags only for Frieren,
  projects questions and notes, groups legacy thinking and tools, and emits images
  as stable plain image items after their activity run.
- Legacy inline activity gets an opaque synthetic detail ID. Detail reads rebuild
  its body from the old shard without rewriting it.
- `activity_detail` requests and results use the existing session socket and a
  caller-owned request ID. Missing, corrupt and unknown details return `expired`.
- Frieren and Mac project before sending. Their clients retain the received
  transcript items directly, and both host-specific history projectors are gone.
- The shared `Transcript` accepts settled items alongside the temporary live
  `AgentMessage` shape. It renders messages, images and the disposable live row
  now, but deliberately skips settled activity rows until Phase 4.
- `SessionServerMessage` carries `TranscriptStatus`, never `SessionStatus` or raw
  `AgentEvent`. Mac maps all non-idle work to one busy status.
- Frieren's worker accumulates stripped response text and maps tools to short
  phrases. Expression changes use a separate Frieren-only message so browser
  pacing stays independent of transcript status.
- Frieren keeps one client-owned temporary row while work runs. Each status
  replaces it, idle drops it, and settled items remain authoritative.
- The shared transcript renders one settled crease per activity item. It lazily
  reads detail on open, renders notes and thinking as prose, keeps tool bodies in
  monospace, and shows an expired state when the sidecar is gone.
- Failed runs open by default. All other settled activity starts folded.
- Opening a disclosure detaches bottom pinning before content grows, then reveals
  only the overflow while keeping the disclosure button visible.
- Daily Frieren maintenance deletes detail older than 30 days, then deletes the
  oldest remaining files until the cache is at most 100 MiB. Large sweeps resume
  in bounded alarm slices.

### What has not landed

- Multiple selectable sessions, older-history pagination and richer detail
  inspectors remain separate work.

### Decisions that are closed

- Keep the mockup and visual behavior. Implementation work must fit the design,
  not redesign it.
- Durable session entries are storage. `TranscriptItem` is presentation. The
  backend performs that translation before data crosses the wire.
- Full thinking and tool bodies live in disposable sidecars. Session history
  holds a small receipt. Model context, compaction and memory never read the
  sidecar.
- `ask_user` is conversation, not interior activity. It stays inline with its
  options.
- A session has one replaceable status and append-only settled history. Do not
  restore `ActiveTurn`, turn start or finish messages, an append message type,
  or a client lifecycle reducer.
- Abort means "stop the work currently running in this session" and carries no
  turn ID. A delayed abort from one client can cancel newer work started by
  another client. That rare stale-abort race is accepted to keep the contract
  small.
- A dropped connection loses live detail. Reconnect with a snapshot and carry
  on. Mid-turn replay and exact restoration are out of scope.
- One agent still has one selected session. Multiple selectable sessions and
  older-history pagination are separate work.

### Implementation status

The four planned phases are complete. New work should treat the session protocol,
settled projection, disposable status, crease UI and detail retention as the
current contract.

Visual mockups, interactive: [`mockups.html`](./mockups.html). Open it in a
browser. Press **Play turn**; the two switches in the frame header change real
decisions, not styling.

## The problem

Every tool call is a permanent row in the thread. A five-step turn buries the one
sentence the user asked for under five rows of scaffolding that were only ever
interesting while they were running. Thinking has the same shape and the same
problem. `compaction`, `branch_summary` and `label` are worse because they reach
the transcript wearing the agent's voice.

The end user should see the answer. The person debugging should be able to see
everything. Those are two views of the same turn.

## The line: response, or interior

A design language needs one test, not a list of cases. This one holds for every
kind that exists today and every kind worth adding:

> **Does it invite or require the user's attention?**
> Yes: it is the **response**, and it renders plainly.
> No: it is **interior**, and it folds.

The test earns its keep immediately, because it settles `ask_user`. An
`ask_user` tool call asks for the user's next response, so it is a response, and
it should render as a question with clickable options, never as a tool row. Mac
already does this (`platform/mac/ui/launcher/agentChat.tsx`); frieren does not.
The rule predicts the host that got it right.

### Kinds

Three UI kinds cover everything the session model has today. `compaction`,
`branch_summary` and `label` collapse into one `note` kind. They differ in what
produced them, not in how they read.

| Kind | Persisted input | Folded label | Body |
| --- | --- | --- | --- |
| `think` | activity summary; legacy `assistant_thinking` | Thought for 6.2s | Prose |
| `tool` | activity summary; legacy `tool_call` + `tool_result` | Reading Transcript.tsx | Mono, args and result |
| `note` | `compaction`, `branch_summary`, `label` | Compacted 40 messages | Prose, or nothing |

## The shape

The status line and the seam occupy the same place in chronological order,
**above the reply the work produced**.

```text
[user message]
⟳ Reading Transcript.tsx    2.3s        ← live row
                                          (spinner, plain-words phrase, 58%)
                ↓  turn finishes; history replaces the live row

─── 6 steps · 7.4s ──────────────  ⌄     ← history crease
                                          (fold mark, summary, rule, 34%)
[assistant reply]
```

Position is the whole reason this works. The tool calls happen *before* the
reply, so a seam underneath reads backwards. Above it, the turn is chronological
and the seam appears where the status line was.

It also survives the case that breaks the naive design: an **interleaved** turn,
where the agent narrates, works, then narrates again. Below the reply there is
nowhere sensible to put that seam. Above it, the turn just reads in order.

### Two small views

The running row and settled crease share typography and position, but they are
independent views. The running row has a spinner, phrase and elapsed time. The
settled crease has a fold mark, summary and hairline rule. The next session state
removes the first and inserts the second with authoritative history.

Do not preserve a React node across that replacement. The settled crease uses
its `SessionEntry.id`; the temporary row uses a client-owned ID. This may skip
the mockup's settle animation, which is preferable to adding a live item state
machine for a decorative transition.

The unfold is two properties animating together. Height alone reads as an
accordion; the hinge is what makes it paper:

```css
/* clip: animatable height without measuring */
.crease-body { display: grid; grid-template-rows: 0fr;
  transition: grid-template-rows 320ms cubic-bezier(.2,.9,.25,1); }
.crease[data-open="true"] .crease-body { grid-template-rows: 1fr; }

/* hinge: top origin, plus the crease's own shadow */
.crease-sheet {
  transform-origin: top center;
  transform: perspective(760px) rotateX(-74deg);
  box-shadow: inset 0 9px 11px -9px rgba(0,0,0,.3);
}
```

Under `prefers-reduced-motion`, drop the `rotateX` and the rule sweep, keep the
fades. The hinge is decorative; the disclosure is not.

### Uniform shell, kind-owned content

The crease owns chronological position, the hairline, disclosure and row layout.
Each settled item supplies a label and body. Tools use mono for arguments and
results. Thinking and notes use prose. A failed tool marks the run as failed and
opens it by default.

The live row is smaller still. The worker sends a plain phrase such as `Thinking`
or `Reading Transcript.tsx`; the client shows the phrase with a spinner. It does
not receive or assemble a partially complete activity item.

### Grouping and labels

**One crease per contiguous run of interior activity.** A text block breaks the
run. A mixed run of thinking and tools is one seam, because it was one unit of
work. The mockup's *By kind* switch shows the cost of the alternative: four seams
where one would do, and the thread goes stripey.

**Labels specialise when a run is homogeneous.** Counting is the fallback, not
the rule:

| Run | Label |
| --- | --- |
| All `think` | `Thought for 8.4s` |
| One entry | That entry's own phrase, `Listed packages/ui · 0.2s` |
| Mixed | `6 steps · 7.4s` |

`1 step · 0.2s` says nothing the phrase does not say better. The kind already
produced the phrase for the status line.

**Hold each running phrase ~400ms minimum.** A burst of fast tools otherwise
strobes the line into something less readable than the rows it replaced.

## What the codebase already has

`SessionEntry` in `packages/agent/session.manager.ts` is the ordered, typed,
append-only history. It already has `tool_call`, `tool_result`, `compaction`,
`branch_summary` and `label` entries. Its schema also admits
`assistant_thinking`, but the persistence path in `packages/agent/assistant.ts`
does not write that entry today. Thinking only exists in live
`thinking_delta` events and disappears on reload.

The current storage model gets one important thing right. Model context,
compaction and daily-note extraction do not consume raw tool calls or results:

- `buildSessionContext()` emits user and assistant text plus the latest
  compaction summary.
- `prepareCompaction()` counts and summarises user and assistant text only.
- session retirement calls `takeNotes()` with that filtered context.

Keep those filters. Persisting enough activity for the transcript must not make
tool output part of model context or memory extraction.

### History and status are different things

The old lifecycle mixed durable history with the state of current work. Starting
or finishing a prompt replaced both values, even though history usually only grew
by one or two items. It also exposed `ActiveTurn`, turn IDs, start and finish
events, plus a client reducer that reconstructed whether the session was busy.

The implemented contract has one durable value and one ephemeral value:

```ts
export type SessionStatus =
	| { state: 'idle' }
	| {
			state: 'thinking' | 'calling_tool' | 'responding'
			detail?: AgentEvent
	  }

export type SessionServerMessage =
	| { type: 'snapshot'; history: readonly TranscriptItem[]; status: TranscriptStatus }
	| { type: 'item'; item: TranscriptItem }
	| { type: 'status'; status: TranscriptStatus; error?: AgentError }
	| { type: 'accepted' }
	| { type: 'rejected'; reason: 'busy' }
	| { type: 'activity_detail'; requestId: string; result: ActivityDetailResult }
```

These are application messages, not WebSocket frames. The shared types therefore
use `Message`, never `Frame`.

`snapshot` is the one complete read. It is sent on connect and in response to an
explicit history request, catching the client up with settled history and what
the agent is doing now. After that, `item` extends history and `status` replaces
the current status. `{ state: 'idle' }` is the completion signal; there is no
separate `done` message.

The session persists the user's entry before asking the model and publishes it as
an item. Connected clients therefore see the prompt without an `ActiveTurn`
placeholder. When the model finishes, the session publishes the persisted output
items, then idle status. A reset sends an empty snapshot. Storage reconciliation
also sends a snapshot when the change cannot be expressed as an append.

Internal `SessionStatus.detail` carries the latest raw agent update to the host.
It is current, in-memory data, not session history. Frieren maps it to
`TranscriptStatus` before sending, while Mac maps every non-idle state to one busy
status. A reconnect still uses `status.state` to block another prompt.

Prompt admission is command traffic. The sender receives `accepted` or
`rejected`; every client receives the same session status and durable items.
Abort targets the current work in that session, so it carries no turn ID. This
deliberately gives up stale-abort protection in exchange for a smaller contract.

Each host serializes snapshot, item and status sends per session. An update is
therefore either included in the snapshot or delivered after it. No revision is
needed for one ordered WebSocket with no replay. Errors stay transient on the
idle status and are not added to history.

The shared session messages contain no agent ID. Mac's `/agent` socket represents
one session. Frieren keeps `/ws` for control traffic and opens one
`/api/agents/:agentId/connect` socket per agent session. The Worker binds the
agent ID during upgrade, sends a snapshot, then routes every message on that
socket to the same session.

### Before Phase 2, the payload projection drifted

The old flattening happened twice, independently, and the copies did not agree:

| | `platform/frieren/worker/display.ts` | `platform/mac/ui/launcher/agentChat.tsx` |
| --- | --- | --- |
| function | `sessionEntries2DisplayMessages` | `sessionEntriesToMessages` |
| `SessionServerMessage` payload | projected `DisplayMessage` | raw `SessionEntry` |
| runs | worker-side before `updateMessages` | client-side after receipt |
| `ask_user` | a raw tool row | a question bubble with options |
| `compaction` | `{ role: 'assistant', content: summary }` | dropped |
| `branch_summary` | `{ role: 'assistant', content: summary }` | dropped |
| `label` | `` { content: `[${label}]` } `` | dropped |

So on Frieren a user scrolling back saw the agent apparently announce a
compaction summary, or say `[before refactor]`, in the voice it answers questions
in. On Mac those events vanished. Both were wrong, in opposite directions, and
neither was a rendering bug. The presentation model lacked a category.

Phase 2 removed both projectors and fixed settled IDs. Phase 3 removed the live
divergence. Frieren now keeps one temporary phrase or partial response, then drops
it when settled history arrives. Phase 4 will render the settled activity item as
a crease. Remounting the temporary row when the turn ends remains allowed.

## Storage, context and presentation are separate

The durable history stays small. Full detail is a cache, and the wire carries a
presentation model:

```text
SessionEntry receipt + optional detail file
                 |
                 +-- model context: user/assistant text + compaction
                 +-- memory input: user/assistant text only
                 +-- history projection: TranscriptItem[]
                 +-- detail read: full body or expired
```

### One receipt per crease

The persistence transform collects each contiguous run of thinking and tools,
then writes one completed entry when the run ends:

```ts
type ActivitySummary =
	| { kind: 'think'; durationMs: number }
	| { kind: 'tool'; name: string; label: string; durationMs: number; failed?: true }

type ActivityRunEntry = EntryBase & {
	type: 'activity'
	items: ActivitySummary[]
	detailId?: string
	images?: ImageRef[]
}
```

The sidecar contains the full ordered body for that crease:

```ts
type ActivityDetail = {
	items: (
		| { kind: 'think'; content: string }
		| { kind: 'tool'; name: string; input: unknown; result: unknown; failed?: true }
	)[]
}
```

One crease therefore has one graph entry, one detail ID and at most one file.
Provider tool-call IDs may help the turn recorder assemble repeated or parallel
calls, but they stay inside that recorder. They are not session or wire concepts.

A message, question or image closes the current activity run. The turn recorder
writes the sidecar before appending its small receipt. A crash can leave an
unreferenced file or lose an unfinished activity run. Both are acceptable: the
conversation remains durable, and cache eviction eventually removes the file.

`ask_user` remains ordinary user-facing conversation. Add optional question
options to the assistant message entry and keep them inline, outside activity
detail. Tool-produced `ImageRef`s stay on the run receipt; the projector emits
them after the crease as ordinary image items.

Keep the old `assistant_thinking`, `tool_call` and `tool_result` shapes in the
read union. The projector groups those legacy entries into activity runs. New
writes use `ActivityRunEntry`; do not rewrite synced JSONL files.

### One settled projection

Both hosts call the same pure `sessionEntriesToTranscriptItems()` function before
sending history. Put the wire types and projector with `@justfiles/agent/protocol`,
without React or host imports. It owns these rules:

- `ask_user` becomes an assistant question with options; its result is omitted.
- legacy thinking and tools are grouped into activity runs.
- `compaction`, `branch_summary` and `label` become `note` runs.
- expression tags are stripped only when the session requested them.
- tool-produced images become plain image items.

The wire model is settled-only:

```ts
export type TranscriptActivity =
	| ActivitySummary
	| { kind: 'note'; label: string; body?: string }

export type TranscriptItem =
	| {
			id: string
			type: 'message'
			role: 'user'
			content: string
	  }
	| {
			id: string
			type: 'message'
			role: 'assistant'
			content: string
			options?: { label: string }[]
	  }
	| {
			id: string
			type: 'activity'
			label: string
			items: TranscriptActivity[]
			failed?: true
			detailId?: string
	  }
	| { id: string; type: 'image'; image: TranscriptImage }
```

`SessionEntry.id` is the settled item ID. History restore never invents browser
UUIDs. There is no settled `running` state and no promise that a temporary row
keeps its DOM identity when history replaces it.

Opening a crease sends an `activity_detail` request with `requestId` and opaque
`detailId`. The matching message returns either the full run or `expired` on the
same session connection. Detail reads do not affect history or `SessionStatus`.

`Transcript` takes one activity configuration prop:

```ts
activity?: {
	loadDetail?: (id: string) => Promise<
		| { status: 'available'; detail: ActivityDetail }
		| { status: 'expired' }
	>
}
```

Open state stays inside the component.

### Status detail is disposable

The lifecycle refactor already sends each raw `AgentEvent` as the optional detail
of a complete `SessionStatus`. For the crease, Frieren's worker maps that detail
to the current phrase or accumulated partial response before it crosses the wire:

```ts
export type TranscriptStatus =
	| { state: 'idle' }
	| { state: 'thinking'; label: string }
	| { state: 'calling_tool'; label: string }
	| { state: 'responding'; text: string }
```

Each `status` message replaces the previous value. `calling_tool` starts or
replaces the temporary status phrase. `responding` clears that phrase and shows
the accumulated partial response. The browser does not assemble tool arguments,
thinking bodies or activity receipts. Idle status discards the temporary view;
the durable `item` messages already hold the settled transcript.

The worker consumes expression tags before sending response text and emits
Frieren's avatar signal separately. Mac may ignore status detail and only use
idle versus non-idle. Both hosts use the same settled projection.

Each client stores history, the latest status and one local `submitting` boolean.
There is no remote phase union, turn ID or separate live-event message.

The turn recorder measures duration internally and writes it with the completed
run. Session entry timestamps are not suitable because one append batch gives
all entries the same timestamp.

### Ownership

| Concern | Owner |
| --- | --- |
| prompt admission and abort | agent session |
| durable history | snapshot and item messages |
| current agent status | one replaceable status message |
| reconnect | snapshot from the new socket |
| raw provider events and completed activity runs | backend turn recorder |
| session history to transcript meaning | shared projector |
| temporary text and status phrase | Frieren worker and client |
| detail expiry | daily cache sweep |
| disclosure and body rendering | `Transcript` |

No client rebuilds durable activity from streamed events. Compaction never
decides whether detail survives. The cache never changes session history.

## Detail retention

Full detail is a cache, not part of the session graph. Two limits govern it:

```text
delete files older than DETAIL_TTL
if total detail exceeds DETAIL_STORE_LIMIT, delete oldest files first
```

The existing daily maintenance job applies both limits across main and
app-attached agents. The exact constants stay server-owned and should be chosen
after measuring real sessions. They are not user settings.

Compaction, branching and session retirement do not participate. There are no
cleanup candidates, reachability checks, orphan classes or grace periods. A
sidecar-first crash simply leaves a cache entry that age or storage pressure will
remove. Cleanup is idempotent. A missing file returns `expired`, not a generic
server error.

The durable `ActivityRunEntry` remains after eviction, so history still shows
what ran, how long it took and whether it failed. Only the expandable body is
gone.

Neither compaction, `buildSessionContext()`, daily-note extraction nor memory
consolidation may dereference an activity sidecar. This is the hard boundary that
keeps a large terminal dump out of the user's memory.

### Precedent

AG-UI and the Vercel AI SDK use start, delta and end events for messages,
reasoning and tool calls. That supports inspecting partially streamed objects.
The crease does not need that capability, so its live protocol carries only text
and a status phrase. See [AG-UI events](https://docs.ag-ui.com/concepts/events)
and the [AI SDK UI stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol).

Codex separates its detailed internal rollout from typed, pageable app-server
history. See the
[rollout persistence policy](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/policy.rs)
and [app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).

OpenCode persists reasoning and tool parts, then marks older tool output as
compacted when building model context. The payload remains in storage, which is
the failure this plan avoids with separately prunable detail files. See its
[message model](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/message.ts)
and [compaction path](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/compaction.ts).

Hermes stores full history in SQLite but selects and prunes a separate request
copy. Its history search excludes tool output by default because it is usually
noise. See its [session storage](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md)
and [context engine](https://github.com/NousResearch/hermes-agent/blob/main/agent/context_engine.py).

Phoenix LiveView keeps server state authoritative and sends a view derived from
that state. The crease uses the smaller version of that pattern: replace the
current status and append settled items.
See the [LiveView lifecycle](https://hexdocs.pm/phoenix_live_view/Phoenix.LiveView.html).

Kubernetes uses `resourceVersion` because its watch API is a retained,
distributed change stream that clients may resume. This protocol has one ordered
WebSocket, per-session send queues and a fresh snapshot after reconnect, so a
revision would protect a topology the product does not have. See
[Kubernetes API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/)
and [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455.html).

S3 expires cached objects by age, and journald vacuums archived logs by age or
total size. Those policies fit disposable detail better than graph-aware garbage
collection. See [S3 lifecycle management](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
and [journalctl vacuuming](https://www.freedesktop.org/software/systemd/man/255/journalctl.html).

The shared lesson is separation. Full detail does not belong in model context,
memory input or the initial transcript response. This design goes one step
further and treats that detail as disposable.

## Delivery plan

### Phase 1: record completed activity runs

Status: complete. The implementation and tests live in `@justfiles/agent`.

- Add `ActivityRunEntry` and keep legacy inline activity entries readable.
- Collect thinking, tool arguments and tool results during a turn. Flush one
  receipt and one sidecar per contiguous run.
- Preserve text, activity, questions and images in their original order.
- Keep `ask_user` question text and options inline as conversation.
- Prove that model context, compaction and both memory paths never read detail
  files.
- Accept that a process crash may lose an unfinished run or leave a cache file.

### Phase 2: project once on the backend

Status: complete. The shared protocol projection and both host migrations are
implemented.

- Add protocol-owned `TranscriptItem`, `TranscriptStatus` and one shared
  `sessionEntriesToTranscriptItems()` projector.
- Project `snapshot` and `item` payloads before sending them. Keep
  prompt admission and activity-detail reads as command traffic.
- Keep the existing per-session send queues. Ignore messages from an old
  WebSocket after a replacement connection becomes current.
- Use the shared projector in Frieren and Mac. Delete both host-specific history
  projections and stop sending raw `SessionEntry` to browsers.
- Add `activity_detail` request/result variants. Fetch a body only when its
  crease opens.
- Test `ask_user`, notes, legacy history, repeated tools, images and an
  interleaved `think -> tool -> think` run.
- Test snapshots, incremental items, accepted and rejected admission, reconnect,
  socket replacement and abort.

### Phase 3: use disposable live updates

Status: complete. Browsers receive only `TranscriptStatus`; Frieren projects
partial responses and tool phrases in its worker, and Mac keeps busy versus idle.

- Map raw status detail to `TranscriptStatus` in the Frieren worker.
- Keep one temporary status phrase in the browser. Do not build live activity
  items or preserve their identity at settlement.
- Strip expression tags in the worker and keep avatar pacing in Frieren.
- When status becomes idle, discard the temporary view. Durable items already
  contain the settled transcript.
- Keep Mac on history and status messages. Token streaming on Mac is out of scope.

### Phase 4: render and retain

Status: complete. The shared crease, both host integrations and cache retention
are implemented and tested.

- Render one crease per projected activity run.
- **Render nothing for zero activity.** A turn that just answers must look
  exactly as it does today.
- Keep image items outside the crease.
- `tool` → mono `<pre>`, args and result, as today.
- `think` and `note` → prose. Body font, ~72% opacity, a left rule. Never `<pre>`.
- A run containing a failure opens by default and tints with `--danger`.
- Keep normal settled runs folded by default.
- Fix the scroll interaction below.
- Add the daily age and storage-limit eviction pass. Test age eviction, oldest
  first eviction and expired detail reads.
- Check both hosts render settled turns identically and reload preserves them.

## The scroll bug this creates

Real, and hit on day one. `Transcript.tsx:176` re-pins to the bottom on any
content growth while `stuckRef.current` is true:

```ts
const ro = new ResizeObserver(() => {
	if (stuckRef.current) toBottom()
})
```

Opening a crease halfway up the thread grows the content, the observer fires, and
the view yanks to the bottom, away from the thing the user just chose to look
at. The transcript passes an internal `onBeforeOpen` callback to each crease. It
sets `stuckRef.current = false` before the growth lands; this is not a public
component prop.

During a turn the status row is the last thing in the thread, so stick-to-bottom
keeps it visible. This bug only affects opening settled history.

After the unfold transition, if the sheet's bottom is below the viewport, scroll
by the overflow only. Keep the disclosure button visible; never jump to the
thread bottom. Closing before the transition ends restores the pin state captured
when opening began. A completed reveal scroll stays detached even when it lands
inside the bottom-pin slop.

## Accessibility

- Live row: put `role="status"`, `aria-live="polite"` and `aria-atomic` on
  the changing phrase only. Keep the elapsed timer outside that live region and
  mark it `aria-hidden`; otherwise every timer tick re-announces the whole row.
- Hold each live phrase for the same 400ms minimum used by the visual status.
- Settled: use a real `<button aria-expanded aria-controls>` with the label as
  its accessible name.
- A disclosure button is a sibling of its panel.
- Reduced motion: drop the hinge and the rule sweep, keep the fades.

## Four rules that keep it small

1. **One activity config prop.** It carries the default-open preference and
   detail loader. Per-crease open state is internal.
2. **History plus status.** Durable items append. One status value is replaced.
   Only `submitting` is local UI state.
3. **Interior never blocks.** Anything that requires or invites the user's
   attention is a response and renders plainly. That is the `ask_user` test.
4. **Detail is optional.** The receipt renders without its sidecar. Missing
   detail means expired, not corrupt history.

## What was rejected

Four directions were mocked up before this one. The others, and why not:

- **Reader Switch:** no per-turn affordance at all; one global control flips the
  whole transcript. This adds a preference for something each crease already
  controls in place.
- **Ribbon Rail:** a gutter in the left margin, hover to peek, click to pin. The
  only direction with a genuinely untouched text column, and the prettiest. Loses
  on discoverability (an unlabelled stripe) and does not survive touch.
- **Receipt Drawer:** a footnote chip that opens an inspector over the thread.
  Never reflows, and the trace gets real room. If a
  trace needs a diff, a screenshot, or 200 lines of JSON, the crease is too
  small and the drawer becomes a separate feature.
- **Told, Then Shown:** the status line settles into a past-tense sentence that
  expands into a timeline. It needs live and settled identity, so this design
  drops it.

The crease keeps activity in chronological order and gives detailed history one
local disclosure. That is enough reason to use it.
