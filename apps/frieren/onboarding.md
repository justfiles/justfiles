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

- a name
- a free text description written by the user

### UX goals

- reduce friction on first run
- avoid a generic multi-step form feel
- collect structured data only where precision matters — name, birth date, gender
- give the user full flexibility for the agent description — do not impose a structure they have to fit into

## Core Design Direction

The best fit is a hybrid flow:

- conversational shell
- structured inputs underneath
- explicit confirmation before writing files

This means the assistant can introduce each step in-character, but the user still interacts with reliable controls:

- text input for name
- date picker for birth date
- select plus custom text for gender
- textarea for self-description
- text input for agent name
- large textarea for agent description, with optional preset templates to start from

The system should not rely on the model alone to parse first-run identity. Structured fields are used only where the data needs to be exact. Everything else is free text.

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

### Step 3: Agent summoning ritual

The assistant transitions into a more theatrical JRPG-style step.

The user provides two things:

- **Name** — a short text input for what to call the companion
- **Description** — a large textarea where the user describes the agent in their own words: personality, role, how it speaks, what it cares about, what it avoids

No structure is imposed on the description. The user can write a few sentences or several paragraphs. To reduce blank-page friction, the UI offers optional preset templates the user can load and edit. Presets are complete free-text descriptions, not field configurations — more like starter agent.md files than form defaults.

Presets can eventually be shared between users the same way developers share CLAUDE.md files or agent system prompts — as plain text that anyone can copy, adapt, and redistribute.

After submit:

- show the name and full description text for confirmation
- let the user edit before confirming
- write `/soul.md`

### Step 4: First in-character line

Once both files are written:

- enter normal chat
- start with a short first line from the chosen companion persona

This gives the user immediate feedback that the ritual mattered.

## Why Structured Inputs for the User Profile

The user profile uses structured inputs rather than freeform conversation for the fields that need to be exact: name, birth date, gender. A conversation-driven approach fails here because models summarize instead of normalize, and a field like birth date becomes ambiguous if entered as prose. A date picker produces `1995-08-14`; a conversation produces "mid-nineties, August I think".

The agent description is the opposite case — structure would hurt it. Forcing a persona into predefined fields caps what the user can express and creates a lowest-common-denominator result. Free text lets the user say exactly what they want.

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

The frontmatter holds the agent name. The prose body is exactly what the user typed during onboarding — no transformation, no generation. It is loaded directly as the system prompt.

Example:

```md
---
schema: frieren/agent-soul/v1
agent_name: Elyra
---

You are Elyra, a quiet and observant companion. You stay with the person rather than rushing to fix them. When something is hard, you sit with it first. You speak warmly but never effusively. You do not offer advice unless asked. You notice things — small things the person might not mention but that matter — and you bring them up gently when the moment is right. You never use pet names. You keep your responses short unless depth is needed.
```

The user wrote that description. The system stores it as-is. If the user wants to change the persona later, they edit the description and rewrite the file.

## Open Questions

- should users be able to edit `/soul.md` directly after onboarding, or only through a UI flow
- should the app show a short generated preview of how the companion might respond before the user confirms
- where does the preset library live and who can contribute to it — bundled in the app, hosted remotely, or user-imported
- should the user profile include a short self-description, or is name, birth date, and gender sufficient

## Near-Term Implementation Shape

The minimal implementation path is:

1. Add an onboarding state machine check on app load.
2. Create a dedicated onboarding route.
3. Implement the user profile step: name, birth date, gender — structured inputs, confirmation, write `/profiles/user.md`.
4. Implement the agent step: name text input, large description textarea, optional preset loader, confirmation, write `/soul.md`.
5. Transition into normal chat with a short first in-character line from the new companion.

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
