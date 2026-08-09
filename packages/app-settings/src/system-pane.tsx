import type { Client } from '@justfiles/app'
import { useEffect, useRef, useState } from 'react'
import type { SettingsApp } from './app.ts'

// The System pane: what this device is running. One line today, and deliberately a pane
// rather than a footnote in the sidebar — "which build am I on" is the first question a bug
// report has to answer, so it needs somewhere to live that a user can be sent to.
//
// NOTHING HERE IS REDUCER STATE (see `readVersion`): the build is a fact about THIS device
// and reducer state replicates, so the pane asks the host it runs on and keeps the answer.
// It asks once — a bundle cannot become another bundle while you are looking at it.

// What the pane knows, before or after asking. `unavailable` is a host that doesn't report
// its own build (the Mac app today), which is a statement and not a failure.
type Build = { version: string | null; unavailable: boolean }

export function SystemPane({ client }: { client: Client<SettingsApp> }) {
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
				if (message.includes('CAPABILITY_UNAVAILABLE'))
					setBuild({ version: null, unavailable: true })
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
