#!/usr/bin/env node
// Deep pinned-pi smoke for git-safe-write. Boots real pi in RPC mode with the
// extension loaded (GIT_SAFE_WRITE_DEBUG=1) and asserts the load marker from
// session_start on the real process. Gate decision matrix is covered by unit
// tests against real git; this proves the extension loads and hooks live.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'pi-gsw-deep-'));
const agentDir = join(dir, 'agent');
mkdirSync(join(agentDir, 'sessions', 'tmp'), { recursive: true });
const MARKER = join(agentDir, 'git-safe-write-loaded.json');

const child = spawn(
	process.env.PI_TEST_BIN ?? join(dirname(process.execPath), 'pi'),
	['--mode', 'rpc', '--no-extensions', '-e', join(root, 'index.ts'), '--session-dir', join(agentDir, 'sessions', 'tmp')],
	{ env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, GIT_SAFE_WRITE_DEBUG: '1' }, cwd: dir },
);
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

const t0 = Date.now();
const hard = setTimeout(() => child.kill('SIGKILL'), 30_000);
const poll = setInterval(() => {
	if (existsSync(MARKER)) {
		clearInterval(poll);
		finish(true);
	} else if (Date.now() - t0 > 20_000) {
		clearInterval(poll);
		finish(false);
	}
}, 200);

function finish(ok) {
	child.kill('SIGTERM');
	child.on('exit', () => {
		clearTimeout(hard);
		try {
			if (!ok) throw new Error(`timed out waiting for session_start marker. stderr tail: ${out.slice(-600)}`);
			console.log(`Deep smoke PASS: session_start fired, gate hooks live (${(Date.now() - t0) / 1000 | 0}s).`);
			process.exit(0);
		} catch (e) {
			console.error('FAIL', e.message);
			process.exit(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
