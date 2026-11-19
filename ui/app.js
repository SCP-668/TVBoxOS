'use strict';
/* ================= TVBox PC 前端逻辑（复刻原版交互） ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* 站源选择栏加载小动画：引用计数，支持嵌套/并发/竞态（旧请求结束不会误关新请求的动画） */
const _siteSpinCount = { home: 0, vod: 0, read: 0 };
function siteSpinOn(page) {
  _siteSpinCount[page] = (_siteSpinCount[page] || 0) + 1;
  const el = $('#' + page + '-site-spin'); if (el) el.classList.add('on');
}
function siteSpinOff(page) {
  _siteSpinCount[page] = Math.max(0, (_siteSpinCount[page] || 0) - 1);
  if (_siteSpinCount[page] === 0) { const el = $('#' + page + '-site-spin'); if (el) el.classList.remove('on'); }
}

const LS = {
  get(k, d) { try { const v = localStorage.getItem('tvbox.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tvbox.' + k, JSON.stringify(v)); } catch {} },
};

const state = {
  config: null,
  sites: [],
  lives: [],
  reads: [],
  readKey: '',
  readClass: '',
  readPage: 1,
  readPageCount: 1,
  readBook: null,
  homeKey: '',
  vodKey: '',
  vodClass: '',
  vodPage: 1,
  vodPageCount: 1,
  liveKey: '',
  liveData: null,
  liveGroup: '',
  liveChannels: [],
  liveIdx: -1,
  detail: null,
  netAccel: false,
  defaultDownloadDir: '',
  epLine: 0,
  epSortAsc: true,
  player: null,     // {siteKey,id,line,epIdx,eps}
  hls: null,
  focusables: [],
  focusIdx: 0,
};

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}
async function api(path, params = {}) {
  const u = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  const r = await fetch(u);
  if (!r.ok) { let e; try { e = await r.json(); } catch { e = { error: r.statusText }; } throw new Error(e.error || ('请求失败 ' + r.status)); }
  return r.json();
}
// 带超时的 api 请求：站点抓取卡住时前端及时放弃，交给上层降级
async function apiTimeout(path, params, ms) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  const u = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  try {
    const r = await fetch(u, { signal: ctrl.signal });
    if (!r.ok) { let e; try { e = await r.json(); } catch { e = { error: r.statusText }; } throw new Error(e.error || ('请求失败 ' + r.status)); }
    return await r.json();
  } catch (e) {
    // 前端等待超时主动中止：不外露英文技术错误，给出可操作的提示（开启加速时网络更慢，可重试/换源）
    if (e && e.name === 'AbortError') throw new Error('请求超时：该站源响应较慢或网络不通，请重试；开启「网络加速」后若仍慢，可到设置里切换其它站源');
    throw e;
  } finally { clearTimeout(t); }
}

/* ---------------- 时钟 ---------------- */
function tickClock() {
  const d = new Date();
  const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  $('#clockDate').textContent = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}  ${wk}`;
  $('#clockTime').textContent = d.toLocaleTimeString('zh-CN', { hour12: false });
}
setInterval(tickClock, 1000); tickClock();

/* ---------------- 视图切换 ---------------- */
let currentView = 'home';
// 进入播放器前所在的页面：点播/首页/搜索/收藏/历史/推送/本地文件，播放器返回时回到这里
let playerReturnView = 'home';
function switchView(v) {
  const prev = currentView;
  currentView = v;
  document.body.dataset.view = v;
  // 离开时停掉对应播放器，避免声音残留
  if (prev === 'player' && v !== 'player') stopVodPlayer();
  if (prev === 'live' && v !== 'live') stopLive();
  $$('.view').forEach(x => x.classList.remove('active'));
  const el = $('#view-' + v); if (el) el.classList.add('active');
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  refreshFocusables();
  if (v === 'live' && !state.liveData) loadLiveSources();
  // 离开直播时 stopLive() 会销毁 HLS 并清空 video src；切回来自动恢复上次频道，
  // 无需用户再点一次频道。延迟到本次视图切换完成后再播，避免隐藏状态下 play 被拒。
  if (v === 'live' && prev !== 'live' && state.liveIdx >= 0 && state.liveChannels[state.liveIdx]) {
    setTimeout(() => {
      if (currentView === 'live' && state.liveIdx >= 0 && state.liveChannels[state.liveIdx]) playLive(state.liveIdx);
    }, 0);
  }
  if (v === 'read') loadReadSites();
  if (v === 'downloads') renderDownloads();
  if (v === 'fav') renderFav();
  if (v === 'history') renderHistory();
  if (v === 'settings') renderSettings();
  if (v === 'sources') showApiHistory();
  if (v === 'push') renderPushHistory();
  if (v === 'file') loadFileRoot();
  if (v === 'search') renderSearchExtra();
}

/* ---------------- 海报卡片 ---------------- */
// 图片/小说条目：列表是纯文字无缩略图，封面走懒加载接口（取详情首图）。
// 视频条目：用源站自带 pic，行为不变。
// 列表已加载的真实封面缓存（id → pic）：供详情弹窗复用，避免详情接口无 pic 时落到透明占位图
const coverCache = new Map();
function coverSrc(v) {
  if (v.pic) return v.pic;
  if (v.fromArticle && v.siteKey && v.id) {
    return `/api/vod/cover?key=${encodeURIComponent(v.siteKey)}&id=${encodeURIComponent(v.id)}`;
  }
  return '';
}
function posterHTML(v, opts = {}) {
  const pic = coverSrc(v);
  if (pic && v.id) coverCache.set(String(v.siteKey || '') + '||' + String(v.id), pic);
  const badges = [];
  if (v.year) badges.push(`<span class="badge year">${esc(v.year)}</span>`);
  if (v.area) badges.push(`<span class="badge area">${esc(v.area)}</span>`);
  if (v.lang) badges.push(`<span class="badge">${esc(v.lang)}</span>`);
  if (v.type && !v.area) badges.push(`<span class="badge">${esc(v.type)}</span>`);
  const note = v.remarks ? `<span class="note">${esc(v.remarks)}</span>` : '';
  const sub = [v.type, v.actor].filter(Boolean).join(' · ');
  const act = opts.action || (v.fromArticle
    ? `openDetail('${esc(v.siteKey || '')}','${esc(v.id)}',1)`
    : `openDetail('${esc(v.siteKey || '')}','${esc(v.id)}')`);
  return `<div class="poster" tabindex="0" onclick="${act}" onkeydown="if(event.key==='Enter'){${act}}">
    ${pic ? `<img class="thumb" src="${esc(pic)}" loading="lazy" onerror="this.style.opacity=0">` : '<div class="thumb"></div>'}
    <div class="badges">${badges.join('')}</div>${note}
    <div class="caption"><div class="pname">${esc(v.name)}</div><div class="psub">${esc(sub)}</div></div>
  </div>`;
}
let searchRowSeq = 0;
const searchRowData = new Map();
function rowHTML(title, videos, siteKey, tid, opts = {}) {
  if (!videos || !videos.length) return '';
  const expand = !!opts.searchExpand;
  const LIMIT = 12;
  let moreBtn, cardHtml;
  if (expand) {
    // 搜索页：不跳转，带全量数据，点击「展开全部」就地铺开并分批懒加载
    const rid = 'sr' + (++searchRowSeq);
    searchRowData.set(rid, { videos, siteKey });
    cardHtml = videos.slice(0, LIMIT).map(v => posterHTML({ ...v, siteKey })).join('');
    moreBtn = `<button class="row-more row-expand" data-rid="${rid}">展开全部 (${videos.length}) ›</button>`;
  } else {
    // 首页：带站源与分类跳到点播页筛选
    cardHtml = videos.map(v => posterHTML({ ...v, siteKey })).join('');
    moreBtn = `<button class="row-more" data-key="${esc(siteKey || '')}" data-tid="${esc(tid || '')}" data-name="${esc(title)}">查看更多 ›</button>`;
  }
  return `<div class="row"${expand ? ' data-search-row="1"' : ''}>
    <div class="row-head"><span class="bar"></span><h3>${esc(title)}</h3><span class="more">${videos.length} 部</span>${moreBtn}</div>
    <div class="row-scroll">${cardHtml}</div>
  </div>`;
}
/* 搜索结果行：点击「展开全部」把该源全部条目就地铺开（每批 12 个 + 触底追加），
   再点「收起」恢复为前 12 个；数据与 Observer 都挂在行节点上，重搜时随 DOM 一起丢弃。 */
function toggleSearchRow(btn) {
  const row = btn.closest('.row'), scroll = row?.querySelector('.row-scroll');
  const data = searchRowData.get(btn.dataset.rid);
  if (!scroll || !data) return;
  if (row.dataset.expanded === '1') {
    if (row._io) { row._io.disconnect(); row._io = null; }
    row.dataset.expanded = '';
    scroll.classList.remove('expanded');
    scroll.innerHTML = data.videos.slice(0, 12).map(v => posterHTML({ ...v, siteKey: data.siteKey })).join('');
    btn.textContent = `展开全部 (${data.videos.length}) ›`;
    refreshFocusables();
    return;
  }
  row.dataset.expanded = '1';
  scroll.classList.add('expanded');
  btn.textContent = '收起 ‹';
  let shown = Math.min(12, data.videos.length);
  const appendMore = () => {
    const end = Math.min(shown + 12, data.videos.length);
    if (end > shown) {
      scroll.insertAdjacentHTML('beforeend', data.videos.slice(shown, end).map(v => posterHTML({ ...v, siteKey: data.siteKey })).join(''));
      shown = end;
      refreshFocusables();
    }
    if (row._io) {
      row._io.disconnect();
      if (shown < data.videos.length) { const last = scroll.lastElementChild; if (last) row._io.observe(last); }
      else { row._io.disconnect(); row._io = null; }
    }
  };
  row._io = new IntersectionObserver(es => { if (es[0].isIntersecting) appendMore(); }, { root: null, rootMargin: '600px' });
  appendMore();
}

/* ---------------- 首页：多行海报墙 ---------------- */
let homeLoadSeq = 0;
async function loadHome() {
  const seq = ++homeLoadSeq;
  const wrap = $('#home-rows');
  // 首页推荐（原版 HOME_REC）：观看历史模式不依赖站点
  if (LS.get('homeRec', 'site') === 'history') {
    $('#home-classes').innerHTML = '';
    $('#home-tip').textContent = '观看历史';
    const hist = LS.get('history', []);
    if (!hist.length) { wrap.innerHTML = '<div class="empty-big">暂无观看历史。看过的影片会出现在这里（设置 → 首页推荐 切换回站点推荐）。</div>'; return; }
    const cards = hist.slice(0, 30).map(v => posterHTML(v)).join('');
    wrap.innerHTML = `<div class="row"><div class="row-head"><span class="bar"></span><h3>最近观看</h3><span class="more">${hist.length} 条</span></div><div class="row-scroll">${cards}</div></div>`;
    refreshFocusables();
    return;
  }
  if (!state.sites.length) { $('#home-classes').innerHTML = ''; wrap.innerHTML = '<div class="empty-big">未配置点播源。到「设置 → 配置地址」粘贴 TVBox 配置或导入订阅。</div>'; return; }
  let key = state.homeKey || state.sites[0].key;
  wrap.innerHTML = '<div class="empty-big">加载中…</div>';
  siteSpinOn('home');
  try {
    // 只请求当前选中的站源：解析失败就明确提示，绝不自动切到其它源
    let home = null, homeErr = '';
    try { home = await apiTimeout('/api/vod/home', { key }, 15000); } catch (e) { home = null; homeErr = e?.message || ''; }
    if (seq !== homeLoadSeq) return;
    if (!home || !(home.classes?.length || home.videos?.length || home.list?.length)) {
      $('#home-classes').innerHTML = '';
      const siteName = state.sites.find(s => s.key === key)?.name || key;
      $('#home-tip').textContent = '源：' + siteName;
      const reason = homeErr ? `<br><span style="opacity:.75">原因：${esc(homeErr)}</span>` : '';
      wrap.innerHTML = `<div class="empty-big">当前站点「${esc(siteName)}」内容加载失败（可能已失效或网络问题）。${reason}<br>请在上方「站源」下拉框中切换其它站点，或到「设置 → 配置地址」重新导入。</div>`;
      return;
    }
    state.homeKey = key;
    const site = state.sites.find(s => s.key === key);
    $('#home-tip').textContent = '源：' + (site?.name || key);
    const hs = $('#home-site'); if (hs && hs.value !== key) hs.value = key;
    // 类型导航（从当前源获取；"主页"由上方站源切换框承担，不再加）
    renderHomeClasses(home.classes || [], key);
    // 先渲染"最近更新"，分类行逐个追加（避免等 8 个请求串行结束才出内容）
    wrap.innerHTML = (home.videos && home.videos.length)
      ? rowHTML('最近更新', home.videos, key)
      : '<div class="empty-big" id="home-loading">加载中…</div>';
    refreshFocusables();
    const classes = (home.classes || []).slice(0, 8);
    let added = 0;
    for (const c of classes) {
      try {
        const r = await api('/api/vod/category', { key, tid: c.tid, pg: 1 });
        if (seq !== homeLoadSeq) return;
        if (!r.videos || !r.videos.length) continue;
        // 首个分类行到达时移除"加载中…"占位，避免分类已显示、顶部还挂着旧占位
        const ph = $('#home-loading'); if (ph) ph.remove();
        wrap.insertAdjacentHTML('beforeend', rowHTML(c.name, r.videos, key, c.tid));
        added++;
        refreshFocusables();
      } catch (_) {}
    }
    if (!home.videos?.length && !added) wrap.innerHTML = '<div class="empty-big">该站源暂无数据</div>';
  } finally { siteSpinOff('home'); }
}

/* 首页类型导航：从当前站点源的 classes 获取，点击跳到点播页对应分类 */
function renderHomeClasses(classes, key) {
  const box = $('#home-classes');
  if (!classes.length) { box.innerHTML = ''; return; }
  box.innerHTML = classes.map(c => `<button class="hc" data-tid="${esc(c.tid)}" data-name="${esc(c.name)}">${esc(c.name)}</button>`).join('');
  $$('#home-classes .hc').forEach(btn => btn.onclick = () => {
    state.vodKey = key; LS.set('vodKey', key);
    state.vodClass = btn.dataset.tid; state.vodPage = 1;
    switchView('vod'); loadVodClasses();
  });
  refreshFocusables();
}

/* ---------------- 点播分类 ---------------- */
// 竞态序号：切换接口后，旧 key 的延迟请求不得覆盖新源的选中项与提示
let vodLoadSeq = 0;
async function loadVodClasses() {
  const seq = ++vodLoadSeq;
  const sel = $('#vod-site');
  sel.innerHTML = state.sites.map(s => `<option value="${esc(s.key)}">${esc(s.name)}</option>`).join('');
  if (!state.sites.length) { $('#vod-classes').innerHTML = ''; $('#vod-grid').innerHTML = ''; $('#vod-empty').style.display = ''; return; }
  let key = state.vodKey || state.sites[0].key;
  sel.value = key;
  siteSpinOn('vod');
  try {
    // 只请求当前选中的站源：解析失败就明确提示，绝不自动切到其它源
    let home = null;
    try { home = await apiTimeout('/api/vod/home', { key }, 15000); } catch (e) { home = null; }
    // 竞态守卫：若期间已切换接口/站源，本次是旧请求，直接退出，绝不改写当前选中项与提示
    if (seq !== vodLoadSeq) return;
    if (!home || !(home.classes?.length || home.videos?.length || home.list?.length)) {
      // 解析失败时不再锁定选中项：保留用户当前 key，避免旧失败请求把新源劫持成旧源
      if (state.vodKey !== key) { sel.value = state.vodKey; return; }
      sel.value = key;
      $('#vod-classes').innerHTML = ''; $('#vod-grid').innerHTML = '';
      $('#vod-empty').style.display = '';
      const siteName = state.sites.find(s => s.key === key)?.name || key;
      $('#vod-empty').textContent = `当前站点「${siteName}」解析失败，请在上方站源下拉框中切换其它站点，或到「设置 → 配置地址」重新导入。`;
      return;
    }
    state.vodKey = key; LS.set('vodKey', key); sel.value = key;
    try {
      let classes = home.classes || [];
      // 无分类但有视频的站点（部分接口 ac=list 不返回 class）：补一个"全部"分类，避免内容无法显示
      if (!classes.length && (home.videos?.length || home.list?.length)) classes = [{ tid: '', name: '全部' }];
      $('#vod-classes').innerHTML = classes.map(c => `<button class="chip ${c.tid === state.vodClass ? 'active' : ''}" data-tid="${esc(c.tid)}">${esc(c.name)}</button>`).join('');
      $$('#vod-classes .chip').forEach(ch => ch.onclick = () => {
        state.vodClass = ch.dataset.tid; state.vodPage = 1;
        $$('#vod-classes .chip').forEach(x => x.classList.toggle('active', x === ch));
        loadVodGrid();
      });
      state.vodClass = state.vodClass || (classes[0]?.tid || '');
      $$('#vod-classes .chip').forEach(x => x.classList.toggle('active', x.dataset.tid === state.vodClass));
      $('#vod-empty').style.display = classes.length ? 'none' : '';
      if (classes.length) loadVodGrid();
    } catch (e) { $('#vod-empty').style.display = ''; $('#vod-empty').textContent = '加载失败：' + e.message; }
  } finally { siteSpinOff('vod'); }
}
async function loadVodGrid() {
  if (!state.vodKey || !state.vodClass) return;
  // 记录本次请求的选中项：返回时若用户已切换接口/分类/页码，丢弃旧结果
  const reqKey = state.vodKey, reqClass = state.vodClass, reqPage = state.vodPage;
  const grid = $('#vod-grid'); grid.innerHTML = '<div class="empty-big">加载中…</div>';
  siteSpinOn('vod');
  try {
    const r = await api('/api/vod/category', { key: reqKey, tid: reqClass, pg: reqPage });
    if (state.vodKey !== reqKey || state.vodClass !== reqClass || state.vodPage !== reqPage) return;
    state.vodPageCount = Math.max(1, Number(r.pagecount) || 1);
    $('#vod-page').textContent = `${state.vodPage} / ${state.vodPageCount}`;
    $('#vod-prev').style.opacity = state.vodPage <= 1 ? '.35' : '1';
    $('#vod-next').style.opacity = state.vodPage >= state.vodPageCount ? '.35' : '1';
    $('#vod-first').style.opacity = state.vodPage <= 1 ? '.35' : '1';
    $('#vod-last').style.opacity = state.vodPage >= state.vodPageCount ? '.35' : '1';
    renderVodPages();
    // 网页文章列表：保存 id/名称序列，供阅读器"上一篇/下一篇"导航
    state.articleList = r.videos.map(v => ({ id: v.id, name: v.name }));
    grid.innerHTML = r.videos.map(v => posterHTML({ ...v, siteKey: state.vodKey })).join('');
    $('#vod-empty').style.display = r.videos.length ? 'none' : '';
    refreshFocusables();
  } catch (e) { grid.innerHTML = `<div class="empty-big">加载失败：${esc(e.message)}</div>`; }
  finally { siteSpinOff('vod'); }
}
/* 数字页码：当前页 ±2 + 首尾页，中间用 … 省略；点击直达对应页 */
function renderVodPages() {
  const box = $('#vod-pages'); if (!box) return;
  const cur = state.vodPage, total = state.vodPageCount;
  const set = new Set([1, total]);
  for (let i = cur - 2; i <= cur + 2; i++) if (i >= 1 && i <= total) set.add(i);
  const pages = [...set].sort((a, b) => a - b);
  let html = '', prev = 0;
  for (const p of pages) {
    if (p - prev > 1) html += '<span class="pg-gap">…</span>';
    html += `<button class="pg-num ${p === cur ? 'active' : ''}" data-p="${p}">${p}</button>`;
    prev = p;
  }
  box.innerHTML = html;
  $$('#vod-pages .pg-num').forEach(b => b.onclick = () => {
    const p = +b.dataset.p;
    if (p !== state.vodPage && p >= 1 && p <= state.vodPageCount) { state.vodPage = p; loadVodGrid(); }
  });
  refreshFocusables();
}

/* ---------------- 详情弹层 ---------------- */
// 关闭/再次打开时清空上一次详情，避免闪现旧海报、旧简介、旧选集
function clearDetailBox() {
  state.detail = null;
  const dpic = $('#detail-pic');
  if (dpic) { dpic.onerror = null; dpic.onclick = null; dpic.removeAttribute('src'); dpic.style.opacity = 1; dpic.style.cursor = 'default'; }
  const texts = ['detail-name','detail-site','detail-year','detail-area','detail-lang','detail-type','detail-remarks','detail-actor','detail-director','detail-des'];
  texts.forEach(t => { const el = $('#' + t); if (el) el.textContent = ''; });
  ['detail-eps','ep-lines'].forEach(t => { const el = $('#' + t); if (el) el.innerHTML = ''; });
  const rd = $('#detail-read'); if (rd) rd.style.display = 'none';
}
async function openDetail(siteKey, id, article) {
  const box = $('#detail'); clearDetailBox(); box.classList.remove('hidden');
  $('#detail-name').textContent = '加载中…';
  try {
    const d = await api('/api/vod/detail', article ? { key: siteKey, id, article: 1 } : { key: siteKey, id });
    // 只有真正取到图文正文/图集，且没有播放地址时，才算可读资源。
    // 源站可能把小说正文塞进视频详情，或列表标记 article 但详情命中同名视频；
    // 这两种情况一律按视频处理，避免“在线播放 + 开始阅读”同时出现。
    const hasArticleBody = !!((d.images && d.images.length) || String(d.contentText || '').trim().length >= 30);
    const hasPlays = (Array.isArray(d.plays) && d.plays.length > 0)
      || !!(d.play_url || d.vod_play_url);
    const readable = hasArticleBody && !hasPlays;
    state.detail = { ...d, siteKey, fromArticle: readable };
    state.epLine = 0; state.epSortAsc = true;
    const readBtn = $('#detail-read');
    if (readBtn) readBtn.style.display = readable ? '' : 'none';
    const dpic = $('#detail-pic');
    // 图文/图集详情：优先复用列表已加载的封面接口地址（同 key+id 命中浏览器缓存，避免弹窗重复加载）。
    // 只有非图文（视频）条目才用详情自带的 pic；图文条目不再用 d.pic 原始外链（易被CDN拦且缓存不互通）。
    const coverApi = siteKey && id
      ? `/api/vod/cover?key=${encodeURIComponent(siteKey)}&id=${encodeURIComponent(id)}` : '';
    // 列表里已加载的真实封面地址（coverApi 对普通视频站只会返回透明占位图，不当作真实封面）
    const listedPic = id ? (coverCache.get(String(siteKey || '') + '||' + String(id)) || coverCache.get(String(id)) || '') : '';
    const realListed = listedPic && !listedPic.startsWith('/api/vod/cover') ? listedPic : '';
    // 视频条目：详情自带 pic 优先；没有则复用列表真实封面（同地址命中缓存）；最后才用 coverApi（仅图文站有效）
    const cover = readable
      ? (coverApi || d.pic || realListed || '')
      : (d.pic || realListed || coverApi || '');
    dpic.onerror = () => { dpic.style.opacity = 0; };
    dpic.style.opacity = 1;
    dpic.src = cover || '';
    // 详情封面点击放大浏览：直接用详情里已成功显示的原始地址，避免二次经代理失败导致灯箱空白。
    // 只有原始图确实加载失败时，才在灯箱内降级走图片代理重试一次。
    dpic.style.cursor = cover ? 'zoom-in' : 'default';
    dpic.onclick = cover ? () => openLightbox([cover], 0) : null;
    $('#detail-name').textContent = d.name || '未命名';
    $('#detail-site').textContent = state.sites.find(s => s.key === siteKey)?.name || siteKey;
    $('#detail-year').textContent = d.year || '';
    $('#detail-area').textContent = d.area || '';
    $('#detail-lang').textContent = d.lang || '';
    $('#detail-type').textContent = d.type || '';
    $('#detail-remarks').textContent = d.remarks || '';
    $('#detail-actor').textContent = d.actor || '—';
    $('#detail-director').textContent = d.director || '—';
    const bodyText = d.contentText && d.contentText.length > (d.des || '').length ? d.contentText : (d.des || '');
    $('#detail-des').textContent = bodyText || '暂无简介';
    // 与“开始阅读”按钮使用同一判断，避免按钮和选集区行为不一致
    if (readable) {
      renderImageArticle(d);
    } else {
      renderVideoEpisodes(d);
    }
    const fav = LS.get('fav', []);
    $('#detail-fav').textContent = fav.some(x => x.id === d.id && x.siteKey === siteKey) ? '取消收藏' : '加入收藏';
  } catch (e) {
    $('#detail-name').textContent = '加载失败：' + e.message;
  }
}
/* ================= 网页文章阅读器（由详情弹层“开始阅读”进入） ================= */
let articleFontSize = LS.get('articleFontSize', 21);
async function openArticleReader(siteKey, id) {
  const box = $('#article-reader'); if (!box) return;
  box.classList.remove('hidden');
  $('#ar-h1').textContent = '加载中…';
  $('#ar-meta').textContent = '';
  $('#ar-content').innerHTML = '';
  $('#ar-scroll').scrollTop = 0;
  try {
    const d = await apiTimeout('/api/vod/detail', { key: siteKey, id, article: 1 }, 15000);
    state.article = { key: siteKey, id, ...d };
    $('#ar-h1').textContent = d.name || '未命名';
    const site = state.sites.find(s => s.key === siteKey);
    const len = (d.contentText || '').length;
    $('#ar-meta').textContent = [site ? site.name : '', len ? len + ' 字' : '', (d.images || []).length ? d.images.length + ' 图' : ''].filter(Boolean).join(' · ');
    const imgs = (d.images || []).filter(Boolean);
    let html = '';
    if (d.contentText) html += `<div class="ar-text" style="font-size:${articleFontSize}px">${esc(d.contentText).replace(/\n/g, '<br>')}</div>`;
    if (imgs.length) html += '<div class="ar-gallery" id="ar-gallery"></div><div class="ar-load-more" id="ar-load-more"></div>';
    $('#ar-content').innerHTML = html || '<div class="empty-big">暂无正文</div>';
    if (imgs.length) renderArticleGallery(imgs);  // 分批惰性加载，避免一次拉几十上百张图
    updateArticleNav();
    applyArticleFont();
    refreshFocusables();
  } catch (e) {
    $('#ar-content').innerHTML = `<div class="empty-big">加载失败：${esc(e.message)}</div>`;
  }
}
/* 阅读器图集：分批惰性加载。每次只创建 12 个 img，滚动到底部哨兵时才追加下一批，
   彻底避免一进阅读器就发起几十上百个图片请求导致卡顿。 */
let articleGalleryIO = null;
function renderArticleGallery(imgs) {
  if (articleGalleryIO) { articleGalleryIO.disconnect(); articleGalleryIO = null; }
  const gallery = $('#ar-gallery'), sentinel = $('#ar-load-more');
  if (!gallery || !imgs.length) return;
  gallery.innerHTML = '';
  const BATCH = 12;
  let shown = 0;
  const proxied = imgs.map(articleImgUrl);
  const appendBatch = () => {
    const end = Math.min(shown + BATCH, imgs.length);
    const frag = document.createDocumentFragment();
    for (let i = shown; i < end; i++) {
      const cell = document.createElement('div');
      cell.className = 'ar-img';
      cell.dataset.i = String(i);
      const img = document.createElement('img');
      img.loading = 'lazy';            // 浏览器层再兜底：视口外不真正解码
      img.onerror = function () { this.parentElement.style.opacity = .3; };
      img.src = proxied[i];            // 只在进入本批时才设 src
      cell.appendChild(img);
      cell.onclick = () => openLightbox(proxied, i);
      frag.appendChild(cell);
    }
    gallery.appendChild(frag);
    shown = end;
    sentinel.textContent = shown < imgs.length
      ? `已显示 ${shown}/${imgs.length} 张 · 继续下滑加载`
      : `共 ${imgs.length} 张 · 已全部加载`;
    if (shown >= imgs.length && articleGalleryIO) { articleGalleryIO.disconnect(); articleGalleryIO = null; }
  };
  appendBatch();
  if (shown < imgs.length) {
    // root 用阅读器滚动容器；提前 600px 触发，滚动流畅无空白
    articleGalleryIO = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) appendBatch();
    }, { root: $('#ar-scroll'), rootMargin: '600px 0px' });
    articleGalleryIO.observe(sentinel);
  }
}
function closeArticleReader() {
  $('#article-reader').classList.add('hidden');
  if (articleGalleryIO) { articleGalleryIO.disconnect(); articleGalleryIO = null; }
}
function updateArticleNav() {
  const list = state.articleList || [];
  const i = list.findIndex(x => String(x.id) === String(state.article?.id));
  const prev = $('#ar-prev'), next = $('#ar-next');
  if (prev) prev.style.opacity = i > 0 ? '1' : '.35';
  if (next) next.style.opacity = i >= 0 && i < list.length - 1 ? '1' : '.35';
}
function articleStep(dir) {
  const list = state.articleList || [];
  const i = list.findIndex(x => String(x.id) === String(state.article?.id));
  const j = i + dir;
  if (j < 0 || j >= list.length) { toast(dir < 0 ? '已是第一篇' : '已是最后一篇'); return; }
  const key = state.article?.key || state.vodKey;
  openArticleReader(key, list[j].id);
}
function applyArticleFont() {
  const el = $('#ar-content .ar-text'); if (el) el.style.fontSize = articleFontSize + 'px';
  const lab = $('#ar-font-label'); if (lab) lab.textContent = articleFontSize;
}
function articleFontStep(delta) {
  articleFontSize = Math.max(14, Math.min(40, articleFontSize + delta));
  LS.set('articleFontSize', articleFontSize);
  applyArticleFont();
}

// 视频：渲染线路与选集（原逻辑）
function renderVideoEpisodes(d) {
  const epsBox = $('#detail-eps'); epsBox.onclick = null; epsBox.style.cursor = '';
  $('#ep-lines').style.display = '';
  const playBtn = $('#detail-play'); if (playBtn) playBtn.style.display = '';
  $('.detail-ep-head .ep-title') && ($('.detail-ep-head .ep-title').textContent = '选集');
  $('#ep-lines').innerHTML = (d.plays || []).map((p, i) => `<div class="ep-line ${i === 0 ? 'active' : ''}" data-i="${i}">${esc(p.flag)}</div>`).join('');
  $$('#ep-lines .ep-line').forEach(el => el.onclick = () => {
    state.epLine = +el.dataset.i;
    $$('#ep-lines .ep-line').forEach(x => x.classList.toggle('active', x === el));
    renderEpisodes();
  });
  renderEpisodes();
}

// 图片/图文小说弹窗：只放少量预览（1 张图 + 截断正文），不在这里加载完整内容。
// 点「开始阅读」进阅读器才按页全部加载，避免一开弹窗就拉几十张图/整篇小说。
function renderImageArticle(d) {
  const isImage = d.kind === 'image' || (d.images && d.images.length >= 2);
  const title = isImage ? '图集' : '图文阅读';
  $('.detail-ep-head .ep-title') && ($('.detail-ep-head .ep-title').textContent = title);
  $('#ep-lines').style.display = 'none';
  const playBtn = $('#detail-play'); if (playBtn) playBtn.style.display = 'none';
  const imgs = (d.images || []).filter(Boolean);
  const box = $('#detail-eps');
  // 不再在弹窗下方渲染预览图：它与顶部封面重复加载同一批图源，且每次打开都会重新请求。
  // 封面已在弹窗顶部展示，这里只保留图文统计与「开始阅读」入口。
  let html = '';
  const text = String(d.contentText || '').trim();
  if (!isImage && text) {
    const short = text.length > 120 ? text.slice(0, 120) + '…' : text;
    html += `<div class="res-article">${esc(short).replace(/\n/g, '<br>')}</div>`;
  }
  const counts = [];
  if (imgs.length) counts.push(imgs.length + ' 图');
  if (text.length) counts.push(text.length + ' 字');
  html += `<div class="res-hint">${counts.length ? counts.join(' · ') + '，' : ''}点击「开始阅读」查看全部</div>`;
  box.innerHTML = html;
  box.style.cursor = 'pointer';
  box.onclick = () => openArticleReader(d.siteKey || state.vodKey, d.id);
  refreshFocusables();
}

function renderEpisodes() {
  const plays = state.detail?.plays || [];
  const line = plays[state.epLine];
  let eps = line ? [...line.episodes] : [];
  if (!state.epSortAsc) eps.reverse();
  $('#detail-eps').innerHTML = eps.map((e, i) => `<div class="ep ${i === 0 ? 'active' : ''}" data-i="${i}">${esc(e.name)}</div>`).join('')
    || '<div class="empty-big">暂无播放数据</div>';
  $$('#detail-eps .ep').forEach(el => el.onclick = () => {
    $$('#detail-eps .ep').forEach(x => x.classList.remove('active'));
    el.classList.add('active');
    playVod(+el.dataset.i);
  });
}
function closeDetail() { $('#detail').classList.add('hidden'); clearDetailBox(); stopVodPlayer(); }

/* ---------------- 点播播放 ---------------- */
function proxyUrl(url) { return '/api/proxy?url=' + encodeURIComponent(url) + (LS.get('m3u8Purify', false) ? '&purify=1' : ''); }
// 图文正文图片：走代理并允许 https→http 降级（图床 https 常被 CDN 拦）
function articleImgUrl(url) { return '/api/proxy?img=1&url=' + encodeURIComponent(url); }
function playVod(epIdx) {
  const d = state.detail; if (!d) return;
  const plays = d.plays || []; const line = plays[state.epLine];
  const eps = line?.episodes || []; const ep = eps[epIdx];
  if (!ep) { toast('没有可用的播放地址'); return; }
  closeDetailSilently();
  switchViewRaw('player');
  state.player = { siteKey: d.siteKey, id: d.id, name: d.name, line: state.epLine, epIdx, plays };
  $('#player-title').textContent = `${d.name} · ${ep.name}`;
  // 线路/选集下拉
  $('#player-line').innerHTML = plays.map((p, i) => `<option value="${i}" ${i === state.epLine ? 'selected' : ''}>${esc(p.flag)}</option>`).join('');
  $('#player-ep').innerHTML = eps.map((e, i) => `<option value="${i}" ${i === epIdx ? 'selected' : ''}>${esc(e.name)}</option>`).join('');
  attachVodSource(ep.url);
  // 记录历史（原版：历史记录数量 + 历史合并）
  const hist = LS.get('history', []);
  const rec = { id: d.id, siteKey: d.siteKey, name: d.name, pic: d.pic, year: d.year, type: d.type, ts: Date.now() };
  let next;
  if (LS.get('historyMerge', true)) {
    next = [rec, ...hist.filter(x => !(x.id === d.id && x.siteKey === d.siteKey))];
  } else {
    next = [rec, ...hist];
  }
  LS.set('history', next.slice(0, LS.get('historyNum', 60)));
}
function closeDetailSilently() { $('#detail').classList.add('hidden'); }
function switchViewRaw(v) {
  // 进入播放器时记下来源页面；已在播放器内（切集/推送/本地连续播放）时不覆盖
  if (v === 'player' && currentView !== 'player') playerReturnView = currentView || 'home';
  currentView = v;
  document.body.dataset.view = v;
  $$('.view').forEach(x => x.classList.remove('active'));
  const el = $('#view-' + v); if (el) el.classList.add('active');
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'player') pokePlayerUi(); else clearTimeout(playerUiTimer);
}
/* ---------------- 全屏状态：ESC 优先退出全屏，不被当成“返回” ---------------- */
// 视频用原生 controls 的全屏按钮会走 Fullscreen API；ESC 的默认退出行为在部分
// Electron/Chromium 版本下不会派发到页面，但 keydown 会命中全局 ESC 处理器。
// 若此时执行 backFromPlayer()，播放视图被隐藏而全屏状态残留，软件就卡在全屏。
let lastExitFullscreenAt = -Infinity;
function inFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
}
function exitFullscreenSafely() {
  lastExitFullscreenAt = performance.now();
  if (!inFullscreen()) return;
  const fn = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen;
  if (!fn) return;
  try {
    const p = fn.call(document);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {}
}
function onFullscreenChange() {
  if (!inFullscreen()) lastExitFullscreenAt = performance.now();
}
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

// 从播放器返回进入前的页面（点播/首页/搜索/收藏/历史…），而不是固定回首页
function backFromPlayer() {
  // 保险：若仍在全屏（例如点返回按钮时），先退出全屏再切视图，避免全屏残留
  if (inFullscreen()) exitFullscreenSafely();
  const target = playerReturnView && $('#view-' + playerReturnView) ? playerReturnView : 'home';
  switchView(target);
}
/* 点播播放器音量：滑块独立于原生 controls，视频未加载时也能设置并持久化 */
function applyVodVolume() {
  const video = $('#vod-video'); if (!video) return;
  const val = Number($('#vod-vol')?.value ?? LS.get('vodVol', 80));
  video.volume = val / 100;
  video.muted = val === 0;
  const vv = $('#vod-vol-val'); if (vv) vv.textContent = val;
  const mb = $('#vod-mute'); if (mb) mb.textContent = val === 0 ? '🔇' : '🔊';
  LS.set('vodVol', val);
}
function initVodVolume() {
  const slider = $('#vod-vol'); if (!slider) return;
  slider.value = LS.get('vodVol', 80);
  slider.oninput = applyVodVolume;
  $('#vod-mute').onclick = () => {
    const video = $('#vod-video');
    const cur = +slider.value;
    if (cur === 0 || video?.muted) { slider.value = Number(LS.get('vodVolLast', 80)) || 80; }
    else { LS.set('vodVolLast', cur); slider.value = 0; }
    applyVodVolume();
  };
  applyVodVolume();
}
function attachVodSource(url) {
  const video = $('#vod-video');
  applyVodVolume();  // 播放前先把已保存音量设上，无需等待加载
  const finalUrl = /^https?:/i.test(url) ? proxyUrl(url) : url;
  $('#player-msg').textContent = '加载中…';
  try { if (state.hls) { state.hls.destroy(); state.hls = null; } } catch {}
  if (/\.m3u8/i.test(url) && window.Hls?.isSupported?.()) {
    state.hls = new Hls({ enableWorker: true, lowLatencyMode: false });
    state.hls.loadSource(finalUrl);
    state.hls.attachMedia(video);
    state.hls.on(Hls.Events.MANIFEST_PARSED, () => { $('#player-msg').textContent = ''; video.play().catch(() => {}); });
    state.hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) $('#player-msg').textContent = '播放失败：' + (data.details || '源不可用'); });
  } else {
    video.src = finalUrl;
    video.onplaying = () => { $('#player-msg').textContent = ''; };
    video.onerror = () => { $('#player-msg').textContent = '播放失败：源不可用或格式不支持'; };
    video.play().catch(() => {});
  }
}
/* 播放控件（顶部标题栏 + 底部选集栏）随原生进度条自动隐藏：
   原生 <video controls> 无显隐事件，这里用"鼠标移动/键盘操作=有操作，
   静止 ~3 秒=隐藏"来同步；暂停时常驻（原生进度条暂停时也常驻）。 */
let playerUiTimer = null;
function showPlayerUi() {
  const view = $('#view-player'); if (!view) return;
  view.querySelector('.player-top')?.classList.remove('player-ui-hidden');
  view.querySelector('.player-bottom')?.classList.remove('player-ui-hidden');
}
function hidePlayerUi() {
  const view = $('#view-player'); if (!view) return;
  const video = $('#vod-video');
  // 暂停、或键盘焦点落在控件上时保持显示，避免遮挡操作
  if (video && video.paused) return;
  // 方向键焦点落在控件上时保持显示，避免遮挡键盘操作。
  // 不能用 document.activeElement：鼠标点过按钮后焦点会滞留其上，导致永不隐藏。
  const kbdOnUi = view.querySelector('.player-top .focus,.player-bottom .focus');
  if (kbdOnUi) { schedulePlayerUiHide(); return; }
  view.querySelector('.player-top')?.classList.add('player-ui-hidden');
  view.querySelector('.player-bottom')?.classList.add('player-ui-hidden');
}
function schedulePlayerUiHide() {
  clearTimeout(playerUiTimer);
  playerUiTimer = setTimeout(hidePlayerUi, 3000);
}
function pokePlayerUi() { showPlayerUi(); schedulePlayerUiHide(); }
function setupPlayerAutoHide() {
  const view = $('#view-player'); const video = $('#vod-video');
  if (!view || !video) return;
  view.addEventListener('mousemove', pokePlayerUi);
  view.addEventListener('mouseenter', pokePlayerUi);
  view.addEventListener('mouseleave', () => { clearTimeout(playerUiTimer); playerUiTimer = setTimeout(hidePlayerUi, 800); });
  video.addEventListener('play', pokePlayerUi);
  video.addEventListener('playing', pokePlayerUi);
  video.addEventListener('pause', () => { clearTimeout(playerUiTimer); showPlayerUi(); });
  video.addEventListener('ended', () => { clearTimeout(playerUiTimer); showPlayerUi(); });
}

function stopVodPlayer() {
  try { if (state.hls) { state.hls.destroy(); state.hls = null; } } catch {}
  const v = $('#vod-video'); if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
}
// 选集/线路切换后重新播放（原版播放器核心操作）
function selectEpAndPlay() {
  const p = state.player; if (!p) return;
  const play = p.plays?.[p.line || 0] || p.plays?.[0];
  const ep = play?.episodes?.[p.epIdx];
  if (!ep) { toast('没有更多剧集'); return; }
  $('#player-title').textContent = `${p.name || ''}${ep.name ? ' · ' + ep.name : ''}`;
  // 同步下拉框
  const epSel = $('#player-ep');
  if (epSel && play.episodes?.length) { epSel.innerHTML = play.episodes.map((e, i) => `<option value="${i}" ${i === p.epIdx ? 'selected' : ''}>${esc(e.name)}</option>`).join(''); }
  const isLocal = /^\/api\/file\//.test(ep.url);
  if (isLocal) { playLocalFile(decodeURIComponent(ep.url.split('path=')[1] || ''), ep.name || p.name || '本地'); return; }
  attachVodSource(ep.url);
}

/* ---------------- 直播 ---------------- */
async function loadLiveSources() {
  const sel = $('#live-source');
  sel.innerHTML = state.lives.map(l => `<option value="${esc(l.key)}">${esc(l.name)}</option>`).join('');
  if (!state.lives.length) { state.liveKey = ''; $('#live-groups').innerHTML = ''; $('#live-channels').innerHTML = '<div class="empty-big">未配置直播源</div>'; return; }
  // 直播源被整体替换后旧 key 可能失效，回退到第一条
  if (!state.lives.some(l => l.key === state.liveKey)) state.liveKey = state.lives[0].key;
  const key = state.liveKey; sel.value = key;
  await loadLivePlaylist(key);
}
async function loadLivePlaylist(key, force) {
  $('#live-channels').innerHTML = '<div class="empty-big">加载列表…</div>';
  $('#live-msg').textContent = '加载频道列表…';
  try {
    const data = await api('/api/live/playlist', { key, force: force ? 1 : '' });
    state.liveData = data; state.liveKey = key;
    renderLiveGroups();
    const first = data.groups[0] || '';
    selectLiveGroup(first);
    $('#live-msg').textContent = data.channels.length ? `共 ${data.channels.length} 个频道，选择开始播放` : '暂无频道';
  } catch (e) {
    $('#live-channels').innerHTML = `<div class="empty-big">加载失败：${esc(e.message)}</div>`;
    $('#live-msg').textContent = '频道列表加载失败';
  }
}
function renderLiveGroups() {
  const gs = state.liveData?.groups || [];
  $('#live-groups').innerHTML = gs.map(g => `<div class="lg ${g === state.liveGroup ? 'active' : ''}" data-g="${esc(g)}">${esc(g)}</div>`).join('');
  $$('#live-groups .lg').forEach(el => el.onclick = () => selectLiveGroup(el.dataset.g));
}
function selectLiveGroup(g) {
  state.liveGroup = g;
  $$('#live-groups .lg').forEach(x => x.classList.toggle('active', x.dataset.g === g));
  const kw = ($('#live-filter').value || '').trim();
  state.liveChannels = (state.liveData?.channels || []).filter(c => (!g || c.group === g) && (!kw || c.name.includes(kw)));
  renderLiveChannels();
}
function renderLiveChannels() {
  $('#live-channels').innerHTML = state.liveChannels.map((c, i) => `<div class="ch ${i === state.liveIdx ? 'active' : ''}" data-i="${i}" title="${c.geo ? '该地区受限' : esc(c.name)}">${esc(c.name)}${c.geo ? '<span class="ch-geo">锁区</span>' : ''}</div>`).join('')
    || '<div class="empty-big">该分组暂无频道</div>';
  $$('#live-channels .ch').forEach(el => el.onclick = () => playLive(+el.dataset.i));
}
function playLive(idx) {
  const c = state.liveChannels[idx]; if (!c) return;
  state.liveIdx = idx;
  $$('#live-channels .ch').forEach((x, i) => x.classList.toggle('active', i === idx));
  $('#live-big-name').textContent = c.name;
  $('#epg-ch').textContent = c.name;
  $('#epg-now').textContent = '正在加载节目…';
  $('#epg-next').textContent = '';
  $('#epg-src').textContent = `源 1/${state.liveChannels.length}`;
  $('#lr-line-val').textContent = `${idx + 1}/${state.liveChannels.length}`;
  const failMsg = c.geo ? '该地区受限：该频道有地区封锁，当前网络无法播放，请换其它频道' : '播放失败：该频道源不可用，试试换台';
  $('#live-msg').textContent = c.geo ? '提示：该频道有地区封锁，可能无法播放' : '';
  const video = $('#live-video');
  const url = proxyLiveUrl(c.url);
  try { if (state.hls) { state.hls.destroy(); state.hls = null; } } catch {}
  if (/\.m3u8/i.test(c.url) && window.Hls?.isSupported?.()) {
    state.hls = new Hls({ enableWorker: true, lowLatencyMode: true });
    state.hls.loadSource(url);
    state.hls.attachMedia(video);
    state.hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    state.hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) $('#live-msg').textContent = failMsg; });
  } else {
    video.src = url;
    video.onerror = () => { $('#live-msg').textContent = failMsg; };
    video.play().catch(() => {});
  }
  loadEpg(c.name);
}
function proxyLiveUrl(url) { return '/api/live/stream?url=' + encodeURIComponent(url); }
/* 直播左栏宽度拖动：拖动把手调整左栏宽度，分组列按比例联动，宽度持久化 */
function applyLiveWidth(w) {
  const left = $('#live-left'); if (!left) return;
  w = Math.max(280, Math.min(w, Math.round(window.innerWidth * 0.7)));
  document.documentElement.style.setProperty('--live-left-w', w + 'px');
  document.documentElement.style.setProperty('--live-group-w', Math.round(w * 0.4) + 'px');
}
function initLiveResize() {
  const handle = $('#live-resize'); if (!handle || handle._init) return; handle._init = true;
  applyLiveWidth(LS.get('liveLeftW', 400));
  let dragging = false, startX = 0, startW = 0;
  handle.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX;
    startW = $('#live-left').getBoundingClientRect().width;
    handle.classList.add('dragging'); e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    applyLiveWidth(startW + (e.clientX - startX));
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; handle.classList.remove('dragging');
    LS.set('liveLeftW', Math.round($('#live-left').getBoundingClientRect().width));
  });
}
async function loadEpg(name) {
  // 原版 EPG 依赖外部接口；免费源通常无 EPG，给出通用的节目时间提示
  const d = new Date();
  const h = d.getHours();
  const seg = h < 6 ? ['深夜剧场', '午夜新闻'] : h < 12 ? ['早间新闻', '上午剧场'] : h < 18 ? ['午间新闻', '下午剧场'] : ['晚间新闻', '黄金剧场'];
  $('#epg-now').textContent = `${String(h).padStart(2, '0')}:00  ${seg[0]}（该源无 EPG 数据）`;
  $('#epg-next').textContent = `${String((h + 1) % 24).padStart(2, '0')}:00  ${seg[1]}`;
}
function stopLive() { try { if (state.hls) { state.hls.destroy(); state.hls = null; } } catch {} const v = $('#live-video'); if (v) { v.pause(); v.removeAttribute('src'); v.load(); } }

/* ---------------- 搜索 ---------------- */
const HOT_WORDS = ['庆余年', '狂飙', '三体', '流浪地球', '甄嬛传', '权力的游戏', '哆啦A梦', 'Hello Kitty'];
function renderSearchExtra() {
  const hist = LS.get('searchHistory', []);
  $('#hot-words').innerHTML = HOT_WORDS.map(w => `<span class="se-chip" onclick="$('#search-input').value='${esc(w)}';doSearch()">${esc(w)}</span>`).join('');
  $('#search-history-words').innerHTML = hist.length
    ? hist.map(w => `<span class="se-chip" onclick="$('#search-input').value='${esc(w)}';doSearch()">${esc(w)}</span>`).join('')
    : '<span class="se-label" style="padding-top:6px">暂无</span>';
  $('#search-history').style.display = hist.length ? '' : 'none';
}
// 搜索竞态序号：连续搜索（按钮连点/Enter+按钮/快速点热词）时，只有最后一次的结果能写入，
// 避免旧请求或空结果延迟返回把已显示的结果覆盖成「没有找到结果」。
let searchLoadSeq = 0;
async function doSearch() {
  const wd = $('#search-input').value.trim();
  if (!wd) { toast('请输入关键词'); return; }
  const seq = ++searchLoadSeq;
  // 记录搜索历史
  const hist = LS.get('searchHistory', []);
  LS.set('searchHistory', [wd, ...hist.filter(x => x !== wd)].slice(0, 12));
  renderSearchExtra();
  const box = $('#search-results'); box.innerHTML = '<div class="empty-big">搜索中…</div>';
  $('#search-empty').style.display = 'none';
  try {
    const r = await api('/api/vod/search', { wd });
    if (seq !== searchLoadSeq) return;  // 已有更新的搜索，丢弃本次结果
    searchRowData.clear(); searchRowSeq = 0;  // 丢弃旧展开数据（须在确认本次为最新后）
    let html = '';
    for (const res of r.results || []) {
      if (!(res.videos || []).length) continue;  // 跳过无结果的站点，避免空行
      const siteName = state.sites.find(s => s.key === res.siteKey)?.name || res.siteKey;
      html += rowHTML(`${siteName} · 找到 ${res.videos.length} 部`, res.videos, res.siteKey, '', { searchExpand: true });
    }
    box.innerHTML = html || '<div class="empty-big">没有找到结果</div>';
    refreshFocusables();
  } catch (e) { if (seq === searchLoadSeq) box.innerHTML = `<div class="empty-big">搜索失败：${esc(e.message)}</div>`; }
}

/* ---------------- 推送：链接直接播放（PushActivity） ---------------- */
function extractPushUrl(text) {
  const t = String(text || '').trim();
  // 直接是链接
  if (/^https?:\/\//i.test(t)) return t.split(/\s/)[0];
  // TVBox 分享文本：从中提取第一个 http(s) 链接
  const m = t.match(/https?:\/\/[^\s"'<>，。；）)]+/i);
  return m ? m[0] : '';
}
function renderPushHistory() {
  const hist = LS.get('pushHistory', []);
  $('#push-history').innerHTML = hist.length ? hist.map((h, i) =>
    `<div class="push-hist-item" onclick="playPushUrl('${esc(h.url)}')">
       <span class="ph-url">${esc(h.url)}</span>
       <span class="ph-time">${esc(h.time || '')}</span>
       <span class="ph-del" onclick="event.stopPropagation();delPushHist(${i})">✕</span>
     </div>`).join('')
    : '<div class="empty-big" style="padding:14px">暂无推送记录</div>';
  refreshFocusables();
}
function delPushHist(i) {
  const hist = LS.get('pushHistory', []); hist.splice(i, 1); LS.set('pushHistory', hist); renderPushHistory();
}
function playPushUrl(url) {
  if (!url) { toast('链接无效'); return; }
  const hist = LS.get('pushHistory', []);
  LS.set('pushHistory', [{ url, time: new Date().toLocaleString('zh-CN', { hour12: false }) }, ...hist.filter(x => x.url !== url)].slice(0, 20));
  state.player = { name: '推送播放', siteKey: '', id: '', epIdx: 0, plays: [{ flag: '推送', episodes: [{ name: '直播/视频', url }] }] };
  $('#player-title').textContent = '推送播放';
  $('#player-line').innerHTML = '<option>推送</option>';
  $('#player-ep').innerHTML = '<option>1</option>';
  switchViewRaw('player');
  attachVodSource(url);
}

/* ---------------- 本地文件（LocalFileActivity） ---------------- */
function fmtSize(n) {
  if (!n) return '';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
async function loadFileRoot() {
  try {
    const r = await api('/api/file/roots');
    $('#file-path').textContent = '快捷目录';
    $('#file-empty').style.display = 'none';
    $('#file-list').innerHTML = '<div class="file-root-item">' +
      r.roots.map(x => `<div class="fr-chip" onclick="loadFileDir('${esc(x.path)}')">📁 ${esc(x.name)}</div>`).join('') + '</div>';
    refreshFocusables();
  } catch (e) { $('#file-empty').style.display = ''; $('#file-empty').textContent = '加载失败：' + e.message; }
}
async function loadFileDir(dir) {
  $('#file-empty').style.display = ''; $('#file-empty').textContent = '加载中…';
  $('#file-list').innerHTML = '';
  try {
    const r = await api('/api/file/list', { path: dir });
    state.fileDir = r.path;
    state.fileParent = r.parent;
    $('#file-path').textContent = r.path;
    $('#file-empty').style.display = r.entries.length ? 'none' : '';
    $('#file-empty').textContent = r.entries.length ? '' : '此目录没有视频文件或子目录';
    let html = '';
    if (r.parent) html += `<div class="file-item" onclick="loadFileDir('${esc(r.parent)}')"><span class="fi-icon">⬆</span><span class="fi-name">.. 上级目录</span></div>`;
    for (const e of r.entries) {
      const act = e.dir ? `loadFileDir('${esc(e.path)}')` : `playLocalFile('${esc(e.path)}','${esc(e.name)}')`;
      html += `<div class="file-item" onclick="${act}">
        <span class="fi-icon">${e.dir ? '📁' : '🎬'}</span>
        <span class="fi-name">${esc(e.name)}</span>
        <span class="fi-size">${e.dir ? '' : fmtSize(e.size)}</span>
      </div>`;
    }
    $('#file-list').innerHTML = html;
    refreshFocusables();
  } catch (e) { $('#file-empty').style.display = ''; $('#file-empty').textContent = '加载失败：' + e.message; }
}
function playLocalFile(path, name) {
  const url = '/api/file/stream?path=' + encodeURIComponent(path);
  state.player = { name, siteKey: '__local__', id: path, epIdx: 0, plays: [{ flag: '本地', episodes: [{ name, url }] }] };
  $('#player-title').textContent = name;
  $('#player-line').innerHTML = '<option>本地</option>';
  $('#player-ep').innerHTML = '<option>1</option>';
  switchViewRaw('player');
  // 本地文件走原生 video（不支持 hls.js 的本地 m3u8 除外）
  const video = $('#vod-video');
  applyVodVolume();
  try { if (state.hls) { state.hls.destroy(); state.hls = null; } } catch {}
  video.src = url;
  $('#player-msg').textContent = '加载中…';
  video.onplaying = () => { $('#player-msg').textContent = ''; };
  video.onerror = () => { $('#player-msg').textContent = '播放失败：文件不可读或格式不支持'; };
  video.play().catch(() => {});
}

/* ---------------- 收藏 / 历史 ---------------- */
function renderFav() {
  const fav = LS.get('fav', []);
  $('#fav-empty').style.display = fav.length ? 'none' : '';
  $('#fav-grid').innerHTML = fav.map(v => posterHTML({ ...v, action: v.fromArticle
    ? `openDetail('${esc(v.siteKey)}','${esc(v.id)}',1)`
    : `openDetail('${esc(v.siteKey)}','${esc(v.id)}')` })).join('');
  refreshFocusables();
}
function renderHistory() {
  const hist = LS.get('history', []);
  $('#history-empty').style.display = hist.length ? 'none' : '';
  $('#history-grid').innerHTML = hist.map(v => posterHTML({ ...v, action: v.fromArticle
    ? `openDetail('${esc(v.siteKey)}','${esc(v.id)}',1)`
    : `openDetail('${esc(v.siteKey)}','${esc(v.id)}')` })).join('');
  refreshFocusables();
}
function toggleFav() {
  const d = state.detail; if (!d) return;
  const fav = LS.get('fav', []);
  const i = fav.findIndex(x => x.id === d.id && x.siteKey === d.siteKey);
  if (i >= 0) { fav.splice(i, 1); toast('已取消收藏'); $('#detail-fav').textContent = '加入收藏'; }
  else { fav.unshift({ id: d.id, siteKey: d.siteKey, name: d.name, pic: d.pic, year: d.year, type: d.type, fromArticle: !!d.fromArticle }); toast('已加入收藏'); $('#detail-fav').textContent = '取消收藏'; }
  LS.set('fav', fav);
}

/* ---------------- 设置 ---------------- */
function renderSettings() {
  const fmtUrl = u => u === 'preset' ? '内置预置' : (u ? u.replace(/^https?:\/\//, '').slice(0, 46) : '未设置');
  const vodUrl = state.config?.vodApiUrl || (state.config?.apiUrl === 'preset' ? 'preset' : (state.config?.apiUrl || ''));
  const liveUrl = state.config?.liveApiUrl || (state.config?.apiUrl === 'preset' ? 'preset' : (state.config?.apiUrl || ''));
  $('#set-api-vod-val').textContent = `${fmtUrl(vodUrl)}（${state.sites.length} 源）`;
  $('#set-api-live-val').textContent = `${fmtUrl(liveUrl)}（${state.lives.length} 源）`;
  const apiHist = LS.get('apiHistory', []);
  const ifaceTotal = (sourcesCache ? (sourcesCache.vod?.length || 0) + (sourcesCache.live?.length || 0) : 0);
  $('#set-api-history-val').textContent = (ifaceTotal ? ifaceTotal + ' 接口' : '') + (apiHist.length ? (ifaceTotal ? ' · ' : '') + apiHist.length + ' 历史' : '') + (!ifaceTotal && !apiHist.length ? '0 条' : '');
  const defaults = { homeMultiRow: true, fastSearch: true, autoLine: true, safeDns: false, m3u8Purify: false, historyMerge: true };
  const toggles = {
    'set-home-style': ['homeMultiRow', '开启', '关闭'],
    'set-fast': ['fastSearch', '开启', '关闭'],
    'set-autoline': ['autoLine', '开启', '关闭'],
    'set-dns': ['safeDns', '开启', '关闭'],
    'set-m3u8ad': ['m3u8Purify', '开启', '关闭'],
    'set-history-merge': ['historyMerge', '开启', '关闭'],
  };
  for (const [id, [key, on, off]] of Object.entries(toggles)) {
    const val = LS.get(key, defaults[key]);
    $('#' + id + '-val').textContent = val ? on : off;
  }
  $('#set-netaccel-val').textContent = state.netAccel ? '开启' : '关闭';
  const homeSite = state.sites.find(s => s.key === state.homeKey) || state.sites[0];
  $('#set-home-val').textContent = homeSite ? homeSite.name : '未配置';
  $('#set-default-view-val').textContent = LS.get('defaultView', 'home') === 'live' ? '直播' : '点播';
  $('#set-home-rec-val').textContent = LS.get('homeRec', 'site') === 'history' ? '观看历史' : '站点推荐';
  $('#set-history-num-val').textContent = LS.get('historyNum', 60) + '条';
  const dlDir = LS.get('downloadDir', '') || state.defaultDownloadDir || '';
  $('#set-download-dir-val').textContent = dlDir
    ? (dlDir.length > 34 ? dlDir.slice(0, 14) + '…' + dlDir.slice(-18) : dlDir)
    : '未设置';
}
/* ---------------- 下载列表（顶部“下载”导航） ---------------- */
let dlBusy = false;
async function downloadControl(op, id, extra = {}) {
  if (dlBusy) return;
  dlBusy = true;
  try {
    await api('/api/download/control', { op, id, ...extra });
    renderDownloads();
  } catch (e) { toast('操作失败：' + e.message); }
  finally { dlBusy = false; }
}
async function renderDownloads(silent = false) {
  if (dlBusy) return;
  const box = $('#download-list'); if (!box) return;
  let r;
  try { r = await api('/api/download/tasks'); }
  catch (e) { if (!silent) box.innerHTML = `<div class="empty-big">加载失败：${esc(e.message)}</div>`; return; }
  const tasks = r.tasks || [];
  if (!tasks.length) {
    box.innerHTML = '<div class="empty-big">暂无下载任务。在详情弹窗点「下载」即可开始。</div>';
    return;
  }
  const clearBtn = $('#download-clear-done');
  if (clearBtn) clearBtn.style.display = tasks.some(t => t.status === 'done') ? '' : 'none';
  const statusText = s => ({ done: '已完成', error: '失败', canceled: '已取消', paused: '已暂停', downloading: '下载中' })[s] || s;
  box.innerHTML = tasks.map((t, i) => {
    const f = (t.files || [])[0] || '';
    const canPlay = /\.(mp4|webm|mkv|mov)$/i.test(f);
    const ready = t.status === 'done' && !!f;
    let actions = '';
    if (t.status === 'downloading') actions = '<button class="ghost-btn" data-act="pause">暂停</button><button class="ghost-btn" data-act="cancel">取消</button>';
    else if (t.status === 'paused') actions = '<button class="ghost-btn" data-act="resume">继续</button><button class="ghost-btn" data-act="cancel">取消</button>';
    else if (t.status === 'done') actions = `<button class="ghost-btn" data-act="play" ${ready ? '' : 'disabled'}>${canPlay ? '播放资源' : '打开资源'}</button><button class="ghost-btn" data-act="folder" ${ready ? '' : 'disabled'}>到文件夹查看</button><button class="ghost-btn" data-act="delete">删除</button>`;
    else actions = '<button class="ghost-btn" data-act="retry">重试</button><button class="ghost-btn" data-act="delete">删除</button>';
    const sizeText = Number(t.bytes) > 0
      ? (t.status === 'done' ? fmtSize(t.bytes) : '已下载 ' + fmtSize(t.bytes))
      : '';
    return `<div class="dl-item" data-i="${i}">
      <div class="dl-head"><span class="dl-name">${esc(t.name)}</span><span class="dl-status ${esc(t.status)}">${statusText(t.status)}</span></div>
      <div class="dl-meta">${esc(t.dir)}${sizeText ? ' · ' + sizeText : ''} · ${(t.files || []).length} 个文件 · ${t.status === 'done' ? '完成于 ' + new Date(t.finishedAt || Date.now()).toLocaleString('zh-CN') : '创建于 ' + new Date(t.createdAt || Date.now()).toLocaleTimeString('zh-CN')}</div>
      <div class="dl-bar"><i style="width:${Number(t.progress) || 0}%"></i></div>
      <div class="dl-msg">${esc(t.message || '')} · ${Number(t.progress) || 0}%</div>
      <div class="dl-actions">${actions}</div>
    </div>`;
  }).join('');
  box.querySelectorAll('.dl-item').forEach(el => {
    const t = tasks[+el.dataset.i];
    const f = (t.files || [])[0] || '';
    const on = (act, fn) => { const b = el.querySelector(`[data-act="${act}"]`); if (b) b.onclick = fn; };
    on('pause', () => downloadControl('pause', t.id));
    on('resume', () => downloadControl('resume', t.id));
    on('cancel', () => downloadControl('cancel', t.id));
    on('retry', () => downloadControl('retry', t.id, { siteKey: t.siteKey }));
    on('delete', () => {
      if (t.status !== 'done') { downloadControl('delete', t.id); return; }
      showList('删除下载任务', [
        { i: 0, label: '仅删除任务记录（保留已下载文件）' },
        { i: 1, label: '删除任务记录并删除已下载文件' },
      ], it => downloadControl('delete', t.id, { files: it.i === 1 ? 1 : 0 }), { display: it => it.label });
    });
    on('play', () => {
      if (!f) return;
      if (/\.(mp4|webm|mkv|mov)$/i.test(f)) playLocalFile(f, t.name);
      else if (window.tvbox?.openItem) window.tvbox.openItem(f).then(msg => { if (msg) toast('打开失败：' + msg); });
      else toast('当前环境不支持直接打开资源');
    });
    on('folder', async () => {
      if (!f) return;
      if (window.tvbox?.showItem) { await window.tvbox.showItem(f); toast('已打开所在文件夹'); }
      else { await copyText(t.dir); toast('已复制下载路径'); }
    });
  });
}
setInterval(() => { if (currentView === 'downloads') renderDownloads(true); }, 2000);

/* 通用列表选择弹窗（配置历史等） */
function showList(title, items, onPick, opts = {}) {
  $('#list-modal-title').textContent = title;
  const box = $('#list-modal-box');
  box.innerHTML = items.length ? items.map((it, i) => `
    ${it.kind === 'group'
      ? `<div class="lm-group">${esc(it.label)}</div>`
      : `<div class="lm-item ${opts.html ? 'lm-block' : ''}" data-i="${i}">
      ${opts.html
        ? `<div class="lm-body">${opts.html(it)}</div>`
        : `<span class="lm-text">${esc(opts.display ? opts.display(it) : it)}</span>`}
      ${it.cur ? '<span class="lm-cur">当前</span>' : ''}
      ${opts.deletable && !it.noDel ? `<span class="lm-del" data-del="${i}">✕</span>` : ''}
    </div>`}`).join('') : `<div class="lm-empty">${esc(opts.empty || '列表为空')}</div>`;
  $('#list-modal').classList.remove('hidden');
  box.querySelectorAll('.lm-item').forEach(el => {
    el.onclick = e => {
      const it = items[+el.dataset.i];
      if (e.target.classList.contains('lm-del')) { opts.onDelete?.(it); return; }
      $('#list-modal').classList.add('hidden');
      onPick(it);
    };
    // 可选：右键回调（仅传入 onContext 的列表启用，如"首页站源"复制源信息）
    if (typeof opts.onContext === 'function') {
      el.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); opts.onContext(items[+el.dataset.i]); };
    }
  });
  $('#list-modal-close').onclick = () => $('#list-modal').classList.add('hidden');
}

// 复制文本到剪贴板：优先 Clipboard API，file:// 下回退 execCommand
function copyText(text) {
  const done = () => toast('已复制到剪贴板');
  const fail = () => toast('复制失败，请手动选择复制');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallback());
  } else fallback();
  function fallback() {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      ok ? done() : fail();
    } catch (_) { fail(); }
  }
}

// 从可能被本地代理套壳的 api 里还原出真实接口地址。
// 例：http://127.0.0.1:10079/p/0/proxy/https://bfzyapi.com/api.php/provide/vod?  →  https://bfzyapi.com/...
// 有些加速/代理工具会把站点 api 改写成「本地地址/p/0/proxy/<真实URL>」，直接取 origin 会复制成本地路径。
function realApiUrl(api) {
  let u = String(api || '').trim();
  // 先解码（兼容整个嵌套 URL 被 encodeURIComponent 的情形，如 https%3A%2F%2F...）
  for (let i = 0; i < 2; i++) { try { const d = decodeURIComponent(u); if (d === u) break; u = d; } catch (_) { break; } }
  // 反复剥离 /proxy/ 后面的嵌套 URL（兼容多层套壳）
  for (let i = 0; i < 3; i++) {
    const m = u.match(/^https?:\/\/[^\/]+\/.*?\/proxy\/(https?:\/\/.+)$/i);
    if (!m) break;
    u = m[1];
    try { u = decodeURIComponent(u); } catch (_) {}
  }
  return u;
}

// 把首页站源条目的完整信息复制为可读文本（从当前配置里取该源的 api/type 等字段）
function copySiteInfo(it) {
  const s = state.sites.find(x => x.key === it.key) || it;
  const api = String(s.api || '').trim();
  if (!api) { toast('该源没有接口地址'); return; }
  // 先还原被本地代理套壳的地址，再只取真实源网站域名（协议+主机），去掉接口路径
  const real = realApiUrl(api);
  let site = real;
  try { site = new URL(real).origin; } catch (_) {}
  copyText(site);
}
/* 配置历史：内置接口清单（供设置页显示条数）；管理页只展示用户导入的接口 */
let sourcesCache = null;
async function getSources() {
  if (sourcesCache) return sourcesCache;
  try { sourcesCache = await api('/api/config/sources'); } catch { sourcesCache = { vod: [], live: [] }; }
  return sourcesCache;
}
function hiddenSources() { return LS.get('hiddenSources', []); }
function hideSource(url) { LS.set('hiddenSources', [...new Set([...hiddenSources(), url])]); }
function histText(it) {
  if (typeof it === 'string') return it;
  return it && (it.text || it.rawText || it.url) || '';
}
/* 配置历史：独立页面渲染。接口清单来自用户数据目录（不再内置），导入历史按类型归入对应栏 */
let sourcesLoading = false;
async function showApiHistory(force = false) {
  if (sourcesLoading && !force) return;
  sourcesLoading = true;
  const refreshBtn = $('#src-refresh'); if (refreshBtn) refreshBtn.classList.add('spinning');
  const wrap = $('#sources-columns');
  if (wrap) wrap.innerHTML = '<div class="sources-loading">正在读取接口清单…</div>';
  try {
    if (force) sourcesCache = null;
    // 清理历史遗留的重复导入条目：同一 scope + 同一接口内容只保留一条，并写回
    {
      const _h = LS.get('apiHistory', []), _seen = new Set(), _out = [];
      for (const _x of _h) {
        const _scope = (typeof _x !== 'string' && _x?.scope) || 'vod';
        const _txt = typeof _x === 'string' ? _x : (_x?.url || _x?.text || '');
        const _k = _scope + ':' + _txt.slice(0, 200);
        if (_seen.has(_k)) continue;
        _seen.add(_k); _out.push(_x);
      }
      if (_out.length !== _h.length) LS.set('apiHistory', _out);
    }
    const hist = LS.get('apiHistory', []);
    const curVod = state.config?.vodApiUrl || (state.config?.apiUrl === 'preset' ? 'preset' : (state.config?.apiUrl || ''));
    const curLive = state.config?.liveApiUrl || '';
    const src = await getSources();

    const scopeOf = h => (typeof h !== 'string' && h?.scope) || 'vod';
    const labelOf = h => (typeof h !== 'string' && h?.label) || histText(h).replace(/^https?:\/\//, '').slice(0, 60);
    // 接口清单在前；导入历史按导入时选择的类型追加到对应栏尾部
    const buildItems = (kind, curUrl) => {
      const arr = (src[kind] || []).map(s => ({
        from: 'list', name: s.name || '接口', url: s.url, cur: curUrl === s.url
      }));
      hist.forEach((h, hi) => {
        if (scopeOf(h) !== kind) return;
        const text = histText(h);
        arr.push({ from: 'hist', hi, name: labelOf(h), text, cur: false });
      });
      return arr;
    };
    const vodItems = buildItems('vod', curVod);
    const liveItems = buildItems('live', curLive);
    const cards = (items, kind) => {
      if (!items.length) return '<div class="src-empty">暂无接口<br>到设置里导入配置地址</div>';
      return items.map((it, i) => {
        const tags = [];
        if (it.cur) tags.push('<span class="src-tag cur">当前</span>');
        if (it.from === 'hist') tags.push('<span class="src-tag imp">导入</span>');
        const body = it.from === 'hist'
          ? (/^https?:\/\//i.test(it.text.trim())
              ? `<div class="src-url">${esc(it.text)}</div>`
              : `<pre class="src-json">${esc(it.text.slice(0, 500))}</pre>`)
          : `<div class="src-url">${esc(it.url)}</div>`;
        return `<div class="src-card ${it.cur ? 'is-current' : ''}" data-kind="${kind}" data-i="${i}">
          <div class="src-card-main">
            <div class="src-card-top"><span class="src-name">${esc(it.name)}</span>${tags.join('')}</div>
            ${body}
          </div>
          <div class="src-card-actions">
            <button class="src-apply" data-act="apply">${it.cur ? '重新应用' : '应用'}</button>
            <button class="src-del" data-act="del" title="删除该接口">删除</button>
          </div>
        </div>`;
      }).join('');
    };

    wrap.innerHTML = `
      <div class="src-col">
        <div class="src-col-head"><span class="src-col-ico vod">▣</span><span class="src-col-title">点播接口</span><span class="src-col-count">${vodItems.length}</span></div>
        <div class="src-list">${cards(vodItems, 'vod')}</div>
      </div>
      <div class="src-col">
        <div class="src-col-head"><span class="src-col-ico live">◉</span><span class="src-col-title">直播接口</span><span class="src-col-count">${liveItems.length}</span></div>
        <div class="src-list">${cards(liveItems, 'live')}</div>
      </div>`;

    // 应用 / 删除（事件委托，卡片重渲染后仍有效）
    wrap.querySelectorAll('.src-card').forEach(el => {
      const kind = el.dataset.kind, idx = +el.dataset.i;
      const applyBtn = el.querySelector('[data-act="apply"]');
      const delBtn = el.querySelector('[data-act="del"]');
      applyBtn.onclick = () => applySourceItem(kind, idx, vodItems, liveItems);
      delBtn.onclick = async () => {
        const it = (kind === 'vod' ? vodItems : liveItems)[idx];
        if (!it) return;
        if (it.from === 'hist') {
          LS.set('apiHistory', LS.get('apiHistory', []).filter((_, i) => i !== it.hi));
          toast('已删除该导入记录');
        } else {
          try {
            const r = await fetch('/api/config/sources/delete', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ kind, url: it.url })
            });
            if (!r.ok) throw new Error(r.status);
            sourcesCache = null;
            toast('已删除该接口');
          } catch (e) { toast('删除失败：' + e.message); return; }
        }
        showApiHistory(true); renderSettings();
      };
    });
  } catch (e) {
    if (wrap) wrap.innerHTML = `<div class="src-empty">读取接口清单失败：${esc(e.message)}</div>`;
  } finally {
    sourcesLoading = false;
    if (refreshBtn) refreshBtn.classList.remove('spinning');
  }
}

// 应用某条接口：点播只动 sites、直播只动 lives，两侧互不干扰
async function applySourceItem(kind, idx, vodItems, liveItems) {
  const it = (kind === 'vod' ? vodItems : liveItems)[idx];
  if (!it) return;
  const name = it.name || (kind === 'vod' ? '点播接口' : '直播接口');
  const value = it.from === 'hist' ? it.text : it.url;
  if (kind === 'vod') {
    await applyConfigFromText(value, 'vod', name, false);
    showApiHistory();
  } else if (it.from === 'hist') {
    const ok = await applyConfigFromText(value, 'live', name, false);
    if (ok) { switchView('live'); showApiHistory(); }
  } else {
    // 直播接口清单项：只推入 lives，绝不动点播源
    const cfg = JSON.parse(JSON.stringify(state.config || { sites: [], lives: [], parses: [] }));
    const key = 'live_iface_' + (cfg.lives.length + 1) + '_' + Date.now().toString(36);
    cfg.lives = [{ key, name, url: value, ua: '' }, ...(cfg.lives || [])];
    cfg.liveApiUrl = value;
    try {
      const saved = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
      if (!saved.ok) throw new Error(saved.status);
      state.config = await saved.json(); applyConfig(); renderSettings();
      state.liveKey = key; toast('已追加直播接口：' + name + '（点播源未改动）');
      switchView('live'); loadLiveSources();
    } catch (e) { toast('加载直播接口失败：' + e.message); }
  }
}
/* 数据备份 / 恢复（原版 BackupDialog） */
function exportBackup() {
  const data = {
    app: 'TVBox-PC', version: 1, time: new Date().toISOString(),
    config: state.config || {},
    favorites: LS.get('fav', []),
    history: LS.get('history', []),
    settings: {},
  };
  for (const k of ['homeKey', 'homeMultiRow', 'fastSearch', 'autoLine', 'safeDns', 'm3u8Purify', 'historyMerge', 'historyNum', 'defaultView', 'homeRec', 'apiHistory', 'searchHistory']) {
    const v = LS.get(k, undefined); if (v !== undefined) data.settings[k] = v;
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tvbox-pc-backup.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出备份文件');
}
async function importBackupFile(file) {
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch { toast('备份文件不是合法 JSON'); return; }
  if (data.app !== 'TVBox-PC') { toast('不是 TVBox PC 的备份文件'); return; }
  // 恢复配置（走现有导入链路，保留解析增强）
  const cfg = data.config || {};
  if (cfg.sites?.length || cfg.lives?.length) {
    try {
      const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
      if (!r.ok) throw new Error(r.status);
      state.config = await r.json();
      applyConfig(); loadHome(); loadVodClasses(); loadLiveSources();
    } catch (e) { toast('恢复配置失败：' + e.message); }
  }
  if (Array.isArray(data.favorites)) LS.set('fav', data.favorites);
  if (Array.isArray(data.history)) LS.set('history', data.history);
  if (data.settings) for (const [k, v] of Object.entries(data.settings)) LS.set(k, v);
  renderSettings(); refreshFocusables();
  toast('备份已恢复：收藏 ' + (data.favorites?.length || 0) + ' / 历史 ' + (data.history?.length || 0));
}
function showPrompt(title, value, onOk, multiline = true, scope = null, nameValue = '') {
  $('#prompt-title').textContent = title;
  $('#prompt-text').value = value || '';
  // 接口类型行：仅 choose（通用导入）需要用户选；vod/live 已由入口固定，隐藏
  const row = $('#prompt-type-row');
  const sel = $('#prompt-scope');
  if (scope === 'choose') {
    row.style.display = '';
    sel.value = 'vod'; sel.disabled = false;
  } else {
    row.style.display = 'none';
    if (scope === 'vod' || scope === 'live') sel.value = scope;
  }
  // 接口名称行：配置/导入类弹窗（vod/live/choose）显示，其它（下载路径/关于等）隐藏
  const nameRow = $('#prompt-name-row');
  const nameInput = $('#prompt-name');
  const withName = scope === 'vod' || scope === 'live' || scope === 'choose';
  nameRow.style.display = withName ? '' : 'none';
  nameInput.value = nameValue || '';
  $('#prompt').classList.remove('hidden');
  $('#prompt-ok').onclick = () => {
    const v = $('#prompt-text').value.trim();
    const chosen = sel.value;
    const name = $('#prompt-name').value.trim();
    $('#prompt').classList.add('hidden');
    onOk(v, chosen, name);
  };
  $('#prompt-cancel').onclick = () => $('#prompt').classList.add('hidden');
  setTimeout(() => (withName ? nameInput : $('#prompt-text')).focus(), 50);
}
// scope: 'vod' | 'live'。只更新对应一侧，另一侧保持不动。nameHint 用于直播接口命名。
async function applyConfigFromText(text, scope = 'vod', nameHint = '', recordHistory = true) {
  if (!text) { toast('内容为空'); return false; }
  if (!['vod', 'live'].includes(scope)) scope = 'vod';
  let cfg, okMsg, rawText;
  const isUrl = /^https?:\/\//i.test(text);
  // 前端超时保护：失效接口可能长时间无响应，超时后明确报错，由用户自己选择其它接口
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 11000);
  const side = scope === 'live' ? '直播' : '点播';
  try {
    if (isUrl) {
      const importUrl = '/api/config/import?scope=' + scope + '&url=' + encodeURIComponent(text) + (nameHint ? '&name=' + encodeURIComponent(nameHint) : '');
      const r = await fetch(importUrl, { cache: 'no-store', signal: ctrl.signal });
      const d = await r.json();
      if (!r.ok) { toast(side + '导入失败：' + (d.error || r.status)); return false; }
      cfg = d; rawText = d.rawText || text;
      okMsg = scope === 'live'
        ? `已导入 ${d.lives?.length || 0} 个直播源（点播源未改动）`
        : `已导入 ${d.sites?.length || 0} 个点播源（直播源未改动）` + (d.skipped ? `，跳过 ${d.skipped} 个需安卓爬虫的站点` : '');
    } else {
      const r = await fetch('/api/config/parse?scope=' + scope, { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text, signal: ctrl.signal });
      const d = await r.json();
      if (!r.ok) { toast(side + '解析失败：' + (d.error || r.status)); return false; }
      cfg = d; rawText = text;
      okMsg = scope === 'live'
        ? `已保存 ${d.lives?.length || 0} 个直播源（点播源未改动）`
        : `已保存 ${d.sites?.length || 0} 个点播源（直播源未改动）` + (d.skipped ? `，跳过 ${d.skipped} 个需安卓爬虫的站点` : '');
    }
  } catch (e) { toast(side + '导入失败：' + (e.name === 'AbortError' ? '请求超时' : e.message)); return false; }
  finally { clearTimeout(timer); }
  state.config = cfg; applyConfig(); renderSettings(); toast(okMsg);
  // 配置历史：每条保存接入的接口地址 + 原始配置 JSON + 接口类型，点击可只更新对应一侧
  // 仅在真正"新增导入"时记录；从接口清单点"应用"不应新增历史条目，否则每点一次就多一条
  if (recordHistory) {
    const h = LS.get('apiHistory', []);
    const key = (scope === 'live' ? 'live:' : 'vod:') + (isUrl ? text : text.slice(0, 200));
    const autoLabel = isUrl ? text.replace(/^https?:\/\//, '').slice(0, 60) : '粘贴的配置 JSON';
    const entry = { url: isUrl ? text : '', text: rawText || text, label: nameHint || autoLabel, scope, ts: Date.now() };
    const norm = x => (scope === 'live' ? 'live:' : 'vod:') + (typeof x === 'string' ? x : (x?.url || x?.text || '')).slice(0, 200);
    const next = [entry, ...h.filter(x => norm(x) !== key)].slice(0, 12);
    LS.set('apiHistory', next);
    renderSettings();
  }
  // 只刷新被改动的那一侧：点播不碰直播播放，直播不碰首页/点播列表
  if (scope === 'live') loadLiveSources();
  else { loadHome(); loadVodClasses(); }
  return true;
}
function applyConfig() {
  state.sites = state.config?.sites || [];
  state.lives = state.config?.lives || [];
  state.reads = state.config?.reads || [];
  const hs = $('#home-site');
  hs.innerHTML = state.sites.map(s => `<option value="${esc(s.key)}">${esc(s.name)}</option>`).join('');
  if (!state.sites.some(s => s.key === state.homeKey)) { state.homeKey = state.sites[0]?.key || ''; LS.set('homeKey', state.homeKey); }
  if (!state.sites.some(s => s.key === state.vodKey)) {
    // 切换接口后旧 key 已失效：重置到新站点首个，且清掉旧分类并写回本地，避免回到点播仍请求旧源
    state.vodKey = state.sites[0]?.key || '';
    state.vodClass = ''; state.vodPage = 1;
    LS.set('vodKey', state.vodKey);
  }
  if (state.homeKey) hs.value = state.homeKey;
  const rs = $('#read-site');
  if (rs) {
    rs.innerHTML = state.reads.map(s => `<option value="${esc(s.key)}">${esc(s.name)}</option>`).join('');
    if (!state.reads.some(s => s.key === state.readKey)) state.readKey = state.reads[0]?.key || '';
    if (state.readKey) rs.value = state.readKey;
  }
}

/* 切首页站源：同步点播页；若首页推荐是"观看历史"，自动切回站点推荐（否则切了看不出变化） */
function setHomeSite(key) {
  state.homeKey = key;
  LS.set('homeKey', key);
  // 首页与点播页共用同一站源：切换时同步点播选中项与分类
  state.vodKey = key;
  LS.set('vodKey', key);
  state.vodClass = ''; state.vodPage = 1;
  const wasHist = LS.get('homeRec', 'site') === 'history';
  if (wasHist) LS.set('homeRec', 'site');
  applyConfig(); renderSettings(); loadHome();
  const vs = $('#vod-site'); if (vs) vs.value = key;
  loadVodClasses();
  return wasHist;
}

/* ================= 小说/听书模块 ================= */
let readLoadSeq = 0;
let readInitedKey = ''; // 已成功初始化过的小说源：再次进入时保留当前分类/页码，不重复重置
async function loadReadSites() {
  const rs = $('#read-site');
  if (!rs) return;
  if (!state.reads.length) {
    try { state.reads = await api('/api/read/sites'); } catch { state.reads = []; }
    if (state.config) state.config.reads = state.reads;
  }
  rs.innerHTML = state.reads.map(s => `<option value="${esc(s.key)}">${esc(s.name)}</option>`).join('');
  if (!state.reads.some(s => s.key === state.readKey)) state.readKey = state.reads[0]?.key || '';
  if (state.readKey) rs.value = state.readKey;
  if (!state.readKey) { $('#read-empty').style.display = ''; $('#read-grid').innerHTML = ''; return; }
  // 同一小说源已初始化且列表仍在：直接保留用户当前分类/页码，避免每次进入都重新拉首页
  if (readInitedKey === state.readKey && $('#read-grid').children.length) return;
  readInitedKey = state.readKey;
  $('#read-empty').style.display = 'none';
  $('#read-grid').innerHTML = '<div class="empty-big">加载中…</div>';
  siteSpinOn('read');
  try { await loadReadClasses(); } finally { siteSpinOff('read'); }
}

async function loadReadClasses() {
  const key = state.readKey;
  if (!key) return;
  $('#read-empty').style.display = 'none';
  siteSpinOn('read');
  try {
    const d = await apiTimeout('/api/read/home', { key }, 12000);
    const box = $('#read-classes');
    box.innerHTML = (d.classes || []).map(c =>
      `<button class="chip ${c.tid === state.readClass ? 'active' : ''}" onclick="setReadClass('${esc(c.tid)}','${esc(c.name)}')">${esc(c.name)}</button>`
    ).join('');
    if (!state.readClass && (d.classes || []).length) state.readClass = d.classes[0].tid;
    state.readPage = 1;
    state.readPageCount = Math.max(1, Number(d.pagecount) || 1);
    // 有首页推荐就直接渲染，无需用户再点一次分类；无推荐则按默认分类拉取
    if ((d.videos || []).length) loadReadGrid(d.videos);
    else await loadReadGrid();
  } catch (e) {
    $('#read-grid').innerHTML = '';
    $('#read-empty').style.display = '';
    $('#read-empty').textContent = '小说源加载失败：' + e.message;
  } finally { siteSpinOff('read'); }
}

function setReadClass(tid, name) {
  state.readClass = tid; state.readPage = 1;
  $$('#read-classes .chip').forEach(c => c.classList.toggle('active', c.textContent === name));
  loadReadGrid();
}
/* 小说分页：与点播同款扩展分页（首/末页 + 当前页±2 + 省略号） */
function renderReadPages() {
  const box = $('#read-pages'); if (!box) return;
  const cur = state.readPage, total = state.readPageCount;
  const set = new Set([1, total]);
  for (let i = cur - 2; i <= cur + 2; i++) if (i >= 1 && i <= total) set.add(i);
  const pages = [...set].sort((a, b) => a - b);
  let html = '', prev = 0;
  for (const p of pages) {
    if (p - prev > 1) html += '<span class="pg-gap">…</span>';
    html += `<button class="pg-num ${p === cur ? 'active' : ''}" data-p="${p}">${p}</button>`;
    prev = p;
  }
  box.innerHTML = html;
  $$('#read-pages .pg-num').forEach(b => b.onclick = () => {
    const p = +b.dataset.p;
    if (p !== state.readPage && p >= 1 && p <= state.readPageCount) { state.readPage = p; loadReadGrid(); }
  });
}
function syncReadPager() {
  const dim = (sel, off) => { const el = $(sel); if (el) el.style.opacity = off ? '.35' : '1'; };
  const atFirst = state.readPage <= 1, atLast = state.readPage >= state.readPageCount;
  dim('#read-first', atFirst); dim('#read-prev', atFirst);
  dim('#read-next', atLast); dim('#read-last', atLast);
  const pg = $('#read-page'); if (pg) pg.textContent = state.readPage + ' / ' + state.readPageCount;
  renderReadPages();
}
async function loadReadGrid(videos) {
  if (videos) {
    $('#read-grid').innerHTML = videos.map(v => readCardHTML(v)).join('');
    $('#read-empty').style.display = videos.length ? 'none' : '';
    syncReadPager(); refreshFocusables();
    return;
  }
  if (!state.readKey || !state.readClass) return;
  const seq = ++readLoadSeq;
  siteSpinOn('read');
  try {
    const d = await apiTimeout('/api/read/category', { key: state.readKey, tid: state.readClass, pg: state.readPage }, 15000);
    if (seq !== readLoadSeq) return;
    state.readPageCount = Math.max(1, Number(d.pagecount) || 1);
    $('#read-grid').innerHTML = (d.videos || []).map(v => readCardHTML(v)).join('');
    $('#read-empty').style.display = (d.videos || []).length ? 'none' : '';
    if (!(d.videos || []).length) $('#read-empty').textContent = '该分类暂无小说';
    syncReadPager(); refreshFocusables();
  } catch (e) { toast('加载失败：' + e.message); }
  finally { siteSpinOff('read'); }
}
function readCardHTML(v) {
  const pic = v.pic || '';
  return `<div class="poster" tabindex="0" onclick="openReadDetail('${esc(state.readKey)}','${esc(v.id)}')" onkeydown="if(event.key==='Enter'){openReadDetail('${esc(state.readKey)}','${esc(v.id)}')}">
    ${pic ? `<img class="thumb" src="${esc(pic)}" loading="lazy" onerror="this.style.opacity=0">` : '<div class="thumb"></div>'}
    <span class="note">${esc(v.remarks || '')}</span>
    <div class="caption"><div class="pname">${esc(v.name)}</div></div>
  </div>`;
}

async function openReadDetail(key, id) {
  try {
    const d = await apiTimeout('/api/read/detail', { key, id }, 15000);
    state.readBook = { key, id, ...d };
    const b = d.book || {};
    $('#read-name').textContent = b.name || '未命名';
    const site = state.reads.find(s => s.key === key);
    $('#read-site-name').textContent = site ? site.name : '';
    $('#read-remarks').textContent = b.remarks || '';
    $('#read-des').textContent = b.des || '';
    const cover = $('#read-cover');
    if (b.pic) { cover.src = b.pic; cover.style.display = ''; }
    else cover.style.display = 'none';
    // 封面点击 -> 图片浏览
    $('#read-cover-wrap').onclick = b.pic ? () => openLightbox([b.pic], 0) : null;
    $('#read-cover-wrap').style.cursor = b.pic ? 'zoom-in' : 'default';
    $('#read-chapter-count').textContent = (d.chapters || []).length + ' 章';
    $('#read-chapters').innerHTML = (d.chapters || []).map((c, i) =>
      `<button class="ep" onclick="playReadChapter(${i})">${esc(c.name)}</button>`
    ).join('');
    $('#read-detail').classList.remove('hidden');
  } catch (e) { toast('详情加载失败：' + e.message); }
}
function closeReadDetail() { $('#read-detail').classList.add('hidden'); stopVodPlayer(); }

function playReadChapter(idx) {
  const b = state.readBook; if (!b) return;
  const ch = (b.chapters || [])[idx]; if (!ch || !ch.url) { toast('该章节无音频'); return; }
  $('#read-detail').classList.add('hidden');
  stopVodPlayer();
  playerReturnView = 'read';
  switchViewRaw('player');
  $('#player-title').textContent = (b.book?.name || '') + ' - ' + ch.name;
  const v = $('#vod-video');
  v.src = proxyUrl(ch.url);
  v.onerror = () => { $('#player-msg').textContent = '音频加载失败，可能是源站防盗链或该音频已失效'; };
  v.play().catch(() => {});
  state.player = { siteKey: b.key, id: b.id, line: 0, epIdx: idx, eps: b.chapters.map(c => c.url), read: true };
  refreshFocusables();
}

/* ================= 图片浏览灯箱（封面/详情图/图集） ================= */
let lbList = [], lbIdx = 0;
function openLightbox(list, idx = 0) {
  lbList = (list || []).filter(Boolean);
  if (!lbList.length) return;
  lbIdx = Math.max(0, Math.min(idx, lbList.length - 1));
  renderLightbox();
  $('#lightbox').classList.remove('hidden');
}
function closeLightbox() { $('#lightbox').classList.add('hidden'); }
function renderLightbox() {
  const img = $('#lb-img');
  const raw = lbList[lbIdx] || '';
  // 外链图直连失败时，自动降级走图片代理重试一次（带标记避免死循环）
  img.onerror = () => {
    if (/^https?:\/\//i.test(raw) && img.dataset.lbProxy !== '1') {
      img.dataset.lbProxy = '1';
      img.src = articleImgUrl(raw);
    }
  };
  img.dataset.lbProxy = '';
  img.src = raw;
  $('#lb-counter').textContent = (lbList.length > 1) ? (lbIdx + 1) + ' / ' + lbList.length : '';
  const multi = lbList.length > 1;
  $('#lb-prev').style.display = multi ? '' : 'none';
  $('#lb-next').style.display = multi ? '' : 'none';
}
function lbStep(d) { if (!lbList.length) return; lbIdx = (lbIdx + d + lbList.length) % lbList.length; renderLightbox(); }

/* ---------------- 键盘方向键焦点（模拟原版遥控器） ---------------- */
function refreshFocusables() {
  const root = $('.view.active') || document;
  state.focusables = [...root.querySelectorAll('.poster,.chip,.ch,.hc,.lg,.lr-item,.set-item,.nav-btn,.ep,.ep-line,.act,.file-item,.fr-chip,.se-chip,.push-hist-item,.lm-item,.res-thumb')].filter(x => x.offsetParent !== null);
  state.focusIdx = 0;
  if (state.focusables[0]) { state.focusables.forEach(x => x.classList.remove('kbd-focus')); }
}
function moveFocus(dx, dy) {
  const list = state.focusables; if (!list.length) return;
  let i = state.focusIdx;
  if (dx) i = (i + dx + list.length) % list.length;
  else if (dy) i = (i + dy + list.length) % list.length;
  state.focusIdx = i;
  list.forEach((x, j) => x.classList.toggle('focus', j === i));
  list[i].scrollIntoView({ block: 'nearest', inline: 'center' });
}
// 播放器空格：必须在捕获阶段拦截，阻止事件到达带 controls 的 video。
// 否则原生 controls 的空格切换 + 这里的切换会各执行一次，互相抵消，表现为“按了没反应”。
document.addEventListener('keydown', (e) => {
  if (currentView !== 'player' || e.repeat) return;
  if (e.code !== 'Space' && e.key !== ' ' && e.key !== 'Spacebar') return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (!$('#prompt').classList.contains('hidden')) return;
  e.preventDefault();
  e.stopPropagation();
  const v = $('#vod-video'); if (!v) return;
  if (v.paused || v.ended) v.play().catch(() => {});
  else v.pause();
  pokePlayerUi();
}, true);

// 双保险 1：点击播放器后让 video 失焦——浏览器原生媒体快捷键（空格播放/暂停）只对获得焦点的媒体元素生效
document.addEventListener('pointerup', () => {
  if (currentView === 'player' && document.activeElement?.tagName === 'VIDEO') {
    setTimeout(() => { if (document.activeElement?.tagName === 'VIDEO') document.activeElement.blur(); }, 0);
  }
});
// 双保险 2：在 video 捕获阶段吞掉空格默认行为，即便事件到达 video 也不会触发原生切换
(function bindVodSpaceGuard() {
  const attach = () => {
    const vv = $('#vod-video');
    if (vv) vv.addEventListener('keydown', e => {
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') e.preventDefault();
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();
})();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // 全屏中：ESC 只用于退出全屏，不关闭弹窗/返回播放器，避免全屏状态残留
    if (inFullscreen()) {
      e.preventDefault();
      e.stopPropagation();
      exitFullscreenSafely();
      return;
    }
    // 浏览器可能已先退出全屏再派发 keydown：短时间内不把这次 ESC 当成“返回”
    if (performance.now() - lastExitFullscreenAt < 350) {
      e.preventDefault();
      return;
    }
    if (!$('#article-reader').classList.contains('hidden')) closeArticleReader();
    else if (!$('#detail').classList.contains('hidden')) closeDetail();
    else if (!$('#prompt').classList.contains('hidden')) $('#prompt').classList.add('hidden');
    else if (currentView === 'player') backFromPlayer();
    return;
  }
  if (!$('#prompt').classList.contains('hidden')) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    moveFocus(e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0, e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0);
    if (currentView === 'player') pokePlayerUi();
  } else if (e.key === 'Enter' && state.focusables[state.focusIdx]) {
    state.focusables[state.focusIdx].click();
  }
});

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  $$('.nav-btn').forEach(b => b.onclick = () => switchView(b.dataset.view));
  // 小说：切源 / 翻页 / 详情关闭 / 开始收听
  const rsEl = $('#read-site'); if (rsEl) rsEl.onchange = e => {
    state.readKey = e.target.value; state.readClass = ''; state.readPage = 1; LS.set('readKey', state.readKey); loadReadClasses();
  };
  const rf = $('#read-first'); if (rf) rf.onclick = () => { if (state.readPage > 1) { state.readPage = 1; loadReadGrid(); } };
  const rp = $('#read-prev'); if (rp) rp.onclick = () => { if (state.readPage > 1) { state.readPage--; loadReadGrid(); } };
  const rn = $('#read-next'); if (rn) rn.onclick = () => { if (state.readPage < state.readPageCount) { state.readPage++; loadReadGrid(); } };
  const rl = $('#read-last'); if (rl) rl.onclick = () => { if (state.readPage < state.readPageCount) { state.readPage = state.readPageCount; loadReadGrid(); } };
  const rdc = $('#read-detail-close'); if (rdc) rdc.onclick = closeReadDetail;
  const rpf = $('#read-play-first'); if (rpf) rpf.onclick = () => playReadChapter(0);
  // 网页文章阅读器：关闭/返回/上下篇/字号
  const arc = $('#ar-close'); if (arc) arc.onclick = closeArticleReader;
  const arb = $('#ar-back'); if (arb) arb.onclick = closeArticleReader;
  const arp = $('#ar-prev'); if (arp) arp.onclick = () => articleStep(-1);
  const arn = $('#ar-next'); if (arn) arn.onclick = () => articleStep(1);
  const arm = $('#ar-font-minus'); if (arm) arm.onclick = () => articleFontStep(-2);
  const arplus = $('#ar-font-plus'); if (arplus) arplus.onclick = () => articleFontStep(2);
  const arBox = $('#article-reader'); if (arBox) arBox.onclick = e => { if (e.target === arBox) closeArticleReader(); };
  // 图片灯箱：关闭 / 前后切换 / 键盘 / 点背景关闭
  const lbc = $('#lb-close'); if (lbc) lbc.onclick = closeLightbox;
  const lbp = $('#lb-prev'); if (lbp) lbp.onclick = () => lbStep(-1);
  const lbn = $('#lb-next'); if (lbn) lbn.onclick = () => lbStep(1);
  const lb = $('#lightbox'); if (lb) lb.onclick = e => { if (e.target === lb) closeLightbox(); };
  document.addEventListener('keydown', e => {
    if ($('#lightbox').classList.contains('hidden')) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') lbStep(-1);
    else if (e.key === 'ArrowRight') lbStep(1);
  });

  $('#home-site').onchange = e => {
    const wasHist = setHomeSite(e.target.value);
    if (wasHist) toast('首页推荐已切回站点推荐');
  };
  // 「查看更多」两类：搜索页就地展开/收起；首页按该行站源+分类跳点播筛选
  document.addEventListener('click', e => {
    const btn = e.target.closest && e.target.closest('.row-more');
    if (!btn) return;
    if (btn.classList.contains('row-expand')) { toggleSearchRow(btn); return; }
    const key = btn.dataset.key || state.homeKey;
    state.vodKey = key; LS.set('vodKey', key);
    state.vodClass = btn.dataset.tid || ''; state.vodPage = 1;
    switchView('vod'); loadVodClasses();
  });
  // 首页行横向滚动：按住鼠标拖拽左右滚动（替代滚动条）
  // 性能：mousemove 只记录目标值，scrollLeft 写入合并到 requestAnimationFrame，每帧最多一次；
  //       拖拽期间禁用 smooth 与卡片动效，避免每帧触发平滑动画/强制布局造成卡顿。
  let dragScroll = null, suppressClickUntil = 0, dragRAF = 0;
  document.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const sc = e.target.closest && e.target.closest('.row-scroll');
    if (!sc || sc.scrollWidth <= sc.clientWidth + 2) return;
    dragScroll = { sc, x: e.clientX, left: sc.scrollLeft, moved: false, target: sc.scrollLeft };
    sc.classList.add('dragging');
    e.preventDefault(); // 阻止图片/文字原生拖拽与选中
  });
  document.addEventListener('mousemove', e => {
    if (!dragScroll) return;
    const dx = e.clientX - dragScroll.x;
    if (Math.abs(dx) > 4) dragScroll.moved = true;
    dragScroll.target = dragScroll.left - dx;
    if (!dragRAF) dragRAF = requestAnimationFrame(() => {
      dragRAF = 0;
      if (dragScroll) dragScroll.sc.scrollLeft = dragScroll.target;
    });
  }, { passive: true });
  document.addEventListener('mouseup', () => {
    if (!dragScroll) return;
    if (dragRAF) { cancelAnimationFrame(dragRAF); dragRAF = 0; }
    const ds = dragScroll; dragScroll = null;
    ds.sc.scrollLeft = ds.target; // 落定最终位置
    ds.sc.classList.remove('dragging');
    if (ds.moved) suppressClickUntil = performance.now() + 250;
  });
  // 拖拽结束紧跟的那次 click 是误触，在捕获阶段拦掉，避免触发卡片内联 onclick
  document.addEventListener('click', e => {
    if (performance.now() < suppressClickUntil) {
      suppressClickUntil = 0; e.stopPropagation(); e.preventDefault();
    }
  }, true);
  // 海报卡片 3D 偏转：鼠标位置映射轻微 rotateX/rotateY，配合原有放大
  let tiltCur = null;
  document.addEventListener('mousemove', e => {
    // 拖拽行时跳过 3D 偏转：避免每帧 getBoundingClientRect 强制布局 + 与拖拽打架
    if (dragScroll) {
      if (tiltCur) { tiltCur.style.setProperty('--rx', '0deg'); tiltCur.style.setProperty('--ry', '0deg'); tiltCur = null; }
      return;
    }
    const card = e.target.closest && e.target.closest('.poster');
    if (!card || card !== tiltCur) {
      if (tiltCur) { tiltCur.style.setProperty('--rx', '0deg'); tiltCur.style.setProperty('--ry', '0deg'); }
      tiltCur = card;
    }
    if (!card) return;
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    card.style.setProperty('--rx', (-py * 12).toFixed(1) + 'deg');
    card.style.setProperty('--ry', (px * 12).toFixed(1) + 'deg');
  }, { passive: true });
  $('#vod-site').onchange = e => { state.vodKey = e.target.value; LS.set('vodKey', state.vodKey); state.vodClass = ''; loadVodClasses(); };
  $('#vod-first').onclick = () => { if (state.vodPage > 1) { state.vodPage = 1; loadVodGrid(); } };
  $('#vod-prev').onclick = () => { if (state.vodPage > 1) { state.vodPage--; loadVodGrid(); } };
  $('#vod-next').onclick = () => { if (state.vodPage < state.vodPageCount) { state.vodPage++; loadVodGrid(); } };
  $('#vod-last').onclick = () => { if (state.vodPage < state.vodPageCount) { state.vodPage = state.vodPageCount; loadVodGrid(); } };

  $('#detail-close').onclick = closeDetail;
  $('#detail-play').onclick = () => playVod(0);
  $('#detail-fav').onclick = toggleFav;
  $('#detail-read').onclick = () => {
    const d = state.detail; if (!d) return;
    const key = d.siteKey || state.vodKey;
    closeDetailSilently();
    openArticleReader(key, d.id);
  };
  // 下载当前资源：先选“默认路径 / 自己挑文件夹”，再加入队列，不直接开下
  $('#detail-download').onclick = () => {
    const d = state.detail; if (!d) return;
    const def = LS.get('downloadDir', '') || state.defaultDownloadDir || '';
    const items = [
      { i: 0, label: '使用默认路径：' + (def || '系统下载目录') },
      { i: 1, label: '打开文件夹自己选择…' },
    ];
    showList('选择下载位置', items, async it => {
      let dir = '';
      if (it.i === 0) dir = def;
      else {
        if (!window.tvbox?.pickFolder) { toast('当前环境不支持文件夹选择'); return; }
        try { dir = await window.tvbox.pickFolder(); } catch (e) {}
        if (!dir) return;
        LS.set('downloadDir', dir);
        renderSettings();
      }
      const active = $('#detail-eps .ep.active');
      const epIdx = active && active.dataset.i !== undefined ? +active.dataset.i : 0;
      try {
        await api('/api/download/start', {
          dir,
          siteKey: d.siteKey,
          id: d.id,
          article: d.fromArticle ? 1 : 0,
          line: state.epLine,
          epIdx,
          name: d.name || '资源',
          kind: d.kind || (d.fromArticle ? 'article' : 'video'),
        });
        toast('已加入下载队列，可在顶部「下载」查看进度');
      } catch (e) { toast('下载失败：' + e.message); }
    }, { display: it => it.label });
  };
  $('#detail-search').onclick = () => { const name = state.detail?.name || ''; closeDetail(); switchView('search'); $('#search-input').value = name; doSearch(); };
  $('#detail-switch').onclick = () => { const name = state.detail?.name || ''; closeDetail(); switchView('search'); $('#search-input').value = name; doSearch(); };
  $('#ep-sort').onclick = () => { state.epSortAsc = !state.epSortAsc; $('#ep-sort').textContent = state.epSortAsc ? '正序' : '倒序'; renderEpisodes(); };

  $('#player-back').onclick = backFromPlayer;
  $('#player-prev').onclick = () => { if (state.player?.epIdx > 0) { state.player.epIdx--; selectEpAndPlay(); } };
  $('#player-next').onclick = () => { if (state.player) { state.player.epIdx++; selectEpAndPlay(); } };
  $('#player-line').onchange = e => { if (state.player) { state.player.line = +e.target.value; state.player.epIdx = 0; selectEpAndPlay(); } };
  $('#player-ep').onchange = e => { if (state.player) { state.player.epIdx = +e.target.value; selectEpAndPlay(); } };

  $('#live-source').onchange = e => { state.liveKey = e.target.value; loadLivePlaylist(e.target.value); };
  $('#live-filter').oninput = () => { if (state.liveGroup) selectLiveGroup(state.liveGroup); };
  $('#lr-prev').onclick = () => playLive((state.liveIdx - 1 + state.liveChannels.length) % state.liveChannels.length);
  $('#lr-next').onclick = () => playLive((state.liveIdx + 1) % state.liveChannels.length);
  $('#lr-retry').onclick = () => { if (state.liveIdx >= 0) playLive(state.liveIdx); };
  $('#lr-full').onclick = () => { const v = $('#live-video'); v.requestFullscreen?.(); };
  $('#lr-line').onclick = () => { if (state.liveIdx >= 0) playLive((state.liveIdx + 1) % state.liveChannels.length); };
  // 直播音量（非全屏也能调）
  const vol = $('#live-vol');
  const applyVol = () => {
    const v = $('#live-video'); const val = +vol.value;
    v.volume = val / 100; v.muted = val === 0;
    $('#live-vol-val').textContent = val;
    $('#lr-mute-val').textContent = val === 0 ? '🔇' : '🔊';
    LS.set('liveVol', val);
  };
  vol.oninput = applyVol;
  const savedVol = LS.get('liveVol', 80);
  vol.value = savedVol; applyVol();
  $('#lr-mute').onclick = () => {
    const v = $('#live-video');
    if (v.muted || +vol.value === 0) { const restore = +vol.value || 80; vol.value = restore; v.muted = false; applyVol(); }
    else { v.muted = true; $('#lr-mute-val').textContent = '🔇'; }
  };
  // 点播播放器音量（独立于原生控件，未加载也可调）
  initVodVolume();
  // 直播左栏拖动调整宽度（分组列按比例联动）
  initLiveResize();

  $('#search-btn').onclick = doSearch;
  // 只按回车/点击按钮才搜索：不再边输边搜，避免逐字输入把「gong」等半截词写进搜索历史
  $('#search-input').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } };

  // 推送
  $('#push-play').onclick = () => {
    const url = extractPushUrl($('#push-input').value);
    if (!url) { $('#push-msg').textContent = '未识别到有效链接'; return; }
    $('#push-msg').textContent = '正在推送：' + url;
    playPushUrl(url);
  };
  $('#push-clear').onclick = () => { $('#push-input').value = ''; $('#push-msg').textContent = ''; };
  $('#push-hist-clear').onclick = () => { LS.set('pushHistory', []); renderPushHistory(); toast('已清空推送记录'); };

  // 本地文件
  $('#file-up').onclick = () => { if (state.fileParent) loadFileDir(state.fileParent); else loadFileRoot(); };
  $('#file-root').onclick = loadFileRoot;

  $('#fav-clear').onclick = () => { LS.set('fav', []); renderFav(); toast('已清空收藏'); };
  $('#history-clear').onclick = () => { LS.set('history', []); renderHistory(); toast('已清空历史'); };

  // 设置项：点播/直播配置地址分开设置与操作，互不影响
  $('#set-api-vod').onclick = () => showPrompt('点播配置地址（订阅 URL 或配置 JSON）', '', async (v, _scope, name) => { if (v) await applyConfigFromText(v, 'vod', name); }, true, 'vod');
  $('#set-api-live').onclick = () => showPrompt('直播配置地址（m3u/txt 订阅 URL 或配置 JSON）', '', async (v, _scope, name) => { if (v) await applyConfigFromText(v, 'live', name); }, true, 'live');
  $('#set-api-history').onclick = () => switchView('sources');
  const srcBack = $('#src-back'); if (srcBack) srcBack.onclick = () => switchView('settings');
  const srcRefresh = $('#src-refresh'); if (srcRefresh) srcRefresh.onclick = async () => {
    // 先重新拉取服务端最新配置，让"当前"标记与生效站点保持同步，再重绘清单
    try { state.config = await api('/api/config?t=' + Date.now()); applyConfig(); } catch (_) {}
    await showApiHistory(true);
    toast('接口清单已刷新');
  };
  $('#set-import').onclick = () => showPrompt('从 URL 导入配置（选类型、填名称、粘贴订阅地址）', '', async (v, scope, name) => { if (v) await applyConfigFromText(v, scope, name); }, true, 'choose');
  $('#set-import-file').onclick = () => $('#file-import-config').click();
  $('#file-import-config').onchange = e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const content = String(rd.result).trim();
      showPrompt('导入本地文件（已读取 ' + content.length + ' 字符，选类型并填名称）', content, async (v, scope, name) => { if (v) await applyConfigFromText(v, scope, name); }, true, 'choose');
    };
    rd.readAsText(f, 'utf-8');
  };
  $('#set-home').onclick = () => {
    if (!state.sites.length) { toast('还没有点播源，先导入配置'); return; }
    showList('首页站源（点击切换 · 右键复制源信息）', state.sites.map(s => ({ key: s.key, name: s.name, cur: s.key === state.homeKey })), it => {
      const wasHist = setHomeSite(it.key);
      toast('首页站源已切换：' + it.name + (wasHist ? '（首页推荐已切回站点推荐）' : ''));
    }, { display: it => it.name, onContext: copySiteInfo });
  };
  const toggleDefaults = { homeMultiRow: true, fastSearch: true, autoLine: true, safeDns: false, m3u8Purify: false, historyMerge: true };
  const toggleIds = { 'set-home-style': 'homeMultiRow', 'set-fast': 'fastSearch', 'set-autoline': 'autoLine', 'set-dns': 'safeDns', 'set-m3u8ad': 'm3u8Purify', 'set-history-merge': 'historyMerge' };
  for (const [id, key] of Object.entries(toggleIds)) {
    $('#' + id).onclick = () => { const v = !LS.get(key, toggleDefaults[key]); LS.set(key, v); renderSettings(); };
  }
  // 网络加速：开启走系统代理（浏览器同款），关闭走直连；状态存服务端，重启保持
  $('#set-netaccel').onclick = async () => {
    const v = !state.netAccel;
    try {
      const r = await fetch('/api/netaccel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: v }) });
      const j = await r.json();
      state.netAccel = !!j.enabled;
      renderSettings();
      toast(state.netAccel ? '网络加速已开启：接口改走系统代理' : '网络加速已关闭：接口走直连');
    } catch (e) { toast('设置失败：' + e.message); }
  };
  // 下次进入（原版 DEFAULT_LOAD_LIVE：点播/直播）
  $('#set-default-view').onclick = () => {
    const v = LS.get('defaultView', 'home') === 'live' ? 'home' : 'live';
    LS.set('defaultView', v);
    $('#set-default-view-val').textContent = v === 'live' ? '直播' : '点播';
    toast('下次启动进入' + (v === 'live' ? '直播' : '点播'));
  };
  // 首页推荐（原版 HOME_REC：站点推荐/观看历史）
  $('#set-home-rec').onclick = () => {
    const v = LS.get('homeRec', 'site') === 'history' ? 'site' : 'history';
    LS.set('homeRec', v);
    $('#set-home-rec-val').textContent = v === 'history' ? '观看历史' : '站点推荐';
    loadHome();
  };
  // 历史记录数量（原版 HISTORY_NUM）
  $('#set-history-num').onclick = () => {
    const opts = [30, 50, 100, 200];
    const cur = LS.get('historyNum', 60);
    const next = opts[(opts.indexOf(cur) + 1) % opts.length] ?? 30;
    LS.set('historyNum', next);
    LS.set('history', LS.get('history', []).slice(0, next));
    $('#set-history-num-val').textContent = next + '条';
    toast('历史记录保留 ' + next + ' 条');
  };
  $('#download-clear-done').onclick = () => downloadControl('clearDone', '');
  // 下载路径：优先打开系统文件夹选择框；不支持时回退手工输入
  $('#set-download-dir').onclick = async () => {
    if (window.tvbox?.pickFolder) {
      let picked = '';
      try { picked = await window.tvbox.pickFolder(); } catch (e) {}
      if (picked) {
        LS.set('downloadDir', picked);
        renderSettings();
        toast('下载路径已保存：' + picked);
      }
      return;
    }
    const cur = LS.get('downloadDir', '') || state.defaultDownloadDir || '';
    showPrompt('下载路径（绝对路径）', cur, v => {
      if (!v) { toast('请输入绝对路径'); return; }
      const absolute = /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\') || v.startsWith('/');
      if (!absolute) { toast('请输入绝对路径，例如 D:\\Downloads'); return; }
      LS.set('downloadDir', v);
      renderSettings();
      toast('下载路径已保存');
    }, false);
  };
  // 清空缓存（原版：清掉抓取缓存并重载）
  $('#set-clear-cache').onclick = async () => {
    try {
      const r = await fetch('/api/cache/clear', { method: 'POST' });
      const d = await r.json();
      toast('已清空缓存（' + (d.cleared || 0) + ' 项），正在重新加载…');
      applyConfig(); loadHome(); loadVodClasses(); loadLiveSources();
    } catch (e) { toast('清空失败：' + e.message); }
  };
  // 数据备份 / 恢复（原版 BackupDialog）
  $('#set-backup').onclick = exportBackup;
  $('#set-restore').onclick = () => $('#file-restore').click();
  $('#file-restore').onchange = e => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) importBackupFile(f);
  };
  $('#set-search-view').onclick = () => { showPrompt('搜索展示', '聚合', () => {}); };
  $('#set-player').onclick = () => { showPrompt('播放器（PC 端使用内置 hls 播放器）', '系统内置', () => {}); };
  $('#set-scale').onclick = () => {
    const v = $('#vod-video');
    const modes = ['适应', '填充', '拉伸'];
    const cur = $('#set-scale-val').textContent;
    const next = modes[(modes.indexOf(cur) + 1) % modes.length];
    $('#set-scale-val').textContent = next;
    v.style.objectFit = next === '填充' ? 'cover' : next === '拉伸' ? 'fill' : 'contain';
    $('#live-video').style.objectFit = v.style.objectFit;
  };
  $('#set-wallpaper').onclick = () => cycleWallpaper();
  $('#set-bgreset').onclick = () => { document.body.style.backgroundImage = ''; LS.set('wallpaper', 0); toast('已重置壁纸'); };
  $('#set-about').onclick = () => showPrompt('关于 TVBox PC', 'TVBox PC 1.0\n基于 TVBoxOS 爬虫核移植\n数据源：sites / lives / parses', () => {}, false);
}

/* ---------------- 壁纸（原版换壁纸功能） ---------------- */
const WALLPAPERS = [
  '',
  'linear-gradient(135deg,#0a0a14,#161b2e 50%,#0a0a14)',
  'linear-gradient(135deg,#001a1a,#0a2e2e 50%,#001414)',
  'linear-gradient(135deg,#1a0a12,#2e1020 50%,#140a10)',
  'linear-gradient(135deg,#0a121a,#10243a 50%,#0a121a)',
];
function cycleWallpaper() {
  const cur = LS.get('wallpaper', 0);
  const next = (cur + 1) % WALLPAPERS.length;
  LS.set('wallpaper', next);
  document.body.style.background = WALLPAPERS[next] || '#000';
  toast('已换壁纸 ' + next);
}
function applyWallpaper() {
  const w = LS.get('wallpaper', 0);
  if (w) document.body.style.background = WALLPAPERS[w];
}

/* ---------------- 自绘窗口标题栏（无边框窗口） ---------------- */
function initWindowChrome() {
  const api = window.tvbox;
  const bar = $('#app-titlebar');
  if (!api || !bar) return;  // 浏览器预览环境没有这些能力，静默跳过
  const maxBtn = $('#tb-max');
  const syncMax = async known => {
    const m = typeof known === 'boolean' ? known : !!(await api.isMaximized?.());
    document.body.classList.toggle('win-max', m);
    if (maxBtn) {
      maxBtn.textContent = m ? '\u2750' : '\u25FB';
      maxBtn.title = m ? '还原' : '最大化';
    }
  };
  const bind = (sel, action) => { const b = $(sel); if (b) b.onclick = () => api.winAction?.(action); };
  bind('#tb-min', 'min');
  bind('#tb-max', 'max');
  bind('#tb-close', 'close');
  bar.ondblclick = e => { if (!e.target.closest('.tb-controls')) api.winAction?.('max'); };
  api.onWinState?.(m => syncMax(m));
  syncMax();
}

/* ---------------- 初始化 ---------------- */
async function init() {
  initWindowChrome();
  applyWallpaper();
  getSources().then(() => renderSettings());  // 预加载接口清单，刷新历史条数
  api('/api/download/defaultDir').then(r => { state.defaultDownloadDir = r.dir || ''; renderSettings(); }).catch(() => {});
  api('/api/netaccel').then(r => { state.netAccel = !!r.enabled; renderSettings(); }).catch(() => {});
  try {
    state.config = await api('/api/config');
    applyConfig();
    state.homeKey = LS.get('homeKey', state.homeKey);
    state.vodKey = LS.get('vodKey', state.vodKey);
    applyConfig();
  } catch (e) { toast('读取配置失败：' + e.message); }
  bindEvents();
  setupPlayerAutoHide();
  renderSettings();
  loadHome();
  loadVodClasses();
  loadLiveSources();
  // 下次进入（原版 DEFAULT_LOAD_LIVE）
  if (LS.get('defaultView', 'home') === 'live' && state.lives.length) switchView('live');
  refreshFocusables();
}
init();
window.openDetail = openDetail;
window.openArticleReader = openArticleReader;
window.playLive = playLive;
window.setReadClass = setReadClass;
window.openReadDetail = openReadDetail;
window.playReadChapter = playReadChapter;
window.openLightbox = openLightbox;
