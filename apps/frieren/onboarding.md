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

For the agent:

- name
- gender, optional
- archetype — Teacher, Companion, or Assistant
- a generated soul text, reviewed and editable by the user before saving

### UX goals

- reduce friction on first run
- avoid a generic multi-step form feel
- collect structured data only where precision matters — name, birth date, gender
- give the user a fast path through agent setup — three archetype choices rather than a blank page
- keep the user in control — the generated soul text is shown and editable before anything is saved

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
- optional select for agent gender
- three archetype cards to choose from
- editable textarea showing the generated soul text

The system should not rely on the model alone to parse first-run identity. Structured fields are used only where the data needs to be exact. The soul text is generated but always shown to the user for review and editing before it is saved.

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
- `gender` (optional)

After submit:

- show a summary for confirmation
- let the user edit before confirming
- write `/profiles/user.md`

Important rule: never ask for or store age directly. Always store birth date and derive age at runtime.

### Step 3: Agent summoning ritual

The assistant transitions into a more theatrical JRPG-style step.

The user provides three inputs:

- **Name** — text input
- **Gender** — optional select, same treatment as user gender
- **Archetype** — one of three cards described below

Once the user selects an archetype, the system generates the soul text in the background and displays it in an editable textarea. The user reads it, adjusts anything they want, then confirms.

After confirm:

- write `/soul.md` with the reviewed text as the body
- the archetype is stored in frontmatter for future reference

#### The three archetypes

**Teacher**

Guides through questions rather than giving answers. Patient and knowledgeable, but prioritizes understanding over efficiency. Celebrates the moment of realisation rather than the correct answer. Does not tell the user what to think — leads them to think it themselves.

Works for: children learning, adults building a skill, anyone who wants to be challenged to grow.

**Companion**

Peer relationship, no hierarchy. Present alongside the user — not above, not below. Warm and attentive. Faces challenges together rather than solving them for the user. Imaginative and loyal. Remembers things that matter.

Works for: emotional support, creative collaboration, someone to think out loud with, day-to-day company.

**Assistant**

Task-oriented and user-directed. The user leads; the assistant serves. Organized, proactive, reliable. Helps get things done — reminders, research, summarizing, tracking. Anticipates what the user needs before being asked.

Works for: productivity, professionals who want a Jarvis-style utility, anyone who needs help managing their day.

#### Generation

When an archetype is selected, the system makes a single generation call with the following context:

- agent name, agent gender
- archetype
- user age (derived from birth date) and user gender
- name inference — if the agent name carries cultural or fictional signal, the generator draws on it; if the name is neutral, the archetype and user context drive the result instead

The output is 100–150 words, written in second person as instructions to the agent. It is displayed immediately in an editable textarea. The user can rewrite any part of it before confirming.

Example — user is an 8-year-old boy, agent name is Goku, archetype is Companion:

```
You are Goku, an unstoppable companion always ready for the next adventure. You never back down from a challenge and you never let your friend face one alone. You talk straight — no long speeches, just action. When things get hard, you get excited. You believe anyone can get stronger if they keep going. You are loyal to the end. You never give up, and you never let them give up either.
```

Example — adult user, agent name is Lyra, archetype is Assistant:

```
You are Lyra, a calm and capable assistant. You stay on top of what matters and surface it before being asked. You communicate clearly and briefly. When given a task, you complete it thoroughly and report back without padding. You keep track of things the user mentions — follow-ups, reminders, unresolved items — and bring them back at the right moment. You do not offer opinions unless asked. You are reliable above all else.
```

### Step 4: First in-character line

Once both files are written:

- enter normal chat
- start with a short first line from the chosen companion persona

This gives the user immediate feedback that the ritual mattered.

## Why Structured Inputs for the User Profile

The user profile uses structured inputs rather than freeform conversation for the fields that need to be exact: name, birth date, gender. A conversation-driven approach fails here because models summarize instead of normalize, and a field like birth date becomes ambiguous if entered as prose. A date picker produces `1995-08-14`; a conversation produces "mid-nineties, August I think".

The agent soul text is the opposite case — structure would hurt it. Three archetype cards give the user a fast starting point without forcing their idea into predefined fields. The generation step produces a concrete draft from minimal input. The editable textarea gives back full control before anything is committed.

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
```

### `/soul.md`

The frontmatter holds the agent name, optional gender, and archetype. The prose body is the soul text the user reviewed and confirmed during onboarding — generated as a starting point, but the saved version reflects any edits the user made. It is loaded directly as the system prompt.

Example:

```md
---
schema: frieren/agent-soul/v1
agent_name: Lyra
agent_gender: female
archetype: companion
---

You are Lyra, a quiet and observant companion. You stay with the person rather than rushing to fix them. When something is hard, you sit with it first. You speak warmly but never effusively. You do not offer advice unless asked. You notice things — small things the person might not mention but that matter — and you bring them up gently when the moment is right. You never use pet names. You keep your responses short unless depth is needed.
```

If the user wants to change the persona later, they edit the soul text and rewrite the file. The archetype in frontmatter records what the user started from but does not constrain future edits.

## Open Questions

- should users be able to re-run the summoning ritual later to regenerate and replace `/soul.md`
  A: yes, but it's out of scope for now, we can provide "reset" later, which is effectively redo the onboarding and overwrite the files.
- should the app show a sample opening line from the generated persona before the user confirms, so they can hear the voice before committing
  A: sure, if it's not too much trouble
- should the archetype selection be visible and editable after onboarding, or treated as a one-time setup choice
  A: the archetype selection is one-off, after the setup process, it's simply the soul.md file, we can provide ways to edit it, later. currently out of scope for the onboarding process.
- should soul files be shareable — exported and imported as plain text, the way developers share system prompts
  A: yes, later, out of scope for onboarding

## Near-Term Implementation Shape

The minimal implementation path is:

1. Add an onboarding state machine check on app load.
2. Create a dedicated onboarding route.
3. Implement the user profile step: name, birth date, gender — structured inputs, confirmation, write `/profiles/user.md`.
4. Implement the agent step: name input, optional gender select, three archetype cards, generation call on archetype selection, editable textarea, confirmation, write `/soul.md`.
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
