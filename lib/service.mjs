// dsh-zentao-ai-workbench — 数据/写回聚合层（多账号）
//
// 职责：
//   - 管理账号会话（每账号独立 client/cookie/缓存；cookie 失效用本机密码静默重登）；
//   - 「按链接取列表」：浏览页 URL → .json → 统一 Card 模型；
//   - 富详情：v1 详情 + actions 时间线 + 内联图片；
//   - 写回：备注（action-comment）与状态流转（{kind}-{action}-{id} 表单）；
//   - 批量回写：逐条执行，单条失败不影响其余；
//   - 短缓存（列表 60s / 详情 10min）与图片内存缓存。
//
// RPC 层与 Agent 工具都只调用本层方法（CONTRACT 第 3/4 节）。

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createZentaoClient, toCard, toActions, htmlToText, extractImageRefs, sniffImageMediaType, normalizeFiles, safeDecodeComponent } from './zentao-client.mjs';
import { readConfig, writeConfig, clearConfig, accountId, normAlias, decodeSecret, encodeSecret, isValidBaseUrl, readLegacyPanelConfigSync } from './store.mjs';

const CACHE_TTL_MS = 60 * 1000;
const DETAIL_CACHE_TTL_MS = 10 * 60 * 1000;
const PROBE_TTL_MS = 30 * 1000;
const IMAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const IMAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_PATH_PREFIXES = ['/file-read-', '/data/upload/', '/index.php'];
/** 允许 host 下载的禅道文件路径（图片 + 附件下载入口）。 */
const FILE_PATH_PREFIXES = [...IMAGE_PATH_PREFIXES, '/file-download-', '/file-read-'];
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * 明确不许落盘的系统位置（POSIX + Windows 同一份清单，比较前统一小写与正斜杠）。
 * 原实现只有 POSIX 路径：在 Windows 上 `C:\Windows`、`C:\Program Files` 全都能通过，
 * 而 savefile 的 dir 来自面板调用方，写错目录不该能写到系统位置去。
 */
const BLOCKED_DIRS = [
  '/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys', '/var', '/lib', '/lib64', '/opt',
  '/System', '/Library', '/Applications', '/private/etc',
  'c:/windows', 'c:/program files', 'c:/program files (x86)', 'c:/programdata', 'c:/users/all users',
  'c:/users/default',
];

function isBlockedDir(absDir) {
  const norm = String(absDir ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!norm) return true;                 // 文件系统根
  if (/^[a-z]:$/.test(norm)) return true; // Windows 盘符根（C: / D: …）
  return BLOCKED_DIRS.some((root) => norm === root || norm.startsWith(`${root}/`));
}

function imageError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function createAccountSession(rec, { logger, createClient, onLoginSaved, listCacheTtlMs = CACHE_TTL_MS }) {
  const log = logger;
  const baseUrl = rec.baseUrl;
  const account = rec.account;
  let aliasValue = normAlias(rec.alias);
  let password = decodeSecret(rec.password);
  const client = createClient({ baseUrl, logger: log });
  client.restore(rec.cookies ?? {});
  let listCache = new Map(); // url → {at, value}
  let detailCache = new Map(); // `${kind}-${id}` → {at, value}
  let loginPromise = null;
  let lastProbeAt = 0;
  let lastUrl = '';
  const imageCache = new Map();
  let imageCacheBytes = 0;

  async function ensureLogin(force = false) {
    if (client.loggedIn() && !force) {
      if (Date.now() - lastProbeAt < PROBE_TTL_MS) return true;
      try {
        await client.fetchListByUrl(lastUrl || `${baseUrl}/my-work-bug.json`);
        lastProbeAt = Date.now();
        return true;
      } catch (err) {
        if (err.code !== 'SESSION_EXPIRED') {
          // 探测用的那个 URL 可能自己失效了（页面被删、权限变化、实例改版），这不代表
          // cookie 过期。此时若把错误抛出去，用户连别的正常链接都读不了。按「仍在登录态」
          // 继续，让真正的业务请求去决定成败。
          log.warn?.(`dsh-zentao-ai-workbench: 会话探测失败，按仍在登录态处理：${err?.message ?? err}`);
          lastProbeAt = Date.now();
          return true;
        }
        log.info?.('dsh-zentao-ai-workbench: 禅道会话失效，自动重登');
      }
    }
    if (!account || !password) {
      const err = new Error('禅道会话失效且本地无凭据，请在面板重新登录');
      err.code = 'NEED_LOGIN';
      throw err;
    }
    loginPromise ??= (async () => {
      try {
        await client.login(account, password);
        lastProbeAt = Date.now();
        onLoginSaved?.();
        return true;
      } finally {
        loginPromise = null;
      }
    })();
    return loginPromise;
  }

  /** 带缓存 + 会话失效自动重试一次。 */
  async function withLogin(fn, { retry = true } = {}) {
    await ensureLogin();
    try {
      return await fn();
    } catch (err) {
      if (retry && err.code === 'SESSION_EXPIRED') {
        await ensureLogin(true);
        return fn();
      }
      throw err;
    }
  }

  async function listFromUrl({ url, refresh = false } = {}) {
    const key = String(url ?? '').trim();
    if (!key) throw new Error('请提供禅道浏览链接');
    const hit = listCache.get(key);
    if (!refresh && hit && Date.now() - hit.at < listCacheTtlMs) return { ...hit.value, cached: true };
    const value = await withLogin(async () => {
      const r = await client.fetchListByUrl(key);
      lastUrl = key;
      return {
        url: key,
        kind: r.kind,
        title: r.title,
        pager: r.pager,
        items: r.items.map((raw) => toCard(r.kind, raw, baseUrl)),
      };
    });
    listCache.set(key, { at: Date.now(), value });
    return { ...value, cached: false };
  }

  async function detail({ kind, id }) {
    const key = `${kind}-${id}`;
    const hit = detailCache.get(key);
    if (hit && Date.now() - hit.at < DETAIL_CACHE_TTL_MS) return { ...hit.value, cached: true };
    const value = await withLogin(async () => {
      const raw = await client.fetchDetail(kind, id);
      const card = toCard(kind, raw, baseUrl);
      const descHtml = raw.steps ?? raw.desc ?? raw.spec ?? '';
      const actions = toActions(raw.actions, baseUrl); // 只归一一次：下面 commentImages 也用它
      return {
        ...card,
        desc: htmlToText(descHtml),
        steps: htmlToText(raw.steps ?? ''),
        actions,
        images: extractImageRefs(descHtml, baseUrl),
        // 备注/回复里的图片（每条 action 各自的 images），client 会与描述图合并去重后作为真实附件
        commentImages: actions.flatMap((a) => a.images ?? []),
        // 条目附件（files[]）：该实例的 bug 多数没有，取到就列出来（图片可当图片附件，其它下载到工作目录）
        files: normalizeFiles(raw.files, baseUrl),
        cached: false,
      };
    });
    detailCache.set(key, { at: Date.now(), value });
    return { ...value, cached: false };
  }

  /** 禅道可能装在子路径（如 /zentao），图片白名单要按去掉子路径后的相对路径判断。 */
  const baseUrlObj = new URL(baseUrl);
  const basePath = baseUrlObj.pathname.replace(/\/+$/, '');

  function relativePath(target) {
    let p = target.pathname;
    if (basePath && p.startsWith(basePath)) p = p.slice(basePath.length);
    return `${p || '/'}${target.search}`;
  }

  function parseImageUrl(url) {
    return parseFileUrl(url, IMAGE_PATH_PREFIXES, '图片');
  }

  /** 通用文件地址校验（同源 + 路径白名单），图片与附件共用。 */
  function parseFileUrl(url, prefixes, what = '文件') {
    let target;
    try { target = new URL(String(url)); } catch { throw imageError('BAD_IMAGE_URL', `${what}地址非法`); }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw imageError('BAD_IMAGE_URL', `只支持 http(s) ${what}`);
    if (target.username || target.password) throw imageError('BAD_IMAGE_URL', `${what}地址非法`);
    if (target.origin !== baseUrlObj.origin) throw imageError('BAD_IMAGE_URL', `只允许下载禅道同源${what}`);
    const rel = relativePath(target);
    if (!prefixes.some((p) => rel.startsWith(p))) throw imageError('BAD_IMAGE_URL', `不支持的禅道${what}路径`);
    return target;
  }

  function safeFileName(raw) {
    const base = String(raw ?? '').split(/[?#]/)[0].split('/').pop() ?? '';
    let name = '';
    try { name = decodeURIComponent(base); } catch { name = base; }
    name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
    return (name || 'attachment').slice(0, 160);
  }

  /**
   * 把禅道附件下载到本机目录（通常是会话工作目录），返回落盘路径。
   * 放在 `<dir>/.zentao-attachments/` 下，重名自动加 -1/-2 后缀；仅允许同源白名单路径。
   */
  async function downloadFile({ url, dir, name: preferredName } = {}) {
    const target = parseFileUrl(url, FILE_PATH_PREFIXES, '附件');
    const rawDir = String(dir ?? '').trim();
    if (!rawDir) {
      const err = new Error('会话工作目录不可用，附件未下载（上下文里已保留附件名与链接）');
      err.code = 'NO_TARGET_DIR';
      throw err;
    }
    const absDir = resolve(rawDir);
    // 纵深防御：只允许写「真实存在的普通目录」，并拒绝系统目录
    // （RPC 已由 loopback 信任栅栏保护，这里防的是 caller 传错目录时把文件写进系统位置）
    if (isBlockedDir(absDir)) {
      const err = new Error(`不允许写入系统目录：${absDir}`);
      err.code = 'BAD_TARGET_DIR';
      throw err;
    }
    const st = await stat(absDir).catch(() => null);
    if (!st || !st.isDirectory()) {
      const err = new Error(`附件保存目录不存在或不是目录：${absDir}`);
      err.code = 'NO_TARGET_DIR';
      throw err;
    }
    const bytes = await withLogin(async () => {
      const res = await client.fetchFile({ path: relativePath(target), referer: `${baseUrl}/my.html`, maxBytes: MAX_ATTACHMENT_BYTES });
      if (res.status !== 200) throw new Error(`附件下载失败（HTTP ${res.status}）`);
      // 禅道在无权限/文件已删时也会 200 返回一个 HTML 提示页，绝不能把它当成附件存盘
      if (/text\/html/i.test(res.contentType) || /^\s*<(?:!doctype|html)/i.test(res.bytes.slice(0, 64).toString('utf8'))) {
        throw new Error('禅道返回的是页面而不是文件（可能无权限或文件已删除），未保存');
      }
      return res.bytes;
    });
    const outDir = join(absDir, '.zentao-attachments');
    await mkdir(outDir, { recursive: true });
    // 禅道的下载地址常是 file-download-{id}.html，真实文件名要由调用方（面板/工具）给出
    const name = safeFileName(preferredName || target.pathname);
    let outPath = join(outDir, name);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; i < 50 && await stat(outPath).then(() => true, () => false); i += 1) {
      outPath = join(outDir, `${stem}-${i}${ext}`);
    }
    await writeFile(outPath, bytes);
    return { path: outPath, name, bytes: bytes.length };
  }

  async function fetchImage({ url } = {}) {
    const target = parseImageUrl(url);
    const path = relativePath(target);
    const hit = imageCache.get(path);
    if (hit && Date.now() - hit.at < IMAGE_CACHE_TTL_MS) return { ...hit.value };
    const value = await withLogin(async () => {
      const res = await client.fetchFile({ path, referer: `${baseUrl}/my.html`, maxBytes: MAX_IMAGE_BYTES });
      if (res.status !== 200) throw imageError('IMAGE_FETCH_FAILED', `图片下载失败（HTTP ${res.status}）`);
      const mediaType = sniffImageMediaType(res.bytes);
      if (!mediaType) throw imageError('UNSUPPORTED_IMAGE', '图片格式不支持（仅支持 png/jpeg/webp/gif）');
      const ext = mediaType.split('/')[1].replace('jpeg', 'jpg');
      const base = safeDecodeComponent(target.pathname.slice(target.pathname.lastIndexOf('/') + 1)).replace(/^file-read-/i, '');
      return { name: base || `image.${ext}`, mediaType, base64: res.bytes.toString('base64'), bytes: res.bytes.length };
    });
    if (value.bytes <= IMAGE_CACHE_MAX_BYTES) {
      imageCache.set(path, { at: Date.now(), value });
      imageCacheBytes += value.bytes;
      while (imageCacheBytes > IMAGE_CACHE_MAX_BYTES && imageCache.size > 1) {
        const oldest = imageCache.keys().next().value;
        imageCacheBytes -= imageCache.get(oldest).value.bytes;
        imageCache.delete(oldest);
      }
    }
    return { ...value };
  }

  const WRITE_ACTIONS = {
    bug: ['comment', 'resolve', 'close', 'activate'],
    task: ['comment', 'start', 'finish', 'close', 'cancel', 'pause', 'activate'],
    story: ['comment', 'close', 'activate'],
  };

  /** 单条写回：action=comment 走备注接口，其余走状态流转表单。 */
  async function writeOne(item = {}) {
    const kind = String(item.kind ?? 'bug');
    const id = Number(item.id);
    const action = String(item.action ?? 'comment');
    if (!Number.isInteger(id) || id <= 0) return { kind, id, action, ok: false, message: 'id 非法' };
    if (!WRITE_ACTIONS[kind]?.includes(action)) {
      return { kind, id, action, ok: false, message: `${kind} 不支持操作 ${action}（可用：${(WRITE_ACTIONS[kind] ?? []).join('/')}）` };
    }
    try {
      const out = await withLogin(async () => (action === 'comment'
        ? client.addComment(kind, id, item.comment ?? '')
        : client.updateStatus(kind, id, action, {
            comment: item.comment,
            resolution: item.resolution,
            resolvedBuild: item.resolvedBuild,
            assignedTo: item.assignedTo,
            resolvedDate: item.resolvedDate,
          })));
      // 写回成功后让相关缓存失效：详情直接删；列表里含该条的整页删掉，下次 list 重新拉。
      // 不「猜」写回后的状态（task 的 start/finish、activate 各形态不同），也不原地改
      // 已经发给调用方的 items 数组——那会让面板拿着被改过的缓存对象显示错误状态。
      detailCache.delete(`${kind}-${id}`);
      for (const [cacheKey, entry] of listCache) {
        if (entry.value?.items?.some((c) => c.kind === kind && c.id === id)) listCache.delete(cacheKey);
      }
      return { kind, id, action, ok: true, message: out?.message ?? '保存成功' };
    } catch (err) {
      return { kind, id, action, ok: false, message: err?.message ?? String(err) };
    }
  }

  async function writeBack(items = []) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) throw new Error('没有要回写的条目');
    const results = [];
    for (const item of list) results.push(await writeOne(item)); // 串行：避免同一账号并发写触发禅道会话竞争
    return { results, okCount: results.filter((r) => r.ok).length, failCount: results.filter((r) => !r.ok).length };
  }

  async function comment({ kind, id, text }) {
    const r = await writeOne({ kind, id, action: 'comment', comment: text });
    if (!r.ok) throw new Error(r.message);
    return { message: r.message };
  }

  function invalidate() { listCache = new Map(); detailCache = new Map(); }

  function snapshot() {
    return {
      id: rec.id,
      baseUrl,
      account,
      alias: aliasValue,
      password: rec.password ?? '',
      cookies: client.exportCookies(),
      savedAt: Date.now(),
    };
  }

  return {
    id: rec.id,
    get baseUrl() { return baseUrl; },
    get account() { return account; },
    get alias() { return aliasValue; },
    setAlias(v) { aliasValue = normAlias(v); },
    setPassword(plain) { password = String(plain ?? password); rec.password = encodeSecret(password); },
    loggedIn: () => client.loggedIn(),
    ensureLogin,
    listFromUrl,
    detail,
    fetchImage,
    downloadFile,
    writeOne,
    writeBack,
    comment,
    invalidate,
    lastUrlOf: () => lastUrl,
    snapshot,
    actionsFor: (kind) => WRITE_ACTIONS[kind] ?? ['comment'],
  };
}

/**
 * 创建聚合服务（多账号）。
 * @param {{logger?:object, cacheTtlMs?:number, createClient?:Function}} options
 */
export function createZentaoWorkbenchService({ logger = console, createClient = createZentaoClient, cacheTtlMs = CACHE_TTL_MS } = {}) {
  const log = logger;
  const sessions = new Map();
  let activeId = '';
  let lastUrl = '';

  function save() {
    void writeConfig({ accounts: [...sessions.values()].map((s) => s.snapshot()), activeId, lastUrl });
  }

  const persistOnLogin = () => { save(); };
  const opts = { logger: log, createClient, onLoginSaved: persistOnLogin, listCacheTtlMs: cacheTtlMs };

  function active() { return sessions.get(activeId) ?? null; }

  function mustActive() {
    const s = active();
    if (!s) {
      const err = new Error('尚未配置禅道账号，请点击面板右上角「登录禅道」');
      err.code = 'NEED_LOGIN';
      throw err;
    }
    return s;
  }

  /** 启动恢复：读本插件配置；为空时从已安装的 dsh-zentao-panel 导入账号+cookie。 */
  function init() {
    const cfg = readConfig();
    let records = cfg.accounts;
    let imported = false;
    let importedActiveId = '';
    if (!records.length) {
      // 同步读取旧插件配置（首启无缝）：init() 在插件启动路径上，保持同步
      const legacy = readLegacyPanelConfigSync();
      if (legacy) {
        records = legacy.accounts;
        imported = true;
        importedActiveId = legacy.activeId;
        lastUrl = legacy.lastUrl;
        void writeConfig({ accounts: records, activeId: legacy.activeId, lastUrl });
      }
    }
    for (const rec of records) {
      // 单条坏记录（地址非法等）不该让整个插件激活失败
      try {
        sessions.set(rec.id, createAccountSession(rec, opts));
      } catch (err) {
        log.warn?.(`dsh-zentao-ai-workbench: 跳过无法恢复的账号 ${rec?.account ?? '?'}：${err?.message ?? err}`);
      }
    }
    // 导入时沿用旧插件当时激活的那个账号，而不是一律回到第一个
    activeId = [cfg.activeId, importedActiveId].find((id) => sessions.has(id)) ?? (records[0]?.id ?? '');
    lastUrl = lastUrl || cfg.lastUrl || '';
    const cur = active();
    if (imported) log.info?.(`dsh-zentao-ai-workbench: 已从禅道面板导入 ${records.length} 个账号`);
    return cur
      ? { configured: true, account: cur.account, baseUrl: cur.baseUrl, count: sessions.size, imported }
      : { configured: false, count: 0, imported };
  }

  /** 保存/更新账号并激活（同地址同账号 = 更新凭据并重登）。 */
  function configure({ baseUrl: newBase, account: acct, password: pw, alias: newAlias }) {
    const baseUrl = String(newBase ?? '').replace(/\/+$/, '');
    const account = String(acct ?? '').trim();
    if (!isValidBaseUrl(baseUrl)) throw new Error('禅道地址必须是合法的 http:// 或 https:// URL');
    if (!account || !String(pw ?? '')) throw new Error('账号和密码不能为空');
    const id = accountId(baseUrl, account);
    const prev = sessions.get(id);
    const alias = typeof newAlias === 'string' ? normAlias(newAlias) : (prev?.alias ?? '');
    const rec = {
      id, baseUrl, account, alias,
      password: encodeSecret(pw),
      cookies: {},
      savedAt: Date.now(),
    };
    const session = createAccountSession(rec, opts);
    sessions.set(id, session);
    activeId = id;
    save();
    return session;
  }

  /**
   * 登录 / 更新账号并切换——事务式：**先真登成功，再替换与持久化**。
   *
   * 为什么不能直接用 configure()：账号 id 由 baseUrl+account 决定，密码打错时旧路径会
   * 用空 cookie 的新会话盖掉同 id 的可用账号，然后把错误凭据写进配置——用户从「有可用
   * cookie」掉回「必须重输密码」，并且失败的那次输入已经把工作配置弄坏了。
   */
  async function login({ baseUrl: newBase, account: acct, password: pw, alias: newAlias }) {
    const baseUrl = String(newBase ?? '').replace(/\/+$/, '');
    const account = String(acct ?? '').trim();
    if (!isValidBaseUrl(baseUrl)) throw new Error('禅道地址必须是合法的 http:// 或 https:// URL');
    if (!account || !String(pw ?? '')) throw new Error('账号和密码不能为空');
    const id = accountId(baseUrl, account);
    const prevSession = sessions.get(id) ?? null;
    const prevActiveId = activeId;
    const alias = typeof newAlias === 'string' ? normAlias(newAlias) : (prevSession?.alias ?? '');
    const rec = {
      id, baseUrl, account, alias,
      password: encodeSecret(pw),
      cookies: {},
      savedAt: Date.now(),
    };
    const session = createAccountSession(rec, opts);
    sessions.set(id, session);
    activeId = id;
    try {
      await session.ensureLogin();
    } catch (err) {
      // 回滚：登不上就不改动原账号，失败凭据也不落盘
      if (prevSession) sessions.set(id, prevSession);
      else sessions.delete(id);
      activeId = sessions.has(prevActiveId) ? prevActiveId : (sessions.keys().next().value ?? '');
      throw err;
    }
    save();
    return session;
  }

  function switchAccount(id) {
    if (!sessions.has(id)) {
      const err = new Error('账号不存在或已移除');
      err.code = 'NO_SUCH_ACCOUNT';
      throw err;
    }
    activeId = id;
    save();
  }

  function rename(id, alias) {
    if (!sessions.has(id)) {
      const err = new Error('账号不存在或已移除');
      err.code = 'NO_SUCH_ACCOUNT';
      throw err;
    }
    sessions.get(id).setAlias(alias);
    save();
  }

  function logout(id) {
    const target = (typeof id === 'string' && id) ? id : activeId;
    if (target) sessions.delete(target);
    if (activeId === target) activeId = sessions.keys().next().value ?? '';
    if (sessions.size) save();
    else void clearConfig();
  }

  function status() {
    const cur = active();
    return {
      configured: Boolean(cur),
      baseUrl: cur?.baseUrl ?? '',
      account: cur?.account ?? '',
      alias: cur?.alias ?? '',
      loggedIn: Boolean(cur?.loggedIn()),
      lastUrl: lastUrl || cur?.lastUrlOf() || '',
      accounts: [...sessions.values()].map((s) => ({ id: s.id, baseUrl: s.baseUrl, account: s.account, alias: s.alias, loggedIn: s.loggedIn() })),
    };
  }

  /** 记住上次使用的链接（面板缓存用）。 */
  function rememberUrl(url) {
    const s = String(url ?? '').trim();
    if (!s) return;
    lastUrl = s;
    save();
  }

  return {
    init, configure, login, ensureLogin: () => mustActive().ensureLogin(), status, rememberUrl,
    listFromUrl: async (opts2 = {}) => {
      const r = await mustActive().listFromUrl(opts2);
      if (r?.url) rememberUrl(r.url);
      return r;
    },
    detail: (a) => mustActive().detail(a),
    comment: (a) => mustActive().comment(a),
    writeOne: (a) => mustActive().writeOne(a),
    /** 兼容两种调用：writeBack([...]) 与 CONTRACT 写的 writeBack({items:[...]})。 */
    writeBack: (a) => mustActive().writeBack(Array.isArray(a) ? a : (a?.items ?? [])),
    fetchImage: (a) => mustActive().fetchImage(a),
    /** 下载禅道附件到本机目录（通常是目标会话的 cwd），返回落盘路径。 */
    downloadFile: (a) => mustActive().downloadFile(a),
    actionsFor: (kind) => mustActive().actionsFor(kind),
    switch: switchAccount,
    rename,
    logout,
  };
}

export { CACHE_TTL_MS, DETAIL_CACHE_TTL_MS };
