// tests/zentao-client.test.mjs
//
// 用 node:http 假禅道驱动真实的 lib/zentao-client.mjs（登录握手、浏览页双层信封、
// v1 详情、备注/状态表单、文件下载、cookie 与各种失效形态），外加纯函数单测。
// 不连真实禅道、不连 DSH、不出 127.0.0.1。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  createZentaoClient,
  createCookieJar,
  parseVerifyRand,
  safeDecodeComponent,
  unwrapEnvelope,
  htmlToText,
  normalizeImageUrl,
  extractImageRefs,
  sniffImageMediaType,
  normalizeFiles,
  toCard,
  toActions,
  detectKind,
  extractList,
  parseActionForm,
  parseFormResponse,
  commentToHtml,
} from '../lib/zentao-client.mjs';
import { startFakeZentao, PNG_1X1, TXT_ATTACHMENT } from './helpers/fake-zentao.mjs';

const silent = { info() {}, warn() {}, error() {} };
const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');
const BROWSE = '/bug-browse-1-all-assigntome-0-id_desc-10-20.html';
const BROWSE_JSON = '/bug-browse-1-all-assigntome-0-id_desc-10-20.json';
const TASK_BROWSE = '/task-browse-1-all-assigntome-0-id_desc-10-20.html';

async function setup(t, options) {
  const srv = await startFakeZentao(options);
  t.after(() => srv.close());
  const client = createZentaoClient({ baseUrl: srv.baseUrl, logger: silent });
  return { srv, client, login: () => client.login('demo', 'secret') };
}

// ---------------------------------------------------------------------------
// 登录握手
// ---------------------------------------------------------------------------

test('login: GET 登录页 → refreshRandom → POST md5(md5(pw)+rand)，带齐 jQuery 风格头与长期 cookie', async (t) => {
  const { srv, client, login } = await setup(t);
  assert.equal(client.loggedIn(), false);
  await login();

  assert.equal(client.loggedIn(), true);
  assert.equal(srv.count('GET', '/user-login.html'), 1);
  assert.equal(srv.count('GET', '/user-refreshRandom.html'), 1);
  assert.equal(srv.state.loginCount, 1);
  assert.equal(srv.state.loginFailures, 0, '假禅道的请求头/密码校验必须全部通过');

  const post = srv.postsFor('/user-login.html')[0];
  assert.equal(post.headers['x-requested-with'], 'XMLHttpRequest');
  assert.equal(post.headers['content-type'], 'application/x-www-form-urlencoded; charset=UTF-8');
  assert.match(String(post.headers.accept), /application\/json/);
  assert.equal(post.headers.origin, srv.baseUrl);
  assert.equal(post.headers.referer, `${srv.baseUrl}/user-login.html`);
  assert.match(String(post.headers['user-agent']), /Mozilla\/5\.0/);
  assert.match(String(post.headers.cookie), /zentaosid=/);

  const form = new URLSearchParams(post.body);
  assert.equal(form.get('account'), 'demo');
  assert.equal(form.get('verifyRand'), srv.state.rand, '必须回传 refreshRandom 下发的值');
  assert.equal(form.get('password'), md5(md5('secret') + srv.state.rand));
  assert.equal(form.get('passwordStrength'), '1');
  assert.equal(form.get('keepLogin'), '1');
  assert.equal(form.get('referer'), '/');

  const cookies = client.exportCookies();
  assert.equal(cookies.za?.value, 'demo');
  assert.ok(cookies.zp?.value, '应保存免密 hash cookie zp');
  assert.match(client.cookieHeader(), /za=demo/);

  // cookie 可持久化/恢复：面板重启后靠它免密
  const restored = createZentaoClient({ baseUrl: srv.baseUrl, logger: silent });
  restored.restore(cookies);
  assert.equal(restored.loggedIn(), true);
  assert.match(restored.cookieHeader(), /zp=/);
});

test('login: refreshRandom 返回 JSON 信封 {verifyRand} 也能登录（Lead 新增的兼容形态）', async (t) => {
  const { srv, client, login } = await setup(t, { refreshRandom: 'json' });
  await login();
  assert.equal(client.loggedIn(), true);
  assert.equal(srv.count('GET', '/user-refreshRandom.html'), 1);
  assert.equal(srv.state.loginCount, 1);

  const form = new URLSearchParams(srv.postsFor('/user-login.html')[0].body);
  assert.equal(form.get('verifyRand'), srv.state.rand);
  assert.equal(form.get('password'), md5(md5('secret') + srv.state.rand));
});

test('login: 垃圾 verifyRand 响应 → 抛出「获取 verifyRand 失败」且不发登录 POST', async (t) => {
  const { srv, client, login } = await setup(t, { refreshRandom: 'garbage' });
  await assert.rejects(login, /获取 verifyRand 失败/);
  assert.equal(srv.state.loginCount, 0, '拿不到 verifyRand 就不该提交密码');
  assert.equal(client.exportCookies().za, undefined);
});

test('login: 密码错误回传禅道 message，不落 za/zp', async (t) => {
  const { srv, client } = await setup(t);
  await assert.rejects(client.login('demo', 'wrong'), /禅道登录失败：账号或密码错误/);
  assert.equal(srv.state.loginFailures, 1);
  assert.equal(client.exportCookies().za, undefined);
  assert.equal(client.loggedIn(), true, '已种 session cookie，只是未登录成功');
});

test('parseVerifyRand: 裸数字 / 字符串 / JSON 信封 / 垃圾', () => {
  assert.equal(parseVerifyRand(' 819927\n'), '819927');
  assert.equal(parseVerifyRand('{"verifyRand":123}'), '123');
  assert.equal(parseVerifyRand('{"rand":"456"}'), '456');
  assert.equal(parseVerifyRand('{"data":"789"}'), '789');
  assert.equal(parseVerifyRand('"321"'), '321');
  assert.equal(parseVerifyRand(''), '');
  assert.equal(parseVerifyRand('not-a-number'), '');
  assert.equal(parseVerifyRand('{"foo":1}'), '');
  assert.equal(parseVerifyRand('{broken'), '');
});

// ---------------------------------------------------------------------------
// 浏览页列表：.html → .json，双层信封
// ---------------------------------------------------------------------------

test('list: 浏览页 .html 正常渲染，.json 返回双层信封（bug 为 dict）并解出 pager/title', async (t) => {
  const { srv, client, login } = await setup(t);
  await login();

  const res = await fetch(`${srv.baseUrl}${BROWSE}`, {
    headers: { cookie: client.cookieHeader() },
    redirect: 'manual',
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>示例产品-Bug<\/title>/);
  assert.match(html, /#1/);

  const list = await client.fetchListByUrl(`${srv.baseUrl}${BROWSE}`);
  assert.equal(list.kind, 'bug');
  assert.equal(list.title, '示例产品-Bug');
  assert.deepEqual(list.pager, { total: 2, page: 1, perPage: 10 });
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0].id, 1);
  assert.equal(list.items[0].title, '登录页报错');
  assert.equal(list.items[0].assignedTo, '张三');
  assert.equal(typeof list.payload.bugs, 'object');
  assert.ok(!Array.isArray(list.payload.bugs), 'bug 列表的 bugs 是 dict 不是数组');
  assert.equal(srv.count('GET', BROWSE_JSON), 1, '应只请求 .json 兄弟地址');
});

test('list: task 浏览页的 tasks 是数组，也应解出条目与 pager', async (t) => {
  const { srv, client, login } = await setup(t);
  await login();

  const list = await client.fetchListByUrl(`${srv.baseUrl}${TASK_BROWSE}`);
  assert.equal(list.kind, 'task');
  assert.equal(list.title, '示例项目-任务');
  assert.ok(Array.isArray(list.payload.tasks));
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].name, '任务A');
  assert.deepEqual(list.pager, { total: 1, page: 1, perPage: 20 });
});

test('list: .json 返回 200 登录页 HTML 时归类为 SESSION_EXPIRED', async (t) => {
  const { srv, client, login } = await setup(t);
  await login();
  srv.expireSession();
  await assert.rejects(
    client.fetchListByUrl(`${srv.baseUrl}${BROWSE}`),
    (err) => err.code === 'SESSION_EXPIRED',
  );
});

// ---------------------------------------------------------------------------
// v1 详情
// ---------------------------------------------------------------------------

test('detail: 200 返回原始详情；401 归类 SESSION_EXPIRED；404 报不存在', async (t) => {
  const { srv, client, login } = await setup(t);
  await login();

  const d = await client.fetchDetail('bug', 1);
  assert.equal(d.id, 1);
  assert.equal(d.title, '登录页报错');
  assert.match(d.steps, /<img/);
  assert.equal(d.actions.length, 3);
  assert.equal(d.files.length, 3);

  srv.expireSession();
  await assert.rejects(client.fetchDetail('bug', 2), (err) => err.code === 'SESSION_EXPIRED');

  await client.login('demo', 'secret'); // 静默重登后恢复
  await assert.rejects(client.fetchDetail('bug', 999), /禅道 bug #999 不存在/);
});

// ---------------------------------------------------------------------------
// 备注：GET 取 uid → POST actioncomment + uid
// ---------------------------------------------------------------------------

test('comment: GET 取隐藏 uid 与编辑器字段名，POST 回写 <p> 包装的备注', async (t) => {
  const { srv, client, login } = await setup(t);
  await login();

  const out = await client.addComment('bug', 1, '已定位问题\n第二行');
  assert.deepEqual(out, { message: '保存成功' });
  assert.equal(srv.count('GET', '/action-comment-bug-1.html'), 1);

  const getReq = srv.requests.find((r) => r.method === 'GET' && r.path === '/action-comment-bug-1.html');
  assert.equal(getReq.headers['x-requested-with'], 'XMLHttpRequest');
  assert.equal(getReq.headers.referer, `${srv.baseUrl}/bug-view-1.html`);

  const post = srv.postsFor('/action-comment-bug-1.html')[0];
  assert.match(String(post.headers['content-type']), /^application\/x-www-form-urlencoded/);
  const form = new URLSearchParams(post.body);
  assert.equal(form.get('uid'), 'uid-comment-bug-1');
  assert.equal(form.get('actioncomment'), '<p>已定位问题<br />第二行</p>');

  // 调用方给 HTML 时不二次包装
  await client.addComment('bug', 1, '<p>原始 HTML</p>');
  const posts = srv.postsFor('/action-comment-bug-1.html');
  assert.equal(new URLSearchParams(posts[1].body).get('actioncomment'), '<p>原始 HTML</p>');

  // 空备注不请求网络
  await assert.rejects(client.addComment('bug', 1, '   '), /备注内容不能为空/);
  assert.equal(srv.postsFor('/action-comment-bug-1.html').length, 2);
});

test('comment: 表单页 302 → SESSION_EXPIRED', async (t) => {
  const { srv, client, login } = await setup(t);
  await login();
  srv.expireSession();
  await assert.rejects(client.addComment('bug', 1, 'x'), (err) => err.code === 'SESSION_EXPIRED');
});

// ---------------------------------------------------------------------------
// 状态流转：解析表单默认值 + 覆盖项合并
// ---------------------------------------------------------------------------

test('updateStatus: 解析 hidden input / picker defaultValue / 编辑器，POST 合并后的字段', async (t) => {
  const { srv, client, login } = await setup(t);
  await login();

  const out = await client.updateStatus('bug', 1, 'resolve', {
    comment: '已修复',
    resolution: 'fixed',
    resolvedBuild: 'trunk',
    assignedTo: 'demo',
  });
  assert.deepEqual(out, { message: '保存成功' });

  const getReq = srv.requests.find((r) => r.method === 'GET' && r.path === '/bug-resolve-1.html');
  assert.equal(getReq.headers.referer, `${srv.baseUrl}/bug-view-1.html`);

  const form = new URLSearchParams(srv.postsFor('/bug-resolve-1.html')[0].body);
  assert.equal(form.get('uid'), 'uid-bug-resolve-1');
  assert.equal(form.get('id'), '1');
  assert.equal(form.get('status'), 'resolved');
  assert.equal(form.get('resolvedDate'), '2026-11-09', 'hidden input 默认值应保留');
  assert.equal(form.get('resolvedBuild'), 'trunk', 'picker defaultValue 应保留');
  assert.equal(form.get('assignedTo'), 'demo', '显式覆盖项优先于 picker 默认值');
  assert.equal(form.get('resolution'), 'fixed');
  assert.equal(form.get('comment'), '<p>已修复</p>');
});

test('updateStatus: resolve 未指定 resolution 时补默认 fixed；task finish 走自己的表单', async (t) => {
  const { srv, client, login } = await setup(t);
  await login();

  await client.updateStatus('bug', 1, 'resolve', {});
  const resolveForm = new URLSearchParams(srv.postsFor('/bug-resolve-1.html')[0].body);
  assert.equal(resolveForm.get('resolution'), 'fixed');
  assert.equal(resolveForm.get('resolvedBuild'), 'trunk');
  assert.equal(resolveForm.get('assignedTo'), 'zhangsan', '未覆盖时用 picker 默认值');
  assert.equal(resolveForm.get('comment'), null, '未给 comment 时不凭空提交编辑器字段');

  await client.updateStatus('task', 1, 'finish', { comment: '已完成' });
  const taskForm = new URLSearchParams(srv.postsFor('/task-finish-1.html')[0].body);
  assert.equal(taskForm.get('uid'), 'uid-task-finish-1');
  assert.equal(taskForm.get('consumed'), '4', 'finish 表单的 picker 默认值');
  assert.equal(taskForm.get('comment'), '<p>已完成</p>');
});

test('updateStatus: 不支持的动作立即报错；表单 302 → SESSION_EXPIRED', async (t) => {
  const { srv, client, login } = await setup(t);
  await login();

  await assert.rejects(client.updateStatus('bug', 1, 'start', {}), /不支持的 bug 操作：start/);
  assert.equal(srv.count('GET', '/bug-start-1.html'), 0);

  srv.expireSession();
  await assert.rejects(client.updateStatus('bug', 1, 'close', {}), (err) => err.code === 'SESSION_EXPIRED');
});

// ---------------------------------------------------------------------------
// 文件下载
// ---------------------------------------------------------------------------

test('file: /file-read-*.png 返回真实 PNG 字节，附件字节与 200 HTML 提示页都可拿原始形态', async (t) => {
  const { srv, client, login } = await setup(t);
  await login();

  const png = await client.fetchFile({ path: '/file-read-25509.png' });
  assert.equal(png.status, 200);
  assert.match(png.contentType, /^image\/png/);
  assert.deepEqual(png.bytes, PNG_1X1);
  assert.equal(sniffImageMediaType(png.bytes), 'image/png');

  const txt = await client.fetchFile({ path: '/file-read-25510.txt' });
  assert.equal(txt.bytes.toString('utf8'), TXT_ATTACHMENT.toString('utf8'));
  assert.equal(sniffImageMediaType(txt.bytes), null);

  const page = await client.fetchFile({ path: '/file-read-99999.png' });
  assert.equal(page.status, 200);
  assert.match(page.contentType, /text\/html/);
  assert.match(page.bytes.toString('utf8'), /没有权限/);
});

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('cookie jar: 吸收 Set-Cookie、过期/删除语义与 toJSON', () => {
  const jar = createCookieJar({
    za: 'a',
    zp: { value: 'b', expires: Date.now() + 60_000 },
    stale: { value: 'x', expires: Date.now() - 1_000 },
  });
  assert.equal(jar.header(), 'za=a; zp=b');
  assert.equal(jar.has('stale'), false);

  jar.absorb(['zentaosid=s1; path=/; Max-Age=60', 'gone=deleted; path=/']);
  assert.equal(jar.has('zentaosid'), true);
  assert.equal(jar.has('gone'), false);

  jar.absorb(['zentaosid=deleted']);
  assert.equal(jar.has('zentaosid'), false);

  const jar2 = createCookieJar();
  jar2.absorb(['a=1; Max-Age=0', 'b=2; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'c=3']);
  assert.equal(jar2.has('a'), false);
  assert.equal(jar2.has('b'), false);
  assert.equal(jar2.get('c'), '3');
  assert.deepEqual(Object.keys(jar2.toJSON()), ['c']);
});

test('unwrapEnvelope / extractList: 双层信封与 dict/数组两种列表形态', () => {
  const inner = { bugs: { 1: { id: 1 }, 2: { id: 2 } } };
  const outer = JSON.stringify({ status: 'success', data: JSON.stringify(inner) });
  assert.deepEqual(unwrapEnvelope(outer), inner);
  assert.deepEqual(unwrapEnvelope('{"a":1}'), { a: 1 });

  assert.equal(extractList('bug', inner).length, 2);
  assert.equal(extractList('task', { tasks: [{ id: 1 }, null, 'x'] }).length, 1);
  assert.equal(extractList('story', { stories: [] }).length, 0);
  assert.equal(extractList('bug', {}).length, 0);
});

test('detectKind: 浏览页路径 → kind，猜不出回退 bug', () => {
  assert.equal(detectKind('http://h/zentao/bug-browse-1-all-assigntome-0-id_desc-10-20.html'), 'bug');
  assert.equal(detectKind('http://h/zentao/task-browse-1-all.html'), 'task');
  assert.equal(detectKind('http://h/zentao/story-browse-1-all.html'), 'story');
  assert.equal(detectKind('http://h/zentao/my-work-bug.html'), 'bug');
  assert.equal(detectKind('http://h/zentao/unknown.html'), 'bug');
  assert.equal(detectKind('http://h/zentao/unknown.html', 'task'), 'task');
});

test('toCard: 统一卡片字段（personName 真名、数字转换、绝对图片地址、详情 URL）', () => {
  const base = 'http://host/zentao/';
  const card = toCard('bug', {
    id: '7',
    title: '标题',
    status: 'active',
    pri: '3',
    severity: ' 2 ',
    assignedTo: { realname: '张三', account: 'zhangsan' },
    openedBy: { account: 'lisi' },
    openedDate: '2026-11-09 21:26:46',
    moduleTitle: { id: 1, name: '模块' },
    productName: { id: 2, name: '产品' },
    deadline: '2026-11-20',
    steps: '<p>描述</p><p><img src="{1.png}" /></p>',
  }, base);
  assert.equal(card.kind, 'bug');
  assert.equal(card.id, 7);
  assert.equal(card.pri, 3);
  assert.equal(card.severity, 2);
  assert.equal(card.assignedTo, '张三');
  assert.equal(card.openedBy, 'lisi');
  assert.equal(card.moduleTitle, '模块');
  assert.equal(card.productName, '产品');
  assert.equal(card.deadline, '2026-11-20');
  assert.equal(card.url, 'http://host/zentao/bug-view-7.html');
  assert.equal(card.descBrief, '描述\n[图片：1.png]');
  assert.deepEqual(card.images, [{ url: 'http://host/zentao/file-read-1.png', name: '1.png' }]);

  const task = toCard('task', { id: 1, name: '任务', projectName: '项目', severity: 5 }, 'http://host');
  assert.equal(task.kind, 'task');
  assert.equal(task.title, '任务');
  assert.equal(task.severity, null, '任务没有严重程度');
  assert.equal(task.productName, '项目');
  assert.equal(task.url, 'http://host/task-view-1.html');
});

test('toActions: 过滤空记录、HTML 转纯文本、备注图归一并去重', () => {
  const acts = toActions([
    {
      actor: '张三',
      action: 'commented',
      date: '2026-11-09 21:27:03',
      desc: '<p>说明</p>',
      comment: '<p>备注</p><p><img src="{9.png}" /></p>',
    },
    { actor: '系统', action: 'edited', date: '', desc: '', comment: '' },
    null,
  ], 'http://host/zentao');
  assert.equal(acts.length, 1);
  assert.equal(acts[0].actor, '张三');
  assert.equal(acts[0].desc, '说明');
  assert.equal(acts[0].comment, '备注\n[图片：9.png]');
  assert.deepEqual(acts[0].images, [{ url: 'http://host/zentao/file-read-9.png', name: '9.png' }]);
});

test('htmlToText / commentToHtml / normalizeImageUrl / extractImageRefs', () => {
  assert.equal(htmlToText('<p>第一行</p><br><p><img src="{25509.png}" /></p>'), '第一行\n\n[图片：25509.png]');
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText(null), '');

  assert.equal(commentToHtml('a\nb'), '<p>a<br />b</p>');
  assert.equal(commentToHtml('a\n\nb'), '<p>a</p><p>b</p>');
  assert.equal(commentToHtml('<p>已经是 HTML</p>'), '<p>已经是 HTML</p>');
  assert.equal(commentToHtml(''), '');
  assert.equal(commentToHtml('a & b < c'), '<p>a &amp; b &lt; c</p>');

  const base = 'http://host/zentao';
  assert.equal(normalizeImageUrl('{25509.png}', base), 'http://host/zentao/file-read-25509.png');
  assert.equal(normalizeImageUrl('/data/upload/a.png', base), 'http://host/zentao/data/upload/a.png');
  assert.equal(normalizeImageUrl('http://other/a.png', base), 'http://other/a.png');
  assert.equal(normalizeImageUrl('data:image/png;base64,xx', base), null);
  assert.equal(normalizeImageUrl('mailto:x@y', base), null);
  assert.equal(normalizeImageUrl('', base), null);
  assert.equal(normalizeImageUrl('//cdn.example.com/a.png', 'https://host/zentao'), 'https://cdn.example.com/a.png');

  const refs = extractImageRefs(
    '<img src="{1.png}"><img src="{1.png}"><img src="/data/upload/2.png"><img src="data:image/png;base64,xx">',
    base,
  );
  assert.deepEqual(refs, [
    { url: 'http://host/zentao/file-read-1.png', name: '1.png' },
    { url: 'http://host/zentao/data/upload/2.png', name: '2.png' },
  ]);

  assert.equal(safeDecodeComponent('%E4%B8%AD%E6%96%87'), '中文');
  assert.equal(safeDecodeComponent('%E4%B8'), '%E4%B8', '残缺百分号编码不该抛 URIError');
  assert.equal(safeDecodeComponent(null), '');

  // 回归：详情/列表里出现残缺百分号编码的图片名时，不能整条详情崩掉（Lead 的 safeDecodeComponent）
  const broken = extractImageRefs('<img src="%E4%BD.png">', base);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].url, 'http://host/zentao/%E4%BD.png');
  assert.equal(broken[0].name, '%E4%BD.png');
  const brokenFiles = normalizeFiles([{ id: 7, title: '', pathname: '/file-read-%E4%BD.png' }], base);
  assert.equal(brokenFiles.length, 1);
  assert.equal(brokenFiles[0].name, 'file-read-%E4%BD.png', '残缺编码原样保留，不抛 URIError');
});

test('normalizeFiles: 兼容 downloadURL/url/fileID/extension 等字段，无地址无 id 的条目丢弃', () => {
  const files = normalizeFiles([
    { fileID: 3001, filename: '报表.xlsx', extension: '.xlsx', size: '2048' },
    { id: 25511, title: '截图.png', downloadURL: 'http://host/zentao/file-read-25511.png' },
    { id: 42, name: '无路径.txt' },
    { title: '空' },
    null,
    'x',
  ], 'http://host/zentao/');
  assert.equal(files.length, 3);
  assert.deepEqual(files[0], {
    id: 3001,
    name: '报表.xlsx',
    ext: 'xlsx',
    size: 2048,
    url: 'http://host/zentao/file-read-3001.xlsx',
  });
  assert.deepEqual(files[1], {
    id: 25511,
    name: '截图.png',
    ext: '',
    size: null,
    url: 'http://host/zentao/file-read-25511.png',
  });
  assert.equal(files[2].url, 'http://host/zentao/file-read-42');
});

test('parseActionForm: hidden/text/textarea/select + picker defaultValue + 编辑器 + uid', () => {
  const html = `<!doctype html><html><body>
<form id="f" action="/bug-resolve-5.html" method="post">
  <input type="hidden" name="uid" value="uid-5" />
  <input type="hidden" name="id" value="5" />
  <input type="text" name="resolvedDate" value="2026-11-09" />
  <input type="checkbox" name="skip" value="1" checked />
  <input type="submit" name="submit" value="保存" />
  <textarea name="note">第一行
第二行</textarea>
  <select name="openedBuild"><option value="1">一</option><option value="2" selected>二</option></select>
  <div zui-create-picker="{&quot;name&quot;:&quot;resolvedBuild&quot;,&quot;defaultValue&quot;:&quot;trunk&quot;}"></div>
  <div zui-create-picker="{&quot;name&quot;:&quot;pri&quot;,&quot;defaultValue&quot;:3}"></div>
  <zen-editor name="comment"></zen-editor>
</form></body></html>`;
  const form = parseActionForm(html, '/fallback.html');
  assert.equal(form.url, '/bug-resolve-5.html');
  assert.equal(form.uid, 'uid-5');
  assert.deepEqual(form.editors, ['comment']);
  assert.equal(form.pickers.length, 2);
  assert.deepEqual(form.fields, {
    id: '5',
    resolvedDate: '2026-11-09',
    note: '第一行\n第二行',
    openedBuild: '2',
    resolvedBuild: 'trunk',
    pri: '3',
  });
  assert.equal(form.fields.skip, undefined, 'checkbox/submit 不参与表单回填');
});

test('parseActionForm: <option selected> 读入默认值（selected="selected" / selected 前置 / 无选中不写入）', () => {
  // 回归：旧正则让贪婪 [^>]* 吃掉 selected，<select> 默认值（如关闭原因 closedReason）永远丢失，
  // 导致 task/story close 这类必填下拉的表单被提交成缺字段。
  const selectedExplicit = parseActionForm(
    '<form><select name="closedReason"><option value="done">已完成</option><option value="fixed" selected="selected">已修复</option></select></form>',
    '/x',
  );
  assert.equal(selectedExplicit.fields.closedReason, 'fixed', 'selected="selected" 形态应识别');

  const selectedFirst = parseActionForm(
    '<form><select name="openedBuild"><option selected value="2">二</option><option value="3">三</option></select></form>',
    '/x',
  );
  assert.equal(selectedFirst.fields.openedBuild, '2', 'selected 出现在 value 之前也应识别');

  const noneSelected = parseActionForm(
    '<form><select name="closedReason"><option value="done">已完成</option><option value="fixed">已修复</option></select></form>',
    '/x',
  );
  assert.equal(noneSelected.fields.closedReason, undefined, '没有 selected 时不能凭空取最后一个选项');

  const singleQuoted = parseActionForm(
    "<form><select name=\"resolution\"><option selected value='fixed'>已修复</option></select></form>",
    '/x',
  );
  assert.equal(singleQuoted.fields.resolution, 'fixed', '单引号 value 也应支持');

  const bareValue = parseActionForm(
    '<form><select name="status"><option selected value=resolved>已解决</option></select></form>',
    '/x',
  );
  assert.equal(bareValue.fields.status, 'resolved', '裸 value 也应支持');
});

test('parseFormResponse: JSON success / fail(字段级 message) / 登录超时 / HTML 回执', () => {
  assert.deepEqual(parseFormResponse('{"result":"success","message":"保存成功"}'), { ok: true, message: '保存成功' });
  assert.deepEqual(parseFormResponse('{"result":"success"}'), { ok: true, message: '保存成功' });
  assert.deepEqual(
    parseFormResponse('{"result":"fail","message":{"openedBuild":["『影响版本』不能为空。"]}}'),
    { ok: false, message: '『影响版本』不能为空。', sessionExpired: false },
  );
  assert.deepEqual(
    parseFormResponse('{"result":false,"message":"登录已超时，请重新登录"}'),
    { ok: false, message: '登录已超时，请重新登录', sessionExpired: true },
  );
  assert.deepEqual(parseFormResponse('{"error":"no permission"}'), { ok: false, message: 'no permission' });
  assert.deepEqual(parseFormResponse('<html><form action="/user-login.html"></form></html>'), {
    ok: false,
    message: '禅道会话失效，请重新登录',
    sessionExpired: true,
  });
  assert.deepEqual(parseFormResponse('<script>parent.location.reload()</script>'), { ok: true, message: '保存成功' });
  const unknown = parseFormResponse('random text');
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /禅道未确认保存（响应 random text）/);
});

test('normalizeBrowseUrl: 同源/子路径/协议校验与 .html→.json 转换', () => {
  const client = createZentaoClient({ baseUrl: 'http://zentao.example.com/zentao', logger: silent });

  assert.deepEqual(
    client.normalizeBrowseUrl('http://zentao.example.com/zentao/bug-browse-1-all-assigntome-0-id_desc-10-20.html?foo=1'),
    { path: '/bug-browse-1-all-assigntome-0-id_desc-10-20.json?foo=1', kind: 'bug' },
  );
  assert.deepEqual(
    client.normalizeBrowseUrl('http://zentao.example.com/zentao/my-work-bug.json'),
    { path: '/my-work-bug.json', kind: 'bug' },
  );
  assert.equal(
    client.normalizeBrowseUrl('http://zentao.example.com/zentao/story-browse-1-all.html').kind,
    'story',
  );

  assert.throws(() => client.normalizeBrowseUrl(''), /请填写禅道链接/);
  assert.throws(() => client.normalizeBrowseUrl('not a url'), /链接格式不正确/);
  assert.throws(() => client.normalizeBrowseUrl('ftp://zentao.example.com/zentao/bug-browse-1.html'), /只支持 http\(s\) 链接/);
  assert.throws(
    () => client.normalizeBrowseUrl('http://zentao.example.com:8080/zentao/bug-browse-1.html'),
    /链接与已登录实例不同源/,
  );
  assert.throws(
    () => client.normalizeBrowseUrl('http://zentao.example.com/other/bug-browse-1.html'),
    /链接路径不在当前禅道实例下/,
  );
  assert.equal(client.baseUrl, 'http://zentao.example.com/zentao', 'baseUrl 去掉尾部斜杠');
});
