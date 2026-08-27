# The crease: folding the agent's interior

> Status: **design, no code yet.** Changes one shared component
> (`packages/ui/src/Transcript.tsx`), one shared type, and the three places that
> build messages for it. Replaces the permanent tool-call rows with a live status
> line and one fold per turn. Nets **fewer** fields on `AgentMessage`, not more.
>
> Along the way it fixes an existing drift: frieren and mac project the same
> `SessionEntry` stream into messages independently, and the two projections
> already disagree about three things.

Visual mockups, interactive: [`mockups.html`](./mockups.html) — open it in a
browser. Press **Play turn**; the two switches in the frame header change real
decisions, not styling.

## The problem

Every tool call is a permanent row in the thread. A five-step turn buries the one
sentence the user asked for under five rows of scaffolding that were only ever
interesting while they were running. Thinking has the same shape and the same
problem, and `compaction`, `branch_summary` and `label` are worse — they reach
the transcript wearing the agent's voice.

The end user should see the answer. The person debugging should be able to see
everything. Those are not in tension; they are two states of the same thing.

## The line: response, or interior

A design language needs one test, not a list of cases. This one holds for every
kind that exists today and every kind worth adding:

> **Does it invite or require the user's attention?**
> Yes — it is the **response**, and it renders plainly.
> No — it is **interior**, and it folds.

The test earns its keep immediately, because it settles `ask_user`. An
`ask_user` tool call blocks on a human, so it is a response, and it should render
as a question with clickable options — never as a tool row. Mac already does
this (`platform/mac/ui/launcher/agentChat.tsx`); frieren does not. The rule
predicts the host that got it right.

### Kinds

Three UI kinds cover everything the session model has today. `compaction`,
`branch_summary` and `label` collapse into one `note` kind — they differ in what
produced them, not in how they read.

| Kind | SessionEntry | Folded label | Body |
| --- | --- | --- | --- |
| `think` | `assistant_thinking` | Thought for 6.2s | Prose |
| `tool` | `tool_call` + `tool_result` | Reading Transcript.tsx | Mono — args, result |
| `note` | `compaction`, `branch_summary`, `label` | Compacted 40 messages | Prose, or nothing |

Speculative kinds — `delegate`, `recall`, `wait` — are in
[Growth surfaces](#growth-surfaces). They are not built now, but the language is
checked against them in the mockups, and `delegate` is the one that justifies
picking a fold over the alternatives.

## The shape

The status line and the seam are the same element in two phases, sitting in
chronological order — **above the reply the work produced**.

```text
[user message]
⟳ Reading Transcript.tsx    2.3s        ← phase: running
                                          (spinner, plain-words phrase, 58%)
                ↓  settles in place, no remount

─── 6 steps · 7.4s ──────────────  ⌄     ← phase: settled
                                          (fold mark, summary, rule, 34%)
[assistant reply]
```

Position is the whole reason this works. The tool calls happen *before* the
reply, so a seam underneath reads backwards. Above it, the turn is chronological
— and the seam ends up exactly where the status line already was, so nothing has
to be destroyed and nothing has to be created.

It also survives the case that breaks the naive design: an **interleaved** turn,
where the agent narrates, works, then narrates again. Below the reply there is
nowhere sensible to put that seam. Above it, the turn just reads in order.

### One node, two phases

Everything in the transition is CSS keyed off `data-phase`. There is no animation
code:

- the spinner shrinks out as the fold mark scales in,
- the live phrase and the settled label cross-fade in one grid cell,
- the hairline rule sweeps right from the text,
- opacity drops 58% → 34%.

Settling does not change the node's height, so nothing jumps. React keeps the
node across the phase change as long as the key is stable — key it on the first
activity's id.

The unfold is two properties animating together. Height alone reads as an
accordion; the hinge is what makes it paper:

```css
/* clip — animatable height without measuring */
.crease-body { display: grid; grid-template-rows: 0fr;
  transition: grid-template-rows 320ms cubic-bezier(.2,.9,.25,1); }
.crease[data-open="true"] .crease-body { grid-template-rows: 1fr; }

/* hinge — top origin, plus the crease's own shadow */
.crease-sheet {
  transform-origin: top center;
  transform: perspective(760px) rotateX(-74deg);
  box-shadow: inset 0 9px 11px -9px rgba(0,0,0,.3);
}
```

Under `prefers-reduced-motion`, drop the `rotateX` and the rule sweep, keep the
fades. The hinge is decorative; the disclosure is not.

### Uniform shell, kind-owned content

The language is only useful if it says what a new kind **may not** change. Five
things are fixed forever:

1. Chronological position — in the thread, above the response it produced.
2. The two phases and the settle between them.
3. The seam: same hairline, same label grammar, same fold.
4. Row chrome: status dot, kind word, one line, duration.
5. Disclosure: a row opens on click; a failure opens itself.

A kind supplies exactly three things:

```ts
// The Crease owns position, phase, seam, row chrome, disclosure.
// A kind owns only what it says and how its body reads.
interface KindView<A> {
	live(a: A): string     // "Reading Transcript.tsx" — present tense, status line
	rest(a: A): string     // "Transcript.tsx"         — one line, settled row
	body(a: A): ReactNode  // <pre> for tools, prose for think and note
}
```

The third is the one that matters. **Thinking must never render in mono.** It is
natural language; `<pre>` makes it read like a log. The current code already
knows this — `Transcript.tsx` passes `mono={false}` to `SystemRow` for thinking —
which is the kind-specific body rule, discovered once and hardcoded in one place.

The status dot carries **status only** (running / done / failed). The kind is a
lowercase word in mono: `think`, `read`, `bash`, `note`. At 5px a glyph turns to
mud, and a word needs no legend and no icon design for every kind added later.

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
| One entry | That entry's own phrase — `Listed packages/ui · 0.2s` |
| Mixed | `6 steps · 7.4s` |

`1 step · 0.2s` says nothing the phrase does not say better, and the phrase is
free — the kind already produced it for the status line.

**Hold each running phrase ~400ms minimum.** A burst of fast tools otherwise
strobes the line into something less readable than the rows it replaced.

## What the codebase already has

`SessionEntry` in `packages/agent/session.manager.ts` is already the ordered,
typed, append-only stream this design wants. `assistant_thinking`, `tool_call`,
`tool_result`, `compaction`, `branch_summary` and `label` all sit side by side in
one union, in order.

The information is destroyed on the way to the UI. `AgentMessage` has
`thinking?: string` and `toolCalls?: ToolCallInfo[]` — two separate buckets — so
nothing can record that the agent thought, called a tool, then thought again.
Chronological placement is impossible against that shape. **This is the only
blocking change.**

### Two projections that have drifted

The flattening happens twice, independently, and the copies no longer agree:

| | `platform/frieren/worker/display.ts` | `platform/mac/ui/launcher/agentChat.tsx` |
| --- | --- | --- |
| function | `sessionEntries2DisplayMessages` | `sessionEntriesToMessages` |
| runs | worker-side, on history replay | client-side, on entry push |
| `ask_user` | a raw tool row | a question bubble with options |
| `compaction` | `{ role: 'assistant', content: summary }` | dropped |
| `branch_summary` | `{ role: 'assistant', content: summary }` | dropped |
| `label` | `` { content: `[${label}]` } `` | dropped |

So on frieren a user scrolling back sees the agent apparently announce a
compaction summary, or say `[before refactor]`, in the voice it answers questions
in. On mac those events vanish. Both are wrong, in opposite directions, and
neither is a rendering bug — it is a missing category.

There is a third divergence inside frieren alone. During streaming,
`platform/frieren/src/os/client.ts` seeds one message with both `thinking: ''`
and `toolCalls: []` (`message_start`) and accumulates deltas onto it. On replay,
`display.ts` gives thinking its *own* message. **The same turn renders
differently live than it does after a reload.** One ordered list removes the
divergence by construction.

## The data model

Two fields become one ordered list. This is a net reduction in
`TranscriptProps`' surface, which is the point.

```ts
// packages/ui/src/Transcript.tsx

export type ActivityStatus = 'running' | 'done'

/** Anything the agent did that was not addressed to the user. */
export type Activity =
	| { id: string; kind: 'think'; status: ActivityStatus; text: string }
	| {
			id: string
			kind: 'tool'
			status: ActivityStatus
			name: string
			args: unknown
			result?: unknown
			isError?: boolean
			images?: TranscriptImage[]
	  }
	| {
			id: string
			kind: 'note'
			status: ActivityStatus
			label: string   // "Compacted 40 messages"
			text?: string   // the summary, when there is one
	  }

export interface AgentMessage {
	id: string
	role: 'user' | 'assistant'
	content: string
	source?: 'user' | 'app'
-	thinking?: string
-	toolCalls?: ToolCallInfo[]
+	activity?: Activity[]   // ordered; interleaves with content
	error?: true
	options?: { label: string }[]
}

/** Back-compat: frieren's agent/types.ts re-exports this, and images.ts
 *  depends on the shape. Nothing outside the package moves on day one. */
export type ToolCallInfo = Extract<Activity, { kind: 'tool' }>
```

One new prop, and only one:

```ts
// The user's preference — the only thing the component cannot know.
// Per-turn open state stays internal; hosts have no business knowing
// which crease is open.
expandTools?: boolean
```

Resist a `renderActivity` escape hatch until a second host actually needs one.

## Delivery plan

### Phase 1: the status line, on the existing data model

Ship the perceived win by itself, before touching any types.

- In `MessageItem`, stop rendering `ToolCallRow` and the thinking `SystemRow`
  when `expandTools` is false (the default).
- Derive one live row from the tail of the thread and render it after
  `messages.map`, not inside a message — inside, it leaves a hole when it goes.
- Add the tool-name → phrase table. Unknown tools fall back to
  `` `Running ${name}` ``, never a raw JSON blob.
- `expandTools` restores today's rows, unchanged, in today's position.

Small diff, fully reversible, and it makes the rest concrete instead of
theoretical.

### Phase 2: one ordered `activity[]`

The blocking change, and the only risky one. No visual change beyond ordering.

- Add the `Activity` union to `packages/ui`; keep `ToolCallInfo` as an alias.
- `display.ts`: append in entry order instead of sorting into buckets. Map
  `compaction` / `branch_summary` / `label` to `kind: 'note'` — they stop being
  assistant speech.
- `agentChat.tsx`: same change. Stop dropping the three note kinds.
- **Port mac's `ask_user` handling to `display.ts`** while both files are open.
  It is the one place the two projections disagree that is a plain bug.
- `os/client.ts`: `message_start` seeds `activity: []`; `thinking_delta` appends
  or extends a trailing `think` entry; `tool_execution_start` / `_end` push and
  patch a `tool` entry. The history restore at the bottom of the file maps to the
  same shape.
- `display.test.ts` and `frieren.test.ts` already cover the projection — extend
  them with an interleaved turn (`think → tool → think`) that asserts order.

### Phase 3: the Crease

- One component, phase-driven, keyed on `calls[0].id` so the node survives
  running → settled.
- Group consecutive activity into runs; a text block breaks a run. If the message
  model does not preserve interleaving yet, one crease per assistant message is a
  fine first cut — the interleaved case degrades to the simple case and no markup
  changes when the model catches up.
- **Render nothing for zero activity.** A turn that just answers must look
  exactly as it does today.
- Fix the scroll interaction (below).

### Phase 4: kind-owned bodies

- `tool` → mono `<pre>`, args and result, as today.
- `think` and `note` → prose. Body font, ~72% opacity, a left rule. Never `<pre>`.
- A run containing a failure opens by default and tints with `--danger`.

### Phase 5: preference and parity

- Persist `expandTools`. Setting it opens every crease by default — that is a
  stored boolean, not a second design.
- Check both hosts render the same turn identically, live and after reload. That
  is the regression this whole change is supposed to make impossible.

## The scroll bug this creates

Real, and hit on day one. `Transcript.tsx:176` re-pins to the bottom on any
content growth while `stuckRef.current` is true:

```ts
const ro = new ResizeObserver(() => {
	if (stuckRef.current) toBottom()
})
```

Opening a crease halfway up the thread grows the content, the observer fires, and
the view yanks to the bottom — away from the thing the user just chose to look
at. **Set `stuckRef.current = false` in the toggle, before the growth lands.**

Two notes. During a turn the seam is the last thing in the thread, so the
stick-to-bottom keeps it visible for free — this only bites on unfold. And a
nested crease makes it worse, not better, because the growth can be large.

After the unfold transition, if the sheet's bottom is below the viewport, scroll
just enough to bring it in — never more. The seam itself must not move.

## Accessibility

- Running phase: `role="status"`, `aria-live="polite"`, `aria-atomic` — each
  phrase is announced, rather than the thread re-read.
- Settled: a real `<button aria-expanded>` with the label as its accessible name.
- Nested creases nest the buttons; nothing special is needed.
- Reduced motion: drop the hinge and the rule sweep, keep the fades.

## Four rules that keep it from sprawling

1. **One new prop.** `expandTools`. Per-turn open state is internal.
2. **A kind is three functions.** No kind may change position, phase, seam, row
   chrome, or disclosure. If a kind needs to, the language is wrong — fix the
   language, not the kind.
3. **Interior never blocks.** Anything that requires or invites the user's
   attention is a response and renders plainly. That is the `ask_user` test.
4. **A failure never folds silently.** Hiding a failure is the only way this
   change makes the product worse instead of quieter.

## What was rejected

Five directions were mocked up before this one. The others, and why not:

- **Reader Switch** — no per-turn affordance at all; one global control flips the
  whole transcript. Not rejected so much as *absorbed*: it is rule 1's
  `expandTools`, which is a preference rather than a layout.
- **Ribbon Rail** — a gutter in the left margin, hover to peek, click to pin. The
  only direction with a genuinely untouched text column, and the prettiest. Loses
  on discoverability (an unlabelled stripe) and does not survive touch.
- **Receipt Drawer** — a footnote chip that opens an inspector over the thread.
  Never reflows, and the trace gets real room. Held in reserve: the moment a
  trace needs a diff, a screenshot, or 200 lines of JSON, the crease is too
  small and this becomes right rather than over-built.
- **Told, Then Shown** — the status line settles into a past-tense sentence that
  expands into a timeline. The best default state, because it teaches without a
  click. Absorbed as the *narrated label* variant; it stays a setting because a
  one-line label truncates on a busy turn.

The crease won on one argument the others cannot answer: **it recurses.** A
delegated subagent is just another interior kind whose body is another crease,
and the depth ribbon does what Xcode's fold ribbon does with nested braces. Every
other direction needs a new surface to show a subagent's work.

## Growth surfaces

- **`delegate`** — a subagent's run, body rendered as a nested crease. The
  strongest reason the fold was chosen; see the last mockup.
- **`recall`** — memory or context retrieval, body a list of hits.
- **`wait`** — polling something external, body a poll log. The one kind whose
  duration is the interesting part.
- **Narrated labels** — `Read 2 files · ran tests twice · edited 1 file`,
  grouped mechanically with no model call. Already implemented in the mockup;
  gated on solving one-line truncation.
- **Streamed thinking** — showing the live thought fragment is the most alive the
  agent ever looks and costs nothing, since the text is already streaming. It is
  also the one place raw model output reaches the user unmediated, so it wants a
  hard truncation and a setting. Quiet (`Thinking · 6.2s`) is the safe default
  for a shipped app.
