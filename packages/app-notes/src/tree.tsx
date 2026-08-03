import type { ContextMenuItem, ContextMenuOpenContext, FileTreeBatchOperation } from '@pierre/trees'
import { FileTree, useFileTree } from '@pierre/trees/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Entry } from './app.ts'
import { joinPath, matchNotes, parentDir } from './notes.ts'

// The docked pane's tree. `@pierre/trees` owns the hard parts — virtualized
// rows, expansion, drag-and-drop, the context-menu trigger — so this file is
// only the seam between its path-first model and our volume paths: it feeds
// paths in and turns each gesture into one of the app's actions.
//
// The model is a PROJECTION, never the truth: every gesture persists through an
// action, and the `treeRevision` watch re-lists `/notes` and `resetPaths`. A
// failed write therefore self-heals on the next scan.
//
// Naming (new note, new folder, rename) is done by OUR menu, not the library's
// inline rename: the inline input is torn down by the context menu's own close /
// focus path, so it never survives long enough to type into. One text field in
// the menu covers all three, and a new note needs a name before it exists
// (DESIGN.md §4) — which is exactly what the field collects.

// The model speaks relative paths and marks folders with a trailing slash;
// the volume speaks absolute paths.
const toTree = (path: string, isDir: boolean) => `${path.slice(1)}${isDir ? '/' : ''}`
const fromTree = (path: string) => `/${path.replace(/\/+$/, '')}`

// Every directory above a tree path, shallowest first: `a/b/c.md` ->
// [`a/`, `a/b/`]. Search resets use these to keep nested matches visible.
function ancestorDirs(paths: string[]): string[] {
	const dirs = new Set<string>()
	for (const path of paths)
		for (let cut = path.indexOf('/'); cut !== -1; cut = path.indexOf('/', cut + 1))
			dirs.add(path.slice(0, cut + 1))
	return [...dirs]
}

export type NotesTreeProps = {
	entries: Entry[]
	openPath: string | null
	// The bar's field is the only search box; it filters the tree in place.
	query: string
	onOpen: (path: string) => void
	onSelectDir: (dir: string) => void
	onCreate: (dir: string, title: string) => void
	onMkdir: (path: string) => void
	// Awaited, and it answers WHERE the note ended up (`null` = it did not move). The drop
	// path needs it at `to`: anything else — refused, or deduped to a free name — leaves the
	// model holding a row no listing will mention, which has to be repaired. A multi-item
	// drop is applied ONE AT A TIME (see `persistDrop`).
	onRename: (from: string, to: string) => Promise<string | null>
	onRemove: (path: string) => void
}

export function NotesTree(props: NotesTreeProps) {
	// The hook builds the model once, so the handlers it captured must read the
	// latest props through a ref (the `app-code` pattern).
	const latest = useRef(props)
	latest.current = props

	// One drop can carry several items, and two of them can want the SAME
	// destination name (`/A/Kyoto.md` and `/B/Kyoto.md` dropped on the root). Applied
	// in sequence, so the second one finds the name taken and gets numbered; fired in
	// parallel they would race for it, and no filesystem primitive can decide that
	// race for us (packages/fs/volume.ts `rename`). Ordering our own writes is the
	// cheap half of that problem — this is the only place this app makes more than
	// one at a time.
	const persistDrop = async (
		draggedPaths: readonly string[],
		target: { kind: 'directory' | 'root'; directoryPath: string | null }
	) => {
		const dir = target.kind === 'root' ? '/' : fromTree(target.directoryPath ?? '')
		let landed = true
		for (const dragged of draggedPaths) {
			const from = fromTree(dragged)
			const to = joinPath(dir, from.slice(from.lastIndexOf('/') + 1))
			if (to !== from && (await latest.current.onRename(from, to)) !== to) landed = false
		}
		// The model moved the rows ITSELF, before a byte was written. Where the disk did
		// not end up agreeing, it now holds a row no listing will ever mention — and a
		// listing that did not change cannot correct it, since a refused move changes
		// nothing on disk. So put the model back to the last listing we fed it; if a
		// newer one is on its way (a deduped name), the reconcile effect takes it from
		// there.
		if (!landed)
			model.resetPaths(fed.current.paths, {
				initialExpandedPaths: fed.current.query ? ancestorDirs(fed.current.paths) : undefined
			})
	}

	// Filtering is OUR matcher (the same one the dropdown ranks with), applied to
	// the paths we feed — not the tree's own search session. One search rule for
	// both surfaces, and no session state to keep in sync. Folders are implied by
	// their children, so a filtered view feeds matching notes only.
	//
	// `entries` is RE-LISTED on signals that say nothing about the tree's shape —
	// opening a note re-lists so the recency order follows its mtime — and each scan
	// is a fresh array. Hence TWO gates, guarding two different things: the key is
	// rebuilt only when a scan hands over a new array (identity), which keeps a walk
	// of the whole vault off every editor keystroke — each one re-renders this
	// component; the paths are rebuilt only when that key's VALUE differs (kinds and
	// paths; an mtime is not the tree's business), which is what leaves the folds
	// alone on a re-list that changed no rows.
	//
	// Every part is LENGTH-PREFIXED, so no two listings can spell the same key: a
	// note's name may legally hold whatever a separator would be (`isCanonicalPath`
	// forbids only `/`, `.`, `..` and empty segments — a newline is a fine filename,
	// and an import preserves it), and a key that collides freezes the tree on a
	// stale set. Cheaper than escaping, and the same one pass over the listing.
	const query = props.query.trim()
	const pathsKey = useMemo(() => {
		let key = `${query.length}:${query}`
		for (const entry of props.entries) key += `${entry.type}${entry.path.length}:${entry.path}`
		return key
	}, [props.entries, query])
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional — recompute only when the path set changes by value (pathsKey), not on every re-list of the same rows (see above).
	const paths = useMemo(() => {
		const files = props.entries.filter((entry) => entry.type === 'file')
		if (query) return matchNotes(files, query).map((entry) => toTree(entry.path, false))
		return props.entries.map((entry) => toTree(entry.path, entry.type === 'dir'))
	}, [pathsKey])

	const { model } = useFileTree({
		paths,
		// Match Files: start with every folder collapsed, then preserve whatever the
		// user opens through the incremental reconciliation below.
		initialExpansion: 'closed',
		itemHeight: 24,
		density: 0.9,
		composition: { contextMenu: { enabled: true, triggerMode: 'both' } },
		dragAndDrop: {
			// One move per dragged row. Both callbacks persist, because the model's own
			// move is optimistic AND collision-strict: dropping onto a folder that
			// already holds that name throws inside the store (`collision: 'error'`), so
			// `onDropComplete` never fires and the drag would look like a no-op. The
			// reducer dedups instead (`Kyoto 2.md`), and the `treeRevision` watch redraws
			// whatever actually landed — the disk stays the truth either way.
			onDropComplete: ({ draggedPaths, target }) => void persistDrop(draggedPaths, target),
			onDropError: (_error, { draggedPaths, target }) => void persistDrop(draggedPaths, target)
		},
		onSelectionChange: (selected) => {
			const path = selected[0]
			if (path === undefined) return
			const { onOpen, onSelectDir } = latest.current
			if (model.getItem(path)?.isDirectory()) onSelectDir(fromTree(path))
			else onOpen(fromTree(path))
		}
	})

	// The model was built with the initial `paths`; every later change is applied
	// INCREMENTALLY. `resetPaths` is a whole-tree rebuild that re-applies
	// `initialExpansion: 'closed'`, so it snaps every folder back closed.
	// A filtered view is the exception both ways: its matches have to be visible
	// without hunting for folds, so entering or leaving a search does reset.
	//
	// `fed` is what the model was last TOLD to hold — seeded with the paths
	// `useFileTree` built it from, so the first run reconciles nothing.
	const fed = useRef({ paths, query })
	useEffect(() => {
		const prev = fed.current
		fed.current = { paths, query }
		if (query || prev.query)
			model.resetPaths(paths, { initialExpandedPaths: query ? ancestorDirs(paths) : undefined })
		else applyPathDiff(model, prev.paths, paths)
	}, [model, paths, query])

	// Follow the open note when it changed elsewhere (search field, agent).
	useEffect(() => {
		if (!props.openPath) return
		const path = toTree(props.openPath, false)
		if (!model.getItem(path)) return
		const selected = model.getSelectedPaths()
		if (selected.length === 1 && selected[0] === path) return
		for (const other of selected) model.getItem(other)?.deselect()
		model.getItem(path)?.select()
		model.scrollToPath(path, { focus: false })
	}, [model, props.openPath])

	// Dropping on the blank area below the rows moves an item to the top level —
	// the standard file-tree affordance (Finder sidebar, VS Code), which the library
	// doesn't cover: it resolves a drop target from ROW elements only, so a drop
	// past the last row resolves to nothing. Drags are native HTML5 and carry the
	// dragged path as `text/plain`, and drag events cross the shadow boundary, so
	// this wrapper can serve as the root zone. `composedPath` tells the two apart:
	// if the drop landed on a row, the tree owns it.
	const [rootDrop, setRootDrop] = useState(false)
	const overRow = (event: React.DragEvent) =>
		event.nativeEvent
			.composedPath()
			.some((node) => node instanceof HTMLElement && node.dataset.type === 'item')

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a drop zone, not a control — the tree's rows own the keyboard/ARIA surface.
		<div
			className="notes-tree-wrap"
			data-root-drop={rootDrop || undefined}
			onDragOver={(event) => {
				// A file drag is an import: not ours, and not a "move to top level".
				if (isFileDrag(event) || overRow(event)) {
					setRootDrop(false)
					return
				}
				event.preventDefault()
				event.dataTransfer.dropEffect = 'move'
				setRootDrop(true)
			}}
			onDragLeave={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setRootDrop(false)
			}}
			onDrop={(event) => {
				setRootDrop(false)
				if (isFileDrag(event) || overRow(event)) return
				const dragged = event.dataTransfer.getData('text/plain')
				if (!dragged) return
				event.preventDefault()
				const from = fromTree(dragged)
				const to = joinPath('/', from.slice(from.lastIndexOf('/') + 1))
				if (to !== from) void props.onRename(from, to)
			}}
		>
			<FileTree
				model={model}
				className="notes-tree"
				renderContextMenu={(item, context) => (
					<MenuLayer item={item} context={context} {...props} />
				)}
			/>
		</div>
	)
}

// Reconcile the model from the `prev` path set to `next`. Folders are EXPLICIT
// rows here (the listing carries them, empty ones included), so this is just the
// set difference — no emptied-ancestor pruning, unlike a tree derived from file
// paths alone. `getItem` guards each op because a drop that WORKED is already in
// the model: the listing then reports a move the model made itself, and both
// halves of it must be skipped rather than thrown on (`add`/`remove` throw on a
// path that does (not) exist).
function applyPathDiff(
	model: ReturnType<typeof useFileTree>['model'],
	prev: string[],
	next: string[]
) {
	const prevSet = new Set(prev)
	const nextSet = new Set(next)
	const removed = prev.filter((path) => !nextSet.has(path))
	const added = next.filter((path) => !prevSet.has(path))
	const ops: FileTreeBatchOperation[] = []
	// A removed folder is taken out recursively, so every removed row UNDER one is
	// already gone with it. Asked of each row's own ancestors — a handful of slices,
	// however long the listing — rather than by rescanning `removed` per row: a
	// 20k-note folder is one import away, and that scan would be quadratic.
	const gone = new Set(removed)
	const underRemovedDir = (path: string) => {
		for (let cut = path.indexOf('/'); cut !== -1; cut = path.indexOf('/', cut + 1)) {
			const dir = path.slice(0, cut + 1)
			if (dir !== path && gone.has(dir)) return true
		}
		return false
	}
	for (const path of removed) {
		if (underRemovedDir(path) || !model.getItem(path)) continue
		ops.push({ type: 'remove', path, recursive: path.endsWith('/') })
	}
	for (const path of added) if (!model.getItem(path)) ops.push({ type: 'add', path })
	if (ops.length > 0) model.batch(ops)
}

// The menu is PORTALED out of the tree and pinned to the viewport at the
// trigger's rect. Rendered in place it would be both clipped by the tree host's
// `overflow: hidden` and painted under the editor (it is a static, z-index-less
// child of the pane). `data-file-tree-context-menu-root` tells the tree that
// clicks inside this portaled surface are not outside clicks.
function MenuLayer(
	props: NotesTreeProps & { item: ContextMenuItem; context: ContextMenuOpenContext }
) {
	const { anchorRect } = props.context
	// Flip up / pull left near an edge, sized off the menu's own max box — enough
	// for a 4-row menu, and cheaper than a measure-then-reposition pass.
	const place = {
		left: Math.max(4, Math.min(anchorRect.left, window.innerWidth - MENU_W - 4)),
		...(anchorRect.bottom + MENU_H > window.innerHeight
			? { bottom: Math.max(4, window.innerHeight - anchorRect.top + 2) }
			: { top: anchorRect.bottom + 2 })
	}
	return createPortal(
		<div className="notes-menu-layer" data-file-tree-context-menu-root="true" style={place}>
			<RowMenu {...props} />
		</div>,
		document.body
	)
}

const MENU_W = 180
const MENU_H = 160

// ————— OS file drags —————
// A dropped file is an IMPORT, handled by the app root (gui.tsx) so it works
// wherever it lands — pane, editor or bar. Here it only has to be told apart
// from an internal row drag (which carries `text/plain`, not `Files`) and left
// alone so it bubbles out.
const isFileDrag = (event: React.DragEvent) =>
	Array.from(event.dataTransfer.types).includes('Files')

// A new child of a folder, or a new sibling of a file.
function dirOf(item: ContextMenuItem): string {
	const path = fromTree(item.path)
	return item.kind === 'directory' ? path : parentDir(path)
}

type MenuMode = 'menu' | 'note' | 'folder' | 'rename' | 'delete'

// The row menu is a plain `ds-menu` (it is slotted into the tree's light DOM, so
// the app's stylesheet applies). Everything that needs input or confirmation
// happens IN the menu: the app runs in a sandboxed iframe with no
// `allow-modals`, so `prompt()`/`confirm()` are not available either.
function RowMenu(
	props: NotesTreeProps & { item: ContextMenuItem; context: ContextMenuOpenContext }
) {
	const [mode, setMode] = useState<MenuMode>('menu')
	const { item } = props
	const folder = item.kind === 'directory'
	const path = fromTree(item.path)
	const close = () => props.context.close({ restoreFocus: false })

	if (mode === 'delete') {
		return (
			<div className="ds-menu notes-menu">
				<div className="notes-menu-note">
					Delete {folder ? 'folder and contents' : 'note'} “{item.name}”?
				</div>
				<button
					type="button"
					className="ds-menu-item notes-menu-danger"
					onClick={() => {
						close()
						props.onRemove(path)
					}}
				>
					Delete
				</button>
				<button type="button" className="ds-menu-item" onClick={() => setMode('menu')}>
					Cancel
				</button>
			</div>
		)
	}

	if (mode !== 'menu') {
		const label = mode === 'note' ? 'New note' : mode === 'folder' ? 'New folder' : 'Rename to'
		return (
			<NameForm
				label={label}
				initial={mode === 'rename' ? item.name : ''}
				onCancel={() => setMode('menu')}
				onSubmit={(name) => {
					close()
					if (mode === 'note') props.onCreate(dirOf(item), name)
					else if (mode === 'folder') props.onMkdir(joinPath(dirOf(item), name))
					// Just the new name in the same folder — keeping a note's extension is the
					// `rename` procedure's job, so the agent and this menu cannot disagree.
					else void props.onRename(path, joinPath(parentDir(path), name))
				}}
			/>
		)
	}

	return (
		<div className="ds-menu notes-menu">
			<button type="button" className="ds-menu-item" onClick={() => setMode('note')}>
				New note{folder ? ' here' : ''}
			</button>
			<button type="button" className="ds-menu-item" onClick={() => setMode('folder')}>
				New folder{folder ? ' here' : ''}
			</button>
			<button type="button" className="ds-menu-item" onClick={() => setMode('rename')}>
				Rename…
			</button>
			<button
				type="button"
				className="ds-menu-item notes-menu-danger"
				onClick={() => setMode('delete')}
			>
				Delete…
			</button>
		</div>
	)
}

function NameForm(props: {
	label: string
	initial: string
	onCancel: () => void
	onSubmit: (name: string) => void
}) {
	const [name, setName] = useState(props.initial)
	const submit = () => {
		const trimmed = name.trim()
		if (trimmed) props.onSubmit(trimmed)
		else props.onCancel()
	}
	return (
		<div className="ds-menu notes-menu">
			<div className="notes-menu-note">{props.label}</div>
			<input
				// biome-ignore lint/a11y/noAutofocus: the menu opened for this field — typing must land in it without a second click.
				autoFocus
				className="notes-menu-input"
				value={name}
				placeholder="Name"
				onChange={(e) => setName(e.target.value)}
				onKeyDown={(e) => {
					e.stopPropagation()
					if (e.key === 'Enter') submit()
					else if (e.key === 'Escape') props.onCancel()
				}}
			/>
			<button type="button" className="ds-menu-item" onClick={submit}>
				OK
			</button>
		</div>
	)
}
