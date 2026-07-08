import {
	Excalidraw,
	exportToSvg,
	hashElementsVersion,
	restore,
	serializeAsJSON
} from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { GUIProps } from '@justfiles/app/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DRAFT_PATH, type DrawApp } from './app.ts'
import './gui.css'

const EXT = '.excalidraw'
const AUTOSAVE_MS = 800

// A blank scene, written to the draft on "New" so an empty draft survives reload.
const EMPTY_SCENE = JSON.stringify({
	type: 'excalidraw',
	version: 2,
	source: 'justfiles-draw',
	elements: [],
	appState: {},
	files: {}
})

const titleOf = (path: string) => path.slice(1, -EXT.length)

// The minimal slice of Excalidraw's imperative API we touch.
interface ExcalidrawAPI {
	getSceneElements: () => readonly unknown[]
	getAppState: () => Record<string, unknown>
	getFiles: () => Record<string, unknown>
	// Re-reads the container's DOM rect (offsetLeft/offsetTop). Excalidraw derives
	// pointer→scene coords from those, so they must be refreshed after any resize.
	refresh: () => void
}

type SceneData = {
	elements?: unknown[]
	appState?: Record<string, unknown>
	files?: unknown
} | null

function parseScene(json: string): SceneData {
	if (!json) return null
	try {
		const data = JSON.parse(json) as SceneData
		return data && typeof data === 'object' ? data : null
	} catch {
		return null
	}
}

// A saved drawing plus the scene bytes needed to draw its thumbnail.
type GalleryItem = { path: string; title: string; json: string }

// One gallery tile's preview: render the scene to an SVG (headless — no editor
// instance) and drop it into the host div. Naive by design: every tile exports
// on mount, no caching.
function Thumbnail({ json }: { json: string }) {
	const hostRef = useRef<HTMLDivElement>(null)
	useEffect(() => {
		let alive = true
		void (async () => {
			const data = parseScene(json) ?? { elements: [], appState: {}, files: {} }
			const scene = restore(data as never, null, null)
			const svg = await exportToSvg({
				elements: scene.elements,
				appState: scene.appState,
				files: scene.files,
				maxWidthOrHeight: 320,
				exportPadding: 6,
				skipInliningFonts: true
			})
			if (!alive || !hostRef.current) return
			svg.removeAttribute('width')
			svg.removeAttribute('height')
			hostRef.current.replaceChildren(svg)
		})()
		return () => {
			alive = false
		}
	}, [json])
	return <div className="draw-thumb" ref={hostRef} />
}

export default function Draw({ state, actions }: GUIProps<DrawApp>) {
	const { openPath, error } = state

	// Excalidraw reads `initialData` once per mount, so switching documents bumps
	// `docKey` to force a clean remount with the new scene.
	const [initialData, setInitialData] = useState<SceneData>(null)
	const [docKey, setDocKey] = useState<string | null>(null)

	// Gallery view (null = editing on the canvas) + the "Save as…" name prompt.
	const [gallery, setGallery] = useState<GalleryItem[] | null>(null)
	const [naming, setNaming] = useState(false)
	const [nameValue, setNameValue] = useState('')

	// Force a reload of the draft even when openPath is unchanged (New on a draft).
	const [reloadSeq, setReloadSeq] = useState(0)

	const apiRef = useRef<ExcalidrawAPI | null>(null)
	const canvasHostRef = useRef<HTMLDivElement | null>(null)
	const pathRef = useRef<string>(DRAFT_PATH) // file the canvas autosaves to
	const dirtyRef = useRef(false)
	const versionRef = useRef<number | null>(null) // scene version of the last write/load
	const loadTokenRef = useRef(0)
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	const sceneJson = useCallback((): string => {
		const api = apiRef.current
		if (!api) return EMPTY_SCENE
		return serializeAsJSON(
			api.getSceneElements() as never,
			api.getAppState() as never,
			api.getFiles() as never,
			'local'
		)
	}, [])

	const hasContent = useCallback(() => (apiRef.current?.getSceneElements().length ?? 0) > 0, [])

	// Persist the dirty canvas to its file. Correctness comes from flush-if-dirty
	// on every transition (switch, New, hide); the debounce is only a perf win.
	const flush = useCallback(async () => {
		if (!dirtyRef.current || !apiRef.current) return
		dirtyRef.current = false
		await actions.save({ path: pathRef.current, json: sceneJson() })
	}, [actions, sceneJson])

	// Load a document's scene into the canvas (a fresh remount). A token drops
	// stale reads if the user switches documents mid-flight.
	const loadDoc = useCallback(
		async (path: string | null) => {
			const target = path ?? DRAFT_PATH
			const token = ++loadTokenRef.current
			const { json } = await actions.readScene({ path: target })
			if (loadTokenRef.current !== token) return
			const data = parseScene(json)
			pathRef.current = target
			dirtyRef.current = false
			// Baseline the version to the loaded scene so the mount-time onChange
			// (same elements) doesn't immediately mark the canvas dirty.
			versionRef.current = hashElementsVersion((data?.elements ?? []) as never)
			setInitialData(data)
			setDocKey(`${target}#${token}`)
		},
		[actions]
	)

	// The single load driver: launch, agent/GUI open/newDraft (openPath changes),
	// and forced draft reloads (reloadSeq). On first mount it wipes the draft so
	// every launch opens on a fresh blank canvas.
	const bootedRef = useRef(false)
	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadSeq is a manual reload trigger; actions is stable.
	useEffect(() => {
		void (async () => {
			if (!bootedRef.current) {
				bootedRef.current = true
				await actions.save({ path: DRAFT_PATH, json: EMPTY_SCENE })
			}
			await loadDoc(openPath)
		})()
	}, [openPath, reloadSeq, loadDoc])

	// Excalidraw fires onChange constantly (selection, scroll, zoom). Only a real
	// element change bumps the scene version — gate autosave on that, then debounce.
	const handleChange = useCallback(
		(elements: readonly unknown[]) => {
			const version = hashElementsVersion(elements as never)
			if (version === versionRef.current) return
			versionRef.current = version
			dirtyRef.current = true
			if (timerRef.current) clearTimeout(timerRef.current)
			timerRef.current = setTimeout(() => void flush(), AUTOSAVE_MS)
		},
		[flush]
	)

	const onNew = useCallback(async () => {
		await flush()
		setGallery(null)
		// Only an unsaved draft with content can lose work; a named drawing is
		// already autosaved, and an empty draft has nothing to lose.
		if (openPath === null && hasContent() && !window.confirm('Discard the current drawing?')) return
		await actions.save({ path: DRAFT_PATH, json: EMPTY_SCENE })
		dirtyRef.current = false
		if (openPath !== null) await actions.newDraft({})
		else setReloadSeq((n) => n + 1)
	}, [flush, openPath, hasContent, actions])

	const onSave = useCallback(async () => {
		await flush()
		// Save only prompts for a draft; a named drawing autosaves continuously.
		if (openPath === null) {
			setNameValue('')
			setNaming(true)
		}
	}, [flush, openPath])

	const submitName = useCallback(async () => {
		const name = nameValue.trim()
		if (!name) return
		const { path } = await actions.promote({ name, json: sceneJson() })
		dirtyRef.current = false
		setNaming(false)
		await actions.open({ path }) // stay on the now-named drawing
	}, [nameValue, sceneJson, actions])

	// Toggle the gallery. Opening it flushes the canvas, lists every saved drawing
	// and reads each scene up front so its thumbnail can render.
	const toggleGallery = useCallback(async () => {
		if (gallery) return setGallery(null)
		await flush()
		const saved = await actions.list({})
		const items = await Promise.all(
			saved.map(async ({ path, title }) => {
				const { json } = await actions.readScene({ path })
				return { path, title, json }
			})
		)
		setGallery(items)
	}, [gallery, flush, actions])

	// Open a drawing picked from the gallery: leave the gallery (remounts the
	// canvas) and let the openPath change drive the load. No flush — the canvas is
	// unmounted in gallery view, so nothing is dirty.
	const openDrawing = useCallback(
		async (path: string) => {
			setGallery(null)
			await actions.open({ path })
		},
		[actions]
	)

	// Best-effort flush as the window hides (a webview can tear down mid-debounce).
	useEffect(() => {
		const onHide = () => void flush()
		window.addEventListener('pagehide', onHide)
		document.addEventListener('visibilitychange', onHide)
		return () => {
			window.removeEventListener('pagehide', onHide)
			document.removeEventListener('visibilitychange', onHide)
		}
	}, [flush])

	// Realign Excalidraw's coordinate mapping with the viewport.
	//
	// Two independent fixes, both needed because the host mounts every app into a
	// `contain: paint` box (apps/frieren host), which (a) makes Excalidraw read
	// stale DOM offsets after a resize/move and (b) turns that box into the
	// containing block for `position: fixed` — so Excalidraw's `.SVGLayer` (the
	// laser trail + eraser cursor), which is `fixed` and draws in *viewport*
	// coordinates, gets anchored to the window's top-left instead of the viewport.
	//
	//  1. refresh(): re-reads offsetLeft/offsetTop so pointer→scene (pencil, hit
	//     testing) is correct.
	//  2. Counter-translate `.SVGLayer` so its origin sits back at the true viewport
	//     origin, cancelling the containing block's on-screen offset. `contain`
	//     still clips the layer to the window, so trails stay confined.
	const alignCanvas = useCallback(() => {
		apiRef.current?.refresh()
		const layer = canvasHostRef.current?.querySelector<HTMLElement>('.SVGLayer')
		if (!layer) return
		layer.style.transform = 'none'
		const { left, top } = layer.getBoundingClientRect()
		if (left || top) layer.style.transform = `translate(${-left}px, ${-top}px)`
	}, [])

	// Drive alignment on the events that move/resize the canvas: a resize (via
	// ResizeObserver, one frame later so layout has settled) and pointer entry
	// (covers a window drag — which fires no resize event — since a stroke always
	// starts by moving the cursor into the canvas). Gated on canvas view (the host
	// is unmounted in the gallery).
	useEffect(() => {
		const host = canvasHostRef.current
		if (gallery || !host) return
		let raf = 0
		const schedule = () => {
			cancelAnimationFrame(raf)
			raf = requestAnimationFrame(alignCanvas)
		}
		const ro = new ResizeObserver(schedule)
		ro.observe(host)
		window.addEventListener('resize', schedule)
		return () => {
			cancelAnimationFrame(raf)
			ro.disconnect()
			window.removeEventListener('resize', schedule)
		}
	}, [gallery, alignCanvas])

	useEffect(() => {
		document.title = openPath ? titleOf(openPath) : 'Untitled — Draw'
	}, [openPath])

	return (
		<div className="draw">
			<div className="draw-bar">
				{naming ? (
					<>
						<input
							// biome-ignore lint/a11y/noAutofocus: a name prompt focuses its field on open by design.
							autoFocus
							placeholder="Drawing name…"
							value={nameValue}
							onChange={(e) => setNameValue(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') void submitName()
								else if (e.key === 'Escape') setNaming(false)
							}}
						/>
						<button type="button" onClick={() => void submitName()}>
							Save
						</button>
						<button type="button" onClick={() => setNaming(false)}>
							Cancel
						</button>
					</>
				) : (
					<>
						<span className="draw-name" data-draft={openPath === null}>
							{gallery ? 'Gallery' : openPath ? titleOf(openPath) : 'Untitled draft'}
						</span>
						{error ? <span className="draw-error">{error}</span> : null}
						<span className="draw-spacer" />
						<button type="button" onClick={() => void onNew()}>
							New
						</button>
						<button type="button" onClick={() => void toggleGallery()}>
							{gallery ? 'Close' : 'Gallery'}
						</button>
						{gallery ? null : (
							<button type="button" onClick={() => void onSave()}>
								Save
							</button>
						)}
					</>
				)}
			</div>

			<div className="draw-body">
				{gallery ? (
					<div className="draw-gallery">
						{gallery.length === 0 ? (
							<div className="draw-gallery-empty">No saved drawings yet</div>
						) : (
							gallery.map((d) => (
								<button
									type="button"
									key={d.path}
									className="draw-tile"
									onClick={() => void openDrawing(d.path)}
								>
									<Thumbnail json={d.json} />
									<span className="draw-tile-name">{d.title}</span>
								</button>
							))
						)}
					</div>
				) : (
					<div className="draw-canvas" ref={canvasHostRef} onPointerEnter={alignCanvas}>
						{docKey ? (
							<Excalidraw
								key={docKey}
								excalidrawAPI={(api: unknown) => {
									apiRef.current = api as ExcalidrawAPI
								}}
								initialData={initialData as never}
								onChange={(elements: readonly unknown[]) => handleChange(elements)}
							/>
						) : null}
					</div>
				)}
			</div>
		</div>
	)
}
