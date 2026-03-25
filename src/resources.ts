/**
 * Babysitter resource loader: wraps pi's DefaultResourceLoader with
 * Babysitter-specific extension/skill discovery and a Slack system prompt.
 *
 * - Extensions: data/extensions/ (workspace-level only)
 * - Skills: data/skills/ (workspace) + data/<channel>/skills/ (channel, overrides workspace)
 * - System prompt: Slack-specific prompt built from mutable per-run context
 */

import {
	DefaultResourceLoader,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import * as log from "./log.js";
import type { SandboxConfig } from "./sandbox.js";
import type { ChannelInfo, UserInfo } from "./slack.js";

/** Mutable per-run context that changes with each Slack message */
export interface DynamicContext {
	memory: string;
	channels: ChannelInfo[];
	users: UserInfo[];
}

export interface BabysitterResourceLoaderOptions {
	/** Host-side channel directory (e.g. data/D0ANE5J8BL3) */
	channelDir: string;
	/** Sandbox workspace path the agent sees (e.g. /workspace) */
	workspacePath: string;
	/** Channel ID */
	channelId: string;
	/** Sandbox configuration */
	sandboxConfig: SandboxConfig;
}

/**
 * Create a DefaultResourceLoader configured for Babysitter.
 *
 * Uses pi's real extension/skill loading with Babysitter-controlled paths only
 * (no ~/.pi/agent or cwd/.pi discovery).
 */
export function createBabysitterResourceLoader(
	options: BabysitterResourceLoaderOptions,
	dynamicCtx: DynamicContext,
): DefaultResourceLoader {
	const { channelDir, workspacePath, channelId, sandboxConfig } = options;
	const hostWorkspaceDir = join(channelDir, "..");

	// Built-in paths (shipped with babysitter, in git)
	const builtinDir = join(import.meta.dirname, "..", "pi");
	const builtinExtensionsDir = join(builtinDir, "extensions");
	const builtinSkillsDir = join(builtinDir, "skills");

	// User paths (host-side workspace, in data/)
	const extensionDir = join(hostWorkspaceDir, "extensions");
	const workspaceSkillsDir = join(hostWorkspaceDir, "skills");
	const channelSkillsDir = join(channelDir, "skills");
	const extensionPaths = [
		...discoverExtensionPaths(builtinExtensionsDir),
		...discoverExtensionPaths(extensionDir),
	];

	const loader = new DefaultResourceLoader({
		// Use non-existent paths so pi's default discovery finds nothing
		cwd: "/nonexistent-babysitter-cwd",
		agentDir: "/nonexistent-babysitter-agentdir",

		// Disable default discovery, only use our additional paths
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,

		// Built-in (git) + user (data/) paths
		// DefaultResourceLoader expects concrete extension files/package dirs here,
		// not a parent "extensions/" directory to scan.
		additionalExtensionPaths: extensionPaths,
		additionalSkillPaths: [builtinSkillsDir, workspaceSkillsDir, channelSkillsDir],

		// Translate skill paths from host to sandbox workspace paths
		skillsOverride: (base) => {
			const translated: Skill[] = base.skills.map((skill) => ({
				...skill,
				filePath: translateHostToWorkspace(skill.filePath, hostWorkspaceDir, workspacePath),
				baseDir: translateHostToWorkspace(skill.baseDir, hostWorkspaceDir, workspacePath),
			}));
			return { skills: translated, diagnostics: base.diagnostics };
		},

		// Return the Slack-specific system prompt (without skills — pi appends them)
		systemPromptOverride: () =>
			buildSlackSystemPrompt(workspacePath, channelId, dynamicCtx, sandboxConfig),
	});

	return loader;
}

/** Discover concrete extension entries inside an extensions/ directory. */
function discoverExtensionPaths(extensionsDir: string): string[] {
	if (!existsSync(extensionsDir)) {
		return [];
	}

	const paths: string[] = [];
	for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
		const fullPath = join(extensionsDir, entry.name);
		if (entry.isDirectory()) {
			paths.push(fullPath);
		} else if (entry.isFile() && /\.(ts|js|mjs|cjs)$/.test(entry.name)) {
			paths.push(fullPath);
		}
	}

	return paths;
}

/** Translate a host-side path to the sandbox workspace path the agent sees */
function translateHostToWorkspace(hostPath: string, hostWorkspaceDir: string, workspacePath: string): string {
	if (hostPath.startsWith(hostWorkspaceDir)) {
		return workspacePath + hostPath.slice(hostWorkspaceDir.length);
	}
	return hostPath;
}

/** Read workspace and channel MEMORY.md files */
export function getMemory(channelDir: string): string {
	const parts: string[] = [];

	const workspaceMemoryPath = join(channelDir, "..", "MEMORY.md");
	if (existsSync(workspaceMemoryPath)) {
		try {
			const content = readFileSync(workspaceMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Global Workspace Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read workspace memory", `${workspaceMemoryPath}: ${error}`);
		}
	}

	const channelMemoryPath = join(channelDir, "MEMORY.md");
	if (existsSync(channelMemoryPath)) {
		try {
			const content = readFileSync(channelMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Channel-Specific Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read channel memory", `${channelMemoryPath}: ${error}`);
		}
	}

	if (parts.length === 0) {
		return "(no working memory yet)";
	}

	return parts.join("\n\n");
}

/**
 * Build the Slack-specific system prompt.
 *
 * NOTE: Skills are NOT included here — pi's buildSystemPrompt appends them
 * automatically when a customPrompt is returned from the resource loader.
 */
function buildSlackSystemPrompt(
	workspacePath: string,
	channelId: string,
	ctx: DynamicContext,
	sandboxConfig: SandboxConfig,
): string {
	const channelPath = `${workspacePath}/${channelId}`;
	const isDocker = sandboxConfig.type === "docker";

	const channelMappings =
		ctx.channels.length > 0
			? ctx.channels.map((c) => `${c.id}\t#${c.name}`).join("\n")
			: "(no channels loaded)";

	const userMappings =
		ctx.users.length > 0
			? ctx.users.map((u) => `${u.id}\t@${u.userName}\t${u.displayName}`).join("\n")
			: "(no users loaded)";

	const envDescription = isDocker
		? `You are running inside a Docker container (Alpine Linux).
- Bash working directory: / (use cd or absolute paths)
- Install tools with: apk add <package>
- Your changes persist across sessions`
		: `You are running directly on the host machine.
- Bash working directory: ${process.cwd()}
- Be careful with system modifications`;

	return `You are mom, a Slack bot assistant. Be concise. No emojis.

## Context
- For current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl (contains user messages and your final responses, but not tool results).

## Slack Formatting (mrkdwn, NOT Markdown)
Bold: *text*, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: <url|text>
Do NOT use **double asterisks** or [markdown](links).

## Slack IDs
Channels: ${channelMappings}

Users: ${userMappings}

When mentioning users, use <@username> format (e.g., <@mario>).

## Environment
${envDescription}

## Workspace Layout
${workspacePath}/
├── MEMORY.md                    # Global memory (all channels)
├── extensions/                  # Extensions (auto-loaded, host-side)
├── skills/                      # Global skills
└── ${channelId}/                # This channel
    ├── MEMORY.md                # Channel-specific memory
    ├── log.jsonl                # Message history (no tool results)
    ├── attachments/             # User-shared files
    ├── scratch/                 # Your working directory
    └── skills/                  # Channel-specific tools

## Extensions
Create TypeScript files in \`${workspacePath}/extensions/\` to extend capabilities. Auto-loaded and hot-reloaded on each message. Extensions run on the host (not sandboxed).

Documentation: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
Examples: https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions

## Events
You can schedule events that wake you up at specific times or when external things happen. Events are JSON files in \`${workspacePath}/events/\`.

### Event Types

**Immediate** - Triggers as soon as harness sees the file. Use in scripts/webhooks to signal external events.
\`\`\`json
{"type": "immediate", "channelId": "${channelId}", "text": "New GitHub issue opened"}
\`\`\`

**One-shot** - Triggers once at a specific time. Use for reminders.
\`\`\`json
{"type": "one-shot", "channelId": "${channelId}", "text": "Remind Mario about dentist", "at": "2025-12-15T09:00:00+01:00"}
\`\`\`

**Periodic** - Triggers on a cron schedule. Use for recurring tasks.
\`\`\`json
{"type": "periodic", "channelId": "${channelId}", "text": "Check inbox and summarize", "schedule": "0 9 * * 1-5", "timezone": "${Intl.DateTimeFormat().resolvedOptions().timeZone}"}
\`\`\`

### Cron Format
\`minute hour day-of-month month day-of-week\`
- \`0 9 * * *\` = daily at 9:00
- \`0 9 * * 1-5\` = weekdays at 9:00
- \`30 14 * * 1\` = Mondays at 14:30
- \`0 0 1 * *\` = first of each month at midnight

### Timezones
All \`at\` timestamps must include offset (e.g., \`+01:00\`). Periodic events use IANA timezone names. The harness runs in ${Intl.DateTimeFormat().resolvedOptions().timeZone}. When users mention times without timezone, assume ${Intl.DateTimeFormat().resolvedOptions().timeZone}.

### Creating Events
Use unique filenames to avoid overwriting existing events. Include a timestamp or random suffix:
\`\`\`bash
cat > ${workspacePath}/events/dentist-reminder-$(date +%s).json << 'EOF'
{"type": "one-shot", "channelId": "${channelId}", "text": "Dentist tomorrow", "at": "2025-12-14T09:00:00+01:00"}
EOF
\`\`\`
Or check if file exists first before creating.

### Managing Events
- List: \`ls ${workspacePath}/events/\`
- View: \`cat ${workspacePath}/events/foo.json\`
- Delete/cancel: \`rm ${workspacePath}/events/foo.json\`

### When Events Trigger
You receive a message like:
\`\`\`
[EVENT:dentist-reminder.json:one-shot:2025-12-14T09:00:00+01:00] Dentist tomorrow
\`\`\`
Immediate and one-shot events auto-delete after triggering. Periodic events persist until you delete them.

### Silent Completion
For periodic events where there's nothing to report, respond with just \`[SILENT]\` (no other text). This deletes the status message and posts nothing to Slack. Use this to avoid spamming the channel when periodic checks find nothing actionable.

### Debouncing
When writing programs that create immediate events (email watchers, webhook handlers, etc.), always debounce. If 50 emails arrive in a minute, don't create 50 immediate events. Instead collect events over a window and create ONE immediate event summarizing what happened, or just signal "new activity, check inbox" rather than per-item events. Or simpler: use a periodic event to check for new items every N minutes instead of immediate events.

### Limits
Maximum 5 events can be queued. Don't create excessive immediate or periodic events.

## Memory
Write to MEMORY.md files to persist context across conversations.
- Global (${workspacePath}/MEMORY.md): skills, preferences, project info
- Channel (${channelPath}/MEMORY.md): channel-specific decisions, ongoing work
Update when you learn something important or when asked to remember something.

### Current Memory
${ctx.memory}

## System Configuration Log
Maintain ${workspacePath}/SYSTEM.md to log all environment modifications:
- Installed packages (apk add, npm install, pip install)
- Environment variables set
- Config files modified (~/.gitconfig, cron jobs, etc.)
- Skill dependencies installed

Update this file whenever you modify the environment. On fresh container, read it first to restore your setup.

## Log Queries (for older history)
Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isBot":false}\`
The log contains user messages and your final responses (not tool calls/results).
${isDocker ? "Install jq: apk add jq" : ""}

\`\`\`bash
# Recent messages
tail -30 log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Search for specific topic
grep -i "topic" log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Messages from specific user
grep '"userName":"mario"' log.jsonl | tail -20 | jq -c '{date: .date[0:19], text}'
\`\`\`

## Tools
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- attach: Share files to Slack

Each tool requires a "label" parameter (shown to user).
`;
}
