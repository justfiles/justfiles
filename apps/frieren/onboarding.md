# Frieren Onboarding

## Background

`apps/frieren` already has the core idea of two durable identity files:

- `/profiles/user.md` identifies the human user
- `/soul.md` identifies the agent

The runtime treats these files as foundational context for future sessions. If they are missing, the current behavior falls back to prompt-driven setup. That is directionally correct, but too loose for first-run onboarding because:

- some facts must be stored as structured data, not vague prose
- the current setup prompt asks for `age`, but we need `birth date` so age can be derived over time
- the app does not yet have a dedicated onboarding flow in the UI
- the agent customization experience should match Frieren's JRPG ritual tone rather than a generic chatbot settings page

We want onboarding to feel conversational and in-world, while still collecting concrete, durable inputs that can safely drive future behavior.

## What We Want To Achieve

### Product goals

- first-time users should land in a clear onboarding flow instead of a blank chat
- onboarding should feel like a ritual, summoning, or character creation sequence
- the flow should preserve the emotional appeal of a conversation-driven companion app
- the system should still capture exact fields where precision matters

### Data goals

We need durable identity for both sides of the relationship.

For the user:

- name
- birth date as a real date, ideally ISO `YYYY-MM-DD`
- gender or gender identity, optional and user-defined
- short self-description

For the agent:

- a stable identity and role
- a set of behavioral traits that can reliably shape responses
- explicit constraints and boundaries
- a freeform description for nuance that does not fit the preset attributes

### UX goals

- reduce friction on first run
- avoid a generic multi-step form feel
- avoid a pure freeform chat flow that produces ambiguous data
- let the user move quickly with presets, but allow deeper customization

## Core Design Direction

The best fit is a hybrid flow:

- conversational shell
- structured inputs underneath
- explicit confirmation before writing files

This means the assistant can introduce each step in-character, but the user still interacts with reliable controls such as:

- text input for name
- date picker for birth date
- select plus custom text for gender
- textarea for self-description
- card, slider, or sigil-based trait pickers for agent customization

The system should not rely on the model alone to parse first-run identity.

## Proposed Workflow

### Step 1: Check onboarding state

On app load, evaluate a state machine with two conditions:

- `/profiles/user.md` present
- `/soul.md` present

The machine evaluates both conditions independently and routes to whichever collection step is still needed. Order does not matter. The only exit into normal chat is when both files exist.

```
app load
  │
  ├─ user.md missing  →  user profile ritual  →  write user.md  →  re-evaluate
  │
  ├─ soul.md missing  →  agent summoning ritual  →  write soul.md  →  re-evaluate
  │
  └─ both present  →  normal chat
```

If the user abandons the flow before confirming, no file is written. On the next session the state machine re-evaluates and resumes from whatever is still missing.

### Step 2: User profile ritual

The assistant greets the user and explains that a few details are needed to establish who they are.

Fields:

- `name`
- `birth_date`
- `gender`
- `short_description`

After submit:

- show a natural-language summary in the chat timeline
- ask the user to confirm or edit
- write `/profiles/user.md`

Important rule:

- never ask for or store age directly during onboarding
- always store birth date and derive age later

### Step 3: Agent summoning / customization ritual

The assistant transitions into a more theatrical JRPG-style creation step.

Suggested framing:

- choose the form of your companion
- inscribe its nature
- speak the true name

The user should be able to pick predefined attributes and then add a freeform description.

After submit:

- show a generated preview of the companion persona
- let the user confirm or edit
- write `/soul.md`

### Step 4: First in-character line

Once both files are written:

- enter normal chat
- start with a short first line from the chosen companion persona

This gives the user immediate feedback that the ritual mattered.

## Why Not Pure Conversation

A fully conversation-driven onboarding flow is attractive, but not sufficient for the data we need.

Problems with a pure freeform setup:

- users answer loosely or incompletely
- models tend to summarize instead of normalize
- exact fields like birth date become ambiguous
- future behavior becomes harder to control

A hybrid approach keeps the emotional tone of a conversation while using deterministic capture for critical fields.

## Research Summary

The research suggests a recurring pattern across companion and persona products:

- identity is usually separate from behavioral instructions
- products often use a combination of presets and freeform text
- example voice or greeting strongly influences how the persona feels
- traits work best when they map to interaction behavior, not just lore

### Character.AI

Character.AI centers character setup around:

- name
- greeting
- definition
- example conversations

This is useful because it separates the idea of the character from examples of how the character speaks.

Useful references:

- https://book.character.ai/character-book/character-attributes
- https://book.character.ai/character-book/character-attributes/definition
- https://book.character.ai/character-book/character-attributes/example-conversations
- https://book.character.ai/character-book/character-attributes/greeting

### Replika

Replika distinguishes traits, interests, and backstory. Traits affect how the assistant behaves, while backstory shapes the broader personality frame.

Useful references:

- https://help.replika.com/hc/en-us/articles/360062096391-How-do-Traits-Interests-work
- https://help.replika.com/hc/en-us/articles/37208430613261-How-your-Replika-s-backstory-shapes-its-personality

### Kindroid

Kindroid provides one of the clearest customization models for companion AI:

- backstory
- response directive
- key memories
- example messages

This is a strong reference for how to separate:

- who the agent is
- how it should answer
- what persistent context it should carry

Useful references:

- https://docs.kindroid.ai/customizing-personality
- https://docs.kindroid.ai/memory

### Warmth and competence

Social perception research often uses warmth and competence as core dimensions for how humans evaluate agents and other social actors. These are useful as hidden or semi-visible design dimensions for AI companions.

Useful reference:

- https://www.frontiersin.org/journals/social-psychology/articles/10.3389/frsps.2024.1396533/full

### Communication style dimensions

For practical conversation design, a few style dimensions matter more than a full psychological profile:

- directness
- verbosity
- formality
- initiative

Useful reference:

- https://pressbooks.nvcc.edu/culturesmart/chapter/4-2-communicationstyles/

### RPG character framing

Tabletop RPG systems often separate personality into compact but expressive buckets such as:

- trait
- ideal
- bond
- flaw

That structure is useful because it gives personality shape without requiring a large trait taxonomy.

Useful reference:

- https://www.dndbeyond.com/sources/dnd/basic-rules-2014/personality-and-background

### Big Five

The Big Five are a strong research-backed personality model, but they are probably too abstract to expose directly in onboarding. They are more useful as internal design inspiration than as visible UI labels.

Useful reference:

- https://mbrg.bsg.ox.ac.uk/big-five

## Design Options For Agent Attributes

These are the main ways we could design the agent customization layer.

### Option A: Direct behavioral traits

This is the most product-pragmatic option.

Visible attributes:

- `Companion Role`
- `Temperament`
- `Warmth`
- `Directness`
- `Expressiveness`
- `Initiative`
- `Primary Focus`
- `Boundaries`
- `Freeform Description`

Example values:

- `Companion Role`: wise mage, loyal knight, shrine maiden, wandering healer, rogue scholar
- `Temperament`: gentle, stoic, cheerful, sardonic, serene, playful
- `Warmth`: reserved, warm, devoted
- `Directness`: understated, diplomatic, clear, blunt
- `Expressiveness`: sparse, balanced, flourished
- `Initiative`: reactive, balanced, proactive
- `Primary Focus`: comfort, strategy, reflection, discipline, curiosity, lorekeeping
- `Boundaries`: never patronize, never flirt, no pet names, no roleplay unless invited

Pros:

- easy to understand
- directly maps to interaction behavior
- easiest to encode into `/soul.md`

Cons:

- can feel a little like a settings panel unless strongly themed

### Option B: JRPG ritual attributes

This is the strongest thematic option for Frieren.

Visible attributes:

- `Class`
- `Disposition`
- `Oath`
- `Speech Style`
- `Pace`
- `Distance`
- `Flaw`
- `Taboo`
- `True Name`
- `Freeform Description`

Example values:

- `Class`: mage, knight, healer, rogue, scholar, priestess, familiar
- `Disposition`: gentle, stoic, proud, playful, severe, wistful
- `Oath`: protect, guide, witness, challenge, comfort, teach
- `Speech Style`: plainspoken, courtly, poetic, dry, teasing
- `Pace`: brief, balanced, elaborate
- `Distance`: formal, familiar, intimate
- `Flaw`: aloof, blunt, overprotective, meddlesome, secretive
- `Taboo`: no flattery, no romance, no babying, no vagueness

Pros:

- best thematic fit
- memorable and emotionally resonant
- naturally feels like a summoning ritual or character creation screen

Cons:

- some labels are poetic and may need hidden internal mappings to clear behavior instructions

### Option C: Presets plus advanced tuning

This is probably the best long-term UX model.

Flow:

- the user first picks a preset companion
- then optionally opens advanced customization
- then adds freeform notes

Preset examples:

- Calm confidant
- Blunt coach
- Thoughtful archivist
- Playful familiar
- Gentle healer
- Dry strategist

Advanced controls could then expose a smaller trait set such as:

- warmth
- directness
- expressiveness
- initiative
- focus
- boundaries

Pros:

- fastest for new users
- easiest to make beautiful
- easy to expand later

Cons:

- requires more design work up front to make the presets feel distinct

### Option D: Hidden internal trait engine

In this model, the visible UI stays simple and thematic, while the system maps those choices to internal values.

Visible user-facing picks:

- role or class
- tone or disposition
- speech style
- help style
- boundaries

Internal hidden values:

- warmth
- competence posture
- directness
- verbosity
- initiative
- playfulness
- formality
- emotional intensity

Pros:

- gives the best internal consistency
- easy to reuse across presets
- makes future prompt generation more systematic

Cons:

- more implementation complexity
- requires careful design of the mapping layer

## Recommended Direction

For Frieren, the best version is likely a combination of Option B and Option C:

- present the screen as a JRPG ritual
- begin with strong preset archetypes
- allow advanced tuning through a small set of behavioral traits
- end with a freeform description box

This preserves theme without sacrificing control.

Recommended visible fields:

- `Companion Role` or `Class`
- `Temperament` or `Disposition`
- `Warmth`
- `Directness`
- `Expressiveness`
- `Initiative`
- `Primary Focus` or `Oath`
- `Boundaries` or `Taboo`
- `Freeform Description`

Recommended UX framing:

1. Choose the vessel
2. Inscribe the temperament
3. Bind the oath
4. Speak the true name

## Suggested File Shapes

### `/profiles/user.md`

This file should be human-readable but include stable machine-usable fields.

Example:

```md
---
schema: frieren/user-profile/v1
name: Xiaoxing
birth_date: 1995-08-14
gender: nonbinary
---

# User Profile

Xiaoxing is thoughtful, technical, and prefers concise communication.
```

### `/soul.md`

This file should separate identity from behavior.

Example:

```md
---
schema: frieren/agent-soul/v1
agent_name: Elyra
class: mage
disposition: serene
warmth: warm
directness: clear
expressiveness: balanced
initiative: proactive
focus: reflection
boundaries:
  - never patronize the user
  - avoid pet names
---

You are Elyra, a serene mage-companion who guides the user with warmth, clarity, and restraint.

Behavior:
- Be thoughtful, observant, and gently proactive.
- Offer reflection before solutions when the user seems emotionally tangled.
- Speak clearly rather than vaguely.
- Keep answers elegant and not overlong unless depth is requested.
- Never patronize the user.
- Do not use pet names.
```

## Open Questions

- should users be able to re-run the ritual later and regenerate `/soul.md` from settings
- how much of the companion definition should be user-visible after setup
- should the app generate one or more example opening lines so the user can preview voice before confirming
- should we store only final attributes, or also preserve the chosen preset and the raw freeform text

## Near-Term Implementation Shape

The minimal implementation path is:

1. Add an onboarding state check before entering normal chat.
2. Create a dedicated onboarding page or onboarding route.
3. Implement a structured user-profile step.
4. Implement a JRPG-themed companion customization step.
5. Add confirmation before writing each durable file.
6. Write `/profiles/user.md` and `/soul.md`.
7. Transition into the normal chat experience with a short first in-character line.

## Useful Resources

- Character.AI Character Book: https://book.character.ai/character-book/character-attributes
- Character.AI Definition: https://book.character.ai/character-book/character-attributes/definition
- Character.AI Example Conversations: https://book.character.ai/character-book/character-attributes/example-conversations
- Character.AI Greeting: https://book.character.ai/character-book/character-attributes/greeting
- Replika Traits and Interests: https://help.replika.com/hc/en-us/articles/360062096391-How-do-Traits-Interests-work
- Replika Backstory: https://help.replika.com/hc/en-us/articles/37208430613261-How-your-Replika-s-backstory-shapes-its-personality
- Kindroid Customizing Personality: https://docs.kindroid.ai/customizing-personality
- Kindroid Memory: https://docs.kindroid.ai/memory
- Warmth and competence in conversational AI perceptions: https://www.frontiersin.org/journals/social-psychology/articles/10.3389/frsps.2024.1396533/full
- Communication style overview: https://pressbooks.nvcc.edu/culturesmart/chapter/4-2-communicationstyles/
- D&D personality and background: https://www.dndbeyond.com/sources/dnd/basic-rules-2014/personality-and-background
- Oxford Big Five overview: https://mbrg.bsg.ox.ac.uk/big-five
