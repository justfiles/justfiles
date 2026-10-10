---
project: packages/app, packages/agent
status: todo
---

# Emit JSON Schema for actions instead of a hand-rolled hint

## TL;DR

`ActionMeta.schemaHint` is produced by peeking at Valibot internals and flattens an object schema
to top-level type names. Nested shapes, bounds, enums, and descriptions are lost, so authors
restate constraints in prose. Replace the hint with a JSON Schema document derived from the
validator, and have the agent command and agent runtime consume it directly.

## Proposed change

Breaking, SDK (`app.ts`, `sdk.ts`):

```ts
interface ActionMeta {
	kind: 'handler' | 'procedure'
	audience?: ProcedureAudience
	description?: string
	examples?: ActionExample[]
	schema?: Record<string, unknown>   // JSON Schema (draft 2020-12) for the params object
	// removed: schemaHint
}
```

Derivation in `defineApp`: use the Standard JSON Schema interface
(`schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' })`) when the validator
implements it; otherwise omit `schema`. Verify the pinned Valibot version implements it before
relying on it; the template already depends on Valibot.

Consumers:

```ts
// packages/agent/justbash/app.ts — `app actions` and error hints
renderParams(meta.schema)   // properties with type, bounds, enum, description, required

// agent runtime (later, no SDK change needed)
tools.push({ name, description: meta.description, parameters: meta.schema })
```

## Why

- **One schema language.** JSON Schema is what every model tool-calling API accepts and what the
  Standard Schema ecosystem now exports. The framework should carry the industry format rather than
  a private one that only the `app` command understands.
- **Validation and documentation from one source.** Today the schema validates, and the description
  re-explains it. With a faithful schema the agent sees `minimum`, `maximum`, `enum`, and nested
  shapes without an author writing them twice, and the two cannot disagree.
- **Robustness.** The current hint reads `type`, `entries`, and `wrapped` off the validator object.
  It silently degrades on pipes, unions, records, and any non-Valibot validator, and it will break on
  a Valibot internal rename. A documented interface cannot.
- **Equal size, more standard.** This swaps one small function for another; nothing is added to the
  authoring surface.
