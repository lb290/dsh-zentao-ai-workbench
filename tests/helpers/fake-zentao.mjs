// tests/helpers/fake-zentao.mjs — 离线禅道替身（node:http，仅监听 127.0.0.1 的随机端口）
//
// 复刻 CONTRACT.md §6 实测协议，供 tests/ 里的 client/service 测试直接跑真实
// lib/zentao-client.mjs，不需要真实禅道实例、不需要 DSH 运行时、不访问外网：
//
//   GET  /user-login.html            种 session cookie，返回登录页
//   GET  /user-refreshRandom.html    XHR 取 verifyRand（实测裸数字；可切 JSON / 垃圾形态）
//   POST /user-login.html            校验 md5(md5(pw)+rand) 与 jQuery 风格请求头
//   GET  /bug-browse-*.html          浏览页 HTML；同名 .json 返回双层信封
//   GET  /api.php/v1/bugs/1          v1 详情（desc/steps/actions/files）
//   GET  /action-comment-bug-1.html  含隐藏 uid + zen-editor 的备注表单；POST 校验
//   GET  /bug-resolve-1.html         hidden input + zui-create-picker defaultValue + 编辑器
//   GET  /file-read-*.png|txt        真实 PNG 字节 / 附件字节；99999.png 返回 200 HTML 提示页
//
// 所有时间/随机数都是确定性的；每个用例独立起一个 server，`close()` 里强制断开
// keep-alive 连接，避免测试进程挂住。

import { createHash } from 'node:crypto';
import http from 'node:http';

const md5 = (s) => createHash('md5').update(String(s), 'utf8').digest('hex');

/** 1x1 透明 PNG（真实 PNG 签名 + IHDR/IDAT/IEND，sniffImageMediaType 认它）。 */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** 附件字节（非图片）。 */
export const TXT_ATTACHMENT = Buffer.from('附件内容 attachment body\n', 'utf8');

const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>用户登录 - 禅道</title></head>
<body><div id="login">
<form action="/user-login.html" method="post" id="loginForm">
  <input type="text" name="account" value="" />
  <input type="password" name="password" value="" />
</form>
</div></body></html>`;

/** 无权限/文件已删时禅道返回的 200 HTML 提示页（必须被 host 识别并拒绝存盘）。 */
const NO_PERMISSION_PAGE = '<!doctype html><html><body>您没有权限访问该文件或文件已删除</body></html>';

const BUG_LIST = [
  {
    id: 1, title: '登录页报错', status: 'active', pri: 3, severity: 2,
    assignedTo: '张三', openedBy: '李四', openedDate: '2026-11-09 21:26:46',
    moduleTitle: '登录模块', productName: '示例产品', deadline: '',
    steps: '<p>打开登录页后报错</p><p><img src="{25509.png}" /></p>',
  },
  {
    id: 2, title: '列表分页错乱', status: 'resolved', pri: 1, severity: 1,
    assignedTo: '王五', openedBy: '张三', openedDate: '2026-11-09 21:30:00',
    moduleTitle: '列表模块', productName: '示例产品', deadline: '2026-11-20',
  },
];

const TASK_LIST = [
  {
    id: 5, name: '任务A', status: 'doing', pri: 2,
    assignedTo: '张三', openedBy: '李四', openedDate: '2026-11-09 21:40:00',
    moduleTitle: '迭代1', projectName: '示例项目', deadline: '2026-12-01',
    desc: '<p>任务描述</p>',
  },
];

const STORY_LIST = [
  {
    id: 9, title: '需求A', status: 'reviewing', pri: 2,
    assignedTo: '张三', openedBy: '李四', openedDate: '2026-11-09 21:45:00',
    stage: 'developed', category: 'feature',
    desc: '<p>需求描述</p>',
  },
];

const BUG_DETAIL_1 = {
  id: 1,
  title: '登录页报错',
  status: 'active',
  pri: 3,
  severity: 2,
  assignedTo: { id: 1, account: 'zhangsan', realname: '张三' },
  openedBy: { id: 2, account: 'lisi', realname: '李四' },
  openedDate: '2026-11-09 21:26:46',
  moduleTitle: { id: 7, name: '登录模块' },
  productName: { id: 2, name: '示例产品' },
  deadline: '',
  steps: '<p>打开登录页后报错</p><p><img src="{25509.png}" /></p>',
  actions: [
    { actor: '李四', action: 'opened', date: '2026-11-09 21:26:46', desc: '由 李四 创建。', comment: '' },
    { actor: '张三', action: 'commented', date: '2026-11-09 21:27:03', desc: '', comment: '<p>已定位问题</p><p><img src="{25510.png}" /></p>' },
    { actor: '系统', action: 'edited', date: '2026-11-09 21:28:00', desc: '', comment: '' },
  ],
  files: [
    { id: 3001, title: '报表.xlsx', extension: 'xlsx', size: 2048, url: '/file-read-3001.xlsx' },
    { id: 25511, title: '截图.png', extension: 'png', size: 512, downloadURL: '/file-read-25511.png' },
    { title: '无地址.txt', extension: 'txt', size: 10 },
  ],
};

const TASK_DETAIL_1 = {
  id: 1,
  name: '任务A',
  status: 'doing',
  pri: 2,
  assignedTo: '张三',
  openedBy: '李四',
  openedDate: '2026-11-09 21:40:00',
  moduleTitle: '迭代1',
  projectName: '示例项目',
  deadline: '2026-12-01',
  desc: '<p>任务描述</p>',
};

const DETAILS = {
  bugs: { 1: BUG_DETAIL_1 },
  tasks: { 1: TASK_DETAIL_1 },
  stories: { 1: { id: 1, title: '需求A', status: 'active', pri: 2, openedBy: '张三', productName: '示例产品', spec: '<p>需求描述</p>' } },
};

const FILE_ROUTES = {
  '25509.png': { body: PNG_1X1, type: 'image/png' },
  '25511.png': { body: PNG_1X1, type: 'image/png' },
  '25510.txt': { body: TXT_ATTACHMENT, type: 'text/plain; charset=utf-8' },
  '3001.xlsx': { body: Buffer.from('XLSX-BYTES'), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  '99999.png': { body: Buffer.from(NO_PERMISSION_PAGE, 'utf8'), type: 'text/html; charset=utf-8' },
};

function browseKind(path) {
  if (/(^|\/)(bug-browse|my-work-bug|my-bug|product-bug|project-bug|execution-bug)/.test(path)) return 'bug';
  if (/(^|\/)(task-browse|my-work-task|my-task|execution-task|project-task)/.test(path)) return 'task';
  if (/(^|\/)(story-browse|my-work-story|my-story|product-story|projectstory)/.test(path)) return 'story';
  return null;
}

function listPayload(kind) {
  if (kind === 'bug') {
    return {
      title: '示例产品-Bug',
      pager: { recTotal: BUG_LIST.length, pageID: 1, recPerPage: 10 },
      bugs: Object.fromEntries(BUG_LIST.map((b) => [b.id, b])),
    };
  }
  if (kind === 'task') {
    return {
      title: '示例项目-任务',
      pager: { recTotal: TASK_LIST.length, pageID: 1, recPerPage: 20 },
      tasks: TASK_LIST,
    };
  }
  // 实测 my-work-story.json 的 stories 是「以 id 为键的对象」，不是数组；
  // 载荷键名是 stories（story 的复数），内部用 dict 形态覆盖这个真实形状。
  return {
    title: '示例产品-需求',
    pager: { recTotal: STORY_LIST.length, pageID: 1, recPerPage: 10 },
    stories: Object.fromEntries(STORY_LIST.map((s) => [s.id, s])),
  };
}

function listPageHtml(kind) {
  const rows = kind === 'bug'
    ? BUG_LIST.map((b) => `<tr><td><a href="/bug-view-${b.id}.html">#${b.id}</a></td><td>${b.title}</td><td>${b.status}</td></tr>`).join('')
    : TASK_LIST.map((t) => `<tr><td><a href="/task-view-${t.id}.html">#${t.id}</a></td><td>${t.name}</td><td>${t.status}</td></tr>`).join('');
  const title = kind === 'bug' ? '示例产品-Bug' : '示例项目-任务';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><table id="list">${rows}</table></body></html>`;
}

function uidFor(kind, action, id) {
  return action === 'comment' ? `uid-comment-${kind}-${id}` : `uid-${kind}-${action}-${id}`;
}

function commentFormHtml(kind, id) {
  return `<!doctype html><html><body>
<form id="commentForm" action="/action-comment-${kind}-${id}.html" method="post">
  <input type="hidden" name="uid" value="${uidFor(kind, 'comment', id)}" />
  <zen-editor name="actioncomment" class="editor"></zen-editor>
</form>
</body></html>`;
}

function actionFormHtml(kind, action, id) {
  const uid = uidFor(kind, action, id);
  const status = {
    resolve: 'resolved', close: 'closed', activate: 'active',
    start: 'doing', finish: 'done', cancel: 'cancelled', pause: 'paused',
  }[action] ?? 'active';
  const parts = [
    `<form id="${action}Form" action="/${kind}-${action}-${id}.html" method="post">`,
    `<input type="hidden" name="uid" value="${uid}" />`,
    `<input type="hidden" name="id" value="${id}" />`,
    `<input type="hidden" name="status" value="${status}" />`,
  ];
  if (action === 'resolve') {
    parts.push('<input type="text" name="resolvedDate" value="2026-11-09" />');
    // zui-create-picker 的 spec 是 JSON；禅道真实页面里引号被转义成 &quot;
    parts.push('<div zui-create-picker="{&quot;name&quot;:&quot;resolvedBuild&quot;,&quot;defaultValue&quot;:&quot;trunk&quot;,&quot;items&quot;:[]}"></div>');
    parts.push('<div zui-create-picker="{&quot;name&quot;:&quot;assignedTo&quot;,&quot;defaultValue&quot;:&quot;zhangsan&quot;}"></div>');
    parts.push('<zen-editor name="comment"></zen-editor>');
  } else if (action === 'finish') {
    parts.push('<div zui-create-picker="{&quot;name&quot;:&quot;consumed&quot;,&quot;defaultValue&quot;:&quot;4&quot;}"></div>');
    parts.push('<zen-editor name="comment"></zen-editor>');
  } else {
    parts.push('<textarea name="comment"></textarea>');
  }
  parts.push('</form></body></html>');
  return `<!doctype html><html><body>${parts.join('')}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

function redirect(res, location) {
  send(res, 302, '', { Location: location });
}

/**
 * 启动一个假禅道实例。
 * @param {{
 *   account?: string, password?: string, randBase?: number,
 *   refreshRandom?: 'digits'|'json'|'garbage', pathPrefix?: string,
 * }} options
 */
export async function startFakeZentao(options = {}) {
  const account = options.account ?? 'demo';
  const password = options.password ?? 'secret';
  const randBase = Number(options.randBase ?? 819927);
  const refreshRandomMode = options.refreshRandom ?? 'digits';
  const pathPrefix = String(options.pathPrefix ?? '').replace(/\/+$/, '');

  const state = {
    rand: String(randBase),
    randSeq: 0,
    sessionId: '',
    sessionSeq: 0,
    expired: false,
    denied: new Set(),
    loginCount: 0,
    loginFailures: 0,
    requests: [],
  };

  function cookieOf(req) {
    return String(req.headers.cookie ?? '');
  }

  function authorized(req) {
    if (state.expired) return false;
    return state.sessionId !== '' && cookieOf(req).includes(`zentaosid=${state.sessionId}`);
  }

  function issueSession(res) {
    state.sessionSeq += 1;
    state.sessionId = `s${state.sessionSeq}`;
    res.setHeader('Set-Cookie', `zentaosid=${state.sessionId}; path=/; HttpOnly`);
  }

  async function handle(req, res, path, body) {
    // --- 登录页 / 登录提交 -------------------------------------------------------
    if (path === '/user-login.html') {
      if (req.method === 'GET') {
        // 打开登录页会建立新会话：旧会话的过期标记随之作废
        state.expired = false;
        issueSession(res);
        send(res, 200, LOGIN_PAGE);
        return;
      }
      if (req.method === 'POST') {
        state.loginCount += 1;
        const form = new URLSearchParams(body);
        const problems = [];
        if (!cookieOf(req).includes('zentaosid=')) problems.push('缺少 session cookie');
        if (req.headers['x-requested-with'] !== 'XMLHttpRequest') problems.push('缺少 X-Requested-With');
        if (String(req.headers['content-type'] ?? '').toLowerCase() !== 'application/x-www-form-urlencoded; charset=utf-8') {
          problems.push('Content-Type 不是 form-urlencoded; charset=UTF-8');
        }
        if (!/application\/json/i.test(String(req.headers.accept ?? ''))) problems.push('Accept 不含 application/json');
        if (String(req.headers.origin ?? '') !== baseUrl) problems.push('Origin 不匹配');
        if (String(req.headers.referer ?? '') !== `${baseUrl}/user-login.html`) problems.push('Referer 不匹配');
        if (!/Mozilla\/5\.0/.test(String(req.headers['user-agent'] ?? ''))) problems.push('缺少浏览器 UA');
        if (problems.length) {
          state.loginFailures += 1;
          sendJson(res, 200, { result: 'fail', message: `登录请求头不完整：${problems.join('；')}` });
          return;
        }
        if (form.get('account') !== account) {
          state.loginFailures += 1;
          sendJson(res, 200, { result: 'fail', message: '账号或密码错误' });
          return;
        }
        if (form.get('verifyRand') !== state.rand || form.get('password') !== md5(md5(password) + state.rand)) {
          state.loginFailures += 1;
          sendJson(res, 200, { result: 'fail', message: '账号或密码错误' });
          return;
        }
        state.expired = false;
        res.setHeader('Set-Cookie', [
          `za=${account}; path=/`,
          `zp=${md5(`${account}|${password}|${state.rand}`)}; path=/`,
          'keepLogin=on; path=/',
        ]);
        sendJson(res, 200, { result: 'success', message: '登录成功' });
        return;
      }
    }

    // --- verifyRand --------------------------------------------------------------
    if (path === '/user-refreshRandom.html' && req.method === 'GET') {
      if (!authorized(req)) {
        redirect(res, `${pathPrefix}/user-login.html`);
        return;
      }
      state.randSeq += 1;
      state.rand = String(randBase + state.randSeq);
      if (refreshRandomMode === 'json') sendJson(res, 200, { verifyRand: state.rand });
      else if (refreshRandomMode === 'garbage') send(res, 200, 'not-a-number');
      else send(res, 200, state.rand);
      return;
    }

    // --- 浏览页：.html 渲染页面，.json 返回双层信封 --------------------------------
    const kind = browseKind(path);
    if (kind && /\.(html|json)$/i.test(path)) {
      if (path.endsWith('.json')) {
        // 禅道会话失效时 .json 端点返回 200 + 登录页 HTML（而不是 JSON）
        if (!authorized(req)) {
          send(res, 200, LOGIN_PAGE);
          return;
        }
        sendJson(res, 200, { status: 'success', data: JSON.stringify(listPayload(kind)) });
        return;
      }
      if (!authorized(req)) {
        redirect(res, `${pathPrefix}/user-login.html`);
        return;
      }
      send(res, 200, listPageHtml(kind));
      return;
    }

    // --- v1 详情 -----------------------------------------------------------------
    const detail = /^\/api\.php\/v1\/(bugs|tasks|stories)\/(\d+)$/.exec(path);
    if (detail) {
      if (!authorized(req)) {
        // 禅道 cookie 失效时 v1 返回 401/403
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
      const [, plural, idText] = detail;
      const record = DETAILS[plural]?.[idText];
      if (!record) {
        sendJson(res, 404, { error: 'Not Found' });
        return;
      }
      sendJson(res, 200, record);
      return;
    }

    // --- 备注表单 -----------------------------------------------------------------
    const comment = /^\/action-comment-(bug|task|story)-(\d+)\.html$/.exec(path);
    if (comment) {
      const [, kind2, id] = comment;
      if (!authorized(req)) {
        // 会话失效时禅道 302 到登录页
        redirect(res, `${pathPrefix}/user-login.html`);
        return;
      }
      if (state.denied.has(`${kind2}-comment`)) {
        redirect(res, `${pathPrefix}/user-deny-${kind2}-comment.html`);
        return;
      }
      if (req.method === 'GET') {
        send(res, 200, commentFormHtml(kind2, id));
        return;
      }
      if (req.method === 'POST') {
        const form = new URLSearchParams(body);
        const uid = form.get('uid');
        const text = form.get('actioncomment');
        if (uid !== uidFor(kind2, 'comment', id)) {
          sendJson(res, 200, { result: 'fail', message: 'uid 缺失或不匹配' });
          return;
        }
        if (!text) {
          sendJson(res, 200, { result: 'fail', message: '备注内容不能为空' });
          return;
        }
        sendJson(res, 200, { result: 'success', message: '保存成功' });
        return;
      }
    }

    // --- 状态流转表单 -------------------------------------------------------------
    const action = /^\/(bug|task|story)-(resolve|close|activate|start|finish|cancel|pause)-(\d+)\.html$/.exec(path);
    if (action) {
      const [, kind3, act, id] = action;
      if (!authorized(req)) {
        redirect(res, `${pathPrefix}/user-login.html`);
        return;
      }
      if (state.denied.has(`${kind3}-${act}`)) {
        redirect(res, `${pathPrefix}/user-deny-${kind3}-${act}.html`);
        return;
      }
      if (req.method === 'GET') {
        send(res, 200, actionFormHtml(kind3, act, id));
        return;
      }
      if (req.method === 'POST') {
        const form = new URLSearchParams(body);
        if (form.get('uid') !== uidFor(kind3, act, id)) {
          sendJson(res, 200, { result: 'fail', message: 'uid 缺失或不匹配' });
          return;
        }
        sendJson(res, 200, { result: 'success', message: '保存成功' });
        return;
      }
    }

    // --- 文件下载（图片 / 附件） ---------------------------------------------------
    const file = /^\/file-read-([\w.-]+)$/.exec(path);
    if (file) {
      if (!authorized(req)) {
        redirect(res, `${pathPrefix}/user-login.html`);
        return;
      }
      const hit = FILE_ROUTES[file[1]];
      if (!hit) {
        send(res, 404, 'Not Found');
        return;
      }
      send(res, 200, hit.body, { 'Content-Type': hit.type });
      return;
    }

    sendJson(res, 404, { result: 'fail', message: `fake-zentao: 未实现的路由 ${req.method} ${path}` });
  }

  let baseUrl = '';
  const server = http.createServer(async (req, res) => {
    let body = '';
    try {
      body = await readBody(req);
    } catch {
      body = '';
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    let path = url.pathname;
    if (pathPrefix && path.startsWith(pathPrefix)) path = path.slice(pathPrefix.length) || '/';
    const record = { method: req.method, path, query: url.search, headers: req.headers, body };
    state.requests.push(record);
    try {
      await handle(req, res, path, body);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { result: 'fail', message: String(err?.stack ?? err) });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}${pathPrefix}`;

  return {
    baseUrl,
    port,
    state,
    requests: state.requests,
    count(method, path) {
      return state.requests.filter((r) => r.method === method && r.path === path).length;
    },
    postsFor(path) {
      return state.requests.filter((r) => r.method === 'POST' && r.path === path);
    },
    /** 让所有已签发的 cookie 立即失效（模拟禅道会话过期）。 */
    expireSession() {
      state.expired = true;
    },
    /**
     * 模拟「当前账号没有该动作权限」：禅道不会返回 403，而是 302 到 user-deny-*.html。
     * 真实案例：story-close 在无权账号下 302 → /zentao/user-deny-story-close.html，
     * 旧实现把任何 302 都当会话失效，用户只看到「禅道会话失效」并反复重登。
     */
    deny(kind, action) {
      state.denied.add(`${kind}-${action}`);
    },
    allow(kind, action) {
      state.denied.delete(`${kind}-${action}`);
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
