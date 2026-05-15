/**
 * Stop the app launched with `npm run start:bg` (uses .electron-overlay.pid).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const pidFile = path.join(root, 'data', '.electron-overlay.pid');

if (!fs.existsSync(pidFile)) {
    console.log(
        'No .electron-overlay.pid — not started with `npm run start:bg`, or it already quit.\n' +
            'To stop manually: Task Manager → find Electron → End task.'
    );
    process.exit(0);
}

const raw = fs.readFileSync(pidFile, 'utf8').trim();
const pid = Number(raw);
if (!Number.isInteger(pid) || pid <= 0) {
    try {
        fs.unlinkSync(pidFile);
    } catch (_) {
        /* ignore */
    }
    console.log('Removed invalid PID file.');
    process.exit(0);
}

if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
        fs.unlinkSync(pidFile);
    } catch (_) {
        /* ignore */
    }
    if (r.status === 0) {
        console.log('Stopped Electron process tree.');
    } else if (r.status === 128) {
        console.log('Process was already gone. Removed stale PID file.');
    } else {
        console.log('taskkill exit', r.status);
        if (r.stderr) console.error(r.stderr);
    }
    process.exit(r.status === 0 || r.status === 128 ? 0 : r.status || 1);
}

try {
    process.kill(pid, 'SIGTERM');
} catch (e) {
    if (e && e.code !== 'ESRCH') {
        console.error(e.message || e);
    }
}
try {
    fs.unlinkSync(pidFile);
} catch (_) {
    /* ignore */
}
console.log('Stopped (PID ' + pid + ').');
process.exit(0);
