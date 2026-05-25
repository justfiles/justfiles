import type { Client } from '@justfiles/app'
import { defineGUI } from '@justfiles/app/browser'
import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { type CrosswordApp, type CrosswordState, type Entry, initialState } from './app'
import { type Cell, cellKey, type Direction, type Slot } from './puzzle.ts'

const parseCell = (key: Cell): [number, number] => {
	const [r, c] = key.split(',').map(Number)
	return [r ?? 0, c ?? 0]
}

const stateOrInitial = (value: unknown): CrosswordState =>
	value && typeof value === 'object' && 'phase' in value ? (value as CrosswordState) : initialState

const cellNumbers = (grid: string[]): Record<Cell, number> => {
	const map: Record<Cell, number> = {}
	let n = 1
	for (let r = 0; r < grid.length; r++) {
		const row = grid[r] ?? ''
		for (let c = 0; c < row.length; c++) {
			if (row[c] === '#') continue
			const startsAcross =
				(c === 0 || row[c - 1] === '#') && c + 1 < row.length && row[c + 1] !== '#'
			const startsDown =
				(r === 0 || (grid[r - 1]?.[c] ?? '#') === '#') &&
				r + 1 < grid.length &&
				(grid[r + 1]?.[c] ?? '#') !== '#'
			if (startsAcross || startsDown) map[cellKey(r, c)] = n++
		}
	}
	return map
}

export const gui = defineGUI<CrosswordApp>({
	mount(el, state, ctx) {
		const root = createRoot(el)
		const render = (next: CrosswordState | null) =>
			root.render(
				<StrictMode>
					<Crossword state={stateOrInitial(next)} client={ctx.client} />
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

function Crossword({ state, client }: { state: CrosswordState; client: Client<CrosswordApp> }) {
	const [theme, setTheme] = useState(state.theme)
	const [error, setError] = useState<string | null>(null)
	const call = useCallback((promise: Promise<unknown>) => {
		setError(null)
		void promise.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
	}, [])

	if (state.phase === 'idle')
		return (
			<Shell>
				<section className="m-auto grid w-full max-w-md gap-3 p-6">
					<h1 className="text-xl font-semibold tracking-wide uppercase">Crossword</h1>
					<p className="text-sm opacity-70">
						Pick a theme. The agent fills the grid; you solve it.
					</p>
					<input
						value={theme}
						onChange={(e) => setTheme(e.target.value)}
						placeholder="e.g. space, harry potter, jazz"
						className="rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 outline-none focus:border-[var(--ring)]"
					/>
					<button
						type="button"
						onClick={() => call(client.start({ theme }))}
						disabled={!theme.trim()}
						className="rounded border border-[var(--border)] bg-[var(--primary)] px-3 py-2 text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-40"
					>
						Start
					</button>
					{error && <ErrorRow>{error}</ErrorRow>}
				</section>
			</Shell>
		)

	if (state.phase === 'awaiting-seeds' || !state.puzzle)
		return (
			<Shell>
				<section className="m-auto grid w-full max-w-2xl gap-3 p-6">
					<StandbyRow>
						Theme "{state.theme}". Waiting for the agent to submit seed words…
					</StandbyRow>
					{state.briefing && <Briefing>{state.briefing}</Briefing>}
					{error && <ErrorRow>{error}</ErrorRow>}
				</section>
			</Shell>
		)

	if (state.phase === 'awaiting-fill')
		return (
			<Shell>
				<section className="m-auto grid w-full max-w-2xl gap-3 p-6">
					<StandbyRow>
						Theme "{state.puzzle.theme}". Waiting for the agent to write clues for{' '}
						{state.puzzle.slots.length} slot(s)…
					</StandbyRow>
					{state.briefing && <Briefing>{state.briefing}</Briefing>}
					{error && <ErrorRow>{error}</ErrorRow>}
				</section>
			</Shell>
		)

	return (
		<Shell>
			<Game
				puzzle={state.puzzle}
				solved={state.phase === 'solved'}
				userGrid={state.userGrid}
				revealed={new Set(state.revealed)}
				wrong={new Set(state.wrong)}
				onEnter={(row, col, letter) => call(client.enter({ row, col, letter }))}
				onReveal={(cells) => call(client.reveal({ cells }))}
				onCheck={(cells) => call(client.check({ cells }))}
			/>
			{error && (
				<div className="p-4">
					<ErrorRow>{error}</ErrorRow>
				</div>
			)}
		</Shell>
	)
}

function Shell({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex h-full w-full flex-col overflow-auto bg-[var(--background)] font-mono text-[var(--foreground)]">
			{children}
		</div>
	)
}

function StandbyRow({ children }: { children: React.ReactNode }) {
	return (
		<p className="rounded border-2 border-dashed border-[var(--border)] px-6 py-4 text-sm tracking-wide opacity-70">
			{children}
		</p>
	)
}

function ErrorRow({ children }: { children: React.ReactNode }) {
	return (
		<p className="rounded border-2 border-dashed border-[var(--destructive)] px-6 py-4 text-sm tracking-wide text-[var(--destructive)]">
			{children}
		</p>
	)
}

function Briefing({ children }: { children: React.ReactNode }) {
	return (
		<pre className="overflow-auto rounded border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-xs whitespace-pre-wrap">
			{children}
		</pre>
	)
}

type GameProps = {
	puzzle: NonNullable<CrosswordState['puzzle']>
	solved: boolean
	userGrid: Record<Cell, string>
	revealed: Set<Cell>
	wrong: Set<Cell>
	onEnter: (r: number, c: number, letter: string) => void
	onReveal: (cells: Cell[]) => void
	onCheck: (cells: Cell[]) => void
}

function Game({
	puzzle,
	solved,
	userGrid,
	revealed,
	wrong,
	onEnter,
	onReveal,
	onCheck
}: GameProps) {
	const { grid, slots } = puzzle

	const firstPlay = useMemo<Cell | null>(() => {
		for (let r = 0; r < grid.length; r++) {
			const row = grid[r] ?? ''
			for (let c = 0; c < row.length; c++) if (row[c] !== '#') return cellKey(r, c)
		}
		return null
	}, [grid])

	const [selected, setSelected] = useState<Cell | null>(firstPlay)
	const [direction, setDirection] = useState<Direction>('across')
	useEffect(() => setSelected(firstPlay), [firstPlay])

	const cellNum = useMemo(() => cellNumbers(grid), [grid])

	const slotByCell = useMemo(() => {
		const across = new Map<Cell, string>()
		const down = new Map<Cell, string>()
		for (const s of slots) {
			for (let i = 0; i < s.length; i++) {
				const r = s.direction === 'down' ? s.row + i : s.row
				const c = s.direction === 'across' ? s.col + i : s.col
				;(s.direction === 'across' ? across : down).set(cellKey(r, c), s.id)
			}
		}
		return { across, down }
	}, [slots])

	const slotCells = useCallback((slot: Slot): Cell[] => {
		const out: Cell[] = []
		for (let i = 0; i < slot.length; i++) {
			const r = slot.direction === 'down' ? slot.row + i : slot.row
			const c = slot.direction === 'across' ? slot.col + i : slot.col
			out.push(cellKey(r, c))
		}
		return out
	}, [])

	const allPlayCells = useMemo(() => {
		const out: Cell[] = []
		for (let r = 0; r < grid.length; r++) {
			const row = grid[r] ?? ''
			for (let c = 0; c < row.length; c++) if (row[c] !== '#') out.push(cellKey(r, c))
		}
		return out
	}, [grid])

	const activeSlotId = selected
		? direction === 'across'
			? slotByCell.across.get(selected)
			: slotByCell.down.get(selected)
		: undefined
	const activeSlot = slots.find((s) => s.id === activeSlotId)
	const activeSlotCells = useMemo(
		() => new Set(activeSlot ? slotCells(activeSlot) : []),
		[activeSlot, slotCells]
	)

	const directionsFor = useCallback(
		(key: Cell): Direction[] => {
			const dirs: Direction[] = []
			if (slotByCell.across.has(key)) dirs.push('across')
			if (slotByCell.down.has(key)) dirs.push('down')
			return dirs
		},
		[slotByCell]
	)

	const advance = useCallback(() => {
		if (!activeSlot || !selected) return
		const [r, c] = parseCell(selected)
		const i = activeSlot.direction === 'across' ? c - activeSlot.col : r - activeSlot.row
		if (i + 1 >= activeSlot.length) return
		setSelected(
			cellKey(
				activeSlot.direction === 'down' ? r + 1 : r,
				activeSlot.direction === 'across' ? c + 1 : c
			)
		)
	}, [activeSlot, selected])

	const retreat = useCallback(() => {
		if (!activeSlot || !selected) return
		const [r, c] = parseCell(selected)
		const i = activeSlot.direction === 'across' ? c - activeSlot.col : r - activeSlot.row
		if (i === 0) return
		setSelected(
			cellKey(
				activeSlot.direction === 'down' ? r - 1 : r,
				activeSlot.direction === 'across' ? c - 1 : c
			)
		)
	}, [activeSlot, selected])

	const moveSelection = useCallback(
		(dr: number, dc: number, nextDir: Direction) => {
			if (!selected) return
			const [r, c] = parseCell(selected)
			let nr = r + dr
			let nc = c + dc
			while (nr >= 0 && nr < grid.length && nc >= 0 && nc < (grid[nr]?.length ?? 0)) {
				if (grid[nr]?.[nc] !== '#') {
					setSelected(cellKey(nr, nc))
					setDirection((d) => (directionsFor(cellKey(nr, nc)).includes(nextDir) ? nextDir : d))
					return
				}
				nr += dr
				nc += dc
			}
		},
		[selected, grid, directionsFor]
	)

	useEffect(() => {
		if (solved) return
		const handler = (e: KeyboardEvent) => {
			if (!selected) return
			const arrow: [number, number, Direction] | null =
				e.key === 'ArrowLeft'
					? [0, -1, 'across']
					: e.key === 'ArrowRight'
						? [0, 1, 'across']
						: e.key === 'ArrowUp'
							? [-1, 0, 'down']
							: e.key === 'ArrowDown'
								? [1, 0, 'down']
								: null
			if (arrow) {
				e.preventDefault()
				moveSelection(...arrow)
				return
			}
			if (e.key === 'Tab' || e.key === ' ') {
				e.preventDefault()
				const dirs = directionsFor(selected)
				if (dirs.length > 1) setDirection((d) => (d === 'across' ? 'down' : 'across'))
				return
			}
			const [r, c] = parseCell(selected)
			if (e.key === 'Backspace') {
				e.preventDefault()
				if (revealed.has(selected)) return retreat()
				if (userGrid[selected]) onEnter(r, c, '')
				else retreat()
				return
			}
			if (/^[a-zA-Z]$/.test(e.key)) {
				e.preventDefault()
				if (!revealed.has(selected)) onEnter(r, c, e.key.toUpperCase())
				advance()
			}
		}
		window.addEventListener('keydown', handler)
		return () => window.removeEventListener('keydown', handler)
	}, [
		selected,
		solved,
		moveSelection,
		directionsFor,
		revealed,
		userGrid,
		retreat,
		advance,
		onEnter
	])

	const onCellClick = (r: number, c: number) => {
		if (grid[r]?.[c] === '#') return
		const key = cellKey(r, c)
		if (selected === key) {
			const dirs = directionsFor(key)
			if (dirs.length > 1) setDirection((d) => (d === 'across' ? 'down' : 'across'))
			return
		}
		setSelected(key)
		const dirs = directionsFor(key)
		if (!dirs.includes(direction) && dirs[0]) setDirection(dirs[0])
	}

	const width = grid[0]?.length ?? 0

	return (
		<main className="grid min-h-0 flex-1 grid-cols-1 items-start gap-6 p-6 md:grid-cols-[minmax(280px,600px)_minmax(240px,1fr)]">
			<section className="grid gap-3">
				<header className="flex flex-wrap items-baseline justify-between gap-4">
					<h1 className="text-base font-semibold tracking-wide uppercase">{puzzle.theme}</h1>
				</header>
				<div
					className="grid aspect-square w-full gap-[2px] border-2 border-[var(--border)] bg-[var(--border)] p-[2px]"
					style={{ gridTemplateColumns: `repeat(${width}, 1fr)` }}
				>
					{grid.flatMap((row, r) =>
						row.split('').map((ch, c) => {
							const key = cellKey(r, c)
							const isBlock = ch === '#'
							const isSelected = selected === key
							const inSlot = !isSelected && activeSlotCells.has(key)
							const isWrong = wrong.has(key)
							const isRevealed = revealed.has(key)
							const cls = [
								'relative box-border appearance-none border-0 p-0',
								isBlock
									? 'cursor-default bg-[var(--foreground)]'
									: 'cursor-pointer bg-[var(--card)]',
								inSlot && 'bg-[color-mix(in_oklch,var(--accent)_70%,var(--card))]',
								isSelected &&
									'bg-[var(--accent)] outline outline-2 -outline-offset-2 outline-[var(--ring)] z-10'
							]
								.filter(Boolean)
								.join(' ')
							const letter = userGrid[key]
							const letterColor = isWrong
								? 'text-[var(--destructive)] line-through'
								: isRevealed
									? 'text-[var(--ring)]'
									: 'text-[var(--card-foreground)]'
							const inner = (
								<>
									{!isBlock && cellNum[key] !== undefined && (
										<span className="absolute top-px left-0.5 text-[9px] leading-none opacity-70">
											{cellNum[key]}
										</span>
									)}
									{!isBlock && letter && (
										<span
											className={`absolute inset-0 grid place-items-center text-[clamp(14px,3.2vmin,28px)] font-bold ${letterColor}`}
										>
											{letter}
										</span>
									)}
								</>
							)
							return isBlock ? (
								<div key={key} className={cls}>
									{inner}
								</div>
							) : (
								<button type="button" key={key} className={cls} onClick={() => onCellClick(r, c)}>
									{inner}
								</button>
							)
						})
					)}
				</div>
				{solved ? (
					<div className="rounded border-2 border-[var(--ring)] bg-[var(--accent)] px-5 py-4">
						<h2 className="m-0 text-base font-semibold">Solved.</h2>
					</div>
				) : (
					<div className="flex flex-wrap gap-2">
						<ToolButton disabled={!selected} onClick={() => selected && onReveal([selected])}>
							Reveal letter
						</ToolButton>
						<ToolButton
							disabled={!activeSlot}
							onClick={() => activeSlot && onReveal(slotCells(activeSlot))}
						>
							Reveal word
						</ToolButton>
						<ToolButton disabled={!selected} onClick={() => selected && onCheck([selected])}>
							Check letter
						</ToolButton>
						<ToolButton onClick={() => onCheck(allPlayCells)}>Check puzzle</ToolButton>
					</div>
				)}
			</section>
			<aside className="grid min-w-0 gap-5 overflow-auto md:max-h-[calc(100vh-3rem)]">
				{(['across', 'down'] as const).map((dir) => (
					<ClueList
						key={dir}
						title={dir === 'across' ? 'Across' : 'Down'}
						slots={slots.filter((s) => s.direction === dir)}
						entries={puzzle.entries}
						activeSlotId={direction === dir ? activeSlotId : undefined}
						cellNum={cellNum}
						onSelect={(s) => {
							setSelected(cellKey(s.row, s.col))
							setDirection(dir)
						}}
					/>
				))}
			</aside>
		</main>
	)
}

function ToolButton(props: { disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			disabled={props.disabled}
			onClick={props.onClick}
			className="rounded border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs text-[var(--card-foreground)] hover:bg-[var(--accent)] disabled:opacity-40"
		>
			{props.children}
		</button>
	)
}

function ClueList({
	title,
	slots,
	entries,
	activeSlotId,
	onSelect,
	cellNum
}: {
	title: string
	slots: Slot[]
	entries: Record<string, Entry>
	activeSlotId?: string
	onSelect: (s: Slot) => void
	cellNum: Record<Cell, number>
}) {
	return (
		<div>
			<h2 className="mb-2 text-xs font-bold tracking-wide uppercase opacity-80">{title}</h2>
			<ol className="m-0 grid list-none gap-2 p-0">
				{slots.map((s) => {
					const num = cellNum[cellKey(s.row, s.col)]
					const clue = entries[s.id]?.clue ?? ''
					const active = s.id === activeSlotId
					return (
						<li key={s.id}>
							<button
								type="button"
								className={`grid w-full cursor-pointer grid-cols-[2rem_1fr] items-start gap-2 rounded border-0 bg-transparent px-1.5 py-1 text-left text-sm leading-snug ${
									active ? 'bg-[var(--accent)]' : 'hover:bg-[var(--muted)]'
								}`}
								onClick={() => onSelect(s)}
							>
								<span className="text-right font-bold opacity-80">{num ?? s.id}</span>
								<span>{clue}</span>
							</button>
						</li>
					)
				})}
			</ol>
		</div>
	)
}
