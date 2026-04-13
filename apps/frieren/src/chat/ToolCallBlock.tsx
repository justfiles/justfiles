import { useState } from 'react'
import type { ToolCallInfo } from './types'

export function ToolCallBlock({ toolCall }: { toolCall: ToolCallInfo }) {
	const [expanded, setExpanded] = useState(false)

	const indicatorClass =
		toolCall.status === 'running'
			? 'text-warning'
			: toolCall.isError
				? 'text-error'
				: 'text-success'

	const indicatorLabel =
		toolCall.status === 'running' ? '...' : toolCall.isError ? 'x' : 'ok'

	return (
		<div
			className={`collapse collapse-arrow rounded-lg border border-base-300 bg-base-200/50 ${
				toolCall.isError ? 'border-error/30' : ''
			}`}
		>
			<input
				type="checkbox"
				checked={expanded}
				onChange={() => setExpanded(!expanded)}
			/>
			<div className="collapse-title min-h-0 py-2 px-3 text-sm after:!top-4">
				<div className="flex items-center gap-2">
					<span className={`badge badge-xs font-mono text-xs ${indicatorClass}`}>
						{indicatorLabel}
					</span>
					<span className="flex-1 font-mono">{toolCall.name}</span>
				</div>
			</div>
			<div className="collapse-content px-3 pb-3 text-sm">
				<div className="mb-2">
					<div className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-50">
						Arguments
					</div>
					<pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-base-300 p-2 text-xs">
						{JSON.stringify(toolCall.args, null, 2)}
					</pre>
				</div>
				{toolCall.result !== undefined ? (
					<div>
						<div className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-50">
							Result
						</div>
						<pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-base-300 p-2 text-xs">
							{JSON.stringify(toolCall.result, null, 2)}
						</pre>
					</div>
				) : null}
			</div>
		</div>
	)
}
