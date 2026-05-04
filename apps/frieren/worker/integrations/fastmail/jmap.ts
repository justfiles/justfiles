const SESSION_URL = 'https://api.fastmail.com/jmap/session'
const MAIL_CAPABILITY = 'urn:ietf:params:jmap:mail'
const SUBMISSION_CAPABILITY = 'urn:ietf:params:jmap:submission'
const CORE_CAPABILITY = 'urn:ietf:params:jmap:core'

export interface EmailAddress {
	name: string | null
	email: string
}

export interface EmailSummary {
	id: string
	subject: string | null
	from: EmailAddress[]
	receivedAt: string
	preview: string
}

export interface EmailDetails extends EmailSummary {
	to: EmailAddress[]
	text: string
}

export interface SendInput {
	to: string
	subject: string
	body: string
}

export interface JmapClient {
	list(options: { limit: number }): Promise<EmailSummary[]>
	read(id: string): Promise<EmailDetails>
	send(input: SendInput): Promise<{ id: string }>
}

interface Session {
	apiUrl: string
	accountId: string
	identityEmail: string
}

interface JmapInvocation {
	0: string
	1: Record<string, unknown>
	2: string
}

interface JmapResponse {
	methodResponses: JmapInvocation[]
}

export interface JmapClientOptions {
	token: string
	fetch?: typeof globalThis.fetch
}

export function createJmapClient(opts: JmapClientOptions): JmapClient {
	const fetchFn = opts.fetch ?? globalThis.fetch
	let sessionPromise: Promise<Session> | undefined

	const auth = `Bearer ${opts.token.trim()}`

	async function loadSession(): Promise<Session> {
		const res = await fetchFn(SESSION_URL, { headers: { Authorization: auth } })
		if (!res.ok) {
			const detail = await res.text().catch(() => '')
			const hint =
				res.status === 401
					? ' (use a Fastmail API token, not an app password — Settings → Privacy & Security → Connected apps & API tokens → API tokens)'
					: ''
			throw new Error(
				`fastmail session failed: ${res.status}${hint}${detail ? ` — ${detail.slice(0, 200)}` : ''}`
			)
		}
		const body = (await res.json()) as {
			apiUrl: string
			primaryAccounts: Record<string, string>
			accounts: Record<string, { name: string }>
		}
		const accountId = body.primaryAccounts[MAIL_CAPABILITY]
		if (!accountId) throw new Error('fastmail account has no mail capability')
		return {
			apiUrl: body.apiUrl,
			accountId,
			identityEmail: body.accounts[accountId]?.name ?? ''
		}
	}

	function session(): Promise<Session> {
		if (!sessionPromise) sessionPromise = loadSession()
		return sessionPromise
	}

	async function call(using: string[], methodCalls: JmapInvocation[]): Promise<JmapResponse> {
		const { apiUrl } = await session()
		const res = await fetchFn(apiUrl, {
			method: 'POST',
			headers: { Authorization: auth, 'Content-Type': 'application/json' },
			body: JSON.stringify({ using, methodCalls })
		})
		if (!res.ok) throw new Error(`fastmail api failed: ${res.status}`)
		return (await res.json()) as JmapResponse
	}

	function take<T>(response: JmapResponse, name: string, callId: string): T {
		const found = response.methodResponses.find((r) => r[0] === name && r[2] === callId)
		if (!found) throw new Error(`fastmail: missing ${name} response`)
		return found[1] as T
	}

	function takeError(
		response: JmapResponse,
		callId: string
	): { type: string; description?: string } | undefined {
		const found = response.methodResponses.find((r) => r[0] === 'error' && r[2] === callId)
		return found?.[1] as { type: string; description?: string } | undefined
	}

	async function findInbox(): Promise<string> {
		const { accountId } = await session()
		const res = await call(
			[CORE_CAPABILITY, MAIL_CAPABILITY],
			[['Mailbox/get', { accountId, ids: null }, '0'] as unknown as JmapInvocation]
		)
		const got = take<{ list: { id: string; role: string | null }[] }>(res, 'Mailbox/get', '0')
		const inbox = got.list.find((m) => m.role === 'inbox')
		if (!inbox) throw new Error('fastmail: inbox not found')
		return inbox.id
	}

	return {
		async list({ limit }) {
			const { accountId } = await session()
			const inboxId = await findInbox()
			const res = await call(
				[CORE_CAPABILITY, MAIL_CAPABILITY],
				[
					[
						'Email/query',
						{
							accountId,
							filter: { inMailbox: inboxId },
							sort: [{ property: 'receivedAt', isAscending: false }],
							limit,
							collapseThreads: true
						},
						'0'
					] as unknown as JmapInvocation,
					[
						'Email/get',
						{
							accountId,
							'#ids': { resultOf: '0', name: 'Email/query', path: '/ids' },
							properties: ['id', 'subject', 'from', 'receivedAt', 'preview']
						},
						'1'
					] as unknown as JmapInvocation
				]
			)
			const got = take<{ list: EmailSummary[] }>(res, 'Email/get', '1')
			return got.list
		},

		async read(id) {
			const { accountId } = await session()
			const res = await call(
				[CORE_CAPABILITY, MAIL_CAPABILITY],
				[
					[
						'Email/get',
						{
							accountId,
							ids: [id],
							properties: [
								'id',
								'subject',
								'from',
								'to',
								'receivedAt',
								'preview',
								'textBody',
								'bodyValues'
							],
							fetchTextBodyValues: true,
							maxBodyValueBytes: 65536
						},
						'0'
					] as unknown as JmapInvocation
				]
			)
			const got = take<{
				list: Array<
					EmailSummary & {
						to?: EmailAddress[]
						textBody?: { partId: string }[]
						bodyValues?: Record<string, { value: string }>
					}
				>
			}>(res, 'Email/get', '0')
			const email = got.list[0]
			if (!email) throw new Error(`fastmail: email ${id} not found`)
			const partId = email.textBody?.[0]?.partId
			const text = (partId && email.bodyValues?.[partId]?.value) ?? ''
			return {
				id: email.id,
				subject: email.subject,
				from: email.from,
				to: email.to ?? [],
				receivedAt: email.receivedAt,
				preview: email.preview,
				text
			}
		},

		async send({ to, subject, body }) {
			const s = await session()
			const setupRes = await call(
				[CORE_CAPABILITY, MAIL_CAPABILITY, SUBMISSION_CAPABILITY],
				[
					['Identity/get', { accountId: s.accountId }, '0'] as unknown as JmapInvocation,
					['Mailbox/get', { accountId: s.accountId, ids: null }, '1'] as unknown as JmapInvocation
				]
			)
			const identity = take<{ list: { id: string; email: string }[] }>(
				setupRes,
				'Identity/get',
				'0'
			)
			const mailboxes = take<{ list: { id: string; role: string | null }[] }>(
				setupRes,
				'Mailbox/get',
				'1'
			)
			const identityId = identity.list[0]?.id
			if (!identityId) throw new Error('fastmail: no identity available')
			const fromEmail = identity.list[0]?.email ?? s.identityEmail
			const drafts = mailboxes.list.find((m) => m.role === 'drafts')?.id
			const sent = mailboxes.list.find((m) => m.role === 'sent')?.id
			if (!drafts) throw new Error('fastmail: drafts mailbox not found')
			if (!sent) throw new Error('fastmail: sent mailbox not found')

			const sendRes = await call(
				[CORE_CAPABILITY, MAIL_CAPABILITY, SUBMISSION_CAPABILITY],
				[
					[
						'Email/set',
						{
							accountId: s.accountId,
							create: {
								draft: {
									mailboxIds: { [drafts]: true },
									keywords: { $draft: true },
									from: [{ email: fromEmail }],
									to: [{ email: to }],
									subject,
									bodyStructure: { type: 'text/plain', partId: '0' },
									bodyValues: { '0': { value: body } }
								}
							}
						},
						'0'
					] as unknown as JmapInvocation,
					[
						'EmailSubmission/set',
						{
							accountId: s.accountId,
							create: { sub: { emailId: '#draft', identityId } },
							onSuccessUpdateEmail: {
								'#sub': {
									[`mailboxIds/${drafts}`]: null,
									[`mailboxIds/${sent}`]: true,
									'keywords/$draft': null
								}
							}
						},
						'1'
					] as unknown as JmapInvocation
				]
			)
			const setError = takeError(sendRes, '0')
			if (setError) throw new Error(`fastmail: Email/set ${setError.type}`)
			const subError = takeError(sendRes, '1')
			if (subError) throw new Error(`fastmail: EmailSubmission/set ${subError.type}`)
			const created = take<{ created?: Record<string, { id: string }> }>(sendRes, 'Email/set', '0')
			const draftId = created.created?.draft?.id
			if (!draftId) throw new Error('fastmail: send failed (no draft id)')
			return { id: draftId }
		}
	}
}
