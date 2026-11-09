# dsh-zentao-ai-workbench — 内部接口契约（v1，Lead 定义，禁止单方面修改）

> 禅道 AI 工作台：输入禅道 Bug 列表链接 → 读取条目 → 多选 → 加入已有/新会话交给 AI →
> AI 处理完通过工具回写备注与状态，不再需要人工登录禅道。
>
> 本文件是 client 半边、host 半边、验证脚本之间的唯一接口约定。
> 实现若发现契约有误，先发消息给 lead，由 lead 更新本文件。

## 0. 目录与写入范围（并行开发，勿越界）

| 归属 | 写入范围 |
| --- | --- |
| lead | `lib/**`、`package.json`、`cordis.patch.yml`、`locale/**`、`icon.svg`、`README.md`、`CONTRACT.md` |
| client-dev | `client/**` |
| verifier | `verify/**` |

## 1. 插件包

- 包名 `dsh-zentao-ai-workbench`（目录 `/Users/bing/Documents/workspeace/dsh-zentao-ai-workbench`）。
- host 入口 `lib/index.js`，`export function apply(ctx, config)`，`export const inject = ['tools']`（webServer/connection 懒取，不写进 inject）。
- client 入口 `client/client.js`，`dsh.client` 声明装载，`platform: 'web'`。
- 配置文件（host 运行时写）：`~/.dsh/zentao-ai-workbench/config.json`（首次启动自动从
  `~/.dsh/zentao-panel/config.json` 导入账号与 cookie）。

## 2. RPC 通道（client → host）

- 通道名：`/dsh-zentao-ai-workbench`
- client 调用：`ctx.connection.rpc.call('/dsh-zentao-ai-workbench', endpoint, payload)` → Promise
- 返回信封：成功 `{ ok: true, value: <T> }`；失败 `{ ok: false, error: { code, message, details? } }`

### 端点

| endpoint | payload | value |
| --- | --- | --- |
| `status` | `{}` | `Status` |
| `login` | `{baseUrl, account, password}` | `Status` |
| `logout` | `{id?}` | `Status` |
| `list` | `{url, refresh?}` | `ListResult` |
| `detail` | `{kind, id}` | `Detail` |
| `comment` | `{kind, id, text}` | `{message}` |
| `writeback` | `{items: WriteItem[]}` | `{results: WriteResult[]}` |
| `image` | `{url}` | `{name, mediaType, base64, bytes}` |
| `savefile` | `{url, dir, name?}` | `{path, name, bytes}`（附件落盘到 `dir/.zentao-attachments/`；`name` 用于保留真实文件名） |

```ts
type Kind = 'bug' | 'task' | 'story'

interface Status {
  configured: boolean
  baseUrl: string
  account: string
  alias: string
  loggedIn: boolean
  lastUrl: string
  accounts: Array<{id: string, baseUrl: string, account: string, alias: string, loggedIn: boolean}>
}

interface Card {
  kind: Kind
  id: number
  title: string
  status: string          // 禅道原始状态：active/resolved/closed/wait/doing/done...
  pri: number | null
  severity: number | null // 仅 bug
  assignedTo: string
  openedBy: string
  openedDate: string
  moduleTitle: string
  productName: string
  deadline: string
  url: string             // 禅道网页详情地址
  descBrief: string       // 纯文本摘要（≤300 字）
  images: Array<{url: string, name: string}>  // 已归一成可下载绝对地址
}

interface ListResult {
  url: string
  kind: Kind
  title: string           // 禅道页面标题（如「示例产品-Bug」）
  pager: {total: number, page: number, perPage: number}
  items: Card[]
}

interface Detail extends Card {
  desc: string            // 纯文本（含 [图片：xxx.png] 占位）
  steps: string           // bug 的重现步骤纯文本
  actions: Array<{actor: string, action: string, date: string, desc: string, comment: string, images: Array<{url: string, name: string}>}>
  commentImages: Array<{url: string, name: string}>   // 所有备注/回复里的图片（与描述图分开，client 合并去重）
  files: Array<{id: number|null, name: string, ext: string, size: number|null, url: string}> // 条目附件（可能为空）
}
```

**「模型能不能看到」的覆盖口径（v2，2026-11-09 增补，均已真机实测数据形态）**：

| 内容 | 来源 | 是否自动喂给模型 |
| --- | --- | --- |
| 标题/状态/优先级/负责人/模块/链接 | Card | ✅ 上下文 Markdown |
| 描述 / 重现步骤文字 | `desc` / `steps` | ✅ |
| 描述里的图片 | `images` | ✅ 真实图片附件（vision 可见） |
| **下面的备注/历史记录文字** | `actions[].comment`/`desc` | ✅ v2 起进上下文（尾部 ≤30 条/条） |
| **备注里的图片** | `commentImages` | ✅ v2 起作为真实图片附件（与描述图合并去重，≤24 张） |
| **条目附件（图片类）** | `files[]` | ✅ 作为图片附件 |
| **条目附件（非图片）** | `files[]` | ✅ RPC `savefile` 落盘到目标会话 cwd 的 `.zentao-attachments/`，上下文给出本地路径供模型用文件工具读 |
| 无权限/已删除文件 | — | 禅道 200 返回 HTML 提示页，host 识别并报错，绝不存成假附件 |

interface WriteItem {
  kind: Kind
  id: number
  action: 'comment' | 'resolve' | 'close' | 'activate' | 'start' | 'finish' | 'cancel' | 'pause'
  comment?: string        // 纯文本或简单 HTML，host 会包成 <p>
  resolution?: string     // 仅 resolve，默认 'fixed'
  resolvedBuild?: string  // 仅 resolve，默认 'trunk'
  assignedTo?: string     // 可选，禅道账号
}

interface WriteResult { kind: Kind, id: number, action: string, ok: boolean, message: string }
```

能力矩阵（host 实现，client 据此渲染下拉；host 是超集，client 少渲染个别动作不影响写回）：

- `bug`：`comment`（写备注）、`resolve`（已解决）、`close`（已关闭）、`activate`（重新激活）
- `task`：`comment`、`start`（开始）、`finish`（完成）、`close`（关闭）、`cancel`（取消）、`pause`（暂停）、`activate`（重新激活）
- `story`：`comment`、`close`、`activate`

## 3. Host 服务方法（lib/service.mjs 导出）

```js
createZentaoWorkbenchService({logger, cacheTtlMs}) => {
  init(),                              // 启动恢复配置（含从 zentao-panel 导入）
  configure({baseUrl, account, password, alias}), // upsert + 激活
  ensureLogin(),                       // cookie 失效用本机密码静默重登
  status(),
  listFromUrl({url, refresh}),         // 解析浏览页 URL → ListResult
  detail({kind, id}),
  comment({kind, id, text}),
  writeBack({items}),                  // 批量，逐条返回结果，不因单条失败中断
  writeOne({kind, id, action, ...}),
  fetchImage({url}),
  logout(id),
}
```

RPC 层与 Agent 工具（`lib/tools.mjs`）都只调用上述方法，**不允许有第二套业务逻辑**。

## 4. Agent 工具（host 注册，供 AI 处理完自动回写）

| 工具名 | 参数 | 说明 |
| --- | --- | --- |
| `zentao_list_items` | `{url, kind?}` | 按禅道浏览链接拉取条目（AI 需要复核时用） |
| `zentao_item_detail` | `{kind, id, saveDir?}` | 单条详情（描述/步骤/最近动态/备注图/附件）；传 `saveDir` 时非图片附件落盘并返回 `localPath` |
| `zentao_add_comment` | `{kind, id, comment}` | 添加备注，返回禅道回执 |
| `zentao_update_status` | `{kind, id, action, comment?, resolution?, resolvedBuild?, assignedTo?}` | 更新状态（resolve/close/activate/start/finish/...） |
| `zentao_write_back` | `{items: WriteItem[]}` | 批量回写：多选条目的备注+状态一次提交 |

工具执行成功返回 `{ok:true, ...}`；失败返回 `{ok:false, message}`，不抛异常给模型。
注入到会话的上下文文本末尾必须提示模型：处理完成后调用 `zentao_add_comment` / `zentao_update_status`
（或批量 `zentao_write_back`）把结论写回禅道。

## 5. Client 半边要求

装载形态（与已安装的 dsh-zentao-panel 相同，已在本机 DSH 0.2.2-rc.1 验证的写法）：

```js
(function (root) {
  if (!root || !root.__ModuleLoader__) return
  root.__ModuleLoader__.load({ id: 'dsh-zentao-ai-workbench', factory: (require) => {
    const React = require('react')            // 只 require react
    ...
    exports.name = 'dsh-zentao-ai-workbench'
    exports.inject = ['slots', 'connection']
    exports.apply = apply
    return module.exports
  }})
})(typeof window !== 'undefined' ? window : globalThis)
```

- 只允许 `require('react')`；**禁止** require 任何 `@deepseek-ai/*` 客户端包。
- 样式只用 DSH 语义 token（`--dsw-alias-*`），自绘控件，样式以 `<style>` 注入，class 前缀 `ztaw-`。

### UI（左侧栏 + 主面板）

`sidebar.panellist`：`{id:'zentao-ai', order:33, label:'禅道AI'}`，图标组件收 `{size, active}`。
`main` keyed slot：`{name:'main', key:'zentao-ai'}`。

面板功能（自上而下）：

1. 标题行：禅道AI工作台 · 当前账号/实例 · 连接状态点；`设置/登录` 按钮（baseUrl + 账号 + 密码）。
2. 链接行：输入框（默认填上次的 URL，首次给示例
   `http://zentao.example.com/zentao/bug-browse-1-all-assigntome-0-id_desc-10-20.html`）+「读取」按钮。
3. 工具行：全选/反选、已选 n/total、搜索框、「刷新状态」。
4. 列表：复选框 + `#id` + 标题 + 状态标签 + 负责人 + 严重程度；展开可看详情（描述/步骤/图片缩略）。
5. 指令区：多行输入（默认「请逐条分析并处理所选 Bug：定位原因、给出修复方案；处理完成后调用
   zentao_add_comment 写备注，并用 zentao_update_status 更新状态。」）+ 模板 chip（本地存储，≤8 条）。
6. 动作区：
   - `加入当前会话`：把上下文写入当前会话草稿（`conversation.input.for(scope).setDraft`），
     附件图片走 `conversation.createDrafts` + `facade.addAttachments`；不可用时降级 DOM composer → 剪贴板。
   - `新建会话并处理`：`sessions.create({cwd})` → `retain` → `scope` → 填草稿 + 附件 → `submit()` 自动发送；
     若 `conversation`/`sessions` 服务缺失则降级到 `uiWorkspace.startSession()` + 剪贴板提示。
   - `回写禅道`：打开回写弹层。
   - `复制上下文`：剪贴板兜底。
7. 回写弹层：列出所选条目，每条一个动作下拉 + 备注文本域（默认模板「AI 已处理：#id 标题 —— 结论：」）；
   「全部提交」调 `writeback`，逐条显示 ok/失败原因；成功后自动 `list` 刷新状态。
8. 底部状态条：最近一次操作的提示（读取 n 条 / 写入结果 / 服务降级原因）。

会话上下文 Markdown 结构（`buildContext(items, instruction)`）：

```
# 禅道 Bug 处理任务（YUNTI 链接）
共 3 条，来自 <url>

## 1. #13711 标题
- 状态：active · 优先级：3 · 严重程度：3 · 指派：张三 · 模块：xxx
- 链接：<url>
- [图片（描述）：25509.png]
- [图片（备注）：25510.png]
- [图片（附件）：25511.png]
- 附件：报表.xlsx（已保存到 <cwd>/.zentao-attachments/报表.xlsx，可用文件工具读取）
### 描述/重现步骤
<desc 纯文本>

### 备注与历史记录
- 2026-11-09 21:26:46  李四 创建。
- 2026-11-09 21:27:03  张三 备注：已定位到 xxx，改法是 yyy

（全部图片同时作为真实图片附件挂到消息上；备注/历史记录取尾部 ≤30 条，
更早的只注明条数；无 cwd 或下载失败时附件退化成「文件名 + 链接」并说明原因）

## 处理要求
<instruction>

## 回写要求（重要）
处理完成后，必须对每条使用工具回写禅道，无需人工登录：
- 备注：`zentao_add_comment`
- 状态：`zentao_update_status`（action: resolve/close/activate）
- 多条：`zentao_write_back`
```

### 会话服务用法（参照 dsh-zentao-panel，服务缺失必须降级而非报错）

```js
const sessions = appCtx.get('sessions') ?? null
const conversation = appCtx.get('conversation') ?? null
const snap = sessions?.list?.getSnapshot?.()          // 新版有 current；旧版用 byId[*].retainedBy.mainView
const scope = sessions?.scope?.(sessionId)
const facade = scope ? conversation?.input?.for(scope) : null
facade.setDraft(text); facade.addAttachments(ids); facade.submit()
```

另外注册 `conversation.session.header.actions`（id `zentao-ai`, order 50）：一个「禅道AI」按钮，
点开主面板并把当前 `sessionId` 记进模块级变量，供「加入当前会话」精确复用。

## 6. 禅道协议（已实测，2026-11-09）

- 登录：`GET user-login.html` → `GET user-refreshRandom.html`(XHR) 取 verifyRand →
  `POST user-login.html`（`password=md5(md5(pw)+rand)`，必须带 jQuery 风格头：`X-Requested-With`、
  `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`、`Accept: application/json...`、
  `Referer`、`Origin`、浏览器 UA）。成功得长期 cookie `za`/`zp`/`keepLogin`。
- 列表：把浏览页 URL 的 `.html` 换成 `.json` 直接 GET（同 cookie），双层 JSON
  `{status:'success', data:'<json字符串>'}`；解出后取 `bugs|tasks|stories`（bug 是 dict，其余可能是数组）。
- 详情：`GET /api.php/v1/{bugs|tasks|stories}/{id}`（cookie 鉴权，复数路径）。
- 备注：`GET action-comment-{kind}-{id}.html` 取 `uid` →
  `POST action-comment-{kind}-{id}.html`，字段 `actioncomment=<p>文本</p>` + `uid`。
- 状态：`GET {kind}-{action}-{id}.html` 解析表单默认值（hidden input + `zui-create-picker` 的
  `defaultValue` + `zen-editor` 的 name）→ 合并覆盖项 → `POST` 同一地址（带 `uid`）。
  resolve 必填 `resolution`；实测 `resolution=fixed&resolvedBuild=trunk&assignedTo=demo&comment=...` 返回
  `{"result":"success","message":"保存成功"}`；close 只需 `comment+uid`。
- 图片下载：`GET /file-read-{name}`（登录态 cookie），用于真实图片附件。

## 7. 验收标准

1. 面板可输入题目给的链接并读出 10 条 Bug（标题/ID/状态/负责人正确）。
2. 多选 2+ 条后能插入当前会话草稿，或新建会话并自动发送；上下文含标题、状态、描述/步骤、图片提示。
3. `zentao_add_comment` / `zentao_update_status` / `zentao_write_back` 三个工具在真实实例上可用
   （备注出现在「历史记录」，状态真实流转）。
4. 面板「回写禅道」弹层可批量提交并显示逐条结果，提交后刷新能看到新状态。
5. 未配置/会话失效时给出明确提示，不出现空白面板或静默失败。
