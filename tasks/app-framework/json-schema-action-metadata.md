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

Derivation in `defineApp`, in this order:

```ts
defineApp({
	init, update, procedures,
	// optional app-level converter for validators that do not carry Standard JSON Schema
	jsonSchema?: (schema: StandardSchemaV1) => Record<string, unknown>
})

const toJson = (schema) =>
	schema['~standard'].jsonSchema?.input({ target: 'draft-2020-12' })   // Standard JSON Schema
	?? spec.jsonSchema?.(schema)                                          // app-level converter
	?? undefined                                                          // no metadata
```

A raw Valibot schema does not implement the Standard JSON Schema interface (checked against
Valibot 1.4.0: `~standard.jsonSchema` is undefined). Valibot ships it through the separate
`@valibot/to-json-schema` package. So the templates add that package and pass its converter once:

```ts
import { toJsonSchema } from '@valibot/to-json-schema'
export const app = defineApp({ ..., jsonSchema: toJsonSchema })
```

One line per app, not one wrapper per schema. Without it every action would lose its parameter
metadata the moment `schemaHint` is removed.

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
