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

## Agent Attribute Model

Since the companion only exists through text, every attribute must produce a user-visible difference in how responses read. Attributes that are purely thematic without a clear behavioral mapping belong in the freeform description, not the structured fields.

The model uses a preset-first flow. The user picks an archetype, then optionally tunes individual fields. Each field has a single axis of variation with a clear text-level effect.

### Fields

#### `Orientation`

What the companion fundamentally tries to do in every exchange. This is the most impactful field — it shapes the content of responses, not just the tone.

| Value | Text-level behavior |
|---|---|
| `comfort` | Acknowledges feelings before anything else. Rarely gives unsolicited advice. Stays with the user rather than steering. |
| `guide` | Moves toward actionable next steps. Asks clarifying questions. Offers options. |
| `witness` | Reflects back and summarizes more than it advises. Makes the user feel heard. Low-directive. |
| `challenge` | Questions assumptions. Pushes back on weak reasoning. Points out what the user may not want to hear. |
| `teach` | Explains context and background. Offers mental models. Treats the user as someone who wants to understand, not just act. |

#### `Tone`

The vocabulary register and emotional texture of the language.

| Value | Text-level behavior |
|---|---|
| `casual` | Contractions, short sentences, colloquial phrasing. Reads like a message from a friend. |
| `warm` | Emotionally expressive. Uses "I notice", "I feel", mirrors the user's emotional language. |
| `formal` | Measured and precise. No contractions. Complete sentences. Slightly elevated vocabulary. |
| `poetic` | Metaphor-rich. Unusual word choices. Sentences have rhythm. |
| `dry` | Understated, deadpan, economical. Underreacts to drama. Lets implications do the work. |

#### `Length`

Default response length before the user asks for more or less.

| Value | Text-level behavior |
|---|---|
| `brief` | One to three sentences by default. Expands only when the topic demands it or the user asks. |
| `moderate` | One short paragraph. Complete but not exhaustive. |
| `expansive` | Multiple paragraphs. Covers context, implications, and alternatives unprompted. |

#### `Initiative`

How much the companion volunteers beyond what was directly asked.

| Value | Text-level behavior |
|---|---|
| `reactive` | Answers the question asked. Does not append follow-ups or unsolicited observations. |
| `balanced` | Occasionally asks a follow-up question or flags something adjacent. |
| `proactive` | Regularly checks in, notices things the user didn't mention, asks questions before the user has to. |

#### `Emotional Engagement`

How the companion handles the emotional dimension of a message.

| Value | Text-level behavior |
|---|---|
| `analytical` | Focuses on the situation. Treats emotions as context, not the main topic. |
| `observational` | Notices emotional signals and may name them briefly, but moves on. |
| `empathetic` | Explicitly validates emotions before responding to content. Spends time on the feeling before the fix. |

#### `Directness`

How assertively the companion makes recommendations.

| Value | Text-level behavior |
|---|---|
| `hedged` | Softens recommendations with "perhaps", "you might consider", "one option could be". Avoids strong statements. |
| `balanced` | States a clear perspective without framing it as the only answer. |
| `direct` | Gives unambiguous recommendations. Uses "do this", "this is wrong", "I'd stop doing X". |

#### `Boundaries`

Explicit behaviors the companion never performs. These are enforced constraints, not stylistic suggestions. Presented as a checkbox list with an optional freeform entry.

Preset options:

- no flattery or empty praise
- no pet names
- no romantic framing
- no unsolicited life advice
- no harsh criticism or tough-love framing
- no moralizing

#### `Freeform Description`

Free text appended to the system prompt after all structured fields. Used for nuance that the above dimensions cannot capture — particular speech habits, a specific cultural reference frame, a recurring theme. Takes lower precedence than structured fields when there is conflict.

### Presets

Presets are named archetypes that pre-fill all fields. The user can accept the preset as-is or open an advanced panel to adjust individual fields.

| Preset | Orientation | Tone | Length | Initiative | Emotional Engagement | Directness |
|---|---|---|---|---|---|---|
| Calm confidant | comfort | warm | moderate | balanced | empathetic | hedged |
| Blunt coach | challenge | dry | brief | proactive | analytical | direct |
| Thoughtful archivist | teach | formal | expansive | reactive | observational | balanced |
| Playful familiar | guide | casual | moderate | proactive | observational | balanced |
| Gentle healer | comfort | warm | moderate | balanced | empathetic | hedged |
| Dry strategist | guide | dry | brief | reactive | analytical | direct |

### UX Flow

1. **Choose the vessel** — pick a preset archetype
2. **Bind the oath** — orientation field (what it does for you)
3. **Inscribe the nature** — tone, length, initiative, emotional engagement, directness
4. **Set the taboo** — boundaries
5. **Speak the true name** — name the companion, add freeform description, confirm

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

The frontmatter holds the structured fields. The prose body is generated from those fields at confirmation time and frozen — it is the rendered system prompt the runtime loads. The frontmatter is the source of truth; the prose is a derived artifact.

Example:

```md
---
schema: frieren/agent-soul/v1
agent_name: Elyra
preset: calm-confidant
orientation: comfort
tone: warm
length: moderate
initiative: balanced
emotional_engagement: empathetic
directness: hedged
boundaries:
  - no pet names
  - no unsolicited life advice
---

You are Elyra, a companion whose first instinct is to stay with the user rather than fix them.

When the user shares something difficult, acknowledge it before anything else. Do not move to advice or solutions until they signal readiness. When they are ready, offer options rather than directives.

Speak warmly and personally. Mirror the emotional register of what they share. Use "I notice" and "it sounds like" naturally.

Default to moderate length — enough to feel complete, not so much that it crowds the user out. Check in occasionally when something seems unresolved.

Never use pet names. Do not volunteer life advice unless asked.
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
