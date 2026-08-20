# The way out: a home button for a hosted app

Status: **proposed. Nothing shipped.** Four directions, each a live mockup under
[`home-button/`](./home-button/). The recommendation at the bottom is d2 Beacon.

## The brief

An app on the runner owns its whole subdomain, and the page that serves it —
[`apps/runner/src/app.tsx`](../../apps/runner/src/app.tsx) — gives it the whole viewport: the document
is a `#app` div and the app's GUI mounts into it. That is the point, and it should stay the point.

Installed to a home screen it owns more than that. The web app manifest declares
`display: standalone`, so there is no address bar, no back button and no tab — nothing on the screen
leads anywhere. A visitor who opens Notes from the index has no way back to the index short of
retyping the domain.

So: a way home that is **obvious, and not intrusive**. iOS is the reference — an app gets 100% of the
screen, and there is still always a way out.

## The four

Each direction is a different answer to one question: **what does the way out cost the app?**

| | Direction | The affordance | Costs the app |
|---|---|---|---|
| d1 | **Indicator** | A home bar in a gutter the host reserves at the bottom | 22 px of height, permanently |
| d2 | **Beacon** | A floating orb that idles down to a smudge | No layout; 42 px over the app, movable |
| d3 | **Shelf** | A strip of host chrome above the app, which yields as you read | 32 px at the top, handed back while you read |
| d4 | **Edge** | Nothing on the screen; a swipe in from the left | Nothing — you pay in discoverability |

Open [`home-button/index.html`](./home-button/index.html) to see all four side by side, each in a
desktop frame and a 390 px phone frame, all live — tap the bar, drag the orb, scroll the shelf away,
swipe the edge. Each also opens full screen:
[indicator](./home-button/indicator.html), [beacon](./home-button/beacon.html),
[shelf](./home-button/shelf.html), [edge](./home-button/edge.html).

Every direction is drawn over the same mock app, a notes editor with furniture at **both** edges — a
toolbar on top and a formatting bar below. An app with clear edges cannot show what a way out costs,
so this one has none to spare.

## Why Beacon

Three things decide it, and none of them are visible in the mockups. They are all about what the
platform has already taken.

**The bottom edge is spoken for.** Installed to an iPhone home screen, the system draws its own home
indicator across the bottom of the screen. d1's capsule lands directly above it: two home bars, one
of which is a lie. The direction that imitates iOS most faithfully is the one iOS has left no room
for. In a browser tab it is perfect; installed — the case that actually strands you — it is not.

**So is the left edge.** In a browser tab, swiping in from the left edge is the browser's own back
gesture, on iOS Safari and on Android Chrome. d4 cannot have it there. Installed, the gesture is
free — so d4 works exactly where it is hardest to teach, and fails exactly where a first-time
visitor meets it.

**Only d3 answers "where am I?"** Installed, nothing on the screen says this app came from the
runner. Whether that is worth 32 px is a product question, not a layout one: it is the difference
between a store and a set of bookmarks. It is the fallback if that answer matters more than
immersion.

Which leaves the Beacon. It costs no layout, collides with no platform gesture, behaves identically
in a tab and installed, and moves out of the way when it is in the way. It is the only one of the
four that is obvious the moment the app opens and gone by the second paragraph.

## What building it would touch

The way out belongs to the **host**, not to the app: rendered by the runner into the document beside
the `#app` mount point, so no app has to add it, no app can remove it, and nothing about it reaches
the SDK. [`apps/runner/src/client/main.ts`](../../apps/runner/src/client/main.ts) does not change.

The tap needs no client code at all — it is a link off this origin to `ROOT_DOMAIN`. The idle dim is
a class and a timer, and only d3 needs more than that (a scroll listener on a node the host does not
own, which is the strongest argument against it).

One prerequisite either way: the app document renders no `<meta name="viewport">` today, so a phone
lays it out at 980 px and scales down. Every direction here assumes that tag — and d1 additionally
assumes `viewport-fit=cover` plus `env(safe-area-inset-bottom)`, or its bar sits under the system's.

## Worth reusing

- **The trip home is the transition.** Going home shrinks the app toward the springboard rather than
  navigating to it. Shared by all four, and it is what makes the destination feel like the same
  device rather than another website. In the mockups it is a transform; in the real thing it would
  be a cross-document view transition, since the two pages are different origins.
- **The destination is the real index.** The springboard behind every mockup is v1 Daylight from
  [`springboard.md`](./springboard.md), tokens and all, so the two studies read as one system.
- **Container queries, not media queries.** Same as the springboard study: every breakpoint asks how
  wide `.stage` is, so the phone frames are real renders rather than screenshots.
- **Idle-then-wake.** d1 and d2 announce themselves once when the app opens and then fade. An
  affordance that idles has to do that, or its first impression is its quietest.

## The files

Generated once and then frozen; the HTML, CSS and JS here are the artifact.

```text
home-button/
├── index.html        # all four, framed at desktop and phone width
├── indicator.html    # one direction per page, full screen
├── beacon.html
├── shelf.html
├── edge.html
├── home-button.css   # the shared stage and mock app, plus one section per direction
└── home-button.js    # the springboard, the mock app, the four gestures
```

Icons come from [`springboard/`](./springboard/) next door rather than being copied.
