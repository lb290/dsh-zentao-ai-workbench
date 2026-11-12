// tests/store.test.mjs
//
// lib/store.mjs 的本机配置存储：DSH_HOME 隔离到临时目录，绝不读写真实 ~/.dsh。
// 覆盖：缺配置→空、写入/读回、0600 权限（POSIX）、损坏 JSON→空、旧面板配置导入、
// accountId 稳定、baseUrl 去尾斜杠、别名/密码编解码。

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  readConfig,
  writeConfig,
  clearConfig,
  configPath,
  legacyPanelConfigPath,
  accountId,
  normAlias,
  encodeSecret,
  decodeSecret,
  readLegacyPanelConfigSync,
  importFromPanel,
  SCHEMA_VERSION,
} from '../lib/store.mjs';

const ORIGINAL_HOME = process.env.DSH_HOME;

/** 每个用例独立的 DSH_HOME（--test-isolation=none 下多文件共进程，必须互不污染）。 */
function freshHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ztaw-store-'));
  process.env.DSH_HOME = dir;
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (ORIGINAL_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = ORIGINAL_HOME;
  });
  return dir;
}

const EMPTY = { version: SCHEMA_VERSION, accounts: [], activeId: '', lastUrl: '' };

after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = ORIGINAL_HOME;
});

test('readConfig: 配置不存在 → 空配置（不抛错）', (t) => {
  const home = freshHome(t);
  assert.equal(configPath(), join(home, 'zentao-ai-workbench', 'config.json'));
  assert.deepEqual(readConfig(), EMPTY);
});

test('writeConfig → readConfig: 账号字段往返、baseUrl 去尾斜杠、id 稳定、cookies 保留', async (t) => {
  const home = freshHome(t);
  const password = 'p@ss 中文 <&>';
  const ok = await writeConfig({
    accounts: [{
      baseUrl: 'http://zentao.local/zentao///',
      account: 'demo',
      alias: '  演示账号  ',
      password: encodeSecret(password),
      cookies: { za: { value: 'demo' }, zp: { value: 'hash', expires: Date.now() + 3_600_000 } },
      savedAt: 123,
    }, {
      // 非法行（无 baseUrl）应被过滤
      account: 'broken',
    }],
    activeId: 'not-an-existing-id',
    lastUrl: 'http://zentao.local/zentao/bug-browse-1-all-assigntome-0-id_desc-10-20.html',
  });
  assert.equal(ok, true);

  const id = accountId('http://zentao.local/zentao', 'demo');
  const cfg = readConfig();
  assert.equal(cfg.version, SCHEMA_VERSION);
  assert.equal(cfg.accounts.length, 1, '缺 baseUrl 的账号行应被丢弃');
  const [acct] = cfg.accounts;
  assert.equal(acct.id, id, '缺省 id 由「去尾斜杠的 baseUrl + account」计算');
  assert.equal(acct.baseUrl, 'http://zentao.local/zentao', 'baseUrl 必须去掉尾斜杠');
  assert.equal(acct.account, 'demo');
  assert.equal(acct.alias, '演示账号', 'alias 去空白');
  assert.equal(acct.password, encodeSecret(password), '密码按既有惯例 base64 存储');
  assert.equal(decodeSecret(acct.password), password);
  assert.equal(acct.cookies.za.value, 'demo');
  assert.equal(acct.cookies.zp.value, 'hash');
  assert.ok(acct.cookies.zp.expires > Date.now(), 'cookie 过期时间应保留');
  assert.equal(acct.savedAt, 123);
  assert.equal(cfg.activeId, id, '不存在的 activeId 回退到第一个账号');
  assert.equal(cfg.lastUrl, 'http://zentao.local/zentao/bug-browse-1-all-assigntome-0-id_desc-10-20.html');

  // 落盘内容是可解析的 JSON（含 version），不是半截文件
  const raw = JSON.parse(readFileSync(configPath(), 'utf8'));
  assert.equal(raw.version, SCHEMA_VERSION);
  assert.equal(raw.accounts.length, 1);
});

test('writeConfig: 配置文件权限 0600（POSIX）', { skip: process.platform === 'win32' ? 'Windows 不支持 POSIX mode' : false }, async (t) => {
  freshHome(t);
  assert.equal(await writeConfig({ accounts: [], activeId: '', lastUrl: '' }), true);
  const mode = statSync(configPath()).mode & 0o777;
  assert.equal(mode, 0o600, `配置文件权限应为 0600，实际 ${mode.toString(8)}`);
});

test('readConfig: 损坏 JSON / 非对象 JSON → 空配置（不能把整个面板带崩）', (t) => {
  const home = freshHome(t);
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });

  writeFileSync(path, '{ "accounts": [ {"baseUrl": "http://x"} ', 'utf8');
  assert.deepEqual(readConfig(), EMPTY, '半截 JSON 应回退空配置');

  writeFileSync(path, 'null', 'utf8');
  assert.deepEqual(readConfig(), EMPTY);

  writeFileSync(path, '"just a string"', 'utf8');
  assert.deepEqual(readConfig(), EMPTY);

  assert.equal(dirname(configPath()), join(home, 'zentao-ai-workbench'));
});

test('clearConfig: 删除配置文件，再读为空；重复删除也返回 true', async (t) => {
  freshHome(t);
  await writeConfig({
    accounts: [{ baseUrl: 'http://zentao.local', account: 'demo', alias: '', password: encodeSecret('x'), cookies: {} }],
    activeId: '',
    lastUrl: '',
  });
  assert.equal(readConfig().accounts.length, 1);
  assert.equal(await clearConfig(), true);
  assert.deepEqual(readConfig(), EMPTY);
  assert.equal(await clearConfig(), true, '文件已不存在也应幂等成功');
});

test('accountId: 同一地址（含尾斜杠差异）+ 账号 → 稳定 12 位 hex；不同账号/地址不同 id', () => {
  const a = accountId('http://zentao.local/zentao', 'demo');
  const b = accountId('http://zentao.local/zentao/', 'demo');
  assert.equal(a, b, '尾斜杠不应改变账号 id');
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.notEqual(a, accountId('http://zentao.local/zentao', 'other'));
  assert.notEqual(a, accountId('http://other.local/zentao', 'demo'));
});

test('normAlias / encodeSecret / decodeSecret 边界', () => {
  assert.equal(normAlias('  abc  '), 'abc');
  assert.equal(normAlias(null), '');
  assert.equal(normAlias('x'.repeat(50)).length, 40, '别名最长 40 字符');
  assert.equal(normAlias(undefined), '');

  assert.equal(decodeSecret(encodeSecret('中文密码 🔑')), '中文密码 🔑');
  assert.equal(decodeSecret(''), '');
  assert.equal(decodeSecret(null), '');
  assert.equal(decodeSecret(undefined), '');
});

test('readLegacyPanelConfigSync: 旧 ~/.dsh/zentao-panel/config.json → 本插件账号形态（含 cookie/lastUrl）', async (t) => {
  const home = freshHome(t);
  const legacyPath = legacyPanelConfigPath();
  assert.equal(legacyPath, join(home, 'zentao-panel', 'config.json'));
  mkdirSync(dirname(legacyPath), { recursive: true });

  // 文件不存在 → null
  assert.equal(readLegacyPanelConfigSync(), null);
  assert.equal(await importFromPanel(), null);

  writeFileSync(legacyPath, JSON.stringify({
    accounts: [{
      baseUrl: 'http://legacy.local/zentao/',
      account: 'legacyuser',
      alias: ' 旧面板 ',
      password: encodeSecret('legacy-pass'),
      cookies: { za: { value: 'legacyuser' }, zp: { value: 'hash' } },
      savedAt: 42,
    }, {
      baseUrl: '',
      account: 'invalid',
    }],
    activeId: 'stale-id',
    lastUrl: 'http://legacy.local/zentao/bug-browse-9-all.html',
  }), 'utf8');

  const imported = readLegacyPanelConfigSync();
  assert.ok(imported, '应读到旧配置');
  assert.equal(imported.accounts.length, 1, '无 baseUrl 的账号应被过滤');
  const [acct] = imported.accounts;
  assert.equal(acct.id, accountId('http://legacy.local/zentao', 'legacyuser'));
  assert.equal(acct.baseUrl, 'http://legacy.local/zentao');
  assert.equal(acct.account, 'legacyuser');
  assert.equal(acct.alias, '旧面板');
  assert.equal(decodeSecret(acct.password), 'legacy-pass');
  assert.deepEqual(acct.cookies, { za: { value: 'legacyuser' }, zp: { value: 'hash' } });
  assert.equal(imported.activeId, acct.id, '失效 activeId 回退第一个账号');
  assert.equal(imported.lastUrl, 'http://legacy.local/zentao/bug-browse-9-all.html');

  // 兼容的异步导出走同一份映射
  assert.deepEqual(await importFromPanel(), imported);

  // 损坏 JSON → null（首启不能因为旧配置坏了起不来）
  writeFileSync(legacyPath, '{ not json', 'utf8');
  assert.equal(readLegacyPanelConfigSync(), null);
  assert.equal(await importFromPanel(), null);
  assert.equal(dirname(legacyPanelConfigPath()), join(home, 'zentao-panel'));
});

test('readConfig: 本插件配置优先，旧面板配置不会被读取（由 service.init 决定导入时机）', async (t) => {
  freshHome(t);
  mkdirSync(dirname(legacyPanelConfigPath()), { recursive: true });
  writeFileSync(legacyPanelConfigPath(), JSON.stringify({
    accounts: [{ baseUrl: 'http://legacy.local', account: 'legacy' }],
  }), 'utf8');
  assert.deepEqual(readConfig(), EMPTY, 'readConfig 只读本插件文件，不静默合并旧配置');
});
