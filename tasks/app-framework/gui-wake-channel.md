---
project: packages/app
status: deferred
---

# A wake channel that does not write state

## TL;DR

The only way an external change reaches the GUI is through the reducer: a stream event folds into
a transition that bumps a `revision` counter, the counter is persisted to `/state/<id>.json`, the
state is pushed, and the GUI re-reads the data through a procedure. The counter exists only to
carry the wake. Three designs have pushed back on paying a persisted write per wake. Deferred: wait
for one more case before adding a second channel.

## Proposed change

Sketch only. Additive, SDK:

```ts
// subscriptions(state, sub)
sub.capability('volume', 'watch', { path: '/', recursive: true }).coalesce().wake('tree')
// GUI
mount(el, state, { client, wakes })   // wakes.on('tree', () => refetch())
```

Kernel: a `wake` subscription is diffed and kept alive exactly like a `to(edge)` subscription, but
its events are forwarded to connected GUIs over the existing state transport as a small
`{ type: 'wake', name }` frame instead of being dispatched into the reducer. Nothing is written.

## Why this is not done now

- **It adds a second channel.** Today the GUI has one input: state. A wake channel is a second
  kind of message with its own lifecycle and its own place in the bridge. The framework should
  resist that until the cost of the counter pattern is clearly higher than the cost of a concept.
- **The counter pattern has real virtues.** It is recoverable by construction, because the stream
  set is a pure function of persisted state, and the agent sees the same signal the GUI sees.
- **The cost is real and growing.** A persisted write per wake, and semantically empty fields in
  agent-visible state, are exactly the kind of thing the state discipline tells authors to avoid.
  The newest app's design rejects the counter and plans foreground polling instead, which is a
  worse outcome than either option.

Revisit when a fourth app reaches for polling or a counter, or when a wake source appears whose
event rate makes a write per event unacceptable.
