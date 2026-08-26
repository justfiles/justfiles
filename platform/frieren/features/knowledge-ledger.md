# Knowledge Ledger

## What It Is

A persistent record of concepts the user has encountered and their current mastery level. It exists so the companion does not re-teach things the user already knows, can adapt explanations based on prior coverage, and can feed the review scheduling system with accurate data.

## Data Model

Each entry represents a single concept:

```json
{
  "id": "multiplication-6x7",
  "concept": "6 × 7 = 42",
  "domain": "multiplication",
  "note": "User derived this from 6×6=36 by adding one group of 6. Did not arrive at it from memory.",
  "first_taught": "2026-04-18",
  "last_reviewed": "2026-04-18",
  "mastery": "demonstrated",
  "review_due": "2026-04-21"
}
```

### Mastery Levels

| Level | Meaning |
|-------|---------|
| `introduced` | Concept was mentioned but user did not demonstrate understanding |
| `attempted` | User tried but made errors — understanding is partial or incorrect |
| `demonstrated` | User arrived at the correct answer through guided reasoning |
| `fluent` | User answered correctly without guidance in a later session |

Mastery only moves forward, never backward. A user who was `demonstrated` last week and makes an error today is still `demonstrated` — they may need review, but that does not erase prior understanding.

## How Entries Are Created and Updated

The companion writes or updates a ledger entry via a tool call at the end of a turn when:

- A new concept is introduced for the first time → create entry at `introduced`
- The user works through a problem and reaches the correct answer → upgrade to `demonstrated`
- The user answers correctly in a review session without guidance → upgrade to `fluent`

This is a structured output action, not embedded in the conversation text. The companion does not narrate the fact that it is logging.

## Storage

Ghostore. Each entry is a note keyed by concept ID. The domain field enables querying by subject area (e.g. all multiplication concepts, all science concepts the user has covered).

## Session Start Injection

At session start, the runtime loads recent ledger entries and injects a summary into the system prompt:

> User has covered the following: multiplication up to 6×6 (fluent), 6×7 and 6×8 (demonstrated), carrying in addition (attempted — made errors on tens column). Do not re-explain fluent concepts. Be ready to support attempted concepts with a different approach.

This tells the companion where the user actually is, not where the curriculum assumes they should be.

## What This Does Not Cover

The ledger stores data. When to surface that data for review, and in what order, is handled by the review scheduling feature.
