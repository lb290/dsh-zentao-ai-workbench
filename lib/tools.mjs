// dsh-zentao-ai-workbench — Agent 工具（host 半边）
//
// 目的：AI 处理完禅道条目后，自己把「备注 + 状态」写回禅道，不再需要人工登录操作。
// 与 RPC/面板共用同一套 service 方法（CONTRACT 第 3/4 节：一个操作只有一份实现）。
//
// 工具不抛异常：失败返回 {ok:false, message}，让模型能读到原因并决定重试或改参数。

const KIND_ENUM = ['bug', 'task', 'story'];
const IMAGE_FILE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
function isImageFileName(file) {
  const ext = String(file?.ext ?? '').toLowerCase().replace(/^\./, '')
    || (/\.([a-z0-9]+)$/i.exec(String(file?.name ?? ''))?.[1] ?? '').toLowerCase();
  return IMAGE_FILE_EXTS.has(ext);
}
const ACTION_ENUM = ['comment', 'resolve', 'close', 'activate', 'start', 'finish', 'cancel', 'pause'];

const OBJECT_SCHEMA = (props, required = []) => ({
  type: 'object',
  properties: props,
  required,
  additionalProperties: false,
});

const CARD_PROPS = {
  kind: { type: 'string' },
  id: { type: 'integer' },
  title: { type: 'string' },
  status: { type: 'string' },
  pri: { type: 'integer' },
  severity: { type: 'integer' },
  assignedTo: { type: 'string' },
  openedBy: { type: 'string' },
  openedDate: { type: 'string' },
  moduleTitle: { type: 'string' },
  productName: { type: 'string' },
  deadline: { type: 'string' },
  url: { type: 'string' },
  descBrief: { type: 'string' },
  images: { type: 'array', items: OBJECT_SCHEMA({ url: { type: 'string' }, name: { type: 'string' } }, ['url']) },
};

const ACTION_PROPS = {
  actor: { type: 'string' },
  action: { type: 'string' },
  date: { type: 'string' },
  desc: { type: 'string' },
  comment: { type: 'string' },
  images: { type: 'array', items: OBJECT_SCHEMA({ url: { type: 'string' }, name: { type: 'string' } }, ['url']) },
};

function textBlock(text) {
  return [{ type: 'text', text }];
}

function describeCard(card) {
  const bits = [`#${card.id}`, card.title || ''];
  if (card.status) bits.push(`状态 ${card.status}`);
  if (card.assignedTo) bits.push(`指派 ${card.assignedTo}`);
  return bits.join(' · ');
}

/**
 * 注册全部禅道工具。返回 disposer（移除本插件注册的全部工具）。
 * @param {object} ctx host cordis context（需 inject 'tools'）
 * @param {{service:object, log?:object}} deps
 */
export function installZentaoWorkbenchTools(ctx, { service, log = console }) {
  const disposers = [];

  const register = (definition) => {
    const dispose = ctx.tools.register(definition);
    disposers.push(dispose);
    return dispose;
  };

  register({
    name: 'zentao_list_items',
    description:
      '按禅道浏览页链接读取条目列表（Bug/任务/需求）。用于在回写前复核条目当前状态；'
      + '面板已经把所选条目的标题、状态、描述与截图放进上下文时，通常不需要再调它。',
    parameters: OBJECT_SCHEMA({
      url: { type: 'string', description: '禅道浏览页链接，例如 http://host/zentao/bug-browse-52-all-assigntome-0-id_desc-10-20.html' },
      kind: { type: 'string', enum: KIND_ENUM, description: '条目类型；省略时按链接自动判断' },
    }, ['url']),
    output: {
      schema: OBJECT_SCHEMA({
        ok: { type: 'boolean' },
        total: { type: 'integer' },
        kind: { type: 'string' },
        message: { type: 'string' },
        items: { type: 'array', items: OBJECT_SCHEMA(CARD_PROPS) },
      }, ['ok']),
      render: (_args, value) => {
        if (!value.ok) return textBlock(`读取失败：${value.message ?? '未知错误'}`);
        const lines = (value.items ?? []).map((c) => `- ${describeCard(c)}`);
        return textBlock(`共 ${value.total} 条（${value.kind}）：\n${lines.join('\n')}`);
      },
    },
    async execute(args) {
      try {
        const r = await service.listFromUrl({ url: String(args.url ?? ''), refresh: true });
        return { ok: true, total: r.pager?.total ?? r.items.length, kind: r.kind, items: r.items };
      } catch (err) {
        return { ok: false, total: 0, kind: 'bug', items: [], message: err?.message ?? String(err) };
      }
    },
  });

  register({
    name: 'zentao_item_detail',
    description:
      '读取单条禅道 Bug/任务/需求的完整描述、重现步骤、最近动态（含同事备注文字与备注里的图片地址）和附件列表。'
      + '传入 saveDir 时，条目里的非图片附件会被下载到该目录下，返回本地路径供你用文件工具直接读取。',
    parameters: OBJECT_SCHEMA({
      kind: { type: 'string', enum: KIND_ENUM, description: '条目类型' },
      id: { type: 'integer', description: '条目 ID' },
      saveDir: { type: 'string', description: '可选：非图片附件的保存目录（通常是当前会话工作目录）。不传则只列出附件地址。' },
    }, ['kind', 'id']),
    output: {
      schema: OBJECT_SCHEMA({
        ok: { type: 'boolean' },
        message: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string' },
        desc: { type: 'string' },
        steps: { type: 'string' },
        assignedTo: { type: 'string' },
        url: { type: 'string' },
        images: { type: 'array', items: OBJECT_SCHEMA({ url: { type: 'string' }, name: { type: 'string' } }) },
        commentImages: { type: 'array', items: OBJECT_SCHEMA({ url: { type: 'string' }, name: { type: 'string' } }) },
        files: { type: 'array', items: OBJECT_SCHEMA({ name: { type: 'string' }, url: { type: 'string' }, ext: { type: 'string' }, size: { type: 'integer' }, localPath: { type: 'string' }, saveError: { type: 'string' } }) },
        actions: { type: 'array', items: OBJECT_SCHEMA(ACTION_PROPS) },
      }, ['ok']),
      render: (_args, value) => {
        if (!value.ok) return textBlock(`读取失败：${value.message ?? '未知错误'}`);
        const head = `#${value.title ?? ''}（${value.status ?? ''}）\n${value.url ?? ''}`;
        const body = value.steps || value.desc || '';
        // 备注优先；没备注时禅道的 desc 形如「2026-11-09 21:26:46, 由 张三 创建。」，
        // 时间/人名下面已单独渲染，先剥掉再拼，避免一行里出现两遍。
        const actionText = (a) => {
          const comment = String(a.comment ?? '').trim();
          if (comment) return comment;
          let text = String(a.desc ?? '').trim()
            .replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?,?\s*/, '')
            .trim();
          const who = String(a.actor ?? '').trim();
          if (who) text = text.replace(new RegExp(`^由\\s*${who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`), '').trim();
          return text || String(a.action ?? '');
        };
        const acts = (value.actions ?? []).slice(-5).map((a) => `- ${a.date || ''} ${a.actor || ''} ${actionText(a)}`.replace(/\s+/g, ' '));
        const extra = [
          `描述图 ${(value.images ?? []).length} 张`,
          `备注图 ${(value.commentImages ?? []).length} 张`,
          `附件 ${(value.files ?? []).length} 个`,
        ].join(' · ');
        const atts = (value.files ?? []).map((f) => (f.localPath
          ? `- 附件：${f.name}（已保存到 ${f.localPath}，可用文件工具读取）`
          : `- 附件：${f.name}${f.saveError ? `（下载失败：${f.saveError}）` : (f.url ? `（${f.url}）` : '')}`));
        return textBlock([head, extra, body, atts.join('\n'), acts.length ? `最近动态：\n${acts.join('\n')}` : ''].filter(Boolean).join('\n\n'));
      },
    },
    async execute(args) {
      try {
        const d = await service.detail({ kind: String(args.kind), id: Number(args.id) });
        const saveDir = typeof args.saveDir === 'string' ? args.saveDir.trim() : '';
        const files = [];
        for (const f of d.files ?? []) {
          const row = { name: f.name, url: f.url, ext: f.ext ?? '', size: f.size ?? 0 };
          if (saveDir && f.url && !isImageFileName(f)) {
            try {
              const saved = await service.downloadFile({ url: f.url, dir: saveDir, name: f.name });
              row.localPath = saved.path;
            } catch (err) {
              row.saveError = err?.message ?? String(err);
            }
          }
          files.push(row);
        }
        return {
          ok: true, title: d.title, status: d.status, desc: d.desc, steps: d.steps,
          assignedTo: d.assignedTo, url: d.url, images: d.images ?? [], actions: d.actions ?? [],
          commentImages: d.commentImages ?? [], files,
        };
      } catch (err) {
        return { ok: false, message: err?.message ?? String(err) };
      }
    },
  });

  register({
    name: 'zentao_add_comment',
    description:
      '在禅道条目下添加备注（写入「历史记录」）。处理完成后用它回报结论；'
      + '多条一起写用 zentao_write_back 更快。',
    parameters: OBJECT_SCHEMA({
      kind: { type: 'string', enum: KIND_ENUM, description: '条目类型，默认 bug' },
      id: { type: 'integer', description: '条目 ID' },
      comment: { type: 'string', description: '备注内容（纯文本即可，支持换行；会转成禅道编辑器接受的 HTML）' },
    }, ['id', 'comment']),
    output: {
      schema: OBJECT_SCHEMA({ ok: { type: 'boolean' }, id: { type: 'integer' }, message: { type: 'string' } }, ['ok']),
      render: (_args, value) => textBlock(value.ok ? `已写入禅道备注 #${value.id}：${value.message}` : `写入失败：${value.message}`),
    },
    async execute(args) {
      const kind = KIND_ENUM.includes(args.kind) ? args.kind : 'bug';
      const id = Number(args.id);
      try {
        const r = await service.comment({ kind, id, text: String(args.comment ?? '') });
        return { ok: true, id, message: r.message ?? '保存成功' };
      } catch (err) {
        return { ok: false, id, message: err?.message ?? String(err) };
      }
    },
  });

  register({
    name: 'zentao_update_status',
    description:
      '更新禅道条目状态并可选写备注。Bug：resolve（已解决，可给 resolution/resolvedBuild）、close（已关闭）、'
      + 'activate（重新激活）；任务：start/finish/close/cancel/pause/activate；需求：close/activate。'
      + '这是真实写操作，会通知相关同事，确认处理完成后再调用。',
    parameters: OBJECT_SCHEMA({
      kind: { type: 'string', enum: KIND_ENUM, description: '条目类型，默认 bug' },
      id: { type: 'integer', description: '条目 ID' },
      action: { type: 'string', enum: ACTION_ENUM, description: '要执行的动作' },
      comment: { type: 'string', description: '随状态变更一起写入的备注（建议写清结论与验证方式）' },
      resolution: { type: 'string', description: '仅 bug resolve：解决方案，如 fixed/bydesign/duplicate/notrepro/willnotfix/postponed；默认 fixed' },
      resolvedBuild: { type: 'string', description: '仅 bug resolve：解决版本，如 trunk 或版本 ID' },
      assignedTo: { type: 'string', description: '可选：指派给某个禅道账号' },
    }, ['id', 'action']),
    output: {
      schema: OBJECT_SCHEMA({ ok: { type: 'boolean' }, id: { type: 'integer' }, action: { type: 'string' }, message: { type: 'string' } }, ['ok']),
      render: (_args, value) => textBlock(value.ok ? `已更新禅道 #${value.id}（${value.action}）：${value.message}` : `更新失败 #${value.id}：${value.message}`),
    },
    async execute(args) {
      const kind = KIND_ENUM.includes(args.kind) ? args.kind : 'bug';
      const id = Number(args.id);
      const action = String(args.action ?? '');
      try {
        const r = await service.writeOne({
          kind, id, action,
          comment: args.comment,
          resolution: args.resolution,
          resolvedBuild: args.resolvedBuild,
          assignedTo: args.assignedTo,
        });
        return { ok: r.ok, id, action, message: r.message };
      } catch (err) {
        return { ok: false, id, action, message: err?.message ?? String(err) };
      }
    },
  });

  register({
    name: 'zentao_write_back',
    description:
      '批量回写禅道：把多条条目的备注与状态一次提交（每条约一条，单条失败不影响其它）。'
      + '面板多选处理后推荐用它收尾。',
    parameters: OBJECT_SCHEMA({
      items: {
        type: 'array',
        description: '要回写的条目列表',
        items: OBJECT_SCHEMA({
          kind: { type: 'string', enum: KIND_ENUM, description: '条目类型，默认 bug' },
          id: { type: 'integer', description: '条目 ID' },
          action: { type: 'string', enum: ACTION_ENUM, description: '动作；只写备注用 comment' },
          comment: { type: 'string', description: '备注内容' },
          resolution: { type: 'string', description: '仅 bug resolve' },
          resolvedBuild: { type: 'string', description: '仅 bug resolve' },
          assignedTo: { type: 'string', description: '可选：指派账号' },
        }, ['id']),
      },
    }, ['items']),
    output: {
      schema: OBJECT_SCHEMA({
        ok: { type: 'boolean' },
        okCount: { type: 'integer' },
        failCount: { type: 'integer' },
        message: { type: 'string' },
        results: {
          type: 'array',
          items: OBJECT_SCHEMA({ kind: { type: 'string' }, id: { type: 'integer' }, action: { type: 'string' }, ok: { type: 'boolean' }, message: { type: 'string' } }),
        },
      }, ['ok']),
      render: (_args, value) => {
        const lines = (value.results ?? []).map((r) => `${r.ok ? '✓' : '✗'} #${r.id} ${r.action}：${r.message}`);
        return textBlock(`回写完成：成功 ${value.okCount ?? 0} 条，失败 ${value.failCount ?? 0} 条\n${lines.join('\n')}`);
      },
    },
    async execute(args) {
      const items = Array.isArray(args.items) ? args.items : [];
      if (!items.length) return { ok: false, okCount: 0, failCount: 0, results: [], message: 'items 为空' };
      try {
        const r = await service.writeBack(items.map((it) => ({
          kind: KIND_ENUM.includes(it?.kind) ? it.kind : 'bug',
          id: Number(it?.id),
          action: String(it?.action ?? 'comment'),
          comment: it?.comment,
          resolution: it?.resolution,
          resolvedBuild: it?.resolvedBuild,
          assignedTo: it?.assignedTo,
        })));
        return { ok: r.failCount === 0, okCount: r.okCount, failCount: r.failCount, results: r.results, message: `${r.okCount}/${r.results.length} 条成功` };
      } catch (err) {
        return { ok: false, okCount: 0, failCount: items.length, results: [], message: err?.message ?? String(err) };
      }
    },
  });

  log.info?.(`dsh-zentao-ai-workbench: 已注册 ${disposers.length} 个禅道工具`);

  return () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* 已清理 */ }
    }
  };
}

export { KIND_ENUM, ACTION_ENUM };
