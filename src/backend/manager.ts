// P4 TS: backend lifecycle + process queue/lock + opencode binary resolution (ported from P3 .js).
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { ProxyConfig } from '../types/config.js';
import type { BackendState, OpencodeResolveResult } from '../types/backend.js';

interface QueuedTask {
  task: () => Promise<unknown>;
  timeout: number;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

const queue: QueuedTask[] = [];
let isProcessing = false;

const STARTUP_WAIT_ITERATIONS = 60;
const STARTUP_WAIT_INTERVAL_MS = 2000;
const STARTING_WAIT_ITERATIONS = 120;
const STARTING_WAIT_INTERVAL_MS = 1000;

const OPENCODE_BASENAME = 'opencode';

export function splitPathEnv(): string[] {
  const raw: string = process.env['PATH'] || '';
  return raw.split(path.delimiter).filter(Boolean);
}

export function sleep(ms: unknown): Promise<void> {
  const numeric = Number(ms);
  const safe = Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
  return new Promise((resolve) => setTimeout(resolve, safe));
}

export function pushDir(list: string[], dir: unknown): void {
  if (!dir || typeof dir !== 'string' || !dir) return;
  if (!list.includes(dir)) list.push(dir);
}

export function pushExistingDir(list: string[], dir: unknown): void {
  if (!dir || typeof dir !== 'string' || !dir) return;
  if (!fs.existsSync(dir)) return;
  if (!list.includes(dir)) list.push(dir);
}

export function addVersionedDirs(list: string[], baseDir: unknown, subpath: unknown): void {
  if (typeof baseDir !== 'string' || !baseDir || !fs.existsSync(baseDir)) return;
  let entries: import('fs').Dirent[] = [];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.forEach((entry) => {
    if (!entry.isDirectory()) return;
    const full = path.join(baseDir, entry.name, typeof subpath === 'string' ? subpath : '');
    pushExistingDir(list, full);
  });
}

export function prefixToBin(prefix: unknown): string | null {
  if (!prefix || typeof prefix !== 'string' || !prefix) return null;
  return process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
}

export function getOpencodeCandidateNames(): string[] {
  if (process.platform === 'win32') {
    return [`${OPENCODE_BASENAME}.cmd`, `${OPENCODE_BASENAME}.exe`, `${OPENCODE_BASENAME}.bat`, OPENCODE_BASENAME];
  }
  return [OPENCODE_BASENAME];
}

export function findExecutableInDirs(dirs: unknown, names: unknown): string | null {
  if (!Array.isArray(dirs) || !Array.isArray(names)) return null;
  for (const dir of dirs as unknown[]) {
    if (typeof dir !== 'string') continue;
    for (const name of names as unknown[]) {
      if (typeof name !== 'string') continue;
      const full = path.join(dir, name);
      if (fs.existsSync(full)) {
        return full;
      }
    }
  }
  return null;
}

export function resolveOpencodePath(requestedPath: unknown): OpencodeResolveResult {
  const input = typeof requestedPath === 'string' ? requestedPath.trim() : '';
  const names = getOpencodeCandidateNames();

  if (input) {
    const looksLikePath = path.isAbsolute(input) || input.includes('/') || input.includes('\\');
    if (looksLikePath) {
      if (fs.existsSync(input)) return { path: input, source: 'config' };
      const resolved = path.resolve(process.cwd(), input);
      if (fs.existsSync(resolved)) return { path: resolved, source: 'config' };
    }
  }

  const pathDirs = splitPathEnv();
  const fromPath = findExecutableInDirs(pathDirs, names);
  if (fromPath) return { path: fromPath, source: 'PATH' };

  const extraDirs: string[] = [];
  if (process.env['OPENCODE_HOME']) {
    pushDir(extraDirs, path.join(process.env['OPENCODE_HOME'], 'bin'));
  }
  if (process.env['OPENCODE_DIR']) {
    pushDir(extraDirs, path.join(process.env['OPENCODE_DIR'], 'bin'));
  }
  pushDir(extraDirs, prefixToBin(process.env['npm_config_prefix'] ?? process.env['NPM_CONFIG_PREFIX']));
  pushDir(extraDirs, process.env['PNPM_HOME']);
  if (process.env['YARN_GLOBAL_FOLDER']) {
    pushDir(extraDirs, path.join(process.env['YARN_GLOBAL_FOLDER'], 'bin'));
  }
  if (process.env['VOLTA_HOME']) {
    pushDir(extraDirs, path.join(process.env['VOLTA_HOME'], 'bin'));
  }
  pushDir(extraDirs, process.env['NVM_BIN']);
  pushDir(extraDirs, path.dirname(process.execPath));

  const home = os.homedir();
  if (home) {
    pushDir(extraDirs, path.join(home, '.opencode', 'bin'));
    pushDir(extraDirs, path.join(home, '.local', 'bin'));
    pushDir(extraDirs, path.join(home, '.npm-global', 'bin'));
    pushDir(extraDirs, path.join(home, '.npm', 'bin'));
    pushDir(extraDirs, path.join(home, '.pnpm-global', 'bin'));
    pushDir(extraDirs, path.join(home, '.local', 'share', 'pnpm'));
    pushDir(extraDirs, path.join(home, '.fnm', 'node-versions', 'v1', 'installations'));
    pushDir(extraDirs, path.join(home, '.asdf', 'shims'));
  }

  if (process.platform === 'win32') {
    pushDir(extraDirs, process.env['APPDATA'] ? path.join(process.env['APPDATA'], 'npm') : null);
    pushDir(extraDirs, process.env['LOCALAPPDATA'] ? path.join(process.env['LOCALAPPDATA'], 'pnpm') : null);
    pushDir(extraDirs, process.env['NVM_HOME']);
    pushDir(extraDirs, process.env['NVM_SYMLINK']);
    pushDir(extraDirs, process.env['ProgramFiles'] ? path.join(process.env['ProgramFiles'], 'nodejs') : null);
    pushDir(
      extraDirs,
      process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'] as string, 'nodejs') : null,
    );
  } else {
    pushDir(extraDirs, '/usr/local/bin');
    pushDir(extraDirs, '/usr/bin');
    pushDir(extraDirs, '/bin');
    pushDir(extraDirs, '/opt/homebrew/bin');
    pushDir(extraDirs, '/snap/bin');
  }

  // nvm (unix) versions
  const nvmDir: string | null = (process.env['NVM_DIR'] as string) || (home ? path.join(home, '.nvm') : null);
  if (nvmDir) {
    addVersionedDirs(extraDirs, path.join(nvmDir, 'versions', 'node'), 'bin');
  }

  // asdf nodejs installs
  const asdfDir: string | null =
    (process.env['ASDF_DATA_DIR'] as string) || (home ? path.join(home, '.asdf') : null);
  if (asdfDir) {
    addVersionedDirs(extraDirs, path.join(asdfDir, 'installs', 'nodejs'), 'bin');
  }

  // fnm installs
  if (home) {
    addVersionedDirs(extraDirs, path.join(home, '.fnm', 'node-versions', 'v1'), 'installation' + path.sep + 'bin');
  }

  const fromExtras = findExecutableInDirs(extraDirs, names);
  if (fromExtras) return { path: fromExtras, source: 'known-locations' };

  return { path: null, source: 'not-found' };
}

export function processQueue(): void {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;
  const next = queue.shift();
  if (!next) {
    isProcessing = false;
    return;
  }
  const { task, timeout, resolve, reject } = next;
  let settled = false;
  const timeoutMs = timeout || 120000;
  const timeoutId = setTimeout(() => {
    if (settled) return;
    settled = true;
    reject(new Error(`Request timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  Promise.resolve()
    .then(() => task())
    .then((result: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    })
    .catch((err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      reject(err);
    })
    .finally(() => {
      isProcessing = false;
      if (queue.length > 0) {
        queueMicrotask(processQueue);
      }
    });
}

export function lock(task: unknown, timeout: unknown = 120000): Promise<unknown> {
  const fn = task as () => Promise<unknown>;
  const ms = typeof timeout === 'number' && Number.isFinite(timeout) ? timeout : 120000;
  return new Promise((resolve, reject) => {
    queue.push({ task: fn, timeout: ms, resolve, reject });
    processQueue();
  });
}

/**
 * Robust Health Check Helper
 */
export function buildBackendAuthHeaders(password: unknown = ''): Record<string, string> | undefined {
  if (!password || typeof password !== 'string' || !password) return undefined;
  const token = Buffer.from(`opencode:${password}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

export function checkHealth(serverUrl: unknown, password: unknown = ''): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const headers = buildBackendAuthHeaders(password);
    const url = String(serverUrl);
    const onResponse = (res: import('http').IncomingMessage): void => {
      if (res.statusCode === 200) resolve(true);
      else reject(new Error(`Status ${res.statusCode}`));
    };
    // Preserve 3-arg call shape (url, options|undefined, callback): the Jest
    // http mock expects (url, options, callback) and real http.get accepts
    // undefined options. A 2-arg call would shift the mock's callback to
    // undefined and break health checks in tests.
    const options = (headers ? { headers } : undefined) as unknown as import('http').RequestOptions;
    const req = http.get(`${url}/health`, options, onResponse);
    req.on('error', (e: unknown) => reject(e));
    req.setTimeout(2000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

/**
 * Cleanup temporary directories
 */
export function cleanupTempDirs(): void {
  // Only cleanup jail directories on non-Windows platforms
  // On Windows, we don't use isolated jail to avoid path issues
  if (process.platform === 'win32') return;

  const jailRoot = path.join(os.tmpdir(), 'opencode-proxy-jail');
  try {
    if (fs.existsSync(jailRoot)) {
      fs.rmSync(jailRoot, { recursive: true, force: true });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[Cleanup] Failed to remove temp dirs:', msg);
  }
}

// Register cleanup on exit
process.on('exit', cleanupTempDirs);

// Handle signals - Unix-like systems
if (process.platform !== 'win32') {
  process.on('SIGINT', () => {
    console.log('\n[Shutdown] Received SIGINT, cleaning up...');
    cleanupTempDirs();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    console.log('\n[Shutdown] Received SIGTERM, cleaning up...');
    cleanupTempDirs();
    process.exit(0);
  });
}
// Note: Windows signal handling is limited, cleanup is handled via process.on('exit')

// Backend management state (per-instance)
export const backendState = new Map<string, BackendState>();

/**
 * Backend Lifecycle Management
 */
export async function ensureBackend(config: unknown): Promise<void> {
  const cfg = config as ProxyConfig;
  const {
    OPENCODE_SERVER_URL,
    OPENCODE_PATH,
    USE_ISOLATED_HOME,
    ZEN_API_KEY,
    OPENCODE_SERVER_PASSWORD,
    MANAGE_BACKEND,
    PROMPT_MODE,
  } = cfg;
  const stateKey = String(OPENCODE_SERVER_URL);

  if (!backendState.has(stateKey)) {
    backendState.set(stateKey, {
      isStarting: false,
      process: null,
      jailRoot: null,
    });
  }

  const state = backendState.get(stateKey) as BackendState;

  if (state.isStarting) {
    // Wait for startup to complete
    for (let i = 0; i < STARTING_WAIT_ITERATIONS; i++) {
      await new Promise((r) => setTimeout(r, STARTING_WAIT_INTERVAL_MS));
      try {
        await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
        return;
      } catch {
        // keep waiting
      }
    }
    throw new Error('Backend startup timeout');
  }

  try {
    await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
  } catch (err: unknown) {
    if (!MANAGE_BACKEND) {
      for (let i = 0; i < STARTUP_WAIT_ITERATIONS; i++) {
        await new Promise((r) => setTimeout(r, STARTUP_WAIT_INTERVAL_MS));
        try {
          await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
          return;
        } catch {
          // keep waiting
        }
      }
      throw err;
    }

    state.isStarting = true;
    console.log(`[Proxy] OpenCode backend not found at ${OPENCODE_SERVER_URL}. Starting...`);

    // Kill existing process if any
    if (state.process) {
      try {
        (state.process as ChildProcess).kill();
      } catch {
        // ignore
      }
    }

    // Cleanup old temp dir
    if (state.jailRoot && fs.existsSync(state.jailRoot)) {
      try {
        fs.rmSync(state.jailRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }

    const isWindows = process.platform === 'win32';
    const useIsolatedHome =
      typeof USE_ISOLATED_HOME === 'boolean'
        ? USE_ISOLATED_HOME
        : String(process.env['OPENCODE_USE_ISOLATED_HOME'] ?? '').toLowerCase() === 'true' ||
          process.env['OPENCODE_USE_ISOLATED_HOME'] === '1';

    // On Windows, don't use isolated fake-home to avoid path issues
    // On Unix-like systems, use jail for isolation
    const salt = Math.random().toString(36).substring(7);
    const jailRoot = path.join(os.tmpdir(), 'opencode-proxy-jail', salt);
    state.jailRoot = jailRoot;
    cfg.OPENCODE_HOME_BASE = jailRoot;
    const workspace = path.join(jailRoot, 'empty-workspace');

    let envVars: Record<string, string | undefined>;
    let cwd: string;

    if (isWindows) {
      // Windows: use normal user home to avoid opencode storage path issues
      fs.mkdirSync(workspace, { recursive: true });
      cwd = workspace;
      envVars = {
        ...process.env,
        OPENCODE_PROJECT_DIR: workspace,
      };
      console.log('[Proxy] Running on Windows, using standard user home directory');
    } else {
      fs.mkdirSync(workspace, { recursive: true });
      cwd = workspace;

      if (useIsolatedHome) {
        // Unix-like: use isolated fake-home
        const fakeHome = path.join(jailRoot, 'fake-home');

        // Create necessary opencode directories
        const opencodeDir = path.join(fakeHome, '.local', 'share', 'opencode');
        const storageDir = path.join(opencodeDir, 'storage');
        const messageDir = path.join(storageDir, 'message');
        const sessionDir = path.join(storageDir, 'session');

        [fakeHome, opencodeDir, storageDir, messageDir, sessionDir].forEach((d) => {
          if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        });

        envVars = {
          ...process.env,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          OPENCODE_PROJECT_DIR: workspace,
        };

        if (PROMPT_MODE === 'plugin-inject') {
          const configDir = path.join(fakeHome, '.config', 'opencode');
          const pluginDir = path.join(configDir, 'plugin', 'opencode2api-empty');
          fs.mkdirSync(pluginDir, { recursive: true });
          fs.writeFileSync(
            path.join(pluginDir, 'index.js'),
            `export const Opencode2apiEmptyPlugin = async () => ({})\nexport default Opencode2apiEmptyPlugin\n`,
            'utf8',
          );
          fs.writeFileSync(
            path.join(configDir, 'opencode.json'),
            JSON.stringify(
              {
                plugin: [path.join(pluginDir, 'index.js')],
                instructions: [],
                theme: 'system',
              },
              null,
              2,
            ),
            'utf8',
          );
          console.log('[Proxy] Using plugin-inject prompt mode');
        }
        console.log('[Proxy] Using isolated home for OpenCode');
      } else {
        envVars = {
          ...process.env,
          OPENCODE_PROJECT_DIR: workspace,
        };
        console.log('[Proxy] Using real HOME for OpenCode (isolation disabled)');
      }
    }

    const [, , portStr] = String(OPENCODE_SERVER_URL).split(':');
    const port = portStr ? String(portStr).split('/')[0] : '10001';
    const resolved = resolveOpencodePath(OPENCODE_PATH);
    const opencodeBin = resolved.path || (OPENCODE_PATH as string) || OPENCODE_BASENAME;
    if (resolved.path) {
      console.log(`[Proxy] Using OpenCode binary: ${opencodeBin} (source: ${resolved.source})`);
    } else {
      console.warn(`[Proxy] Unable to resolve OpenCode binary for '${OPENCODE_PATH}'. Using as-is.`);
    }

    // Cross-platform spawn options
    const useShell =
      process.platform === 'win32' || !resolved.path || opencodeBin.endsWith('.cmd') || opencodeBin.endsWith('.bat');
    const spawnOptions = {
      stdio: 'inherit' as const,
      cwd,
      env: envVars,
      shell: useShell, // Use shell only when needed (e.g., Windows .cmd or unresolved PATH)
    };

    const spawnArgs = ['serve', '--port', String(port), '--hostname', '127.0.0.1'];
    if (ZEN_API_KEY) {
      spawnArgs.push('--password', String(ZEN_API_KEY));
    }
    state.process = spawn(opencodeBin, spawnArgs, spawnOptions);

    // Handle spawn errors
    state.process.on('error', (spawnErr: unknown) => {
      const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      console.error(`[Proxy] Failed to spawn OpenCode: ${msg}`);
      const code: unknown = (spawnErr as Record<string, unknown>)['code'];
      if (code === 'ENOENT') {
        console.error(`[Proxy] Command '${OPENCODE_PATH}' not found. Please ensure OpenCode is installed and in your PATH.`);
        console.error(`[Proxy] You can specify the full path in config.json using 'OPENCODE_PATH'`);
      }
    });

    // Wait for backend to be ready
    let started = false;
    for (let i = 0; i < STARTUP_WAIT_ITERATIONS; i++) {
      await new Promise((r) => setTimeout(r, STARTUP_WAIT_INTERVAL_MS));
      try {
        await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
        console.log('[Proxy] OpenCode backend ready.');
        started = true;
        break;
      } catch {
        // keep waiting
      }
    }

    state.isStarting = false;

    if (!started) {
      console.warn('[Proxy] Backend start timed out.');
      throw new Error('Backend start timeout');
    }
  }
}
