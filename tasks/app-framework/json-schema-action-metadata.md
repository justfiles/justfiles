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
	// JSON Schema for the params object, describing the INPUT the validator accepts.
	// Draft 2020-12 or draft-07; consumers accept either, since converters differ.
	schema?: Record<string, unknown>
	// removed: schemaHint
}
```

Derivation in `defineApp`, per schema, never throwing:

```ts
defineApp({
	init, update, procedures,
	// optional app-level converter for validators without Standard JSON Schema
	jsonSchema?: (schema: StandardSchemaV1) => Record<string, unknown> | undefined
})

const toJson = (name, schema) => {
	try {
		return (
			schema['~standard'].jsonSchema?.input({ target: 'draft-2020-12' })   // Standard JSON Schema
			?? spec.jsonSchema?.(schema)                                          // app-level converter
		)
	} catch (error) {
		// Both paths may throw for an unsupported target, schema, or action. One
		// unconvertible action must not fail the whole bundle at module load;
		// it just ships without parameter metadata, and says so once in dev.
		warnOnce(`${name}: no JSON Schema (${message(error)})`)
		return undefined
	}
}
```

A raw Valibot schema does not implement the Standard JSON Schema interface (checked against
Valibot 1.4.0: `~standard.jsonSchema` is undefined). Valibot ships it through the separate
`@valibot/to-json-schema` package. Its converter must be asked for the input representation,
because the default mode ignores transformations and would advertise parameters the validator
does not accept; and it emits draft-07, which is why `ActionMeta.schema` admits both drafts.

```ts
import { toJsonSchema } from '@valibot/to-json-schema'
export const app = defineApp({
	...,
	jsonSchema: (schema) => toJsonSchema(schema, { typeMode: 'input', errorMode: 'ignore' })
})
```

One line per app, not one wrapper per schema. Confirm the option names against the installed
converter version when implementing.

Every `defineApp` that uses Valibot gets the dependency and the hook in the same change as the
`schemaHint` removal, not only the templates: the in-repo apps (pixel and crossword among them,
whose agent-facing actions would otherwise lose all parameter metadata), the test bundles, and the
public `justfiles/app-*` repositories as part of `sync-public-apps-and-skill.md`. An app that is
not migrated still loads and runs; its actions simply carry no `schema`.

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
