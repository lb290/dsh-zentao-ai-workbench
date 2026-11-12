// tools/probe-writeback.mjs — 真机探针（只读干跑优先；凭据从本机 ~/.dsh 配置读取，不含任何账号）
//
// 目的：把「任务 / 需求的状态流转」在真实禅道上安全地验一遍。
//
//   --list <kind>      只读：列出指派给我的条目（拿 id 用）
//   --kind --id --action
//                      默认「干跑」：只 GET 动作表单，打印解析出的字段，**不发 POST**。
//                      这一步证明 parseActionForm 在真机表单上取到了必填/惯填项
//                      （如 task-finish 的 finishedDate、bug-resolve 的 resolution），
//                      而不是靠猜。
//   --write            真写：POST 表单（会进禅道历史记录、可能通知同事），
//                      写完再读 v1 详情核对 status 与最近动态。
//
// 凭据取自本机配置（~/.dsh/zentao-ai-workbench/config.json，优先用已有 cookie），
// 只在内存里用，不打印密码与 cookie。
//
// 用法：
//   node tools/probe-writeback.mjs --list task
//   node tools/probe-writeback.mjs --list story
//   node tools/probe-writeback.mjs --kind task --id 123 --action finish
//   node tools/probe-writeback.mjs --kind task --id 123 --action finish --comment "结论…" --write
//   node tools/probe-writeback.mjs --kind bug  --id 456 --action resolve --resolution fixed --write
//
// ⚠️ 真写只对「自己建的测试条目」做；禅道写操作会给相关同事发通知。

import { readConfig, decodeSecret } from '../lib/store.mjs';
import { createZentaoClient, toActions } from '../lib/zentao-client.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const val = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const LIST = flag('list');
const KIND = LIST ? val('list', 'task') : val('kind', 'task');
const ACTION = val('action', '');
const ID = Number(val('id', '0'));
const COMMENT = val('comment', '');
const WRITE = flag('write');
const URL = val('url', '');

/** 各状态动作的必填项（禅道服务端要求；表单里通常带默认值，这里只做提示）。 */
const REQUIRED = {
  'bug:resolve': ['resolution'],
  'bug:close': [],
  'bug:activate': [],
  'task:start': [],
  'task:finish': ['finishedDate'],
  'task:close': [],
  'task:cancel': [],
  'task:pause': [],
  'task:activate': [],
  'story:close': [],
  'story:activate': [],
};

const say = (...bits) => console.log(...bits);
const head = (title) => say(`\n=== ${title} ===`);

function clip(v, n = 90) {
  const s = String(v ?? '');
  return s.length > n ? `${s.slice(0, n)}…（${s.length} 字）` : s;
}

async function main() {
  if (!['bug', 'task', 'story'].includes(KIND)) {
    console.error(`kind 只能是 bug / task / story（收到 ${KIND}）`);
    return 2;
  }

  const cfg = readConfig();
  const rec = cfg.accounts.find((a) => a.id === cfg.activeId) ?? cfg.accounts[0];
  if (!rec) {
    console.error('本机没有禅道账号：先在面板里登录，或把账号写进 ~/.dsh/zentao-ai-workbench/config.json');
    return 2;
  }

  const client = createZentaoClient({ baseUrl: rec.baseUrl, logger: { info() {}, warn: console.warn, error: console.error } });
  client.restore(rec.cookies ?? {});

  /** cookie 在但已过期（实测很常见）：用本机密码静默重登一次再重试，与 service 层一致。 */
  const withLogin = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err?.code !== 'SESSION_EXPIRED') throw err;
      if (!rec.password) throw new Error('会话失效且本机没有密码，请在面板重新登录');
      say('cookie 已失效，用本机密码重新登录…');
      await client.login(rec.account, decodeSecret(rec.password));
      return fn();
    }
  };

  head('连接');
  say(`实例：${rec.baseUrl}  账号：${rec.account}  已有 cookie：${client.loggedIn() ? '是' : '否'}`);
  if (!client.loggedIn()) {
    if (!rec.password) { console.error('没有可用 cookie，也没有本机密码，无法登录'); return 2; }
    await client.login(rec.account, decodeSecret(rec.password));
    say('已用本机密码重新登录');
  }

  if (LIST) {
    const url = URL || `${rec.baseUrl.replace(/\/+$/, '')}/my-work-${KIND}.json`;
    const r = await withLogin(() => client.fetchListByUrl(url));
    head(`指派给我的 ${r.kind}（${r.pager.total} 条，来自 ${url}）`);
    for (const it of r.items.slice(0, 25)) {
      say(`  #${it.id}  ${String(it.status ?? '').padEnd(9)} ${clip(it.title ?? it.name ?? '', 60)}`);
    }
    const first = r.items[0]?.id ?? '<id>';
    const action = r.kind === 'bug' ? 'resolve' : r.kind === 'task' ? 'finish' : 'close';
    say(`\n挑一条来试：node tools/probe-writeback.mjs --kind ${r.kind} --id ${first} --action ${action}`);
    return 0;
  }

  if (!ID) { console.error('缺少 --id（用 --list 先看有哪些条目）'); return 2; }
  if (!ACTION) {
    console.error('缺少 --action（bug: comment/resolve/close/activate；task: comment/start/finish/close/cancel/pause/activate；story: comment/close/activate）');
    return 2;
  }

  head(`动作：${KIND} #${ID} → ${ACTION}${WRITE ? '（真写）' : '（干跑：只读表单，不提交）'}`);

  if (ACTION === 'comment') {
    if (!COMMENT) { console.error('comment 动作需要 --comment'); return 2; }
    const form = await withLogin(() => client.fetchCommentForm(KIND, ID));
    say(`表单：${form.path}  uid=${form.uid ? '有' : '无'}  编辑器字段：${form.editors.join(',') || '(默认)'}`);
    if (!WRITE) {
      say('干跑通过：已取到备注表单与 uid，未提交。加 --write 才真正写备注。');
      return 0;
    }
    const res = await withLogin(() => client.addComment(KIND, ID, COMMENT));
    say(`已提交备注：${res.message}`);
  } else {
    const form = await withLogin(() => client.fetchActionForm(KIND, ACTION, ID));
    say(`表单地址：${form.path}  提交到：${form.url}`);
    say(`uid：${form.uid ? '有' : '无'}   编辑器字段：${form.editors.join(', ') || '(无)'}`);
    say(`控件默认值：${form.pickers.map((p) => `${p.name}=${clip(JSON.stringify(p.defaultValue), 40)}`).join(', ') || '(无)'}`);
    say(`解析出的字段（${Object.keys(form.fields).length} 个）：`);
    for (const [k, v] of Object.entries(form.fields)) say(`  ${k} = ${clip(v)}`);

    const need = REQUIRED[`${KIND}:${ACTION}`] ?? [];
    const missing = need.filter((f) => !form.fields[f]);
    say(`\n必填项检查（${need.join(', ') || '无额外必填'}）：${missing.length ? `缺 ${missing.join(', ')} ⚠️` : '齐全 ✅'}`);
    if (missing.length) say('（缺失项可能由服务端补默认值，也可能导致提交被驳回——真写会告诉你答案）');

    if (!WRITE) {
      say('\n干跑结束：以上字段就是真正提交时会带上的内容，本次没有任何写操作。');
      return 0;
    }
    const res = await withLogin(() => client.updateStatus(KIND, ID, ACTION, {
      comment: COMMENT || undefined,
      resolution: val('resolution', '') || undefined,
      resolvedBuild: val('resolvedBuild', '') || undefined,
      assignedTo: val('assignedTo', '') || undefined,
    }));
    say(`已提交：${res.message}`);
  }

  const detail = await withLogin(() => client.fetchDetail(KIND, ID));
  head('写后核对（v1 详情）');
  say(`status：${detail.status ?? '(空)'}   assignedTo：${detail.assignedTo ?? '(空)'}`);
  for (const a of toActions(detail.actions, rec.baseUrl).slice(-3)) {
    say(`  ${a.date}  ${a.actor}  ${a.action}  ${clip(a.comment || a.desc, 70)}`);
  }
  say('\n如果 status 与上面一致、历史记录里出现刚才的结论，就说明这条链路通了。');
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`\n失败：${err?.message ?? err}`);
  process.exitCode = 1;
}
