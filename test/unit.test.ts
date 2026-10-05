import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { checkGitStatus, isInTmp, needsGate, resolveAbsolute, type GitStatus } from "../index.js";

// Scratch lives INSIDE the harness dir (never under tmpdir()) — the
// extension short-circuits temp paths as never-gated, so git repos for
// checkGitStatus tests must live outside OS temp.
const SCRATCH = join(process.cwd(), ".test-scratch");
let roots: string[] = [];
function tempDir(): string {
	const d = join(SCRATCH, Math.random().toString(36).slice(2));
	mkdirSync(d, { recursive: true });
	roots.push(d);
	return d;
}
function gitRepo(): string {
	const d = tempDir();
	execFileSync("git", ["init", "-q"], { cwd: d });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: d });
	execFileSync("git", ["config", "user.name", "t"], { cwd: d });
	return d;
}
/** Fake pi.exec over real git — matches the ExtensionAPI exec contract used by checkGitStatus. */
function fakePi(): { exec: (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ code: number; stdout: string }> } {
	return {
		exec: async (cmd, args, opts) => {
			try {
				const stdout = execFileSync(cmd, args, { timeout: opts?.timeout ?? 5000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
				return { code: 0, stdout };
			} catch (err) {
				const e = err as { status?: number; stdout?: string };
				return { code: e.status ?? 1, stdout: e.stdout ?? "" };
			}
		},
	};
}
const pi = fakePi();

test.after(() => {
	rmSync(SCRATCH, { recursive: true, force: true });
});

// ---------- isInTmp ----------
test("isInTmp: tmpdir itself and children true", () => {
	assert.equal(isInTmp(tmpdir()), true);
	assert.equal(isInTmp(join(tmpdir(), "scratch", "x.txt")), true);
});
test("isInTmp: /tmp and macOS /private/tmp true", () => {
	assert.equal(isInTmp("/tmp/x.txt"), true);
	assert.equal(isInTmp("/private/tmp/x.txt"), true);
	assert.equal(isInTmp("/var/tmp/x.txt"), true);
});
test("isInTmp: prefix-lookalike directory false", () => {
	assert.equal(isInTmp("/tmpx/file.txt"), false);
	assert.equal(isInTmp("/usr/tmp-clone/x.txt"), false);
});
test("isInTmp: normal paths false", () => {
	assert.equal(isInTmp("/Users/x/proj/a.ts"), false);
});

// ---------- resolveAbsolute ----------
test("resolveAbsolute: absolute passthrough", () => {
	assert.equal(resolveAbsolute("/a/b/c.txt", "/x"), "/a/b/c.txt");
});
test("resolveAbsolute: relative joined to cwd", () => {
	assert.equal(resolveAbsolute("sub/file.txt", "/x/y"), "/x/y/sub/file.txt");
});
test("resolveAbsolute: dot-dot resolved", () => {
	assert.equal(resolveAbsolute("../file.txt", "/x/y"), "/x/file.txt");
});

// ---------- needsGate decision matrix ----------
test("needsGate: tracked -> false", () => {
	assert.equal(needsGate({ tracked: true, exists: true, ignored: false, inRepo: true }), false);
});
test("needsGate: new file (not exists) -> false", () => {
	assert.equal(needsGate({ tracked: false, exists: false, ignored: false, inRepo: true }), false);
});
test("needsGate: ignored -> false", () => {
	assert.equal(needsGate({ tracked: false, exists: true, ignored: true, inRepo: true }), false);
});
test("needsGate: untracked existing -> true", () => {
	assert.equal(needsGate({ tracked: false, exists: true, ignored: false, inRepo: true }), true);
});
test("needsGate: outside repo existing -> true", () => {
	assert.equal(needsGate({ tracked: false, exists: true, ignored: false, inRepo: false }), true);
});
test("needsGate: tmp short-circuit shape -> false", () => {
	assert.equal(needsGate({ tracked: true, exists: true, ignored: false, inRepo: false }), false);
});

// ---------- checkGitStatus against real git ----------
test("checkGitStatus: committed file tracked", async () => {
	const repo = gitRepo();
	const f = join(repo, "tracked.txt");
	writeFileSync(f, "v1\n");
	execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
	execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
	const st = await checkGitStatus(f, repo, pi as never);
	assert.equal(st.tracked, true);
	assert.equal(st.exists, true);
	assert.equal(st.inRepo, true);
	assert.equal(needsGate(st), false);
});
test("checkGitStatus: staged-but-uncommitted file tracked", async () => {
	const repo = gitRepo();
	const f = join(repo, "staged.txt");
	writeFileSync(f, "v1\n");
	execFileSync("git", ["add", "staged.txt"], { cwd: repo });
	const st = await checkGitStatus(f, repo, pi as never);
	assert.equal(st.tracked, true);
	assert.equal(needsGate(st), false);
});
test("checkGitStatus: untracked existing file gated", async () => {
	const repo = gitRepo();
	writeFileSync(join(repo, "committed.txt"), "x\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
	const f = join(repo, "untracked.txt");
	writeFileSync(f, "new\n");
	const st = await checkGitStatus(f, repo, pi as never);
	assert.equal(st.tracked, false);
	assert.equal(st.exists, true);
	assert.equal(st.ignored, false);
	assert.equal(needsGate(st), true);
});
test("checkGitStatus: ignored file allowed", async () => {
	const repo = gitRepo();
	writeFileSync(join(repo, ".gitignore"), "secret.txt\n");
	writeFileSync(join(repo, "committed.txt"), "x\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
	const f = join(repo, "secret.txt");
	writeFileSync(f, "s\n");
	const st = await checkGitStatus(f, repo, pi as never);
	assert.equal(st.ignored, true);
	assert.equal(needsGate(st), false);
});
test("checkGitStatus: nonexistent new file not gated", async () => {
	const repo = gitRepo();
	writeFileSync(join(repo, "a.txt"), "x\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
	const st = await checkGitStatus(join(repo, "brand-new.txt"), repo, pi as never);
	assert.equal(st.exists, false);
	assert.equal(needsGate(st), false);
});
// "Outside any repo" is unreachable on this machine (every scratch path
// sits in the harness worktree, and .test-scratch is git-ignored — covered
// by the ignored test above). The gate matrix itself is fully covered by
// the needsGate decision tests.
test("checkGitStatus: tmp path short-circuits without git", async () => {
	const f = join(tmpdir(), "pi-gsw-scratch-test.txt");
	writeFileSync(f, "x\n");
	try {
		const st = await checkGitStatus(f, tmpdir(), pi as never);
		assert.equal(st.tracked, true);
		assert.equal(st.inRepo, false);
		assert.equal(needsGate(st), false);
	} finally {
		rmSync(f, { force: true });
	}
});
test("checkGitStatus: nested path in repo subtree resolves root", async () => {
	const repo = gitRepo();
	mkdirSync(join(repo, "deep", "dir"), { recursive: true });
	writeFileSync(join(repo, "deep", "dir", "f.txt"), "x\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
	const st = await checkGitStatus(join(repo, "deep", "dir", "f.txt"), repo, pi as never);
	assert.equal(st.tracked, true);
});
