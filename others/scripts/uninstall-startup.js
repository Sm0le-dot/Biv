/**
 * Windows: remove the Startup-folder shortcut created by install-startup.js.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SHORTCUT_NAME = 'DesktopLLMOverlay.lnk';

if (process.platform !== 'win32') {
    console.log('No Windows startup shortcut to remove.');
    process.exit(0);
}

let startupDir;
try {
    startupDir = execFileSync(
        'powershell.exe',
        [
            '-NoProfile',
            '-Command',
            '[Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)'
        ],
        { encoding: 'utf8' }
    ).trim();
} catch (e) {
    console.error('Could not resolve Startup folder:', e.message);
    process.exit(1);
}

const lnkPath = path.join(startupDir, SHORTCUT_NAME);

if (fs.existsSync(lnkPath)) {
    fs.unlinkSync(lnkPath);
    console.log('Removed startup shortcut:');
    console.log(' ', lnkPath);
} else {
    console.log('Startup shortcut was not found (already removed or never installed):');
    console.log(' ', lnkPath);
}
