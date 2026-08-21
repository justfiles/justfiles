import { raw } from 'hono/html'
import type { ReleaseManifest } from '../protocol'
import type { AppAccess, Resource } from './capability'

const STYLE = `
:root { color-scheme: light dark; font: 16px/1.5 ui-sans-serif, system-ui, sans-serif }
body { margin: 10vh auto; max-width: 560px; padding: 24px }
h1 { line-height: 1.15 }
li { margin: 10px 0 }
.actions { align-items: center; display: flex; gap: 18px; margin-top: 28px }
button { background: #b06a2c; border: 0; border-radius: 8px; color: white; cursor: pointer;
	font: inherit; padding: 10px 16px }
a { color: inherit }
`

export function consentPage(
	app: ReleaseManifest,
	access: AppAccess,
	csrf: string,
	consent: string,
	cancel: string
) {
	const declared = [
		...new Set(Object.values(app.capabilities ?? {}).map((capability) => capability.id))
	].sort()
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>Connect {app.name} to Frieren</title>
				<style>{raw(STYLE)}</style>
			</head>
			<body>
				<main>
					<h1>Connect {app.name} to Frieren?</h1>
					<p>Runner will give this app only the Frieren access listed below.</p>
					<ul>
						{access.resources.map((resource) => (
							<li>{resourceText(resource, app.name)}</li>
						))}
						{access.resources.length === 0 && <li>No Frieren resource access.</li>}
					</ul>
					<p>Declared capabilities: {declared.join(', ') || 'none'}.</p>
					<p>Connected access needs a network connection. Runner will not merge local app data.</p>
					<form method="post" action="/consent">
						<input type="hidden" name="app" value={app.id} />
						<input type="hidden" name="capabilityHash" value={access.hash} />
						<input type="hidden" name="csrf" value={csrf} />
						<input type="hidden" name="consent" value={consent} />
						<div class="actions">
							<button type="submit">Connect app</button>
							<a href={cancel}>Cancel</a>
						</div>
					</form>
				</main>
			</body>
		</html>
	)
}

const resourceText = (resource: Resource, name: string): string => {
	if (resource === 'ai') return 'Use your Frieren AI budget.'
	if (resource === 'volume:system')
		return 'Read and change your full non-private Frieren volume while online.'
	return `Read and change the part of your non-private Frieren volume assigned to ${name} while online.`
}
