/**
 * Windows: add a shortcut to the user Startup folder so the overlay runs at login.
 * Uses cmd.exe + `node scripts/start-background.js` so PATH matches a normal terminal.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const ps1 = path.join(__dirname, 'windows-startup-shortcut.ps1');

if (process.platform !== 'win32') {
    console.log('Automatic startup is only wired for Windows (Startup folder shortcut).');
    console.log('');
    console.log('On macOS: System Settings → General → Login Items → add:');
    console.log('  ', process.execPath, path.join(root, 'scripts', 'start-background.js'));
    console.log('');
    console.log('On Linux: add to your WM autostart or a systemd user unit running that command.');
    process.exit(0);
}

if (!fs.existsSync(ps1)) {
    console.error('Missing:', ps1);
    process.exit(1);
}

try {
    execFileSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-ProjectRoot', root],
        { stdio: 'inherit' }
    );
} catch (e) {
    console.error(e.message || e);
    process.exit(1);
}
