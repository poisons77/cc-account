import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { readJsonOr, writeJsonAtomic } from './jsonFile.js';

const FALLBACK_INIT_PARAMS = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'cc-account-starter', version: '1' },
};

const STOP_GRACE_MS = 3000;

// Ids the real server answers to us; strings, so they never clash with a client's.
const INTERNAL_INIT = 'starter-init';
const INTERNAL_TOOLS = 'starter-tools';

/** Spawner for Claude Code's own Chrome tool server. */
export function chromeServer(env) {
  return () =>
    spawn('claude', ['--claude-in-chrome-mcp'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env,
      windowsHide: true,
      // The npm install is a claude.cmd shim, which only a shell can run. The args are literals.
      shell: process.platform === 'win32',
    });
}

/** Calls `onLine` for every newline-terminated line of `stream`, tolerating `\r\n` and split chunks. */
function readLines(stream, onLine, onEnd = () => {}) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const feed = (text) => {
    buffer += text;
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      if (line !== '') onLine(line);
    }
  };
  stream.on('data', (chunk) => feed(typeof chunk === 'string' ? chunk : decoder.write(chunk)));
  stream.on('end', () => {
    feed(decoder.end());
    const rest = buffer.replace(/\r$/, '');
    buffer = '';
    if (rest !== '') onLine(rest);
    onEnd();
  });
}

function parse(line) {
  try {
    const value = JSON.parse(line);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

const isResponse = (msg) => msg !== null && 'id' in msg && !('method' in msg);

/**
 * Answers the MCP handshake from a cache and starts the real server only when a message needs it,
 * so an idle session holds this small process instead of the server's full footprint.
 */
export function runChromeStarter({ input, output, startServer, cacheFile }) {
  return new Promise((resolve) => {
    const cache = readJsonOr(cacheFile, null);
    const cachedInit = cache?.initialize ?? null;
    const cachedTools = Array.isArray(cache?.tools) ? cache.tools : null;

    let initParams;
    let server = null;
    let live = false;
    let done = false;
    let inputEnded = false;
    const queue = [];
    const internal = new Map();

    const finish = (code) => {
      if (done) return;
      done = true;
      resolve(code);
    };
    const toClient = (value) => output.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
    const toServer = (value) => server.stdin.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
    const reply = (id, result) => toClient({ jsonrpc: '2.0', id, result });

    function goLive() {
      live = true;
      for (const line of queue.splice(0)) toServer(line);
    }

    // Handshake with the fresh server; `clientInit` is the client's own initialize when no cache existed.
    function handshake(clientInit) {
      let initResult;
      const onInit = (msg) => {
        initResult = msg.result;
        if (clientInit) toClient(msg);
        if (!initResult) return goLive();
        toServer({ jsonrpc: '2.0', method: 'notifications/initialized' });
        internal.set(INTERNAL_TOOLS, onTools);
        toServer({ jsonrpc: '2.0', id: INTERNAL_TOOLS, method: 'tools/list' });
      };
      const onTools = (msg) => {
        if (msg.result && Array.isArray(msg.result.tools)) {
          writeJsonAtomic(cacheFile, { initialize: initResult, tools: msg.result.tools });
        }
        goLive();
      };
      if (clientInit) {
        internal.set(clientInit.id, onInit);
        toServer(clientInit);
      } else {
        internal.set(INTERNAL_INIT, onInit);
        toServer({ jsonrpc: '2.0', id: INTERNAL_INIT, method: 'initialize', params: initParams ?? FALLBACK_INIT_PARAMS });
      }
    }

    function start(clientInit) {
      server = startServer();
      server.stdin.on?.('error', () => {});
      server.on('exit', (code) => finish(inputEnded ? 0 : (code ?? 1)));
      readLines(server.stdout, (line) => {
        const msg = parse(line);
        const handler = isResponse(msg) ? internal.get(msg.id) : undefined;
        if (handler) {
          internal.delete(msg.id);
          handler(msg);
        } else {
          toClient(line);
        }
      });
      handshake(clientInit);
    }

    function fromClient(line) {
      if (done) return;
      const msg = parse(line);
      const method = msg?.method;
      // The starter sends the server its own initialized, so the client's is never relayed.
      if (method === 'notifications/initialized') return;
      if (live) return toServer(line);
      if (server) return void queue.push(line);

      const hasId = msg !== null && 'id' in msg;
      if (method === 'initialize' && hasId) {
        initParams = msg.params;
        if (cachedInit) return reply(msg.id, cachedInit);
        return start(msg);
      }
      if (method === 'ping' && hasId) return reply(msg.id, {});
      // Newer clients ask this before initialize. A server without it answers "method not found",
      // and the client goes on with initialize, which the cache answers.
      if (method === 'server/discover' && hasId) {
        return toClient({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
      }
      if (method === 'logging/setLevel' && hasId && cachedInit) return reply(msg.id, {});
      if (method === 'tools/list' && hasId && cachedTools) return reply(msg.id, { tools: cachedTools });
      if (msg === null) return; // nothing to deliver to: no server yet
      queue.push(line);
      start(null);
    }

    readLines(input, fromClient, () => {
      if (!server) return finish(0);
      // Closing its input is how a stdio server is told to stop. On Windows the server runs
      // under cmd, and a kill reaches only cmd, so the kill is the fallback for one that hangs.
      // Done only once it has stopped, so a caller that exits then leaves nothing running.
      inputEnded = true;
      server.stdin.end();
      const fallback = setTimeout(() => server.kill(), STOP_GRACE_MS);
      server.on('exit', () => clearTimeout(fallback));
    });
  });
}
