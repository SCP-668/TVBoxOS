'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { httpGet, rewriteM3U8, isHttpUrl, cacheClear, setNetworkAccel } = require('./util');
const spider = require('./spider');
const live = require('./live');
const read = require('./read');
const downloader = require('./download');
const { parseConfigText, mergeConfigs } = require('./configParser');

const PORT = Number(process.env.PORT || 32124);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.TVBOX_DATA || path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const ACCEL_FILE = path.join(DATA_DIR, 'netaccel.json');
const UI_DIR = path.join(__dirname, '..', 'ui');

fs.mkdirSync(DATA_DIR, { recursive: true });

// 网络加速开关状态（独立文件，不混入 config）
function loadAccel() {
  try { return { enabled: !!JSON.parse(fs.readFileSync(ACCEL_FILE, 'utf8')).enabled }; }
  catch { return { enabled: false }; }
}
setNetworkAccel(loadAccel().enabled);

const DEFAULT_CONFIG = {
  sites: [],
  lives: [],
  parses: [],
  reads: [],
  vodApiUrl: '',    // 点播配置地址（与直播互不干扰）
  liveApiUrl: '',   // 直播配置地址（与点播互不干扰）
};

const PRESET_FILE = path.join(__dirname, 'preset.json');
const SOURCES_FILE = path.join(__dirname, 'preset-sources.json');
// 用户数据目录里的接口清单/预置：优先使用；项目内不再内置任何接口数据
const USER_SOURCES_FILE = path.join(DATA_DIR, 'sources.json');
const USER_PRESET_FILE = path.join(DATA_DIR, 'preset.json');

// 接口清单：只读用户数据目录（首次启动时由安装包迁移过来），项目内预设为空
function loadSources() {
  try {
    const s = JSON.parse(fs.readFileSync(USER_SOURCES_FILE, 'utf8'));
    return { vod: Array.isArray(s.vod) ? s.vod : [], live: Array.isArray(s.live) ? s.live : [] };
  } catch { return { vod: [], live: [] }; }
}
function saveSources(s) {
  fs.writeFileSync(USER_SOURCES_FILE, JSON.stringify(s, null, 2));
  return s;
}
// 真正删除一条接口（vod/live），持久化到用户数据目录
function deleteSource(kind, url) {
  const s = loadSources();
  if (kind === 'vod' || kind === 'live') s[kind] = (s[kind] || []).filter(x => x.url !== url);
  return saveSources(s);
}

// 预置站点：只读用户数据目录；项目内 preset.json 为空（新安装不再内置）
function loadPreset() {
  try {
    const p = JSON.parse(fs.readFileSync(USER_PRESET_FILE, 'utf8'));
    if (p && Array.isArray(p.sites) && p.sites.length) return p;
  } catch {}
  return null;
}

function isPresetConfig(cfg) {
  const p = loadPreset();
  if (!p || !cfg || !Array.isArray(cfg.sites) || cfg.sites.length !== p.sites.length) return false;
  const keys = new Set(p.sites.map(s => s.key));
  return cfg.sites.every(s => keys.has(s.key));
}

function loadConfig() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch {
    const preset = loadPreset();
    cfg = preset
      ? { sites: preset.sites, lives: (preset.lives && preset.lives.length ? preset.lives : DEFAULT_CONFIG.lives), parses: preset.parses || [], reads: preset.reads || [], apiUrl: 'preset', vodApiUrl: 'preset', liveApiUrl: 'preset' }
      : { ...DEFAULT_CONFIG };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    return cfg;
  }
  // 老配置：站点集合与内置预置一致但没标记来源，自动打上 preset 标记
  if (!cfg.apiUrl && isPresetConfig(cfg)) {
    cfg.apiUrl = 'preset';
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch {}
  }
  // 老配置只有 apiUrl 一个地址：迁移成点播/直播各自的地址，但互不覆盖
  let migrated = false;
  if (cfg.apiUrl && cfg.vodApiUrl === undefined) { cfg.vodApiUrl = cfg.apiUrl === 'preset' ? 'preset' : cfg.apiUrl; migrated = true; }
  if (cfg.liveApiUrl === undefined) { cfg.liveApiUrl = cfg.apiUrl === 'preset' ? 'preset' : (cfg.apiUrl || ''); migrated = true; }
  // 老配置补 reads 字段
  if (!Array.isArray(cfg.reads)) { cfg.reads = []; migrated = true; }
  if (migrated) { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch {} }
  return cfg;
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}
function siteByKey(cfg, key) { return cfg.sites.find(s => s.key === key); }

// 按作用域把解析结果合并进现有配置：只动对应的那一侧，另一侧原样保留。
// scope: 'vod' | 'live' | 'all'（all 仅用于兼容旧的整包导入）
function mergeConfigScoped(base, parsed, scope, apiUrl) {
  scope = ['vod', 'live'].includes(scope) ? scope : 'all';
  if (scope === 'vod') {
    return {
      ...base,
      sites: parsed.sites,
      parses: parsed.parses,
      reads: parsed.reads || base.reads || [],
      vodApiUrl: apiUrl || base.vodApiUrl || '',
      apiUrl: apiUrl || base.apiUrl || '',
    };
  }
  if (scope === 'live') {
    return {
      ...base,
      lives: parsed.lives,
      liveApiUrl: apiUrl || base.liveApiUrl || '',
    };
  }
  // all：兼容旧调用，整包替换
  return {
    ...base,
    sites: parsed.sites,
    lives: parsed.lives,
    parses: parsed.parses,
    reads: parsed.reads || base.reads || [],
    apiUrl: apiUrl || '',
    vodApiUrl: apiUrl || '',
    liveApiUrl: apiUrl || '',
  };
}

// 递归抓取订阅（含 urls 子订阅），返回规范化后的配置。
// meta.rawText 记录顶层订阅接口返回的原始文本（即"接入的接口文档里的 JSON"），供前端配置历史展示。
async function fetchSubscription(url, seen = new Set(), depth = 0, meta = {}) {
  if (depth > 3 || seen.has(url)) return { sites: [], lives: [], parses: [] };
  seen.add(url);
  const r = await httpGet(url, { timeout: 25000, ua: '', raw: true });
  if (!r.ok) throw new Error(`抓取失败 HTTP ${r.status}: ${url}`);
  if (depth === 0) meta.rawText = r.text;
  console.log('[import] 抓取', url, '长度', r.text.length, '片段', r.text.replace(/\s+/g, ' ').slice(0, 100));
  const parsed = parseConfigText(r.text);
  let all = { sites: parsed.sites, lives: parsed.lives, parses: parsed.parses, reads: parsed.reads || [] };
  for (const sub of parsed.urls) {
    try {
      const child = await fetchSubscription(sub, seen, depth + 1);
      all = mergeConfigs([all, child]);
    } catch (e) { console.error('[sub]', sub, e.message); }
  }
  return all;
}

// 只保留 PC 端爬虫能跑的站点：type 0/1 且 api 为 http(s) 地址。
// type 3 的 csp_*/js_* 依赖安卓端 csp/drpy 运行时，PC 无对应实现，导入时跳过并计数。
function pruneSites(sites) {
  const ok = [], skipped = [];
  for (const s of sites || []) {
    if ((s.type === 0 || s.type === 1) && isHttpUrl(s.api)) ok.push(s);
    else skipped.push(s.name || s.key || s.api);
  }
  return { ok, skipped };
}

// 从直播订阅地址提取直播源列表。直播接口通常直接是 m3u/txt 播放列表（不是 TVBox JSON），
// 因此这里把地址本身登记为一条直播源；若返回内容恰好是含 lives 的 TVBox 配置则按其 lives 解析。
function liveSourcesFrom(url, text, nameHint) {
  try {
    const parsed = parseConfigText(text);
    if (parsed.lives && parsed.lives.length) return parsed.lives;
  } catch {}
  // m3u / txt 播放列表：把订阅地址本身作为一条直播源
  const name = (nameHint || '').trim() || (() => { try { return new URL(url).hostname; } catch { return '直播源'; } })();
  const key = 'live_' + Buffer.from(url).toString('base64url').slice(0, 12);
  return [{ key, name, url, ua: '' }];
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function err(res, e) { send(res, 500, { error: e?.message || String(e) }); }

async function handle(req, res) {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = u.pathname;
  const q = u.searchParams;

  // ---- 静态前端 ----
  if (p === '/' || p === '/index.html') {
    const html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
    return send(res, 200, html, 'text/html; charset=utf-8');
  }
  if (p.startsWith('/static/')) {
    const name = path.basename(p);
    const file = path.join(UI_DIR, name);
    if (fs.existsSync(file)) {
      const ext = path.extname(file);
      const type = ext === '.js' ? 'application/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
      return send(res, 200, fs.readFileSync(file), type);
    }
    return send(res, 404, 'not found', 'text/plain');
  }

  try {
    // ---- 配置 ----
    if (p === '/api/config' && req.method === 'GET') return send(res, 200, loadConfig());
    // 网络加速开关：读取 / 切换（开启走系统代理，关闭走直连）
    if (p === '/api/netaccel' && req.method === 'GET') return send(res, 200, loadAccel());
    if (p === '/api/netaccel' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      let enabled = false;
      try { enabled = !!JSON.parse(body).enabled; } catch {}
      try { fs.writeFileSync(ACCEL_FILE, JSON.stringify({ enabled }, null, 2)); } catch {}
      setNetworkAccel(enabled);
      return send(res, 200, { enabled });
    }
    // 接入的接口清单（点播/直播订阅地址），供配置历史逐条展示
    if (p === '/api/config/sources' && req.method === 'GET') return send(res, 200, loadSources());
    // 本地接口快照（如从猫影视 open99 恢复的站点）：作为可被标准 import 流程读取的订阅源
    // 数据只存用户数据目录，项目/安装包内不内置；删除清单项不影响此读取器
    if (p === '/api/config/local/open99' && req.method === 'GET') {
      try { return send(res, 200, fs.readFileSync(path.join(DATA_DIR, 'open99-local.json'), 'utf8')); }
      catch { return send(res, 404, { error: '本地接口配置不存在' }); }
    }
    // 真正删除一条接口：从用户数据目录持久化移除（不是隐藏）
    if (p === '/api/config/sources/delete' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      let kind, url;
      try { ({ kind, url } = JSON.parse(body)); } catch {}
      if (!url || (kind !== 'vod' && kind !== 'live')) return send(res, 400, { error: '参数错误' });
      return send(res, 200, deleteSource(kind, url));
    }
    if (p === '/api/config' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      return send(res, 200, saveConfig(JSON.parse(body)));
    }
    // 一键恢复内置预置源（保留用户自己的解析地址）
    if (p === '/api/config/preset' && req.method === 'GET') {
      const preset = loadPreset();
      if (!preset) return send(res, 404, { error: '安装包里没有内置预置' });
      const cur = loadConfig();
      const cfg = saveConfig({
        sites: preset.sites,
        lives: (preset.lives && preset.lives.length ? preset.lives : DEFAULT_CONFIG.lives),
        parses: cur.parses || [],
        apiUrl: 'preset',
        vodApiUrl: 'preset',
        liveApiUrl: 'preset',
      });
      return send(res, 200, Object.assign({ restored: true }, cfg));
    }
    // 从订阅 URL 导入配置（支持 urls 子订阅递归）
    // scope=vod 只更新点播源 / scope=live 只更新直播源，另一侧保持不动；缺省 all 兼容旧调用
    if (p === '/api/config/import' && req.method === 'GET') {
      const url = q.get('url');
      const scope = q.get('scope') || 'all';
      if (!url || !isHttpUrl(url)) return send(res, 400, { error: '订阅地址不合法' });
      const cur = loadConfig();
      if (scope === 'live') {
        // 直播接口：抓取内容，登记为直播源，只动 lives
        const r = await httpGet(url, { timeout: 25000, ua: '', raw: true });
        if (!r.ok) return send(res, 400, { error: `抓取失败 HTTP ${r.status}: ${url}` });
        const lives = liveSourcesFrom(url, r.text, q.get('name'));
        if (!lives.length) return send(res, 400, { error: '未从直播地址解析到任何直播源' });
        const cfg = saveConfig(mergeConfigScoped(cur, { lives }, 'live', url));
        return send(res, 200, { ...cfg, scope, rawText: r.text });
      }
      const meta = {};
      const parsed = await fetchSubscription(url, new Set(), 0, meta);
      const pr = pruneSites(parsed.sites);
      const reads = (parsed.reads || []).filter(r => read.supported(r));
      if (scope === 'vod') {
        if (!pr.ok.length && !reads.length) return send(res, 400, { error: `订阅里没有 PC 端可用的点播源或小说源（跳过 ${pr.skipped.length} 个需安卓爬虫运行时的站点）` });
        const cfg = saveConfig(mergeConfigScoped(cur, { sites: pr.ok, parses: parsed.parses, reads }, 'vod', url));
        return send(res, 200, { ...cfg, scope, skipped: pr.skipped.length, rawText: meta.rawText || '' });
      }
      if (!pr.ok.length && !parsed.lives.length && !reads.length) {
        return send(res, 400, { error: `订阅里没有 PC 端可用的点播源、直播源或小说源（跳过 ${pr.skipped.length} 个需安卓爬虫运行时的站点）` });
      }
      const cfg = saveConfig(mergeConfigScoped(cur, { sites: pr.ok, lives: parsed.lives, parses: parsed.parses, reads }, 'all', url));
      return send(res, 200, { ...cfg, scope, skipped: pr.skipped.length, rawText: meta.rawText || '' });
    }
    // 直接粘贴订阅 JSON 文本导入（scope 同上）
    if (p === '/api/config/parse' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      const scope = q.get('scope') || 'all';
      const cur = loadConfig();
      if (scope === 'live') {
        const lives = liveSourcesFrom(q.get('url') || '', body, q.get('name'));
        if (!lives.length) return send(res, 400, { error: '文本里没有可识别的直播源' });
        const cfg = saveConfig(mergeConfigScoped(cur, { lives }, 'live', q.get('url') || 'pasted:live'));
        return send(res, 200, { ...cfg, scope });
      }
      const parsed = parseConfigText(body);
      const pr = pruneSites(parsed.sites);
      const reads = (parsed.reads || []).filter(r => read.supported(r));
      if (scope === 'vod') {
        if (!pr.ok.length && !reads.length) return send(res, 400, { error: `文本里没有 PC 端可用的点播源或小说源（跳过 ${pr.skipped.length} 个需安卓爬虫运行时的站点）` });
        const cfg = saveConfig(mergeConfigScoped(cur, { sites: pr.ok, parses: parsed.parses, reads }, 'vod', 'pasted:vod'));
        return send(res, 200, { ...cfg, scope, skipped: pr.skipped.length });
      }
      if (!pr.ok.length && !parsed.lives.length && !reads.length) {
        return send(res, 400, { error: `文本里没有 PC 端可用的点播源、直播源或小说源（跳过 ${pr.skipped.length} 个需安卓爬虫运行时的站点）` });
      }
      const cfg = saveConfig(mergeConfigScoped(cur, { sites: pr.ok, lives: parsed.lives, parses: parsed.parses, reads }, 'all', 'pasted:all'));
      return send(res, 200, { ...cfg, scope, skipped: pr.skipped.length });
    }
    // 清空缓存（原版“清空缓存”：清掉站点/直播抓取缓存，回主页重新加载）
    // ---- 本地下载：详情弹窗“下载”按钮，路径由设置页提供 ----
    if (p === '/api/download/defaultDir') return send(res, 200, { dir: downloader.defaultDir() });
    if (p === '/api/download/tasks') return send(res, 200, { tasks: downloader.list() });
    if (p === '/api/download/control') {
      const cfg = loadConfig();
      const r = await downloader.control(q.get('op') || '', q.get('id') || '', {
        withFiles: q.get('files') === '1',
        site: siteByKey(cfg, q.get('siteKey') || ''),
      });
      return send(res, 200, { ok: true, result: r });
    }
    if (p === '/api/download/start') {
      const cfg = loadConfig();
      const t = downloader.start({
        dir: q.get('dir') || '',
        site: siteByKey(cfg, q.get('siteKey') || ''),
        id: q.get('id') || '',
        article: q.get('article') === '1',
        line: q.get('line'),
        epIdx: q.get('epIdx'),
        name: q.get('name') || '',
        kind: q.get('kind') || '',
      });
      return send(res, 200, t);
    }
    if (p === '/api/download') {
      const cfg = loadConfig();
      const r = await downloader.run({
        dir: q.get('dir') || '',
        site: siteByKey(cfg, q.get('siteKey') || ''),
        id: q.get('id') || '',
        article: q.get('article') === '1',
        line: q.get('line'),
        epIdx: q.get('epIdx'),
      });
      return send(res, 200, r);
    }
    if (p === '/api/cache/clear' && req.method === 'POST') {
      const n = cacheClear();
      return send(res, 200, { ok: true, cleared: n });
    }

    // ---- 直播 ----
    if (p === '/api/live/playlist') {
      const cfg = loadConfig();
      const key = q.get('key');
      const liveCfg = key ? cfg.lives.find(l => l.key === key) : null;
      if (!liveCfg) return send(res, 400, { error: '未找到直播源: ' + key });
      const data = await live.loadPlaylist(liveCfg, q.get('force') === '1');
      return send(res, 200, data);
    }
    // m3u8/媒体代理：把相对地址改写成本地代理地址，绕开 CORS 且可带 UA
    if (p === '/api/live/stream' || p === '/api/proxy') {
      const target = q.get('url');
      if (!target || !isHttpUrl(target)) return send(res, 400, { error: '缺少合法 url 参数' });
      const cfg = loadConfig();
      // 优先用配置里对应源的 UA
      let ua = '';
      for (const l of cfg.lives) { if (target.startsWith(new URL(l.url).origin)) { ua = l.ua; break; } }
      let r = await httpGet(target, { raw: true, timeout: 20000, ua: ua || undefined });
      // 图文正文图片(img=1)：部分图床 https 被 CDN 拦(521)、http 可用，失败时降级重试一次
      if (!r.ok && q.get('img') === '1' && target.startsWith('https://')) {
        r = await httpGet('http://' + target.slice(8), { raw: true, timeout: 20000, ua: ua || undefined });
      }
      if (!r.ok) return send(res, 502, { error: `上游返回 ${r.status}` });
      const ct = r.headers['content-type'] || '';
      if (/mpegurl|m3u8/i.test(ct) || /\.m3u8(\?|$)/i.test(target)) {
        const purify = q.get('purify') === '1';
        const base = `${p === '/api/proxy' ? '/api/proxy' : '/api/live/stream'}?${purify ? 'purify=1&' : ''}url=`;
        const text = rewriteM3U8(r.text, r.url || target, base, purify);
        return send(res, 200, text, 'application/vnd.apple.mpegurl; charset=utf-8', { 'Access-Control-Allow-Origin': '*' });
      }
      const safe = ['content-type', 'accept-ranges', 'content-range', 'etag', 'last-modified'];
      const extra = { 'Access-Control-Allow-Origin': '*' };
      for (const k of safe) if (r.headers[k]) extra[k] = r.headers[k];
      // 图文/图片图集(img=1)：缩略图与灯箱放大用同一地址，缓存一段时间避免点击放大重复回源加载
      if (q.get('img') === '1') extra['Cache-Control'] = 'public, max-age=1800';
      return send(res, 200, r.buf, ct || 'application/octet-stream', extra);
    }

    // ---- 点播 ----
    if (p === '/api/vod/home') {
      const cfg = loadConfig(); const s = siteByKey(cfg, q.get('key'));
      if (!s) return send(res, 400, { error: '未找到点播源' });
      return send(res, 200, await spider.home(s));
    }
    if (p === '/api/vod/category') {
      const cfg = loadConfig(); const s = siteByKey(cfg, q.get('key'));
      if (!s) return send(res, 400, { error: '未找到点播源' });
      return send(res, 200, await spider.category(s, q.get('tid'), q.get('pg') || 1));
    }
    if (p === '/api/vod/search') {
      const cfg = loadConfig();
      const wd = q.get('wd') || '';
      const keys = q.get('key') ? [q.get('key')] : cfg.sites.filter(s => s.searchable !== 0).map(s => s.key);
      const results = [];
      for (const key of keys) {
        const s = siteByKey(cfg, key); if (!s) continue;
        try { results.push(await spider.search(s, wd, q.get('pg') || 1)); }
        catch (e) { results.push({ siteKey: key, videos: [], error: e.message }); }
      }
      return send(res, 200, { keyword: wd, results });
    }
    if (p === '/api/vod/detail') {
      const cfg = loadConfig(); const s = siteByKey(cfg, q.get('key'));
      if (!s) return send(res, 400, { error: '未找到点播源' });
      return send(res, 200, await spider.detail(s, q.get('id'), { article: q.get('article') === '1' }));
    }
    // 图文/图片条目封面：列表是纯文字无缩略图，取详情正文首图。
    // 图床 https 常被 CDN 拦(521)、http 可用，故由服务端带 UA 取图并原样返回，https 失败自动降级 http。
    if (p === '/api/vod/cover') {
      const cfg = loadConfig(); const s = siteByKey(cfg, q.get('key'));
      const transparent = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
      if (!s) return send(res, 200, transparent, 'image/gif');
      try {
        const pic = await spider.cover(s, q.get('id'));
        if (pic && isHttpUrl(pic)) {
          const urls = [pic];
          if (pic.startsWith('https://')) urls.push('http://' + pic.slice(8));
          for (const u of urls) {
            const r = await httpGet(u, { raw: true, timeout: 12000 });
            if (r.ok && r.buf && r.buf.length) {
              const ct = r.headers['content-type'] || 'image/jpeg';
              return send(res, 200, r.buf, ct, { 'Cache-Control': 'public, max-age=1800' });
            }
          }
        }
      } catch (_) {}
      return send(res, 200, transparent, 'image/gif');
    }

    // ---- 小说/听书 ----
    function readByKey(cfg, key) { return (cfg.reads || []).find(s => s.key === key); }
    if (p === '/api/read/sites') {
      const cfg = loadConfig();
      return send(res, 200, (cfg.reads || []).filter(s => read.supported(s)));
    }
    if (p === '/api/read/home') {
      const cfg = loadConfig(); const s = readByKey(cfg, q.get('key'));
      if (!s) return send(res, 400, { error: '未找到小说源' });
      return send(res, 200, await read.home(s));
    }
    if (p === '/api/read/category') {
      const cfg = loadConfig(); const s = readByKey(cfg, q.get('key'));
      if (!s) return send(res, 400, { error: '未找到小说源' });
      return send(res, 200, await read.category(s, q.get('tid'), q.get('pg') || 1));
    }
    if (p === '/api/read/search') {
      const cfg = loadConfig();
      const wd = q.get('wd') || '';
      const keys = q.get('key') ? [q.get('key')] : (cfg.reads || []).filter(s => read.supported(s)).map(s => s.key);
      const results = [];
      for (const key of keys) {
        const s = readByKey(cfg, key); if (!s) continue;
        try { results.push(await read.search(s, wd, q.get('pg') || 1)); }
        catch (e) { results.push({ siteKey: key, videos: [], error: e.message }); }
      }
      return send(res, 200, { keyword: wd, results });
    }
    if (p === '/api/read/detail') {
      const cfg = loadConfig(); const s = readByKey(cfg, q.get('key'));
      if (!s) return send(res, 400, { error: '未找到小说源' });
      return send(res, 200, await read.detail(s, q.get('id')));
    }

    // ---- 本地文件（对应原版 LocalFileActivity）----
    const VIDEO_EXT = /\.(mp4|mkv|avi|mov|flv|wmv|m4v|ts|rmvb|rm|3gp|webm|m3u8)$/i;
    // 常见视频根目录（Windows: 各盘符 + 用户视频/桌面/下载）
    if (p === '/api/file/roots') {
      const roots = [];
      for (const d of ['C', 'D', 'E', 'F', 'G', 'H']) {
        const drv = d + ':\\';
        try { if (fs.existsSync(drv)) roots.push({ name: d + '盘', path: drv }); } catch {}
      }
      for (const sub of ['Videos', 'Desktop', 'Downloads', '桌面', '下载', '视频']) {
        const dir = path.join(process.env.USERPROFILE || '', sub);
        try { if (fs.existsSync(dir)) roots.push({ name: sub, path: dir }); } catch {}
      }
      return send(res, 200, { roots });
    }
    // 列目录：只显示目录 + 视频文件
    if (p === '/api/file/list') {
      let dir = q.get('path') || '';
      if (!dir) {
        const up = process.env.USERPROFILE || '';
        dir = path.join(up, 'Videos');
        if (!fs.existsSync(dir)) dir = up;
      }
      // 安全：限制在真实存在的绝对路径
      if (!path.isAbsolute(dir) || !fs.existsSync(dir)) return send(res, 400, { error: '目录不存在: ' + dir });
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true }).map(e => {
          const full = path.join(dir, e.name);
          let size = 0;
          try { if (e.isFile()) size = fs.statSync(full).size; } catch {}
          return {
            name: e.name,
            path: full,
            dir: e.isDirectory(),
            video: e.isFile() && VIDEO_EXT.test(e.name),
            size,
          };
        }).filter(e => e.dir || e.video);
        entries.sort((a, b) => (a.dir === b.dir) ? a.name.localeCompare(b.name, 'zh') : (a.dir ? -1 : 1));
      } catch (e) { return send(res, 400, { error: '无法读取目录: ' + e.message }); }
      const parent = path.dirname(dir);
      return send(res, 200, { path: dir, parent: parent !== dir ? parent : '', entries });
    }
    // 本地视频流（支持 Range 拖动进度）
    if (p === '/api/file/stream') {
      let file = q.get('path') || '';
      if (!file || !path.isAbsolute(file) || !fs.existsSync(file)) return send(res, 404, { error: '文件不存在' });
      let stat;
      try { stat = fs.statSync(file); } catch (e) { return send(res, 400, { error: e.message }); }
      const ext = path.extname(file).toLowerCase();
      const type = ext === '.mp4' ? 'video/mp4' : ext === '.mkv' ? 'video/x-matroska'
        : ext === '.webm' ? 'video/webm' : ext === '.m3u8' ? 'application/vnd.apple.mpegurl'
        : /\.m3u8$/i.test(file) ? 'application/vnd.apple.mpegurl' : 'video/mp4';
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        if (m) {
          const start = parseInt(m[1], 10);
          const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
          if (start >= 0 && end >= start && start < stat.size) {
            res.writeHead(206, {
              'Content-Type': type,
              'Content-Range': `bytes ${start}-${end}/${stat.size}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': end - start + 1,
              'Cache-Control': 'no-store',
            });
            return fs.createReadStream(file, { start, end }).pipe(res);
          }
        }
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }

    return send(res, 404, { error: 'api not found: ' + p });
  } catch (e) {
    console.error('[service]', p, e);
    err(res, e);
  }
}

const server = http.createServer((req, res) => { handle(req, res); });
server.listen(PORT, HOST, () => console.log(`TVBox-PC service listening http://${HOST}:${PORT}`));
