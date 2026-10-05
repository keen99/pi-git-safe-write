/**
 * Git-Safe Write Extension for pi
 *
 * Intercepts write/edit tool calls so pi only modifies files the user has
 * opted into. Specifically, it gates writes to *existing, untracked* files
 * inside a git repo and asks for confirmation. Everything else is allowed.
 *
 * Decision matrix:
 *
 *   tracked file            -> allow
 *   new file (doesn't exist)-> allow (creating a new file)
 *   temp file (/tmp etc)    -> allow (scratch, never gated)
 *   ignored file            -> allow (explicitly excluded from VCS)
 *   untracked existing file -> PROMPT (the only gate)
 *   outside a git repo      -> PROMPT ("not tracked" in the primary sense)
 *
 * Commands:
 *   /unsafe  Disable the untracked-file gate for the session (persists
 *            across /reload, resets on /new /fork).
 *   /safe    Re-enable full protection.
 *   /nosafe  Disable the entire extension until restart (not persisted).
 *
 * State is stored via pi.appendEntry so approvals and bypass survive
 * /reload. /new and /fork reset state because they start a new session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, join, resolve, isAbsolute, sep } from "node:path";

export interface GitStatus {
	/** True if the file is tracked by git (staged or committed). */
	tracked: boolean;
	/** True if the file currently exists on disk. */
	exists: boolean;
	/** True if the file matches a .gitignore rule. */
	ignored: boolean;
	/** True if the file lives inside a git working tree. */
	inRepo: boolean;
}

interface ApprovedFilesState {
	approvedPaths: string[];
}

interface BypassState {
	bypassed: boolean;
}

const APPROVED_FILES_KEY = "git-safe-write-approved";
const BYPASS_KEY = "git-safe-write-bypass";

// Temp dirs: always allow. pi (and agents in general) scribble scratch files
// here constantly. Gating them just adds noise. Covers os.tmpdir() plus the
// conventional Unix temp locations.
const TMP_DIRS: string[] = Array.from(
	new Set(
		[
			tmpdir(),
			"/tmp",
			"/var/tmp",
			"/private/tmp", // macOS symlink target of /tmp
			"/private/var/tmp",
		].map((p) => {
				try {
					return resolve(p);
				} catch {
					return p;
				}
			}),
	),
);

/** True if abs path lives under a known temp directory. */
export function isInTmp(abs: string): boolean {
	return TMP_DIRS.some((dir) => abs === dir || abs.startsWith(dir + sep));
}

/**
 * Resolve a (possibly relative) path to an absolute path. Returns undefined
 * if resolution fails.
 */
export function resolveAbsolute(rawPath: string, cwd: string): string | undefined {
	// Defer to node:path so we don't reimplement edge cases.
	try {
		return isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
	} catch {
		return undefined;
	}
}

/**
 * Determine the git status of a file using only the git binary (no shell
 * helper script). All git calls are bounded and never throw: on any error
 * we return a permissive status so writes are never accidentally blocked.
 */
export async function checkGitStatus(filePath: string, cwd: string, pi: ExtensionAPI, signal?: AbortSignal): Promise<GitStatus> {
	let abs = resolveAbsolute(filePath, cwd);
	if (!abs) {
		return { tracked: false, exists: false, ignored: false, inRepo: false };
	}

	// Temp files: short-circuit as "tracked" so they're never gated.
	if (isInTmp(abs)) {
		return { tracked: true, exists: true, ignored: false, inRepo: false };
	}

	let exists = false;
	try {
		exists = existsSync(abs);
	} catch {
		exists = false;
	}

	// Normalize symlinked ancestors (macOS /var -> /private/var) so the file
	// path shares a prefix with the repo root git rev-parse returns (always
	// realized). Without this, tracked files under symlinked dirs look
	// untracked and get falsely gated.
	try {
		abs = join(dirname(realpathSync(abs)), basename(abs));
	} catch {
		/* keep unresolved abs — file may not exist yet */
	}

	// Find the repo root from the file's directory. If git can't find a
	// repo, we're outside VCS entirely -> allow.
	const dir = dirname(abs);
	let root: string | undefined;
	try {
		const rootResult = await pi.exec("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
			signal,
			timeout: 5000,
		});
		if (rootResult.code !== 0) {
			return { tracked: false, exists, ignored: false, inRepo: false };
		}
		root = rootResult.stdout.trim();
	} catch {
		return { tracked: false, exists, ignored: false, inRepo: false };
	}
	if (!root) {
		return { tracked: false, exists, ignored: false, inRepo: false };
	}

	// Repo-relative path. Fall back to absolute if the prefix strip fails.
	const rel = abs.startsWith(root + "/") ? abs.slice(root.length + 1) : abs;

	// Tracked? ls-files --error-unmatch exits non-zero when untracked.
	let tracked = false;
	try {
		const trackedResult = await pi.exec("git", ["-C", root, "ls-files", "--error-unmatch", "--", rel], {
			signal,
			timeout: 5000,
		});
		tracked = trackedResult.code === 0;
	} catch {
		tracked = false;
	}

	// Ignored? check-ignore exits 0 when the path is ignored.
	let ignored = false;
	if (!tracked) {
		try {
			const ignoreResult = await pi.exec("git", ["-C", root, "check-ignore", "--quiet", "--", rel], {
				signal,
				timeout: 5000,
			});
			ignored = ignoreResult.code === 0;
		} catch {
			ignored = false;
		}
	}

	return { tracked, exists, ignored, inRepo: true };
}

/** The gate: any existing file git does not track (ignored = allowed). */
export function needsGate(status: GitStatus): boolean {
	return status.exists && !status.tracked && !status.ignored;
}


/** Best-effort desktop notification that pi needs a decision. Never throws. */
function notifyAttention(title: string, body: string): void {
	if (process.platform === "darwin") {
		const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		try {
			execFileSync(
				"osascript",
				["-e", `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`],
				{ timeout: 3000, stdio: "ignore" },
			);
		} catch {
			/* silent */
		}
	} else {
		// BEL works in most terminals as a minimal attention signal.
		try {
			process.stdout.write("\x07");
		} catch {
			/* silent */
		}
	}
}

export default function (pi: ExtensionAPI) {
	const approvedFiles = new Set<string>();
	let bypass = false;
	let disabled = false;

	// ── Footer status ──
	type StatusCtx = {
		ui: { setStatus(key: string, text: string | undefined): void; theme?: { fg(color: string, text: string): string } };
	};

	function statusText(): string {
		if (disabled) return "🔒 safe:off";
		if (bypass) return "🔓 safe:BYPASS";
		return `🔒 safe:on${approvedFiles.size ? ` (${approvedFiles.size})` : ""}`;
	}

	function statusColor(): string {
		if (disabled) return "dim";
		if (bypass) return "warning";
		return "dim";
	}

	function updateStatus(ctx: StatusCtx) {
		try {
			const theme = ctx.ui.theme;
			const text = statusText();
			ctx.ui.setStatus("zs-git-safe-write", theme?.fg ? theme.fg(statusColor(), text) : text);
		} catch {
			/* footer status is best-effort */
		}
	}

	// Restore session-persisted state. Runs before any tool_call, so the
	// gate reflects prior approvals/bypass as soon as the session is live.
	pi.on("session_start", async (_event, ctx) => {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === APPROVED_FILES_KEY) {
				const data = entry.data as ApprovedFilesState | undefined;
				if (data?.approvedPaths) {
					for (const p of data.approvedPaths) approvedFiles.add(p);
				}
			}
			if (entry.customType === BYPASS_KEY) {
				const data = entry.data as BypassState | undefined;
				if (data?.bypassed) bypass = true;
			}
		}
		updateStatus(ctx);
		if (process.env.GIT_SAFE_WRITE_DEBUG === "1") {
			try {
				const { writeFileSync: wf, mkdirSync: md } = await import("node:fs");
				const { join: j } = await import("node:path");
				const { homedir: hd } = await import("node:os");
				const agentDir = process.env.PI_CODING_AGENT_DIR || j(hd(), ".pi", "agent");
				md(agentDir, { recursive: true });
				wf(j(agentDir, "git-safe-write-loaded.json"), JSON.stringify({ loaded: true }) + "\n");
			} catch { /* best-effort */ }
		}
	});

	function saveApprovedFiles(): void {
		pi.appendEntry<ApprovedFilesState>(APPROVED_FILES_KEY, {
			approvedPaths: Array.from(approvedFiles),
		});
	}

	function saveBypass(ctx: StatusCtx): void {
		pi.appendEntry<BypassState>(BYPASS_KEY, { bypassed: bypass });
		updateStatus(ctx);
	}

	// /unsafe — allow untracked-in-repo writes for the session (persists
	// across /reload; resets on /new /fork because those start new sessions).
	pi.registerCommand("unsafe", {
		description: "safe-write: allow untracked-file writes (this session)",
		handler: async (_args, ctx) => {
			bypass = true;
			saveBypass(ctx);
			ctx.ui.notify("git-safe-write: untracked-file gate DISABLED. Use /safe to re-enable.", "warning");
		},
	});

	// /safe — re-enable full protection.
	pi.registerCommand("safe", {
		description: "safe-write: re-enable untracked-file gate",
		handler: async (_args, ctx) => {
			bypass = false;
			disabled = false;
			saveBypass(ctx);
			ctx.ui.notify("git-safe-write: FULLY ENABLED", "info");
		},
	});

	// /nosafe — disable the entire extension until restart (not persisted).
	pi.registerCommand("nosafe", {
		description: "safe-write: disable entire extension until restart",
		handler: async (_args, ctx) => {
			disabled = true;
			updateStatus(ctx);
			ctx.ui.notify("git-safe-write: ENTIRELY DISABLED until restart. Use /safe to re-enable.", "error");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

		let filePath: string | undefined;
		if (isToolCallEventType("write", event)) {
			filePath = event.input.path;
		} else if (isToolCallEventType("edit", event)) {
			filePath = event.input.path;
		}
		if (!filePath) return undefined;

		// Entire extension disabled — allow everything.
		if (disabled) return undefined;

		// Already approved this session — skip the prompt.
		if (approvedFiles.has(filePath)) return undefined;

		const status = await checkGitStatus(filePath, ctx.cwd, pi, ctx.signal);

		// Gate: any existing file git doesn't track. Covers untracked files
		// inside a repo AND files outside any repo ("not tracked" in the
		// primary sense). Ignored files are part of the repo by explicit
		// exclusion, so they're allowed.
		if (status.exists && !status.tracked && !status.ignored && !bypass) {
			// Lazy restore: in case session_start hasn't run for this path
			// yet, double-check the session entries directly.
			try {
				for (const entry of ctx.sessionManager.getEntries()) {
					if (entry.type === "custom" && entry.customType === BYPASS_KEY) {
						const data = entry.data as BypassState | undefined;
						if (data?.bypassed) {
							bypass = true;
							break;
						}
					}
				}
			} catch {
				/* ignore */
			}
			if (bypass) return undefined;

			if (!ctx.hasUI) {
				return {
					block: true,
					reason: `git-safe-write: "${filePath}" is not git-tracked and no UI is available. Run /unsafe to allow untracked writes for this session. Do NOT modify the file through any other mechanism (bash redirection, tee, cp, sed -i, python, etc.) — tell the user what you need instead.`,
				};
			}

			notifyAttention("pi needs input", `${event.toolName}: ${filePath}`);

			const choice = await ctx.ui.select(
				`git-safe-write: file not git-tracked\n\n  ${filePath}\n\n${event.toolName === "write" ? "Write to" : "Edit"} it? (/unsafe = allow all untracked this session)`,
				["Yes (this time only)", "Yes (remember for session)", "No"],
			);

			if (!choice || choice === "No") {
				return {
					block: true,
					reason: `User declined to ${event.toolName} untracked file "${filePath}". Do NOT modify it through any other mechanism (bash redirection, tee, cp, sed -i, python, etc.). The user said no. If you believe the change is necessary, stop and explain why, then wait for the user to decide.`,
				};
			}

			if (choice === "Yes (remember for session)") {
				approvedFiles.add(filePath);
				saveApprovedFiles();
				updateStatus(ctx);
			}
		}

		return undefined;
	});
}
