'use strict';
const { app, BrowserWindow, Menu, session, dialog, shell, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const PORT = 32124;

const LOG = path.join(app.getPath('userData'), 'tvbox-pc.log');
function log(m) { try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`); } catch (_) {} }

const SERVICE_JS = app.isPackaged
  ? path.join(process.resourcesPath, 'service', 'index.js')
  : path.join(__dirname, 'service', 'index.js');
const UI_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'ui')
  : path.join(__dirname, 'ui');

let serverProc = null, mainWindow = null;

// 下载相关：原生文件夹选择 / 资源管理器定位 / 系统默认程序打开
ipcMain.handle('tvbox:pickFolder', async () => {
  try {
    const r = await dialog.showOpenDialog(mainWindow || BrowserWindow.getFocusedWindow(), {
      title: '选择下载文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? '' : (r.filePaths[0] || '');
  } catch (_) { return ''; }
});
ipcMain.handle('tvbox:showItem', async (_e, p) => {
  if (!p) return false;
  try { await shell.showItemInFolder(p); return true; } catch (_) { return false; }
});
ipcMain.handle('tvbox:openItem', async (_e, p) => {
  if (!p) return '路径为空';
  try { return (await shell.openPath(p)) || ''; } catch (e) { return e.message || String(e); }
});

// 窗口控制：自绘标题栏（无边框窗口）用，只暴露三个受控动作
ipcMain.handle('tvbox:winAction', (_e, action) => {
  const w = mainWindow;
  if (!w) return false;
  switch (action) {
    case 'min': w.minimize(); break;
    case 'max': w.isMaximized() ? w.restore() : w.maximize(); break;
    case 'close': w.close(); break;
    default: return false;
  }
  return true;
});
ipcMain.handle('tvbox:isMaximized', () => !!(mainWindow && mainWindow.isMaximized()));

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
    // 无边框透明窗口：由页面自己绘制圆角外壳与标题栏（logo + 窗口控制按钮）
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  const ok = await waitServer();
  if (!ok) { mainWindow.loadFile(path.join(UI_DIR, 'error.html')).catch(() => {}); mainWindow.show(); return; }
  const notifyMax = max => mainWindow && mainWindow.webContents.send('tvbox:winState', !!max);
  mainWindow.on('maximize', () => notifyMax(true));
  mainWindow.on('unmaximize', () => notifyMax(false));
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
