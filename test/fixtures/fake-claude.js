// Stands in for the real `claude` CLI. Reports whoever the sandbox credential
// blob currently names, so a swap changes the answer exactly as it does live.
import fs from 'node:fs';
import path from 'node:path';

const [command, subcommand] = process.argv.slice(2);
if (command !== 'auth' || subcommand !== 'status') {
  process.stderr.write(`fake-claude: unsupported command '${process.argv.slice(2).join(' ')}'\n`);
  process.exit(1);
}

const credentialsFile = path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json');

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
