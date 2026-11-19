'use strict';
/* 回归自检：确保「猫影视兼容结构」不会破坏标准 JSON 采集配置的解析。
 * 用法：node selftest.js   （改动 configParser / spider 后先跑一遍）
 * 只做本地断言，不访问网络、不改动任何配置。
 */
const assert = require('node:assert');
const http = require('node:http');
const cp = require('./service/configParser');
const spider = require('./service/spider');

let passed = 0;
function ok(name) { passed++; console.log('  ✓ ' + name); }

// 1) 标准 TVBox JSON：sites 的 api/type 必须原样解析（量子资源这类源不能被改写）
const standardCfg = JSON.stringify({
  sites: [
    { key: 'a', name: 'A', api: 'http://example.com/api.php/provide/vod/', type: 1 },
    { key: 'b', name: 'B', api: 'https://example.org/at/json', type: 0 },
  ],
  lives: [], parses: [],
});
{
  const p = cp.parseConfigText(standardCfg);
  assert.equal(p.sites.length, 2, '标准 sites 数量');
  assert.equal(p.sites[0].api, 'http://example.com/api.php/provide/vod/', '标准 api 原样');
  assert.equal(p.sites[0].type, 1, '标准 type 原样');
  assert.deepEqual(p.reads, [], '标准配置不应凭空产生 reads');
  ok('标准 JSON 的 sites/api/type 原样解析，无 reads 污染');
}

// 2) 猫影视嵌套结构：video.sites 作为兜底被识别，read.sites 生成 reads
const catCfg = JSON.stringify({
  video: { sites: [{ key: 'c', name: 'C', api: 'http://cat.example/vod/', type: 1 }] },
  read: { sites: [{ key: 'r', name: 'R', api: 'bookan_open.js' }] },
});
{
  const p = cp.parseConfigText(catCfg);
  assert.equal(p.sites.length, 1, '视频兜底站点数');
  assert.equal(p.sites[0].key, 'c', '视频兜底站点 key');
  assert.equal(p.reads.length, 1, '小说源数量');
  assert.equal(p.reads[0].driver, 'bookan', '小说源 driver');
  ok('猫影视 video.sites/read.sites 兜底解析，且不覆盖标准结构');
}

// 3) 两种结构同时存在时，标准 sites 优先，不被 video.sites 覆盖
const mixedCfg = JSON.stringify({
  sites: [{ key: 'std', name: 'STD', api: 'http://std.example/vod/', type: 0 }],
  video: { sites: [{ key: 'cat', name: 'CAT', api: 'http://cat.example/vod/', type: 1 }] },
});
{
  const p = cp.parseConfigText(mixedCfg);
  assert.equal(p.sites.length, 1, '应只取标准 sites');
  assert.equal(p.sites[0].key, 'std', '标准 sites 必须优先');
  ok('标准 sites 优先于 video.sites（导入猫影视不会顶掉标准源）');
}

// 4) 失效响应必须抛错，合法 JSON/XML 必须放行（按路径返回不同内容）
const JSON_OK = JSON.stringify({
  code: 1, list: [{ vod_id: '1', vod_name: '测试影片', vod_pic: '', vod_play_from: 't', vod_play_url: '测试$http://x/1.m3u8' }],
  class: [{ type_id: '1', type_name: '电影' }], pagecount: 1,
});
const XML_OK = '<?xml version="1.0" encoding="utf-8"?><rss><class><ty id="1">电影</ty></class>'
  + '<list><video id="1"><name>测试</name><pic></pic><playfrom>t</playfrom><playurl>测试$http://x/1.m3u8</playurl></video></list>'
  + '<pagecount>1</pagecount></rss>';
const HTML_DEAD = '<!-- 636338150173 -->\n<!DOCTYPE html><html lang="en"><head><title>This domain is for sale</title></head>'
  + '<body><h1>This domain is for sale</h1></body></html>';
const srv = http.createServer((req, res) => {
  const p = (req.url || '').split('?')[0];
  if (p === '/text-error') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('upstream connect failed: connection timed out'); }
  if (p === '/html-dead') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(HTML_DEAD); }
  if (p === '/json-ok') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('\uFEFF' + JSON_OK); }
  if (p === '/xml-ok') { res.writeHead(200, { 'content-type': 'text/xml' }); return res.end(XML_OK); }
  res.writeHead(200); res.end('');
});
srv.listen(0, '127.0.0.1', async () => {
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const mk = (path) => ({ key: 'x', name: 'x', api: base + path, type: 0 });
    await assert.rejects(spider.home(mk('/text-error')), /上游返回错误/, '错误文本应抛错');
    ok('网关/代理错误文本被拒绝，不再伪装成空数据');
    await assert.rejects(spider.home(mk('/html-dead')), /上游返回错误/, 'HTML 失效页应抛错');
    ok('HTTP200+HTML 失效页（域名出售/404/挑战页）被识别为失效，前端可显示真实原因');
    const jr = await spider.home(mk('/json-ok'));
    assert.equal(jr.videos.length, 1, '带 BOM 的标准 JSON 必须解析出影片');
    ok('标准 JSON（含 BOM）正常放行，不受错误识别影响');
    const xr = await spider.home(mk('/xml-ok'));
    assert.equal(xr.videos.length, 1, '标准 XML 必须解析出影片');
    ok('标准 XML 正常放行，不被 HTML 规则误伤');
    console.log(`\n全部通过：${passed} 项`);
  } catch (e) {
    console.error('自检失败：', e.message);
    process.exitCode = 1;
  } finally {
    srv.close();
  }
});
