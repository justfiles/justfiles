# Age Calibration

## What It Is

A runtime feature that adapts the companion's vocabulary, sentence length, response length, and abstraction level to match the user's developmental stage. It is derived from the user's birth date — no separate user input is required.

This is not part of persona customization. It is a system-level communication adjustment that applies on top of whatever companion persona is active.

## Age Bands

| Age | Vocabulary | Max sentence length | Response length | Abstraction |
|-----|-----------|-------------------|-----------------|-------------|
| 4–6 | Concrete nouns, simple verbs, ≤2 syllables. Define anything unusual immediately. | 8 words | 1–2 sentences | None — physical, tangible, sensory examples only |
| 7–9 | Common everyday words. Introduce new words with an immediate simple definition. | 12 words | 2–4 sentences | Simple cause and effect |
| 10–12 | Grade-level vocabulary. Define uncommon terms. | 15 words | 3–6 sentences | Moderate — basic logical reasoning |
| 13–15 | Broad vocabulary. Technical terms with context. | Flexible | 1–2 short paragraphs | High — abstract concepts acceptable |
| 16–18 | Adult vocabulary. | Flexible | Flexible | Full |
| 18+ | Full vocabulary. | Flexible | Flexible | Full |

## Data Source

The user's `birth_date` in their profile. Age is calculated at session start. No additional data needs to be stored.

If the user is a child, a `grade_level_override` field in the user profile allows a parent or educator to manually shift the band up or down. This is useful when a child reads significantly above or below their age level.

## Storage and Regeneration

The current band can be cached in the user profile file to avoid recalculation on every turn and to make the active calibration visible and editable. The cached value should be regenerated when:

- The user's age crosses a band boundary (detectable at session start by comparing the current band to the stored one)
- The `grade_level_override` field changes
- Triggered manually

## How It Integrates

At session start, the runtime calculates the user's age, determines the band, and injects a communication parameters block into the system prompt. This block is separate from the soul identity section and the educator mode section.

Example injection for a user aged 8:

> The user is 8 years old. Use vocabulary a second-grader would know. Keep sentences to 12 words or fewer. Limit responses to 3 sentences unless more is clearly needed. Use concrete, physical examples — avoid abstract concepts. If you use an unfamiliar word, immediately explain it in simple terms.

The instruction is specific enough that the model can follow it mechanically, not just interpret it loosely.

## What This Does Not Cover

Age calibration adjusts how the companion speaks, not what it does. The Socratic teaching method, knowledge tracking, and review scheduling are separate features that sit alongside this one.
