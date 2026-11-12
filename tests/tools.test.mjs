// tests/tools.test.mjs
//
// lib/tools.mjs 的 Agent 工具契约：注册 5 个工具、参数 schema、execute 永不抛异常
// （失败一律 {ok:false, message}），以及 kind 必填/整批拒绝、批量映射到 service.writeBack。

import test from 'node:test';
import assert from 'node:assert/strict';

import { installZentaoWorkbenchTools, KIND_ENUM, ACTION_ENUM } from '../lib/tools.mjs';

const silent = { info() {}, warn() {}, error() {} };

function makeFakeService(options = {}) {
  const calls = {
    listFromUrl: [], detail: [], comment: [], writeOne: [], writeBack: [], downloadFile: [],
  };
  const errors = options.errors ?? {};
  const must = (name) => {
    if (errors[name]) throw new Error(errors[name]);
  };
  const service = {
    async listFromUrl(a) {
      calls.listFromUrl.push(a);
      must('listFromUrl');
      return options.listResult ?? {
        kind: 'bug',
        title: '示例产品-Bug',
        pager: { total: 2, page: 1, perPage: 10 },
        items: [
          { id: 1, title: '登录页报错', status: 'active', assignedTo: '张三' },
          { id: 2, title: '列表分页错乱', status: 'resolved', assignedTo: '王五' },
        ],
      };
    },
    async detail(a) {
      calls.detail.push(a);
      must('detail');
      return options.detailResult ?? {
        title: '详情标题',
        status: 'active',
        desc: '描述文字',
        steps: '重现步骤',
        assignedTo: '张三',
        url: 'http://x/bug-view-1.html',
        images: [{ url: 'http://x/file-read-25509.png', name: '25509.png' }],
        commentImages: [{ url: 'http://x/file-read-25510.png', name: '25510.png' }],
        actions: [{ actor: '张三', action: 'commented', date: '2026-11-09', desc: '', comment: '备注', images: [] }],
        files: [
          { name: '报表.xlsx', url: 'http://x/file-read-3001.xlsx', ext: 'xlsx', size: 10 },
          { name: '截图.png', url: 'http://x/file-read-25511.png', ext: 'png', size: 5 },
          { name: '说明.txt', url: 'http://x/file-read-3002.txt', ext: 'txt', size: 1 },
        ],
      };
    },
    async comment(a) {
      calls.comment.push(a);
      must('comment');
      return { message: '保存成功' };
    },
    async writeOne(a) {
      calls.writeOne.push(a);
      must('writeOne');
      return options.writeOneResult ?? { kind: a.kind, id: a.id, action: a.action, ok: true, message: '保存成功' };
    },
    async writeBack(items) {
      calls.writeBack.push(items);
      must('writeBack');
      if (options.writeBackResult) return options.writeBackResult(items);
      return {
        results: items.map((it) => ({ kind: it.kind, id: it.id, action: it.action, ok: true, message: '保存成功' })),
        okCount: items.length,
        failCount: 0,
      };
    },
    async downloadFile(a) {
      calls.downloadFile.push(a);
      must('downloadFile');
      if (options.downloadFileError) throw new Error(options.downloadFileError);
      return { path: `${a.dir}/.zentao-attachments/${a.name}`, name: a.name, bytes: 1 };
    },
  };
  return { service, calls };
}

function install(t, options = {}) {
  const registered = new Map();
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
    },
  };
  const fake = makeFakeService(options);
  const dispose = installZentaoWorkbenchTools(ctx, { service: fake.service, log: silent });
  t.after(() => dispose());
  return { registered, fake, dispose };
}

test('register: 注册 5 个工具，schema/execute/render 齐全，disposer 全部注销', (t) => {
  const { registered, dispose } = install(t);
  assert.deepEqual([...registered.keys()].sort(), [
    'zentao_add_comment',
    'zentao_item_detail',
    'zentao_list_items',
    'zentao_update_status',
    'zentao_write_back',
  ]);
  const required = {
    zentao_list_items: ['url'],
    zentao_item_detail: ['kind', 'id'],
    zentao_add_comment: ['kind', 'id', 'comment'],
    zentao_update_status: ['kind', 'id', 'action'],
    zentao_write_back: ['items'],
  };
  for (const [name, def] of registered) {
    assert.equal(def.name, name);
    assert.equal(def.parameters?.type, 'object', `${name} 需要 object 参数 schema`);
    assert.deepEqual(def.parameters.required, required[name], `${name} 必填参数`);
    assert.equal(typeof def.execute, 'function');
    assert.equal(typeof def.output?.render, 'function');
    assert.equal(typeof def.description, 'string');
  }
  assert.deepEqual(KIND_ENUM, ['bug', 'task', 'story']);
  assert.ok(ACTION_ENUM.includes('resolve') && ACTION_ENUM.includes('start'));

  dispose();
  assert.equal(registered.size, 0, 'disposer 应注销本插件注册的全部工具');
});

test('zentao_list_items: 成功走 service.listFromUrl({url, refresh:true})，渲染结果行', async (t) => {
  const { registered, fake } = install(t);
  const def = registered.get('zentao_list_items');
  const r = await def.execute({ url: 'http://x/bug-browse-1-all-assigntome-0-id_desc-10-20.html' });
  assert.equal(r.ok, true);
  assert.equal(r.total, 2);
  assert.equal(r.kind, 'bug');
  assert.equal(r.items.length, 2);
  assert.deepEqual(fake.calls.listFromUrl, [{
    url: 'http://x/bug-browse-1-all-assigntome-0-id_desc-10-20.html',
    refresh: true,
  }]);
  const rendered = def.output.render({}, r)[0].text;
  assert.match(rendered, /共 2 条（bug）/);
  assert.match(rendered, /#1 · 登录页报错 · 状态 active · 指派 张三/);
});

test('failure contract: 任一 service 抛异常，工具都返回 {ok:false, message} 而不是抛给模型', async (t) => {
  const cases = [
    ['zentao_list_items', { url: 'http://x/a.html' }],
    ['zentao_item_detail', { kind: 'bug', id: 1 }],
    ['zentao_add_comment', { kind: 'bug', id: 1, comment: 'x' }],
    ['zentao_update_status', { kind: 'bug', id: 1, action: 'resolve' }],
    ['zentao_write_back', { items: [{ kind: 'bug', id: 1, action: 'comment' }] }],
  ];
  for (const [name, args] of cases) {
    const { registered } = install(t, { errors: { [name === 'zentao_list_items' ? 'listFromUrl'
      : name === 'zentao_item_detail' ? 'detail'
        : name === 'zentao_add_comment' ? 'comment'
          : name === 'zentao_update_status' ? 'writeOne'
            : 'writeBack']: '后端炸了' } });
    const r = await registered.get(name).execute(args);
    assert.equal(r.ok, false, `${name} 失败应返回 ok:false`);
    assert.match(r.message, /后端炸了/, `${name} 应把错误原因给模型`);
  }
});

test('zentao_add_comment: kind 必填（非法/缺失 → 提示且不调 service），成功透传回执', async (t) => {
  const { registered, fake } = install(t);
  const def = registered.get('zentao_add_comment');

  for (const args of [{ id: 1, comment: 'x' }, { kind: 'epic', id: 1, comment: 'x' }]) {
    const r = await def.execute(args);
    assert.equal(r.ok, false);
    assert.match(r.message, /kind 必须是 bug \/ task \/ story/);
  }
  assert.equal(fake.calls.comment.length, 0, 'kind 非法时不能猜类型去写');

  const ok = await def.execute({ kind: 'task', id: 7, comment: '已完成' });
  assert.deepEqual(ok, { ok: true, id: 7, message: '保存成功' });
  assert.deepEqual(fake.calls.comment, [{ kind: 'task', id: 7, text: '已完成' }]);

  const failed = install(t, { errors: { comment: '没权限' } });
  const r = await failed.registered.get('zentao_add_comment').execute({ kind: 'bug', id: 1, comment: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.message, '没权限');
  assert.match(failed.registered.get('zentao_add_comment').output.render({}, r)[0].text, /写入失败：没权限/);
});

test('zentao_update_status: kind 校验、参数逐个透传 service.writeOne，业务失败不抛异常', async (t) => {
  const { registered, fake } = install(t);
  const def = registered.get('zentao_update_status');

  const bad = await def.execute({ kind: 'story', id: 1, action: 'start' }); // kind 合法，action 由 service 裁决
  assert.deepEqual(bad, { ok: true, id: 1, action: 'start', message: '保存成功' });
  assert.equal(fake.calls.writeOne[0].kind, 'story');

  const noKind = await def.execute({ id: 1, action: 'resolve' });
  assert.equal(noKind.ok, false);
  assert.match(noKind.message, /kind 必须是/);

  const ok = await def.execute({
    kind: 'bug', id: 9, action: 'resolve',
    comment: '已修复', resolution: 'fixed', resolvedBuild: 'trunk', assignedTo: 'demo',
  });
  assert.deepEqual(ok, { ok: true, id: 9, action: 'resolve', message: '保存成功' });
  assert.deepEqual(fake.calls.writeOne.at(-1), {
    kind: 'bug', id: 9, action: 'resolve',
    comment: '已修复', resolution: 'fixed', resolvedBuild: 'trunk', assignedTo: 'demo',
  });

  // service 以 {ok:false} 表示业务失败：工具原样上报，不抛异常
  const denied = install(t, { writeOneResult: { ok: false, message: '当前账号没有该操作权限' } });
  const r = await denied.registered.get('zentao_update_status').execute({ kind: 'bug', id: 3, action: 'close' });
  assert.deepEqual(r, { ok: false, id: 3, action: 'close', message: '当前账号没有该操作权限' });
  assert.match(denied.registered.get('zentao_update_status').output.render({}, r)[0].text, /更新失败 #3/);
});

test('zentao_write_back: items 映射到 service.writeBack（默认 comment），okCount/failCount 汇总', async (t) => {
  const { registered, fake } = install(t);
  const def = registered.get('zentao_write_back');

  const r = await def.execute({
    items: [
      { kind: 'bug', id: '1', comment: '备注', resolution: 'fixed', resolvedBuild: 'trunk', assignedTo: 'demo' },
      { kind: 'task', id: 2, action: 'finish' },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.okCount, 2);
  assert.equal(r.failCount, 0);
  assert.equal(r.results.length, 2);
  assert.equal(r.message, '2/2 条成功');
  assert.equal(fake.calls.writeBack.length, 1);
  const [mapped] = fake.calls.writeBack[0];
  assert.equal(mapped.kind, 'bug');
  assert.equal(mapped.id, 1, 'id 转数字');
  assert.equal(mapped.action, 'comment', '缺省动作是 comment');
  assert.equal(mapped.comment, '备注');
  assert.equal(mapped.resolution, 'fixed');
  assert.equal(mapped.resolvedBuild, 'trunk');
  assert.equal(mapped.assignedTo, 'demo');
  const second = fake.calls.writeBack[0][1];
  assert.equal(second.kind, 'task');
  assert.equal(second.id, 2);
  assert.equal(second.action, 'finish');

  const rendered = def.output.render({}, r)[0].text;
  assert.match(rendered, /回写完成：成功 2 条，失败 0 条/);
  assert.match(rendered, /✓ #1 comment/);
});

test('zentao_write_back: 部分失败 → ok:false 且逐条结果保留；空白/超量/缺 kind 整批拒绝', async (t) => {
  const partial = install(t, {
    writeBackResult: (items) => ({
      results: items.map((it, i) => ({
        kind: it.kind,
        id: it.id,
        action: it.action,
        ok: i === 0,
        message: i === 0 ? '保存成功' : '禅道拒绝保存',
      })),
      okCount: 1,
      failCount: items.length - 1,
    }),
  });
  const def = partial.registered.get('zentao_write_back');
  const r = await def.execute({ items: [{ kind: 'bug', id: 1, action: 'comment' }, { kind: 'bug', id: 2, action: 'resolve' }] });
  assert.equal(r.ok, false, '有失败条目时整批 ok:false');
  assert.equal(r.okCount, 1);
  assert.equal(r.failCount, 1);
  assert.equal(r.results[1].message, '禅道拒绝保存');
  const rendered = def.output.render({}, r)[0].text;
  assert.match(rendered, /成功 1 条，失败 1 条/);
  assert.match(rendered, /✗ #2 resolve/);

  const { registered, fake } = install(t);
  const d = registered.get('zentao_write_back');
  const empty = await d.execute({ items: [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.message, 'items 为空');
  assert.equal(fake.calls.writeBack.length, 0);

  const tooMany = await d.execute({
    items: Array.from({ length: 51 }, (_, i) => ({ kind: 'bug', id: i + 1, action: 'comment' })),
  });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.message, /一次最多回写 50 条/);
  assert.equal(fake.calls.writeBack.length, 0);

  const badKind = await d.execute({ items: [{ kind: 'bug', id: 1 }, { kind: 'epic', id: 2 }] });
  assert.equal(badKind.ok, false);
  assert.match(badKind.message, /第 2 条（id=2）/);
  assert.match(badKind.message, /kind 必须是 bug \/ task \/ story/);
  assert.equal(fake.calls.writeBack.length, 0, '含非法 kind 时整批拒绝，不猜类型');
});

test('zentao_item_detail: 只有非图片附件在 saveDir 下落盘，图片附件不下载；失败回传 saveError', async (t) => {
  const { registered, fake } = install(t);
  const def = registered.get('zentao_item_detail');

  const noDir = await def.execute({ kind: 'bug', id: 1 });
  assert.equal(noDir.ok, true);
  assert.equal(noDir.title, '详情标题');
  assert.equal(noDir.desc, '描述文字');
  assert.equal(noDir.steps, '重现步骤');
  assert.deepEqual(noDir.images, [{ url: 'http://x/file-read-25509.png', name: '25509.png' }]);
  assert.deepEqual(noDir.commentImages, [{ url: 'http://x/file-read-25510.png', name: '25510.png' }]);
  assert.equal(noDir.files.length, 3);
  assert.equal(noDir.files[0].localPath, undefined);
  assert.equal(fake.calls.downloadFile.length, 0, '没传 saveDir 不应下载附件');
  assert.deepEqual(fake.calls.detail, [{ kind: 'bug', id: 1 }]);

  const withDir = await def.execute({ kind: 'bug', id: 1, saveDir: '  C:/work  ' });
  assert.equal(withDir.files[0].localPath, 'C:/work/.zentao-attachments/报表.xlsx');
  assert.equal(withDir.files[1].localPath, undefined, 'png 属图片附件，不落盘');
  assert.equal(withDir.files[2].localPath, 'C:/work/.zentao-attachments/说明.txt');
  assert.deepEqual(fake.calls.downloadFile, [
    { url: 'http://x/file-read-3001.xlsx', dir: 'C:/work', name: '报表.xlsx' },
    { url: 'http://x/file-read-3002.txt', dir: 'C:/work', name: '说明.txt' },
  ]);
  const rendered = def.output.render({}, withDir)[0].text;
  assert.match(rendered, /已保存到 C:\/work\/\.zentao-attachments\/报表\.xlsx/);

  const failing = install(t, { downloadFileError: '禅道返回的是页面而不是文件' });
  const failed = await failing.registered.get('zentao_item_detail').execute({ kind: 'bug', id: 1, saveDir: 'C:/work' });
  assert.equal(failed.ok, true, '附件下载失败不应让整条详情失败');
  assert.equal(failed.files[0].saveError, '禅道返回的是页面而不是文件');
  assert.match(failing.registered.get('zentao_item_detail').output.render({}, failed)[0].text, /下载失败：禅道返回的是页面而不是文件/);
});
