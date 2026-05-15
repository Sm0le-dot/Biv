/**
 * Start Electron without attaching a console window on Windows.
 * If already running, kill the previous process and start a new one.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const pidFile = path.join(root, 'data', '.electron-overlay.pid');

// Kill any existing process before starting a new one
if (fs.existsSync(pidFile)) {
    try {
        const raw = fs.readFileSync(pidFile, 'utf8').trim();
        const pid = Number(raw);
        if (Number.isInteger(pid) && pid > 0) {
            if (process.platform === 'win32') {
                spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
                    encoding: 'utf8',
                    stdio: 'ignore'
                });
            } else {
                // For macOS/Linux
                spawnSync('kill', ['-9', String(pid)], {
                    encoding: 'utf8',
                    stdio: 'ignore'
                });
            }
        }
    } catch (_) {
        // Ignore errors during cleanup
    }
    // Clean up old PID file
    try {
        fs.unlinkSync(pidFile);
    } catch (_) {
        /* ignore */
    }
}

let electronExe;
try {
    electronExe = require(path.join(root, 'node_modules', 'electron'));
} catch (e) {
    console.error('Install dependencies first: npm install');
    console.error(e.message);
    process.exit(1);
}

const child = spawn(electronExe, ['.'], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: false
});

child.on('error', (err) => {
    console.error('Failed to start Electron:', err.message);
    process.exit(1);
});

if (child.pid) {
    try {
        fs.writeFileSync(pidFile, String(child.pid), 'utf8');
    } catch (e) {
        console.warn('Could not write PID file:', e.message);
    }
}

child.unref();
process.exit(0);
