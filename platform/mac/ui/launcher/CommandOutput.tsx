// A slash command's one-off text output (e.g. `/debug`), shown in place of the
// transcript. It is deliberately NOT a chat bubble: command output is not conversation,
// so it gets its own plain monospace panel and is never persisted. Inline styles keep it
// self-contained across both launcher surfaces (native chat.tsx + in-page main.tsx).
export function CommandOutput({ body }: { body: string }) {
	return (
		<pre
			style={{
				margin: 0,
				padding: '12px 16px',
				height: '100%',
				width: '100%',
				boxSizing: 'border-box',
				overflow: 'auto',
				whiteSpace: 'pre-wrap',
				wordBreak: 'break-word',
				fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
				fontSize: '12px',
				lineHeight: 1.5,
				color: 'var(--text, #ebebf0)'
			}}
		>
			{body}
		</pre>
	)
}
