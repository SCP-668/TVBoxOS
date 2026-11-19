'use strict';
// TVBox 订阅配置健壮解析器
// 兼容：标准 JSON / 带 // 和 /* */ 注释的 JSONC / 字段名变体 / 单引号 / 尾逗号 / urls 子订阅引用

// 去除 JSON 注释，但保留字符串内的 // 和 /* */
function stripJsonComments(s) {
  let out = '', i = 0, inStr = false, quote = '';
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += s[i + 1] || ''; i += 2; continue; }
      if (c === quote) inStr = false;
      i++; continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; out += c; i++; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

// 从任意文本里提取所有平衡的 {...} / [...] 候选块（长块优先）
// 用于从 Markdown 页面、HTML、带说明文字的订阅里抠出真正的配置 JSON
function extractJsonCandidates(s) {
  const cands = [];
  for (const [o, c] of [['{', '}'], ['[', ']']]) {
    let i = 0;
    while (i < s.length) {
      const st = s.indexOf(o, i);
      if (st < 0) break;
      let depth = 0, inStr = false, quote = '', esc = false, end = -1;
      for (let j = st; j < s.length; j++) {
        const ch = s[j];
        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === quote) inStr = false;
          continue;
        }
        if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
        if (ch === o) depth++;
        else if (ch === c) { depth--; if (depth === 0) { end = j; break; } }
      }
      if (end > st) cands.push(s.slice(st, end + 1));
      i = st + 1;
    }
  }
  return cands.sort((a, b) => b.length - a.length);
}

function tryParseJson(t) {
  // 部分订阅会在 JSON 里夹裸的 Markdown 标记行（## json / ## 切片 / ## dr 等），
  // 安卓端 TVBox 会跳过，这里同样整行剔除后再解析
  const noMd = String(t).split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');
  let s = stripJsonComments(noMd).replace(/,\s*([}\]])/g, '$1').trim();
  try { return JSON.parse(s); } catch (e) {}
  // 单引号字符串转双引号（保守处理：仅在值位置）
  try { return JSON.parse(s.replace(/:'((?:\\.|[^'\\])*)'/g, (m, v) => ':"' + v.replace(/"/g, '\\"') + '"')); } catch (e) {}
  return null;
}

function toJson(text) {
  if (!text || typeof text !== 'string') throw new Error('订阅内容为空');
  let s = text.replace(/^\uFEFF/, '').trim();

  // 1) 整段直接解析（标准 JSON / JSONC / 尾逗号已有外层包裹的情况）
  let r = tryParseJson(s);
  if (r) return r;

  // 2) 去掉外层 HTML 标签后再试（<pre>{...}</pre> 之类）
  const stripped = s.replace(/<[^>]+>/g, '').trim();
  if (stripped !== s) { r = tryParseJson(stripped); if (r) return r; }

  // 3) base64 订阅（少数站点整段 base64）
  if (/^[A-Za-z0-9+/=\r\n]{40,}$/.test(s)) {
    try {
      const dec = Buffer.from(s.replace(/\s/g, ''), 'base64').toString('utf8');
      r = tryParseJson(dec); if (r) return r;
      for (const c of extractJsonCandidates(dec)) { r = tryParseJson(c); if (r && (r.sites || r.site || r.lives || r.live || Array.isArray(r))) return r; }
    } catch (e) {}
  }

  // 4) 从候选块里逐个尝试（Markdown 页面 ```json 代码块、说明文字里的配置片段等）
  for (const c of extractJsonCandidates(s)) {
    r = tryParseJson(c);
    if (r && typeof r === 'object' && (r.sites || r.site || r.lives || r.live || r.urls || Array.isArray(r))) return r;
  }

  // 5) 彻底失败：给出内容片段，方便定位是"网页地址"还是"源站失效"
  const snippet = s.replace(/\s+/g, ' ').slice(0, 140);
  const hint = /<html|<!doctype|##\s/i.test(s) ? '（看起来是网页，请改用 raw 原始文件地址）' : '';
  throw new Error('订阅内容里没有可识别的配置 JSON' + hint + '。抓取片段：' + snippet);
}

const arr = (v) => Array.isArray(v) ? v : (v ? [v] : []);
const str = (v) => (v == null ? '' : String(v).trim());

function normalizeSite(x) {
  if (!x || typeof x !== 'object') return null;
  const api = str(x.api || x.url || x.u || x.address);
  const name = str(x.name || x.title || '') || '未命名';
  const key = str(x.key || x.id) || (name + '_' + api).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').slice(0, 24);
  if (!api) return null;
  const o = { key, name, api, type: x.type != null ? Number(x.type) : 0 };
  if (x.ext !== undefined) o.ext = x.ext;
  if (x.searchable !== undefined) o.searchable = Number(x.searchable);
  return o;
}

function normalizeLive(x) {
  if (!x || typeof x !== 'object') return null;
  const url = str(x.url || x.u || x.address);
  const name = str(x.name || x.title || '') || '未命名';
  const key = str(x.key || x.id || x.group || name).replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '') || ('live_' + url.length);
  if (!url) return null;
  return { key, name, url, ua: str(x.ua || x.userAgent || '') };
}

function normalizeParse(x) {
  if (!x || typeof x !== 'object') return null;
  return { key: str(x.key || x.id || x.name), name: str(x.name || x.title || x.key), url: str(x.url || x.api || x.u), type: x.type != null ? Number(x.type) : 0 };
}

// 小说/听书源：猫影视 read.sites，用 api(cat.js 文件名) 作为 key 线索，PC 端原生适配
function normalizeRead(x) {
  if (!x || typeof x !== 'object') return null;
  const api = str(x.api || x.url || '');
  const name = str(x.name || x.title || '') || '未命名';
  const key = str(x.key || x.id) || (name + '_' + api).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').slice(0, 24);
  if (!api && !key) return null;
  // 保留 api 文件名（如 bookan_open.js）用于匹配原生实现
  return { key, name, api, type: x.type != null ? Number(x.type) : 10, driver: api.replace(/_open\.js$/, '').replace(/\.js$/, '') };
}

// 解析订阅文本 → 规范化配置；urls 字段为需要继续抓取的子订阅地址
function parseConfigText(text) {
  let cfg = toJson(text);

  // 少数订阅把配置包在 config/data 字段里
  if (cfg && typeof cfg === 'object') {
    if (cfg.config && typeof cfg.config === 'object') cfg = cfg.config;
    else if (cfg.data && typeof cfg.data === 'object' && (cfg.data.sites || cfg.data.site)) cfg = cfg.data;
  }

  // 整个配置就是一个数组 → 当作 sites
  if (Array.isArray(cfg)) cfg = { sites: cfg };
  if (!cfg || typeof cfg !== 'object') throw new Error('订阅格式无法识别');

  const siteSrc = cfg.sites || cfg.site || (cfg.video && cfg.video.sites);
  const sites = arr(siteSrc).map(normalizeSite).filter(Boolean);
  const lives = arr(cfg.lives || cfg.live).map(normalizeLive).filter(Boolean);
  const parses = arr(cfg.parses || cfg.parse).map(normalizeParse).filter(Boolean);
  // 猫影视嵌套结构：video.sites / read.sites / pan.sites
  const reads = arr((cfg.read && cfg.read.sites) || cfg.reads).map(normalizeRead).filter(Boolean);
  // 多仓订阅里 urls 可能是字符串数组，也可能是 {url,name} 对象数组
  const urls = arr(cfg.urls || cfg.url)
    .map(u => (u && typeof u === 'object' ? str(u.url || u.u || u.api || '') : str(u)))
    .filter(u => /^https?:\/\//i.test(u));

  return { sites, lives, parses, reads, urls };
}

// 合并多份配置，按 key + 地址去重
function mergeConfigs(list) {
  const sites = [], lives = [], parses = [], reads = [];
  const sk = new Set(), lk = new Set(), pk = new Set(), rk = new Set();
  for (const c of list) {
    for (const s of c.sites || []) { const k = s.key + '|' + s.api; if (!sk.has(k)) { sk.add(k); sites.push(s); } }
    for (const l of c.lives || []) { const k = l.key + '|' + l.url; if (!lk.has(k)) { lk.add(k); lives.push(l); } }
    for (const p of c.parses || []) { const k = p.key + '|' + p.url; if (!pk.has(k)) { pk.add(k); parses.push(p); } }
    for (const r of c.reads || []) { const k = r.key + '|' + r.api; if (!rk.has(k)) { rk.add(k); reads.push(r); } }
  }
  return { sites, lives, parses, reads };
}

module.exports = { parseConfigText, mergeConfigs, stripJsonComments, toJson };
