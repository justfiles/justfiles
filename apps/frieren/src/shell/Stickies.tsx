import { type MouseEvent, type PointerEvent, useEffect, useRef, useState } from 'react'
import type { Volume } from '../fs'
import { useOsRuntime } from '../os/hooks'

const DIR = '/stickies'
const INDEX = `${DIR}/index.json`
const WIDTH = 220
const HEIGHT = 180
const MARGIN = 8

interface Sticky {
	id: string
	x: number
	y: number
	text: string
}

type StickyFile = Omit<Sticky, 'id'>

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function Stickies() {
	const { volume } = useOsRuntime()
	const [stickies, setStickies] = useState<Sticky[]>([])
	const [focusId, setFocusId] = useState<string | null>(null)
	const stickiesRef = useRef(stickies)
	const writesRef = useRef(Promise.resolve())
	const readyRef = useRef(false)
	const focusRef = useRef<HTMLTextAreaElement>(null)
	const layerRef = useRef<HTMLDivElement>(null)
	const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null)
	const paths = stickies
		.map(({ id }) => pathFor(id))
		.sort()
		.join('\n')

	useEffect(() => {
		let cancelled = false
		let unwatch: (() => void) | undefined
		void volume.then(async (fs) => {
			const refresh = async () => {
				await splitIndex(fs)
				const loaded = await loadVisible(fs, layerRef.current)
				if (cancelled) return
				stickiesRef.current = loaded
				setStickies(loaded)
			}
			unwatch = await fs.watch(
				DIR,
				(event) => {
					if (event.source === 'remote') void refresh()
				},
				{ recursive: true }
			)
			await refresh()
			readyRef.current = true
		})
		return () => {
			cancelled = true
			unwatch?.()
		}
	}, [volume])

	useEffect(() => {
		let cancelled = false
		let unwatches: Array<() => void> = []
		void volume.then(async (fs) => {
			unwatches = await Promise.all(
				paths
					.split('\n')
					.filter(Boolean)
					.map((path) =>
						fs.watch(path, (event) => {
							if (event.source !== 'remote') return
							void loadVisible(fs, layerRef.current).then((loaded) => {
								if (cancelled) return
								stickiesRef.current = loaded
								setStickies(loaded)
							})
						})
					)
			)
			if (cancelled)
				unwatches.forEach((unwatch) => {
					unwatch()
				})
		})
		return () => {
			cancelled = true
			unwatches.forEach((unwatch) => {
				unwatch()
			})
		}
	}, [paths, volume])

	useEffect(() => {
		if (focusId) focusRef.current?.focus()
	}, [focusId])

	const show = (next: Sticky[]) => {
		stickiesRef.current = next
		setStickies(next)
	}
	const run = (task: () => Promise<void>) => {
		writesRef.current = writesRef.current.then(task).catch(() => {})
	}

	const add = (event: MouseEvent<HTMLDivElement>) => {
		if (!readyRef.current) return
		if (event.target instanceof Element && event.target.closest('.frn-sticky')) return
		const box = event.currentTarget.getBoundingClientRect()
		const sticky = {
			id: crypto.randomUUID(),
			x: event.clientX - box.left - WIDTH / 2,
			y: event.clientY - box.top - HEIGHT / 2,
			text: ''
		}
		const visible = clamp(sticky, box.width, box.height)
		setFocusId(sticky.id)
		show([...stickiesRef.current, visible])
		run(() => write(volume, visible, true))
	}

	const startDrag = (event: PointerEvent<HTMLDivElement>, sticky: Sticky) => {
		if (event.target !== event.currentTarget) return
		const box = layerRef.current?.getBoundingClientRect()
		if (!box) return
		dragRef.current = {
			id: sticky.id,
			dx: event.clientX - box.left - sticky.x,
			dy: event.clientY - box.top - sticky.y
		}
		event.currentTarget.setPointerCapture(event.pointerId)
	}

	const move = (event: PointerEvent<HTMLDivElement>, id: string) => {
		const drag = dragRef.current
		const box = layerRef.current?.getBoundingClientRect()
		const sticky = stickiesRef.current.find((item) => item.id === id)
		if (!drag || drag.id !== id || !box || !sticky) return
		const next = clamp(
			{ ...sticky, x: event.clientX - box.left - drag.dx, y: event.clientY - box.top - drag.dy },
			box.width,
			box.height
		)
		show(stickiesRef.current.map((item) => (item.id === id ? next : item)))
	}

	const endDrag = (event: PointerEvent<HTMLDivElement>, id: string) => {
		if (dragRef.current?.id !== id) return
		dragRef.current = null
		if (event.currentTarget.hasPointerCapture(event.pointerId))
			event.currentTarget.releasePointerCapture(event.pointerId)
		const sticky = stickiesRef.current.find((item) => item.id === id)
		if (sticky) run(() => write(volume, sticky, false))
	}

	const edit = (sticky: Sticky, text: string) => {
		const next = { ...sticky, text }
		show(stickiesRef.current.map((item) => (item.id === sticky.id ? next : item)))
		run(() => write(volume, next, false))
	}

	const remove = (id: string) => {
		show(stickiesRef.current.filter((sticky) => sticky.id !== id))
		run(async () => (await volume).rm(pathFor(id), { force: true }))
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: double-click is a pointer shortcut on the desktop
		<div ref={layerRef} className="frn-stickies" onDoubleClick={add}>
			{stickies.map((sticky) => (
				<div
					key={sticky.id}
					className="frn-sticky"
					style={{ left: sticky.x, top: sticky.y }}
					onPointerDown={(event) => startDrag(event, sticky)}
					onPointerMove={(event) => move(event, sticky.id)}
					onPointerUp={(event) => endDrag(event, sticky.id)}
					onPointerCancel={(event) => endDrag(event, sticky.id)}
				>
					<button
						type="button"
						className="frn-sticky-close"
						aria-label="Delete sticky"
						onClick={() => remove(sticky.id)}
					>
						×
					</button>
					<textarea
						ref={sticky.id === focusId ? focusRef : undefined}
						aria-label="Sticky note"
						value={sticky.text}
						onChange={(event) => edit(sticky, event.target.value)}
					/>
				</div>
			))}
		</div>
	)
}

async function splitIndex(volume: Volume): Promise<void> {
	if (!(await volume.exists(INDEX))) return
	try {
		const value: unknown = JSON.parse(decoder.decode(await volume.readFile(INDEX)))
		if (!Array.isArray(value)) return
		const stickies = value.filter(isSticky)
		await volume.mkdir(DIR, { recursive: true })
		await Promise.all(
			stickies.map(async (sticky) => {
				const path = pathFor(sticky.id)
				if (!(await volume.exists(path))) await write(volume, sticky, true)
			})
		)
		await volume.rm(INDEX)
	} catch {
		return
	}
}

async function load(volume: Volume): Promise<Sticky[]> {
	if (!(await volume.exists(DIR))) return []
	const entries = await volume.readdir(DIR)
	const stickies = await Promise.all(
		entries
			.filter(({ name }) => name.endsWith('.json') && name !== 'index.json')
			.map(async ({ name }) => {
				try {
					const value: unknown = JSON.parse(decoder.decode(await volume.readFile(`${DIR}/${name}`)))
					return isStickyFile(value) ? { id: name.slice(0, -5), ...value } : null
				} catch {
					return null
				}
			})
	)
	return stickies.filter((sticky): sticky is Sticky => sticky !== null)
}

async function loadVisible(volume: Volume, layer: HTMLDivElement | null): Promise<Sticky[]> {
	const loaded = await load(volume)
	if (!layer) return loaded
	const box = layer.getBoundingClientRect()
	const visible = loaded.map((sticky) => clamp(sticky, box.width, box.height))
	await Promise.all(
		visible.map((sticky, index) =>
			sticky === loaded[index] ? Promise.resolve() : write(volume, sticky, false)
		)
	)
	return visible
}

function clamp(sticky: Sticky, width: number, height: number): Sticky {
	const x = Math.max(MARGIN, Math.min(sticky.x, Math.max(MARGIN, width - WIDTH - MARGIN)))
	const y = Math.max(MARGIN, Math.min(sticky.y, Math.max(MARGIN, height - HEIGHT - MARGIN)))
	return x === sticky.x && y === sticky.y ? sticky : { ...sticky, x, y }
}

function isSticky(value: unknown): value is Sticky {
	return isStickyFile(value) && 'id' in value && typeof value.id === 'string'
}

function isStickyFile(value: unknown): value is StickyFile {
	if (!value || typeof value !== 'object') return false
	const sticky = value as Record<string, unknown>
	return (
		typeof sticky.x === 'number' && typeof sticky.y === 'number' && typeof sticky.text === 'string'
	)
}

function pathFor(id: string): string {
	return `${DIR}/${id}.json`
}

async function write(
	volume: Volume | Promise<Volume>,
	sticky: Sticky,
	create: boolean
): Promise<void> {
	const fs = await volume
	await fs.mkdir(DIR, { recursive: true })
	await fs.writeFile(
		pathFor(sticky.id),
		encoder.encode(JSON.stringify({ x: sticky.x, y: sticky.y, text: sticky.text })),
		create ? { exclusive: true } : { update: true }
	)
}
