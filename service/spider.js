'use strict';
// 点播采集适配器：兼容 TVBox 里最常见的 CMS 采集接口（苹果CMS V10 的 json/xml）
// 这类站点接口: ?ac=videolist&t=分类&pg=页 / ?ac=detail&ids=id / ?wd=关键词
// 归一化输出统一结构，供前端渲染，不依赖 Android

const { httpGet, absoluteUrl, isHttpUrl, parseSimpleXml } = require('./util');
const webArticle = require('./webArticle');

function apiUrl(api, params) {
  const u = new URL(api);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  }
  return u.href;
}

function parsePlayUrl(raw) {
  // vod_play_from / vod_play_url 形如 "线路1$$$线路2" / "第1集$url1#第2集$url2$$$..."
  const flags = String(raw || '').split('$$$').filter(x => x.trim());
  return flags.map((block, i) => {
    const episodes = block.split('#').map(seg => {
      const idx = seg.lastIndexOf('$');
      if (idx > 0) return { name: seg.slice(0, idx).trim(), url: seg.slice(idx + 1).trim() };
      return { name: `第${i + 1}集`, url: seg.trim() };
    }).filter(e => e.url);
    return { flag: `线路${i + 1}`, episodes };
  }).filter(f => f.episodes.length);
}

// 从 vod_content（可能含 HTML）里提取图片地址与纯文本正文
// 用于识别"图片/图文小说"类资源：这类条目套着 V10 外壳，但 play_url 为空、内容在图里
function extractContent(content) {
  const html = String(content || '');
  const imgs = [];
  const re = /<img[^>]+src\s*=\s*["']?([^"'\s>]+)/gi;
  let m;
  while ((m = re.exec(html))) if (/^https?:\/\//i.test(m[1])) imgs.push(m[1]);
  // 没有 <img> 标签时，正文里可能直接是图片地址（一行一个）
  if (!imgs.length) {
    for (const line of html.split(/[\r\n<>\s]+/)) {
      if (/^https?:\/\/.*\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(line)) imgs.push(line);
    }
  }
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return { images: [...new Set(imgs)], text };
}

// 判断条目资源类型：video（有真实播放地址）/ image（图集）/ article（图文小说）
// 保守：只要有任意播放地址就当视频，绝不误伤正常视频源
function detectKind(v, playUrl, contentInfo) {
  if (playUrl && String(playUrl).trim()) return 'video';
  if (contentInfo.images.length >= 2) return 'image';
  if (contentInfo.text.length >= 30) return 'article';
  if (contentInfo.images.length === 1) return 'image';
  return 'video'; // 无播放地址也无内容：保持视频（原样，交由旧逻辑显示"暂无播放"）
}

function normalizeList(raw, type) {
  let items = [], cls = [], pagecount = 1;
  // raw 可能是已解析的 JSON 对象，也可能是 XML 文本
  let d;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('{') || t.startsWith('[')) { try { d = JSON.parse(t); } catch { d = {}; } }
    else d = parseSimpleXml(t);
  } else {
    d = raw || {};
  }
  items = Array.isArray(d.list) ? d.list : [];
  cls = Array.isArray(d.class) ? d.class : [];
  pagecount = parseInt(d.pagecount, 10) || 1;
  const videos = items.map(v => {
    const playUrl = v.vod_play_url || v.play_url || '';
    const ci = extractContent(v.vod_content || v.content || '');
    return {
      id: String(v.vod_id ?? v.id ?? ''),
      name: v.vod_name || v.name || '未命名',
      pic: v.vod_pic || v.pic || '',
      remarks: v.vod_remarks || v.remarks || '',
      type: v.type_name || v.type || '',
      year: v.vod_year || v.year || '',
      actor: v.vod_actor || v.actor || '',
      director: v.vod_director || v.director || '',
      des: v.vod_des || v.des || '',
      kind: detectKind(v, playUrl, ci),
      images: ci.images,
      contentText: ci.text,
    };
  });
  const classes = cls.map(c => ({ tid: String(c.type_id ?? c.id ?? ''), name: c.type_name || c.type || c.name || '' }));
  return { videos, classes, pagecount };
}

// 上游错误文本识别：代理/网关失败时可能返回 HTTP 200 + 一段纯文本错误（并非采集数据）。
// 若不识别，会被当成"解析出空列表"，误报为“源失效”。这里只做文本形态判断，
// 不干涉正常 JSON({/[ 开头) 与 XML(< 开头) 的解析，避免影响任何标准采集接口。
function looksLikeUpstreamError(t) {
  if (!t) return false;
  const s = String(t).replace(/^\uFEFF/, '').trim();
  // 合法采集数据必须放行：JSON 与标准 XML（带声明或典型采集标签）
  // 严格白名单，确保任何标准 JSON/XML 源都不被误判为失效。
  if (s.startsWith('{') || s.startsWith('[')) return false;
  if (/^<\?xml/i.test(s) || /<rss[\s>]/i.test(s) || /<list[\s>]/i.test(s)
    || /<class[\s>]/i.test(s) || /<video[\s>]/i.test(s)) return false;
  // HTML 网页：域名出售页 / 404 / 防爬挑战页 / 普通网页 —— 不是采集数据。
  // 采集站域名过期或被墙后常返回 HTTP 200 + 这类页面，必须识别，否则会被
  // 当成空列表，前端只显示笼统的“加载失败”，看不到真实原因。
  if (/<!doctype\s+html/i.test(s) || /<html[\s>]/i.test(s) || /<head[\s>]/i.test(s)
    || /<body[\s>]/i.test(s) || /<script[\s>]/i.test(s) || /<title[\s>]/i.test(s)
    || /this domain is for sale/i.test(s) || /domain[^<]{0,40}for sale/i.test(s)) return true;
  // 纯文本网关/代理错误
  return /^(upstream|bad gateway|gateway time-?out|connection timed?\s*out|connect failed|service unavailable|proxy error|too many requests|access denied|forbidden|file not found|error\s*\d{3}|5\d{2}\b|4\d{2}\b)/i.test(s)
    || /upstream connect failed|upstream timed out|connection timed out/i.test(s.slice(0, 160));
}

async function request(api, type, params, opts = {}) {
  const url = apiUrl(api, params);
  const text = await httpGet(url, { timeout: opts.timeout || 15000, ua: opts.ua, cacheMs: 0 });
  // 按内容自适应：不少站配置里标 type=1(XML)，实际接口返回 JSON（maccms from/ 系列）
  const t = String(text).replace(/^\uFEFF/, '').trim();
  if (!t) throw new Error('上游返回空内容');
  if (t.startsWith('{') || t.startsWith('[')) { try { return JSON.parse(t); } catch (e) {} }
  // JSON/XML 之外：明确的网关/代理错误文本直接抛错，交给上层显示真实原因，
  // 不再静默产出空列表污染首页/分类结果。
  if (looksLikeUpstreamError(t)) throw new Error('上游返回错误：' + t.replace(/\s+/g, ' ').slice(0, 100));
  return parseSimpleXml(t);
}

// site: { key, name, api, type:'json'|'xml' }
async function home(site) {
  // ac=list 会同时返回分类(class)与片单；部分采集站只支持 videolist，失败再回退
  let raw = await request(site.api, site.type, { ac: 'list' });
  let { videos, classes } = normalizeList(raw, site.type);
  if (!videos.length) {
    raw = await request(site.api, site.type, { ac: 'videolist' });
    const r2 = normalizeList(raw, site.type);
    videos = r2.videos;
    if (!classes.length) classes = r2.classes;
  }
  return { siteKey: site.key, siteName: site.name, classes, videos };
}

async function category(site, tid, pg = 1, filters = {}) {
  const params = { ac: 'videolist', t: tid, pg };
  Object.assign(params, filters);
  const raw = await request(site.api, site.type, params);
  let { videos, pagecount } = normalizeList(raw, site.type);
  // 回退：采集接口该分类为空时，部分站点同域名有网页版文章路由(art/type)。
  // 只在空结果时尝试，且仅当解析出文章条目才采用；失败静默，不影响正常视频分类。
  if (!videos.length && webArticle.supported(site)) {
    try {
      const wa = await webArticle.list(site, tid, pg);
      if (wa.videos && wa.videos.length) {
        videos = wa.videos.map(v => ({ ...v, fromArticle: true }));
        pagecount = wa.pagecount || 1;
      }
    } catch (_) {}
  }
  return { siteKey: site.key, videos, pagecount, page: Number(pg) };
}

async function search(site, wd, pg = 1) {
  const params = { ac: 'videolist', wd, pg };
  const raw = await request(site.api, site.type, params);
  const { videos, pagecount } = normalizeList(raw, site.type);
  return { siteKey: site.key, videos, pagecount, page: Number(pg) };
}

async function detail(site, id, opts = {}) {
  // 显式指定来自网页文章列表时，优先走网页文章路由（同 id 在采集接口可能恰有同名视频，不能被误判）。
  if (opts.article && webArticle.supported(site)) {
    try {
      const wa = await webArticle.detail(site, id);
      if ((wa.contentText && wa.contentText.length >= 10) || (wa.images && wa.images.length)) {
        return {
          siteKey: site.key, id, name: wa.name, pic: wa.pic || '', des: '', actor: '', director: '',
          remarks: '', type: '', year: '', plays: [], kind: wa.kind || 'article',
          images: wa.images || [], contentText: wa.contentText || '',
        };
      }
    } catch (_) {}
  }
  const raw = await request(site.api, site.type, { ac: 'detail', ids: id });
  const { videos } = normalizeList(raw, site.type);
  const v = videos[0] || {};
  const d = raw || {};
  const first = (Array.isArray(d.list) ? d.list : [])[0] || {};
  const playFrom = first.vod_play_from || first.play_from || '';
  const playUrl = first.vod_play_url || first.play_url || '';
  const plays = parsePlayUrl(playUrl);
  let kind = v.kind || 'video';
  let images = v.images || [];
  let contentText = v.contentText || '';
  let name = v.name;
  // 回退：采集接口查不到该条目(无播放地址、无正文)时，部分站点同域名有网页版文章路由(art/detail)。
  // 只在完全无内容时尝试，且仅当取到正文或图片才采用；失败静默，不影响正常视频详情。
  if (!opts.article && !plays.length && !images.length && contentText.length < 30 && webArticle.supported(site)) {
    try {
      const wa = await webArticle.detail(site, id);
      if ((wa.contentText && wa.contentText.length >= 10) || (wa.images && wa.images.length)) {
        name = name || wa.name;
        if (!v.pic && wa.pic) v.pic = wa.pic;
        images = wa.images || images;
        contentText = wa.contentText || contentText;
        kind = wa.kind || 'article';
      }
    } catch (_) {}
  }
  return {
    siteKey: site.key, id,
    name, pic: v.pic, des: v.des, actor: v.actor, director: v.director,
    remarks: v.remarks, type: v.type, year: v.year,
    plays, kind, images, contentText,
  };
}

// 封面：网页文章列表是纯文字无缩略图，用详情正文首图当封面。
// 只对支持网页文章路由的站点发请求，普通视频站直接返回空（由前端用原 pic）。
async function cover(site, id) {
  if (!site || !webArticle.supported(site)) return '';
  try {
    const wa = await webArticle.detail(site, id);
    return wa.pic || '';
  } catch (_) { return ''; }
}

module.exports = { home, category, search, detail, cover, parsePlayUrl };
