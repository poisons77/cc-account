import fs from 'node:fs';
import path from 'node:path';

import { accountDir, requireSnapshot, runClaude } from './accounts.js';
import { accessToken } from './credentials.js';
import { readJsonOr, writeJsonAtomic } from './jsonFile.js';
import { ensureLane, laneBlob, laneDir, laneHeaders, lanePaths, laneStatus, refuseUnsafeName } from './lanes.js';
import { confinedTo } from './paths.js';

/**
 * A connector of a saved account, attached to every session whichever account is live, under the
 * name `<connector>-<account>`. Three kinds:
 *
 * - `chrome`: Claude in Chrome through the account's lane, started by `cc-account chrome <account>`.
 * - `claude-ai`: a connector added on claude.ai, served by Anthropic's proxy to the lane's token.
 * - `server`: an HTTP server added in Claude Code (goematic), with the lane's own login to it.
 *
 * Claude Code's own `claude mcp add-json` / `remove` write the user-scope server list; cc-account
 * reads it back to know what is attached, and keeps no list of its own.
 */

const PROXY = 'https://mcp-proxy.anthropic.com/v1/mcp';
// The list request is the one network request cc-account makes: only when connectors are listed
// afresh or attached, never while a session works.
const LIST_PATH = '/v1/mcp_servers?limit=1000';
const LIST_HEADERS = { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'mcp-servers-2025-12-04' };
const CHROME = { slug: 'chrome', label: 'Claude in Chrome', kind: 'chrome' };

/** `Google Drive` -> `google-drive`: lower case, anything else between words a single dash. */
const slugOf = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The server name a connector of `name` is attached under. Claude Code allows letters, digits, `-`, `_`. */
export const serverName = (slug, name) => `${slug}-${name.replace(/[^A-Za-z0-9_-]/g, '_')}`;

const cacheFile = (paths, name) => path.join(accountDir(paths, name), 'connectors.json');

const userServers = (paths) => readJsonOr(paths.configJson, {})?.mcpServers ?? {};

/** The account an entry was attached for by cc-account, or null for anyone else's entry. */
function attachedFor(entry) {
  const helper = /^cc-account header (\S+)/.exec(entry?.headersHelper ?? '');
  if (helper) return helper[1];
  const args = entry?.args ?? [];
  const at = args.indexOf('chrome');
  return at >= 0 && args.includes('cc-account') ? (args[at + 1] ?? null) : null;
}

/**
 * Where the list may be asked: Anthropic, or a test server on this machine. The request carries the
 * lane's claude.ai token, which no other host may ever receive.
 */
function listUrl(paths) {
  const url = new URL(`${paths.apiBase}${LIST_PATH}`);
  const anthropic = url.origin === 'https://api.anthropic.com';
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!anthropic && !loopback) throw new Error(`Refusing to send a login to ${url.origin}: only Anthropic lists connectors.`);
  return url;
}

/** The claude.ai connectors of the account, asked of Anthropic with the lane's token, and cached. */
async function fetchClaudeConnectors(paths, name) {
  const url = listUrl(paths);
  const { Authorization } = laneHeaders(paths, name);
  const response = await fetch(url, { headers: { ...LIST_HEADERS, Authorization } });
  if (!response.ok) {
    throw new Error(`Anthropic did not list the connectors of '${name}' (HTTP ${response.status}).`);
  }
  const listed = (await response.json())?.data ?? [];
  const servers = listed
    .filter((server) => typeof server?.id === 'string' && typeof server?.display_name === 'string')
    .map((server) => ({ id: server.id, label: server.display_name }));
  writeJsonAtomic(cacheFile(paths, name), { fetchedAt: new Date().toISOString(), servers });
  return servers;
}

/** Servers added in Claude Code with a URL, which a lane can sign in to as well; not cc-account's own. */
function addedServers(paths) {
  return Object.entries(userServers(paths))
    .filter(([, entry]) => entry?.type === 'http' && typeof entry.url === 'string' && attachedFor(entry) === null)
    .map(([server, entry]) => ({ server, url: entry.url }));
}

/**
 * Every connector account `name` can lend: Chrome, its claude.ai connectors (from the cache, asked
 * afresh with `refresh` or when there is none yet and the lane can ask), and the servers added in
 * Claude Code. Each says whether it is attached and, for an added server, whether the lane still
 * needs its own sign-in to it.
 */
export async function listConnectors(paths, name, { refresh = false } = {}) {
  requireSnapshot(paths, name);
  const lane = laneStatus(paths, name);
  const cached = readJsonOr(cacheFile(paths, name), null)?.servers;
  let claudeAi = cached ?? [];
  let listError = null;
  if (lane && (refresh || !cached)) {
    try {
      claudeAi = await fetchClaudeConnectors(paths, name);
    } catch (error) {
      // Asked for: the person wants to know. Otherwise one account offline must not empty the list.
      if (refresh) throw error;
      listError = error.message;
    }
  }
  const blob = laneBlob(paths, name);
  const attached = userServers(paths);

  const fromClaudeAi = claudeAi.map(({ id, label }) => ({ slug: slugOf(label), label, kind: 'claude-ai', id }));
  // A server the account also has on claude.ai is offered once, from claude.ai: that one needs no
  // sign-in of its own.
  const onClaudeAi = new Set(fromClaudeAi.map((connector) => connector.slug));
  const connectors = [
    CHROME,
    ...fromClaudeAi,
    ...addedServers(paths).filter(({ server }) => !onClaudeAi.has(slugOf(server))).map(({ server, url }) => ({
      slug: slugOf(server),
      label: server,
      kind: 'server',
      server,
      url,
      needsLogin: accessToken(blob, server) === null,
    })),
  ];
  return {
    name,
    lane,
    listError,
    connectors: connectors.map((connector) => {
      const entry = attached[serverName(connector.slug, name)];
      return { ...connector, attachedAs: serverName(connector.slug, name), attached: attachedFor(entry) === name };
    }),
  };
}

/** The connector `wanted` names: its slug, its label, or a part of its slug only it has. */
function pick(connectors, wanted) {
  const key = wanted.toLowerCase();
  const exact = connectors.find((connector) => connector.slug === key || connector.label.toLowerCase() === key);
  if (exact) return exact;
  const partial = connectors.filter((connector) => connector.slug.includes(key));
  return partial.length === 1 ? partial[0] : partial.length > 1 ? partial : null;
}

/**
 * Register `entry` for account `name` in Claude Code's user-scope server list as `server`, replacing
 * an earlier one of cc-account's for that account and refusing any other server of that name.
 */
function register(paths, name, server, entry) {
  const existing = userServers(paths)[server];
  if (existing && attachedFor(existing) !== name) {
    throw new Error(`A server called ${server} already exists in Claude Code and is not this connector. Nothing was changed.`);
  }
  if (existing) unregister(server);
  const { status, stderr } = runClaude(['mcp', 'add-json', '--scope', 'user', server, JSON.stringify(entry)], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (status !== 0) throw new Error(`Claude Code did not add ${server}: ${(stderr ?? '').trim() || `exit ${status}`}`);
}

/** The entry a session runs the connector from. */
function entryFor(connector, name) {
  if (connector.kind === 'chrome') {
    // cmd resolves the npm `cc-account.cmd` shim on Windows; a direct spawn cannot run it.
    return process.platform === 'win32'
      ? { type: 'stdio', command: 'cmd', args: ['/c', 'cc-account', 'chrome', name] }
      : { type: 'stdio', command: 'cc-account', args: ['chrome', name] };
  }
  if (connector.kind === 'claude-ai') {
    return { type: 'http', url: `${PROXY}/${connector.id}`, headersHelper: `cc-account header ${name}` };
  }
  return { type: 'http', url: connector.url, headersHelper: `cc-account header ${name} ${connector.server}` };
}

/**
 * Give every session connector `wanted` of account `name`. Signs the lane in first when there is
 * none. For a server added in Claude Code the lane needs its own sign-in to it, which only a
 * terminal can do: with `interactive` it runs there, otherwise the result carries the two lines to
 * run in one and nothing is attached yet.
 */
export async function attachConnector(paths, name, wanted, { onLogin, interactive = false } = {}) {
  refuseUnsafeName(name);
  requireSnapshot(paths, name);
  if (!paths.cliOnPath.some((file) => fs.existsSync(file))) {
    throw new Error(
      'Attached connectors call cc-account by name, and none was found on PATH. ' +
        'Install it with: npm install -g cc-account',
    );
  }
  const signedIn = laneStatus(paths, name) ? null : ensureLane(paths, name, { onLogin });

  let found = pick((await listConnectors(paths, name)).connectors, wanted);
  if (!found || Array.isArray(found)) {
    const fresh = (await listConnectors(paths, name, { refresh: true })).connectors;
    found = pick(fresh, wanted);
    if (!found) {
      throw new Error(`'${name}' has no connector called ${wanted}. It has: ${fresh.map((c) => c.slug).join(', ')}`);
    }
    if (Array.isArray(found)) {
      throw new Error(`${wanted} could be ${found.map((c) => c.slug).join(' or ')}. Name one of them.`);
    }
  }

  if (found.kind === 'server') {
    const login = laneServerLogin(paths, name, found, { interactive });
    if (login) return { name, connector: found, signedIn, attached: false, login };
  }

  register(paths, name, found.attachedAs, entryFor(found, name));
  return { name, connector: found, signedIn, attached: true };
}

/**
 * Make sure the lane knows `connector` and is signed in to it. Returns null when it is, or, when a
 * sign-in is still due and no terminal can take it, the lines to run in one.
 */
function laneServerLogin(paths, name, connector, { interactive }) {
  const env = confinedTo(laneDir(paths, name)).env;
  const known = readJsonOr(lanePaths(paths, name).configJson, {})?.mcpServers?.[connector.server];
  // The lane's login belongs to the address it signed in at; it must not reach another one.
  if (known && known.url !== connector.url) {
    throw new Error(
      `${connector.server} has moved to ${connector.url}, but the lane of '${name}' signed in at ` +
        `${known.url}. Nothing was changed. Remove it from the lane, then attach again: ` +
        `${laneCommand(paths, name, `claude mcp remove --scope user ${connector.server}`)}`,
    );
  }
  if (!known) {
    runClaude(['mcp', 'add', '--transport', 'http', '--scope', 'user', connector.server, connector.url], {
      stdio: 'ignore',
      env,
    });
  }
  if (accessToken(laneBlob(paths, name), connector.server)) return null;
  if (interactive) {
    runClaude(['mcp', 'login', connector.server], { stdio: 'inherit', env });
    if (accessToken(laneBlob(paths, name), connector.server)) return null;
  }
  return [laneCommand(paths, name, `claude mcp login ${connector.server}`), `cc-account attach ${name} ${connector.slug}`];
}

/**
 * `command` confined to the lane of `name`, written for this platform's terminal: on Windows a
 * PowerShell line, elsewhere one for sh. Confined in one line, so it can never run on the live config.
 */
function laneCommand(paths, name, command) {
  const dir = laneDir(paths, name);
  return process.platform === 'win32'
    ? `$env:CLAUDE_CONFIG_DIR = "${dir}"; ${command}; Remove-Item Env:CLAUDE_CONFIG_DIR`
    : `CLAUDE_CONFIG_DIR="${dir}" ${command}`;
}

/** The server names of every connector attached for account `name`. */
const attachedServers = (paths, name) =>
  Object.entries(userServers(paths))
    .filter(([, entry]) => attachedFor(entry) === name)
    .map(([server]) => server);

const unregister = (server) => runClaude(['mcp', 'remove', '--scope', 'user', server], { stdio: 'ignore' });

/**
 * Take connector `wanted` of account `name` out of every session, named as `attach` takes it; the
 * server name removed.
 */
export function detachConnector(paths, name, wanted) {
  const suffix = serverName('', name);
  const attached = attachedServers(paths, name).map((server) => {
    const slug = server.slice(0, -suffix.length);
    return { slug, label: slug, server };
  });
  const found = pick(attached, wanted);
  if (!found) throw new Error(`No connector called ${wanted} is attached for '${name}'.`);
  if (Array.isArray(found)) throw new Error(`${wanted} could be ${found.map((c) => c.slug).join(' or ')}. Name one of them.`);
  unregister(found.server);
  return found.server;
}

/** Take every connector of account `name` out of every session; the server names removed. */
export function detachAll(paths, name) {
  const servers = attachedServers(paths, name);
  for (const server of servers) unregister(server);
  return servers;
}

/** Whether Claude Code's own Claude in Chrome is on, which a session would see beside chrome-<account>. */
export const builtInChromeOn = (paths) => readJsonOr(paths.configJson, {})?.claudeInChromeDefaultEnabled === true;
