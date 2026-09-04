import os from 'node:os';
import path from 'node:path';

/**
 * Claude Code keeps identity in two places, and CLAUDE_CONFIG_DIR moves both.
 * With the override set, .claude.json sits inside that directory; without it,
 * the file lives at the home root while the rest lives in ~/.claude.
 */
export function resolvePaths(env = process.env, home = os.homedir()) {
  const override = env.CLAUDE_CONFIG_DIR;
  const configDir = override ? path.resolve(override) : path.join(home, '.claude');
  const configJson = override
    ? path.join(configDir, '.claude.json')
    : path.join(home, '.claude.json');

  return {
    configDir,
    configJson,
    credentialsFile: path.join(configDir, '.credentials.json'),
    store: env.CC_ACCOUNT_HOME ?? path.join(home, '.claude-accounts'),
    // Regenerable caches. A stale one reports the previous account.
    authCaches: [
      path.join(configDir, 'daemon-auth-status.json'),
      path.join(configDir, 'daemon-auth-cooldown'),
    ],
  };
}
