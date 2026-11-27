// Stands in for the real `claude` CLI. Reports whoever the sandbox credential
// blob currently names, so a swap changes the answer exactly as it does live.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const [command, subcommand] = args;
const configDir = process.env.CLAUDE_CONFIG_DIR;
const credentialsFile = path.join(configDir, '.credentials.json');
const configJson = path.join(configDir, '.claude.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

if (command === 'auth' && subcommand === 'login') {
  // The browser round trip, faked: hand BROWSER the sign-in URL, then sign in whichever account
  // the "browser" holds - FAKE_BROWSER_ACCOUNT when set, the hinted email otherwise. An empty
  // FAKE_BROWSER_ACCOUNT is a sign-in the user abandoned.
  const hint = args.includes('--email') ? args[args.indexOf('--email') + 1] : undefined;
  const url =
    'https://claude.example/oauth/authorize?code=true' +
    (hint ? `&login_hint=${encodeURIComponent(hint)}` : '');
  if (process.env.BROWSER) {
    spawnSync(`"${process.env.BROWSER}" "${url}"`, { shell: true, stdio: 'ignore' });
  }

  const email = process.env.FAKE_BROWSER_ACCOUNT ?? hint;
  if (!email) process.exit(1);

  const expiry = Number(process.env.FAKE_RENEWED_EXPIRY) || Date.now() + 30 * 24 * 60 * 60 * 1000;
  fs.mkdirSync(configDir, { recursive: true });
  // As the real one does, a login replaces the claude.ai login and keeps the rest of both files:
  // the MCP servers' own logins and the server list.
  fs.writeFileSync(
    credentialsFile,
    JSON.stringify({
      ...readJson(credentialsFile),
      email,
      plan: 'max',
      refreshToken: `renewed-for-${email}`,
      claudeAiOauth: {
        refreshTokenExpiresAt: expiry,
        accessToken: `access-for-${email}-${Date.now()}`,
        expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      },
    }),
  );
  fs.writeFileSync(
    configJson,
    JSON.stringify({
      ...readJson(configJson),
      oauthAccount: { emailAddress: email, accountUuid: `uuid-${email}` },
    }),
  );
  process.exit(0);
}

if (command === 'mcp' && (subcommand === 'get' || subcommand === 'list')) {
  // Connecting servers renews whatever has expired, as the real one does: the claude.ai login and
  // each server's own login get new tokens. FAKE_RENEW_LOG counts renewals, one line each,
  // FAKE_RENEW_MS stretches one so two can overlap, and FAKE_LINGER_MS keeps it running after the
  // tokens are saved, as the real one does while it connects the servers.
  const started = Date.now();
  const blob = readJson(credentialsFile);
  const stamp = `${process.pid}-${started}`;
  if (blob.claudeAiOauth) {
    blob.claudeAiOauth = { ...blob.claudeAiOauth, accessToken: `renewed-${stamp}`, expiresAt: started + 8 * 3600_000 };
  }
  for (const key of Object.keys(blob.mcpOAuth ?? {})) {
    blob.mcpOAuth[key] = { ...blob.mcpOAuth[key], accessToken: `renewed-${stamp}`, expiresAt: started + 3600_000 };
  }
  const delay = Number(process.env.FAKE_RENEW_MS) || 0;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  fs.writeFileSync(credentialsFile, JSON.stringify(blob));
  if (process.env.FAKE_RENEW_LOG) fs.appendFileSync(process.env.FAKE_RENEW_LOG, `${args.slice(1).join(' ')}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_LINGER_MS) || 0);
  process.exit(0);
}

if (command === 'mcp' && ['add-json', 'add', 'remove', 'login'].includes(subcommand)) {
  // The user-scope server list lives in .claude.json, as the real one keeps it; `login` stands in
  // for the browser sign-in to a server, leaving that server's own token beside the claude.ai one.
  const positional = [];
  for (let i = 2; i < args.length; i += 1) {
    if (['--scope', '-s', '--transport', '-t'].includes(args[i])) i += 1;
    else positional.push(args[i]);
  }
  const config = readJson(configJson);
  const servers = config.mcpServers ?? {};
  const [server, value] = positional;
  if (subcommand === 'add-json') servers[server] = JSON.parse(value);
  if (subcommand === 'add') servers[server] = { type: 'http', url: value };
  if (subcommand === 'remove') {
    if (!servers[server]) process.exit(1);
    delete servers[server];
  }
  if (subcommand === 'login') {
    const blob = readJson(credentialsFile);
    blob.mcpOAuth = { ...blob.mcpOAuth, [`${server}|fake`]: { accessToken: `login-${server}`, expiresAt: Date.now() + 3600_000 } };
    fs.writeFileSync(credentialsFile, JSON.stringify(blob));
  }
  fs.writeFileSync(configJson, JSON.stringify({ ...config, mcpServers: servers }));
  process.exit(0);
}

if (command !== 'auth' || subcommand !== 'status') {
  process.stderr.write(`fake-claude: unsupported command '${args.join(' ')}'\n`);
  process.exit(1);
}

let payload = { loggedIn: false };
try {
  const blob = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
  payload = {
    loggedIn: true,
    email: blob.email,
    authMethod: blob.authMethod ?? 'claudeai',
    apiProvider: 'anthropic',
    subscriptionType: blob.plan ?? 'max',
    orgName: null,
  };
} catch {
  /* logged out */
}

process.stdout.write(`${JSON.stringify(payload)}\n`);
