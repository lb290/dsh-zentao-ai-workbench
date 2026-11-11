// dsh-zentao-ai-workbench — RPC 通道（client ⇄ host，loopback-only）
//
// 与已安装的 dsh-zentao-panel/lib/rpc.mjs 同一模式（本机 DSH Desktop 0.2.2-rc.1 已验证）：
//   1) 首选把 `/dsh-zentao-ai-workbench` 挂到本插件 ctx.webServer 上，复刻
//      dsh-client-connection 的 /api 传输语义（client-request → server-response），
//      并用 ctx.connection.requestRejection 做信任栅栏；
//   2) 回退 ctx.connection.rpc.handle（旧版 dsh / headless）。
//
// 端点与 CONTRACT 第 2 节一致；业务逻辑全部在 service 层，这里只做参数校验与信封包装。

const CHANNEL = '/dsh-zentao-ai-workbench';
const RPC_BODY_MAX = 16 * 1024 * 1024; // 图片 base64 走同一通道，上限比纯文本大
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
const INVALID_REQUEST_RPC_ID = 'invalid-request';
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

export const ENDPOINTS = Object.freeze({
  status: 'status',
  login: 'login',
  logout: 'logout',
  switch: 'switch',
  rename: 'rename',
  list: 'list',
  detail: 'detail',
  comment: 'comment',
  writeback: 'writeback',
  image: 'image',
  savefile: 'savefile',
});

function ok(value) { return { ok: true, value }; }
function fail(code, message) {
  return { ok: false, error: { code, message, details: { issues: [{ message }] } } };
}

function endpointFromPath(pathname) {
  if (!pathname.startsWith(`${CHANNEL}/`)) return undefined;
  const endpoint = pathname.slice(CHANNEL.length + 1);
  if (endpoint.split('/').some((seg) => seg === '' || seg === '.' || seg === '..' || !ENDPOINT_SEGMENT_PATTERN.test(seg))) return undefined;
  return endpoint;
}

function isTrustedLoopbackRequest(req) {
  const host = req.headers?.host;
  if (!host) return false;
  const hostName = host.split(':')[0];
  if (!LOOPBACK_HOSTNAMES.has(hostName)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

function serverResponseJson(rpcId, result) {
  return JSON.stringify({ type: 'server-response', rpcId, result });
}

function fetchHandler(handler, log) {
  return {
    async fetch(request) {
      const endpoint = endpointFromPath(new URL(request.url).pathname);
      if (request.method !== 'POST' || endpoint === undefined) return new Response('not found', { status: 404 });
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') return new Response('content type must be application/json', { status: 415 });
      let body;
      try { body = await request.json(); } catch { return new Response('body is not JSON', { status: 400 }); }
      const rpcId = body && typeof body.rpcId === 'string' ? body.rpcId : INVALID_REQUEST_RPC_ID;
      const method = body && typeof body.method === 'string' ? body.method : null;
      if (rpcId === INVALID_REQUEST_RPC_ID || method === null) {
        return new Response(serverResponseJson(INVALID_REQUEST_RPC_ID, {
          ok: false, error: { code: 'bad-request', message: 'invalid client-request message', details: { issues: [] } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (method !== endpoint) {
        return new Response(serverResponseJson(rpcId, {
          ok: false, error: { code: 'bad-request', message: `method ${JSON.stringify(method)} does not match endpoint ${JSON.stringify(endpoint)}`, details: { issues: [] } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      try {
        const result = await handler(endpoint, body.payload, request.signal);
        return new Response(serverResponseJson(rpcId, result), { status: 200, headers: { 'content-type': 'application/json' } });
      } catch (err) {
        log.error?.('dsh-zentao-ai-workbench: rpc %s failed: %s', endpoint, err?.message ?? err);
        return new Response(`handler failure: ${String(err)}`, { status: 500 });
      }
    },
  };
}

async function httpBridge(req, res, fetchFn, maxBodyBytes) {
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });
  const declaredLen = req.headers['content-length'];
  if (declaredLen !== undefined && Number(declaredLen) > maxBodyBytes) {
    res.writeHead(413, { connection: 'close' });
    res.end();
    req.destroy();
    return;
  }
  const chunks = [];
  let received = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > maxBodyBytes) { tooLarge = true; break; }
    chunks.push(chunk);
  }
  if (tooLarge) {
    res.writeHead(413, { connection: 'close' });
    res.end();
    req.destroy();
    return;
  }
  const url = `http://${req.headers.host ?? '127.0.0.1'}${req.url}`;
  const init = {
    method: req.method ?? 'GET',
    headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')),
    signal: abort.signal,
  };
  if (chunks.length > 0) init.body = Buffer.concat(chunks);
  const request = new Request(url, init);
  const response = await fetchFn.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body === null) { res.end(); return; }
  for await (const chunk of response.body) {
    if (!res.write(chunk)) {
      await new Promise((resolve) => {
        const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
        res.once('drain', done);
        res.once('close', done);
      });
    }
    if (res.writableEnded) break;
  }
  res.end();
}

/** 懒取服务：本插件 inject 只有 'tools'，未 inject 的服务必须用 ctx.get()，不能读 ctx.xxx。 */
function getService(ctx, name) {
  try {
    if (!ctx) return null;
    if (typeof ctx.get === 'function') return ctx.get(name) ?? null;
    return null;
  } catch {
    return null;
  }
}

function mountWebRoute(ctx, { handler, log }) {
  const webServer = getService(ctx, 'webServer');
  if (!webServer || typeof webServer.register !== 'function') return null;
  const connection = getService(ctx, 'connection');
  const fetchFn = fetchHandler(handler, log);
  const route = {
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      let rejection;
      if (typeof connection?.requestRejection === 'function') {
        try { rejection = connection.requestRejection(req); } catch { rejection = 403; }
      } else if (!isTrustedLoopbackRequest(req)) {
        rejection = 403;
      }
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }
      await httpBridge(req, res, fetchFn, RPC_BODY_MAX);
    },
  };
  let registered;
  try {
    registered = webServer.register(route);
  } catch (err) {
    // 上一次热重载/禁用可能没把同路径路由摘掉（webServer 的 (kind,path) 是唯一键）。
    // 此时沿用已存在的同名路由（同一插件上一代注册的，语义相同），不要让整个插件激活失败。
    if (/duplicate\s+\w*\s*route/i.test(String(err?.message ?? ''))) {
      log.warn?.('dsh-zentao-ai-workbench: RPC 路由已存在（上次重载遗留），沿用现有路由；重启 DSH 可彻底清理');
      return () => {};
    }
    throw err;
  }
  const cleanup = typeof registered === 'function'
    ? () => { try { registered(); } catch { /* 已清理 */ } }
    : (registered && typeof registered.then === 'function')
      ? (() => { let done = false; return async () => { if (done) return; done = true; try { const d = await registered; if (typeof d === 'function') d(); } catch { /* 已清理 */ } }; })()
      : () => {};
  return cleanup;
}

/**
 * 注册 RPC 通道，返回 disposer。
 * @param {object} ctx host cordis context
 * @param {{service:object, log?:object}} deps
 */
export function installZentaoWorkbenchRpc(ctx, { service, log = console }) {
  const handler = async (endpoint, payload = {}, signal) => {
    if (signal?.aborted) return fail('cancelled', '请求已取消');
    try {
      switch (endpoint) {
        case ENDPOINTS.status:
          return ok(service.status());

        case ENDPOINTS.login: {
          const baseUrl = String(payload?.baseUrl ?? '').trim();
          const account = String(payload?.account ?? '').trim();
          const password = String(payload?.password ?? '');
          const alias = typeof payload?.alias === 'string' ? payload.alias.trim() : '';
          if (!/^https?:\/\/.+/.test(baseUrl)) return fail('bad-request', '禅道地址必须以 http:// 或 https:// 开头');
          if (!account || !password) return fail('bad-request', '账号和密码不能为空');
          service.configure({ baseUrl, account, password, ...(alias ? { alias } : {}) });
          await service.ensureLogin();
          return ok(service.status());
        }

        case ENDPOINTS.switch: {
          const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
          if (!id) return fail('bad-request', '参数非法（id 必填）');
          service.switch(id);
          return ok(service.status());
        }

        case ENDPOINTS.rename: {
          const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
          if (!id || typeof payload?.alias !== 'string') return fail('bad-request', '参数非法（id + alias 必填）');
          service.rename(id, payload.alias);
          return ok(service.status());
        }

        case ENDPOINTS.logout:
          service.logout(typeof payload?.id === 'string' && payload.id ? payload.id : undefined);
          return ok(service.status());

        case ENDPOINTS.list: {
          const url = String(payload?.url ?? '').trim();
          if (!url) return fail('bad-request', '请填写禅道链接');
          return ok(await service.listFromUrl({ url, refresh: payload?.refresh === true }));
        }

        case ENDPOINTS.detail: {
          const kind = ['task', 'bug', 'story'].includes(payload?.kind) ? payload.kind : null;
          const id = Number(payload?.id);
          if (!kind || !Number.isInteger(id) || id <= 0) return fail('bad-request', '参数非法（kind + id 必填）');
          return ok(await service.detail({ kind, id }));
        }

        case ENDPOINTS.comment: {
          const kind = ['task', 'bug', 'story'].includes(payload?.kind) ? payload.kind : 'bug';
          const id = Number(payload?.id);
          const text = String(payload?.text ?? payload?.comment ?? '').trim();
          if (!Number.isInteger(id) || id <= 0) return fail('bad-request', '参数非法（id 必填）');
          if (!text) return fail('bad-request', '备注内容不能为空');
          return ok(await service.comment({ kind, id, text }));
        }

        case ENDPOINTS.writeback: {
          const items = Array.isArray(payload?.items) ? payload.items : null;
          if (!items || !items.length) return fail('bad-request', '没有要回写的条目');
          return ok(await service.writeBack(items));
        }

        case ENDPOINTS.image: {
          const url = typeof payload?.url === 'string' ? payload.url.trim() : '';
          if (!url || url.length > 2048) return fail('bad-request', '参数非法（url 必填）');
          return ok(await service.fetchImage({ url }));
        }

        case ENDPOINTS.savefile: {
          const url = typeof payload?.url === 'string' ? payload.url.trim() : '';
          const dir = typeof payload?.dir === 'string' ? payload.dir.trim() : '';
          const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 160) : '';
          if (!url || url.length > 2048) return fail('bad-request', '参数非法（url 必填）');
          return ok(await service.downloadFile({ url, dir, ...(name ? { name } : {}) }));
        }

        default:
          return fail('bad-request', `Unknown endpoint: ${endpoint}`);
      }
    } catch (err) {
      if (err?.code === 'NEED_LOGIN') return fail('need-login', err.message);
      log.error?.('dsh-zentao-ai-workbench: rpc %s failed: %s', endpoint, err?.message ?? err);
      return fail('bad-request', err?.message ?? String(err));
    }
  };

  // ── 通道挂载时序 ────────────────────────────────────────────────────────────
  // Loader 并发挂载 entry：`webServer` 的 fiber 要等 listen() 完成才 ACTIVE，
  // `connection` 又要等 webServer 就绪。而 ctx.get(name) 是「严格读」——只返回
  // 提供方 fiber 已 ACTIVE 的实现。插件 apply 是同步的，启动期一次性探测必然拿到
  // undefined，于是路由从未挂上，面板每个请求都落到 SPA 兜底资源（POST → HTTP 405，
  // 即 `transport failure ... HTTP 405`）。
  // 正确做法与 dsh-db-connections 一致：ctx.inject([...], cb)，服务就绪后再挂，
  // 并在 cb 里用 effect 拥有清理权（fiber 卸载/服务下线时自动摘路由）。
  let mounted = null;
  let disposed = false;

  /**
   * 幂等挂载：已挂过则返回空清理器，避免重复 effect 持有同一路由。
   * @param {object} owner 拥有该路由的 ctx（apply 的 ctx 或 inject 回调的 ctx）
   * @returns {() => void} 本次挂载的清理器
   */
  const attach = (owner) => {
    if (mounted) return () => {};
    if (disposed) return () => {};
    let cleanup = mountWebRoute(owner, { handler, log });
    if (!cleanup) {
      const connection = getService(owner, 'connection');
      const rpcHandle = connection?.rpc?.handle;
      if (typeof rpcHandle === 'function') {
        try {
          const handle = rpcHandle.call(connection.rpc, CHANNEL, handler, { authority: 'loopback' });
          cleanup = () => { try { handle?.(); } catch { /* 已清理 */ } };
        } catch (err) {
          log.error?.('dsh-zentao-ai-workbench: 挂载 RPC 通道失败：%s', err?.message ?? err);
        }
      }
    }
    if (!cleanup) return () => {};
    mounted = cleanup;
    return () => {
      try { cleanup(); } finally { if (mounted === cleanup) mounted = null; }
    };
  };

  // 1) 服务已就绪（热重载、旧版主机）时立即挂载，零延迟。
  if (typeof ctx?.effect === 'function') {
    try { ctx.effect(() => attach(ctx), 'dsh-zentao-ai-workbench: rpc'); } catch { attach(ctx); }
  } else {
    attach(ctx);
  }

  // 2) 服务晚就绪（本机 DSH Desktop 0.2.2-rc.1 实测路径）：等注入回调再挂。
  if (!mounted && typeof ctx?.inject === 'function') {
    for (const deps of [['webServer'], ['connection']]) {
      try {
        ctx.inject(deps, (readyCtx) => {
          readyCtx.effect(() => attach(readyCtx), `dsh-zentao-ai-workbench: rpc (${deps[0]})`);
        });
      } catch (err) {
        log.warn?.('dsh-zentao-ai-workbench: 等待 %s 就绪失败：%s', deps[0], err?.message ?? err);
      }
    }
    if (!mounted) log.info?.('dsh-zentao-ai-workbench: 等待 webServer/connection 就绪后挂载 RPC 通道');
  }

  return () => {
    disposed = true;
    try { mounted?.(); } catch { /* 已清理 */ }
    mounted = null;
  };
}

export { CHANNEL };
