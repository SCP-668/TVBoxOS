'use strict';
/* ================= TVBox PC 前端逻辑（复刻原版交互） ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LS = {
  get(k, d) { try { const v = localStorage.getItem('tvbox.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tvbox.' + k, JSON.stringify(v)); } catch {} },
};

const state = {
  config: null,
  sites: [],
  lives: [],
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
  // 离开时停掉对应播放器，避免声音残留
  if (prev === 'player' && v !== 'player') stopVodPlayer();
  if (prev === 'live' && v !== 'live') stopLive();
  $$('.view').forEach(x => x.classList.remove('active'));
  const el = $('#view-' + v); if (el) el.classList.add('active');
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  refreshFocusables();
  if (v === 'live' && !state.liveData) loadLiveSources();
  if (v === 'fav') renderFav();
  if (v === 'history') renderHistory();
  if (v === 'settings') renderSettings();
  if (v === 'push') renderPushHistory();
  if (v === 'file') loadFileRoot();
  if (v === 'search') renderSearchExtra();
}

/* ---------------- 海报卡片 ---------------- */
function posterHTML(v, opts = {}) {
  const pic = v.pic || '';
  const badges = [];
  if (v.year) badges.push(`<span class="badge year">${esc(v.year)}</span>`);
  if (v.area) badges.push(`<span class="badge area">${esc(v.area)}</span>`);
  if (v.lang) badges.push(`<span class="badge">${esc(v.lang)}</span>`);
  if (v.type && !v.area) badges.push(`<span class="badge">${esc(v.type)}</span>`);
  const note = v.remarks ? `<span class="note">${esc(v.remarks)}</span>` : '';
  const sub = [v.type, v.actor].filter(Boolean).join(' · ');
  const act = opts.action || `openDetail('${esc(v.siteKey || '')}','${esc(v.id)}')`;
  return `<div class="poster" tabindex="0" onclick="${act}" onkeydown="if(event.key==='Enter'){${act}}">
    ${pic ? `<img class="thumb" src="${esc(pic)}" loading="lazy" onerror="this.style.opacity=0">` : '<div class="thumb"></div>'}
    <div class="badges">${badges.join('')}</div>${note}
    <div class="caption"><div class="pname">${esc(v.name)}</div><div class="psub">${esc(sub)}</div></div>
  </div>`;
}
function rowHTML(title, videos, siteKey) {
  if (!videos || !videos.length) return '';
  const cards = videos.map(v => posterHTML({ ...v, siteKey })).join('');
  return `<div class="row">
    <div class="row-head"><span class="bar"></span><h3>${esc(title)}</h3><span class="more">${videos.length} 部</span></div>
    <div class="row-scroll">${cards}</div>
  </div>`;
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
  // 只请求当前选中的站源：解析失败就明确提示，绝不自动切到其它源
  let home = null;
  try { home = await apiTimeout('/api/vod/home', { key }, 9000); } catch (e) { home = null; }
  if (seq !== homeLoadSeq) return;
  if (!home || !(home.classes?.length || home.videos?.length || home.list?.length)) {
    $('#home-classes').innerHTML = '';
    const siteName = state.sites.find(s => s.key === key)?.name || key;
    $('#home-tip').textContent = '源：' + siteName;
    wrap.innerHTML = `<div class="empty-big">当前站点「${esc(siteName)}」内容加载失败（可能已失效或网络问题）。<br>请在上方「站源」下拉框中切换其它站点，或到「设置 → 配置地址」重新导入。</div>`;
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
    : '<div class="empty-big">加载中…</div>';
  refreshFocusables();
  const classes = (home.classes || []).slice(0, 8);
  let added = 0;
  for (const c of classes) {
    try {
      const r = await api('/api/vod/category', { key, tid: c.tid, pg: 1 });
      if (seq !== homeLoadSeq) return;
      if (!r.videos || !r.videos.length) continue;
      wrap.insertAdjacentHTML('beforeend', rowHTML(c.name, r.videos, key));
      added++;
      refreshFocusables();
    } catch (_) {}
  }
  if (!home.videos?.length && !added) wrap.innerHTML = '<div class="empty-big">该站源暂无数据</div>';
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
async function loadVodClasses() {
  const sel = $('#vod-site');
  sel.innerHTML = state.sites.map(s => `<option value="${esc(s.key)}">${esc(s.name)}</option>`).join('');
  if (!state.sites.length) { $('#vod-classes').innerHTML = ''; $('#vod-grid').innerHTML = ''; $('#vod-empty').style.display = ''; return; }
  let key = state.vodKey || state.sites[0].key;
  sel.value = key;
  // 只请求当前选中的站源：解析失败就明确提示，绝不自动切到其它源
  let home = null;
  try { home = await apiTimeout('/api/vod/home', { key }, 9000); } catch (e) { home = null; }
  if (!home || !(home.classes?.length || home.list?.length)) {
    state.vodKey = key; sel.value = key;
    $('#vod-classes').innerHTML = ''; $('#vod-grid').innerHTML = '';
    $('#vod-empty').style.display = '';
    const siteName = state.sites.find(s => s.key === key)?.name || key;
    $('#vod-empty').textContent = `当前站点「${siteName}」解析失败，请在上方站源下拉框中切换其它站点，或到「设置 → 配置地址」重新导入。`;
    return;
  }
  state.vodKey = key; LS.set('vodKey', key); sel.value = key;
  try {
    const classes = home.classes || [];
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
}
async function loadVodGrid() {
  if (!state.vodKey || !state.vodClass) return;
  const grid = $('#vod-grid'); grid.innerHTML = '<div class="empty-big">加载中…</div>';
  try {
    const r = await api('/api/vod/category', { key: state.vodKey, tid: state.vodClass, pg: state.vodPage });
    state.vodPageCount = Math.max(1, Number(r.pagecount) || 1);
    $('#vod-page').textContent = `${state.vodPage} / ${state.vodPageCount}`;
    $('#vod-prev').style.opacity = state.vodPage <= 1 ? '.35' : '1';
    $('#vod-next').style.opacity = state.vodPage >= state.vodPageCount ? '.35' : '1';
    grid.innerHTML = r.videos.map(v => posterHTML({ ...v, siteKey: state.vodKey })).join('');
    $('#vod-empty').style.display = r.videos.length ? 'none' : '';
    refreshFocusables();
  } catch (e) { grid.innerHTML = `<div class="empty-big">加载失败：${esc(e.message)}</div>`; }
}

/* ---------------- 详情弹层 ---------------- */
async function openDetail(siteKey, id) {
  const box = $('#detail'); box.classList.remove('hidden');
  $('#detail-name').textContent = '加载中…';
  try {
    const d = await api('/api/vod/detail', { key: siteKey, id });
    state.detail = { ...d, siteKey };
    state.epLine = 0; state.epSortAsc = true;
    $('#detail-pic').src = d.pic || '';
    $('#detail-name').textContent = d.name || '未命名';
    $('#detail-site').textContent = state.sites.find(s => s.key === siteKey)?.name || siteKey;
    $('#detail-year').textContent = d.year || '';
    $('#detail-area').textContent = d.area || '';
    $('#detail-lang').textContent = d.lang || '';
    $('#detail-type').textContent = d.type || '';
    $('#detail-remarks').textContent = d.remarks || '';
    $('#detail-actor').textContent = d.actor || '—';
    $('#detail-director').textContent = d.director || '—';
    $('#detail-des').textContent = d.des || '暂无简介';
    // 线路
    $('#ep-lines').innerHTML = (d.plays || []).map((p, i) => `<div class="ep-line ${i === 0 ? 'active' : ''}" data-i="${i}">${esc(p.flag)}</div>`).join('');
    $$('#ep-lines .ep-line').forEach(el => el.onclick = () => {
      state.epLine = +el.dataset.i;
      $$('#ep-lines .ep-line').forEach(x => x.classList.toggle('active', x === el));
      renderEpisodes();
    });
    renderEpisodes();
    const fav = LS.get('fav', []);
    $('#detail-fav').textContent = fav.some(x => x.id === d.id && x.siteKey === siteKey) ? '取消收藏' : '加入收藏';
  } catch (e) {
    $('#detail-name').textContent = '加载失败：' + e.message;
  }
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
function closeDetail() { $('#detail').classList.add('hidden'); stopVodPlayer(); }

/* ---------------- 点播播放 ---------------- */
function proxyUrl(url) { return '/api/proxy?url=' + encodeURIComponent(url) + (LS.get('m3u8Purify', false) ? '&purify=1' : ''); }
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
  $$('.view').forEach(x => x.classList.remove('active'));
  const el = $('#view-' + v); if (el) el.classList.add('active');
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'player') pokePlayerUi(); else clearTimeout(playerUiTimer);
}
// 从播放器返回进入前的页面（点播/首页/搜索/收藏/历史…），而不是固定回首页
function backFromPlayer() {
  const target = playerReturnView && $('#view-' + playerReturnView) ? playerReturnView : 'home';
  switchView(target);
}
function attachVodSource(url) {
  const video = $('#vod-video');
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
let searchTimer = null;
async function doSearch() {
  const wd = $('#search-input').value.trim();
  if (!wd) { toast('请输入关键词'); return; }
  // 记录搜索历史
  const hist = LS.get('searchHistory', []);
  LS.set('searchHistory', [wd, ...hist.filter(x => x !== wd)].slice(0, 12));
  renderSearchExtra();
  const box = $('#search-results'); box.innerHTML = '<div class="empty-big">搜索中…</div>';
  $('#search-empty').style.display = 'none';
  try {
    const r = await api('/api/vod/search', { wd });
    let html = '';
    for (const res of r.results || []) {
      const siteName = state.sites.find(s => s.key === res.siteKey)?.name || res.siteKey;
      html += rowHTML(`${siteName} · 找到 ${res.videos?.length || 0} 部`, res.videos || [], res.siteKey);
    }
    box.innerHTML = html || '<div class="empty-big">没有找到结果</div>';
    refreshFocusables();
  } catch (e) { box.innerHTML = `<div class="empty-big">搜索失败：${esc(e.message)}</div>`; }
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
  $('#fav-grid').innerHTML = fav.map(v => posterHTML({ ...v, action: `openDetail('${esc(v.siteKey)}','${esc(v.id)}')` })).join('');
  refreshFocusables();
}
function renderHistory() {
  const hist = LS.get('history', []);
  $('#history-empty').style.display = hist.length ? 'none' : '';
  $('#history-grid').innerHTML = hist.map(v => posterHTML({ ...v, action: `openDetail('${esc(v.siteKey)}','${esc(v.id)}')` })).join('');
  refreshFocusables();
}
function toggleFav() {
  const d = state.detail; if (!d) return;
  const fav = LS.get('fav', []);
  const i = fav.findIndex(x => x.id === d.id && x.siteKey === d.siteKey);
  if (i >= 0) { fav.splice(i, 1); toast('已取消收藏'); $('#detail-fav').textContent = '加入收藏'; }
  else { fav.unshift({ id: d.id, siteKey: d.siteKey, name: d.name, pic: d.pic, year: d.year, type: d.type }); toast('已加入收藏'); $('#detail-fav').textContent = '取消收藏'; }
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
  const homeSite = state.sites.find(s => s.key === state.homeKey) || state.sites[0];
  $('#set-home-val').textContent = homeSite ? homeSite.name : '未配置';
  $('#set-default-view-val').textContent = LS.get('defaultView', 'home') === 'live' ? '直播' : '点播';
  $('#set-home-rec-val').textContent = LS.get('homeRec', 'site') === 'history' ? '观看历史' : '站点推荐';
  $('#set-history-num-val').textContent = LS.get('historyNum', 60) + '条';
}
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
  });
  $('#list-modal-close').onclick = () => $('#list-modal').classList.add('hidden');
}
/* 配置历史：逐条列出所有接入的接口（点播订阅 / 直播订阅）+ 用户导入历史 + 恢复预置入口 */
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
async function showApiHistory() {
  const hist = LS.get('apiHistory', []);
  const hidden = hiddenSources();
  const curVod = state.config?.vodApiUrl || (state.config?.apiUrl === 'preset' ? 'preset' : (state.config?.apiUrl || ''));
  const curLive = state.config?.liveApiUrl || '';
  const src = await getSources();
  const inHidden = u => hidden.includes(u);
  const items = [];

  // 1) 内置接入的点播订阅接口（逐条）
  const vodList = (src.vod || []).filter(s => !inHidden(s.url));
  if (vodList.length) items.push({ kind: 'group', label: `点播接口（${vodList.length}）· 点击只替换点播源` });
  for (const s of vodList) items.push({ kind: 'vod', name: s.name, url: s.url, ok: !!s.ok, cur: curVod === s.url });

  // 2) 内置接入的直播订阅接口（逐条）
  const liveList = (src.live || []).filter(s => !inHidden(s.url));
  if (liveList.length) items.push({ kind: 'group', label: `直播接口（${liveList.length}）· 点击只替换直播源` });
  for (const s of liveList) items.push({ kind: 'live', name: s.name, url: s.url, cur: curLive === s.url });

  // 3) 用户手动导入/粘贴的配置历史（按各自记录的类型重新解析）
  if (hist.length) items.push({ kind: 'group', label: `我的导入历史（${hist.length}）` });
  hist.forEach((h, i) => items.push({
    kind: 'cfg', i, text: histText(h), scope: (typeof h !== 'string' && h?.scope) || 'vod',
    label: (typeof h !== 'string' && h?.label) || histText(h).replace(/^https?:\/\//, '').slice(0, 60),
  }));

  // 4) 恢复内置预置（常驻底部，不可删）
  items.push({ kind: 'group', label: '其他' });
  items.push({ kind: 'preset', noDel: true, label: `↺ 恢复内置预置（${src.vod?.length || 0} 点播 / ${src.live?.length || 0} 直播）` });

  showList('配置历史（点播/直播分开操作 · ✕ 隐藏/删除）', items, async it => {
    if (it.kind === 'group') return;
    if (it.kind === 'preset') {
      try {
        const cfg = await api('/api/config/preset');
        state.config = cfg; applyConfig(); renderSettings();
        loadHome(); loadVodClasses(); loadLiveSources();
        toast(`已恢复内置预置：${cfg.sites.length} 点播 / ${cfg.lives.length} 直播`);
      } catch (e) { toast('恢复失败：' + e.message); }
    } else if (it.kind === 'live') {
      // 直播接口：把该播放列表追加进直播源，只动 lives，绝不动点播源
      const cfg = JSON.parse(JSON.stringify(state.config || { sites: [], lives: [], parses: [] }));
      const key = 'live_iface_' + (cfg.lives.length + 1) + '_' + Date.now().toString(36);
      const name = it.name || '直播接口';
      cfg.lives = [{ key, name, url: it.url, ua: '' }, ...(cfg.lives || [])];
      cfg.liveApiUrl = it.url;
      try {
        const saved = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
        if (!saved.ok) throw new Error(saved.status);
        state.config = await saved.json(); applyConfig(); renderSettings();
        state.liveKey = key; switchView('live'); loadLiveSources();
        toast('已追加直播接口：' + name + '（点播源未改动）');
      } catch (e) { toast('加载直播接口失败：' + e.message); }
    } else if (it.kind === 'vod') {
      // 点播接口：只更新点播源；失败明确提示，让用户自己选择其它接口
      const ok = await applyConfigFromText(it.url, 'vod');
      if (ok) showApiHistory();
    } else {
      // 用户导入历史：按该条记录的类型，只更新对应一侧
      const ok = await applyConfigFromText(it.text, it.scope);
      if (ok) { if (it.scope === 'live') switchView('live'); showApiHistory(); }
    }
  }, {
    html: it => {
      if (it.kind === 'group') return `<div class="lm-group">${esc(it.label)}</div>`;
      if (it.kind === 'preset') return `<div class="lm-cfg-head">${esc(it.label)}</div>`;
      if (it.kind === 'vod' || it.kind === 'live') {
        const badge = it.kind === 'live' ? '<span class="lm-badge live">直播</span>' : '<span class="lm-badge">点播</span>';
        const okTag = it.kind === 'vod' ? (it.ok ? '<span class="lm-badge ok">可用</span>' : '<span class="lm-badge dead">失效</span>') : '';
        return `<div class="lm-cfg-head">${badge}${okTag}${esc(it.name || '接口')}${it.cur ? ' · 当前' : ''}</div><div class="lm-url">${esc(it.url)}</div>`;
      }
      const badge = it.scope === 'live' ? '<span class="lm-badge live">直播</span>' : '<span class="lm-badge">点播</span>';
      return `<div class="lm-cfg-head">${badge}${esc(it.label)}</div><pre class="lm-json">${esc((it.text || '').slice(0, 400))}</pre>`;
    },
    deletable: true,
    empty: '暂无接口清单，先导入配置',
    onDelete: async it => {
      if (it.kind === 'preset' || it.kind === 'group') return;
      if (it.kind === 'vod' || it.kind === 'live') {
        hideSource(it.url); toast('已隐藏该接口');
      } else if (it.kind === 'cfg') {
        LS.set('apiHistory', LS.get('apiHistory', []).filter((_, idx) => idx !== it.i));
        toast('已删除该配置');
      }
      showApiHistory(); renderSettings();
    },
  });
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
function showPrompt(title, value, onOk, multiline = true, scope = null) {
  $('#prompt-title').textContent = title;
  $('#prompt-text').value = value || '';
  // 接口类型选择：scope 为 'vod'/'live' 时预选并锁定类型，为 'choose' 时让用户选，为 null 时隐藏
  const row = $('#prompt-type-row');
  const sel = $('#prompt-scope');
  if (scope === 'vod' || scope === 'live' || scope === 'choose') {
    row.style.display = '';
    sel.value = scope === 'choose' ? 'vod' : scope;
    sel.disabled = (scope !== 'choose');
  } else {
    row.style.display = 'none';
  }
  $('#prompt').classList.remove('hidden');
  $('#prompt-ok').onclick = () => {
    const v = $('#prompt-text').value.trim();
    const chosen = sel.value;
    $('#prompt').classList.add('hidden');
    onOk(v, chosen);
  };
  $('#prompt-cancel').onclick = () => $('#prompt').classList.add('hidden');
  setTimeout(() => $('#prompt-text').focus(), 50);
}
// scope: 'vod' | 'live'。只更新对应一侧，另一侧保持不动。nameHint 用于直播接口命名。
async function applyConfigFromText(text, scope = 'vod', nameHint = '') {
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
  {
    const h = LS.get('apiHistory', []);
    const key = (scope === 'live' ? 'live:' : 'vod:') + (isUrl ? text : text.slice(0, 200));
    const entry = { url: isUrl ? text : '', text: rawText || text, label: isUrl ? text.replace(/^https?:\/\//, '').slice(0, 60) : '粘贴的配置 JSON', scope, ts: Date.now() };
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
  const hs = $('#home-site');
  hs.innerHTML = state.sites.map(s => `<option value="${esc(s.key)}">${esc(s.name)}</option>`).join('');
  if (!state.sites.some(s => s.key === state.homeKey)) state.homeKey = state.sites[0]?.key || '';
  if (!state.sites.some(s => s.key === state.vodKey)) state.vodKey = state.sites[0]?.key || '';
  if (state.homeKey) hs.value = state.homeKey;
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

/* ---------------- 键盘方向键焦点（模拟原版遥控器） ---------------- */
function refreshFocusables() {
  const root = $('.view.active') || document;
  state.focusables = [...root.querySelectorAll('.poster,.chip,.ch,.hc,.lg,.lr-item,.set-item,.nav-btn,.ep,.ep-line,.act,.file-item,.fr-chip,.se-chip,.push-hist-item,.lm-item')].filter(x => x.offsetParent !== null);
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
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#detail').classList.contains('hidden')) closeDetail();
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

  $('#home-site').onchange = e => {
    const wasHist = setHomeSite(e.target.value);
    if (wasHist) toast('首页推荐已切回站点推荐');
  };
  $('#vod-site').onchange = e => { state.vodKey = e.target.value; LS.set('vodKey', state.vodKey); state.vodClass = ''; loadVodClasses(); };
  $('#vod-prev').onclick = () => { if (state.vodPage > 1) { state.vodPage--; loadVodGrid(); } };
  $('#vod-next').onclick = () => { if (state.vodPage < state.vodPageCount) { state.vodPage++; loadVodGrid(); } };

  $('#detail-close').onclick = closeDetail;
  $('#detail-play').onclick = () => playVod(0);
  $('#detail-fav').onclick = toggleFav;
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
  // 直播左栏拖动调整宽度（分组列按比例联动）
  initLiveResize();

  $('#search-btn').onclick = doSearch;
  $('#search-input').onkeydown = e => { if (e.key === 'Enter') doSearch(); };
  // 快搜：边输边搜（防抖 600ms）
  $('#search-input').oninput = () => {
    clearTimeout(searchTimer);
    const wd = $('#search-input').value.trim();
    if (wd.length < 2) return;
    searchTimer = setTimeout(doSearch, 600);
  };

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
  $('#set-api-vod').onclick = () => showPrompt('点播配置地址（订阅 URL 或配置 JSON）', state.config?.vodApiUrl || (state.config?.apiUrl === 'preset' ? '' : (state.config?.apiUrl || '')), async v => { if (v) await applyConfigFromText(v, 'vod'); }, true, 'vod');
  $('#set-api-live').onclick = () => showPrompt('直播配置地址（m3u/txt 订阅 URL 或配置 JSON）', state.config?.liveApiUrl || '', async v => { if (v) await applyConfigFromText(v, 'live'); }, true, 'live');
  $('#set-api-history').onclick = showApiHistory;
  $('#set-import').onclick = () => showPrompt('从 URL 导入配置（先选接口类型，再粘贴订阅地址）', '', async (v, scope) => { if (v) await applyConfigFromText(v, scope); }, true, 'choose');
  $('#set-import-file').onclick = () => $('#file-import-config').click();
  $('#file-import-config').onchange = e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const content = String(rd.result).trim();
      showPrompt('导入本地文件（已读取 ' + content.length + ' 字符，先选接口类型）', content, async (v, scope) => { if (v) await applyConfigFromText(v, scope); }, true, 'choose');
    };
    rd.readAsText(f, 'utf-8');
  };
  $('#set-home').onclick = () => {
    if (!state.sites.length) { toast('还没有点播源，先导入配置'); return; }
    showList('首页站源（点击切换）', state.sites.map(s => ({ key: s.key, name: s.name, cur: s.key === state.homeKey })), it => {
      const wasHist = setHomeSite(it.key);
      toast('首页站源已切换：' + it.name + (wasHist ? '（首页推荐已切回站点推荐）' : ''));
    }, { display: it => it.name });
  };
  const toggleDefaults = { homeMultiRow: true, fastSearch: true, autoLine: true, safeDns: false, m3u8Purify: false, historyMerge: true };
  const toggleIds = { 'set-home-style': 'homeMultiRow', 'set-fast': 'fastSearch', 'set-autoline': 'autoLine', 'set-dns': 'safeDns', 'set-m3u8ad': 'm3u8Purify', 'set-history-merge': 'historyMerge' };
  for (const [id, key] of Object.entries(toggleIds)) {
    $('#' + id).onclick = () => { const v = !LS.get(key, toggleDefaults[key]); LS.set(key, v); renderSettings(); };
  }
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

/* ---------------- 初始化 ---------------- */
async function init() {
  applyWallpaper();
  getSources().then(() => renderSettings());  // 预加载接口清单，刷新历史条数
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
window.playLive = playLive;
