'use strict';

const { exec, execFile } = require('child_process');
const { log } = require('./logger');

function isProcessRunning(exeName) {
  return new Promise((resolve) => {
    exec(`tasklist /FI "IMAGENAME eq ${exeName}" /NH`, (err, stdout) => {
      if (err) return resolve(false);
      resolve(stdout.toLowerCase().includes(exeName.toLowerCase()));
    });
  });
}

function focusWindowByProcess(processName) {
  const script = [
    `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);' -Name WU -Namespace W32;`,
    `$p = Get-Process -Name "${processName}" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;`,
    `if ($p) {`,
    `  [W32.WU]::ShowWindow($p.MainWindowHandle, 9);`,
    `  Start-Sleep -Milliseconds 100;`,
    `  (New-Object -ComObject WScript.Shell).AppActivate($p.Id)`,
    `}`,
  ].join('\n');

  execFile('powershell', ['-ExecutionPolicy', 'Bypass', '-Command', script], (err, stdout, stderr) => {
    if (err) log(`focus error: ${err.message}`);
    if (stdout) log(`focus stdout: ${stdout.trim()}`);
    if (stderr) log(`focus stderr: ${stderr.trim()}`);
  });
}

module.exports = { isProcessRunning, focusWindowByProcess };
