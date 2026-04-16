import { spawnSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { createMomSettingsManager } from "./context.js";
import * as log from "./log.js";
import { createWorkspacePackageManager, ensureWorkspacePackageInstalled } from "./packages.js";

export const REQUIRED_WORKSPACE_PACKAGES = ["npm:pi-subagents@0.14.1"];

const REQUIRED_DIRECTORIES = [".pi", join(".pi", "agents"), "jobs", "worktrees"];

export async function bootstrapWorkspace(workspaceDir: string): Promise<void> {
	log.logInfo(`Bootstrapping workspace: ${workspaceDir}`);

	ensureWorkspaceDirectories(workspaceDir);
	await ensureWorkspacePackages(workspaceDir);
	await materializeBuiltinAgentTemplates(workspaceDir);
	await validateRuntimePrerequisites();
	await runCompatibilityChecks(workspaceDir);
}

function ensureWorkspaceDirectories(workspaceDir: string): void {
	for (const relativeDir of REQUIRED_DIRECTORIES) {
		mkdirSync(join(workspaceDir, relativeDir), { recursive: true });
	}
}

async function ensureWorkspacePackages(workspaceDir: string): Promise<void> {
	for (const source of REQUIRED_WORKSPACE_PACKAGES) {
		const result = await ensureWorkspacePackageInstalled(workspaceDir, source, {
			onProgress: (message) => log.logInfo(message),
		});
		log.logInfo(`${result.changed ? "Ready" : "Verified"} workspace package: ${source}`);
	}
}

async function materializeBuiltinAgentTemplates(workspaceDir: string): Promise<void> {
	const sourceDir = join(import.meta.dirname, "..", "pi", "agents");
	const targetDir = join(workspaceDir, ".pi", "agents");

	if (!existsSync(sourceDir)) {
		return;
	}

	mkdirSync(targetDir, { recursive: true });

	for (const entry of readdirSync(sourceDir)) {
		const sourcePath = join(sourceDir, entry);
		const targetPath = join(targetDir, entry);
		if (!statSync(sourcePath).isFile() || existsSync(targetPath)) {
			continue;
		}
		mkdirSync(dirname(targetPath), { recursive: true });
		copyFileSync(sourcePath, targetPath);
		log.logInfo(`Materialized agent template: ${targetPath}`);
	}
}

async function validateRuntimePrerequisites(): Promise<void> {
	assertCommandAvailable("pi", ["--version"]);
	assertCommandAvailable("git", ["--version"]);
	assertCommandAvailable("gh", ["--version"]);

	const ghAuth = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
	if (ghAuth.status !== 0) {
		const details = [ghAuth.stdout, ghAuth.stderr].filter(Boolean).join("\n").trim();
		log.logWarning("GitHub CLI is not authenticated; PR creation will fail until you run `gh auth login`.", details);
	}
}

function assertCommandAvailable(command: string, args: string[]): void {
	const result = spawnSync(command, args, { encoding: "utf-8" });
	if (result.status !== 0) {
		const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		throw new Error(`Required command failed: ${command} ${args.join(" ")}\n${details}`.trim());
	}
}

async function runCompatibilityChecks(workspaceDir: string): Promise<void> {
	const pm = createWorkspacePackageManager(workspaceDir);
	const installedPath = pm.getInstalledPath(REQUIRED_WORKSPACE_PACKAGES[0], "project");

	if (!installedPath) {
		throw new Error(
			`Compatibility check failed: ${REQUIRED_WORKSPACE_PACKAGES[0]} is not installed in project scope.`,
		);
	}

	const packageEntryPoints = [join(installedPath, "index.ts"), join(installedPath, "index.js"), join(installedPath, "package.json")];
	if (!packageEntryPoints.some((file) => existsSync(file))) {
		throw new Error(
			`Compatibility check failed: ${REQUIRED_WORKSPACE_PACKAGES[0]} was installed, but no recognizable package entrypoint was found in ${installedPath}.`,
		);
	}

	const probeCwd = resolve(workspaceDir, "worktrees", "compatibility-probe", "nested");
	mkdirSync(probeCwd, { recursive: true });
	const discoveredProjectAgent = findAncestorAgent(probeCwd, "pr-worker.md");
	if (!discoveredProjectAgent || discoveredProjectAgent !== resolve(workspaceDir, ".pi", "agents", "pr-worker.md")) {
		throw new Error(
			`Compatibility check failed: project agent discovery from worktrees does not reach ${resolve(workspaceDir, ".pi", "agents")}.`,
		);
	}

	const settingsManager = createMomSettingsManager(workspaceDir);
	await settingsManager.flush();
	for (const error of settingsManager.drainErrors()) {
		log.logWarning(`Workspace settings ${error.scope} write error`, error.error.message);
	}

	log.logInfo(`Verified subagent compatibility with ${REQUIRED_WORKSPACE_PACKAGES[0]}`);
}

function findAncestorAgent(startDir: string, agentFileName: string): string | undefined {
	let current = resolve(startDir);
	while (true) {
		const candidate = join(current, ".pi", "agents", agentFileName);
		if (existsSync(candidate)) {
			return candidate;
		}
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}
