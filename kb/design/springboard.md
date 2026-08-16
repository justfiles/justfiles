# The runner index: a springboard

Status: **v1 Daylight shipped.** It is the page [`apps/runner/src/home.tsx`](../../apps/runner/src/home.tsx)
serves at the root domain. The other four directions did not ship and are kept here as studies —
they answer the same brief differently, and some of their parts are worth lifting into other
surfaces.

## The brief

The index is the one page a visitor lands on knowing nothing. It should read like the springboard
of a tablet: a grid of apps you can take in at a glance, and a search box you never have to hunt
for. Same idea at every width — on a phone it becomes the phone home screen, not a shrunken
desktop page. Borrow the simplicity, not the iOS visual language.

## The five

Each direction is a different answer to one question: **where does search go?** That turned out to
be the decision that drives everything else about the page.

| | Direction | Search | Reads as |
|---|---|---|---|
| v1 | **Daylight** | A pill at the top, always in view | A springboard |
| v2 | **Spotlight** | The hero field; drops to the bottom on a phone | A launcher |
| v3 | **Catalog** | Inline with the masthead, underlined | A directory |
| v4 | **Board** | A tile in the grid itself | A dashboard |
| v5 | **Home** | In the dock, beside the favorites | A device |

Open [`springboard/index.html`](./springboard/index.html) to see all five side by side, each in a
desktop frame and a 390px phone frame, with the search boxes live. Each one also opens full screen:
[daylight](./springboard/daylight.html), [spotlight](./springboard/spotlight.html),
[catalog](./springboard/catalog.html), [board](./springboard/board.html),
[home](./springboard/home.html).

## Why Daylight

It is the plain reading of the brief, and the plain reading was the right one. Nothing on the page
competes with the grid: no masthead, no chrome, no per-app metadata. The store is three apps today
and will be tens for a while, which is exactly the range where an icon and a name are enough — a
visitor recognizes Draw faster than they read "a freeform sketchpad backed by Excalidraw".

The search pill sits above the grid rather than inside it, so it survives an empty store and never
moves as the grid grows. At the phone breakpoint the grid goes to a fixed four columns; letting
`auto-fill` decide there gives three fat columns and a page that looks like a list.

What we gave up, and would revisit: v3 Catalog is the only direction that says what an app *is*
without a click, which matters more the further the store gets from apps whose names explain
themselves.

## Worth reusing

- **Container queries, not media queries.** Every breakpoint in
  [`springboard.css`](./springboard/springboard.css) asks how wide the `.stage` is, so one
  stylesheet drives a full window and a 390px frame. It is what makes the phone views in
  `index.html` real renders rather than screenshots, and it is the reason a layout can be dropped
  into a panel later without its breakpoints lying.
- **The monogram fallback.** An app with no icon gets its initial on a colored tile, the color
  derived from its id, so a grid of unpublished icons still reads as a grid instead of a row of
  gray holes. The six-hue palette is at the top of `springboard.css`; the runner derives the same
  colors from the app id.
- **Search as a filter, not a destination.** Every direction filters the grid in place on each
  keystroke — no results page, no submit, no route. At store scale that is a dozen lines of client
  code and no server work at all.
- **v4's tiles and v2's result grid** are the two layouts that would carry the most information per
  square inch if a later surface needs one — a picker, an admin listing, an app switcher.

## The files

Generated once from a single source and then frozen; the HTML and CSS here are the artifact, and
`index.html` is the only file with page furniture of its own.

```text
springboard/
├── index.html        # all five, framed at desktop and phone width
├── daylight.html     # one variant per page, full screen
├── spotlight.html
├── catalog.html
├── board.html
├── home.html
├── springboard.css   # the shared stage plus one section per variant
├── springboard.js    # the app list, the tile templates, the search
└── icon-*.png        # Draw, Notes and Paint, as published
```

The app list in `springboard.js` is the live `store.json` for Draw, Notes and Paint — real names,
versions and icons — plus nine stand-ins, because a three-icon grid does not show whether a grid
works.
