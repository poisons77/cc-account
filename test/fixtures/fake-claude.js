// Stands in for the real `claude` CLI. Reports whoever the sandbox credential
// blob currently names, so a swap changes the answer exactly as it does live.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const [command, subcommand] = args;
const configDir = process.env.CLAUDE_CONFIG_DIR;
const credentialsFile = path.join(configDir, '.credentials.json');

if (command === 'auth' && subcommand === 'login') {
  // The browser round trip, faked: hand BROWSER the sign-in URL, then sign in whichever account
  // the "browser" holds - FAKE_BROWSER_ACCOUNT when set, the hinted email otherwise. An empty
  // FAKE_BROWSER_ACCOUNT is a sign-in the user abandoned.
  const hint = args[args.indexOf('--email') + 1];
  const url = `https://claude.example/oauth/authorize?code=true&login_hint=${encodeURIComponent(hint)}`;
  if (process.env.BROWSER) {
    spawnSync(`"${process.env.BROWSER}" "${url}"`, { shell: true, stdio: 'ignore' });
  }

  const email = process.env.FAKE_BROWSER_ACCOUNT ?? hint;
  if (!email) process.exit(1);

  const expiry = Number(process.env.FAKE_RENEWED_EXPIRY) || Date.now() + 30 * 24 * 60 * 60 * 1000;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    credentialsFile,
    JSON.stringify({
      email,
      plan: 'max',
      refreshToken: `renewed-for-${email}`,
      claudeAiOauth: { refreshTokenExpiresAt: expiry },
    }),
  );
  fs.writeFileSync(
    path.join(configDir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: `uuid-${email}` } }),
  );
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
