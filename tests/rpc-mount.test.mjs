// 校验 lib/rpc.mjs 的挂载时序修复：webServer/connection 晚就绪时仍能挂上路由。
// 运行：node verify/rpc-mount.test.mjs
//
// 回归的是真实故障：Loader 并发挂载 entry，`webServer` 的 fiber 要等 listen() 完成才
// ACTIVE，而 ctx.get() 只返回 ACTIVE 实现 —— 插件 apply 里的「一次性探测」拿不到服务，
// 通道从未挂上，面板每个请求都落到 SPA 兜底资源（POST → HTTP 405 → transport failure）。
import assert from 'node:assert/strict';
import { installZentaoWorkbenchRpc, CHANNEL } from '../lib/rpc.mjs';

const logLines = [];
const log = {
  info: (...a) => logLines.push(['info', a.join(' ')]),
  warn: (...a) => logLines.push(['warn', a.join(' ')]),
  error: (...a) => logLines.push(['error', a.join(' ')]),
};

/** 极简 cordis ctx 替身：get 严格读、inject 延迟回调、effect 立即执行并收集清理器。 */
function makeCtx({ webServerReady = false } = {}) {
  const effects = [];
  const deferred = [];
  const routes = [];
  const webServer = {
    register(route) {
      const existing = routes.find((r) => r.kind === route.kind && r.path === route.path);
      if (existing) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
      routes.push(route);
      return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); };
    },
  };
  const ctx = {
    logger: () => log,
    get(name) {
      if (name === 'webServer') return webServerReady ? webServer : undefined;
      return undefined;
    },
    inject(deps, cb) {
      if (webServerReady && deps[0] === 'webServer') { cb(ctx); return () => {}; }
      deferred.push({ deps, cb });
      return () => {};
    },
    effect(fn) {
      const cleanup = fn();
      effects.push(cleanup);
      return () => { try { cleanup?.(); } catch { /* 已清理 */ } };
    },
  };
  return {
    ctx,
    routes,
    effects,
    /** 模拟 listen() 完成：webServer 变成 ACTIVE，触发 inject 回调。 */
    ready() {
      webServerReady = true;
      for (const { deps, cb } of deferred.splice(0)) {
        if (deps[0] === 'webServer') cb(ctx);
      }
    },
  };
}

const service = { status: () => ({ configured: false }) };

// 场景 A：服务已就绪 → 立即挂载
{
  const h = makeCtx({ webServerReady: true });
  const dispose = installZentaoWorkbenchRpc(h.ctx, { service, log });
  assert.equal(h.routes.length, 1, '就绪时应立刻挂上一条前缀路由');
  assert.equal(h.routes[0].path, CHANNEL);
  assert.equal(h.routes[0].kind, 'prefix');
  dispose();
  assert.equal(h.routes.length, 0, 'dispose 之后路由应被摘掉');
}

// 场景 B：服务晚就绪（线上故障的真实路径）→ 就绪后仍能挂载
{
  const h = makeCtx({ webServerReady: false });
  const dispose = installZentaoWorkbenchRpc(h.ctx, { service, log });
  assert.equal(h.routes.length, 0, '未就绪时不应有路由');
  h.ready();
  assert.equal(h.routes.length, 1, '服务就绪后必须补挂路由');
  assert.equal(h.routes[0].path, CHANNEL);
  dispose();
  assert.equal(h.routes.length, 0, 'dispose 之后路由应被摘掉');
}

// 场景 C：重复就绪通知不产生第二条路由
{
  const h = makeCtx({ webServerReady: false });
  installZentaoWorkbenchRpc(h.ctx, { service, log });
  h.ready();
  h.ready();
  assert.equal(h.routes.length, 1, '幂等：不应重复注册');
}

// 场景 D：路由 handler 走通一次 status 请求（不落 SPA 兜底）
{
  const h = makeCtx({ webServerReady: false });
  installZentaoWorkbenchRpc(h.ctx, { service, log });
  h.ready();
  const route = h.routes[0];
  assert.equal(typeof route.handler, 'function');
  let body = '';
  let status = 0;
  const req = {
    method: 'POST',
    url: `${CHANNEL}/status`,
    headers: { host: '127.0.0.1:50952', 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'x1', method: 'status', payload: {} }));
    },
  };
  const res = {
    writableEnded: false,
    on() {}, off() {}, once() {},
    writeHead(code) { status = code; },
    write(chunk) {
      body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : Buffer.from(chunk).toString('utf8');
      return true;
    },
    end() { this.writableEnded = true; },
  };
  await route.handler(req, res);
  assert.equal(status, 200, `期望 200，实际 ${status}`);
  const parsed = JSON.parse(body);
  assert.equal(parsed.type, 'server-response');
  assert.equal(parsed.rpcId, 'x1');
  assert.equal(parsed.result.ok, true);
  assert.deepEqual(parsed.result.value, { configured: false });
}

console.log('rpc-mount: 全部场景通过 ✅');
