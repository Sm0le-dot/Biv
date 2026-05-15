const { app, BrowserWindow, globalShortcut, ipcMain, shell } = require('electron');
app.setName('Biv');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');




function trimEnvLineValue(s) {
    return String(s || '')
        .trim()
        .replace(/^["'](.*)["']$/, '$1');
}

function readDotEnvMap() {
    const envPath = path.join(__dirname, '..', '.env');
    const map = {};
    if (!fs.existsSync(envPath)) return map;
    try {
        const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
            if (!m) continue;
            const key = m[1];
            let raw = m[2];
            if (key === 'OLLAMA_MODELS' || key === 'OPENROUTER_MODELS') {
                let blob = trimEnvLineValue(raw);
                let j = i + 1;
                while (j < lines.length) {
                    try {
                        const parsed = JSON.parse(blob.replace(/\r/g, '').trim());
                        if (Array.isArray(parsed)) break;
                    } catch {
                        /* accumulate */
                    }
                    const next = lines[j];
                    if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(next)) break;
                    blob += String(next).trim();
                    j++;
                }
                map[key] = blob;
                i = j - 1;
                continue;
            }
            map[key] = trimEnvLineValue(raw);
        }
    } catch (e) {
        console.warn('readDotEnvMap:', e.message);
    }
    return map;
}

function parseEnvBool(value, fallback = false) {
    const v = String(value || '')
        .trim()
        .toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    return fallback;
}

function ollamaSpawnEnv() {
    const env = { ...process.env };
    if (process.platform === 'darwin') {
        const extra = ['/opt/homebrew/bin', '/usr/local/bin'].filter((p) => fs.existsSync(p));
        if (extra.length) {
            env.PATH = extra.join(path.delimiter) + path.delimiter + (env.PATH || '');
        }
    }
    if (process.platform === 'win32') {
        const extra = [];
        if (process.env.LOCALAPPDATA) {
            extra.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama'));
        }
        if (process.env.ProgramFiles) {
            extra.push(path.join(process.env.ProgramFiles, 'Ollama'));
        }
        const existing = (env.PATH || '').split(path.delimiter).filter(Boolean);
        for (const dir of extra) {
            if (fs.existsSync(dir) && !existing.includes(dir)) {
                env.PATH = dir + path.delimiter + (env.PATH || '');
            }
        }
    }
    return env;
}

function getOllamaServeCommand() {
    if (process.platform === 'win32') {
        const dirs = [];
        if (process.env.LOCALAPPDATA) {
            dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama'));
        }
        if (process.env.ProgramFiles) {
            dirs.push(path.join(process.env.ProgramFiles, 'Ollama'));
        }
        for (const d of dirs) {
            const exe = path.join(d, 'ollama.exe');
            if (fs.existsSync(exe)) {
                return { cmd: exe, args: ['serve'], shell: false };
            }
        }
        return { cmd: 'ollama', args: ['serve'], shell: true };
    }
    if (process.platform === 'darwin') {
        const brew = '/opt/homebrew/bin/ollama';
        if (fs.existsSync(brew)) return { cmd: brew, args: ['serve'], shell: false };
        const loc = '/usr/local/bin/ollama';
        if (fs.existsSync(loc)) return { cmd: loc, args: ['serve'], shell: false };
    }
    return { cmd: 'ollama', args: ['serve'], shell: false };
}

/**
 * Start `ollama serve` detached (no console on Windows). Does not block.
 * @returns {{ ok: boolean, error?: string }}
 */
function spawnOllamaServeDetached() {
    const { cmd, args, shell } = getOllamaServeCommand();
    try {
        const child = spawn(cmd, args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            shell: !!shell,
            env: ollamaSpawnEnv()
        });
        child.unref();
        child.on('error', (err) => {
            console.warn('Ollama background start:', err.message);
        });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
    }
}

async function waitForOllama(baseUrl, attempts = 24, delayMs = 500) {
    for (let i = 0; i < attempts; i++) {
        if (await probeOllama(baseUrl)) return true;
        await new Promise((r) => setTimeout(r, delayMs));
    }
    return false;
}

async function tryStartOllamaInBackground(baseUrl) {
    const base = String(baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    if (await probeOllama(base)) {
        return { ok: true, alreadyRunning: true };
    }
    const spawned = spawnOllamaServeDetached();
    if (!spawned.ok) {
        return { ok: false, reason: spawned.error || 'Could not start Ollama process.' };
    }
    const up = await waitForOllama(base);
    if (up) return { ok: true, started: true };
    return {
        ok: false,
        reason: 'Ollama did not respond in time. Install it or start the Ollama app manually.'
    };
}
/**
 * @param {string} baseUrl e.g. http://127.0.0.1:11434
 * @returns {Promise<boolean>}
 */
async function probeOllama(baseUrl) {
    const base = String(baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    
    const tryProbe = (urlStr) => {
        let url;
        try {
            url = new URL(`${urlStr}/api/tags`);
        } catch {
            return Promise.resolve(false);
        }
        const lib = url.protocol === 'https:' ? https : require('http');
        return new Promise((resolve) => {
            const req = lib.request(
                url,
                { method: 'GET', timeout: 3000 },
                (res) => {
                    res.resume();
                    resolve(res.statusCode === 200);
                }
            );
            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                try {
                    req.destroy();
                } catch (_) { /* ignore */ }
                resolve(false);
            });
            req.end();
        });
    };

    // Try the provided base URL first
    let ok = await tryProbe(base);
    if (ok) return true;

    // If it's the default 127.0.0.1 and failed, try localhost as well
    if (base.includes('127.0.0.1:11434')) {
        ok = await tryProbe('http://localhost:11434');
        if (ok) return true;
    } else if (base.includes('localhost:11434')) {
        ok = await tryProbe('http://127.0.0.1:11434');
        if (ok) return true;
    }

    return false;
}

function httpsGetJson(url) {
    return new Promise((resolve, reject) => {
        https
            .get(
                url,
                {
                    headers: {
                        Accept: 'application/vnd.github+json',
                        'User-Agent': 'DesktopLLMOverlay'
                    }
                },
                (res) => {
                    let body = '';
                    res.on('data', (c) => {
                        body += c;
                    });
                    res.on('end', () => {
                        if (res.statusCode && res.statusCode >= 400) {
                            reject(new Error(`GitHub API ${res.statusCode}`));
                            return;
                        }
                        try {
                            resolve(JSON.parse(body));
                        } catch (e) {
                            reject(e);
                        }
                    });
                }
            )
            .on('error', reject);
    });
}

function httpsDownloadToFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const request = (u) => {
            https
                .get(u, { headers: { 'User-Agent': 'DesktopLLMOverlay' } }, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        request(res.headers.location);
                        return;
                    }
                    if (res.statusCode !== 200) {
                        file.close(() => fs.unlink(destPath, () => {}));
                        reject(new Error(`Download HTTP ${res.statusCode}`));
                        return;
                    }
                    res.pipe(file);
                    file.on('finish', () => file.close((err) => (err ? reject(err) : resolve())));
                })
                .on('error', (err) => {
                    file.close(() => fs.unlink(destPath, () => {}));
                    reject(err);
                });
        };
        request(url);
    });
}

// 1. Transparency and performance flags for Windows
app.commandLine.appendSwitch('wm-window-animations-disabled');

let win;
let isHiding = false;

const OVERLAY_PID_FILE = path.join(__dirname, '..', 'data', '.electron-overlay.pid');

function createWindow() {
    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;

    win = new BrowserWindow({
        width: width,
        height: height,
        x: 0,
        y: 0,
        // icon: path.join(__dirname, '..', 'frontend', 'BivLogo.jpg'),
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,      // <--- THIS STOPS SIZING
        movable: false,        // Keep this true so you can still drag it
        hasShadow: false,     // <--- THIS REMOVES THE OS GRADIENT/SHADOW
        show: false, 
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false
        }
    });

    win.loadFile(path.join(__dirname, '..', 'frontend', 'index.html'));

    // Handle clicking away: animate out then hide
    win.on('blur', () => {
        if (!isHiding && win.isVisible()) {
            isHiding = true;
            win.webContents.send('hide-window');
        }
    });

    ipcMain.on('hide-window-done', () => {
        win.hide();
        isHiding = false;
        // Also reset mouse ignore when hidden
        win.setIgnoreMouseEvents(true, { forward: true });
    });

    // Safety reset for hiding state
    ipcMain.on('window-blur', () => {
        if (isHiding) {
            setTimeout(() => {
                if (isHiding) {
                    win.hide();
                    isHiding = false;
                }
            }, 1000);
        }
    });

    ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
        const w = BrowserWindow.fromWebContents(event.sender);
        if (w) w.setIgnoreMouseEvents(ignore, options);
    });

    ipcMain.handle('ollama-probe', async (_evt, baseUrl) => probeOllama(baseUrl));

    ipcMain.handle('ollama-open-download-page', async () => {
        await shell.openExternal('https://ollama.com/download');
        return { ok: true };
    });

    ipcMain.handle('ollama-try-start-background', async (_evt, baseUrl) =>
        tryStartOllamaInBackground(baseUrl)
    );

    ipcMain.handle('ollama-download-windows-installer', async () => {
        if (process.platform !== 'win32') {
            await shell.openExternal('https://ollama.com/download');
            return { ok: false, reason: 'Use the download page on this OS.' };
        }
        const tmp = path.join(app.getPath('temp'), 'OllamaSetup.exe');
        try {
            const release = await httpsGetJson(
                'https://api.github.com/repos/ollama/ollama/releases/latest'
            );
            const assets = release.assets || [];
            const exe = assets.find(
                (a) => a && typeof a.browser_download_url === 'string' && /\.exe$/i.test(a.name)
            );
            if (!exe) {
                await shell.openExternal('https://ollama.com/download');
                return { ok: false, reason: 'No Windows installer in latest release; opened download page.' };
            }
            await httpsDownloadToFile(exe.browser_download_url, tmp);
            const err = await shell.openPath(tmp);
            if (err) {
                return { ok: false, reason: err || 'Could not start installer.' };
            }
            return { ok: true, path: tmp };
        } catch (e) {
            await shell.openExternal('https://ollama.com/download');
            return {
                ok: false,
                reason: e && e.message ? e.message : String(e)
            };
        }
    });





    // Optional: Log errors if they happen in the main process
    win.webContents.on('did-fail-load', () => {
        console.log("Failed to load index.html. Check your file path.");
    });
}

app.whenReady().then(() => {
    createWindow();

    const envMap = readDotEnvMap();
    if (parseEnvBool(envMap.OLLAMA_ENABLED, true) && parseEnvBool(envMap.OLLAMA_AUTO_START, false)) {
        const base = (envMap.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
        tryStartOllamaInBackground(base).then((r) => {
            if (!r.ok && !r.alreadyRunning) {
                console.warn('OLLAMA_AUTO_START:', r.reason || r);
            }
        });
    }

    // HOTKEY LOGIC
    const ret = globalShortcut.register('CommandOrControl+Shift+Space', () => {
        if (win.isVisible()) {
            // If it's visible, hide it
            isHiding = true;
            win.webContents.send('hide-window');
            
            // Safety timeout: if renderer doesn't reply in 500ms, force hide
            setTimeout(() => {
                if (isHiding && win.isVisible()) {
                    win.hide();
                    isHiding = false;
                }
            }, 500);
        } else {
            isHiding = false;
            // Ensure the window is interactive before showing
            win.setIgnoreMouseEvents(false);
            win.show();
            win.focus();
            win.webContents.send('window-shown');
        }
    });

    if (!ret) {
        console.log('Registration failed: The hotkey is likely used by another app.');
    }

    // Write PID file for management scripts
    try {
        const dataDir = path.dirname(OVERLAY_PID_FILE);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        fs.writeFileSync(OVERLAY_PID_FILE, String(process.pid), 'utf8');
    } catch (e) {
        console.warn('Could not write PID file:', e.message);
    }

    // Show window only when content is fully loaded
    win.webContents.on('did-finish-load', () => {
        setTimeout(() => {
            if (win && !win.isDestroyed()) {
                // Ensure the window is fully interactive on launch
                win.setIgnoreMouseEvents(false);
                win.show();
                win.focus();
                win.webContents.send('window-shown');
            }
        }, 500);
    });
});

// Clean up shortcuts on quit
app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    try {
        if (fs.existsSync(OVERLAY_PID_FILE)) {
            fs.unlinkSync(OVERLAY_PID_FILE);
        }
    } catch (_) {
        /* ignore */
    }
});

// Quit when all windows are closed
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});