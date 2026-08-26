import type { Notification } from '@justfiles/app/capabilities/notify'
import { expect, test } from 'vitest'
import { createNotificationStore } from './store'

const n = (over: Partial<Notification> = {}): Notification => ({
	id: crypto.randomUUID(),
	source: 'agent',
	kind: 'info',
	title: 'Frieren',
	body: 'done',
	...over
})

test('coalesces by threadId — a re-post replaces rather than stacks', () => {
	const store = createNotificationStore()
	store.notify(n({ id: 'a', threadId: 'agent', body: 'first' }))
	store.notify(n({ id: 'b', threadId: 'agent', body: 'second' }))
	const { entries, active } = store.snapshot()
	expect(entries).toHaveLength(1)
	expect(active?.notification.id).toBe('b')
	expect(active?.notification.body).toBe('second')
})

test('active is most-urgent-then-newest', () => {
	const store = createNotificationStore()
	store.notify(n({ id: 'info', kind: 'info' }))
	store.notify(n({ id: 'err', kind: 'error' }))
	store.notify(n({ id: 'q', kind: 'question' }))
	// error outranks a newer question/info.
	expect(store.snapshot().active?.notification.id).toBe('err')
})

test('newest wins on an urgency tie', () => {
	const store = createNotificationStore()
	store.notify(n({ id: 'old', kind: 'info' }))
	store.notify(n({ id: 'new', kind: 'info' }))
	expect(store.snapshot().active?.notification.id).toBe('new')
})

test('ring buffer is bounded and drops the oldest', () => {
	const store = createNotificationStore()
	for (let i = 0; i < 60; i++) store.notify(n({ id: `n${i}` }))
	const { entries } = store.snapshot()
	expect(entries).toHaveLength(50)
	expect(entries[0]?.notification.id).toBe('n10')
	expect(entries.at(-1)?.notification.id).toBe('n59')
})

test('dismiss recedes from the pill but stays unread in the center', () => {
	const store = createNotificationStore()
	store.notify(n({ id: 'a' }))
	store.notify(n({ id: 'b' }))
	// `a` is now queued behind the active `b`; dismissing `b` promotes `a`.
	store.dismiss('b')
	const snap = store.snapshot()
	expect(snap.active?.notification.id).toBe('a')
	expect(snap.entries).toHaveLength(2)
	// `b` receded, is unseen, and is no longer active → it now counts as unread.
	expect(snap.unread).toBe(1)
})

test('the active banner is excluded from unread; markSeen clears the badge', () => {
	const store = createNotificationStore()
	store.notify(n({ id: 'a' }))
	// Only entry is active → nothing in history yet.
	expect(store.snapshot().unread).toBe(0)
	store.dismiss('a')
	expect(store.snapshot().unread).toBe(1)
	store.markSeen()
	expect(store.snapshot().unread).toBe(0)
})

test('queued counts undismissed items behind the active one', () => {
	const store = createNotificationStore()
	store.notify(n({ id: 'a' }))
	store.notify(n({ id: 'b' }))
	store.notify(n({ id: 'c' }))
	expect(store.snapshot().queued).toBe(2)
})

test('clear empties the center', () => {
	const store = createNotificationStore()
	store.notify(n({ id: 'a' }))
	store.clear()
	const snap = store.snapshot()
	expect(snap.entries).toHaveLength(0)
	expect(snap.active).toBeNull()
	expect(snap.unread).toBe(0)
})

test('snapshot reference is stable until a mutation', () => {
	const store = createNotificationStore()
	const first = store.snapshot()
	expect(store.snapshot()).toBe(first)
	store.notify(n())
	expect(store.snapshot()).not.toBe(first)
})
