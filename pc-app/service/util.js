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

// 网络加速开关：由设置页控制。开启时 curl 走 Windows 系统代理（浏览器同款），关闭时走直连。
// 默认关闭；index.js 启动时从用户数据目录的 netaccel.json 恢复。
let networkAccel = false;
function setNetworkAccel(on) { networkAccel = !!on; }
function getNetworkAccel() { return networkAccel; }

// 读取 Windows 系统代理（浏览器走的路线）。
// 环境变量 HTTP(S)_PROXY 常指向已关闭的旧代理，导致 curl 超时而浏览器正常。
// 返回 "host:port" 裸地址（不带协议），由 curlFetchRaw 分别尝试 socks5/http 两种协议。
let _sysProxyCache, _sysProxyAt = 0;
function windowsSystemProxy() {
  if (process.platform !== 'win32') return '';
  if (_sysProxyCache !== undefined && Date.now() - _sysProxyAt < 60000) return _sysProxyCache;
  let result = '';
  try {
    const { execFileSync } = require('node:child_process');
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    // ProxyEnable=0 时注册表可能残留 ProxyServer，此时不应使用
    try {
      const en = execFileSync('reg', ['query', key, '/v', 'ProxyEnable'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      if (/ProxyEnable\s+REG_DWORD\s+0x0\b/i.test(en)) { _sysProxyCache = ''; _sysProxyAt = Date.now(); return ''; }
    } catch (_) {}
    const out = execFileSync('reg', ['query', key, '/v', 'ProxyServer'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    const m = out.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
    if (m) {
      const raw = m[1].trim();
      // 形如 "http=127.0.0.1:10808;https=127.0.0.1:10808;socks=127.0.0.1:10808" 或裸 "127.0.0.1:10808"
      // socks 优先（多数本地代理软件 socks 口才真正能出网），其次 http。
      const socks = raw.match(/(?:^|;)socks5?=([^;]+)/i);
      const http = raw.match(/(?:^|;)https?=([^;]+)/i);
      const pick = (socks && socks[1]) || (http && http[1]) || (!raw.includes('=') ? raw : '');
      result = String(pick || '').trim().replace(/^https?:\/\//i, '').replace(/^socks5?:\/\//i, '').replace(/\/+$/, '');
    }
  } catch (_) {}
  _sysProxyCache = result; _sysProxyAt = Date.now();
  return result;
}

async function curlFetchRaw(url, args, perTimeout) {
  // 加速模式单条超时 14s：略小于前端 15s 等待窗口，失败时也能回传明确错误而非 "user aborted"。
  // --ipv4：不少域名 AAAA 记录被污染到不可达 IPv6（如 Facebook 段），强制 IPv4。
  const effTimeout = networkAccel ? 14000 : perTimeout;
  const metaBuf = Buffer.from(META, 'latin1');
  const full = [
    '-sS', '-L', '--compressed', '--ipv4', '--max-time', String(Math.ceil(effTimeout / 1000)),
    '-A', args.ua || DEFAULT_UA,
    ...(args.headers || []),
    '-w', META + '%{http_code}|%{content_type}|%{url_effective}',
  ];
  // 选路：加速开 → 系统代理 socks5 双路 + http + 环境变量代理 + 直连，全部【并发竞速】，谁先拿到有效数据用谁；
  //       加速关 → 只走直连，完全不碰代理（curl 默认会读环境变量，故显式 --noproxy）。
  // 之所以并发：实测 socks5 代理成功率仅约 40%、慢则 13s+，串行会被慢路线吃光前端窗口导致 abort。
  const sysProxy = networkAccel ? windowsSystemProxy() : '';
  const attempts = [];
  if (networkAccel) {
    if (sysProxy) {
      // socks5 走本地 DNS 解析，可绕开代理远端 DNS 故障；双路并发对抗抖动
      attempts.push(['--proxy', 'socks5://' + sysProxy, ...full, url]);
      attempts.push(['--proxy', 'socks5://' + sysProxy, ...full, url]);
      attempts.push(['--proxy', 'http://' + sysProxy, ...full, url]);
    }
    attempts.push([...full, url]);                     // 环境变量代理（加速软件有时只注入此项）
  }
  attempts.push(['--noproxy', '*', ...full, url]);     // 直连（关闭时唯一路线；开启时最后兜底）

  return await new Promise((resolve, reject) => {
    const children = [];
    let settled = false, remaining = attempts.length, lastErr;
    const succeed = r => {
      if (settled) return;
      settled = true;
      for (const c of children) { try { c.kill(); } catch {} }
      resolve(r);
    };
    const fail = e => {
      if (settled) return;
      lastErr = e;
      if (--remaining <= 0) { settled = true; reject(e); }
    };
    attempts.forEach(att => {
      let child;
      try { child = spawn('curl', att, { windowsHide: true }); }
      catch (e) { fail(e); return; }
      children.push(child);
      const chunks = [], errs = [];
      child.stdout.on('data', c => chunks.push(c));
      child.stderr.on('data', c => errs.push(c));
      let finished = false;
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        if (!finished) { finished = true; fail(new Error('curl timeout')); }
      }, effTimeout + 1500);
      child.on('error', e => { if (finished) return; finished = true; fail(e); });
      child.on('close', code => {
        clearTimeout(timer);
        if (finished || settled) return;
        finished = true;
        if (code !== 0) return fail(new Error('curl ' + code + ': ' + Buffer.concat(errs).toString('utf8').slice(0, 140)));
        const buf = Buffer.concat(chunks);
        const mi = buf.lastIndexOf(metaBuf);
        if (mi < 0) return fail(new Error('curl meta missing'));
        const body = buf.subarray(0, mi);
        const meta = buf.subarray(mi + metaBuf.length).toString('utf8').trim();
        const [codeStr, ctype = '', finalUrl = url] = meta.split('|');
        const status = parseInt(codeStr, 10) || 0;
        // 空 body / 非 2xx 视为失败（代理有时只回 CONNECT 头就 code 0，或回 502 错误页）
        if (!(status >= 200 && status < 300) || body.length === 0) {
          return fail(new Error('HTTP ' + status + (body.length === 0 ? ' (empty)' : '')));
        }
        succeed({ status, ctype, finalUrl, body });
      });
    });
  });
}

async function httpGet(url, opts = {}) {
  const { headers = {}, timeout = 15000, ua = DEFAULT_UA, cacheMs = 0, raw = false } = opts;
  const ck = 'http:' + url + '|' + (raw ? 'raw' : 'text');
  if (cacheMs > 0) { const hit = cacheGet(ck); if (hit) return hit; }
  const headerArgs = Object.entries(headers).map(([k, v]) => '-H ' + k + ': ' + v).length
    ? Object.entries(headers).flatMap(([k, v]) => ['-H', k + ': ' + v]) : [];
  // 单轮超时适度缩短：代理不通时快速轮换到下一条路线，避免前端等待窗口内拿不到结果
  const r = await curlFetchRaw(url, { ua, headers: headerArgs }, Math.min(timeout, 8000));
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
  rewriteM3U8, cacheGet, cacheSet, cacheClear, setNetworkAccel, getNetworkAccel,
};
