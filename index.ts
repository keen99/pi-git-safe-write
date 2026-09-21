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

interface GitStatus {
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
const os = require("node:os") as typeof import("node:os");
const pathMod = require("node:path") as typeof import("node:path");
const TMP_DIRS: string[] = Array.from(
	new Set(
		[
			os.tmpdir(),
			"/tmp",
			"/var/tmp",
			"/private/tmp", // macOS symlink target of /tmp
			"/private/var/tmp",
		].map((p) => {
				try {
					return pathMod.resolve(p);
				} catch {
					return p;
				}
			}),
	),
);

/** True if abs path lives under a known temp directory. */
function isInTmp(abs: string): boolean {
	return TMP_DIRS.some((dir) => abs === dir || abs.startsWith(dir + pathMod.sep));
}

/**
 * Resolve a (possibly relative) path to an absolute path. Returns undefined
 * if resolution fails.
 */
function resolveAbsolute(rawPath: string, cwd: string): string | undefined {
	// Defer to node:path so we don't reimplement edge cases.
	const { resolve, isAbsolute } = require("node:path") as typeof import("node:path");
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
async function checkGitStatus(filePath: string, cwd: string, pi: ExtensionAPI, signal?: AbortSignal): Promise<GitStatus> {
	const abs = resolveAbsolute(filePath, cwd);
	if (!abs) {
		return { tracked: false, exists: false, ignored: false, inRepo: false };
	}

	// Temp files: short-circuit as "tracked" so they're never gated.
	if (isInTmp(abs)) {
		return { tracked: true, exists: true, ignored: false, inRepo: false };
	}

	const fs = require("node:fs") as typeof import("node:fs");
	let exists = false;
	try {
		exists = fs.existsSync(abs);
	} catch {
		exists = false;
	}

	// Find the repo root from the file's directory. If git can't find a
	// repo, we're outside VCS entirely -> allow.
	const dir = require("node:path").dirname(abs);
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

import { execFileSync } from "node:child_process";

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
	});

	function saveApprovedFiles(): void {
		pi.appendEntry<ApprovedFilesState>(APPROVED_FILES_KEY, {
			approvedPaths: Array.from(approvedFiles),
		});
	}

	function saveBypass(): void {
		pi.appendEntry<BypassState>(BYPASS_KEY, { bypassed: bypass });
	}

	// /unsafe — allow untracked-in-repo writes for the session (persists
	// across /reload; resets on /new /fork because those start new sessions).
	pi.registerCommand("unsafe", {
		description: "Allow writes to untracked files in git repos for this session",
		handler: async (_args, ctx) => {
			bypass = true;
			saveBypass();
			ctx.ui.notify("git-safe-write: untracked-file gate DISABLED. Use /safe to re-enable.", "warning");
		},
	});

	// /safe — re-enable full protection.
	pi.registerCommand("safe", {
		description: "Re-enable git-safe-write protection",
		handler: async (_args, ctx) => {
			bypass = false;
			disabled = false;
			saveBypass();
			ctx.ui.notify("git-safe-write: FULLY ENABLED", "info");
		},
	});

	// /nosafe — disable the entire extension until restart (not persisted).
	pi.registerCommand("nosafe", {
		description: "Disable git-safe-write entirely until restart",
		handler: async (_args, ctx) => {
			disabled = true;
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
					reason: `File "${filePath}" is not git-tracked and no UI is available for confirmation. Use /unsafe to bypass.`,
				};
			}

			notifyAttention("pi needs input", `${event.toolName}: ${filePath}`);

			const choice = await ctx.ui.select(
				`File not git-tracked\n\n  ${filePath}\n\n${event.toolName === "write" ? "Write to" : "Edit"} this file?`,
				["Yes (this time only)", "Yes (remember for session)", "No"],
			);

			if (!choice || choice === "No") {
				return {
					block: true,
					reason: `User declined to ${event.toolName} untracked file "${filePath}"`,
				};
			}

			if (choice === "Yes (remember for session)") {
				approvedFiles.add(filePath);
				saveApprovedFiles();
			}
		}

		return undefined;
	});
}
