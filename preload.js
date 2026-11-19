'use strict';
// 渲染进程只拿到这几个受控能力，不开放 Node 集成。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tvbox', {
  pickFolder: () => ipcRenderer.invoke('tvbox:pickFolder'),
  showItem: (p) => ipcRenderer.invoke('tvbox:showItem', p),
  openItem: (p) => ipcRenderer.invoke('tvbox:openItem', p),
  // 无边框窗口控制（最小 / 最大还原 / 关闭）与状态
  winAction: (a) => ipcRenderer.invoke('tvbox:winAction', a),
  isMaximized: () => ipcRenderer.invoke('tvbox:isMaximized'),
  onWinState: (cb) => { ipcRenderer.on('tvbox:winState', (_e, max) => cb(!!max)); },
});
