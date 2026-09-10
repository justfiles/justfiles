import { useEffect, useRef, useState } from 'react'
import type { SettingsActions } from './model.ts'

type Build = { version: string | null; unavailable: boolean }

export function SystemPane({ client }: { client: SettingsActions }) {
	const [build, setBuild] = useState<Build>({ version: null, unavailable: false })
	const [error, setError] = useState<string | null>(null)
	const asked = useRef(false)

	useEffect(() => {
		if (asked.current) return
		asked.current = true
		client
			.readVersion({})
			.then((version) => setBuild({ version, unavailable: false }))
			.catch((e: unknown) => {
				const message = e instanceof Error ? e.message : String(e)
				if (message.includes('SETTINGS_UNAVAILABLE')) setBuild({ version: null, unavailable: true })
				else setError(message)
			})
	}, [client])

	return (
		<div className="settings-pane">
			<header className="settings-pane-header">
				<h1 className="settings-pane-title">System</h1>
				<p className="settings-pane-copy">What this device is running.</p>
			</header>
			<section className="settings-card">
				<div className="settings-connected-row">
					<h2 className="settings-card-title">Version</h2>
					<span className="settings-meter-used" style={{ fontFamily: 'var(--font-mono)' }}>
						{build.version ?? (build.unavailable ? 'Unknown' : '…')}
					</span>
				</div>
				<p className="settings-card-copy">
					{build.unavailable
						? 'This device doesn’t report which build it is running.'
						: 'The build serving this window. Quote it when you report a problem.'}
				</p>
				{error ? <p className="settings-card-error">{error}</p> : null}
			</section>
		</div>
	)
}
