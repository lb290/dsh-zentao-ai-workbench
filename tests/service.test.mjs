// tests/service.test.mjs
//
// lib/service.mjs 聚合层：用真实 createZentaoClient 打本地假禅道（协议全链路），
// 个别用例注入假 createClient 验证「探测失败不阻断业务」这类分支。
// DSH_HOME 每个用例独立临时目录，不碰真实 ~/.dsh；缓存/落盘/重登都断言可观察行为。

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createZentaoWorkbenchService } from '../lib/service.mjs';
import { createZentaoClient } from '../lib/zentao-client.mjs';
import {
  readConfig,
  writeConfig,
  configPath,
  accountId,
  encodeSecret,
  decodeSecret,
} from '../lib/store.mjs';
import { startFakeZentao, PNG_1X1, TXT_ATTACHMENT } from './helpers/fake-zentao.mjs';

const silent = { info() {}, warn() {}, error() {} };
const ORIGINAL_HOME = process.env.DSH_HOME;
const BROWSE = '/bug-browse-1-all-assigntome-0-id_desc-10-20.html';
const BROWSE_JSON = '/bug-browse-1-all-assigntome-0-id_desc-10-20.json';

function freshHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ztaw-svc-'));
  process.env.DSH_HOME = dir;
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (ORIGINAL_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = ORIGINAL_HOME;
  });
  return dir;
}

async function makeService(t, { serverOptions, cacheTtlMs, configure = true } = {}) {
  const home = freshHome(t);
  const srv = await startFakeZentao(serverOptions);
  t.after(() => srv.close());
  const service = createZentaoWorkbenchService({ logger: silent, createClient: createZentaoClient, cacheTtlMs });
  const boot = service.init();
  if (configure) {
    service.configure({ baseUrl: `${srv.baseUrl}/`, account: 'demo', password: 'secret', alias: '演示' });
  }
  return { home, srv, service, boot };
}

function makeServiceOnly(t, { createClient }) {
  const home = freshHome(t);
  const service = createZentaoWorkbenchService({ logger: silent, createClient });
  const boot = service.init();
  return { home, service, boot };
}

async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = ORIGINAL_HOME;
});

// ---------------------------------------------------------------------------
// init / configure / login
// ---------------------------------------------------------------------------

test('init: 无配置 → 未配置、空账号列表，业务调用报 NEED_LOGIN', async (t) => {
  const { service, boot } = makeServiceOnly(t, { createClient: createZentaoClient });
  assert.deepEqual(boot, { configured: false, count: 0, imported: false });
  const st = service.status();
  assert.equal(st.configured, false);
  assert.equal(st.baseUrl, '');
  assert.equal(st.account, '');
  assert.equal(st.loggedIn, false);
  assert.deepEqual(st.accounts, []);
  await assert.rejects(
    service.listFromUrl({ url: 'http://zentao.local/zentao/bug-browse-1.html' }),
    (err) => err.code === 'NEED_LOGIN' && /尚未配置禅道账号/.test(err.message),
  );
});

test('init: 从本插件配置恢复账号（cookie 直接可用）与 lastUrl', async (t) => {
  freshHome(t);
  const base = 'http://zentao.local/zentao';
  const id = accountId(base, 'demo');
  const lastUrl = `${base}/bug-browse-1-all-assigntome-0-id_desc-10-20.html`;
  assert.equal(await writeConfig({
    accounts: [{
      id,
      baseUrl: base,
      account: 'demo',
      alias: '演示',
      password: encodeSecret('secret'),
      cookies: { za: { value: 'demo' }, zp: { value: 'hash' } },
      savedAt: 7,
    }],
    activeId: id,
    lastUrl,
  }), true);

  const service = createZentaoWorkbenchService({ logger: silent, createClient: createZentaoClient });
  const boot = service.init();
  assert.equal(boot.configured, true);
  assert.equal(boot.imported, false);
  assert.equal(boot.count, 1);
  assert.equal(boot.account, 'demo');
  assert.equal(boot.baseUrl, base);

  const st = service.status();
  assert.equal(st.configured, true);
  assert.equal(st.account, 'demo');
  assert.equal(st.alias, '演示');
  assert.equal(st.loggedIn, true, '恢复的 za/zp cookie 应视为已登录');
  assert.equal(st.lastUrl, lastUrl);
  assert.deepEqual(st.accounts, [{ id, baseUrl: base, account: 'demo', alias: '演示', loggedIn: true }]);
});

test('init: 本插件无配置时从旧 dsh-zentao-panel 导入账号+cookie+lastUrl，并落盘新配置', async (t) => {
  const home = freshHome(t);
  const legacyPath = join(home, 'zentao-panel', 'config.json');
  mkdirSync(dirname(legacyPath), { recursive: true });
  const lastUrl = 'http://legacy.local/zentao/bug-browse-9-all.html';
  const { writeFileSync } = await import('node:fs');
  writeFileSync(legacyPath, JSON.stringify({
    accounts: [{
      baseUrl: 'http://legacy.local/zentao/',
      account: 'legacyuser',
      alias: '旧面板',
      password: encodeSecret('legacy-pass'),
      cookies: { za: { value: 'legacyuser' }, zp: { value: 'hash' } },
    }],
    lastUrl,
  }), 'utf8');

  const service = createZentaoWorkbenchService({ logger: silent, createClient: createZentaoClient });
  const boot = service.init();
  assert.equal(boot.imported, true, '应标记为从旧面板导入');
  assert.equal(boot.configured, true);
  assert.equal(boot.count, 1);
  assert.equal(boot.account, 'legacyuser');
  assert.equal(service.status().lastUrl, lastUrl);

  const cfg = await waitFor(() => {
    const c = readConfig();
    return c.accounts.length ? c : null;
  });
  assert.equal(cfg.accounts[0].baseUrl, 'http://legacy.local/zentao', '导入时 baseUrl 去尾斜杠');
  assert.equal(cfg.accounts[0].account, 'legacyuser');
  assert.equal(cfg.activeId, cfg.accounts[0].id);
  assert.equal(cfg.lastUrl, lastUrl);
});

test('configure: 地址去尾斜杠、账号 upsert、非法参数报错', async (t) => {
  const { srv, service } = await makeService(t);
  let st = service.status();
  assert.equal(st.configured, true);
  assert.equal(st.baseUrl, srv.baseUrl, 'configure 传了尾斜杠，status 应给出归一化地址');
  assert.equal(st.account, 'demo');
  assert.equal(st.alias, '演示');
  assert.equal(st.loggedIn, false, 'configure 只保存凭据，不主动登录');
  assert.equal(st.accounts.length, 1);

  service.configure({ baseUrl: srv.baseUrl, account: 'demo2', password: 'pw2', alias: '二号' });
  st = service.status();
  assert.equal(st.accounts.length, 2);
  assert.equal(st.account, 'demo2');
  assert.equal(st.alias, '二号');

  // 同地址同账号 = 更新凭据，不新增账号
  service.configure({ baseUrl: `${srv.baseUrl}/`, account: 'demo2', password: 'pw2b', alias: '二号改' });
  st = service.status();
  assert.equal(st.accounts.length, 2);
  assert.equal(st.alias, '二号改');

  assert.throws(
    () => service.configure({ baseUrl: 'zentao.local', account: 'a', password: 'b' }),
    /禅道地址必须/,
  );
  assert.throws(
    () => service.configure({ baseUrl: srv.baseUrl, account: '', password: 'b' }),
    /账号和密码不能为空/,
  );
  assert.throws(
    () => service.configure({ baseUrl: srv.baseUrl, account: 'a', password: '' }),
    /账号和密码不能为空/,
  );
});

test('login: 事务式登录——成功才切换并落盘；密码错回滚，不覆盖可用账号', async (t) => {
  const { srv, service } = await makeService(t, { configure: false });
  await service.login({ baseUrl: `${srv.baseUrl}/`, account: 'demo', password: 'secret', alias: '演示' });

  let st = service.status();
  assert.equal(st.configured, true);
  assert.equal(st.baseUrl, srv.baseUrl);
  assert.equal(st.account, 'demo');
  assert.equal(st.alias, '演示');
  assert.equal(st.loggedIn, true, '真登成功后才算登录');
  assert.equal(srv.state.loginCount, 1);

  const saved = await waitFor(() => {
    const c = readConfig();
    return c.accounts.length ? c : null;
  });
  assert.equal(decodeSecret(saved.accounts[0].password), 'secret');
  assert.equal(saved.activeId, saved.accounts[0].id);

  // 同账号密码打错：必须回滚，原账号仍可用
  await assert.rejects(
    service.login({ baseUrl: srv.baseUrl, account: 'demo', password: 'wrong' }),
    /账号或密码错误/,
  );
  st = service.status();
  assert.equal(st.configured, true, '失败登录不能把已配置账号弄丢');
  assert.equal(st.account, 'demo');
  assert.equal(st.loggedIn, true);
  assert.equal(decodeSecret(readConfig().accounts[0].password), 'secret', '失败凭据不能落盘');

  // 新账号登录失败：不新增账号、不落盘
  await assert.rejects(
    service.login({ baseUrl: srv.baseUrl, account: 'ghost', password: 'wrong' }),
    /账号或密码错误/,
  );
  assert.equal(service.status().accounts.length, 1, '失败的新账号不应留在列表里');
  assert.equal(readConfig().accounts.length, 1);

  // 参数校验与 configure 一致
  await assert.rejects(service.login({ baseUrl: 'nope', account: 'a', password: 'b' }), /禅道地址必须/);
  await assert.rejects(service.login({ baseUrl: srv.baseUrl, account: '', password: 'b' }), /不能为空/);
});

// ---------------------------------------------------------------------------
// 列表：解析 + 缓存
// ---------------------------------------------------------------------------

test('listFromUrl: 浏览链接 → 统一 Card；缓存命中 cached=true，refresh 绕过缓存', async (t) => {
  const { srv, service } = await makeService(t);
  const url = `${srv.baseUrl}${BROWSE}`;

  const r1 = await service.listFromUrl({ url });
  assert.equal(r1.cached, false);
  assert.equal(r1.kind, 'bug');
  assert.equal(r1.title, '示例产品-Bug');
  assert.deepEqual(r1.pager, { total: 2, page: 1, perPage: 10 });
  assert.equal(r1.items.length, 2);

  const card = r1.items[0];
  assert.equal(card.kind, 'bug');
  assert.equal(card.id, 1);
  assert.equal(card.title, '登录页报错');
  assert.equal(card.status, 'active');
  assert.equal(card.pri, 3);
  assert.equal(card.severity, 2);
  assert.equal(card.assignedTo, '张三');
  assert.equal(card.openedBy, '李四');
  assert.equal(card.openedDate, '2026-11-09 21:26:46');
  assert.equal(card.moduleTitle, '登录模块');
  assert.equal(card.productName, '示例产品');
  assert.equal(card.url, `${srv.baseUrl}/bug-view-1.html`);
  assert.equal(card.descBrief, '打开登录页后报错\n[图片：25509.png]');
  assert.deepEqual(card.images, [{ url: `${srv.baseUrl}/file-read-25509.png`, name: '25509.png' }]);
  assert.equal(r1.items[1].status, 'resolved');

  assert.equal(service.status().loggedIn, true, '首次读列表会静默登录');
  assert.equal(service.status().lastUrl, url, '应记住上次链接');
  assert.equal(srv.count('GET', BROWSE_JSON), 1);

  const r2 = await service.listFromUrl({ url });
  assert.equal(r2.cached, true);
  assert.equal(srv.count('GET', BROWSE_JSON), 1, '缓存命中不应再请求禅道');

  const r3 = await service.listFromUrl({ url, refresh: true });
  assert.equal(r3.cached, false);
  assert.equal(srv.count('GET', BROWSE_JSON), 2, 'refresh 必须绕过缓存');

  assert.deepEqual(service.actionsFor('bug'), ['comment', 'resolve', 'close', 'activate']);
  assert.ok(!service.actionsFor('bug').includes('start'), 'bug 不支持 start');
});

test('listFromUrl: cacheTtlMs 生效，TTL 过后重新拉取', async (t) => {
  const { srv, service } = await makeService(t, { cacheTtlMs: 30 });
  const url = `${srv.baseUrl}${BROWSE}`;
  assert.equal((await service.listFromUrl({ url })).cached, false);
  assert.equal((await service.listFromUrl({ url })).cached, true);
  await sleep(60);
  assert.equal((await service.listFromUrl({ url })).cached, false);
  assert.equal(srv.count('GET', BROWSE_JSON), 2);
});

test('listFromUrl: 空链接报错；会话失效（.json 返回登录页）自动重登一次', async (t) => {
  const { srv, service } = await makeService(t);
  await assert.rejects(service.listFromUrl({ url: '   ' }), /请提供禅道浏览链接/);

  const url = `${srv.baseUrl}${BROWSE}`;
  await service.listFromUrl({ url }); // login #1
  srv.expireSession();

  const r = await service.listFromUrl({ url, refresh: true });
  assert.equal(r.cached, false);
  assert.equal(r.items.length, 2);
  assert.equal(srv.state.loginCount, 2, '会话失效后应静默重登一次');
  // 第一次请求拿到登录页（1 次）+ 重试成功（1 次），加最初那次 = 3
  assert.equal(srv.count('GET', BROWSE_JSON), 3, '第一次拿到登录页，重登后重试成功');
});

// ---------------------------------------------------------------------------
// 详情：映射 + 缓存 + 重登
// ---------------------------------------------------------------------------

test('detail: v1 详情映射 desc/steps/actions/commentImages/files/images，二次命中缓存', async (t) => {
  const { srv, service } = await makeService(t);
  const d1 = await service.detail({ kind: 'bug', id: 1 });
  assert.equal(d1.cached, false);
  assert.equal(d1.kind, 'bug');
  assert.equal(d1.id, 1);
  assert.equal(d1.title, '登录页报错');
  assert.equal(d1.status, 'active');
  assert.equal(d1.pri, 3);
  assert.equal(d1.severity, 2);
  assert.equal(d1.assignedTo, '张三');
  assert.equal(d1.openedBy, '李四');
  assert.equal(d1.moduleTitle, '登录模块');
  assert.equal(d1.productName, '示例产品');
  assert.equal(d1.url, `${srv.baseUrl}/bug-view-1.html`);
  assert.equal(d1.desc, '打开登录页后报错\n[图片：25509.png]');
  assert.equal(d1.steps, d1.desc);
  assert.equal(d1.actions.length, 2, '没有 desc/comment 的 action 应被过滤');
  assert.equal(d1.actions[0].actor, '李四');
  assert.equal(d1.actions[0].desc, '由 李四 创建。');
  assert.equal(d1.actions[1].comment, '已定位问题\n[图片：25510.png]');
  assert.deepEqual(d1.images, [{ url: `${srv.baseUrl}/file-read-25509.png`, name: '25509.png' }]);
  assert.deepEqual(d1.commentImages, [{ url: `${srv.baseUrl}/file-read-25510.png`, name: '25510.png' }]);
  assert.deepEqual(d1.files, [{
    id: 3001,
    name: '报表.xlsx',
    ext: 'xlsx',
    size: 2048,
    url: `${srv.baseUrl}/file-read-3001.xlsx`,
  }, {
    id: 25511,
    name: '截图.png',
    ext: 'png',
    size: 512,
    url: `${srv.baseUrl}/file-read-25511.png`,
  }]);
  assert.equal(srv.count('GET', '/api.php/v1/bugs/1'), 1);

  const d2 = await service.detail({ kind: 'bug', id: 1 });
  assert.equal(d2.cached, true);
  assert.equal(srv.count('GET', '/api.php/v1/bugs/1'), 1, '详情缓存 10 分钟内不重复请求');
});

test('detail: 401 → 静默重登后自动重试成功', async (t) => {
  const { srv, service } = await makeService(t);
  await service.listFromUrl({ url: `${srv.baseUrl}${BROWSE}` }); // login #1
  srv.expireSession();

  const d = await service.detail({ kind: 'bug', id: 1 });
  assert.equal(d.title, '登录页报错');
  assert.equal(d.cached, false);
  assert.equal(srv.state.loginCount, 2, '401 后应静默重登');
  assert.equal(srv.count('GET', '/api.php/v1/bugs/1'), 2, '第一次 401，重登后重试成功');
});

test('ensureLogin: 探测因非会话原因失败 → 告警但按已登录继续（不阻断业务请求）', async (t) => {
  let loginCalls = 0;
  const fakeClient = {
    loggedIn: () => true,
    restore() {},
    exportCookies() { return {}; },
    async fetchListByUrl(url) {
      if (url.endsWith('/my-work-bug.json')) throw new Error('页面不存在（探测 URL 失效）');
      return { kind: 'bug', title: 'T', pager: { total: 1, page: 1, perPage: 10 }, items: [{ id: 9, title: '九号' }] };
    },
    async login() { loginCalls += 1; throw new Error('不应重登'); },
  };
  const { service } = makeServiceOnly(t, { createClient: () => fakeClient });
  service.configure({ baseUrl: 'http://fake.local/zentao', account: 'demo', password: 'secret' });

  const r = await service.listFromUrl({ url: 'http://fake.local/zentao/bug-browse-1.html' });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].id, 9);
  assert.equal(r.items[0].kind, 'bug');
  assert.equal(loginCalls, 0, '探测失败不是会话失效，不应重登');
});

test('ensureLogin: 会话失效且本地无密码 → NEED_LOGIN（提示重新登录）', async (t) => {
  freshHome(t);
  const srv = await startFakeZentao();
  t.after(() => srv.close());
  const id = accountId(srv.baseUrl, 'demo');
  await writeConfig({
    accounts: [{
      id,
      baseUrl: srv.baseUrl,
      account: 'demo',
      alias: '',
      password: '',
      cookies: { za: { value: 'demo' }, zp: { value: 'hash' } },
      savedAt: 1,
    }],
    activeId: id,
    lastUrl: `${srv.baseUrl}${BROWSE}`,
  });
  const service = createZentaoWorkbenchService({ logger: silent, createClient: createZentaoClient });
  service.init();
  assert.equal(service.status().loggedIn, true);
  srv.expireSession();
  await assert.rejects(
    service.listFromUrl({ url: `${srv.baseUrl}${BROWSE}` }),
    (err) => err.code === 'NEED_LOGIN' && /本地无凭据/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// 写回：白名单 / 批量 / 缓存失效
// ---------------------------------------------------------------------------

test('writeOne: 按 kind 的 action 白名单（bug resolve 通过，bug start 拒绝），字段透传', async (t) => {
  const { srv, service } = await makeService(t);
  const ok = await service.writeOne({
    kind: 'bug',
    id: 1,
    action: 'resolve',
    comment: '已修复',
    resolution: 'fixed',
    resolvedBuild: 'trunk',
    assignedTo: 'demo',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.message, '保存成功');
  assert.deepEqual({ kind: ok.kind, id: ok.id, action: ok.action }, { kind: 'bug', id: 1, action: 'resolve' });

  const form = new URLSearchParams(srv.postsFor('/bug-resolve-1.html')[0].body);
  assert.equal(form.get('resolution'), 'fixed');
  assert.equal(form.get('resolvedBuild'), 'trunk');
  assert.equal(form.get('assignedTo'), 'demo');
  assert.equal(form.get('comment'), '<p>已修复</p>');

  const rejected = await service.writeOne({ kind: 'bug', id: 1, action: 'start' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /bug 不支持操作 start/);
  assert.match(rejected.message, /可用：comment\/resolve\/close\/activate/);
  assert.equal(srv.count('GET', '/bug-start-1.html'), 0, '白名单拒绝不应访问禅道');

  const badId = await service.writeOne({ kind: 'bug', id: 0, action: 'comment' });
  assert.equal(badId.ok, false);
  assert.equal(badId.message, 'id 非法');

  const badKind = await service.writeOne({ kind: 'epic', id: 1, action: 'comment' });
  assert.equal(badKind.ok, false);
  assert.match(badKind.message, /epic 不支持操作 comment/);

  // 白名单是超集：task finish / story close 也能写
  assert.equal((await service.writeOne({ kind: 'task', id: 1, action: 'finish', comment: '完成' })).ok, true);
  assert.equal((await service.writeOne({ kind: 'story', id: 1, action: 'close', comment: '关闭' })).ok, true);
});

test('writeOne: 成功后列表/详情缓存失效，下一次 list 重新拉取而不是返回旧状态', async (t) => {
  const { srv, service } = await makeService(t);
  const url = `${srv.baseUrl}${BROWSE}`;
  assert.equal((await service.listFromUrl({ url })).cached, false);
  assert.equal((await service.detail({ kind: 'bug', id: 1 })).cached, false);
  assert.equal(srv.count('GET', BROWSE_JSON), 1);
  assert.equal(srv.count('GET', '/api.php/v1/bugs/1'), 1);

  const w = await service.writeOne({ kind: 'bug', id: 1, action: 'comment', comment: '结论' });
  assert.equal(w.ok, true);

  assert.equal((await service.listFromUrl({ url })).cached, false, '含该条的列表缓存应失效');
  assert.equal(srv.count('GET', BROWSE_JSON), 2);
  assert.equal((await service.detail({ kind: 'bug', id: 1 })).cached, false, '该条详情缓存应失效');
  assert.equal(srv.count('GET', '/api.php/v1/bugs/1'), 2);
});

test('writeBack: 逐条执行，单条失败不中断，返回 okCount/failCount；兼容 {items} 形态', async (t) => {
  const { service } = await makeService(t);
  const r = await service.writeBack([
    { kind: 'bug', id: 1, action: 'comment', comment: '第一条' },
    { kind: 'bug', id: 1, action: 'start' }, // 白名单拒绝
    { kind: 'task', id: 1, action: 'finish', comment: '完成' },
  ]);
  assert.equal(r.results.length, 3);
  assert.equal(r.okCount, 2);
  assert.equal(r.failCount, 1);
  assert.equal(r.results[0].ok, true);
  assert.equal(r.results[1].ok, false);
  assert.match(r.results[1].message, /不支持操作 start/);
  assert.equal(r.results[2].ok, true, '前一条失败不能中断后续条目');

  const wrapped = await service.writeBack({ items: [{ kind: 'bug', id: 2, action: 'comment', comment: 'x' }] });
  assert.equal(wrapped.okCount, 1);
  assert.equal(wrapped.failCount, 0);

  await assert.rejects(service.writeBack([]), /没有要回写的条目/);
});

test('comment: 成功返回禅道回执；空备注失败且不落 HTTP', async (t) => {
  const { srv, service } = await makeService(t);
  assert.deepEqual(await service.comment({ kind: 'bug', id: 1, text: '已处理' }), { message: '保存成功' });
  await assert.rejects(service.comment({ kind: 'bug', id: 1, text: '   ' }), /备注内容不能为空/);
  assert.equal(srv.postsFor('/action-comment-bug-1.html').length, 1);
});

// ---------------------------------------------------------------------------
// 附件下载
// ---------------------------------------------------------------------------

test('downloadFile: 落盘 <dir>/.zentao-attachments/、重名加后缀、文件名清洗防穿越', async (t) => {
  const { srv, service, home } = await makeService(t);
  const dir = join(home, 'cwd');
  mkdirSync(dir, { recursive: true });
  const outDir = join(dir, '.zentao-attachments');

  const first = await service.downloadFile({ url: `${srv.baseUrl}/file-read-25509.png`, dir });
  assert.equal(dirname(first.path), outDir);
  assert.equal(first.name, 'file-read-25509.png', '未给 name 时沿用 URL 末段（禅道真实文件名由调用方给出）');
  assert.equal(first.bytes, PNG_1X1.length);
  assert.deepEqual(readFileSync(first.path), PNG_1X1);

  const second = await service.downloadFile({ url: `${srv.baseUrl}/file-read-25509.png`, dir });
  assert.equal(second.path, join(outDir, 'file-read-25509-1.png'), '重名自动加 -1 后缀');
  assert.ok(existsSync(second.path));

  // name 参数优先，且路径片段/非法字符被清洗，不能逃出 .zentao-attachments
  const named = await service.downloadFile({
    url: `${srv.baseUrl}/file-read-25510.txt`,
    dir,
    name: '../../evil name.txt',
  });
  assert.equal(dirname(named.path), outDir, '文件名里的 ../ 不能改变落盘目录');
  assert.equal(named.name, 'evil name.txt');
  assert.equal(readFileSync(named.path, 'utf8'), TXT_ATTACHMENT.toString('utf8'));
});

test('downloadFile: 目录/URL 校验错误码；200 HTML 提示页拒绝存盘', async (t) => {
  const { srv, service, home } = await makeService(t);
  const dir = join(home, 'cwd');
  mkdirSync(dir, { recursive: true });
  const pngUrl = `${srv.baseUrl}/file-read-25509.png`;

  await assert.rejects(service.downloadFile({ url: pngUrl, dir: '' }), (err) => err.code === 'NO_TARGET_DIR');
  await assert.rejects(
    service.downloadFile({ url: pngUrl, dir: join(home, 'not-exists') }),
    (err) => err.code === 'NO_TARGET_DIR',
  );

  // URL 白名单 / 同源校验
  await assert.rejects(
    service.downloadFile({ url: `${srv.baseUrl}/system/secret.txt`, dir }),
    (err) => err.code === 'BAD_IMAGE_URL',
  );
  await assert.rejects(
    service.downloadFile({ url: 'http://example.com/file-read-1.png', dir }),
    (err) => err.code === 'BAD_IMAGE_URL',
  );
  await assert.rejects(
    service.downloadFile({ url: `http://user:pass@127.0.0.1:${srv.port}/file-read-1.png`, dir }),
    (err) => err.code === 'BAD_IMAGE_URL',
  );

  // 系统目录：blocked 且不存在也必须在 stat 之前报 BAD_TARGET_DIR（跨平台清单）
  const blocked = process.platform === 'win32'
    ? 'C:\\Windows\\NoSuchDir_ztaw'
    : '/etc/no-such-dir-ztaw';
  await assert.rejects(
    service.downloadFile({ url: pngUrl, dir: blocked }),
    (err) => err.code === 'BAD_TARGET_DIR',
  );

  // 禅道无权限/文件已删：200 + HTML 提示页，绝不能存成假附件
  const dir2 = join(home, 'cwd2');
  mkdirSync(dir2, { recursive: true });
  await assert.rejects(
    service.downloadFile({ url: `${srv.baseUrl}/file-read-99999.png`, dir: dir2 }),
    /禅道返回的是页面而不是文件/,
  );
  assert.equal(existsSync(join(dir2, '.zentao-attachments')), false, '失败时不应创建附件目录/写入假附件');
});

test('fetchImage: 只接受同源白名单图片，嗅探 PNG、base64 往返、内存缓存；非图片报 UNSUPPORTED_IMAGE', async (t) => {
  const { srv, service } = await makeService(t);
  const url = `${srv.baseUrl}/file-read-25509.png`;
  const img = await service.fetchImage({ url });
  assert.equal(img.name, '25509.png');
  assert.equal(img.mediaType, 'image/png');
  assert.equal(img.bytes, PNG_1X1.length);
  assert.deepEqual(Buffer.from(img.base64, 'base64'), PNG_1X1);

  const again = await service.fetchImage({ url });
  assert.equal(again.mediaType, 'image/png');
  assert.equal(srv.count('GET', '/file-read-25509.png'), 1, '图片内存缓存命中');

  await assert.rejects(
    service.fetchImage({ url: `${srv.baseUrl}/file-read-25510.txt` }),
    (err) => err.code === 'UNSUPPORTED_IMAGE',
  );
  await assert.rejects(
    service.fetchImage({ url: `${srv.baseUrl}/system/a.png` }),
    (err) => err.code === 'BAD_IMAGE_URL',
  );
});

// ---------------------------------------------------------------------------
// 账号管理
// ---------------------------------------------------------------------------

test('status/switch/rename/logout: 账号列表、切换、改名、登出清配置', async (t) => {
  const { srv, service } = await makeService(t);
  const first = service.status().accounts[0];
  assert.throws(() => service.switch('no-such-id'), (err) => err.code === 'NO_SUCH_ACCOUNT');
  assert.throws(() => service.rename('no-such-id', 'x'), (err) => err.code === 'NO_SUCH_ACCOUNT');

  service.configure({ baseUrl: srv.baseUrl, account: 'demo2', password: 'pw2', alias: '' });
  const second = service.status().accounts.find((a) => a.account === 'demo2');
  assert.ok(second);
  service.switch(first.id);
  assert.equal(service.status().account, 'demo');
  service.rename(first.id, '  主账号  ');
  assert.equal(service.status().alias, '主账号');
  assert.equal(service.status().accounts.find((a) => a.id === first.id).alias, '主账号');

  service.logout(first.id);
  assert.equal(service.status().accounts.length, 1);
  assert.equal(service.status().account, 'demo2');
  service.logout();
  assert.equal(service.status().configured, false);
  assert.deepEqual(service.status().accounts, []);
  await waitFor(() => !existsSync(configPath()), { timeout: 2000 });
});
