/**
 * Package management for Babysitter.
 *
 * Provides CLI commands: install, remove, update, list
 * All operations are workspace-local (project scope only).
 *
 * Packages are installed to <workspace>/.pi/npm/ and <workspace>/.pi/git/
 * Package sources are persisted in <workspace>/.pi/settings.json
 */

import { DefaultPackageManager, type ProgressEvent } from "@mariozechner/pi-coding-agent";
import { resolve } from "path";
import { createMomSettingsManager } from "./context.js";

function createWorkspacePackageManager(workspaceDir: string): DefaultPackageManager {
	const settingsManager = createMomSettingsManager(workspaceDir);

	return new DefaultPackageManager({
		cwd: workspaceDir,
		// agentDir points to a workspace-local dummy — we never use global/user scope,
		// but the API requires it. Setting it inside the workspace ensures nothing
		// escapes to ~/.pi/agent.
		agentDir: resolve(workspaceDir, ".pi", "agent"),
		settingsManager,
	});
}

function formatProgress(event: ProgressEvent): string {
	const prefix = `[${event.action}] ${event.source}`;
	switch (event.type) {
		case "start":
			return `${prefix}: starting...`;
		case "progress":
			return `${prefix}: ${event.message || "working..."}`;
		case "complete":
			return `${prefix}: done`;
		case "error":
			return `${prefix}: ERROR - ${event.message || "unknown error"}`;
		default:
			return prefix;
	}
}

async function install(workspaceDir: string, source: string): Promise<number> {
	const pm = createWorkspacePackageManager(workspaceDir);
	pm.setProgressCallback((event) => console.log(formatProgress(event)));

	try {
		await pm.install(source, { local: true });
		pm.addSourceToSettings(source, { local: true });
		console.log(`Installed ${source}`);
		return 0;
	} catch (err) {
		console.error(`Failed to install ${source}: ${err instanceof Error ? err.message : err}`);
		return 1;
	}
}

async function remove(workspaceDir: string, source: string): Promise<number> {
	const pm = createWorkspacePackageManager(workspaceDir);
	pm.setProgressCallback((event) => console.log(formatProgress(event)));

	try {
		await pm.remove(source, { local: true });
		pm.removeSourceFromSettings(source, { local: true });
		console.log(`Removed ${source}`);
		return 0;
	} catch (err) {
		console.error(`Failed to remove ${source}: ${err instanceof Error ? err.message : err}`);
		return 1;
	}
}

async function update(workspaceDir: string, source?: string): Promise<number> {
	const pm = createWorkspacePackageManager(workspaceDir);
	pm.setProgressCallback((event) => console.log(formatProgress(event)));

	try {
		await pm.update(source);
		console.log(source ? `Updated ${source}` : "Updated all packages");
		return 0;
	} catch (err) {
		console.error(`Failed to update: ${err instanceof Error ? err.message : err}`);
		return 1;
	}
}

async function list(workspaceDir: string): Promise<number> {
	const pm = createWorkspacePackageManager(workspaceDir);
	const settingsManager = createMomSettingsManager(workspaceDir);

	const packages = settingsManager.getPackages();

	if (packages.length === 0) {
		console.log("No packages installed.");
		return 0;
	}

	console.log("Installed packages:\n");
	for (const pkg of packages) {
		const source = typeof pkg === "string" ? pkg : pkg.source;
		const installedPath = pm.getInstalledPath(source, "project");
		if (installedPath) {
			console.log(`  ${source}`);
			console.log(`    path: ${installedPath}`);
		} else {
			console.log(`  ${source}  (not installed)`);
		}
	}

	return 0;
}

/**
 * Handle a package CLI command.
 * Called from main.ts when argv[2] is install/remove/update/list.
 *
 * @returns exit code (0 = success, 1 = error)
 */
export async function handlePackageCommand(command: string, args: string[]): Promise<number> {
	// Workspace is cwd
	const workspaceDir = resolve(process.cwd());

	switch (command) {
		case "install": {
			const source = args[0];
			if (!source) {
				console.error("Usage: babysitter install <source>");
				console.error("  e.g. babysitter install npm:pi-mcporter");
				return 1;
			}
			return install(workspaceDir, source);
		}
		case "remove": {
			const source = args[0];
			if (!source) {
				console.error("Usage: babysitter remove <source>");
				return 1;
			}
			return remove(workspaceDir, source);
		}
		case "update":
			return update(workspaceDir, args[0]);
		case "list":
			return list(workspaceDir);
		default:
			console.error(`Unknown package command: ${command}`);
			return 1;
	}
}
