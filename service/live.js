'use strict';
// 直播源解析：兼容 标准 M3U(#EXTINF) 和 TVBox 逗号格式(#genre#)
// 来自 catvod 的 lives 配置：{ name, url, ua, epg, logo }

const { httpGet, absoluteUrl } = require('./util');

function convertGenre(text) {
  const lines = String(text || '').split(/\r?\n/);
  const hasGenre = lines.some(x => /#genre#/.test(x));
  const hasCommaUrl = lines.some(x => {
    const i = x.indexOf(','); return i > 0 && /^https?:\/\//i.test(x.slice(i + 1).trim());
  });
  // 已是标准 m3u 或不是"名称,地址"格式，直接返回
  if (!hasCommaUrl) return text;
  const out = [];
  let group = '';
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/#genre#/.test(t)) { group = t.replace(/,?#genre#\s*$/, '').trim(); continue; }
    const i = t.indexOf(',');
    if (i < 0) { out.push(line); continue; }
    const name = t.slice(0, i).trim(), url = t.slice(i + 1).trim();
    if (!/^https?:\/\//i.test(url)) { out.push(line); continue; }
    out.push(`#EXTINF:-1 group-title="${(group || '默认').replace(/"/g, "'")}",${name}`);
    out.push(url);
  }
  return hasGenre || out.length ? out.join('\n') : text;
}

// 已知地区封锁/需梯子域名——命中即给前端标记，播放时提示而不是干等超时
const GEO_BLOCKED_HOSTS = ['freetv.fun', 'freetv.to'];
function isGeoBlocked(name, url) {
  if (/geo-?blocked|地区|受限|需梯子|锁区/i.test(name || '')) return true;
  try { const h = new URL(url).hostname; return GEO_BLOCKED_HOSTS.some(x => h === x || h.endsWith('.' + x)); }
  catch { return false; }
}

function parseM3U(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/);
  const channels = [];
  let cur = null;
  const attrRe = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXTINF/i.test(line)) {
      const attrs = {};
      let m; attrRe.lastIndex = 0;
      while ((m = attrRe.exec(line))) attrs[m[1].toLowerCase()] = m[2].trim();
      const noAttrs = line.replace(/[a-zA-Z0-9_-]+="[^"]*"/g, '');
      let idx = noAttrs.indexOf(',');
      const title = (idx >= 0 ? noAttrs.slice(idx + 1) : noAttrs).trim().replace(/^"+|"+$/g, '');
      cur = { attrs, title };
      continue;
    }
    if (line.startsWith('#')) continue;
    const url = absoluteUrl(line, baseUrl);
    if (!/^https?:\/\//i.test(url)) { cur = null; continue; }
    const name = cur?.title || guessName(url);
    channels.push({
      id: cur?.attrs['tvg-id'] || hash(url),
      name,
      url,
      group: cur?.attrs['group-title'] || cur?.attrs['extgroup'] || '',
      logo: cur?.attrs['tvg-logo'] || '',
      geo: isGeoBlocked(name, url),
    });
    cur = null;
  }
  return channels;
}
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }
function guessName(url) {
  try { const p = new URL(url).pathname.split('/').filter(Boolean).pop(); return p ? decodeURIComponent(p).replace(/\.(m3u8?|flv|ts|mp4)$/i, '') : new URL(url).hostname; }
  catch { return '未命名频道'; }
}

async function loadPlaylist(live, force = false) {
  const text = await httpGet(live.url, { timeout: 20000, ua: live.ua, cacheMs: force ? 0 : 10 * 60 * 1000 });
  // 内容校验：上游返回 HTML 错误页/网关报错时，不把它解析成一堆假频道
  const head = String(text || '').slice(0, 500);
  if (/^\s*<(html|!doctype|head|body)\b/i.test(String(text || '').trim()) || /gateway error|access denied|502 bad gateway|<title>错误/i.test(head)) {
    return { name: live.name, url: live.url, groups: [], channels: [], error: '源返回的是网页/错误页，不是直播列表' };
  }
  const converted = convertGenre(text);
  const channels = parseM3U(converted, live.url);
  if (!channels.length) return { name: live.name, url: live.url, groups: [], channels: [], error: '未解析到有效频道' };
  const groups = [...new Set(channels.map(c => c.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'));
  return { name: live.name, url: live.url, groups, channels };
}

module.exports = { loadPlaylist, convertGenre, parseM3U };
