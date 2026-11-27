import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { createFindOperations } from "../src/files.ts";

const target = { backend: "ssh", host: "unused.invalid" };
const root = "/work";
const byteChunks = (text) => Array.from(Buffer.from(text), (byte) => Buffer.from([byte]));

// Exercise the real find and run code, but never spawn a process. Emit exact byte boundaries
// instead of relying on OS pipe buffering or timing to split a UTF-8 character.
function mockStdout(t, chunks, { afterChunk, code = 0 } = {}) {
	const kills = [];
	let emitted = 0;
	const spawn = t.mock.method(childProcess, "spawn", () => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		let killed = false;
		child.kill = (signal) => {
			kills.push(signal);
			killed = true;
			queueMicrotask(() => child.emit("close", null));
			return true;
		};
		queueMicrotask(() => {
			for (const chunk of chunks) {
				if (killed) return;
				child.stdout.emit("data", chunk);
				emitted++;
				afterChunk?.(emitted);
			}
			if (!killed) child.emit("close", code);
		});
		return child;
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	return { kills, spawn, get emitted() { return emitted; } };
}

test("find preserves UTF-8 when stdout splits every byte, including NUL delimiters", async (t) => {
	mockStdout(t, byteChunks("./src/中文.ts\0src/café.ts\0src/😀.ts\0src/next.ts\0"));
	assert.deepEqual(await createFindOperations({ target }).glob("*.ts", root, { limit: 20 }), [
		"src/中文.ts", "src/café.ts", "src/😀.ts", "src/next.ts",
	]);
});

for (const [pattern, expected] of [
	["中文.ts", ["src/中文.ts", "src/lib/中文.ts"]],
	["./src/*.ts", ["src/中文.ts", "src/UPPER.TS", "src/.hidden.ts"]],
	["src/**/*.ts", ["src/中文.ts", "src/lib/中文.ts", "src/UPPER.TS", "src/.hidden.ts"]],
	["/work/src/**/中文.ts", ["src/中文.ts", "src/lib/中文.ts"]],
	["*.TS", ["src/UPPER.TS"]],
	["lib/*.ts", []],
]) {
	test(`find preserves glob semantics for ${pattern}`, async (t) => {
		mockStdout(t, byteChunks("./src/中文.ts\0src/lib/中文.ts\0src/UPPER.TS\0src/.hidden.ts\0node_modules/中文.ts\0"));
		assert.deepEqual(await createFindOperations({ target }).glob(pattern, root, { limit: 20 }), expected);
	});
}

test("find decodes the final unterminated path", async (t) => {
	mockStdout(t, byteChunks("src/中文.ts\0src/😀.ts"));
	assert.deepEqual(await createFindOperations({ target }).glob("*.ts", root, { limit: 20 }), ["src/中文.ts", "src/😀.ts"]);
});

test("find stops at the match limit, including when more paths arrive in the same chunk", async (t) => {
	const bytes = Buffer.from("src/中文.ts\0src/second.ts\0");
	const split = Buffer.byteLength("src/") + 1;
	const mock = mockStdout(t, [bytes.subarray(0, split), bytes.subarray(split), Buffer.from("src/third.ts\0")]);
	assert.deepEqual(await createFindOperations({ target }).glob("*.ts", root, { limit: 1 }), ["src/中文.ts"]);
	assert.deepEqual(mock.kills, ["SIGTERM"]);
	assert.equal(mock.emitted, 2);
});

test("find propagates external cancellation even with a partial UTF-8 path buffered", async (t) => {
	const controller = new AbortController();
	const mock = mockStdout(t, [Buffer.from("src/ok.ts\0"), Buffer.from("src/中").subarray(0, 5), Buffer.from("ignored.ts\0")], {
		afterChunk: (count) => { if (count === 2) controller.abort(); },
	});
	await assert.rejects(createFindOperations({ target, signal: controller.signal }).glob("*.ts", root, { limit: 20 }), /aborted/);
	assert.deepEqual(mock.kills, ["SIGTERM"]);
	assert.equal(mock.emitted, 2);
});

test("find propagates nonzero exit before the match limit", async (t) => {
	mockStdout(t, byteChunks("src/中文.ts\0"), { code: 7 });
	await assert.rejects(createFindOperations({ target }).glob("*.ts", root, { limit: 20 }), /ssh exited with code 7/);
});
