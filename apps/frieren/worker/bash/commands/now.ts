import { DEFAULT_TIMEZONE, formatInTimezone } from '../../timezone.ts'
import { defineCommand } from '../define.ts'

export interface NowCommandOptions {
	getTimezone?: () => Promise<string> | string
}

export function createNowCommand(options: NowCommandOptions = {}) {
	const { getTimezone } = options
	return defineCommand({
		name: 'now',
		summary: "Print the current time in ISO 8601 with the user's timezone offset",
		args: [
			{
				name: 'tz',
				description:
					"IANA timezone name; defaults to the user's timezone from /system/profiles/user.md"
			}
		],
		async run({ args }) {
			const tz = args.tz ?? (getTimezone ? await getTimezone() : DEFAULT_TIMEZONE)
			return { stdout: `${formatInTimezone(new Date(), tz)} (${tz})`, stderr: '', exitCode: 0 }
		}
	})
}
