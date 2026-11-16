import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { removeAccount, runClaude, saveAccount } from '../src/accounts.js';
import { attachConnector, detachAll, detachConnector, listConnectors } from '../src/connectors.js';
import { laneDir, laneHeaders, lanePaths } from '../src/lanes.js';
import { confinedTo } from '../src/paths.js';
import { login, readJson, sandbox } from './helpers.js';

/** A lane signs in through `claude auth login`, which the sandbox fakes only off macOS. */
const needsLane = { skip: process.platform === 'darwin' && 'a lane is refused on macOS, as renew is' };

const LISTED = [
  { id: 'mcpsrv_gmail', display_name: 'Gmail' },
  { id: 'mcpsrv_drive', display_name: 'Google Drive' },
  { id: 'mcpsrv_docs', display_name: 'Google Docs' },
];

let box;
let paths;
let api;
let requests;

beforeEach(async () => {
  box = sandbox();
  paths = box.paths;
  // An npm-installed cc-account on PATH, which attached connectors call by name.
  fs.writeFileSync(path.join(box.root, 'bin', process.platform === 'win32' ? 'cc-account.cmd' : 'cc-account'), '');
  requests = [];
  api = http.createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: LISTED }));
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  paths.apiBase = `http://127.0.0.1:${api.address().port}`;

  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  // A server added in Claude Code, which a lane can sign in to as well.
  const config = readJson(paths.configJson);
  fs.writeFileSync(paths.configJson, JSON.stringify({ ...config, mcpServers: { goematic: { type: 'http', url: 'https://mcp.goematic.example/mcp' } } }));
});

afterEach(async () => {
  await new Promise((resolve) => api.close(resolve));
  box.restore();
});

const servers = () => readJson(paths.configJson).mcpServers;

test('without a lane, an account lends Chrome and the servers added in Claude Code, and asks Anthropic nothing', async () => {
  const { lane, connectors } = await listConnectors(paths, 'work');

  assert.equal(lane, null);
  assert.deepEqual(connectors.map((c) => [c.slug, c.kind, c.attached]), [
    ['chrome', 'chrome', false],
    ['goematic', 'server', false],
  ]);
  assert.equal(connectors[1].needsLogin, true);
  assert.deepEqual(requests, []);
});

test('attaching a claude.ai connector signs the lane in, then registers it through the proxy', needsLane, async () => {
  const result = await attachConnector(paths, 'work', 'gmail');

  assert.equal(result.attached, true);
  assert.equal(result.signedIn.email, 'work@example.com');
  assert.deepEqual(servers()['gmail-work'], {
    type: 'http',
    url: 'https://mcp-proxy.anthropic.com/v1/mcp/mcpsrv_gmail',
    headersHelper: 'cc-account header work',
  });
  // The one request: the list, with the lane's token and the headers Anthropic requires.
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/mcp_servers?limit=1000');
  assert.equal(requests[0].headers['anthropic-beta'], 'mcp-servers-2025-12-04');
  assert.equal(requests[0].headers.authorization, laneHeaders(paths, 'work').Authorization);

  const listed = await listConnectors(paths, 'work');
  assert.equal(listed.connectors.find((c) => c.slug === 'gmail').attached, true);
  assert.equal(requests.length, 1, 'a later list reads the cache');
});

test('an account whose list cannot be fetched still lists what it can, unless a refresh was asked for', needsLane, async () => {
  await attachConnector(paths, 'work', 'chrome');
  fs.rmSync(path.join(paths.store, 'work', 'connectors.json'));
  paths.apiBase = 'http://127.0.0.1:9';

  const listed = await listConnectors(paths, 'work');

  assert.match(listed.listError, /fetch failed|ECONNREFUSED|did not list/);
  assert.deepEqual(listed.connectors.map((c) => c.slug), ['chrome', 'goematic']);
  await assert.rejects(listConnectors(paths, 'work', { refresh: true }));
});

test('a server the account also has on claude.ai is offered once, from claude.ai', needsLane, async () => {
  LISTED.push({ id: 'mcpsrv_goematic', display_name: 'Goematic' });
  try {
    await attachConnector(paths, 'work', 'goematic');

    assert.equal(servers()['goematic-work'].url, 'https://mcp-proxy.anthropic.com/v1/mcp/mcpsrv_goematic');
    const listed = await listConnectors(paths, 'work');
    assert.deepEqual(listed.connectors.filter((c) => c.slug === 'goematic').map((c) => c.kind), ['claude-ai']);
  } finally {
    LISTED.pop();
  }
});

test('a connector is named by a part of its name only it has', needsLane, async () => {
  await attachConnector(paths, 'work', 'drive');
  assert.equal(servers()['google-drive-work'].url, 'https://mcp-proxy.anthropic.com/v1/mcp/mcpsrv_drive');

  await assert.rejects(attachConnector(paths, 'work', 'google'), /google could be google-drive or google-docs\. Name one of them\./);
  await assert.rejects(attachConnector(paths, 'work', 'calendar'), /'work' has no connector called calendar\. It has: chrome, gmail, google-drive, google-docs, goematic/);
});

test('a server added in Claude Code is attached only once the lane has its own sign-in to it', needsLane, async () => {
  const first = await attachConnector(paths, 'work', 'goematic');

  assert.equal(first.attached, false);
  // Confined and signed in in one line, so it can never run against the live config.
  assert.match(first.login[0], /CLAUDE_CONFIG_DIR.*claude mcp login goematic/);
  assert.equal(first.login[1], 'cc-account attach work goematic');
  assert.equal(servers()['goematic-work'], undefined);
  // The lane now knows the server, so the sign-in the lines describe can find it.
  assert.equal(readJson(lanePaths(paths, 'work').configJson).mcpServers.goematic.url, 'https://mcp.goematic.example/mcp');

  runClaude(['mcp', 'login', 'goematic'], { env: confinedTo(laneDir(paths, 'work')).env, stdio: 'ignore' });
  const second = await attachConnector(paths, 'work', 'goematic');

  assert.equal(second.attached, true);
  assert.deepEqual(servers()['goematic-work'], {
    type: 'http',
    url: 'https://mcp.goematic.example/mcp',
    headersHelper: 'cc-account header work goematic',
  });
  assert.deepEqual(laneHeaders(paths, 'work', 'goematic'), { Authorization: 'Bearer login-goematic' });
});

test('Chrome is attached as the starter, run by name', needsLane, async () => {
  await attachConnector(paths, 'work', 'chrome');

  assert.deepEqual(
    servers()['chrome-work'],
    process.platform === 'win32'
      ? { type: 'stdio', command: 'cmd', args: ['/c', 'cc-account', 'chrome', 'work'] }
      : { type: 'stdio', command: 'cc-account', args: ['chrome', 'work'] },
  );
});

test('detach takes one connector out, by the same names attach takes', needsLane, async () => {
  await attachConnector(paths, 'work', 'gmail');
  await attachConnector(paths, 'work', 'drive');

  assert.equal(detachConnector(paths, 'work', 'drive'), 'google-drive-work');
  assert.deepEqual(Object.keys(servers()).sort(), ['gmail-work', 'goematic']);
  assert.throws(() => detachConnector(paths, 'work', 'drive'), /No connector called drive is attached for 'work'/);
});

test('detaching everything of an account leaves the servers it did not attach', needsLane, async () => {
  await attachConnector(paths, 'work', 'gmail');
  await attachConnector(paths, 'work', 'chrome');

  assert.deepEqual(detachAll(paths, 'work').sort(), ['chrome-work', 'gmail-work']);
  assert.deepEqual(Object.keys(servers()), ['goematic']);
});

test('removing an account takes its connectors out of every session, with its lane', needsLane, async () => {
  await attachConnector(paths, 'work', 'gmail');
  login(paths, 'personal@example.com');
  saveAccount(paths, 'personal');

  const result = removeAccount(paths, 'work');

  assert.deepEqual(result.detached, ['gmail-work']);
  assert.deepEqual(Object.keys(servers()), ['goematic']);
  assert.equal(fs.existsSync(laneDir(paths, 'work')), false);
});

test('a server of the same name that cc-account did not attach is never replaced', needsLane, async () => {
  const config = readJson(paths.configJson);
  config.mcpServers['gmail-work'] = { type: 'http', url: 'https://mine.example/mcp' };
  fs.writeFileSync(paths.configJson, JSON.stringify(config));

  await assert.rejects(attachConnector(paths, 'work', 'gmail'), /A server called gmail-work already exists in Claude Code and is not this connector/);
  assert.equal(servers()['gmail-work'].url, 'https://mine.example/mcp');
});

test('the lane\'s login to a server never reaches a new address the server moved to', needsLane, async () => {
  await attachConnector(paths, 'work', 'goematic');
  const config = readJson(paths.configJson);
  config.mcpServers.goematic.url = 'https://elsewhere.example/mcp';
  fs.writeFileSync(paths.configJson, JSON.stringify(config));

  await assert.rejects(attachConnector(paths, 'work', 'goematic'), /goematic has moved to https:\/\/elsewhere\.example\/mcp/);
});

test('the connector list is asked only of Anthropic, or of a server on this machine', needsLane, async () => {
  await attachConnector(paths, 'work', 'chrome');
  paths.apiBase = 'https://collector.example';

  await assert.rejects(listConnectors(paths, 'work', { refresh: true }), /Refusing to send a login to https:\/\/collector\.example/);
  assert.equal(requests.length, 1, 'only the first, local, list request was made');
});

test('without cc-account on PATH nothing is attached, since every connector calls it by name', needsLane, async () => {
  paths.cliOnPath = [path.join(box.root, 'nowhere', 'cc-account')];

  await assert.rejects(attachConnector(paths, 'work', 'gmail'), /none was found on PATH\. Install it with: npm install -g cc-account/);
  assert.equal(servers()['gmail-work'], undefined);
});

test('attached, renewed, detached: a connector across a token running out', needsLane, async () => {
  await attachConnector(paths, 'work', 'gmail');
  const first = laneHeaders(paths, 'work').Authorization;
  const file = lanePaths(paths, 'work').credentialsFile;
  const blob = readJson(file);
  fs.writeFileSync(file, JSON.stringify({ ...blob, claudeAiOauth: { ...blob.claudeAiOauth, expiresAt: Date.now() - 1000 } }));

  const renewed = laneHeaders(paths, 'work').Authorization;

  assert.notEqual(renewed, first);
  assert.equal(laneHeaders(paths, 'work').Authorization, renewed, 'the renewed token is handed out again');
  assert.deepEqual(detachAll(paths, 'work'), ['gmail-work']);
});
