import { describe, expect, test } from 'vitest'
import { Coalescer } from './coalescer.ts'

describe('Coalescer', () => {
	test('schedule runs immediately when idle', async () => {
		const c = new Coalescer()
		let ran = false
		await c.schedule(() => {
			ran = true
		})
		expect(ran).toBe(true)
	})

	test('schedule defers while busy and flushes on release', async () => {
		const c = new Coalescer()
		const order: string[] = []
		let release: () => void = () => {}
		const work = new Promise<void>((resolve) => {
			release = resolve
		})

		const tracked = c.during(async () => {
			order.push('start')
			await work
			order.push('end')
		})

		await c.schedule(() => {
			order.push('mid')
		})
		expect(order).toEqual(['start'])

		release()
		await tracked
		expect(order).toEqual(['start', 'end', 'mid'])
	})

	test('multiple deferred actions flush in FIFO order', async () => {
		const c = new Coalescer()
		const order: number[] = []
		let release: () => void = () => {}
		const work = new Promise<void>((resolve) => {
			release = resolve
		})

		const tracked = c.during(async () => {
			await work
		})

		await c.schedule(() => {
			order.push(1)
		})
		await c.schedule(() => {
			order.push(2)
		})
		await c.schedule(() => {
			order.push(3)
		})

		release()
		await tracked
		expect(order).toEqual([1, 2, 3])
	})

	test('exception in tracked work still flushes the queue', async () => {
		const c = new Coalescer()
		let ran = false
		await expect(
			c.during(async () => {
				queueMicrotask(() => {
					c.schedule(() => {
						ran = true
					})
				})
				await Promise.resolve()
				throw new Error('boom')
			})
		).rejects.toThrow('boom')
		expect(ran).toBe(true)
	})
})
