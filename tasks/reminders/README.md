# Reminders v1

Status: **design agreed; not implemented.** A small Frieren app over a shared
folder of Markdown files. Open the app, see what is due, edit an item in place,
and mark it done. The files are the source of truth.

This records the approved sidebar design and the later simplification to direct
title/notes editing. Read [the app authoring guide](../../docs/app.md) before
implementation. Use [Notes](../../apps/notes/src/app.ts) for the shared-volume and
file-editing patterns, and [the design package](../../packages/design/mac.css)
for controls and colors.

## Scope

- Create, read, edit, complete, reopen, and delete reminders.
- Each item has a title, optional due date, Markdown body, and `open`/`done` status.
- Four fixed views: Today, Upcoming, All open, and Completed.
- Today is the initial view on every launch; overdue items remain visible.
- One item can be edited at a time, directly in its list row.
- Use the existing volume and sync infrastructure.

V1 surfaces due reminders while the app is open. It does not promise alerts
while the app or browser is closed. The current
[notification contract](../../packages/app/capabilities/notify/types.ts) has no
scheduled-delivery field; background alerts would be a separate platform task.

No recurrence, times of day, priorities, tags, projects, subtasks, attachments,
custom filters, search, manual ordering, calendar integration, or AI-specific UI.
Markdown may contain links and lists, but these do not become separate items.

## Folder structure

Repository layout, once implemented:

```text
tasks/reminders/
	README.md             Design and v1 acceptance criteria

apps/reminders/
	package.json
	tsconfig.json
	vite.config.ts
	public/icon.svg
	src/
		app.ts            Capability, state, actions, and file procedures
		items.ts          Frontmatter parsing, patching, validation, and view rules
		gui.tsx           Sidebar, list, inline editing, and transient state
		gui.css           App layout; reuse platform tokens and controls
		items.test.ts     File round trips and date/status rules
		app.test.ts       File mutations, failures, and revision signals
```

Start from the existing React create-app template. Keep the initial modules at
this size; no repository layer, indexing service, plugin system, or separate
state-management library. Proposed app ID: `justfiles.reminders`.

The **user volume** has a separate layout:

```text
/reminders/
	550e8400-e29b-41d4-a716-446655440000.md
	9fa876be-663c-4725-9f62-892ead86ba28.md

/state/
	justfiles.reminders.json       Small state file managed by the kernel
```

`tasks/reminders` is repository documentation. `/reminders` is user data inside
the volume; neither is a host filesystem path used directly by the GUI.

Declare only `volume`, scoped to `['/reminders']`. Its app-visible root `/` maps
to the shared `/reminders` folder. Do not use private `/data/<app-id>` storage for
items: they should remain accessible to Files and the agent, and survive app
uninstallation.

V1 reads regular `.md` files directly inside this folder. Ignore subfolders,
symlinks, and other extensions. App-created files use random UUID filenames,
claimed with exclusive creation. Files created elsewhere may use any valid
single-component `.md` filename. The filename is stable when the title changes.
Do not create status folders, date folders, sidecars, or an index file.

A missing folder is an empty collection. The first successful create writes the
file and lets the volume create its parent directory.

## File format

An open reminder:

```markdown
---
title: Book a dentist appointment
status: open
due: "2026-09-10"
---

Ask for a morning appointment.

Bring the referral letter.
```

An undated reminder:

```markdown
---
title: Find a reading lamp
status: open
---

Something small for the desk.
```

| Field | Rule |
| --- | --- |
| `title` | Required, nonempty single-line string. Trim surrounding whitespace on save. |
| `status` | Required; exactly `open` or `done`. |
| `due` | Optional quoted `YYYY-MM-DD` string containing a real calendar date. Omit for no date. |
| Body | All Markdown content after the frontmatter. May be empty. |

Use a YAML parser, not a hand-written YAML subset. Require the frontmatter to be
a mapping with unique keys. Reject malformed YAML, missing required fields,
unsupported statuses, non-string dates, and impossible dates such as February 30.
Do not silently invent metadata or rewrite a file while reading it.

There is no duplicated `id`, `createdAt`, `updatedAt`, or `completedAt` field in
v1. The path identifies a file. Completion changes `status` to `done`; reopening
changes it to `open`. Neither moves the file nor changes its due date.

Patch only the requested fields. Preserve unknown frontmatter fields and the
unchanged Markdown body. Use a YAML document representation to retain comments
where supported; identical frontmatter whitespace is not a promised format.
Clearing a due date removes the YAML key. Do not insert the title into the body.

## Data structures

These describe application data, not an additional database or storage format.
All paths below are relative to the capability root, written as `/<filename>.md`.

```ts
type Reminder = {
	path: string
	title: string
	status: 'open' | 'done'
	due: string | null
	body: string
}

type Summary = Omit<Reminder, 'body'> & {
	preview: string
}

type Document = {
	item: Reminder
	raw: string
}

type Changes = {
	title?: string
	status?: 'open' | 'done'
	due?: string | null
	body?: string
}

type View = 'today' | 'upcoming' | 'all' | 'done'

type Listing = {
	items: Summary[]
	counts: Record<View, number>
	issues: { path: string; message: string }[]
}
```

`due: null` is the in-memory representation of an absent YAML key. In `Changes`,
an omitted property means leave it alone; `due: null` means clear it. `raw` is
the exact text read from the file, used as the baseline for a subsequent write.
The preview is the first nonempty body line rendered as plain text, with a
reasonable display truncation; it never replaces or truncates stored content.

## Minimal app state

The entire durable reducer state is:

```ts
type State = {
	openPath: string | null
	revision: number
}
```

Initial values: `openPath: null`, `revision: 0`.

- `openPath` identifies the existing item being edited. It lets the app watch
  that file and lets the agent see which item the user has open. A new unsaved
  item has no path and stays GUI-local.
- `revision` is a wake-up signal. Increment it after a successful mutation or a
  relevant volume event so the GUI knows to re-read. It is not a file version,
  item counter, conflict token, or synchronization cursor.

Do not persist items, bodies, parsed YAML, counts, active view, current date,
loading flags, errors, or draft keystrokes in reducer state. Files hold durable
item data. The GUI owns the current listing and date, selected view, loading and
error display, draft, baseline, pending write, and one completion Undo record.
Compute `dirty` from draft versus baseline instead of storing a separate flag.

On launch, show Today and clear any persisted `openPath`; an old path does not
restore an unsaved draft. Refreshing an open app is distinct from launching it:
preserve its current view and draft.

## Views and dates

All views are computed from valid files. They never move or modify files.

| View | Membership and grouping |
| --- | --- |
| Today | `status === 'open'` and `due <= today`; separate Overdue and Due today groups. Undated items are excluded. |
| Upcoming | `status === 'open'` and `due > today`; group by due date, starting tomorrow. |
| All open | Every open item; group Overdue, Due today, future dates, then No date. |
| Completed | Every done item; show a single list. |

Sort open items by due date ascending, with undated items last. Break ties by
title, then path. Sort Completed by title, then path; there is no completion
timestamp or implied completion chronology. Counts use the same predicates as
the lists; Today's count includes overdue items.

`today` is the user's local calendar date, supplied by the caller as
`YYYY-MM-DD`. The GUI computes it in the browser's timezone. The agent supplies
the user's local date when calling a dated view. The headless procedure must not
infer it from its server timezone. Compare validated date strings directly; do
not turn all-day dates into UTC timestamps.

An item due today becomes overdue on the next local day, not at an arbitrary
hour. Recalculate at local midnight while open, and whenever focus/visibility
returns after sleep. Overdue dates remain unchanged until explicitly edited.

## Actions and file flow

Use the same app actions for GUI and agent. Keep file I/O inside procedures;
the GUI does not directly access the filesystem.

| Action | Behavior |
| --- | --- |
| `open({ path })` | Public edge; set `openPath` to a validated item path or `null`. No file mutation. |
| `list({ view, today })` | Scan and parse the folder; return filtered summaries, counts across all views, and per-file issues. |
| `read({ path })` | Read and validate one file; return `Document`. |
| `create({ title, due?, body? })` | Create one UUID-named file with `status: open`; return its `Document`. |
| `save({ path, base, changes })` | Re-read, compare with `base`, validate and apply the patch, then update the existing file. Return its new `Document`. |
| `remove({ path, base })` | Re-read and compare with `base`, then delete the file. Clear `openPath` if it names that file. |

`base` is the caller's previously read `raw` string. On mismatch, write nothing
and report that the file changed. Missing files are errors for read/save/remove;
only create may make a new item. Reject paths outside the flat item folder.

Create uses `writeFile` with exclusive creation; save uses update-only mode and
does not recreate missing parents. Serialize this app instance's read-modify-write
procedures using the existing Notes pattern. Commit a revision signal only after
the capability reports success. Do not report a save as successful in advance.

Completion and reopening use `save` with only a status patch. Read the current
document first and use its raw text as the baseline, so a metadata change never
replaces notes with a stale body. No separate complete/reopen procedure is needed.
Completion Undo applies the previous status through the same path; it does not
restore an old copy of the whole file or recreate a removed file.

### Loading and refresh

1. On launch, list the folder and display Today. Show loading until the first
   read finishes; do not temporarily present an unread folder as empty.
2. Scan direct children and read each regular `.md` file. Start with this simple
   linear pass. Parsing frontmatter requires file reads; a directory listing
   alone cannot tell whether an item is due or done.
3. Re-list after successful mutations, view changes, relevant watch signals,
   app focus/visibility returning, explicit Refresh, and local day changes.
4. Ignore an older list/read result if a newer request or selection superseded
   it. Keep the last successful list visible during refresh; report failures.

Use one coalesced recursive watch on the volume root for structural changes and
one concrete-file watch when `openPath` is set. Both can increment the same
revision. See the actual [volume contract](../../packages/app/capabilities/volume/contract.ts):
a recursive watch reports creation/removal/rename, **not edits to existing child
contents**. Do not assume it keeps every item's metadata live. Focus, view
changes, and a small Refresh command cover edits to unopened files in v1.

Keep Refresh as a secondary toolbar command, not a new view. Midnight and focus
checks belong in the GUI; no background scheduler is needed.

### Failed reads and concurrent edits

- A bad file contributes a path and message to `issues`; valid files still
  appear. Show a compact error notice with those paths. Never repair or delete
  invalid files automatically.
- A failed scan is a load error, not an empty collection. A failed save leaves
  the draft editable for retry. Disable duplicate submissions while pending.
- If the open file changes, reload it only when the draft is clean. With a dirty
  draft, retain the text and show that the file changed. Save must refuse the
  stale baseline; Cancel discards the draft and reads the current file.
- If the edited file disappears, keep the draft available to copy and report
  the removal. Never silently recreate it.
- A baseline check plus an app-local write queue does not provide atomic
  compare-and-swap against another app or sync applying a write between the
  check and write. This is the same limit as Notes. Do not claim conflict-free
  collaborative editing or add an app-local lock that pretends to protect all
  writers. Stronger guarantees require a shared storage primitive.

## Concrete GUI

Use the approved sidebar layout: Reminders titlebar, a narrow muted sidebar,
and a plain list on the main surface. Reuse the platform's system font, blue
selection/action colors, thin rules, checkboxes, and native button treatment.
Use a New reminder button at the top right. Avoid cards around each item.

The sidebar contains Today, Upcoming, All open, and Completed, with counts.
Separate Completed slightly from the open views. On narrow windows the same
navigation may wrap into a horizontal strip.

A closed row shows a checkbox, title, one-line note preview when present, and
due-date text at the trailing edge. Color overdue date text and the Overdue
heading, not the whole row.

### Direct editing

Clicking a title replaces that title with a borderless text input at the same
position. Clicking a note preview enters editing with the cursor in the notes.
The expanded item shows its full Markdown body as a borderless textarea beneath
the title. Preserve line breaks. A title-only item reveals an Add a note
placeholder when opened. Inputs keep accessible names and visible keyboard
focus; omit visible Title/Notes field labels and the boxed form.

One controls row sits below the content:

```text
[Today] [Tomorrow] [No date] [date picker]       [Delete…] [Cancel] [Save]
```

The current date shortcut has a selected treatment. The native picker allows
any calendar date. These controls only change the draft. The item stays in its
current group until Save succeeds, even if its new due date belongs elsewhere.
Save commits title, notes, and due date together. Cancel discards all draft
changes. On narrow windows the controls wrap rather than clip.

Do not render both a static row and a second form for the same item. The item
itself becomes the editor. Only one item can be edited at a time. If it has
unsaved changes, ask the user to Save or Cancel before switching items or views;
never lose the draft by silently closing it. An agent changing `openPath` must
likewise not erase a dirty GUI buffer.

New reminder inserts the same editing surface at the top of the list. Only the
title is required. Default its date to today when creating from Today, and to
no date from other views. Show that date explicitly in the controls. Save creates
the file once; Cancel creates nothing. Hide Delete for an unsaved item. If the
saved item is outside the current view, say where to find it without forcibly
switching views. Do not mark a new item done just because it was created while
viewing Completed.

Checkboxes complete/reopen immediately after a successful write. Offer one
Undo for the most recent completion change. Do not complete an item while a
dirty edit is pending; resolve Save/Cancel first.

Delete requires a small inline confirmation; Cancel at that confirmation aborts
deletion. Delete removes the file only after confirmation and successful I/O.
Completed items remain editable and can be reopened or deleted.

For an empty Today view, say Nothing due today and point to All open. Use plain
empty states for the other views. Avoid celebratory overlays and productivity
scores.

## Implementation acceptance criteria

- Creating writes exactly one valid Markdown file, visible through Files.
- Canceling a new reminder writes nothing; repeated Save while pending cannot
  create duplicate items.
- Retitling keeps the filename stable. Status/date changes preserve the body
  and unknown frontmatter fields. Removing a date omits its YAML key.
- All four views, counts, sorting, overdue boundaries, and midnight rollover
  follow the rules above, including undated and completed reminders.
- Invalid metadata in one file does not prevent other files from loading.
- Direct title/notes editing, date shortcuts, Save, Cancel, confirmed Delete,
  completion, reopening, and Undo work through the shared action surface.
- External edits refresh on the documented triggers; detected stale saves and
  missing-file failures preserve drafts and do not overwrite/recreate files.
- Repeated opens do not accumulate subscriptions; late async results do not
  replace a newer listing or draft.
- The GUI works in light/dark themes and narrow windows with keyboard-accessible
  controls. It uses the existing host design rather than a second design system.
- App state stays limited to `openPath` and `revision`; no item database, durable
  list cache, or notification scheduler is introduced.

Validate these behaviors with focused Vitest tests and a Frieren UI smoke check
when implementing. This task currently adds design documentation only.
