# dsh-zentao-ai-workbench（禅道 AI 工作台）

DeepSeek Harness（DSH）插件：把禅道列表页变成一条 AI 处理流水线。

**输入禅道链接 → 读取该页条目 → 多选 → 加入已有会话或新建会话 → AI 处理 → AI 直接回写备注与状态。**
全流程不需要再人工登录禅道改状态。

```
禅道浏览页 URL ──► 工作台面板（10 条/页，多选）
                      │  ①「加入当前会话」：上下文进草稿，检查后发送
                      │  ②「新建会话并处理」：新会话 + 自动发送
                      ▼
                  DSH Agent 逐条处理
                      │  zentao_add_comment / zentao_update_status / zentao_write_back
                      ▼
              禅道「历史记录」出现结论备注，状态变为 已解决 / 已关闭 …
```

## 安装

```bash
# 由 DSH 的 plugin_manager 安装（当前 profile）：
#   action: install_bundle, target: <本目录绝对路径>
```

安装后在左侧栏出现「禅道AI」图标，点开即是主面板。插件包含 host 半边（协议/写回/工具）与
client 半边（面板），与已安装的 `dsh-zentao-panel` 同构但**可写**。

## 首次使用

1. 首次启动会自动从 `~/.dsh/zentao-panel/config.json` 导入账号与登录 cookie（已经装过禅道面板就不必再输密码）。
2. 没有旧配置时，点面板右上角「登录禅道」，填实例地址（如 `http://zentao.example.com/zentao`）、账号、密码。
   - 密码以 base64 存在 `~/.dsh/zentao-ai-workbench/config.json`（0600 权限）；cookie 失效时用密码静默重登。
3. 粘贴禅道浏览页链接，例如
   `http://zentao.example.com/zentao/bug-browse-1-all-assigntome-0-id_desc-10-20.html`，点「读取」。

> 链接规则：只接受与已登录实例同源、同子路径（如 `/zentao`）下的浏览页链接；
> host 会把它转成同地址的 `.json` 接口取数（这是禅道的原生数据接口，等价于页面渲染的数据源）。

## 面板用法

- **多选**：勾选要处理的条目（支持全选/反选、搜索、展开看描述与截图缩略）。
- **写指令**：底部指令框默认「逐条分析并处理…处理完成后调用 zentao_add_comment 写备注、
  zentao_update_status 更新状态」；可存模板 chip 复用。
- **加入当前会话**：把所选条目渲染成 Markdown 上下文（标题/状态/负责人/描述/步骤 + 图片提示）写入当前会话草稿，
  截图会作为真实图片附件一起挂上；检查后自己按发送。
- **新建会话并处理**：新建会话（继承当前工作目录）→ 填入上下文与图片 → 自动发送，面板不跳转。
- **回写禅道**：弹出的回写层里为每条选择动作（只加备注 / 已解决 / 已关闭 / 重新激活 / 任务开始/完成…）
  并填备注，一次提交；结果逐条显示，成功后自动刷新列表状态。
- **复制上下文**：任何情况下都能把上下文复制到剪贴板（服务缺失时的兜底）。

## 模型能看到什么

选中条目下发时，下面这些内容会一起进入会话，模型不需要再登录禅道：

| 内容 | 是否带入 |
| --- | --- |
| 标题、状态、优先级、严重程度、指派、模块、链接 | ✅ 纯文本 |
| 描述 / 重现步骤文字 | ✅ 纯文本 |
| 描述里的截图 | ✅ 真实图片附件（模型看得见图） |
| **下面的备注 / 历史记录文字** | ✅ 最近 30 条（更早的只注明条数） |
| **备注里的截图** | ✅ 真实图片附件（与描述图合并去重，上限 24 张） |
| **条目附件里的图片** | ✅ 真实图片附件 |
| **条目附件里的其它文件**（xlsx/docx/zip…） | ✅ 自动下载到目标会话目录 `.zentao-attachments/`，上下文里给出本地路径，模型可用文件工具直接读 |

AI 主动用 `zentao_item_detail` 复核时同样能拿到备注文字、备注图地址与附件列表（传 `saveDir` 还会顺手把附件落到该目录）。

> 实测提醒：禅道对无权限/已删除的文件会返回一个 HTML 提示页而不是报错，插件会识别并明确报告「未保存」，不会把假文件喂给模型。

## Agent 工具（AI 自动回写）

| 工具 | 用途 |
| --- | --- |
| `zentao_list_items` | 按浏览链接复核条目列表 |
| `zentao_item_detail` | 读取单条描述/步骤/最近动态/备注图/附件（可传 `saveDir` 落盘附件） |
| `zentao_add_comment` | 写备注到「历史记录」 |
| `zentao_update_status` | 状态流转（bug: resolve/close/activate；task: start/finish/close/cancel/pause/activate；story: close/activate） |
| `zentao_write_back` | 批量回写：多条的备注+状态一次提交，单条失败不影响其它 |

工具失败返回 `{ok:false, message}`（不抛异常），模型能读到禅道原话（例如「当前账号没有该操作权限」）再决定下一步。

## 写回的协议依据（实测）

- 备注：`GET action-comment-{kind}-{id}.html` 取隐藏 `uid` → `POST` 同地址（`actioncomment=<p>…</p>` + `uid`）。
- 状态：`GET {kind}-{action}-{id}.html` 读表单默认值（hidden input + picker defaultValue + 编辑器字段名）
  → 合并覆盖项 → `POST` 同地址。`resolve` 必填 `resolution`（默认 `fixed`）。回执形如
  `{"result":"success","message":"保存成功"}`。
- 列表：浏览页 `.html` → `.json`，双层信封 `{status,data}`；bug 是 dict，task/story 可能是数组。
- 详情：`GET /api.php/v1/{bugs|tasks|stories}/{id}`（cookie 鉴权）。

## 已知限制

- 任务/需求的状态表单已在真实实例上读取并核对字段（task 的 start/finish/close/activate、story 的 activate 表单
  均能正确解析出 `finishedDate` / `realStarted` / `assignedTo` 等默认值），但**真的 POST 写回尚未实测**——
  首次使用建议按下面「真机试跑」对自己建的测试条目各跑一次。
  另外禅道的写权限是按动作授予的：本机实测的账号就没有 `story-close` 权限（禅道 302 到
  `user-deny-story-close.html`，插件会明确报「没有 close 权限」，不会假装成功）。
- 当前账号若没有某动作权限（如删除），禅道会拒绝，插件会把原话回显，不会假装成功。
- 一次选中超过 20 条时，面板只自动并发拉取前 20 条的详情（其余用列表摘要下发，不带备注与图片）；
  要拿到全部内容，可以展开单条、分批处理，或让 AI 用 `zentao_item_detail` 复核单条。
- 面板视觉需要在 DSH Web UI 里人工确认（自动化只能验证 slot 注册与资源）。
- **热重载注意**：本插件用 webServer 前缀路由 `/dsh-zentao-ai-workbench` 承载面板 RPC，而
  webServer 的 `(kind, path)` 是唯一键。若在 DSH 运行中反复改代码触发热重载后出现
  「duplicate prefix route」，插件会沿用上一代同名路由并打 warn（功能不变），
  重启一次 DSH 即彻底清理。首次安装或改完代码后重启 DSH 是最干净的做法。

## 数据与隐私

- 账号/密码/cookie 只存在本机 `~/.dsh/zentao-ai-workbench/config.json`（权限 0600），不上传任何第三方。
- 禅道图片通过 host 用登录态下载后再作为 DSH 附件，不经过外部图床。
- 写回是**真实写操作**，会出现在禅道历史记录并可能通知同事，请确认 AI 结论后再让它回写。

## 开发与自测

代码结构：

```
lib/index.js          插件入口（注册 RPC + Agent 工具）
lib/zentao-client.mjs 禅道协议：登录 / 列表 .json / v1 详情 / 表单解析式写回 / 图片与附件下载
lib/service.mjs       多账号会话、缓存、静默重登、批量回写、附件落盘
lib/rpc.mjs           loopback RPC 通道（面板 ⇄ host）
lib/tools.mjs         5 个 Agent 工具
client/client.js      左侧栏图标 + 主面板 + 会话头部按钮（只依赖 react）
locale/               插件展示名与描述
tests/                离线测试：假禅道服务 + node:test（无需 DSH、无需真机、无需账号）
tools/probe-writeback.mjs  真机探针：默认只读干跑，--write 才真写（凭据取自本机配置）
assets/icon-180.png   插件市场卡片图标（GitHub 托管的位图）
```

离线测试（全部跑在本机 127.0.0.1 的假禅道服务上，不连任何真实实例）：

```bash
npm test                                        # = node --test tests/*.test.mjs
node --test --test-isolation=none "tests/*.test.mjs"   # 受限沙箱禁子进程时（spawn EPERM）用同进程模式
```

覆盖：登录握手与 `verifyRand` 两种响应形态、浏览页 `.json` 双层信封（bug dict / task-story dict 与数组两种形态）、
v1 详情与备注图/附件归一、`action-comment` 取 uid + 提交、状态表单「读默认值 → 合并 → POST」、
图片嗅探与「200 但返回 HTML 提示页」的拒绝路径、配置读写与旧面板导入、缓存失效与附件落盘。

### 真机试跑（状态流转）

`tools/probe-writeback.mjs` 用本机已配置的账号跑真实禅道（凭据从 `~/.dsh/zentao-ai-workbench/config.json`
读取，不带任何硬编码账号；**默认只读**，只 GET 表单、不提交）：

```bash
# 1) 拿到自己的条目 id
node tools/probe-writeback.mjs --list task
node tools/probe-writeback.mjs --list story

# 2) 干跑：只读表单，打印解析出的字段与必填项检查（没有任何写操作）
node tools/probe-writeback.mjs --kind task --id <id> --action finish
node tools/probe-writeback.mjs --kind story --id <id> --action activate

# 3) 真写：会进禅道历史记录、可能通知同事 —— 只对「自己建的测试条目」做
node tools/probe-writeback.mjs --kind task --id <id> --action finish --comment "ZTAW 写回测试" --write
```

真写结束后探针会用 v1 详情回读 `status` 与最近动态，确认状态真的变了、备注真的落到「历史记录」。
用它自测或报 issue 都能直接证明「这条链路在你的实例上通不通」。

手动对真实业务条目测试请勿使用 `--write`；面板侧改动需要刷新页面才生效。

## 协议依据（实测记录）

- 登录：`GET user-login.html` 种 session → `GET user-refreshRandom.html` 取 verifyRand →
  `POST user-login.html`，密码 `md5(md5(pw)+rand)`，必须带一组 jQuery 风格请求头。
- 列表：浏览页 URL 的 `.html` 换成 `.json`，双层信封 `{status,data}`（`data` 是字符串需二次解析）。
- 详情：`/api.php/v1/{bugs|tasks|stories}/{id}`（cookie 鉴权）。
- 备注：`GET action-comment-{kind}-{id}.html` 取隐藏 `uid` → `POST` 同地址。
- 状态：`GET {kind}-{action}-{id}.html` 读表单默认值 → 合并覆盖项 → `POST` 同地址。
- 坑位（都已在代码里处理）：cookie 删除指令（`tab=deleted` / `Max-Age=0`）、
  表单 `action` 自带子路径前缀、会话失效有多种形态（302 / 401 / HTTP 200 + 登录信封）、
  无权限或已删文件返回 HTTP 200 的 HTML 提示页。
