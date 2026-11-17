'use strict';
// 点播采集适配器：兼容 TVBox 里最常见的 CMS 采集接口（苹果CMS V10 的 json/xml）
// 这类站点接口: ?ac=videolist&t=分类&pg=页 / ?ac=detail&ids=id / ?wd=关键词
// 归一化输出统一结构，供前端渲染，不依赖 Android

const { httpGet, absoluteUrl, isHttpUrl, parseSimpleXml } = require('./util');

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
  const videos = items.map(v => ({
    id: String(v.vod_id ?? v.id ?? ''),
    name: v.vod_name || v.name || '未命名',
    pic: v.vod_pic || v.pic || '',
    remarks: v.vod_remarks || v.remarks || '',
    type: v.type_name || v.type || '',
    year: v.vod_year || v.year || '',
    actor: v.vod_actor || v.actor || '',
    director: v.vod_director || v.director || '',
    des: v.vod_des || v.des || '',
  }));
  const classes = cls.map(c => ({ tid: String(c.type_id ?? c.id ?? ''), name: c.type_name || c.type || c.name || '' }));
  return { videos, classes, pagecount };
}

async function request(api, type, params, opts = {}) {
  const url = apiUrl(api, params);
  const text = await httpGet(url, { timeout: opts.timeout || 15000, ua: opts.ua, cacheMs: 0 });
  // 按内容自适应：不少站配置里标 type=1(XML)，实际接口返回 JSON（maccms from/ 系列）
  const t = String(text).trim();
  if (t.startsWith('{') || t.startsWith('[')) { try { return JSON.parse(t); } catch (e) {} }
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
  const { videos, pagecount } = normalizeList(raw, site.type);
  return { siteKey: site.key, videos, pagecount, page: Number(pg) };
}

async function search(site, wd, pg = 1) {
  const params = { ac: 'videolist', wd, pg };
  const raw = await request(site.api, site.type, params);
  const { videos, pagecount } = normalizeList(raw, site.type);
  return { siteKey: site.key, videos, pagecount, page: Number(pg) };
}

async function detail(site, id) {
  const raw = await request(site.api, site.type, { ac: 'detail', ids: id });
  const { videos } = normalizeList(raw, site.type);
  const v = videos[0] || {};
  const d = raw || {};
  const first = (Array.isArray(d.list) ? d.list : [])[0] || {};
  const playFrom = first.vod_play_from || first.play_from || '';
  const playUrl = first.vod_play_url || first.play_url || '';
  return {
    siteKey: site.key, id,
    name: v.name, pic: v.pic, des: v.des, actor: v.actor, director: v.director,
    remarks: v.remarks, type: v.type, year: v.year,
    plays: parsePlayUrl(playUrl),
  };
}

module.exports = { home, category, search, detail, parsePlayUrl };
