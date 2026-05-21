import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ToolCallInfo } from './types'

export function ToolCallBlock({ toolCall }: { toolCall: ToolCallInfo }) {
	const [expanded, setExpanded] = useState(false)

	const indicatorClass =
		toolCall.status === 'running'
			? 'text-amber-300'
			: toolCall.isError
				? 'text-red-300'
				: 'text-emerald-300'

	const indicatorLabel =
		toolCall.status === 'running' ? 'running' : toolCall.isError ? 'error' : 'done'

	return (
		<details
			className={cn(
				'group rounded border border-border/70 bg-muted/60 text-xs text-foreground shadow-sm',
				toolCall.isError && 'border-destructive/50 bg-destructive/10'
			)}
			open={expanded}
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 marker:hidden [&::-webkit-details-marker]:hidden">
				<Badge variant="outline" className={cn('h-5 px-1.5 font-mono uppercase', indicatorClass)}>
					{indicatorLabel}
				</Badge>
				<span className="min-w-0 flex-1 truncate font-mono">{toolCall.name}</span>
				<span className="text-muted-foreground transition group-open:rotate-90">&gt;</span>
			</summary>
			<div className="space-y-2 border-t border-border/70 px-3 py-2">
				<JsonBlock label="Arguments" value={toolCall.args} />
				{toolCall.result !== undefined ? (
					<JsonBlock label="Result" value={toolCall.result} copyable />
				) : null}
			</div>
		</details>
	)
}

function JsonBlock(props: { label: string; value: unknown; copyable?: boolean }) {
	const [copied, setCopied] = useState(false)
	const text = JSON.stringify(props.value, null, 2)

	function copy() {
		void navigator.clipboard
			.writeText(text)
			.then(() => {
				setCopied(true)
				window.setTimeout(() => setCopied(false), 1200)
			})
			.catch(() => {})
	}

	return (
		<div>
			<div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
				<span>{props.label}</span>
				{props.copyable ? (
					<Button variant="ghost" size="xs" type="button" onClick={copy} className="h-5 px-1.5">
						{copied ? 'Copied' : 'Copy'}
					</Button>
				) : null}
			</div>
			<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border/70 bg-background/70 p-2 font-mono text-[11px] leading-relaxed">
				{text}
			</pre>
		</div>
	)
}
