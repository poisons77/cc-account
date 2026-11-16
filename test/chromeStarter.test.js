import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runChromeStarter } from '../src/chromeStarter.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-mcp-server.js', import.meta.url));
const CLIENT_PARAMS = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } };

let dir;
let cacheFile;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-account-chrome-'));
  cacheFile = path.join(dir, 'chrome-cache.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const STALE_CACHE = {
  initialize: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cached', version: '0' } },
  tools: [{ name: 'old_tool', inputSchema: { type: 'object' } }],
};

/** A starter wired to PassThrough streams and the fixture server; `lines` collects what the client sees. */
function harness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  const waiting = [];
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      lines.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
    }
    for (const check of waiting.splice(0)) check();
  });

  const h = {
    lines,
    starts: 0,
    child: null,
    send: (message) => input.write(`${JSON.stringify(message)}\n`),
    end: () => input.end(),
    // Resolves when `predicate` matches a message the client has received.
    next: (predicate) =>
      new Promise((resolve) => {
        const check = () => {
          const found = lines.find(predicate);
          if (found) resolve(found);
          else waiting.push(check);
        };
        check();
      }),
  };
  h.done = runChromeStarter({
    input,
    output,
    cacheFile,
    startServer: () => {
      h.starts += 1;
      h.child = spawn(process.execPath, [FIXTURE], { stdio: ['pipe', 'pipe', 'inherit'] });
      return h.child;
    },
  });
  return h;
}

const initialize = (id = 1) => ({ jsonrpc: '2.0', id, method: 'initialize', params: CLIENT_PARAMS });
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const call = (id, name) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });

test('with a cache the handshake is answered without starting the server', async () => {
  fs.writeFileSync(cacheFile, JSON.stringify(STALE_CACHE));
  const h = harness();

  // As Claude Code opens a session (logged live, 16/11/2026): discover, then the classic handshake.
  h.send({ jsonrpc: '2.0', id: 0, method: 'server/discover' });
  h.send(initialize(1));
  h.send(initialized);
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  h.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  h.send({ jsonrpc: '2.0', id: 4, method: 'logging/setLevel', params: { level: 'info' } });
  await h.next((m) => m.id === 4);

  assert.equal(h.lines.find((m) => m.id === 0).error.code, -32601);
  assert.deepEqual(h.lines.find((m) => m.id === 1).result, STALE_CACHE.initialize);
  assert.deepEqual(h.lines.find((m) => m.id === 2).result, { tools: STALE_CACHE.tools });
  assert.deepEqual(h.lines.find((m) => m.id === 3).result, {});
  assert.deepEqual(h.lines.find((m) => m.id === 4).result, {});
  assert.equal(h.starts, 0);

  h.end();
  assert.equal(await h.done, 0);
});

test('the first tool call starts the server once and refreshes the cache', async () => {
  fs.writeFileSync(cacheFile, JSON.stringify(STALE_CACHE));
  const h = harness();

  h.send(initialize(1));
  h.send(initialized);
  h.send(call(7, 'navigate'));
  const result = await h.next((m) => m.id === 7);
  h.send(call(8, 'read_page'));
  await h.next((m) => m.id === 8);

  assert.deepEqual(result.result, { content: [{ type: 'text', text: 'called navigate' }] });
  assert.equal(h.starts, 1);
  // Only the client's own ids come back: initialize, the cached answer, and the two calls.
  assert.deepEqual(h.lines.map((m) => m.id), [1, 7, 8]);
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.deepEqual(cache.tools.map((t) => t.name), ['navigate', 'read_page']);
  assert.equal(cache.initialize.serverInfo.name, 'fake-chrome');

  h.end();
  assert.equal(await h.done, 0);
});

test('without a cache the server starts at initialize and answers it', async () => {
  const h = harness();

  h.send(initialize(41));
  const init = await h.next((m) => m.id === 41);
  h.send(initialized);
  h.send({ jsonrpc: '2.0', id: 42, method: 'tools/list' });
  const tools = await h.next((m) => m.id === 42);

  assert.equal(h.starts, 1);
  assert.equal(init.result.serverInfo.name, 'fake-chrome');
  assert.deepEqual(tools.result.tools.map((t) => t.name), ['navigate', 'read_page']);
  assert.deepEqual(h.lines.map((m) => m.id), [41, 42]);
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(cache.initialize.serverInfo.name, 'fake-chrome');
  assert.equal(cache.tools.length, 2);

  h.end();
  assert.equal(await h.done, 0);
});

test('a server notification reaches the client before the result', async () => {
  fs.writeFileSync(cacheFile, JSON.stringify(STALE_CACHE));
  const h = harness();

  h.send(initialize(1));
  h.send(initialized);
  h.send(call(5, 'notify'));
  await h.next((m) => m.id === 5);

  const methods = h.lines.map((m) => m.method ?? m.id);
  assert.deepEqual(methods, [1, 'notifications/tools/list_changed', 5]);

  h.end();
  await h.done;
});

test('input ending closes the server\'s input, which stops it, and resolves 0', async () => {
  const h = harness();
  h.send(initialize(1));
  await h.next((m) => m.id === 1);
  const exited = new Promise((resolve) => h.child.on('exit', resolve));

  h.end();

  assert.equal(await h.done, 0);
  await exited;
  // Stopped by its closed input, not by the kill kept for a server that hangs.
  assert.equal(h.child.killed, false);
});

test('the server exiting resolves with its exit code', async () => {
  const h = harness();
  h.send(initialize(1));
  await h.next((m) => m.id === 1);

  h.child.kill('SIGKILL');
  const code = await h.done;

  // A killed process reports a null code (signal), which the starter turns into 1.
  assert.equal(code, 1);
});

test('lines split across chunks and CRLF endings are reassembled', async () => {
  fs.writeFileSync(cacheFile, JSON.stringify(STALE_CACHE));
  const input = new PassThrough();
  const output = new PassThrough();
  const done = runChromeStarter({ input, output, cacheFile, startServer: () => assert.fail('no server expected') });
  const text = `${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' })}\r\n`;

  input.write('this is not json\n');
  input.write(text.slice(0, 10));
  input.write(text.slice(10));
  input.end();

  assert.equal(await done, 0);
  const answers = String(output.read()).trim().split('\n');
  assert.deepEqual(answers.map((l) => JSON.parse(l).id), [9]);
});
