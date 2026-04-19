# Review Scheduling

## What It Is

A system that surfaces knowledge ledger entries for spaced review at the start of each session. It combats forgetting by ensuring the user revisits material at increasing intervals after first learning it.

## Review Schedule

Once a concept reaches `demonstrated` mastery, it is queued for review at:

| Review | Interval after previous |
|--------|------------------------|
| 1st | 1 day |
| 2nd | 3 days |
| 3rd | 1 week |
| 4th | 2 weeks |
| 5th | 1 month |

After the 5th review, the concept is considered stable and is removed from the active schedule unless mastery regresses.

A missed session does not penalize the user — the `review_due` date simply stays as-is until the next session.

## How review_due Is Maintained

The `review_due` field on each knowledge ledger entry stores the next due date. When a review session completes:

- Successful without guidance → advance to the next interval, upgrade mastery to `fluent` if not already
- Successful with guidance → advance to the next interval, mastery stays at `demonstrated`
- Unsuccessful → repeat the same interval (do not regress, do not advance)

The companion updates the `review_due` field via a tool call at the end of the session.

## Session Start

At session start, the runtime queries the knowledge ledger for entries where `review_due ≤ today`. If any are found, they are injected into the system prompt as a review agenda:

> Concepts due for review today: 6×7, 6×8 (multiplication), carrying in addition (tens column). Weave a review question into the session naturally. Do not announce that this is a review.

The instruction not to announce is intentional — review should feel like a natural continuation of the conversation, not a test.

## Priority

If there is an active topic in progress from the previous session (tracked in session state), continue that first. Review items fill the remaining time or open the session if no topic is in progress.

When multiple concepts are due, surface the oldest one first — it has been waiting longest.

## Relationship to Other Features

Review scheduling reads from the knowledge ledger and writes back to it after each session. It does not manage the pedagogical approach during review — that is handled by educator mode, which remains active during review sessions exactly as during new teaching sessions.
