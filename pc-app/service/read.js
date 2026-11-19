'use strict';
// 阅读/听书采集适配器：把猫影视(FongMi) read 区块的 cat.js 爬虫能力，用 Node 原生实现。
// 目前内置：bookan(博看有声, 纯 JSON API)。其余站点可按同一接口扩展。
// 统一输出结构供前端渲染：{siteKey, classes, videos:[{id,name,pic,remarks,actor,...}], pagecount}
// 小说/有声书详情里若带图片(pic / images)，前端会提供点击浏览。

const { httpGet, isHttpUrl, absoluteUrl } = require('./util');

const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';

// 各站点的原生实现。每个实现返回统一结构：
//   home()        -> { classes:[{tid,name}], videos:[...] }
//   category(tid,pg) -> { videos, pagecount }
//   detail(id)    -> { book:{id,name,pic,des,actor,...}, chapters:[{name,url}] }
//   search(wd,pg) -> { videos, pagecount }
const IMPLS = {
  // 博看有声：api.bookan.com.cn，纯 JSON，当前可用
  bookan: {
    base: 'https://api.bookan.com.cn',
    es: 'https://es.bookan.com.cn',
    instance: '25304',
    async get(url) {
      const t = await httpGet(url, { timeout: 15000, ua: UA_MOBILE, cacheMs: 5 * 60 * 1000 });
      let d; try { d = JSON.parse(t); } catch { throw new Error('接口返回的不是 JSON'); }
      if (d.code !== 0 && d.code !== undefined) throw new Error(d.msg || '接口异常');
      return d.data || {};
    },
    norm(b) {
      return {
        id: String(b.id ?? ''),
        name: String(b.name || '未命名').replace(/有声小说/g, '').trim(),
        pic: b.cover || b.pic || '',
        remarks: (b.extra && b.extra.author) || b.author || b.remarks || '',
        actor: (b.extra && (b.extra.announcer || b.extra.author)) || '',
      };
    },
    async home() {
      const classes = [
        { tid: '1305', name: '少年读物' }, { tid: '1304', name: '儿童文学' },
        { tid: '1320', name: '国学经典' }, { tid: '1306', name: '文艺少年' },
        { tid: '1309', name: '育儿心经' }, { tid: '1310', name: '心理哲学' },
        { tid: '1307', name: '青春励志' }, { tid: '1312', name: '历史小说' },
        { tid: '1303', name: '故事会' }, { tid: '1317', name: '音乐戏剧' },
        { tid: '1319', name: '相声评书' },
      ];
      // 首页推荐取第一个分类；一并返回真实页数，前端首次进入即可显示准确分页
      let videos = [], pagecount = 1;
      try {
        const d = await this.get(`${this.base}/voice/book/list?instance_id=${this.instance}&page=1&category_id=1305&num=24`);
        videos = (d.list || []).map(b => this.norm(b));
        pagecount = parseInt(d.last_page, 10) || 1;
      } catch {}
      return { classes, videos, pagecount };
    },
    async category(tid, pg = 1) {
      const d = await this.get(`${this.base}/voice/book/list?instance_id=${this.instance}&page=${pg}&category_id=${tid}&num=24`);
      return { videos: (d.list || []).map(b => this.norm(b)), pagecount: parseInt(d.last_page, 10) || 1 };
    },
    async detail(id) {
      const d = await this.get(`${this.base}/voice/album/units?album_id=${encodeURIComponent(id)}&page=1&num=200&order=1`);
      const chapters = (d.list || []).map(u => ({
        name: String(u.title || '').replace(/[<>《》]/g, '').replace(/[$#]/g, ' ').trim(),
        url: u.file || '',
      })).filter(c => c.url);
      return {
        book: { id, name: '', pic: '', des: '', actor: '' },
        chapters,
      };
    },
    async search(wd, pg = 1) {
      const d = await this.get(`${this.es}/api/v3/voice/book?instanceId=${this.instance}&keyword=${encodeURIComponent(wd)}&pageNum=${pg}&limitNum=20`);
      return { videos: (d.list || []).map(b => this.norm(b)), pagecount: parseInt(d.last_page, 10) || 1 };
    },
  },
};

function implFor(site) {
  const key = String(site.key || '').toLowerCase();
  if (IMPLS[key]) return IMPLS[key];
  // key 变体：bookan / bookkan / 博看 都走 bookan
  if (/book|博看|听书/i.test(key) && /bookan|博看/i.test((site.name || '') + key)) return IMPLS.bookan;
  return null;
}

// 站点是否为本模块可处理的小说源
function supported(site) { return !!implFor(site); }

async function home(site) {
  const impl = implFor(site);
  if (!impl) throw new Error('该小说源暂未适配 PC 端：' + (site.name || site.key));
  const r = await impl.home();
  return { siteKey: site.key, siteName: site.name, classes: r.classes || [], videos: r.videos || [] };
}
async function category(site, tid, pg = 1) {
  const impl = implFor(site);
  if (!impl) throw new Error('该小说源暂未适配 PC 端');
  const r = await impl.category(tid, pg);
  return { siteKey: site.key, videos: r.videos || [], pagecount: r.pagecount || 1, page: Number(pg) };
}
async function detail(site, id) {
  const impl = implFor(site);
  if (!impl) throw new Error('该小说源暂未适配 PC 端');
  const r = await impl.detail(id);
  return { siteKey: site.key, id, ...r };
}
async function search(site, wd, pg = 1) {
  const impl = implFor(site);
  if (!impl) throw new Error('该小说源暂未适配 PC 端');
  const r = await impl.search(wd, pg);
  return { siteKey: site.key, videos: r.videos || [], pagecount: r.pagecount || 1, page: Number(pg) };
}
// 音频直链：bookan 的 file 已是直链，parse=0 直接播
function play(site, url) { return { parse: 0, url }; }

module.exports = { supported, home, category, detail, search, play, IMPLS };
