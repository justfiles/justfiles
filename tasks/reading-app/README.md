# Reading — a read-later app over a shared `/reading` volume

> Status: **design, no code yet.** Adds one app (`apps/reading`) and one new
> platform capability (`reader`). The app is a viewer over a folder; the folder
> is the state. No `ai` capability — the host's assistant panel reads app state
> directly.

Read [`docs/app.md`](../../docs/app.md) first — this doc only covers what is
specific to Reading. Framework idioms (edges, procedures, capabilities, the
two-faces model) are assumed. Interactive mockup: [`mockups.html`](./mockups.html),
open it in a browser.

**Contents**

1. [The shape](#shape)
2. [The `reader` capability](#capability)
3. [On disk](#disk)
4. [The state machine](#machine)
5. [The GUI](#gui)
6. [The assistant seam](#assistant)
7. [Listing cost, measured](#perf)
8. [v1 scope & non-goals](#scope)
9. [Open calls](#open)

<a id="shape"></a>

## 1 · The shape

Save a URL, get clean prose back, read it, mark it read. That is the whole app.

Three decisions carry it, and everything else follows:

| Decision | Consequence |
| --- | --- |
| Content lives in a shared top-level `/reading` | The agent, Files and sync all work on it the day it ships |
| An item is a **folder**, not a file | PDFs, assets and future highlights need no new concept |
| The app never touches the network | Fetching is a host capability, reusable by every other app |

The app is deliberately a **viewer**. It does not own the library — the volume
does. Drop a PDF into `/reading` from Files and it appears in the list.

<a id="capability"></a>

## 2 · The `reader` capability

A GUI runs in an opaque-origin iframe whose CSP blocks fetch, and the reducer is
a headless worker. Network egress is not an app privilege in this system and
should not become one. So URL→markdown is a host capability:

```ts
// packages/app/capabilities/reader/contract.ts
export interface ReaderCapability {
	read(input: { url: string }): Promise<{
		url: string          // final URL, after redirects
		title: string
		markdown: string
		siteName?: string
		byline?: string
		publishedAt?: number
		wordCount: number
	}>
}
```

One method, and it is deliberately stingy: every field returned is a field
somebody will depend on. The app declares it as
`reader: reader({ scopes: [] })`, calls it from a procedure (it takes seconds),
and commits one result.

### The host implementation

Two tiers, both Cloudflare. The app cannot tell which one answered — that is the
point of the seam, and it is what lets this be replaced later (a caching wrapper,
readable.page, anything) with no app change.

1. **`fetch()` + Workers AI `toMarkdown()`.** ~200ms, free for HTML, handles most
   of the web. `toMarkdown` also takes PDF, docx and images, so a URL that *is* a
   PDF routes here too. Image conversion runs object-detection and vision models
   and can consume Workers AI neurons ($0.011 / 1,000 neurons, 10,000/day free);
   HTML conversion does not.
2. **Browser Rendering `/markdown`.** A real headless browser, for SPAs and
   anything tier 1 returns thin. Escalate only on failure.

```
POST https://api.cloudflare.com/client/v4/accounts/<id>/browser-rendering/markdown
{
  "url": "https://example.com/article",
  "gotoOptions": { "waitUntil": "networkidle0" },
  "rejectRequestPattern": ["/^.*\\.(css)/"]
}
→ { "success": true, "result": "---\ntitle: …\n---\n\n# Title\n\nBody…" }
```

The response is markdown **prefixed with YAML frontmatter (`title`, and whatever
else the page exposes)** when the page provides that metadata, so the host has a
title without a second render. Byline and date are best-effort.

Prefer the **Workers binding** over REST from the host worker: no API token, no
egress hop.

### What it costs

Quick Actions bill **duration only** — $0.09 per browser hour, no concurrency
charge (that applies to Puppeteer/Playwright sessions, at $2.00 per concurrent
browser above 10). Workers Paid includes 10 browser-hours/month; the free plan's
10 minutes/day is dev-only. Duration is totalled daily in seconds and rounded at
month end: ≥1,800s rounds up to the next hour, ≤1,799s rounds **down**. Failed
`waitForTimeout` requests are not charged.

| Scenario | Render | Articles / browser-hour | Cost / 1,000 |
| --- | --- | --- | --- |
| Typical article | ~5s | 720 | **$0.13** |
| Heavy SPA, `networkidle0` | ~15s | 240 | $0.38 |
| **20 saves/day** | ~5s | ~3,000s/month ≈ 0.83h | **$0.00** — inside the included 10h |

For comparison: Firecrawl is ~$5.33/1,000 (credit-based, from $83/mo), Jina
Reader ~$0.15/1,000 (token-billed at $0.045–0.05/1M tokens). Cloudflare wins on
price, but the real reason is that the host already runs on Workers — this is a
binding, not a vendor.

### Three things that bite

- **Bot walls are permanent.** Cloudflare sends non-configurable headers
  identifying Browser Rendering traffic. Paywalled and bot-protected pages fail
  and stay failed. This is why pasting markdown is a **core** v1 feature and not
  a nice-to-have: it is the recovery path.
- **No durable cache.** `cacheTTL` on `/markdown` defaults to 5s and caps at
  86,400s (24h), keyed on exact URL + params. Re-saving a URL next month
  re-renders and re-bills, and two apps saving the same page pay twice. Fine at
  personal volumes. When it matters, a content-addressed cache goes in the host
  behind the same `read(url)` and no app changes.
- **Latency is seconds.** Saving cannot block on it. See `pending` below.

<a id="disk"></a>

## 3 · On disk

`/reading` is a **top-level volume path**, parallel to `/notes` and `/system` —
not `/data/<app-id>`. Same reasoning as Notes: top-level frames it as a
first-class user substrate that survives the app.

```
/reading/
	attention-and-the-open-tab/
		content.md          ← the document
		info.json
	a-paper-worth-keeping/
		paper.pdf           ← the document
		info.json
```

**Every child of `/reading` is one item.** The folder name is the identity (the
slug). `info.json`:

```json
{
	"title": "Attention and the open tab",
	"doc": "content.md",
	"source": "https://longform.example/attention-and-the-open-tab",
	"savedAt": 1756345200000,
	"read": false,
	"words": 1740
}
```

`doc` is the load-bearing field: it names which file in the folder **is** the
document, so a markdown item and a PDF item are structurally identical and the
viewer dispatches on its extension. Everything else in the folder is payload.

### Why a sidecar and not frontmatter

Marking read would otherwise rewrite the document — impossible for a PDF, and it
destroys byte-fidelity with what was fetched. `info.json` writes are ~200 bytes
and never touch the document.

Rejected alternatives, for the record:

- **Folders as status** (`/reading/unread/`, `/reading/archive/`) makes status a
  move. It fights recency ordering, breaks any path the agent has cited, and
  encodes exactly one bit when we will want more.
- **Xattrs** work for any format with no sidecar and are the leanest option on
  disk — but they are invisible to an agent reading the tree, invisible in Files,
  and the first thing a sync or export drops. Legibility is the whole point.

### Loose files

A file dropped directly into `/reading` (from Files, from sync) is a valid item
with defaulted metadata: unread, `savedAt` = mtime, `title` = filename. It is
**adopted lazily** — the first write that needs somewhere to go (marking it read)
moves it into a folder and creates its `info.json`. No magic until the user acts.

The scanner therefore knows two shapes, which costs ~8 lines. Eager adoption
(one shape, adopt on sight) is defensible and leaner; it just rearranges files
the user only just put there.

<a id="machine"></a>

## 4 · The state machine

```ts
capabilities: {
	volume: volume({ scopes: ['/reading'] }),
	reader: reader({ scopes: [] })
	// no `ai` — see §6
}
```

Inside the chroot the app's `/` **is** `/reading`, so app code uses plain
root-relative paths and never writes the `/reading` prefix.

```ts
type Item = {
	slug: string        // folder name; identity
	title: string
	doc: string         // 'content.md' | 'paper.pdf'
	source: string | null   // null when pasted
	savedAt: number
	read: boolean
	words: number
}

type ReadingState = {
	items: Item[]                              // derived index, persisted
	current: string | null                     // open slug
	showRead: boolean                          // default false
	selection: { slug: string; text: string } | null
	pending: { url: string; startedAt: number }[]   // in flight, no file yet
	failed: { url: string; error: string }[]        // transient, dismissible
	revision: number
}
```

`items` is a **derived index that is also the persisted state**. The kernel
writes the whole reducer state to `/state/<app-id>.json` after every commit and
loads it verbatim on boot, so the list is on screen before any scan runs. The
scan is a background reconcile, never a cold start. This is the index — there is
no hand-maintained `/reading/.index.json`, and there must not be: a second copy
invalidated by every writer that is not us buys ~36ms (§7).

### Edges

| Edge | Kind | Notes |
| --- | --- | --- |
| `open({ slug })` | `t.on` | Sets `current`, clears `selection` |
| `setRead({ slug, read })` | `t.on` + `t.cmd` | Flips state, emits the `info.json` write. Adopts a loose file if needed |
| `setShowRead({ showRead })` | `t.on` | The list filter |
| `remove({ slug })` | `t.on` + `t.cmd` | Optimistic drop, then `rm` recursive |
| `indexed` | `t.commit` | The reconcile result |
| `treeChanged` | `t.fromEvent` | Bumps `revision`; the GUI re-lists |

`setRead` composing the write into the edge keeps marking read synchronous from
the GUI's point of view — the JSON bytes are a pure function of state, so the
edge stays pure and the command carries the effect.

### Procedures

- **`save({ input })`** — the only interesting one. If `input` is a URL: push to
  `pending`, `await app.invoke('reader', 'read', …)`, write `content.md` and
  `info.json`, commit. Otherwise treat it as markdown, derive a title from the
  first heading, and write immediately with `source: null`.
- **`refresh({})`** — one recursive `scan`, parallel `info.json` reads, one
  `t.commit`. Called on the coalesced tree wake.

### Subscriptions

```ts
subscriptions: (state, sub) => [
	sub.capability('volume', 'watch', { path: '/', recursive: true })
		.coalesce().to('treeChanged')
]
```

`.coalesce()` is required, not optional: the event is a WAKE carrying no detail,
so a superseded one is fully absorbed. Without it, importing a vault queues one
full reduce per file.

### Failure and restart

A failed fetch **writes no file**. The URL survives only as a `failed` entry, so
the UI can offer retry / paste it in / open original / dismiss. Retrying a bot
wall fails again — pasting is the real exit, and the UI should not pretend
otherwise.

A save in flight when the app restarts has a dead procedure behind it. On boot,
move any `pending` entry to `failed`; do not silently drop it.

<a id="gui"></a>

## 5 · The GUI

Two panes. A **flat list** on the left ordered by `savedAt` descending — no
folders, no tags, no groups. A document pane on the right.

**Read items are hidden by default.** `showRead` is `false`, and a small
`n read` chip beside the unread count is the only way back; it hides itself
entirely when nothing is read yet. Read *is* the archive — there is no second
list to build.

**Read is set by the button and nothing else.** No scroll tracking, no progress
field, no auto-complete heuristic. If the user never presses it, the item stays
unread forever. That is the correct behaviour, not a gap.

Marking read does not yank the document away: the item leaves the list but stays
open, with a `hidden from list` marker in the doc bar and the button flipped to
`Mark unread`. It disappears once the user navigates away.

The doc bar carries **Open original ↗**, which hands the URL to a browser. The
app never renders the original page — extraction sometimes loses, and this is the
honest escape rather than a second rendering mode. Disabled for pasted items.

<a id="assistant"></a>

## 6 · The assistant seam

**The app declares no `ai` capability and ships no AI code.** The host's
assistant panel is window chrome; it reads `current` and `selection` off the
app's state like any other agent-visible field.

This is the entire reason `selection` lives in the reducer rather than in the
GUI. It is the app's one concession to the assistant, and it costs one field and
one dispatch on `mouseup` — a semantic event on settle, never a stream of
`selectionchange`.

Set it through a `'gui'`-audience procedure committing an internal edge, so it
stays out of the agent's tool list: the agent should *see* the user's selection,
not drive it. A plain `t.on` is leaner and acceptable if that distinction turns
out not to matter.

**The corollary governs every future feature:** anything the agent should know
has to be state. Reading position, the active filter, a highlight — each is a
field, or the agent is blind to it.

<a id="perf"></a>

## 7 · Listing cost, measured

Benchmarked against the real `Volume` over `fsStore`, item folders holding an
~8KB `content.md` plus `info.json`:

| Items | Recursive scan | `info.json` reads (sequential) | **(parallel)** | One index file |
| --- | --- | --- | --- | --- |
| 500 | 2.8ms | 88ms | **33ms** | 0.3ms |
| 2,000 | 11.7ms | 435ms | **131ms** | 0.6ms |

Reproduce by seeding N folders and timing `vol.scan` against `Promise.all` over
`readFile`. IndexedDB (what Frieren uses) was not measured; assume 2–5× the read
column.

Three conclusions:

1. **500 items costs ~36ms.** Below perception, and off the critical path
   entirely because the list paints from persisted state first.
2. **Parallelise the reads.** `Promise.all`, not a `for` loop — it is 3–4× and
   the single biggest lever here.
3. **The scan alone gives you most of a row for free**: path, type and mtime for
   the whole subtree in one call, so identity, `savedAt` and which file is the
   document all come out with zero reads. Only exact `title` and `read` force
   opening `info.json`. If this ever does get slow, paint from the scan at ~3ms
   and fill in the rest as it lands — progressive, still no cache.

<a id="scope"></a>

## 8 · v1 scope & non-goals

**In:** save a URL; paste markdown; a flat recency list; hide-read by default;
the reading surface; mark read/unread; delete; open original; PDFs as documents;
loose-file adoption.

**Out of v1, and the folder shape means none of them need a migration:**

- **Images.** The GUI iframe's CSP blocks remote subresources, so an article's
  images cannot load from their original URLs — they must be local bytes. v1
  strips them. Adding `<item>/assets/` later is additive.
- Highlights and notes — a sibling file in the item folder.
- Tags, folders, search, full-text index.
- Reading position / resume. Deliberately absent; see §5.
- Text-to-speech, Kindle export, browser extension.

<a id="open"></a>

## 9 · Open calls

1. **Images: strip in v1, or write assets now?** Recommend strip. The folder
   shape is exactly what makes this free to add later.
2. **Adopt loose files lazily or eagerly?** Lazy above; eager is one shape in the
   scanner and one fewer branch. Either is fine.
3. **Does `read` survive a rename?** The slug is identity, so renaming a folder
   in Files makes a new item and loses only the read flag — `info.json` travels
   with it. Good enough. An `id` field fixes it properly and is worth one line if
   it bites.
4. **Is `reader` its own capability, or a method on a future `web`?** Standalone
   is leaner now; a broader `web` that later grows search is likelier to be right
   in a year.
