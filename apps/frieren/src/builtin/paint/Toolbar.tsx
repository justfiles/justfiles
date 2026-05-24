import {
	CircleIcon,
	EraserIcon,
	LineSegmentIcon,
	PaintBucketIcon,
	PencilIcon,
	RectangleIcon
} from '@phosphor-icons/react'
import type { ComponentType } from 'react'

export type Tool = 'pencil' | 'eraser' | 'fill' | 'line' | 'rect' | 'ellipse'
export type Size = 1 | 3 | 5

const TOOLS: { id: Tool; label: string; Icon: ComponentType<{ size?: number }> }[] = [
	{ id: 'pencil', label: 'Pencil', Icon: PencilIcon },
	{ id: 'eraser', label: 'Eraser', Icon: EraserIcon },
	{ id: 'fill', label: 'Fill', Icon: PaintBucketIcon },
	{ id: 'line', label: 'Line', Icon: LineSegmentIcon },
	{ id: 'rect', label: 'Rectangle', Icon: RectangleIcon },
	{ id: 'ellipse', label: 'Ellipse', Icon: CircleIcon }
]

const SIZES: { value: Size; px: number }[] = [
	{ value: 1, px: 2 },
	{ value: 3, px: 5 },
	{ value: 5, px: 8 }
]

export function Toolbar(props: {
	tool: Tool
	size: Size
	onTool: (t: Tool) => void
	onSize: (s: Size) => void
}) {
	return (
		<aside
			className="flex flex-none flex-col items-center gap-2 py-2"
			style={{
				width: 56,
				background: 'var(--surface)',
				borderRight: '1px solid var(--rule)'
			}}
		>
			<div className="grid grid-cols-2 gap-1">
				{TOOLS.map(({ id, label, Icon }) => {
					const active = props.tool === id
					return (
						<button
							key={id}
							type="button"
							title={label}
							aria-label={label}
							aria-pressed={active}
							onClick={() => props.onTool(id)}
							style={{
								width: 24,
								height: 24,
								display: 'inline-flex',
								alignItems: 'center',
								justifyContent: 'center',
								background: active ? 'var(--focus)' : '#ffffff',
								color: active ? 'var(--on-focus)' : 'var(--text)',
								border: '1px solid var(--rule)',
								borderRadius: 3,
								cursor: 'default'
							}}
						>
							<Icon size={14} />
						</button>
					)
				})}
			</div>
			<div
				style={{ height: 1, width: '70%', background: 'var(--rule)', margin: '4px 0' }}
				aria-hidden
			/>
			<div className="flex flex-col items-center gap-1">
				{SIZES.map(({ value, px }) => {
					const active = props.size === value
					return (
						<button
							key={value}
							type="button"
							title={`Size ${value}`}
							aria-label={`Size ${value}`}
							aria-pressed={active}
							onClick={() => props.onSize(value)}
							style={{
								width: 28,
								height: 18,
								display: 'inline-flex',
								alignItems: 'center',
								justifyContent: 'center',
								background: active ? 'var(--focus)' : '#ffffff',
								border: '1px solid var(--rule)',
								borderRadius: 3,
								cursor: 'default'
							}}
						>
							<span
								style={{
									width: px,
									height: px,
									background: active ? 'var(--on-focus)' : 'var(--text)',
									borderRadius: '50%'
								}}
							/>
						</button>
					)
				})}
			</div>
		</aside>
	)
}
