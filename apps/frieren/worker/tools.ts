/**
 * Agent filesystem tools — thin wrappers around a @justfiles/fs Volume.
 *
 * Each tool follows the AgentTool interface from pi-agent-core:
 * name, label, description, parameters (TypeBox), execute.
 */
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { Volume } from '@justfiles/fs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createFsTools(vol: Volume): AgentTool<any>[] {
	const readFile: AgentTool<typeof readParams> = {
		name: 'read',
		label: 'Read File',
		description: 'Read the contents of a file from your memory filesystem. Returns the file content as text.',
		parameters: readParams,
		async execute(_toolCallId, params) {
			const data = await vol.readFile(params.path);
			const text = decoder.decode(data);
			return {
				content: [{ type: 'text', text }],
				details: { path: params.path, size: data.length },
			};
		},
	};

	const writeFile: AgentTool<typeof writeParams> = {
		name: 'write',
		label: 'Write File',
		description: 'Write text content to a file in your memory filesystem. Creates the file if it does not exist, overwrites if it does. Parent directories must exist (use mkdir first).',
		parameters: writeParams,
		async execute(_toolCallId, params) {
			const data = encoder.encode(params.content);
			await vol.writeFile(params.path, data);
			return {
				content: [{ type: 'text', text: `Wrote ${data.length} bytes to ${params.path}` }],
				details: { path: params.path, size: data.length },
			};
		},
	};

	const listDir: AgentTool<typeof lsParams> = {
		name: 'ls',
		label: 'List Directory',
		description: 'List the contents of a directory in your memory filesystem. Returns file names and types.',
		parameters: lsParams,
		async execute(_toolCallId, params) {
			const entries = await vol.readdir(params.path);
			const lines = entries.map(e => {
				const typeLabel = e.type === 1 ? 'dir' : 'file';
				return `${typeLabel}\t${e.name}`;
			});
			const text = lines.length > 0 ? lines.join('\n') : '(empty directory)';
			return {
				content: [{ type: 'text', text }],
				details: { path: params.path, count: entries.length },
			};
		},
	};

	const makeDir: AgentTool<typeof mkdirParams> = {
		name: 'mkdir',
		label: 'Create Directory',
		description: 'Create a directory in your memory filesystem. Use recursive: true to create parent directories as needed.',
		parameters: mkdirParams,
		async execute(_toolCallId, params) {
			await vol.mkdir(params.path, { recursive: params.recursive ?? true });
			return {
				content: [{ type: 'text', text: `Created directory ${params.path}` }],
				details: { path: params.path },
			};
		},
	};

	const removeFile: AgentTool<typeof rmParams> = {
		name: 'rm',
		label: 'Remove',
		description: 'Remove a file or directory from your memory filesystem. Use recursive: true to remove non-empty directories.',
		parameters: rmParams,
		async execute(_toolCallId, params) {
			await vol.rm(params.path, {
				recursive: params.recursive ?? false,
				force: params.force ?? false,
			});
			return {
				content: [{ type: 'text', text: `Removed ${params.path}` }],
				details: { path: params.path },
			};
		},
	};

	return [readFile, writeFile, listDir, makeDir, removeFile];
}

// ── TypeBox parameter schemas ─────────────────────────────────────────────

const readParams = Type.Object({
	path: Type.String({ description: 'Absolute path to the file (must start with /)' }),
});

const writeParams = Type.Object({
	path: Type.String({ description: 'Absolute path to the file (must start with /)' }),
	content: Type.String({ description: 'Text content to write' }),
});

const lsParams = Type.Object({
	path: Type.String({ description: 'Absolute path to the directory (must start with /)' }),
});

const mkdirParams = Type.Object({
	path: Type.String({ description: 'Absolute path for the new directory' }),
	recursive: Type.Optional(Type.Boolean({ description: 'Create parent directories if needed (default: true)' })),
});

const rmParams = Type.Object({
	path: Type.String({ description: 'Absolute path to remove' }),
	recursive: Type.Optional(Type.Boolean({ description: 'Remove directories and their contents recursively' })),
	force: Type.Optional(Type.Boolean({ description: 'Do not error if the path does not exist' })),
});
