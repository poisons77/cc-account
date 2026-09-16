import os from 'node:os';
import path from 'node:path';

/**
 * Claude Code keeps identity in two places, and CLAUDE_CONFIG_DIR moves both.
 * With the override set, .claude.json sits inside that directory; without it,
 * the file lives at the home root while the rest lives in ~/.claude.
 */
export function resolvePaths(
  env = process.env,
  home = os.homedir(),
  tmp = os.tmpdir(),
  platform = process.platform,
) {
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
    // Prefix for the throwaway config dir `renew` logs in through. Outside the store, so a renew
    // that dies halfway never shows up as an account.
    loginScratch: path.join(tmp, 'cc-account-login-'),
    privateBrowsers: privateBrowsers(env, platform),
  };
}

const PRIVATE_FLAGS = { chrome: '--incognito', edge: '--inprivate', firefox: '--private-window' };

/**
 * Browsers `renew` can open in a private window, most preferred first. A private window holds no
 * claude.ai session, so the sign-in page asks for the account the login hint names instead of
 * approving whichever account the everyday browser is signed in to.
 */
function privateBrowsers(env, platform) {
  // `renew` refuses macOS, where the login it runs lands in the shared Keychain.
  if (platform === 'darwin') return [];

  if (platform === 'win32') {
    const installs = [
      [env.ProgramFiles, 'Google/Chrome/Application/chrome.exe', 'chrome'],
      [env['ProgramFiles(x86)'], 'Google/Chrome/Application/chrome.exe', 'chrome'],
      [env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe', 'chrome'],
      [env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe', 'edge'],
      [env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe', 'edge'],
      [env.ProgramFiles, 'Mozilla Firefox/firefox.exe', 'firefox'],
    ];
    return installs
      .filter(([root]) => root)
      .map(([root, exe, kind]) => [path.join(root, exe), PRIVATE_FLAGS[kind]]);
  }

  const onPath = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = [
    ['google-chrome', 'chrome'],
    ['google-chrome-stable', 'chrome'],
    ['chromium', 'chrome'],
    ['chromium-browser', 'chrome'],
    ['microsoft-edge', 'edge'],
    ['firefox', 'firefox'],
  ];
  return names.flatMap(([name, kind]) =>
    onPath.map((dir) => [path.join(dir, name), PRIVATE_FLAGS[kind]]),
  );
}

/**
 * The environment and paths of a `claude` run confined to `dir`: its login lands there, and the
 * live config is never read or written.
 */
export function confinedTo(dir, env = process.env) {
  const confinedEnv = { ...env, CLAUDE_CONFIG_DIR: dir };
  return { env: confinedEnv, paths: resolvePaths(confinedEnv) };
}
