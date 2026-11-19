'use strict';
// 下载模块：把详情弹窗里的视频 / 图集 / 图文正文保存到本地目录。
// 只依赖 Node 内置能力 + 系统 curl（与既有 util 一致），不引入第三方包，避免影响其它模块。
// 任务化队列：start / list / control（暂停、继续、取消、重试、删除、清空已完成）。
// 断点续传：直链 curl -C -；m3u8 记录已合并分片；图片/正文已存在则跳过。
// 取消/重试只清理本任务自己的 .part 临时文件，不碰用户其它文件。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { httpGet } = require('./util');
const spider = require('./spider');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DATA_DIR = process.env.TVBOX_DATA || path.join(__dirname, 'data');
const TASKS_FILE = path.join(DATA_DIR, 'downloads.json');

class Stopped extends Error {}

function defaultDir() {
  const d = path.join(os.homedir(), 'Downloads');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) { return os.homedir(); }
  return d;
}

function safeName(s) {
  const n = String(s || 'download')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return n || 'download';
}

function refererOf(site) {
  try { return new URL(site.api).origin + '/'; } catch (_) { return site?.api || ''; }
}

function resolveU(base, ref) {
  try { return new URL(ref, base).href; } catch (_) { return ref; }
}

function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}

// 不覆盖用户已有文件：同名时自动加 -2、-3…（下载到一半的 .part 仍对应原路径）
function uniqueOut(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const stem = ext ? p.slice(0, -ext.length) : p;
  for (let i = 2; i < 100; i++) {
    const q = `${stem}-${i}${ext}`;
    if (!fs.existsSync(q)) return q;
  }
  return `${stem}-${Date.now()}${ext}`;
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

// 任务大小：已完成文件优先；下载中则统计本任务自己的 .part，不碰其它文件。
function sumSizes(paths) {
  return (Array.isArray(paths) ? paths : []).reduce((n, p) => n + fileSize(p), 0);
}
function taskBytes(t) {
  if (!t) return 0;
  const done = sumSizes(t.files || []);
  return done > 0 ? done : sumSizes(t.ctrl?.parts || []);
}

function rememberPart(task, part) {
  if (task?.ctrl?.parts && !task.ctrl.parts.includes(part)) task.ctrl.parts.push(part);
}

async function guard(task) {
  if (!task) return;
  if (task.status === 'canceled') throw new Stopped();
  while (task.status === 'paused') {
    await new Promise(r => setTimeout(r, 200));
    if (task.status === 'canceled') throw new Stopped();
  }
  if (task.status === 'error') throw new Stopped();
}

async function fetchBuf(u, referer) {
  const r = await httpGet(u, {
    raw: true,
    timeout: 20000,
    headers: referer ? { Referer: referer } : {},
  });
  if (!r.ok) throw new Error('下载失败 HTTP ' + r.status + '：' + u);
  return r.buf;
}

async function fetchText(u, referer) {
  return (await fetchBuf(u, referer)).toString('utf8');
}

// 大文件走 curl 直接落盘，避免整段视频占用内存；先写 .part，完成再改名。
// onChild 把子进程交给任务，暂停/取消时可立即 kill；resume 时 curl -C - 断点续传。
function curlSave(url, out, referer, onProgress, task, opts = {}) {
  const part = out + '.part';
  rememberPart(task, part);
  const args = ['-sS', '-L', '--compressed', '--retry', '2', '--max-time', '3600', '--progress-bar', '-A', UA];
  if (referer) args.push('-e', referer);
  if (!opts.noResume && fileSize(part) > 0) args.push('-C', '-');
  args.push('-o', part, url);

  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn('curl', args, { windowsHide: true }); }
    catch (e) { return reject(e); }
    if (task?.ctrl) task.ctrl.child = child;
    const errs = [];
    let lastPct = -1;
    child.stderr.on('data', b => {
      errs.push(b);
      if (!onProgress) return;
      const ms = b.toString('latin1').match(/(\d{1,3})%/g);
      if (!ms) return;
      const pct = parseInt(ms[ms.length - 1], 10);
      if (!Number.isNaN(pct) && pct - lastPct >= 2) {
        lastPct = pct;
        onProgress(Math.min(99, pct), '下载中');
      }
    });
    child.on('error', e => {
      if (task && ['paused', 'canceled', 'error'].includes(task.status)) reject(new Stopped());
      else reject(e);
    });
    child.on('close', code => {
      if (task?.ctrl?.child === child) task.ctrl.child = null;
      if (code === 0 && fileSize(part) > 0) {
        try {
          if (fs.existsSync(out)) fs.unlinkSync(out);
          fs.renameSync(part, out);
          return resolve(out);
        } catch (e) { return reject(e); }
      }
      if (task && ['paused', 'canceled', 'error'].includes(task.status)) return reject(new Stopped());
      // -C - 失败（服务器不支持 Range 等）：删掉 .part 从头再来一次
      if (!opts.noResume && fileSize(part) > 0) {
        try { fs.unlinkSync(part); } catch (_) {}
        return curlSave(url, out, referer, onProgress, task, { ...opts, noResume: true }).then(resolve, reject);
      }
      reject(new Error('curl ' + code + '：' + Buffer.concat(errs).toString('utf8').slice(-160)));
    });
  });
}

function extFromUrl(u) {
  const m = /\.(jpe?g|png|webp|gif|bmp)(\?|$)/i.exec(String(u || ''));
  return m ? '.' + m[1].toLowerCase() : '.jpg';
}

// m3u8：兼容主列表（多码率）与分片列表；有 #EXT-X-MAP 时输出 mp4，否则输出 ts
// task.doneParts 记录已合并的 item 数，暂停后从该位置继续 append
async function downloadM3U8(m3u8Url, outBase, referer, onProgress, task, depth = 0) {
  if (depth > 2) throw new Error('m3u8 嵌套层级过深');
  await guard(task);
  const text = await fetchText(m3u8Url, referer);
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  if (/#EXT-X-STREAM-INF/i.test(text)) {
    const idx = lines.findIndex(l => /#EXT-X-STREAM-INF/i.test(l));
    const sub = lines.slice(idx + 1).find(l => !/^#/.test(l));
    if (!sub) throw new Error('主播放列表里没有可用子流');
    return downloadM3U8(resolveU(m3u8Url, sub), outBase, referer, onProgress, task, depth + 1);
  }

  let initUrl = '';
  const map = /#EXT-X-MAP:URI=["']([^"']+)["']/i.exec(text);
  if (map) initUrl = resolveU(m3u8Url, map[1]);
  const segs = lines.filter(l => !/^#/.test(l)).map(l => resolveU(m3u8Url, l));
  if (!segs.length) throw new Error('m3u8 里没有可下载分片');

  const items = initUrl ? [initUrl, ...segs] : segs;
  const out = uniqueOut(outBase + (initUrl ? '.mp4' : '.ts'));
  const part = out + '.part';
  rememberPart(task, part);
  let done = Math.min(Number(task?.doneParts) || 0, items.length - 1);
  const fd = fs.openSync(part, done > 0 ? 'a' : 'w');
  try {
    for (let i = done; i < items.length; i++) {
      await guard(task);
      writeAll(fd, await fetchBuf(items[i], referer));
      done = i + 1;
      if (task) task.doneParts = done;
      if (onProgress) onProgress(Math.min(99, Math.round(done / items.length * 100)), '合并分片 ' + done + '/' + items.length);
    }
  } finally {
    fs.closeSync(fd);
  }
  await guard(task);
  if (fs.existsSync(out)) fs.unlinkSync(out);
  fs.renameSync(part, out);
  return out;
}

async function saveImages(images, dir, name, referer, onItem, task) {
  const sub = path.join(dir, name);
  fs.mkdirSync(sub, { recursive: true });
  const files = [];
  for (let i = 0; i < images.length; i++) {
    await guard(task);
    const out = path.join(sub, String(i + 1).padStart(3, '0') + extFromUrl(images[i]));
    if (fileSize(out) > 0) {
      files.push(out); // 暂停前已下好的图片直接复用
    } else {
      files.push(await curlSave(images[i], out, referer, null, task));
    }
    if (onItem) onItem(i + 1);
  }
  return files;
}

async function run({ dir, site, id, article, line, epIdx, onProgress, task }) {
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  await guard(task);
  if (!site) throw new Error('源不存在，请先在设置里选择站点');
  const dest = dir || defaultDir();
  if (!path.isAbsolute(dest)) throw new Error('下载路径必须是绝对路径，例如 D:\\Downloads');
  fs.mkdirSync(dest, { recursive: true });
  report(3, '获取资源信息…');

  const d = await spider.detail(site, id, { article: !!article });
  await guard(task);
  const name = safeName(d.name || id || 'download');
  const referer = refererOf(site);
  const files = [];

  const images = Array.isArray(d.images) ? d.images.filter(Boolean) : [];
  const text = typeof d.contentText === 'string' ? d.contentText : '';
  const kind = d.kind || 'video';
  const readable = article || kind === 'article' || kind === 'image'
    || (!Array.isArray(d.plays) || !d.plays.length) && (images.length > 0 || text.length > 0);

  if (readable) {
    const total = (text ? 1 : 0) + images.length || 1;
    let done = 0;
    const bump = n => report(Math.min(99, Math.round((done + n) / total * 100)), '保存文件');
    if (text) {
      const f = path.join(dest, name + '.txt');
      if (!fileSize(f)) fs.writeFileSync(f, text, 'utf8');
      files.push(f);
      done++; bump(0);
    }
    if (images.length) {
      files.push(...await saveImages(images, dest, name, referer, n => bump(n), task));
      done += images.length;
    }
    if (!files.length) throw new Error('该资源没有可下载的正文或图片');
    report(100, '已完成');
    return { ok: true, dir: dest, files };
  }

  const plays = Array.isArray(d.plays) ? d.plays : [];
  const pl = plays[Math.max(0, Number(line) || 0)] || plays[0];
  const eps = (pl && Array.isArray(pl.episodes)) ? pl.episodes : [];
  const ep = eps[Math.max(0, Number(epIdx) || 0)] || eps[0];
  await guard(task);
  if (!ep || !ep.url) throw new Error('该资源没有可下载的播放地址');

  const url = resolveU(referer || 'http://localhost/', ep.url);
  const base = path.join(dest, name + (ep.name ? '-' + safeName(ep.name) : ''));
  const out = /\.m3u8(\?|$)/i.test(url)
    ? await downloadM3U8(url, base, referer, report, task)
    : await curlSave(url, uniqueOut(base + '.mp4'), referer, report, task);
  files.push(out);
  report(100, '已完成');
  return { ok: true, dir: dest, files };
}

/* ---------------- 异步任务队列（顶部“下载”页数据源） ---------------- */
let tasks = [];
let seq = 0;
try {
  const arr = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  if (Array.isArray(arr)) {
    tasks = arr.slice(0, 100).map(t => {
      if (t.status === 'downloading' || t.status === 'paused') {
        t.status = 'error'; t.message = '应用已重启，下载中断'; t.finishedAt = t.finishedAt || Date.now();
      }
      return t;
    });
  }
} catch (_) {}
seq = tasks.length;

function publicTask(t) {
  const { ctrl, running, ...rest } = t || {};
  return { ...rest, bytes: taskBytes(t) };
}
function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks.slice(0, 100).map(publicTask), null, 2));
  } catch (_) {}
}
function find(id) { return tasks.find(t => t.id === id); }
function stopChild(t) { try { if (t.ctrl?.child) t.ctrl.child.kill(); } catch (_) {} }
function cleanupParts(t) {
  for (const p of t?.ctrl?.parts || []) {
    try { if (p && path.isAbsolute(p) && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
  }
  if (t?.ctrl) t.ctrl.parts = [];
}

function launch(t) {
  t.running = true;
  t.ctrl = { child: null, parts: [] };
  t.doneParts = 0;
  setImmediate(async () => {
    try {
      const r = await run({
        ...(t.req || {}),
        task: t,
        onProgress: (pct, msg) => {
          t.progress = Math.max(0, Math.min(99, Number(pct) || 0));
          if (msg) t.message = msg;
          t.bytes = taskBytes(t);
          persist();
        },
      });
      t.dir = r.dir; t.files = r.files;
      t.bytes = sumSizes(r.files);
      t.status = 'done'; t.progress = 100; t.message = '已完成';
    } catch (e) {
      if (!(e instanceof Stopped)) {
        t.status = 'error';
        t.message = e?.message || String(e);
      }
    }
    t.finishedAt = Date.now();
    t.running = false;
    t.ctrl = null;
    persist();
  });
}

function start(params) {
  if (!params.site) throw new Error('源不存在，请先在设置里选择站点');
  const id = 'd' + Date.now().toString(36) + '-' + (++seq);
  const t = {
    id,
    name: params.name || '未命名资源',
    siteKey: params.site.key || '',
    kind: params.kind || 'video',
    status: 'downloading',
    progress: 0,
    message: '准备中…',
    dir: params.dir || defaultDir(),
    files: [],
    bytes: 0,
    createdAt: Date.now(),
    finishedAt: 0,
    req: {
      dir: params.dir || '',
      site: params.site,
      id: params.id,
      article: !!params.article,
      line: params.line,
      epIdx: params.epIdx,
      name: params.name,
      kind: params.kind,
    },
  };
  tasks.unshift(t);
  if (tasks.length > 100) tasks.length = 100;
  persist();
  launch(t);
  return publicTask(t);
}

function pause(id) {
  const t = find(id);
  if (!t || t.status !== 'downloading') throw new Error('该任务不能暂停');
  t.status = 'paused'; t.message = '已暂停';
  stopChild(t); t.bytes = taskBytes(t); persist();
  return publicTask(t);
}

function resume(id) {
  const t = find(id);
  if (!t || t.status !== 'paused') throw new Error('该任务未暂停');
  t.status = 'downloading'; t.message = '继续下载…'; t.finishedAt = 0; persist();
  if (!t.running) launch(t); // curl 被 kill 后 run 已退出，需要重新调度续传
  return publicTask(t);
}

function cancel(id) {
  const t = find(id);
  if (!t || !['downloading', 'paused'].includes(t.status)) throw new Error('该任务不能取消');
  t.status = 'canceled'; t.message = '已取消'; t.finishedAt = Date.now();
  stopChild(t); t.bytes = taskBytes(t); cleanupParts(t); persist();
  return publicTask(t);
}

async function retry(id, site) {
  const t = find(id);
  if (!t) throw new Error('任务不存在');
  if (site && t.req) t.req.site = site;
  if (!t.req?.site) throw new Error('旧任务无法重试，请从详情里重新下载');
  // 先终止可能仍在运行的旧流程（暂停时可能卡在分片等待里），再从头重下
  t.status = 'canceled';
  stopChild(t); cleanupParts(t);
  const deadline = Date.now() + 1200;
  while (t.running && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  t.status = 'downloading'; t.progress = 0; t.message = '重新开始…';
  t.files = []; t.finishedAt = 0; t.doneParts = 0; t.bytes = 0;
  persist();
  launch(t);
  return publicTask(t);
}

function remove(id, withFiles) {
  const i = tasks.findIndex(t => t.id === id);
  if (i < 0) throw new Error('任务不存在');
  const t = tasks[i];
  if (t.status === 'downloading' || t.status === 'paused') { stopChild(t); cleanupParts(t); }
  if (withFiles) {
    for (const f of t.files || []) {
      try { if (typeof f === 'string' && path.isAbsolute(f) && fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
  }
  tasks.splice(i, 1);
  persist();
  return { ok: true };
}

function clearDone() {
  tasks = tasks.filter(t => t.status !== 'done');
  persist();
  return { ok: true };
}

async function control(op, id, opts = {}) {
  switch (op) {
    case 'pause': return pause(id);
    case 'resume': return resume(id);
    case 'cancel': return cancel(id);
    case 'retry': return retry(id, opts.site);
    case 'delete': return remove(id, !!opts.withFiles);
    case 'clearDone': return clearDone();
    default: throw new Error('未知操作：' + op);
  }
}

function list() { return tasks.map(publicTask); }

module.exports = { defaultDir, run, start, list, control };
