import { SignInButton, SignUpButton } from '@clerk/clerk-react'

const features = [
	{
		icon: '⌘',
		title: 'CLI-first editing',
		desc: 'Write, inspect, and organize notes from your terminal with the same filesystem model used by the web app.'
	},
	{
		icon: '⚡',
		title: 'Local-first sync',
		desc: 'Your notes stay available across devices with a file-system model that keeps local edits and remote state in sync.'
	},
	{
		icon: '🗂️',
		title: 'Structured files',
		desc: 'Paths, tags, links, and hidden asset storage keep your notes organized without a separate database model.'
	},
	{
		icon: '🔄',
		title: 'One storage model',
		desc: 'The worker, web UI, and CLI all operate on the same filesystem-backed notes and metadata.'
	},
	{
		icon: '📱',
		title: 'Human-first interface',
		desc: 'A rich offline-capable web app for when you want to think, browse, and connect ideas the way humans do.'
	}
]

export function AuthWall() {
	return (
		<div className="min-h-dvh bg-base-100 flex flex-col">
			{/* Nav */}
			<header className="flex items-center justify-between px-6 py-4 border-b border-base-200">
				<span className="text-xl font-bold tracking-tight">justfiles</span>
				<div className="flex gap-2">
					<SignInButton>
						<button type="button" className="btn btn-sm btn-ghost">
							Sign in
						</button>
					</SignInButton>
					<SignUpButton>
						<button type="button" className="btn btn-sm btn-primary">
							Get started
						</button>
					</SignUpButton>
				</div>
			</header>

			{/* Hero */}
			<section className="flex-1 flex flex-col items-center justify-center text-center px-6 py-24 gap-8">
				<div className="badge badge-outline badge-sm tracking-widest uppercase opacity-60">
					For humans &amp; agents
				</div>

				<h1 className="text-4xl sm:text-6xl font-bold leading-tight max-w-3xl">
					Your knowledge base, <span className="text-primary">built for the agent era</span>
				</h1>

				<p className="text-base-content/60 text-lg sm:text-xl max-w-xl leading-relaxed">
					Work with notes through a web app and a CLI built around one durable file-system-backed
					store.
				</p>

				<div className="flex flex-wrap gap-3 justify-center">
					<SignUpButton>
						<button type="button" className="btn btn-primary btn-lg px-8">
							Start for free
						</button>
					</SignUpButton>
					<SignInButton>
						<button type="button" className="btn btn-outline btn-lg px-8">
							Sign in
						</button>
					</SignInButton>
				</div>

				{/* Code snippet teaser */}
				<div className="mockup-code w-full max-w-lg text-left text-sm mt-4 opacity-80">
					<pre data-prefix="$">
						<code>files write "token clock skew fix"</code>
					</pre>
					<pre data-prefix="$">
						<code>files ls notes/</code>
					</pre>
					<pre data-prefix=" " className="text-success">
						<code>→ token-clock-skew-fix.md</code>
					</pre>
				</div>
			</section>

			{/* Features */}
			<section className="bg-base-200/50 px-6 py-20">
				<div className="max-w-5xl mx-auto">
					<h2 className="text-center text-2xl sm:text-3xl font-bold mb-12 opacity-90">
						Everything you need. Nothing you don't.
					</h2>
					<div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
						{features.map((f) => (
							<div
								key={f.title}
								className="card bg-base-100 border border-base-200 shadow-sm hover:shadow-md transition-shadow"
							>
								<div className="card-body gap-3">
									<span className="text-2xl">{f.icon}</span>
									<h3 className="card-title text-base">{f.title}</h3>
									<p className="text-base-content/60 text-sm leading-relaxed">{f.desc}</p>
								</div>
							</div>
						))}
					</div>
				</div>
			</section>

			{/* CTA bottom */}
			<section className="px-6 py-20 text-center flex flex-col items-center gap-6">
				<div className="badge badge-warning badge-sm tracking-widest uppercase">Beta</div>
				<h2 className="text-2xl sm:text-4xl font-bold max-w-xl">
					Ready to build your second brain?
				</h2>
				<p className="text-base-content/60 max-w-sm">
					Justfiles is in beta - everything is free while we're getting started. No paid plans, no
					credit card required.
				</p>
				<SignUpButton>
					<button type="button" className="btn btn-primary btn-lg px-10">
						Get started free
					</button>
				</SignUpButton>
			</section>

			{/* Footer */}
			<footer className="border-t border-base-200 px-6 py-6 text-center text-xs text-base-content/40">
				justfiles - notes for humans and agents
			</footer>
		</div>
	)
}
