/**
 * Babysitter resource loader: wraps pi's DefaultResourceLoader with
 * Babysitter-specific extension/skill discovery and a Slack system prompt.
 *
 * - Extensions: <workspace>/.pi/extensions/ (workspace-level)
 * - Skills: <workspace>/.pi/skills/ + built-in skills materialized into <workspace>/.pi/babysitter/skills/
 *   plus <workspace>/<channel>/skills/ (channel-local, overrides workspace)
 * - System prompt: Slack-specific prompt built from mutable per-run context
 */

import { DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";
import { createMomSettingsManager } from "./context.js";
import * as log from "./log.js";
import type { ChannelInfo, UserInfo } from "./slack.js";

/** Mutable per-run context that changes with each Slack message */
export interface DynamicContext {
	memory: string;
	channels: ChannelInfo[];
	users: UserInfo[];
}

export interface BabysitterResourceLoaderOptions {
	/** Workspace-side channel directory (e.g. data/D0ANE5J8BL3) */
	channelDir: string;
	/** Workspace path the agent sees */
	workspacePath: string;
	/** Channel ID */
	channelId: string;
}

/**
 * Create a DefaultResourceLoader configured for Babysitter.
 *
 * Uses pi's real extension/skill loading with:
 * - Built-in babysitter resources (from pi/ directory)
 * - Workspace-local hand-written resources (extensions/, skills/)
 * - Installed package resources (from .pi/settings.json via pi's package manager)
 * - Channel-specific skills
 *
 * The loader's cwd is set to the workspace directory so pi's package
 * resolution finds .pi/settings.json, .pi/npm/, and .pi/git/ correctly.
 * agentDir is set to a workspace-local dummy to prevent global ~/.pi/agent discovery.
 */
export function createBabysitterResourceLoader(
	options: BabysitterResourceLoaderOptions,
	dynamicCtx: DynamicContext,
): DefaultResourceLoader {
	const { channelDir, workspacePath, channelId } = options;
	const workspaceDir = resolve(join(channelDir, ".."));

	// Built-in paths (shipped with babysitter, in git)
	const builtinDir = join(import.meta.dirname, "..", "pi");
	const builtinExtensionsDir = join(builtinDir, "extensions");
	const builtinSkillsDir = materializeBuiltinSkills(join(builtinDir, "skills"), workspaceDir);

	// Channel-specific skills (Babysitter-specific, not known to pi)
	const channelSkillsDir = join(channelDir, "skills");

	// Built-in extensions need explicit discovery (they're outside the workspace)
	const builtinExtensionPaths = discoverExtensionPaths(builtinExtensionsDir);

	// Settings manager for this workspace — enables pi to read .pi/settings.json
	// for package sources, provider/model config, etc.
	const settingsManager = createMomSettingsManager(workspaceDir);

	const loader = new DefaultResourceLoader({
		// Real workspace dir so pi resolves .pi/settings.json, .pi/npm/, .pi/git/
		cwd: workspaceDir,
		// Workspace-local dummy agent dir — prevents global ~/.pi/agent discovery
		agentDir: resolve(workspaceDir, ".pi", "agent"),
		// Provide settings so pi can find package sources
		settingsManager,

		// Disable prompt templates and themes (not used by babysitter)
		noPromptTemplates: true,
		noThemes: true,

		// Built-in extensions (outside workspace) added explicitly.
		// pi's default discovery handles:
		// - <workspace>/.pi/extensions/ (project-local hand-written)
		// - installed package extensions (from .pi/settings.json)
		additionalExtensionPaths: builtinExtensionPaths,

		// Built-in skills + channel skills added explicitly.
		// pi's default discovery handles:
		// - <workspace>/.pi/skills/ (project-local hand-written)
		// - installed package skills (from .pi/settings.json)
		additionalSkillPaths: [builtinSkillsDir, channelSkillsDir],

		// Return the Slack-specific system prompt (without skills — pi appends them)
		systemPromptOverride: () => buildSlackSystemPrompt(workspacePath, channelId, dynamicCtx),
	});

	return loader;
}

/** Copy built-in skills into the workspace so tool scripts can read and execute them locally. */
function materializeBuiltinSkills(sourceDir: string, workspaceDir: string): string {
	const targetDir = join(workspaceDir, ".pi", "babysitter", "skills");

	if (!existsSync(sourceDir)) {
		return targetDir;
	}

	mkdirSync(dirname(targetDir), { recursive: true });
	rmSync(targetDir, { recursive: true, force: true });
	cpSync(sourceDir, targetDir, { recursive: true, force: true });
	return targetDir;
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
function buildSlackSystemPrompt(workspacePath: string, channelId: string, ctx: DynamicContext): string {
	const channelPath = `${workspacePath}/${channelId}`;

	const channelMappings =
		ctx.channels.length > 0 ? ctx.channels.map((c) => `${c.id}\t#${c.name}`).join("\n") : "(no channels loaded)";

	const userMappings =
		ctx.users.length > 0
			? ctx.users.map((u) => `${u.id}\t@${u.userName}\t${u.displayName}`).join("\n")
			: "(no users loaded)";

	const envDescription = `You are running in the same execution environment as babysitter.
- Bash working directory: ${workspacePath}
- Use absolute paths or cd as needed
- Install tools with whatever package manager is available in this container or environment (for example: apk add, apt-get install, npm install)
- Your changes persist across sessions while this workspace/container persists`;

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
├── projects/                    # Git repositories to inspect and sync
├── .pi/
│   ├── settings.json            # Model + package settings
│   ├── extensions/              # Hand-written extensions
│   ├── skills/                  # Hand-written shared skills
│   └── babysitter/skills/       # Built-in babysitter skills
└── ${channelId}/                # This channel
    ├── MEMORY.md                # Channel-specific memory
    ├── log.jsonl                # Message history (no tool results)
    ├── attachments/             # User-shared files
    ├── scratch/                 # Your working directory
    └── skills/                  # Channel-specific tools

## Projects
Put repositories you want to inspect under \`${workspacePath}/projects/\`.

When a user asks about a repo in that directory:
- first identify the matching repository
- use the \`project-sync\` skill before reading files or answering
- default to syncing only the relevant repo, not every repo
- prefer safe sync behavior: clean tracked repos may fast-forward, dirty repos should stay unchanged and fall back to fetch-only
- if a repo stays fetch-only, inspect the latest upstream state via git refs such as \`origin/main\`

## Extensions
Create TypeScript files in \`${workspacePath}/.pi/extensions/\` to extend capabilities. Auto-loaded and hot-reloaded on each message. Extensions run in the same environment as babysitter.

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
If jq is missing, install it first.

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
