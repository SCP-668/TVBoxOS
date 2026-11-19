'use strict';
// 通用网页文章解析器：针对 maccms / stui 一类 CMS 站点的「网页版文章路由」。
// 完全内容无关——只按 URL 与 HTML 结构解析，不硬编码任何站点域名、分类名或关键词。
//   列表: /index.php/art/type/id/{tid}.html
//   翻页: /index.php/art/type/id/{tid}/page/{pg}.html
//   详情: /index.php/art/detail/id/{id}.html
// 用途：点播采集接口(ac=videolist)对某个分类返回空时，作为回退数据源，
//      把网页文章条目以 kind:'article' 交给前端已有的图文阅读器渲染。

const { httpGet, absoluteUrl } = require('./util');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function originOf(site) {
  const api = String((site && site.api) || (site && site.url) || '');
  try { return new URL(api).origin; } catch { return ''; }
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCharCode(parseInt(n, 16)); } catch { return _; } })
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(+n); } catch { return _; } });
}

function tagAttr(tag, name) {
  const m = new RegExp(name + '\\s*=\\s*[\\\'"]?([^\\\'">\\s]+)', 'i').exec(tag);
  return m ? m[1] : '';
}

// 解析列表页 HTML -> { videos, pagecount }
function parseList(html, baseUrl) {
  const videos = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"']*\/art\/detail\/id\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    const titleAttr = tagAttr(m[0], 'title');
    const inner = m[3].replace(/<[^>]+>/g, '');
    const name = decodeEntities(titleAttr || inner).replace(/\s+/g, ' ').trim() || ('文章 ' + id);
    videos.push({
      id, name, pic: '', remarks: '', type: '', year: '',
      sourceUrl: absoluteUrl(m[1], baseUrl),
      kind: 'article', images: [], contentText: '',
    });
  }
  let pagecount = 1;
  const pages = [];
  const pr = /\/page\/(\d+)\.html/gi;
  let pm;
  while ((pm = pr.exec(html))) pages.push(+pm[1]);
  if (pages.length) pagecount = Math.max(1, ...pages);
  return { videos, pagecount };
}

async function list(site, tid, pg = 1) {
  const origin = originOf(site);
  if (!origin) throw new Error('站点地址无效');
  const t = encodeURIComponent(String(tid || ''));
  const url = Number(pg) <= 1
    ? `${origin}/index.php/art/type/id/${t}.html`
    : `${origin}/index.php/art/type/id/${t}/page/${Number(pg)}.html`;
  const html = await httpGet(url, { timeout: 10000, ua: UA, cacheMs: 3 * 60 * 1000 });
  return parseList(html, url);
}

// 解析详情页 HTML -> { name, contentText, images, kind }
function parseDetail(html, id) {
  let name = '';
  const hm = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (hm) name = decodeEntities(hm[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

  // 正文区：优先取 h1 之后到页脚之间的片段（通用结构，不依赖 class 名）
  let body = html;
  const h1 = /<h1[^>]*>[\s\S]*?<\/h1>/i.exec(html);
  if (h1) body = html.slice(h1.index + h1[0].length);
  const foot = /<[^>]+class=["'][^"']*\bfoot\b[^"']*["'][^>]*>/i.exec(body);
  if (foot) body = body.slice(0, foot.index);

  // 图片：正文区内 http(s) 图片，排除常见站点图标
  const images = [];
  const ir = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let im;
  while ((im = ir.exec(body))) {
    const u = decodeEntities(im[1]);
    if (/^https?:\/\//i.test(u) && !/(logo|icon|avatar|loading|placeholder|spacer)/i.test(u)) images.push(u);
  }

  const text = decodeEntities(
    body.replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
  ).replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  const uniqImages = [...new Set(images)];
  return {
    name: name || ('文章 ' + id),
    // 列表页是纯文字没有缩略图，详情正文首图即为该条目的封面
    pic: uniqImages[0] || '',
    contentText: text,
    images: uniqImages,
    kind: images.length >= 2 ? 'image' : 'article',
  };
}

async function detail(site, id) {
  const origin = originOf(site);
  if (!origin) throw new Error('站点地址无效');
  const url = `${origin}/index.php/art/detail/id/${encodeURIComponent(String(id))}.html`;
  const html = await httpGet(url, { timeout: 10000, ua: UA, cacheMs: 3 * 60 * 1000 });
  return parseDetail(html, id);
}

// 是否可作为网页文章回退候选：有合法 http 接口地址的站点都可以尝试，失败静默忽略。
function supported(site) {
  return /^https?:\/\//i.test(String((site && site.api) || (site && site.url) || '').trim());
}

module.exports = { supported, originOf, parseList, parseDetail, list, detail };
