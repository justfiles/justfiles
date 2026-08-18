import {
	CaptureUpdateAction,
	Excalidraw,
	exportToBlob,
	exportToSvg,
	hashElementsVersion,
	restore,
	serializeAsJSON,
	viewportCoordsToSceneCoords
} from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type {
	AppState,
	BinaryFiles,
	ExcalidrawImperativeAPI,
	ExcalidrawInitialDataState,
	ExcalidrawProps
} from '@excalidraw/excalidraw/types'
import type { Client } from '@justfiles/app'
import { defineGUI } from '@justfiles/app/browser'
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DRAFT_PATH, type IconApp, type IconState } from './app.ts'
import {
	DEFAULT_ICON_CAMERA,
	DEFAULT_ICON_SETTINGS,
	ICON_SIZE,
	type IconCamera,
	type IconSettings,
	iconExportScale,
	iconSettingsOf,
	withIconSettings
} from './icon-document.ts'
import { fitIcon, focusIconCamera, iconFrame } from './icon-frame.ts'
import { iconFitViewportFactor, iconWindowLayout, resizeIconViewport } from './icon-viewport.ts'
import { serializeIconSvg } from './svg-export.ts'
import './gui.css'

const EXT = '.excalidraw'
const AUTOSAVE_MS = 800
const PREVIEW_MS = 140
const DEFAULT_CANVAS_COLOR = '#ffffff'

const CANVAS_COLORS = [
	{ name: 'White', value: '#ffffff' },
	{ name: 'Blue', value: '#1677ff' },
	{ name: 'Purple', value: '#7c3aed' },
	{ name: 'Pink', value: '#e11d74' },
	{ name: 'Red', value: '#ef4444' },
	{ name: 'Orange', value: '#f97316' },
	{ name: 'Gold', value: '#eab308' },
	{ name: 'Green', value: '#22c55e' },
	{ name: 'Teal', value: '#06b6d4' }
] as const

const UI_OPTIONS: ExcalidrawProps['UIOptions'] = {
	canvasActions: {
		export: false,
		loadScene: false,
		saveToActiveFile: false
	}
}

const EMPTY_SCENE = JSON.stringify({
	type: 'excalidraw',
	version: 2,
	source: 'justfiles-icon',
	elements: [],
	appState: {},
	files: {},
	icon: DEFAULT_ICON_SETTINGS
})

type IconSceneData = ExcalidrawInitialDataState & { icon?: IconSettings }
type LiveScene = {
	elements: readonly OrderedExcalidrawElement[]
	appState: AppState
	files: BinaryFiles
	camera: IconCamera
}

const titleOf = (path: string) => path.slice(1, -EXT.length)

function parseScene(json: string): IconSceneData | null {
	if (!json) return null
	try {
		const data = JSON.parse(json) as unknown
		return data && typeof data === 'object' ? (data as IconSceneData) : null
	} catch {
		return null
	}
}

function canvasColorOf(data: IconSceneData | null): string {
	const color = data?.appState?.viewBackgroundColor
	return typeof color === 'string' ? color : DEFAULT_CANVAS_COLOR
}

function sceneSig(
	elements: readonly OrderedExcalidrawElement[],
	appState: AppState,
	files: BinaryFiles
): string {
	return `${hashElementsVersion(elements)}:${appState.viewBackgroundColor}:${Object.keys(files).length}:${appState.scrollX}:${appState.scrollY}:${appState.zoom.value}`
}

function downloadBlob(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob)
	const anchor = document.createElement('a')
	anchor.href = url
	anchor.download = filename
	anchor.hidden = true
	document.body.appendChild(anchor)
	anchor.click()
	anchor.remove()
	setTimeout(() => URL.revokeObjectURL(url), 0)
}

function SvgGraphic({ svg, label }: { svg: SVGSVGElement | null; label: string }) {
	const hostRef = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const host = hostRef.current
		if (!host) return
		host.replaceChildren(svg ? svg.cloneNode(true) : document.createElement('span'))
	}, [svg])
	return <div className="icon-preview-graphic" ref={hostRef} role="img" aria-label={label} />
}

function PreviewTile({ svg, size }: { svg: SVGSVGElement | null; size: number }) {
	const displaySize = Math.min(size, 148)
	return (
		<div className="icon-preview-tile">
			<div className="icon-preview-stage" style={{ width: displaySize, height: displaySize }}>
				<SvgGraphic svg={svg} label={`${size} pixel icon preview`} />
			</div>
			<span>
				{size} × {size}
			</span>
		</div>
	)
}

type GalleryItem = { path: string; title: string; json: string }

function Thumbnail({ json }: { json: string }) {
	const hostRef = useRef<HTMLDivElement>(null)
	useEffect(() => {
		let alive = true
		void (async () => {
			const data = parseScene(json) ?? { elements: [], appState: {}, files: {} }
			const settings = iconSettingsOf(data)
			const scene = restore(data, null, null)
			const svg = await exportToSvg({
				elements: scene.elements,
				appState: {
					...scene.appState,
					exportBackground: settings.exportBackground,
					exportScale: iconExportScale(settings.camera)
				},
				files: scene.files,
				exportingFrame: iconFrame(settings.camera),
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
	return <div className="icon-thumb" ref={hostRef} />
}

interface IconCreatorProps {
	state: IconState
	actions: Client<IconApp>
}

function IconCreator({ state, actions }: IconCreatorProps) {
	const { openPath, error } = state
	const [initialData, setInitialData] = useState<IconSceneData | null>(null)
	const [docKey, setDocKey] = useState<string | null>(null)
	const [gallery, setGallery] = useState<GalleryItem[] | null>(null)
	const [naming, setNaming] = useState(false)
	const [nameValue, setNameValue] = useState('')
	const [reloadSeq, setReloadSeq] = useState(0)
	const [previewSvg, setPreviewSvg] = useState<SVGSVGElement | null>(null)
	const [previewError, setPreviewError] = useState<string | null>(null)
	const [exporting, setExporting] = useState(false)
	const [exportBackground, setExportBackground] = useState(DEFAULT_ICON_SETTINGS.exportBackground)
	const [canvasColor, setCanvasColor] = useState(DEFAULT_CANVAS_COLOR)

	const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
	const editorHostRef = useRef<HTMLDivElement | null>(null)
	const outputFrameRef = useRef<HTMLDivElement | null>(null)
	const pathRef = useRef<string>(DRAFT_PATH)
	const dirtyRef = useRef(false)
	const sigRef = useRef<string | null>(null)
	const loadTokenRef = useRef(0)
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const previewTokenRef = useRef(0)
	const latestSceneRef = useRef<LiveScene | null>(null)
	const exportBackgroundRef = useRef(exportBackground)
	const canvasColorRef = useRef(canvasColor)
	const cameraRef = useRef<IconCamera>(DEFAULT_ICON_CAMERA)
	const cameraReadyRef = useRef(false)

	const sceneJson = useCallback((): string => {
		const api = apiRef.current
		if (!api) return EMPTY_SCENE
		return withIconSettings(
			serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), 'local'),
			{
				exportBackground: exportBackgroundRef.current,
				camera: cameraRef.current
			}
		)
	}, [])

	const hasContent = useCallback(() => (apiRef.current?.getSceneElements().length ?? 0) > 0, [])

	const flush = useCallback(async () => {
		if (!dirtyRef.current || !apiRef.current) return
		dirtyRef.current = false
		await actions.save({ path: pathRef.current, json: sceneJson() })
	}, [actions, sceneJson])

	const scheduleSave = useCallback(() => {
		dirtyRef.current = true
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
		saveTimerRef.current = setTimeout(() => void flush(), AUTOSAVE_MS)
	}, [flush])

	const renderPreview = useCallback(async () => {
		const scene = latestSceneRef.current
		if (!scene) return
		const token = ++previewTokenRef.current
		try {
			const svg = await exportToSvg({
				elements: scene.elements,
				appState: {
					...scene.appState,
					exportBackground: exportBackgroundRef.current,
					exportEmbedScene: false,
					exportScale: iconExportScale(scene.camera)
				},
				files: scene.files,
				exportingFrame: iconFrame(scene.camera),
				skipInliningFonts: true
			})
			if (token !== previewTokenRef.current) return
			svg.removeAttribute('width')
			svg.removeAttribute('height')
			setPreviewSvg(svg)
			setPreviewError(null)
		} catch (cause) {
			if (token !== previewTokenRef.current) return
			setPreviewError(cause instanceof Error ? cause.message : 'Preview failed')
		}
	}, [])

	const schedulePreview = useCallback(() => {
		if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
		previewTimerRef.current = setTimeout(() => void renderPreview(), PREVIEW_MS)
	}, [renderPreview])

	const layoutOutputFrame = useCallback(() => {
		const host = editorHostRef.current
		const frame = outputFrameRef.current
		if (!host || !frame) return
		const layout = iconWindowLayout(host.clientWidth, host.clientHeight)
		frame.style.left = `${layout.left}px`
		frame.style.top = `${layout.top}px`
		frame.style.width = `${layout.size}px`
		frame.style.height = `${layout.size}px`
		frame.style.visibility = 'visible'
	}, [])

	const viewportFactor = useCallback((appState: AppState): number => {
		const frame = outputFrameRef.current
		if (!frame || appState.width < 1 || appState.height < 1) return 0.82
		const rect = frame.getBoundingClientRect()
		return Math.min(1, Math.max(0.05, rect.width / Math.min(appState.width, appState.height)))
	}, [])

	const cameraFromView = useCallback((appState: AppState): IconCamera => {
		const frame = outputFrameRef.current
		if (!frame) return cameraRef.current
		const rect = frame.getBoundingClientRect()
		if (rect.width < 1 || rect.height < 1) return cameraRef.current
		const topLeft = viewportCoordsToSceneCoords({ clientX: rect.left, clientY: rect.top }, appState)
		return {
			x: topLeft.x,
			y: topLeft.y,
			size: rect.width / appState.zoom.value
		}
	}, [])

	const loadDoc = useCallback(
		async (path: string | null) => {
			const target = path ?? DRAFT_PATH
			const token = ++loadTokenRef.current
			const { json } = await actions.readScene({ path: target })
			if (loadTokenRef.current !== token) return
			const data = parseScene(json)
			const settings = iconSettingsOf(data)
			const nextCanvasColor = canvasColorOf(data)
			pathRef.current = target
			dirtyRef.current = false
			sigRef.current = null
			latestSceneRef.current = null
			cameraReadyRef.current = false
			cameraRef.current = settings.camera
			exportBackgroundRef.current = settings.exportBackground
			canvasColorRef.current = nextCanvasColor
			setExportBackground(settings.exportBackground)
			setCanvasColor(nextCanvasColor)
			setPreviewSvg(null)
			setInitialData(data)
			setDocKey(`${target}#${token}`)
		},
		[actions]
	)

	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadSeq is a manual reload trigger.
	useEffect(() => {
		void loadDoc(openPath)
	}, [openPath, reloadSeq, loadDoc])

	const handleChange = useCallback(
		(elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
			if (canvasColorRef.current !== appState.viewBackgroundColor) {
				canvasColorRef.current = appState.viewBackgroundColor
				setCanvasColor(appState.viewBackgroundColor)
			}
			const camera = cameraReadyRef.current ? cameraFromView(appState) : cameraRef.current
			cameraRef.current = camera
			latestSceneRef.current = { elements, appState, files, camera }
			const sig = sceneSig(elements, appState, files)
			if (sigRef.current === null) {
				sigRef.current = sig
				schedulePreview()
				return
			}
			if (sig === sigRef.current) return
			sigRef.current = sig
			scheduleSave()
			schedulePreview()
		},
		[cameraFromView, schedulePreview, scheduleSave]
	)

	const onNew = useCallback(async () => {
		await flush()
		setGallery(null)
		if (openPath === null && hasContent() && !window.confirm('Discard the current icon?')) return
		await actions.save({ path: DRAFT_PATH, json: EMPTY_SCENE })
		dirtyRef.current = false
		if (openPath !== null) await actions.newDraft({})
		else setReloadSeq((n) => n + 1)
	}, [flush, openPath, hasContent, actions])

	const onSave = useCallback(async () => {
		await flush()
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
		await actions.open({ path })
	}, [nameValue, sceneJson, actions])

	const toggleGallery = useCallback(async () => {
		if (gallery) {
			setGallery(null)
			return
		}
		// Preserve the live scene as the next mount's initial data before the editor
		// is replaced by the gallery.
		setInitialData(parseScene(sceneJson()))
		cameraReadyRef.current = false
		await flush()
		const saved = await actions.list({})
		const items = await Promise.all(
			saved.map(async ({ path, title }) => {
				const { json } = await actions.readScene({ path })
				return { path, title, json }
			})
		)
		setGallery(items)
	}, [gallery, sceneJson, flush, actions])

	const openIcon = useCallback(
		async (path: string) => {
			setGallery(null)
			await actions.open({ path })
		},
		[actions]
	)

	const changeExportBackground = useCallback(
		(checked: boolean) => {
			exportBackgroundRef.current = checked
			setExportBackground(checked)
			scheduleSave()
			schedulePreview()
		},
		[schedulePreview, scheduleSave]
	)

	const changeCanvasColor = useCallback((color: string) => {
		const api = apiRef.current
		if (!api) return
		canvasColorRef.current = color
		setCanvasColor(color)
		api.updateScene({
			appState: { viewBackgroundColor: color },
			captureUpdate: CaptureUpdateAction.IMMEDIATELY
		})
	}, [])

	const exportIcon = useCallback(
		async (format: 'png' | 'svg') => {
			const api = apiRef.current
			if (!api || exporting) return
			setExporting(true)
			setPreviewError(null)
			try {
				cameraRef.current = cameraFromView(api.getAppState())
				await flush()
				const elements = api.getSceneElements()
				const files = api.getFiles()
				const camera = cameraRef.current
				const appState = {
					...api.getAppState(),
					exportBackground: exportBackgroundRef.current,
					exportEmbedScene: false,
					exportScale: iconExportScale(camera)
				}
				const basename = pathRef.current === DRAFT_PATH ? 'untitled_icon' : titleOf(pathRef.current)
				const exportTitle =
					pathRef.current === DRAFT_PATH ? 'Untitled icon' : titleOf(pathRef.current)
				if (format === 'png') {
					const blob = await exportToBlob({
						elements,
						appState,
						files,
						exportingFrame: iconFrame(camera),
						getDimensions: () => ({
							width: ICON_SIZE,
							height: ICON_SIZE,
							scale: iconExportScale(camera)
						}),
						mimeType: 'image/png'
					})
					downloadBlob(blob, `${basename}.png`)
				} else {
					const svg = await exportToSvg({
						elements,
						appState,
						files,
						exportingFrame: iconFrame(camera)
					})
					downloadBlob(
						new Blob([serializeIconSvg(svg.outerHTML, exportTitle)], {
							type: 'image/svg+xml'
						}),
						`${basename}.svg`
					)
				}
			} catch (cause) {
				setPreviewError(cause instanceof Error ? cause.message : 'Export failed')
			} finally {
				setExporting(false)
			}
		},
		[cameraFromView, exporting, flush]
	)

	useEffect(() => {
		const onHide = () => void flush()
		window.addEventListener('pagehide', onHide)
		document.addEventListener('visibilitychange', onHide)
		return () => {
			window.removeEventListener('pagehide', onHide)
			document.removeEventListener('visibilitychange', onHide)
		}
	}, [flush])

	const alignCanvas = useCallback(() => {
		const api = apiRef.current
		api?.refresh()
		const layer = editorHostRef.current?.querySelector<HTMLElement>('.SVGLayer')
		if (layer) {
			layer.style.transform = 'none'
			const { left, top } = layer.getBoundingClientRect()
			if (left || top) layer.style.transform = `translate(${-left}px, ${-top}px)`
		}
		layoutOutputFrame()
	}, [layoutOutputFrame])

	useEffect(() => {
		const host = editorHostRef.current
		if (gallery || !host) return
		let raf = 0
		const schedule = () => {
			cancelAnimationFrame(raf)
			raf = requestAnimationFrame(() => {
				alignCanvas()
				const api = apiRef.current
				if (api && cameraReadyRef.current) {
					const appState = api.getAppState()
					const hostRect = host.getBoundingClientRect()
					const resized = resizeIconViewport({
						width: host.clientWidth,
						height: host.clientHeight,
						hostLeft: hostRect.left,
						hostTop: hostRect.top,
						offsetLeft: appState.offsetLeft,
						offsetTop: appState.offsetTop,
						scrollX: appState.scrollX,
						scrollY: appState.scrollY,
						zoom: appState.zoom.value
					})
					cameraRef.current = resized.camera
					latestSceneRef.current = {
						elements: api.getSceneElements(),
						appState,
						files: api.getFiles(),
						camera: resized.camera
					}
					scheduleSave()
					schedulePreview()
				}
			})
		}
		const ro = new ResizeObserver(schedule)
		ro.observe(host)
		window.addEventListener('resize', schedule)
		return () => {
			cancelAnimationFrame(raf)
			ro.disconnect()
			window.removeEventListener('resize', schedule)
		}
	}, [gallery, alignCanvas, schedulePreview, scheduleSave])

	useEffect(
		() => () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
			if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
			previewTokenRef.current++
		},
		[]
	)

	useEffect(() => {
		document.title = openPath ? `${titleOf(openPath)} — Icon` : 'Untitled — Icon'
	}, [openPath])

	const initializeApi = useCallback(
		(api: ExcalidrawImperativeAPI) => {
			apiRef.current = api
			requestAnimationFrame(() => {
				alignCanvas()
				focusIconCamera(api, cameraRef.current, viewportFactor(api.getAppState()))
				requestAnimationFrame(() => {
					cameraReadyRef.current = true
					const appState = api.getAppState()
					const camera = cameraFromView(appState)
					cameraRef.current = camera
					latestSceneRef.current = {
						elements: api.getSceneElements(),
						appState,
						files: api.getFiles(),
						camera
					}
					sigRef.current = sceneSig(
						latestSceneRef.current.elements,
						appState,
						latestSceneRef.current.files
					)
					schedulePreview()
				})
			})
		},
		[alignCanvas, cameraFromView, schedulePreview, viewportFactor]
	)

	const normalizedCanvasColor = canvasColor.toLowerCase()
	const customCanvasColor = /^#[0-9a-f]{6}$/i.test(canvasColor) ? canvasColor : DEFAULT_CANVAS_COLOR
	const hasCustomCanvasColor = !CANVAS_COLORS.some((color) => color.value === normalizedCanvasColor)

	return (
		<div className="icon-app">
			<div className="icon-bar">
				{naming ? (
					<>
						<input
							// biome-ignore lint/a11y/noAutofocus: a name prompt focuses its field on open by design.
							autoFocus
							placeholder="Icon name…"
							value={nameValue}
							onChange={(event) => setNameValue(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Enter') void submitName()
								else if (event.key === 'Escape') setNaming(false)
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
						<span className="icon-name" data-draft={openPath === null}>
							{gallery ? 'Icon projects' : openPath ? titleOf(openPath) : 'Untitled icon'}
						</span>
						{error ? <span className="icon-error">{error}</span> : null}
						<span className="icon-spacer" />
						<button type="button" onClick={() => void onNew()}>
							New
						</button>
						<button type="button" onClick={() => void toggleGallery()}>
							{gallery ? 'Close' : 'Projects'}
						</button>
						{gallery ? null : (
							<>
								<button
									type="button"
									onClick={() => {
										const api = apiRef.current
										if (api) {
											fitIcon(api, iconFitViewportFactor(viewportFactor(api.getAppState())))
										}
									}}
								>
									Fit artwork
								</button>
								<button type="button" disabled={exporting} onClick={() => void exportIcon('png')}>
									PNG
								</button>
								<button type="button" disabled={exporting} onClick={() => void exportIcon('svg')}>
									SVG
								</button>
								<button type="button" onClick={() => void onSave()}>
									Save
								</button>
							</>
						)}
					</>
				)}
			</div>

			<div className="icon-body">
				{gallery ? (
					<div className="icon-gallery">
						{gallery.length === 0 ? (
							<div className="icon-gallery-empty">No saved icon projects yet</div>
						) : (
							gallery.map((item) => (
								<button
									type="button"
									key={item.path}
									className="icon-tile"
									onClick={() => void openIcon(item.path)}
								>
									<Thumbnail json={item.json} />
									<span className="icon-tile-name">{item.title}</span>
								</button>
							))
						)}
					</div>
				) : (
					<div className="icon-workspace">
						<div className="icon-editor" ref={editorHostRef} onPointerEnter={alignCanvas}>
							{docKey ? (
								<Excalidraw
									key={docKey}
									excalidrawAPI={initializeApi}
									initialData={initialData}
									onChange={handleChange}
									UIOptions={UI_OPTIONS}
								/>
							) : null}
							<div className="icon-output-frame" ref={outputFrameRef} aria-hidden="true">
								<span>
									{ICON_SIZE} × {ICON_SIZE}
								</span>
							</div>
						</div>

						<aside className="icon-previews" aria-label="Icon output previews">
							<div className="icon-previews-heading">
								<div>
									<strong>Output</strong>
									<span>
										{ICON_SIZE} × {ICON_SIZE} px
									</span>
								</div>
								<label>
									<input
										type="checkbox"
										checked={exportBackground}
										onChange={(event) => changeExportBackground(event.target.checked)}
									/>
									Show canvas background
								</label>
								<fieldset className="icon-background-palette">
									<legend>Canvas background color</legend>
									{CANVAS_COLORS.map((color) => (
										<button
											type="button"
											key={color.value}
											className="icon-color-swatch"
											style={{ backgroundColor: color.value }}
											data-selected={normalizedCanvasColor === color.value}
											aria-label={`${color.name} canvas background`}
											aria-pressed={normalizedCanvasColor === color.value}
											title={color.name}
											onClick={() => changeCanvasColor(color.value)}
										/>
									))}
									<label
										className="icon-color-custom"
										data-selected={hasCustomCanvasColor}
										title="Custom color"
									>
										<input
											type="color"
											value={customCanvasColor}
											aria-label="Custom canvas background color"
											onChange={(event) => changeCanvasColor(event.target.value)}
										/>
									</label>
								</fieldset>
							</div>
							{previewError ? <div className="icon-preview-error">{previewError}</div> : null}
							<div className="icon-preview-list">
								{[256, 128, 64, 32, 16].map((size) => (
									<PreviewTile key={size} svg={previewSvg} size={size} />
								))}
							</div>
							<p>Zoom and pan the artwork behind the fixed purple output window.</p>
						</aside>
					</div>
				)}
			</div>
		</div>
	)
}

const INITIAL: IconState = { openPath: null, error: null }

export const gui = defineGUI<IconApp>({
	mount(el, state, ctx) {
		const root = createRoot(el)
		const render = (next: IconState | null) =>
			root.render(
				<StrictMode>
					<IconCreator state={next ?? INITIAL} actions={ctx.client} />
				</StrictMode>
			)
		render(state)
		return {
			update: render,
			unmount() {
				root.unmount()
			}
		}
	}
})
