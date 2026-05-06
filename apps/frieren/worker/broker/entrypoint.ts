// Cloudflare WorkerEntrypoint subclass that bridges RPC to the broker core.
//
// This is the ONLY file in `broker/` that imports from `cloudflare:workers`.
// Subclass and override `buildCapabilities` to inject provider adapters from
// the host's connection store. The default implementation throws so an
// unconfigured host fails loud rather than silently denying.

import { WorkerEntrypoint } from 'cloudflare:workers'
import type { AppCapabilityProps } from './cloudflare.ts'
import type {
	CalendarEventDTO,
	Capabilities,
	CapabilityResult,
	EmailDetailDTO,
	EmailDTO,
	ListTodayInput,
	ListUnreadInput,
	MarkReadInput,
	ReadDetailInput,
	ReadFileInput,
	SandboxContext,
	WriteFileInput
} from './contracts.ts'

export class AppCapabilitiesEntrypoint extends WorkerEntrypoint<Env> {
	protected buildCapabilities(_context: SandboxContext): Promise<Capabilities> | Capabilities {
		throw new Error('AppCapabilitiesEntrypoint.buildCapabilities is not implemented')
	}

	private get props(): AppCapabilityProps {
		const props = (this.ctx as unknown as { props?: AppCapabilityProps }).props
		if (!props?.context) throw new Error('AppCapabilitiesEntrypoint: missing props.context')
		return props
	}

	private async caps(): Promise<Capabilities> {
		return this.buildCapabilities(this.props.context)
	}

	emailListUnread(input: ListUnreadInput): Promise<CapabilityResult<EmailDTO[]>> {
		return this.caps().then((c) => c.email.listUnread(input))
	}
	emailReadDetail(input: ReadDetailInput): Promise<CapabilityResult<EmailDetailDTO>> {
		return this.caps().then((c) => c.email.readDetail(input))
	}
	emailMarkRead(input: MarkReadInput): Promise<CapabilityResult<{ success: true }>> {
		return this.caps().then((c) => c.email.markRead(input))
	}
	calendarListToday(input: ListTodayInput): Promise<CapabilityResult<CalendarEventDTO[]>> {
		return this.caps().then((c) => c.calendar.listToday(input))
	}
	volumeReadFile(input: ReadFileInput): Promise<CapabilityResult<{ data: Uint8Array }>> {
		return this.caps().then((c) => c.volume.readFile(input))
	}
	volumeWriteFile(input: WriteFileInput): Promise<CapabilityResult<{ success: true }>> {
		return this.caps().then((c) => c.volume.writeFile(input))
	}
}
