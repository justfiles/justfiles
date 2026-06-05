// biome-ignore-all lint/suspicious/noExplicitAny: variance-load-bearing — see Edge.transition
// The pure state machine: the minimal building block everything else is layered
// on. A machine is `init` plus a table of pure edges keyed by message type;
// `step` resolves an incoming message to its edge, validates the payload, and
// runs the transition. An edge may pair the next state with an opaque `Effect` —
// the machine never inspects it. The layer above interprets that effect (today a
// Command to run, later a Subscription to open, …) and may feed results back as
// further messages. Nothing here knows about commands, capabilities,
// subscriptions, the action surface, or the kernel, so each of those can be
// built — and later extracted into its own module — without touching this file.
import type { StandardSchemaV1 } from '@standard-schema/spec'

export type Message<Type extends string = string, Params = unknown> = {
	type: Type
	params: Params
	actor?: string
}

// One edge of the machine: pure and synchronous. Returns the next state, or the
// next state paired with an `Effect` for the layer above to carry out. The
// machine treats `Effect` opaquely; callers pin it (e.g. to `Command`).
export type Transition<State, Payload, Effect> = (
	state: State,
	payload: Payload
) => State | [State, Effect]

// A stored edge: an optional input schema (validated before the transition runs)
// and the transition itself. `S` carries the schema's type so a builder above can
// surface typed edges to a client; the machine only needs to validate against it.
// The payload type is erased here (`any`) — the builder keeps it; the machine
// just validates and forwards.
export interface Edge<
	State,
	Effect,
	S extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined
> {
	// Readonly so a concrete `Edge<…, Schema>` stays assignable to the
	// `Edge<…, undefined>`-or-wider bound (covariant in `S`).
	readonly schema?: S
	transition: Transition<State, any, Effect>
}

// What one `step` produces: the next `state` and any `effect` the edge emitted.
// Both optional — a transition that returns bare state emits no effect.
export interface Step<State, Effect> {
	state?: State
	effect?: Effect
}

// The compiled machine: `init` and the reduce (`step`). The edge table is closed
// over; callers route by message type through `step`, never by touching edges.
export interface Machine<State, Effect> {
	readonly init: State
	step(state: State | undefined, message: Message): Promise<Step<State, Effect>>
}

// Compile an edge table (keyed by the message type that selects it) into a
// machine. Resolution is an exact message-type match — any prefix convention for
// internal edges is the caller's concern, applied to the keys before building.
export function buildMachine<State, Effect>(
	init: State,
	edges: Record<string, Edge<State, Effect>>
): Machine<State, Effect> {
	return {
		init,
		async step(state, message) {
			const edge = edges[message.type]
			if (!edge) throw new Error(`unknown action: ${message.type}`)
			let payload: unknown = message.params
			if (edge.schema) {
				const r = await edge.schema['~standard'].validate(message.params)
				if (r.issues)
					throw new Error(
						`invalid params for ${message.type}: ${r.issues.map((i) => i.message).join('; ')}`
					)
				payload = r.value
			}
			const out = edge.transition(state ?? init, payload)
			const [next, effect] = Array.isArray(out) ? out : [out]
			return { state: next, effect }
		}
	}
}
