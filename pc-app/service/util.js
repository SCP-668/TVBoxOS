'use strict';
// 通用工具：HTTP 请求（用系统 curl 后端，自动遵循代理环境变量）、缓存、M3U 处理、轻量 XML 解析
// 只依赖 Node 内置能力 + 系统 curl（Win10+ 自带），不依赖 native 模块

const { spawn } = require('node:child_process');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const cache = new Map();
let cacheBytes = 0;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

function cacheGet(key) {
  const it = cache.get(key);
  if (!it) return undefined;
  if (Date.now() > it.expire) { cache.delete(key); cacheBytes -= it.bytes; return undefined; }
  return it.value;
}
function cacheSet(key, value, ttlMs = 5 * 60 * 1000) {
  const bytes = typeof value === 'string' ? Buffer.byteLength(value) : 4096;
  if (cacheBytes + bytes > MAX_CACHE_BYTES) {
    for (const [k, v] of cache) {
      if (Date.now() > v.expire) { cache.delete(k); cacheBytes -= v.bytes; }
      if (cacheBytes + bytes <= MAX_CACHE_BYTES) break;
    }
  }
  const old = cache.get(key);
  if (old) cacheBytes -= old.bytes;
  cache.set(key, { value, expire: Date.now() + ttlMs, bytes });
  cacheBytes += bytes;
}

// 用 curl 发请求：优先直连 → 走代理，带重试。body 走 stdout，元数据走 -w 分隔符。
const META = '\n__TVBOX_META__'; // 后面跟 http_code|content_type|final_url
async function curlFetchRaw(url, args, perTimeout) {
  const full = [
    '-sS', '-L', '--compressed', '--max-time', String(Math.ceil(perTimeout / 1000)),
    '-A', args.ua || DEFAULT_UA,
    ...(args.headers || []),
    '-w', META + '%{http_code}|%{content_type}|%{url_effective}',
  ];
  const attempts = [
    ['--noproxy', '*', ...full, url],
    [...full, url],
    ['--noproxy', '*', ...full, url],
  ];
  let lastErr;
  for (const att of attempts) {
    try {
      const buf = await new Promise((resolve, reject) => {
        let child;
        try { child = spawn('curl', att, { windowsHide: true }); }
        catch (e) { return reject(e); }
        const chunks = [], errs = [];
        child.stdout.on('data', c => chunks.push(c));
        child.stderr.on('data', c => errs.push(c));
        child.on('error', reject);
        const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('curl timeout')); }, perTimeout + 2500);
        child.on('close', code => {
          clearTimeout(timer);
          if (code !== 0) return reject(new Error('curl ' + code + ': ' + Buffer.concat(errs).toString('utf8').slice(0, 140)));
          resolve(Buffer.concat(chunks));
        });
      });
      const metaBuf = Buffer.from(META, 'latin1');
      const mi = buf.lastIndexOf(metaBuf);
      if (mi < 0) throw new Error('curl meta missing');
      const body = buf.subarray(0, mi);
      const meta = buf.subarray(mi + metaBuf.length).toString('utf8').trim();
      const [codeStr, ctype = '', finalUrl = url] = meta.split('|');
      const status = parseInt(codeStr, 10) || 0;
      // 空 body 视为失败（代理有时只回 CONNECT 头就 code 0）
      if (status >= 200 && status < 300 && body.length === 0) throw new Error('empty body');
      return { status, ctype, finalUrl, body };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('curl failed');
}

async function httpGet(url, opts = {}) {
  const { headers = {}, timeout = 15000, ua = DEFAULT_UA, cacheMs = 0, raw = false } = opts;
  const ck = 'http:' + url + '|' + (raw ? 'raw' : 'text');
  if (cacheMs > 0) { const hit = cacheGet(ck); if (hit) return hit; }
  const headerArgs = Object.entries(headers).map(([k, v]) => '-H ' + k + ': ' + v).length
    ? Object.entries(headers).flatMap(([k, v]) => ['-H', k + ': ' + v]) : [];
  const r = await curlFetchRaw(url, { ua, headers: headerArgs }, Math.min(timeout, 12000));
  const result = {
    ok: r.status >= 200 && r.status < 300, status: r.status, url: r.finalUrl,
    text: r.body.toString('utf8'), buf: r.body,
    headers: { 'content-type': r.ctype },
  };
  if (cacheMs > 0 && result.ok) cacheSet(ck, raw ? result : result.text, cacheMs);
  return raw ? result : result.text;
}

function absoluteUrl(href, base) {
  if (!href) return '';
  try { return new URL(href.trim(), base).href; } catch { return href.trim(); }
}
function isHttpUrl(s) { return /^https?:\/\//i.test(String(s || '').trim()); }

function parseSimpleXml(xml) {
  const text = String(xml || '').replace(/<\?xml[\s\S]*?\?>/gi, '');
  const nodes = {};
  const classBlock = text.match(/<class>([\s\S]*?)<\/class>/i);
  if (classBlock) {
    nodes.class = [];
    const re = /<ty[^>]*id=["']?(\d+)["']?[^>]*>([\s\S]*?)<\/ty>/gi;
    let m;
    while ((m = re.exec(classBlock[1]))) nodes.class.push({ type_id: m[1], type_name: decodeXml(m[2]).trim() });
  }
  const listBlock = text.match(/<list>([\s\S]*?)<\/list>/i);
  if (listBlock) {
    nodes.list = [];
    const re = /<video([^>]*)>([\s\S]*?)<\/video>/gi;
    let m;
    while ((m = re.exec(listBlock[1]))) {
      const idm = m[1].match(/id=["']?(\d+)["']?/i);
      const body = m[2];
      const pick = (tag) => { const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(body); return r ? decodeXml(r[1]).trim() : ''; };
      nodes.list.push({
        vod_id: idm ? idm[1] : '', vod_name: pick('name'), vod_pic: pick('pic'),
        vod_remarks: pick('remarks'), type_name: pick('type'), vod_year: pick('year'),
        vod_actor: pick('actor'), vod_director: pick('director'), vod_des: pick('des'),
        vod_play_from: pick('playfrom'), vod_play_url: pick('playurl'),
      });
    }
  }
  const pc = /<pagecount>([\s\S]*?)<\/pagecount>/i.exec(text);
  nodes.pagecount = pc ? parseInt(pc[1], 10) || 1 : 1;
  return nodes;
}
function decodeXml(s) {
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function rewriteM3U8(text, sourceUrl, proxyBase, purify) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  const segs = []; // 记录各分片的绝对地址，便于净化时统计主机
  for (let line of lines) {
    const t = line.trim();
    if (!t) { out.push(line); continue; }
    if (t.startsWith('#')) {
      out.push(t.replace(/URI="([^"]+)"/g, (_, uri) => {
        const abs = absoluteUrl(uri, sourceUrl);
        return `URI="${proxyBase}${encodeURIComponent(abs)}"`;
      }));
      continue;
    }
    const abs = absoluteUrl(t, sourceUrl);
    out.push(`${proxyBase}${encodeURIComponent(abs)}`);
    segs.push(abs);
  }
  if (!purify || !segs.length) return out.join('\n');
  // m3u8 去广告：统计分片主机，剔除与主流主机不一致的广告分片（原版 M3U8_PURIFY）
  const hostOf = u => { try { return new URL(u).host; } catch { return ''; } };
  const counts = {};
  for (const s of segs) { const h = hostOf(s); counts[h] = (counts[h] || 0) + 1; }
  const mainHost = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  if (!mainHost) return out.join('\n');
  let removed = 0;
  const cleaned = [];
  let segIdx = 0;
  for (const line of out) {
    if (line && !line.startsWith('#') && line.startsWith(proxyBase)) {
      const abs = segs[segIdx++];
      if (hostOf(abs) !== mainHost) { removed++; continue; } // 丢弃广告分片
    }
    cleaned.push(line);
  }
  // 广告分片过多则视为误判，放弃净化
  if (removed > segs.length * 0.6) return out.join('\n');
  return cleaned.join('\n');
}

function cacheClear() {
  const n = cache.size;
  cache.clear();
  cacheBytes = 0;
  return n;
}

module.exports = {
  DEFAULT_UA, httpGet, absoluteUrl, isHttpUrl, parseSimpleXml, decodeXml,
  rewriteM3U8, cacheGet, cacheSet, cacheClear,
};
