// The GUI runs behind a MessageChannel: the host holds one port and dispatches
// against the kernel; the guest holds the other, builds the app's typed client
// from it, and mounts the GUI. Every message across the port is structured-clone
// data — an action in, a result/state out — so no closures cross the boundary.
// Step 2 keeps both ports in the same realm; Step 3 relocates the guest port into
// a sandboxed iframe without changing this protocol.

import type { Message, Transport } from '@justfiles/app'

// guest→host: one request. host→guest: its reply, plus authoritative state pushes.
type GuestMessage = { type: 'invoke'; id: string; action: Message }
type HostMessage =
	| { type: 'invoked'; id: string; result: unknown }
	| { type: 'invokeError'; id: string; error: { message: string } }
	| { type: 'state'; state: unknown }

export interface GuiInstance {
	update(state: unknown): Promise<void> | void
	unmount(): Promise<void> | void
}

interface GuiModule {
	gui: { mount(el: HTMLElement, state: unknown, ctx: { transport: Transport }): GuiInstance }
}

// Host side: service the guest's invokes against `invoke` (a gated kernel
// dispatch) and return a `postState` the host's state sources call to push
// authoritative state to the guest.
export function guiHost(
	port: MessagePort,
	invoke: (action: Message) => Promise<unknown>
): (state: unknown) => void {
	port.onmessage = (e) => {
		const msg = e.data as GuestMessage
		if (msg.type !== 'invoke') return
		invoke(msg.action).then(
			(result) => port.postMessage({ type: 'invoked', id: msg.id, result } satisfies HostMessage),
			(error) =>
				port.postMessage({
					type: 'invokeError',
					id: msg.id,
					error: { message: error instanceof Error ? error.message : String(error) }
				} satisfies HostMessage)
		)
	}
	return (state) => port.postMessage({ type: 'state', state } satisfies HostMessage)
}

// Guest side: a Transport over the port. `invoke` correlates request/reply by id
// (mirrors sandboxClient); `subscribe` fans authoritative state pushes to the GUI.
function guiClient(port: MessagePort): Transport {
	let nextId = 0
	const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
	const subscribers = new Set<(state: unknown) => void>()
	port.onmessage = (e) => {
		const msg = e.data as HostMessage
		if (msg.type === 'state') {
			for (const fn of subscribers) fn(msg.state)
			return
		}
		const p = pending.get(msg.id)
		if (!p) return
		pending.delete(msg.id)
		if (msg.type === 'invokeError') p.reject(new Error(msg.error.message))
		else p.resolve(msg.result)
	}
	return {
		invoke: (action) =>
			new Promise((resolve, reject) => {
				const id = String(nextId++)
				pending.set(id, { resolve, reject })
				port.postMessage({ type: 'invoke', id, action } satisfies GuestMessage)
			}),
		subscribe: (onState) => {
			subscribers.add(onState)
			return () => void subscribers.delete(onState)
		}
	}
}

// Guest bootstrap: load the GUI bytes and mount them against a port-backed client.
// Step 3 relocates this into the iframe; only the module-load mechanism changes.
export async function bootGui(input: {
	el: HTMLElement
	port: MessagePort
	guiCode: string
	state: unknown
}): Promise<GuiInstance> {
	const url = URL.createObjectURL(new Blob([input.guiCode], { type: 'application/javascript' }))
	let mod: GuiModule
	try {
		mod = (await import(/* @vite-ignore */ url)) as GuiModule
	} finally {
		URL.revokeObjectURL(url)
	}
	return mod.gui.mount(input.el, input.state, { transport: guiClient(input.port) })
}
