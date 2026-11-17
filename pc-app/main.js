'use strict';
const { app, BrowserWindow, Menu, session } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const PORT = 32124;
const TITLEBAR_CSS = `
  html { padding-top: 40px !important; box-sizing: border-box; }
  body { -webkit-user-select: none; }
  input, textarea { -webkit-user-select: text; }
  #topbar { height: 40px !important; padding-top: 0 !important; }
  #ltv-drag-strip {
    position: fixed !important; top: 0; left: 0; right: 150px; height: 40px;
    z-index: 2147483647; -webkit-app-region: drag;
  }
`;

const LOG = path.join(app.getPath('userData'), 'tvbox-pc.log');
function log(m) { try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`); } catch (_) {} }

const SERVICE_JS = app.isPackaged
  ? path.join(process.resourcesPath, 'service', 'index.js')
  : path.join(__dirname, 'service', 'index.js');
const UI_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'ui')
  : path.join(__dirname, 'ui');

let serverProc = null, mainWindow = null;

function isPortOpen(port) {
  return new Promise(res => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    const t = setTimeout(() => { s.destroy(); res(false); }, 700);
    s.once('connect', () => { clearTimeout(t); s.destroy(); res(true); });
    s.once('error', () => { clearTimeout(t); res(false); });
  });
}
async function waitServer(ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) { if (await isPortOpen(PORT)) return true; await new Promise(r => setTimeout(r, 250)); }
  return false;
}
function startService() {
  if (!fs.existsSync(SERVICE_JS)) { log('missing service: ' + SERVICE_JS); return false; }
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT), HOST: '127.0.0.1' };
  // 数据目录：打包后放用户目录，避免写安装目录
  env.TVBOX_DATA = path.join(app.getPath('userData'), 'data');
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const fd = fs.openSync(LOG, 'a');
  serverProc = spawn(process.execPath, [SERVICE_JS], {
    cwd: path.dirname(SERVICE_JS), env, windowsHide: true, stdio: ['ignore', fd, fd],
  });
  serverProc.on('error', e => log('spawn error ' + e));
  serverProc.on('exit', (c, s) => log('service exit ' + c + ' ' + s));
  return true;
}
function stopService() {
  if (serverProc && !serverProc.killed) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(serverProc.pid), '/t', '/f'], { windowsHide: true });
    else serverProc.kill('SIGTERM');
    serverProc = null;
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1000, minHeight: 640, show: false,
    icon: path.join(__dirname, 'icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b101a', symbolColor: '#e6f2ff', height: 40 },
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: true },
  });
  const ok = await waitServer();
  if (!ok) { mainWindow.loadFile(path.join(UI_DIR, 'error.html')).catch(() => {}); mainWindow.show(); return; }
  const inject = () => {
    mainWindow.webContents.insertCSS(TITLEBAR_CSS).catch(() => {});
    mainWindow.webContents.executeJavaScript(`
      (function(){ if(document.getElementById('ltv-drag-strip'))return;
        var d=document.createElement('div'); d.id='ltv-drag-strip'; document.body.appendChild(d); })();
    `).catch(() => {});
  };
  mainWindow.webContents.on('did-finish-load', inject);
  mainWindow.loadURL(`http://127.0.0.1:${PORT}/`);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  if (!(await isPortOpen(PORT))) { if (!startService()) { app.quit(); return; } }
  await createWindow();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
app.on('window-all-closed', () => { stopService(); app.quit(); });
app.on('before-quit', stopService);
