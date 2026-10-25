import { readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let remembered;
try {
    remembered = JSON.parse(readFileSync(resolve(root, '.local/agentscope-link.json'), 'utf8')).source;
} catch {}
const source = process.argv.find((arg, i) => i > 1 && !arg.startsWith('--')) || process.env.AGENTSCOPE_SOURCE || remembered;
if (!source) throw new Error('Usage: pnpm agentscope:local <AgentScope directory> [--watch]');
const sdkRoot = realpathSync(resolve(source));
for (const name of ['sdk', 'contracts']) {
    const manifest = JSON.parse(readFileSync(resolve(sdkRoot, 'packages', name, 'package.json'), 'utf8'));
    if (manifest.name !== `@agentscope/${name}`) throw new Error('Selected directory is not an AgentScope checkout');
}
const env = { ...process.env, PATH: [resolve(sdkRoot, 'node_modules/.bin'), resolve(root, 'node_modules/.bin'), process.env.PATH].join(delimiter) };
function run(cwd, args) {
    const result = spawnSync('pnpm', args, { cwd, env, stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Local SDK setup failed');
}
run(sdkRoot, ['--filter', '@agentscope/sdk...', 'build']);
const lock = resolve(root, 'pnpm-lock.yaml');
const originalLock = readFileSync(lock);
try {
    run(resolve(root, 'packages/telemetry'), ['link', resolve(sdkRoot, 'packages/sdk'), resolve(sdkRoot, 'packages/contracts')]);
} finally {
    writeFileSync(lock, originalLock);
}
const require = (await import('node:module')).createRequire(resolve(root, 'packages/telemetry/package.json'));
if (realpathSync(require.resolve('@agentscope/sdk')) !== realpathSync(resolve(sdkRoot, 'packages/sdk/dist/index.js'))) throw new Error('SDK link verification failed');
mkdirSync(resolve(root, '.local'), { recursive: true });
writeFileSync(resolve(root, '.local/agentscope-link.json'), JSON.stringify({ source: sdkRoot }, null, 2) + '\n');
console.log('Local SDK linked. Restart Gist API/Worker to load the current build.');
if (process.argv.includes('--watch') || process.argv.includes('--dev')) {
    if (process.argv.includes('--dev')) run(root, ['--filter', '@gist/api...', '--filter', '@gist/worker...', 'build']);
    const grouped = process.platform !== 'win32';
    const children = [spawn('pnpm', ['--parallel', '--filter', '@agentscope/sdk...', 'dev'], { cwd: sdkRoot, env, stdio: 'inherit', detached: grouped })];
    if (process.argv.includes('--dev')) {
        for (const app of ['api', 'worker']) {
            const watchPaths = [
                resolve(sdkRoot, 'packages/sdk/dist'),
                resolve(sdkRoot, 'packages/contracts/dist'),
                resolve(root, `apps/${app}/dist`),
                ...['telemetry', 'llm', 'config', 'contracts', 'database'].map((name) => resolve(root, `packages/${name}/dist`)),
            ];
            children.push(
                spawn(process.execPath, ['--watch', ...watchPaths.map((p) => `--watch-path=${p}`), `apps/${app}/dist/main.js`], {
                    cwd: root,
                    env,
                    stdio: 'inherit',
                    detached: grouped,
                })
            );
        }
    }
    let stopping = false;
    function stop(signal = 'SIGTERM') {
        if (stopping) return;
        stopping = true;
        for (const child of children) {
            if (!child.pid) continue;
            try {
                if (grouped) process.kill(-child.pid, signal);
                else child.kill(signal);
            } catch {
                /* Child may already have exited. */
            }
        }
    }
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal));
    for (const child of children) {
        child.on('error', () => {
            console.error('Local development child failed to start');
            process.exitCode = 1;
            stop();
        });
        child.on('exit', (code) => {
            if (!stopping) {
                process.exitCode = code || 1;
                stop();
            }
        });
    }
}
