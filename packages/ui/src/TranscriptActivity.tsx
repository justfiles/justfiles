import type { ActivityDetailResult, TranscriptItem } from '@justfiles/agent/protocol'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'

export interface TranscriptActivityConfig {
	loadDetail?: (id: string) => Promise<ActivityDetailResult>
}

type ActivityItem = Extract<TranscriptItem, { type: 'activity' }>
type ActivityDetail = Extract<ActivityDetailResult, { status: 'available' }>['detail']
type Release = { current: (() => void) | null }
type Reveal = (head: HTMLElement, body: HTMLElement) => void

export function ActivityCrease({
	item,
	activity,
	onBeforeOpen,
	onOpened
}: {
	item: ActivityItem
	activity?: TranscriptActivityConfig
	onBeforeOpen: () => () => void
	onOpened: Reveal
}) {
	const hasDetail = item.items.some((part) => part.kind !== 'note')
	const hasBody = hasDetail || item.items.some((part) => part.kind === 'note' && Boolean(part.body))
	const [open, setOpen] = useState(() => hasBody && Boolean(item.failed))
	const [detail, setDetail] = useState<ActivityDetailResult | null>(null)
	const loadingRef = useRef(false)
	const headRef = useRef<HTMLButtonElement>(null)
	const sheetRef = useRef<HTMLDivElement>(null)
	const releaseRef = useRef<(() => void) | null>(null)
	const panelId = useId()

	useEffect(() => {
		if (!open || !hasDetail || loadingRef.current) return
		loadingRef.current = true
		const request =
			item.detailId && activity?.loadDetail
				? activity.loadDetail(item.detailId)
				: Promise.resolve({ status: 'expired' } as const)
		void request.then(
			(result) => setDetail(result),
			() => setDetail({ status: 'expired' })
		)
	}, [activity?.loadDetail, hasDetail, item.detailId, open])

	useReveal(open, detail ?? true, 360, headRef, sheetRef, releaseRef, onOpened)

	const toggle = () => {
		if (!open) releaseRef.current = onBeforeOpen()
		else finishReveal(releaseRef)
		setOpen((value) => !value)
	}

	return (
		<div className="js-transcript-crease" data-open={open} data-failed={Boolean(item.failed)}>
			{hasBody ? (
				<button
					ref={headRef}
					type="button"
					className="js-transcript-crease-head"
					aria-expanded={open}
					aria-controls={panelId}
					onClick={toggle}
				>
					<CreaseHeading label={item.label} />
				</button>
			) : (
				<div className="js-transcript-crease-head">
					<CreaseHeading label={item.label} />
				</div>
			)}
			{hasBody ? (
				<div className="js-transcript-crease-body">
					<div className="js-transcript-crease-clip">
						<div
							ref={sheetRef}
							id={panelId}
							className="js-transcript-crease-sheet"
							aria-hidden={open ? undefined : true}
							inert={!open}
						>
							<ActivityTrace
								item={item}
								detail={detail}
								onBeforeOpen={onBeforeOpen}
								onOpened={onOpened}
							/>
						</div>
					</div>
				</div>
			) : null}
		</div>
	)
}

function CreaseHeading({ label }: { label: string }) {
	return (
		<>
			<span className="js-transcript-crease-mark" aria-hidden="true">
				<ChevronRightIcon />
			</span>
			<span className="js-transcript-crease-label">{label}</span>
			<span className="js-transcript-crease-rule" />
			<span className="js-transcript-crease-chevron" aria-hidden="true">
				<ChevronDownIcon />
			</span>
		</>
	)
}

function ActivityTrace({
	item,
	detail,
	onBeforeOpen,
	onOpened
}: {
	item: ActivityItem
	detail: ActivityDetailResult | null
	onBeforeOpen: () => () => void
	onOpened: Reveal
}) {
	const hasDetail = item.items.some((part) => part.kind !== 'note')
	return (
		<div className="js-transcript-trace">
			{item.items.map((part, index) => (
				<ActivityTraceRow
					// biome-ignore lint/suspicious/noArrayIndexKey: Settled summaries are immutable and have no IDs.
					key={`${part.kind}:${index}`}
					item={part}
					detail={detail?.status === 'available' ? detail.detail.items[index] : undefined}
					onBeforeOpen={onBeforeOpen}
					onOpened={onOpened}
				/>
			))}
			{hasDetail && detail === null ? <TraceMessage>Loading details…</TraceMessage> : null}
			{hasDetail && detail?.status === 'expired' ? (
				<TraceMessage>Activity details have expired.</TraceMessage>
			) : null}
		</div>
	)
}

function ActivityTraceRow({
	item,
	detail,
	onBeforeOpen,
	onOpened
}: {
	item: ActivityItem['items'][number]
	detail?: ActivityDetail['items'][number]
	onBeforeOpen: () => () => void
	onOpened: Reveal
}) {
	const [open, setOpen] = useState(false)
	const headRef = useRef<HTMLButtonElement>(null)
	const bodyRef = useRef<HTMLDivElement>(null)
	const releaseRef = useRef<(() => void) | null>(null)
	const panelId = useId()
	const failed = item.kind === 'tool' && Boolean(item.failed)
	const label = item.kind === 'think' ? 'Thinking' : item.label
	const duration = item.kind === 'note' ? '' : formatDuration(item.durationMs)
	const hasBody = Boolean(
		(item.kind === 'note' && item.body) || detail?.kind === 'think' || detail?.kind === 'tool'
	)

	useReveal(open, hasBody, 240, headRef, bodyRef, releaseRef, onOpened)

	const heading = (
		<>
			<span className="js-transcript-trace-dot" data-failed={failed} />
			<span className="js-transcript-trace-kind">{item.kind}</span>
			<span className="js-transcript-trace-label">{label}</span>
			{duration ? <span className="js-transcript-trace-time">{duration}</span> : null}
		</>
	)

	return (
		<div className="js-transcript-trace-row" data-open={open}>
			{hasBody ? (
				<button
					ref={headRef}
					type="button"
					className="js-transcript-trace-head"
					aria-expanded={open}
					aria-controls={panelId}
					onClick={() => {
						if (!open) releaseRef.current = onBeforeOpen()
						else finishReveal(releaseRef)
						setOpen((value) => !value)
					}}
				>
					{heading}
				</button>
			) : (
				<div className="js-transcript-trace-head">{heading}</div>
			)}
			{hasBody ? (
				<div
					ref={bodyRef}
					id={panelId}
					className="js-transcript-trace-body"
					aria-hidden={open ? undefined : true}
					inert={!open}
				>
					<div>
						<ActivityBody item={item} detail={detail} />
					</div>
				</div>
			) : null}
		</div>
	)
}

function ActivityBody({
	item,
	detail
}: {
	item: ActivityItem['items'][number]
	detail?: ActivityDetail['items'][number]
}) {
	if (item.kind === 'note' && item.body)
		return <div className="js-transcript-trace-prose">{item.body}</div>
	if (detail?.kind === 'think')
		return <div className="js-transcript-trace-prose">{detail.content}</div>
	if (detail?.kind !== 'tool') return null
	return (
		<div className="js-transcript-trace-content">
			<pre>{formatDetail(detail.input)}</pre>
			<pre>{formatDetail(detail.result)}</pre>
		</div>
	)
}

function useReveal(
	open: boolean,
	content: unknown,
	delay: number,
	headRef: { current: HTMLElement | null },
	bodyRef: { current: HTMLElement | null },
	releaseRef: Release,
	onOpened: Reveal
) {
	useEffect(() => {
		if (!open || !content) return
		const timeout = setTimeout(
			() => {
				const head = headRef.current
				const body = bodyRef.current
				if (head && body) onOpened(head, body)
				finishReveal(releaseRef)
			},
			globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : delay
		)
		return () => clearTimeout(timeout)
	}, [bodyRef, content, delay, headRef, onOpened, open, releaseRef])
	useEffect(() => () => finishReveal(releaseRef), [releaseRef])
}

function finishReveal(releaseRef: Release) {
	releaseRef.current?.()
	releaseRef.current = null
}

function TraceMessage({ children }: { children: ReactNode }) {
	return <div className="js-transcript-trace-prose">{children}</div>
}

function formatDuration(durationMs: number): string {
	return durationMs >= 1_000 ? `${(durationMs / 1_000).toFixed(1)}s` : `${durationMs}ms`
}

function formatDetail(value: unknown): string {
	if (typeof value === 'string') return value
	return JSON.stringify(value, null, 2) ?? String(value)
}

function ChevronRightIcon() {
	return (
		<svg
			width="8"
			height="8"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="3.4"
			aria-hidden="true"
		>
			<path d="M9 6l6 6-6 6" />
		</svg>
	)
}

function ChevronDownIcon() {
	return (
		<svg
			width="9"
			height="9"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="3"
			aria-hidden="true"
		>
			<path d="M6 9l6 6 6-6" />
		</svg>
	)
}

export const transcriptActivityCss = `
.js-transcript-crease { display: flex; flex-direction: column; }
.js-transcript-crease-head {
	display: flex; align-items: center; gap: 7px;
	width: 100%; padding: 3px 0; margin: 0;
	background: none; border: 0; color: inherit;
	font-family: var(--font-mono); font-size: 11px; text-align: left;
	opacity: .34; cursor: pointer;
	transition: opacity 260ms ease;
}
.js-transcript-crease-head:hover,
.js-transcript-crease[data-open="true"] .js-transcript-crease-head { opacity: .8; }
.js-transcript-crease[data-failed="true"] .js-transcript-crease-head {
	opacity: .75; color: var(--danger);
}
.js-transcript-crease-mark {
	display: grid; flex: none; width: 11px; height: 11px; place-items: center;
	transition: transform 300ms cubic-bezier(.2, .9, .25, 1);
}
.js-transcript-crease[data-open="true"] .js-transcript-crease-mark { transform: rotate(90deg); }
.js-transcript-crease-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.js-transcript-crease-rule {
	flex: 1; height: 1px; min-width: 0; background: currentColor; opacity: .3;
	transform-origin: left;
	transition: opacity 240ms ease 60ms, transform 320ms cubic-bezier(.2, .9, .25, 1) 60ms;
}
.js-transcript-crease-chevron { display: flex; flex: none; opacity: .55; }
.js-transcript-crease-body {
	display: grid; grid-template-rows: 0fr;
	transition: grid-template-rows 320ms cubic-bezier(.2, .9, .25, 1);
}
.js-transcript-crease[data-open="true"] .js-transcript-crease-body { grid-template-rows: 1fr; }
.js-transcript-crease-clip { overflow: hidden; }
.js-transcript-crease-sheet {
	margin: 3px 0 2px; overflow: hidden;
	transform: perspective(760px) rotateX(-74deg); transform-origin: top center;
	opacity: 0; border: 1px solid var(--rule); border-radius: 5px; background: var(--window-bg, var(--surface));
	box-shadow: inset 0 9px 11px -9px color-mix(in srgb, currentColor 30%, transparent);
	transition: transform 340ms cubic-bezier(.2, .9, .25, 1), opacity 200ms ease;
}
.js-transcript-crease[data-open="true"] .js-transcript-crease-sheet {
	transform: perspective(760px) rotateX(0deg); opacity: 1;
}
.js-transcript-crease[data-failed="true"] .js-transcript-crease-sheet {
	border-color: color-mix(in srgb, var(--danger) 45%, var(--rule));
}
.js-transcript-trace {
	position: relative; display: flex; flex-direction: column; padding-left: 9px;
}
.js-transcript-trace::before {
	content: ""; position: absolute; left: 3px; top: 4px; bottom: 4px;
	width: 3px; border-radius: 2px;
	background: color-mix(in srgb, currentColor 14%, transparent);
}
.js-transcript-trace-row { border-bottom: 1px solid color-mix(in srgb, var(--rule) 55%, transparent); }
.js-transcript-trace-row:last-child { border-bottom: 0; }
.js-transcript-trace-head {
	display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 8px;
	box-sizing: border-box; border: 0; background: none; color: inherit;
	font-family: var(--font-mono); font-size: 11px; text-align: left;
}
button.js-transcript-trace-head { cursor: pointer; transition: background 120ms ease; }
button.js-transcript-trace-head:hover { background: color-mix(in srgb, currentColor 6%, transparent); }
.js-transcript-trace-dot { flex: none; width: 5px; height: 5px; border-radius: 999px; background: currentColor; opacity: .45; }
.js-transcript-trace-dot[data-failed="true"] { background: var(--danger); opacity: 1; }
.js-transcript-trace-kind { flex: none; min-width: 42px; font-weight: 500; }
.js-transcript-trace-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .55; }
.js-transcript-trace-time { flex: none; opacity: .4; font-variant-numeric: tabular-nums; }
.js-transcript-trace-body {
	display: grid; grid-template-rows: 0fr;
	transition: grid-template-rows 220ms ease;
}
.js-transcript-trace-row[data-open="true"] .js-transcript-trace-body { grid-template-rows: 1fr; }
.js-transcript-trace-body > div { overflow: hidden; }
.js-transcript-trace-content { display: flex; flex-direction: column; gap: 4px; }
.js-transcript-trace-content pre {
	margin: 0 8px 8px; padding: 6px 8px; max-height: 12rem; overflow: auto;
	border: 1px solid var(--rule); border-radius: 4px; background: var(--surface);
	font-family: var(--font-mono); font-size: 10.5px; line-height: 1.5;
	white-space: pre-wrap; overflow-wrap: anywhere;
}
.js-transcript-trace-prose {
	margin: 0 8px 8px; padding: 2px 0 2px 10px;
	border-left: 2px solid color-mix(in srgb, currentColor 18%, transparent);
	font-family: var(--font-ui); font-size: 12px; line-height: 1.65; opacity: .72;
	white-space: pre-wrap; overflow-wrap: anywhere;
}
@media (prefers-reduced-motion: reduce) {
	.js-transcript-crease-mark,
	.js-transcript-crease-rule { transition: opacity 200ms ease; }
	.js-transcript-crease-sheet,
	.js-transcript-crease[data-open="true"] .js-transcript-crease-sheet { transform: none; }
	.js-transcript-trace-body { transition: opacity 200ms ease; }
}
`
