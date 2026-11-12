// dsh-zentao-ai-workbench — 禅道协议客户端（host 半边）
//
// 全部协议均为 2026-11-09 在本机对 http://zentao.example.com/zentao（ZenTao 18.13 开源版）
// 真机实测，与已安装的 dsh-zentao-panel/lib/zentao-client.mjs 同源，并新增「按链接取列表」与
// 「表单解析式写回（备注/状态流转）」两部分：
//
//   登录：GET user-login.html 种 session → GET user-refreshRandom.html（XHR）取 verifyRand
//         → POST user-login.html，密码 md5(md5(pw)+rand)，必须带 jQuery 风格请求头。
//         成功后长期 cookie：za（账号）/ zp（免密 hash）/ keepLogin=on。
//   列表：把浏览页 URL 的 .html 换成 .json 直接 GET，双层 JSON 信封
//         {status:'success', data:'<json字符串>'}；bug 是 dict，task/story 可能是数组。
//   详情：GET /api.php/v1/{bugs|tasks|stories}/{id}（cookie 鉴权即可，复数路径）。
//   备注：GET action-comment-{kind}-{id}.html 取隐藏 uid →
//         POST 同地址（actioncomment=<p>…</p> + uid）。
//   状态：GET {kind}-{action}-{id}.html 解析表单（hidden/text input + zui-create-picker 的
//         defaultValue + zen-editor 的 name）→ 合并覆盖项 → POST 同地址。
//         实测 resolve 回执 {"result":"success","message":"保存成功"}；close 只需 comment+uid。
//   图片：GET /file-read-{name}（登录态 cookie）。

import { createHash } from 'node:crypto';

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');

/**
 * decodeURIComponent 遇到非法百分号编码会抛 URIError。文件名来自禅道页面/接口，
 * 一个残缺的 % 号不该让整条详情、整页列表直接失败，所以失败时原样返回。
 */
export function safeDecodeComponent(value) {
  const raw = String(value ?? '');
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/** 实测缺任何一个都会被登录接口忽略（直接渲染回登录页 HTML）。 */
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** kind → 禅道动作页路径片段（实测存在）。 */
const ACTION_PATHS = {
  bug: { resolve: 'bug-resolve', close: 'bug-close', activate: 'bug-activate' },
  task: {
    start: 'task-start', finish: 'task-finish', close: 'task-close',
    cancel: 'task-cancel', pause: 'task-pause', activate: 'task-activate',
  },
  story: { close: 'story-close', activate: 'story-activate' },
};

/** kind → v1 详情路径复数（story → stories，不是 storys）。 */
const V1_KIND_PATHS = { task: 'tasks', bug: 'bugs', story: 'stories' };

/** 浏览页路径前缀 → kind。 */
const BROWSE_KINDS = [
  { re: /(^|\/)(bug-browse|my-work-bug|my-bug|product-bug|project-bug|execution-bug)/, kind: 'bug' },
  { re: /(^|\/)(task-browse|my-work-task|my-task|execution-task|project-task)/, kind: 'task' },
  { re: /(^|\/)(story-browse|my-work-story|my-story|product-story|projectstory)/, kind: 'story' },
];

export function createCookieJar(initial = {}) {
  const jar = new Map(Object.entries(initial).map(([k, v]) => [k, typeof v === 'string' ? { value: v } : v]));
  function alive(c) {
    return c.expires === undefined || c.expires > Date.now();
  }
  return {
    header() {
      return [...jar.entries()].filter(([, c]) => alive(c)).map(([k, c]) => `${k}=${c.value}`).join('; ');
    },
    get(name) {
      const c = jar.get(name);
      return c && alive(c) ? c.value : null;
    },
    has(name) {
      const c = jar.get(name);
      return c !== undefined && alive(c);
    },
    absorb(setCookieValues) {
      for (const raw of setCookieValues) {
        if (!raw) continue;
        const parts = String(raw).split(';');
        const [pair, ...attrs] = parts;
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        let expires;
        let maxAgeZero = false;
        for (const attr of attrs) {
          const em = /^\s*expires\s*=\s*(.+)$/i.exec(attr);
          if (em) {
            const t = Date.parse(em[1]);
            if (Number.isFinite(t)) expires = t;
          }
          const mm = /^\s*max-age\s*=\s*(-?\d+)\s*$/i.exec(attr);
          if (mm) {
            const secs = Number(mm[1]);
            // Max-Age 优先于 Expires；<=0 表示立即删除（禅道删除 tab cookie 用的就是这条路）
            if (secs <= 0) maxAgeZero = true;
            else expires = Date.now() + secs * 1000;
          }
        }
        // 三种删除形态：value=deleted / Max-Age<=0 / Expires 已过期
        if (value === 'deleted' || maxAgeZero || (expires !== undefined && expires <= Date.now())) {
          jar.delete(name);
          continue;
        }
        jar.set(name, { value, ...(expires !== undefined ? { expires } : {}) });
      }
    },
    toJSON() {
      const out = {};
      for (const [k, c] of jar) {
        if (!alive(c)) continue;
        out[k] = { value: c.value, ...(c.expires !== undefined ? { expires: c.expires } : {}) };
      }
      return out;
    },
  };
}

async function readCapped(res, cap) {
  const chunks = [];
  let received = 0;
  for await (const chunk of res.body ?? []) {
    received += chunk.length;
    if (received > cap) throw new Error(`禅道响应超过 ${cap} bytes 上限`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function httpRequest(url, { method = 'GET', headers = {}, body = null, signal, timeoutMs = 20000, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  const controller = signal ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const init = { method, headers, signal, redirect: 'manual' };
    if (body !== null) init.body = body;
    const res = await fetch(url, init);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > maxBytes) throw new Error(`禅道响应过大（${len} bytes）`);
    const buf = await readCapped(res, maxBytes);
    return { status: res.status, headers: res.headers, location: res.headers.get('location') ?? '', text: () => buf.toString('utf8'), bytes: () => buf };
  } finally {
    if (controller && timer) clearTimeout(timer);
  }
}

function htmlDecode(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 外层信封 {status:'success', data:'<json字符串>'} → 内层对象。 */
export function unwrapEnvelope(text) {
  const outer = JSON.parse(text);
  if (outer && typeof outer === 'object' && typeof outer.data === 'string') return JSON.parse(outer.data);
  return outer;
}

/** HTML → 纯文本（够用即可；图片保留 `[图片：文件名]`）。 */
export function htmlToText(html) {
  if (!html) return '';
  let s = String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ol|ul|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const m = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      const name = m ? String(m[1] ?? m[2] ?? m[3] ?? '').replace(/^.*\//, '').replace(/^\{|\}$/g, '') : '';
      return name ? `[图片：${name}]` : '[图片]';
    })
    .replace(/<[^>]+>/g, '');
  const entities = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&ldquo;': '“', '&rdquo;': '”', '&mdash;': '—', '&hellip;': '…' };
  s = s.replace(/&(nbsp|amp|lt|gt|quot|#39|ldquo|rdquo|mdash|hellip);/g, (m) => entities[m] ?? m);
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** 图片 src 归一成可下载绝对地址（详情接口是绝对地址；列表里是 {35861.png} 占位符）。 */
export function normalizeImageUrl(src, baseUrl) {
  const raw = String(src ?? '').trim();
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  if (!raw || /^data:/i.test(raw)) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  if (raw.startsWith('//')) { try { return `${new URL(base).protocol}${raw}`; } catch { return null; } }
  const brace = /^\{([^{}]+)\}$/.exec(raw);
  if (brace) return `${base}/file-read-${brace[1]}`;
  if (raw.startsWith('/')) return `${base}${raw}`;
  return `${base}/${raw}`;
}

export function extractImageRefs(html, baseUrl) {
  if (!html) return [];
  const out = [];
  const seen = new Set();
  const re = /<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const sm = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[0]);
    const src = sm ? (sm[1] ?? sm[2] ?? sm[3] ?? '') : '';
    const url = normalizeImageUrl(src, baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const clean = safeDecodeComponent(String(src).replace(/^\{|\}$/g, '')).split(/[?#]/)[0];
    const name = (clean.slice(clean.lastIndexOf('/') + 1).replace(/[()[\]{}\s]/g, '').replace(/^file-read-/i, '')) || 'image';
    out.push({ url, name: name.length <= 120 ? name : 'image' });
  }
  return out;
}

export function sniffImageMediaType(buf) {
  if (!buf || buf.length === 0) return null;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** v1 详情 files[] → 归一附件模型（禅道不同版本字段名不一，全部兼容，缺什么给空）。 */
export function normalizeFiles(raw, baseUrl) {
  if (!Array.isArray(raw)) return [];
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  const out = [];
  const seen = new Set();
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const id = Number(f.id ?? f.fileID ?? f.fileId) || null;
    const rawPath = String(f.downloadURL ?? f.url ?? f.webPath ?? f.pathname ?? '').trim();
    let url = null;
    if (/^https?:\/\//i.test(rawPath)) url = rawPath;
    else if (rawPath.startsWith('/')) url = `${base}${rawPath}`;
    else if (rawPath) url = `${base}/${rawPath}`;
    const name = String(f.title ?? f.name ?? f.filename ?? '').trim()
      || (rawPath ? safeDecodeComponent(rawPath.slice(rawPath.lastIndexOf('/') + 1)) : '')
      || (id ? `file-${id}` : 'attachment');
    if (!url && id) {
      const ext = String(f.extension ?? f.ext ?? '').replace(/^\./, '');
      url = `${base}/file-read-${id}${ext ? `.${ext}` : ''}`;
    }
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      id,
      name: name.length <= 160 ? name : name.slice(0, 160),
      ext: String(f.extension ?? f.ext ?? '').replace(/^\./, ''),
      size: Number(f.size) || null,
      url,
    });
  }
  return out;
}

function refId(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return refId(v.id ?? v.value);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nameFrom(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.name ?? v.title ?? '').trim();
  const s = String(v).trim();
  return /^\d+$/.test(s) ? '' : s;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
}

function personName(v, fallback = '') {
  if (v && typeof v === 'object') return String(v.realname ?? v.account ?? '').trim() || fallback;
  const s = String(v ?? '').trim();
  return s || fallback;
}

/** 原始记录 → 统一卡片模型（同 CONTRACT 第 2 节 Card）。 */
export function toCard(kind, raw, baseUrl) {
  const id = Number(raw.id);
  const descHtml = raw.steps ?? raw.desc ?? raw.spec ?? '';
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  const urlMap = { task: 'task-view', bug: 'bug-view', story: 'story-view' };
  const projectName = nameFrom(raw.projectName ?? raw.project);
  return {
    kind,
    id,
    title: String(raw.title ?? raw.name ?? `#${id}`),
    status: String(raw.status ?? ''),
    pri: numOrNull(raw.pri),
    severity: kind === 'bug' ? numOrNull(raw.severity) : null,
    assignedTo: personName(raw.assignedTo),
    openedBy: personName(raw.openedBy),
    openedDate: String(raw.openedDate ?? ''),
    moduleTitle: nameFrom(raw.moduleTitle ?? raw.module),
    productName: nameFrom(raw.productName ?? raw.product) || projectName,
    deadline: String(raw.deadline ?? ''),
    url: `${base}/${urlMap[kind] ?? `${kind}-view`}-${id}.html`,
    descBrief: descHtml ? htmlToText(descHtml).slice(0, 300) : '',
    images: extractImageRefs(descHtml, base),
  };
}

/** v1 详情 actions → 精简时间线（actor 已是真名；comment 是 HTML）。 */
export function toActions(raw, baseUrl) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a) => a && typeof a === 'object')
    .map((a) => {
      const commentHtml = typeof a.comment === 'string' ? a.comment.trim() : '';
      return {
        actor: typeof a.actor === 'string' ? a.actor : '',
        action: typeof a.action === 'string' ? a.action : '',
        date: typeof a.date === 'string' ? a.date : '',
        desc: htmlToText(typeof a.desc === 'string' ? a.desc : ''),
        comment: commentHtml ? htmlToText(commentHtml) : '',
        images: commentHtml ? extractImageRefs(commentHtml, baseUrl) : [],
      };
    })
    .filter((a) => a.desc || a.comment);
}

/** 从浏览页 URL 猜 kind；猜不出时按 bug 处理（调用方可用 kind 覆盖）。 */
export function detectKind(url, fallback = 'bug') {
  const path = (() => { try { return new URL(url).pathname; } catch { return String(url); } })();
  for (const { re, kind } of BROWSE_KINDS) if (re.test(path)) return kind;
  return fallback;
}

/** kind → 列表载荷里的字段名（story 的复数是 stories，不是 storys）。 */
const LIST_KEYS = { bug: 'bugs', task: 'tasks', story: 'stories' };

/** 列表载荷 → 原始条目数组（bug 是 array 或 dict，task/story 多为 dict，一律兼容）。 */
export function extractList(kind, payload) {
  const key = LIST_KEYS[kind] ?? `${kind}s`;
  const v = payload?.[key];
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === 'object');
  if (v && typeof v === 'object') return Object.values(v).filter((x) => x && typeof x === 'object');
  return [];
}

/**
 * 解析禅道动作表单：hidden/text input 的现值 + picker 的 defaultValue + 编辑器字段名。
 * 用于「先读表单默认值，再合并覆盖项」的写回方式——不硬编码每个动作的字段集。
 * @returns {{url:string, fields:Record<string,string|string[]>, editors:string[], uid:string, pickers:Array<object>}}
 */
export function parseActionForm(html, formPath) {
  const form = (() => {
    const i = html.indexOf('<form');
    if (i < 0) return html;
    const j = html.indexOf('</form>', i);
    return j > i ? html.slice(i, j) : html.slice(i);
  })();

  const fields = {};
  const inputRe = /<input\b[^>]*>/gi;
  let m;
  while ((m = inputRe.exec(form)) !== null) {
    const tag = m[0];
    const nameM = /\bname\s*=\s*"([^"]*)"/i.exec(tag);
    if (!nameM) continue;
    const name = htmlDecode(nameM[1]);
    if (!name || name === 'uid') continue;
    const typeM = /\btype\s*=\s*"([^"]*)"/i.exec(tag);
    const type = (typeM ? typeM[1] : 'text').toLowerCase();
    if (type === 'file' || type === 'checkbox' || type === 'submit' || type === 'button') continue;
    if (type === 'radio') {
      // 单选项只有「勾着」的那个才是表单默认值（如关闭原因 closedReason）；没勾的不写入
      if (!/\bchecked\b(?=[\s/>=])/i.test(tag)) continue;
      const rv = /\bvalue\s*=\s*"([^"]*)"/i.exec(tag);
      fields[name] = htmlDecode(rv ? rv[1] : 'on');
      continue;
    }
    const valueM = /\bvalue\s*=\s*"([^"]*)"/i.exec(tag);
    fields[name] = htmlDecode(valueM ? valueM[1] : '');
  }
  const textareaRe = /<textarea\b[^>]*\bname\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/textarea>/gi;
  while ((m = textareaRe.exec(form)) !== null) {
    const name = htmlDecode(m[1]);
    if (!name || name === 'uid') continue;
    fields[name] = htmlToText(m[2]);
  }
  const selectRe = /<select\b[^>]*\bname\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/select>/gi;
  while ((m = selectRe.exec(form)) !== null) {
    const name = htmlDecode(m[1]);
    if (!name) continue;
    // 旧写法把 value 和 selected 串在同一个 `[^>]*` 里，正则的贪婪匹配会把 selected
    // 一起吞进「其余属性」，于是 <option value="2" selected> 永远不算选中——下拉项的
    // 表单默认值（比如关闭原因 closedReason）就丢了。改成先取属性串，再分别判断。
    const optRe = /<option\b([^>]*)>/gi;
    let o;
    while ((o = optRe.exec(m[2])) !== null) {
      const attrs = o[1];
      if (!/\bselected\b/i.test(attrs)) continue;
      const valueM = /\bvalue\s*=\s*"([^"]*)"/i.exec(attrs) ?? /\bvalue\s*=\s*'([^']*)'/i.exec(attrs) ?? /\bvalue\s*=\s*([^\s"'>]+)/i.exec(attrs);
      if (!valueM) continue;
      fields[name] = htmlDecode(valueM[1] ?? '');
    }
  }

  const pickers = [];
  // 控件默认值不止一种写法：zui-create-picker（下拉）之外，实测 task-finish 的
  // realStarted / finishedDate 放在 zui-create-datetimePicker 的 JSON 里。只认 picker
  // 会让这些字段拿不到值，提交时被禅道按空值校验驳回。fileSelector / dropmenu 等
  // 不产出表单值（值另有 hidden input 承载），故意不收。
  const pickerRe = /zui-create-(picker|datetimePicker|datePicker|timePicker)="([^"]*)"/gi;
  while ((m = pickerRe.exec(form)) !== null) {
    let spec = null;
    try { spec = JSON.parse(htmlDecode(m[2])); } catch { spec = null; }
    if (!spec || typeof spec !== 'object' || !spec.name) continue;
    pickers.push(spec);
    const dv = spec.defaultValue;
    if (typeof dv === 'string' && dv !== '') fields[spec.name] = dv;
    else if (typeof dv === 'number' && Number.isFinite(dv) && dv !== 0) fields[spec.name] = String(dv);
  }

  const editors = [];
  const editorRe = /<zen-editor\b[^>]*\bname\s*=\s*"([^"]*)"/gi;
  while ((m = editorRe.exec(form)) !== null) {
    const name = htmlDecode(m[1]);
    if (name) editors.push(name);
  }

  const uidM = /\bname\s*=\s*"uid"\s+value\s*=\s*"([^"]*)"/i.exec(form)
    ?? /\bvalue\s*=\s*"([^"]*)"[^>]*\bid\s*=\s*"uid"/i.exec(form);
  const actionM = /<form\b[^>]*\baction\s*=\s*"([^"]*)"/i.exec(form);
  return {
    url: actionM ? htmlDecode(actionM[1]) : formPath,
    fields,
    editors,
    uid: uidM ? htmlDecode(uidM[1]) : '',
    pickers,
  };
}

/** 表单回执 → {ok, message}（JSON 回执 / form-ajax 的 HTML 回执两种形态）。 */
export function parseFormResponse(text) {
  const t = String(text ?? '').trim();
  let parsed = null;
  try { parsed = JSON.parse(t); } catch { parsed = null; }
  if (parsed && typeof parsed === 'object') {
    const rawMsg = parsed.message;
    // message 可能是对象（字段级校验错误）：{"openedBuild":["『影响版本』不能为空。"]}
    const message = rawMsg && typeof rawMsg === 'object'
      ? Object.values(rawMsg).flat().map((x) => String(x)).join('；')
      : String(rawMsg ?? '');
    if (parsed.result === 'success') return { ok: true, message: message || '保存成功' };
    if (parsed.result === 'fail' || parsed.result === false) {
      const expired = /登录|登入|超时|未登|login/i.test(message);
      return { ok: false, message: message || '禅道拒绝保存', sessionExpired: expired };
    }
    if (parsed.error) return { ok: false, message: String(parsed.error) };
    if (parsed.locate) return { ok: true, message: message || '保存成功' };
  }
  if (/user-login/i.test(t)) return { ok: false, message: '禅道会话失效，请重新登录', sessionExpired: true };
  if (/user-deny/i.test(t)) return { ok: false, message: '当前账号没有该操作权限' };
  if (/parent\.location\.reload/i.test(t)) return { ok: true, message: '保存成功' };
  return { ok: false, message: `禅道未确认保存（响应 ${t.slice(0, 120)}）` };
}

/** 纯文本备注 → 禅道编辑器接受的简单 HTML。 */
export function commentToHtml(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  if (/^\s*<[a-z!/]/i.test(raw)) return raw; // 调用方已给 HTML
  const esc = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br />')}</p>`).join('');
}

/**
 * verifyRand 的响应形态：实测的禅道 18.13 直接回一行裸数字；部分版本/反代会在外面多包
 * 一层 JSON（{verifyRand:...} / {rand:...} / {data:...}）。两种都收，收不到才算失败。
 */
export function parseVerifyRand(text) {
  const t = String(text ?? '').trim();
  if (/^\d+$/.test(t)) return t;
  if (t.startsWith('{') || t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      const v = parsed && typeof parsed === 'object' ? (parsed.verifyRand ?? parsed.rand ?? parsed.data) : parsed;
      const s = String(v ?? '').trim();
      if (/^\d+$/.test(s)) return s;
    } catch { /* 不是 JSON：交给下面的失败分支 */ }
  }
  return '';
}

export function createZentaoClient({ baseUrl, logger = console }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const log = logger;
  let jar = createCookieJar();

  function loggedIn() {
    if (jar.has('za') && jar.has('zp')) return true;
    return jar.has('zentaosid');
  }

  function sessionExpired(message = '禅道会话失效') {
    const err = new Error(message);
    err.code = 'SESSION_EXPIRED';
    return err;
  }

  /**
   * 会话失效的统一嗅探（禅道有多种形态）：
   *   - HTML 里出现 user-login（整页跳登录）；
   *   - JSON 信封 {"result":false,"message":"登录已超时…","load":"login"}（ajax 端点，HTTP 仍 200）。
   * 命中即抛 SESSION_EXPIRED，交给 service 层静默重登。
   */
  function assertAlive(text, where = '') {
    const t = String(text ?? '');
    if (t.includes('user-login')) throw sessionExpired();
    const trimmed = t.trim();
    if (trimmed.startsWith('{')) {
      let o = null;
      try { o = JSON.parse(trimmed); } catch { o = null; }
      if (o && typeof o === 'object') {
        if (o.load === 'login') throw sessionExpired(`禅道会话失效${where ? `（${where}）` : ''}`);
        if ((o.result === false || o.result === 'fail') && /登录|登入|超时|未登|login/i.test(String(o.message ?? ''))) {
          throw sessionExpired(String(o.message));
        }
      }
    }
  }

  async function request(path, { method = 'GET', headers = {}, body = null, ajax = false, referer = null, maxBytes, timeoutMs } = {}) {
    const h = {
      ...BROWSER_HEADERS,
      ...(jar.header() ? { Cookie: jar.header() } : {}),
      ...(ajax ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
      ...(referer ? { Referer: referer } : {}),
      ...headers,
    };
    const res = await httpRequest(`${base}${path}`, { method, headers: h, body, maxBytes, timeoutMs });
    const setCookies = [];
    try {
      if (typeof res.headers.getSetCookie === 'function') setCookies.push(...res.headers.getSetCookie());
      else if (res.headers.get('set-cookie')) setCookies.push(res.headers.get('set-cookie'));
    } catch { /* 忽略 */ }
    jar.absorb(setCookies);
    return res;
  }

  async function login(account, password) {
    await request('/user-login.html');
    const randRes = await request('/user-refreshRandom.html', { ajax: true });
    const rand = parseVerifyRand(await randRes.text());
    if (!rand) throw new Error('获取 verifyRand 失败（禅道既没返回数字，也没返回可识别的 JSON）');
    const form = new URLSearchParams({
      account,
      password: md5(md5(password) + rand),
      passwordStrength: '1',
      referer: '/',
      verifyRand: rand,
      keepLogin: '1',
      captcha: '',
    });
    const res = await request('/user-login.html', {
      method: 'POST',
      ajax: true,
      referer: `${base}/user-login.html`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: base,
      },
      body: form.toString(),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (parsed && parsed.result === 'success') {
      log.info?.('dsh-zentao-ai-workbench: 禅道登录成功');
      return { ok: true, keepLogin: jar.has('za') && jar.has('zp') };
    }
    const msg = parsed?.message ?? (text.includes('用户登录') ? '登录被拒（返回登录页）' : '登录失败');
    throw new Error(`禅道登录失败：${msg}`);
  }

  function restore(cookies) { jar = createCookieJar(cookies ?? {}); }
  function exportCookies() { return jar.toJSON(); }

  async function fetchV1Token(account, password) {
    const res = await httpRequest(`${base}/api.php/v1/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, password }),
    });
    if (res.status !== 201) throw new Error(`v1 token 获取失败（HTTP ${res.status}）`);
    return JSON.parse(await res.text()).token;
  }

  /** 按浏览页 URL 取列表（.html → .json，双层信封）。 */
  async function fetchListByUrl(rawUrl) {
    const target = normalizeBrowseUrl(rawUrl, base);
    const res = await request(target.path, { ajax: true, referer: `${base}/my.html` });
    const text = await res.text();
    if (text.includes('user-login')) throw sessionExpired();
    let payload;
    try { payload = unwrapEnvelope(text); } catch { throw new Error('禅道列表返回不是合法 JSON（链接可能不是浏览页）'); }
    if (payload && (payload.result === false || payload.result === 'fail') && payload.bugs === undefined && payload.tasks === undefined && payload.stories === undefined) {
      const msg = String(payload.message ?? '禅道接口返回失败');
      if (/登录|登入|超时|未登|login/i.test(msg)) throw sessionExpired();
      throw new Error(msg);
    }
    const kind = target.kind;
    const items = extractList(kind, payload);
    return {
      kind,
      items,
      payload,
      title: String(payload?.title ?? ''),
      pager: {
        total: Number(payload?.pager?.recTotal) || items.length,
        page: Number(payload?.pager?.pageID) || 1,
        perPage: Number(payload?.pager?.recPerPage) || items.length,
      },
    };
  }

  /** 浏览页 URL → 同源 .json 路径 + kind（只允许配置的禅道实例内）。 */
  function normalizeBrowseUrl(rawUrl, baseForCheck = base) {
    const s = String(rawUrl ?? '').trim();
    if (!s) throw new Error('请填写禅道链接');
    let u;
    try { u = new URL(s); } catch { throw new Error('链接格式不正确（需以 http:// 或 https:// 开头）'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http(s) 链接');
    const expected = new URL(baseForCheck);
    if (u.origin !== expected.origin) throw new Error(`链接与已登录实例不同源（当前账号：${expected.origin}）`);
    if (!u.pathname.startsWith(expected.pathname.replace(/\/+$/, ''))) {
      throw new Error(`链接路径不在当前禅道实例下（应为 ${expected.pathname} 下）`);
    }
    const prefix = expected.pathname.replace(/\/+$/, '');
    let path = u.pathname.slice(prefix.length) || '/';
    path = path.replace(/\.html?$/i, '.json');
    if (!/\.json$/i.test(path)) path += '.json';
    path = `${path}${u.search}`;
    return { path, kind: detectKind(s.startsWith('http') ? s : `${expected.origin}${path}`) };
  }

  async function fetchDetail(kind, id) {
    const res = await request(`/api.php/v1/${V1_KIND_PATHS[kind] ?? `${kind}s`}/${id}`);
    const text = await res.text();
    assertAlive(text, 'detail');
    // cookie 失效时 v1 详情返回 401/403，必须归类为会话失效才能触发静默重登
    if (res.status === 401 || res.status === 403) throw sessionExpired();
    if (res.status === 404) throw new Error(`禅道 ${kind} #${id} 不存在`);
    if (res.status !== 200) throw new Error(`禅道详情请求失败（HTTP ${res.status}）`);
    try { return JSON.parse(text); } catch { throw new Error('禅道详情返回不是合法 JSON（会话可能失效）'); }
  }

  /** 读动作表单（拿 uid 与默认值）。 */
  async function fetchActionForm(kind, action, id) {
    const page = ACTION_PATHS[kind]?.[action];
    if (!page) throw new Error(`不支持的 ${kind} 操作：${action}`);
    const path = `/${page}-${id}.html`;
    const res = await request(path, { referer: `${base}/${kind}-view-${id}.html` });
    const text = await res.text();
    assertAlive(text, `${action} 表单`);
    // 302 不一定是会话失效：实测禅道在「当前状态不允许该操作 / 账号没有权限」时也会 302，
    // 只是跳转目标不同。一律当 SESSION_EXPIRED 会导致静默重登 + 面板报「会话失效」，
    // 用户永远看不到真正原因（真实案例：story-close → /user-deny-story-close.html）。
    if (res.status === 301 || res.status === 302 || res.status === 303) {
      const loc = String(res.location ?? '');
      if (/user-login|login/i.test(loc)) throw sessionExpired(`禅道会话失效（${action} 表单 302 → ${loc}）`);
      if (/user-deny|denied/i.test(loc)) throw new Error(`当前账号没有「${action}」权限（禅道跳转 ${loc}）`);
      throw new Error(`禅道没有打开「${action}」表单（HTTP ${res.status} → ${loc || '未知地址'}），通常是当前状态不允许该操作`);
    }
    if (res.status === 401 || res.status === 403) throw sessionExpired(`禅道会话失效（${action} 表单返回 HTTP ${res.status}）`);
    if (res.status !== 200) throw new Error(`禅道${action}表单加载失败（HTTP ${res.status}）`);
    return { path, html: text, ...parseActionForm(text, path) };
  }

  /** 备注表单（uid 与编辑器字段名）。 */
  async function fetchCommentForm(kind, id) {
    const path = `/action-comment-${kind}-${id}.html`;
    const res = await request(path, { ajax: true, referer: `${base}/${kind}-view-${id}.html` });
    const text = await res.text();
    assertAlive(text, '备注表单');
    if (res.status === 301 || res.status === 302 || res.status === 303) {
      const loc = String(res.location ?? '');
      if (/user-deny|denied/i.test(loc)) throw new Error(`当前账号没有「备注」权限（禅道跳转 ${loc}）`);
      throw sessionExpired(`禅道会话失效（备注表单 302 → ${loc || '未知地址'}）`);
    }
    if (res.status === 401 || res.status === 403) throw sessionExpired(`禅道会话失效（备注表单返回 HTTP ${res.status}）`);
    if (res.status !== 200) throw new Error(`禅道备注表单加载失败（HTTP ${res.status}）`);
    return { path, html: text, ...parseActionForm(text, path) };
  }

  /** 提交表单（form-urlencoded；数组字段自动重复键）。 */
  async function submitForm(path, fields, referer) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const item of v) params.append(k, String(item));
      else params.append(k, String(v));
    }
    const res = await request(path, {
      method: 'POST',
      ajax: true,
      referer: referer ?? `${base}${path}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: base,
      },
      body: params.toString(),
    });
    const text = await res.text();
    return { status: res.status, text, ...parseFormResponse(text) };
  }

  async function addComment(kind, id, text) {
    const html = commentToHtml(text);
    if (!html) throw new Error('备注内容不能为空');
    const form = await fetchCommentForm(kind, id);
    const editorName = form.editors[0] ?? 'actioncomment';
    const fields = { uid: form.uid, [editorName]: html };
    const res = await submitForm(form.path, fields, `${base}/${kind}-view-${id}.html`);
    if (!res.ok && res.sessionExpired) throw sessionExpired(res.message);
    if (!res.ok) throw new Error(res.message);
    return { message: res.message };
  }

  /** 状态流转：读表单默认值 → 合并覆盖项 → 提交。 */
  async function updateStatus(kind, id, action, overrides = {}) {
    const form = await fetchActionForm(kind, action, id);
    const fields = { ...form.fields };
    if (form.uid) fields.uid = form.uid;
    const editorName = form.editors[0] ?? (kind === 'bug' && action === 'resolve' ? 'comment' : 'comment');
    if (overrides.comment !== undefined && String(overrides.comment).trim() !== '') {
      fields[editorName] = commentToHtml(overrides.comment);
    }
    for (const key of ['resolution', 'resolvedBuild', 'resolvedDate', 'assignedTo', 'duplicateBug', 'left', 'consumed', 'realStarted', 'finishedDate', 'closedReason', 'status', 'openedBuild']) {
      if (overrides[key] !== undefined && overrides[key] !== null && overrides[key] !== '') fields[key] = overrides[key];
    }
    // resolve 的「解决方案」是必填且表单无默认值 → 未指定时给「已解决」
    if (kind === 'bug' && action === 'resolve' && !fields.resolution) fields.resolution = 'fixed';
    const res = await submitForm(form.path, fields, `${base}/${kind}-view-${id}.html`);
    if (!res.ok && res.sessionExpired) throw sessionExpired(res.message);
    if (!res.ok) throw new Error(res.message);
    return { message: res.message };
  }

  async function fetchFile({ path, referer = `${base}/my.html`, maxBytes = 20 * 1024 * 1024 } = {}) {
    const res = await request(path, { referer, maxBytes });
    return { status: res.status, contentType: String(res.headers.get('content-type') ?? ''), bytes: res.bytes() };
  }

  return {
    baseUrl: base,
    login, restore, exportCookies, loggedIn, cookieHeader: () => jar.header(),
    fetchV1Token, fetchListByUrl, normalizeBrowseUrl, fetchDetail,
    fetchActionForm, fetchCommentForm, submitForm, addComment, updateStatus, fetchFile,
    _jar: () => jar,
  };
}

export { ACTION_PATHS, V1_KIND_PATHS };
