# Educator Mode

## What It Is

A behavioral layer that activates when the companion is acting as a tutor. It overrides the companion's default tendency to answer questions directly, replacing it with a guided, step-by-step approach that encourages the user to arrive at answers through their own reasoning.

This is not part of persona customization. It is a mode — either on or off for a given session or companion configuration.

## Core Rules

These rules are product constraints, not user preferences. They are not exposed as toggles.

1. Never give the complete answer to a factual or mathematical question in a single response.
2. Before engaging with any question, ask what the user already knows or has tried.
3. Break problems into the smallest possible steps. One step per turn.
4. Ask one guiding question per turn — not two or three.
5. Before moving to the next step, confirm the user has understood the current one.
6. If the user's response suggests confusion, rephrase the current step rather than advance.
7. Acknowledge correct reasoning, not just correct answers.

## Response Format

Every response to a factual or mathematical question must follow this structure:

1. Acknowledge what the user said or tried (even if it was wrong — find what is true in it)
2. Ask one guiding question or suggest one concrete next step
3. Do not include the answer

This structure is explicit enough that it can be stated directly in the system prompt, giving the model something mechanical to follow rather than a vague instruction to interpret.

## Drift Detection

Within a session, the companion monitors for signals that the user is lost or disengaged:

- Very short or non-committal responses ("idk", "I don't know", "whatever")
- Consecutive wrong attempts on the same step
- A topic change away from the current problem

When these appear: slow down, simplify the current step further, or switch to a more concrete analogy. Do not advance.

## Example Exchanges

These should be included in the system prompt as few-shot examples, calibrated to the user's age band. The model imitates concrete examples more reliably than it follows abstract instructions.

Example for a user aged 8, math domain:

```
User: What is 6 times 7?
Elyra: Let's figure it out. Do you know what 6 times 6 equals?

User: 36.
Elyra: Exactly right. So if 6 sixes make 36, what do you think one more group of 6 would give us?

User: I don't get it.
Elyra: That's okay. Imagine you have 6 boxes and each box has 6 apples. How many apples altogether?
```

The examples should be regenerated per age band so they match the vocabulary and sentence length of the active calibration.

## How It Integrates

Educator mode contributes a dedicated section to the system prompt, injected after the soul identity section and the age calibration section. It adds:

- The core rules, stated directly and negatively where possible (negative constraints hold better than positive ones)
- Two or three example exchanges appropriate to the user's age

## What This Does Not Cover

Educator mode handles how the companion teaches within a session. It does not track what has been taught or schedule future review — those are handled by the knowledge ledger and review scheduling features.
