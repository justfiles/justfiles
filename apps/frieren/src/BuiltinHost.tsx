import { HouseIcon } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { findBuiltin } from './builtin'

export function BuiltinHost(props: { id: string; onHome: () => void }) {
	const builtin = findBuiltin(props.id)
	const Component = builtin?.component

	return (
		<div className="relative h-full w-full overflow-hidden bg-slate-950 text-sky-50">
			{Component ? (
				<Component />
			) : (
				<div className="flex h-full w-full items-center justify-center text-sm">
					Unknown built-in app: {props.id}
				</div>
			)}
			<div className="absolute right-2 top-2 z-10 flex border border-sky-300 bg-slate-950/90 shadow-[3px_3px_0_rgba(0,0,0,0.45)]">
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="text-sky-100 hover:bg-slate-900"
					aria-label="Return home"
					title="Return home"
					onClick={props.onHome}
				>
					<HouseIcon />
				</Button>
			</div>
		</div>
	)
}
