// dsh-zentao-ai-workbench — client 半边（左侧栏全局面板 + 会话头部入口）
//
// 装载形态与已安装的 dsh-zentao-panel 相同（本机 DSH Desktop 0.2.2-rc.1 验证过的写法）：
// dsh.client 声明 → dsh-client-modules 以 /plugins/dsh-zentao-ai-workbench/client.js 提供
// → window.__ModuleLoader__.load 执行 factory。
//
// 数据通道：ctx.connection.rpc.call('/dsh-zentao-ai-workbench', endpoint, payload)
//   → host 半边 loopback RPC；成功 {ok:true,value}，失败 {ok:false,error:{code,message}}。
//   端点见 CONTRACT.md 第 2 节：status / login / logout / list / detail / comment / writeback / image。
//
// UI 注册（CONTRACT.md 第 5 节）：
//   sidebar.panellist {id:'zentao-ai', order:33, label:'禅道AI'}  ← 左侧栏图标
//   main keyed slot   {name:'main', key:'zentao-ai'}             ← 整块主区域面板
//   conversation.session.header.actions {id:'zentao-ai', order:50} ← 会话头部「禅道AI」按钮
//
// 主题：颜色全部来自 --dsw-alias-* 语义 token（日/夜自动跟随），class 前缀 ztaw-。
// 约束：只 require('react')，不 require 任何 @deepseek-ai/* 客户端包；所有 DSH 服务懒取，
//       任一服务缺失都降级（服务 → DOM composer → 剪贴板），不抛错炸掉 slot。
(function (root) {
  if (!root || !root.__ModuleLoader__ || typeof root.__ModuleLoader__.load !== 'function') return;

  root.__ModuleLoader__.load({
    id: 'dsh-zentao-ai-workbench',
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

      // React 缺失（node 自检环境）时不注册 UI，但纯函数 _test 仍然导出，便于脚本验证。
      var React = null;
      try { React = require('react'); } catch (e) { React = null; }
      var hasReact = !!(React && typeof React.createElement === 'function');
      var h = hasReact ? React.createElement : function () { return null; };
      var useState = hasReact ? React.useState : null;
      var useEffect = hasReact ? React.useEffect : null;
      var useMemo = hasReact ? React.useMemo : null;
      var useRef = (hasReact && React.useRef) || function (init) { return { current: init }; };

      // ───────────────────────── 常量 ─────────────────────────
      var CHANNEL = '/dsh-zentao-ai-workbench';
      var PANEL_ID = 'zentao-ai';
      var OVERLAY_ID = 'dsh-zentao-ai-workbench';
      var EXAMPLE_URL = 'http://zentao.example.com/zentao/bug-browse-1-all-assigntome-0-id_desc-10-20.html';
      var DEFAULT_INSTRUCTION = '请逐条分析并处理所选 Bug：定位原因、给出修复方案；处理完成后调用 zentao_add_comment 写备注，并用 zentao_update_status 更新状态。';
      var TEMPLATES_KEY = 'dsh-zentao-ai-workbench.templates.v1';
      var LAST_URL_KEY = 'dsh-zentao-ai-workbench.lastUrl.v1';
      var INSTRUCTION_KEY = 'dsh-zentao-ai-workbench.instruction.v1';
      var MAX_TEMPLATES = 8;

      var KIND_LABEL = { bug: 'Bug', task: '任务', story: '需求' };
      var STATUS_LABEL = {
        active: '激活', resolved: '已解决', closed: '已关闭', wait: '待处理', doing: '进行中',
        done: '已完成', pause: '已暂停', cancel: '已取消', reviewing: '评审中', draft: '草稿',
        rejected: '已拒绝', investigating: '调研中', postponed: '已延期', suspended: '已挂起',
      };
      var ACTION_LABEL = {
        comment: '仅写备注', resolve: '标记已解决', close: '关闭', activate: '重新激活',
        start: '开始', finish: '完成', cancel: '取消', pause: '暂停',
      };
      /** 禅道历史记录里的 action 名 → 中文（与写回动作用词不同，单独一张表）。 */
      var HISTORY_ACTION_LABEL = {
        opened: '创建', assigned: '指派', resolved: '已解决', closed: '关闭',
        activated: '重新激活', commented: '备注', edited: '编辑', deleted: '删除',
        'restart': '重启', 'confirmed': '确认', 'duplicated': '重复', 'postponed': '延期',
        'started': '开始', 'finished': '完成', 'canceled': '取消', 'paused': '暂停',
        'restarted': '继续', 'changed': '变更', 'reviewed': '评审', 'commented-edit': '编辑备注',
      };
      // 能力矩阵（与 host service.mjs 的 WRITE_ACTIONS 逐项一致，CONTRACT §2）
      // 顺序：备注在最前，日常流转居中，终止动作（关闭/取消）靠后，重新激活放最后。
      var KIND_ACTIONS = {
        bug: ['comment', 'resolve', 'close', 'activate'],
        task: ['comment', 'start', 'finish', 'pause', 'cancel', 'close', 'activate'],
        story: ['comment', 'close', 'activate'],
      };

      // ───────────────────────── 样式（只用 --dsw-alias-* 语义 token） ─────────────────────────
      var CSS = [
        '.ztaw-main{position:relative;height:100%;min-height:0;display:flex;flex-direction:column;flex:auto;box-sizing:border-box;padding-top:var(--dsh-frame-top-clearance,0px);}',
        '.ztaw-dragband{position:absolute;left:0;right:0;top:0;height:var(--dsh-frame-top-clearance,0px);z-index:3;}',
        '.ztaw-root{position:relative;height:100%;min-height:0;display:flex;flex-direction:column;flex:auto;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;}',

        // 标题行
        '.ztaw-mast{flex:none;display:flex;align-items:center;gap:8px;height:46px;padding:0 12px 0 16px;box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l3);}',
        '.ztaw-mark{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary);flex:none;}',
        '.ztaw-mast-title{font-size:14px;font-weight:600;letter-spacing:.2px;flex:none;}',
        '.ztaw-mast-sub{font-size:11.5px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}',
        '.ztaw-grow{flex:1;min-width:6px;}',
        '.ztaw-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary);}',
        '.ztaw-dot.ok{background:var(--dsw-alias-state-success-primary);}',
        '.ztaw-dot.warn{background:var(--dsw-alias-state-warn-primary);}',
        '.ztaw-dot.err{background:var(--dsw-alias-state-error-primary);}',

        // 按钮 / 输入
        '.ztaw-btn{appearance:none;font:inherit;font-size:12.5px;height:28px;padding:0 12px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:5px;white-space:nowrap;box-sizing:border-box;}',
        '.ztaw-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l4);}',
        '.ztaw-btn:active{background:var(--dsw-alias-interactive-bg-active);}',
        '.ztaw-btn:disabled{opacity:.45;cursor:default;background:transparent;color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l3);}',
        '.ztaw-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent;}',
        '.ztaw-btn-primary:hover{background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-foreground);border-color:transparent;}',
        '.ztaw-btn-primary:disabled{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);opacity:.45;}',
        '.ztaw-btn-sm{height:24px;padding:0 9px;font-size:12px;}',
        '.ztaw-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px;}',

        '.ztaw-input,.ztaw-search,.ztaw-textarea,.ztaw-select{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;outline:none;}',
        '.ztaw-input:hover,.ztaw-search:hover,.ztaw-textarea:hover,.ztaw-select:hover{border-color:var(--dsw-alias-border-l4);}',
        '.ztaw-input:focus,.ztaw-search:focus,.ztaw-textarea:focus,.ztaw-select:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent);}',
        '.ztaw-input{height:30px;padding:0 9px;font-size:12.5px;}',
        '.ztaw-input::placeholder,.ztaw-search::placeholder,.ztaw-textarea::placeholder{color:var(--dsw-alias-label-caption);}',
        '.ztaw-textarea{width:100%;min-height:62px;padding:7px 9px;font-size:12.5px;line-height:1.55;resize:vertical;font-family:inherit;}',
        '.ztaw-select{height:28px;padding:0 6px;font-size:12.5px;cursor:pointer;}',
        '.ztaw-select option{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
        '.ztaw-cbx{width:14px;height:14px;margin:0;flex:none;cursor:pointer;accent-color:var(--dsw-alias-state-business-primary);}',
        '.ztaw-check{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;white-space:nowrap;}',
        '.ztaw-check:hover{color:var(--dsw-alias-label-primary);}',

        // 分段行
        '.ztaw-row{flex:none;display:flex;align-items:center;gap:6px;padding:8px 12px;box-sizing:border-box;}',
        '.ztaw-row-url{border-bottom:.5px solid var(--dsw-alias-border-l2);}',
        '.ztaw-row-tool{border-bottom:.5px solid var(--dsw-alias-border-l2);gap:8px;}',
        '.ztaw-row-tool .ztaw-search{flex:1;min-width:80px;height:28px;padding:0 9px;font-size:12px;}',
        '.ztaw-count{font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;}',

        // 列表
        '.ztaw-list{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;border-bottom:.5px solid var(--dsw-alias-border-l2);}',
        '.ztaw-empty{padding:28px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12.5px;}',
        '.ztaw-item{border-bottom:.5px solid var(--dsw-alias-border-l1);}',
        '.ztaw-item:hover{background:var(--dsw-alias-interactive-bg-hover);}',
        '.ztaw-item.on{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,transparent);}',
        '.ztaw-item-head{display:flex;align-items:center;gap:8px;padding:8px 12px;box-sizing:border-box;}',
        '.ztaw-exp{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);width:18px;height:18px;flex:none;padding:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;border-radius:var(--dsw-radius-sm);}',
        '.ztaw-exp:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary);}',
        '.ztaw-id{font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;}',
        '.ztaw-title{font-size:12.5px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;}',
        '.ztaw-tag{flex:none;font-size:11px;line-height:1;padding:3px 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
        '.ztaw-tag.open{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);}',
        '.ztaw-tag.done{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);}',
        '.ztaw-tag.mid{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);}',
        '.ztaw-owner{flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary);max-width:88px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.ztaw-sev{flex:none;font-size:11px;color:var(--dsw-alias-label-caption);white-space:nowrap;}',

        // 详情展开
        '.ztaw-detail{padding:2px 12px 12px 38px;font-size:12px;color:var(--dsw-alias-label-secondary);}',
        '.ztaw-detail-sec{margin:0 0 6px;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;}',
        '.ztaw-detail-k{font-weight:600;color:var(--dsw-alias-label-tertiary);font-size:11px;margin:8px 0 3px;}',
        '.ztaw-thumbs{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;}',
        '.ztaw-thumb{width:76px;height:56px;object-fit:cover;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-skeleton);}',
        '.ztaw-thumb-ph{width:76px;height:56px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l3);display:flex;align-items:center;justify-content:center;font-size:10.5px;color:var(--dsw-alias-label-caption);text-align:center;padding:2px;box-sizing:border-box;overflow:hidden;}',
        '.ztaw-link{color:var(--dsw-alias-link);text-decoration:none;font-size:11.5px;word-break:break-all;}',
        '.ztaw-link:hover{text-decoration:underline;}',
        '.ztaw-muted{color:var(--dsw-alias-label-caption);font-size:11.5px;}',

        // 指令区 + 动作区 + 状态条
        '.ztaw-instr{flex:none;padding:8px 12px 6px;border-bottom:.5px solid var(--dsw-alias-border-l2);}',
        '.ztaw-chips{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:6px;}',
        '.ztaw-chip{appearance:none;font:inherit;font-size:11px;line-height:1;height:22px;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 9px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;}',
        '.ztaw-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-interactive-bg-hover);}',
        '.ztaw-chip-add{border-style:dashed;color:var(--dsw-alias-label-caption);}',
        '.ztaw-actions{flex:none;display:flex;flex-wrap:wrap;gap:6px;padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);}',
        '.ztaw-statusbar{flex:none;display:flex;align-items:center;gap:7px;padding:8px 12px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);min-height:32px;box-sizing:border-box;}',
        '.ztaw-statusbar .ztaw-txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}',
        '.ztaw-statusbar.ok{color:var(--dsw-alias-state-success-primary);}',
        '.ztaw-statusbar.warn{color:var(--dsw-alias-state-warn-primary);}',
        '.ztaw-statusbar.err{color:var(--dsw-alias-state-error-primary);}',

        // 弹层
        '.ztaw-mask{position:absolute;inset:0;z-index:20;background:var(--dsw-alias-bg-mask-2);display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;}',
        '.ztaw-modal{width:100%;max-width:560px;max-height:100%;display:flex;flex-direction:column;min-height:0;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);box-shadow:0 12px 40px rgba(0,0,0,.28);overflow:hidden;}',
        '.ztaw-modal-head{flex:none;display:flex;align-items:center;gap:8px;height:44px;padding:0 12px 0 16px;border-bottom:.5px solid var(--dsw-alias-border-l3);box-sizing:border-box;}',
        '.ztaw-modal-title{font-size:13.5px;font-weight:600;}',
        '.ztaw-modal-body{flex:1;min-height:0;overflow-y:auto;padding:12px 16px;}',
        '.ztaw-modal-foot{flex:none;display:flex;align-items:center;gap:8px;padding:10px 16px;border-top:.5px solid var(--dsw-alias-border-l3);box-sizing:border-box;}',
        '.ztaw-field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px;}',
        '.ztaw-field > label{font-size:11.5px;color:var(--dsw-alias-label-tertiary);}',
        '.ztaw-field-row{display:flex;gap:8px;}',
        '.ztaw-field-row > .ztaw-field{flex:1;min-width:0;}',
        '.ztaw-hint{font-size:11px;color:var(--dsw-alias-label-caption);line-height:1.5;}',
        '.ztaw-acct{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:.5px solid var(--dsw-alias-border-l1);font-size:12px;}',
        '.ztaw-acct-main{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',

        // 回写弹层
        '.ztaw-wbrow{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:9px 10px;margin-bottom:9px;}',
        '.ztaw-wbrow-head{display:flex;align-items:center;gap:7px;margin-bottom:7px;}',
        '.ztaw-wbrow-title{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;}',
        '.ztaw-wbrow-ctl{display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap;}',
        '.ztaw-wbrow-ctl .ztaw-input{width:150px;height:26px;font-size:12px;}',
        '.ztaw-wbrow .ztaw-textarea{min-height:54px;}',
        '.ztaw-wbres{font-size:11.5px;margin-top:6px;word-break:break-word;}',
        '.ztaw-wbres.ok{color:var(--dsw-alias-state-success-primary);}',
        '.ztaw-wbres.fail{color:var(--dsw-alias-state-error-primary);}',

        // 旧版 DSH 悬浮兜底入口
        '.ztaw-fab{position:fixed;right:18px;bottom:18px;z-index:40;height:32px;padding:0 14px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:12.5px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.22);}',
        '.ztaw-fab:hover{background:var(--dsw-alias-button-primary-hover);}',
      ].join('\n');

      var cssInjected = false;
      function injectCss() {
        if (cssInjected || typeof document === 'undefined' || !document.head) return;
        cssInjected = true;
        try {
          // 插件热重载会重新执行本模块（新模块实例，cssInjected 已复位）：
          // 已存在同标记的 <style> 就复用，避免样式节点在 <head> 里越堆越多。
          if (document.querySelector('style[data-dsh-zentao-ai-workbench]')) return;
        } catch (e) { /* querySelector 不可用时照旧注入 */ }
        var el = document.createElement('style');
        el.setAttribute('data-dsh-zentao-ai-workbench', '1');
        el.textContent = CSS;
        document.head.appendChild(el);
      }

      // ───────────────────────── 图标（16px 线性，与宿主图标同语言） ─────────────────────────
      function ZentaoGlyph(props) {
        var size = (props && props.size) || 16;
        return h('svg', {
          width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
          'aria-hidden': 'true', className: props && props.className,
        },
          h('rect', { x: 2.3, y: 3.3, width: 11.4, height: 9.4, rx: 2.2, stroke: 'currentColor', strokeWidth: 1.1 }),
          h('path', { d: 'M4.9 6.4h2.7M4.9 9.5h2.2', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' }),
          h('path', { d: 'M9.3 9.3l1.1 1.1 2.1-2.3', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        );
      }
      function ChevronIcon(props) {
        var open = props && props.open;
        return h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', 'aria-hidden': 'true' },
          h('path', {
            d: open ? 'M4.2 6.2L8 10l3.8-3.8' : 'M6.2 4.2L10 8l-3.8 3.8',
            stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
          }),
        );
      }
      function CloseIcon() {
        return h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', 'aria-hidden': 'true' },
          h('path', { d: 'M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        );
      }

      // ───────────────────────── 纯函数（进 _test） ─────────────────────────
      function kindLabel(kind) { return KIND_LABEL[kind] || String(kind || '条目'); }

      function statusLabel(status) {
        var s = String(status == null ? '' : status).trim();
        if (!s) return '未知';
        return STATUS_LABEL[s] || s;
      }

      /** 状态标签色档：open（未闭环）/ mid（处理中）/ done（已闭环）。 */
      function statusTone(status) {
        var s = String(status == null ? '' : status).toLowerCase();
        if (s === 'closed' || s === 'resolved' || s === 'done' || s === 'cancel') return 'done';
        if (s === 'active' || s === 'wait' || s === 'draft' || s === '') return 'open';
        return 'mid';
      }

      function actionsFor(kind) {
        var list = KIND_ACTIONS[kind] || ['comment'];
        return list.map(function (a) { return { action: a, label: ACTION_LABEL[a] || a }; });
      }

      function actionLabel(action) { return ACTION_LABEL[action] || String(action || ''); }

      function cardKey(kind, id) { return String(kind || '') + '-' + String(id == null ? '' : id); }

      function itemKey(item) { return item ? cardKey(item.kind, item.id) : ''; }

      /** 图片类扩展名（附件里这些当图片附件挂，模型直接看得见）。 */
      var IMAGE_EXTS = { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1 };
      /** 单次下发最多挂多少张图（DSH 附件上限前的自我保护）。 */
      var IMAGE_MAX_ATTACHMENTS = 24;
      /** attachImagesToDraft 的失败原因 → 状态栏文案（面板里不出现英文错误码）。 */
      var IMAGE_REASON_LABEL = {
        unavailable: '当前没有可用的会话输入接口',
        unsupported: '当前会话不接受图片附件',
        download: '图片下载失败，可展开条目用链接查看',
        drafts: '附件草稿创建失败',
        busy: '会话输入框正忙，稍后重试',
      };
      function imageReasonText(reason) { return IMAGE_REASON_LABEL[reason] || String(reason || '未知原因'); }
      /** 每条目上下文里最多带多少条最近动态。 */
      var ACTION_MAX_IN_CONTEXT = 30;

      function extOf(f) {
        var ext = String((f && f.ext) || '').toLowerCase();
        if (ext) return ext.replace(/^\./, '');
        var m = /\.([a-z0-9]+)$/i.exec(String((f && f.name) || ''));
        return m ? m[1].toLowerCase() : '';
      }
      function isImageFile(f) { return Boolean(f && f.url && IMAGE_EXTS[extOf(f)]); }

      /**
       * 条目可见的图片全集：描述图 + 备注图 + 图片类附件，按 url 去重，上限 IMAGE_MAX_ATTACHMENTS。
       * 这三处以前只有描述图会进上下文，备注里的截图模型完全看不到。
       */
      function imagesOf(card, detail) {
        var out = [];
        var seen = {};
        var push = function (list) {
          if (!Array.isArray(list)) return;
          for (var i = 0; i < list.length; i++) {
            var x = list[i];
            if (!x || typeof x.url !== 'string' || !x.url || seen[x.url]) continue;
            seen[x.url] = 1;
            out.push({ url: x.url, name: String(x.name || '') });
          }
        };
        var d = detail || {};
        push(d.images);
        push(d.commentImages);
        var files = Array.isArray(d.files) ? d.files : [];
        for (var i = 0; i < files.length; i++) {
          if (isImageFile(files[i])) push([{ url: files[i].url, name: files[i].name }]);
        }
        if (!out.length) push(card && card.images);
        return out.slice(0, IMAGE_MAX_ATTACHMENTS);
      }

      /** 条目里非图片的附件（要落盘给模型用文件工具读）。 */
      function attachmentsOf(detail) {
        var files = (detail && Array.isArray(detail.files)) ? detail.files : [];
        return files.filter(function (f) { return f && f.url && !isImageFile(f); });
      }

      /**
       * 把非图片附件下载到目标会话工作目录（host RPC savefile → <cwd>/.zentao-attachments/）。
       * 无 cwd / 单项失败都不抛错：退化成「只有文件名 + 链接」，并在结果里报告原因。
       * @returns {Promise<{lines:Object<string,string[]>, saved:number, failed:Array, noDir:boolean}>}
       */
      function saveAttachments(items, dir) {
        var list = Array.isArray(items) ? items : [];
        var lines = {};
        var saved = 0;
        var failed = [];
        var noDir = !dir;
        var jobs = [];
        for (var i = 0; i < list.length; i++) {
          var it = list[i];
          var key = itemKey(it);
          var atts = attachmentsOf(it);
          if (!atts.length) continue;
          lines[key] = lines[key] || [];
          for (var j = 0; j < atts.length; j++) {
            (function (item, att) {
              if (noDir) {
                lines[itemKey(item)].push('- 附件：' + att.name + '（' + att.url + '；未保存到本地：没有可用的会话工作目录）');
                failed.push({ name: att.name, message: 'unknown-cwd' });
                return;
              }
              jobs.push(rpcValue('savefile', { url: att.url, dir: dir, name: att.name || '' }).then(function (v) {
                if (v && v.path) {
                  saved += 1;
                  lines[itemKey(item)].push('- 附件：' + (v.name || att.name) + '（已保存到 ' + v.path + '，可用文件工具读取）');
                } else {
                  throw new Error('savefile 未返回路径');
                }
              }, function (e) {
                failed.push({ name: att.name, message: (e && e.message) || 'savefile 失败' });
                lines[itemKey(item)].push('- 附件：' + att.name + '（' + att.url + '；未保存到本地：' + ((e && e.message) || '未知原因') + '）');
              }));
            })(it, atts[j]);
          }
        }
        if (!jobs.length && !Object.keys(lines).length) return Promise.resolve({ lines: {}, saved: 0, failed: [], noDir: false });
        return Promise.all(jobs).then(function () {
          return { lines: lines, saved: saved, failed: failed, noDir: noDir };
        });
      }

      /** 上下文里的图片占位行：区分描述图/备注图/图片附件（真实图片会作为附件挂上）。 */
      function imageLines(item) {
        var it = item || {};
        var seen = {};
        var lines = [];
        var push = function (list, label) {
          if (!Array.isArray(list)) return;
          for (var i = 0; i < list.length; i++) {
            var x = list[i];
            if (!x || typeof x.url !== 'string' || !x.url || seen[x.url]) continue;
            seen[x.url] = 1;
            var nm = x.name || ('image-' + (lines.length + 1));
            // 已知下载失败的图退化成「文件名 + 链接 + 原因」：模型至少知道原图在哪，不是一条死占位。
            lines.push('- [图片（' + label + '）：' + nm + ']'
              + (imageFailed.has(x.url) ? '（下载失败，原图：' + x.url + '）' : ''));
          }
        };
        push(it.images, '描述');
        push(it.commentImages, '备注');
        var files = Array.isArray(it.files) ? it.files : [];
        var imgFiles = [];
        for (var i = 0; i < files.length; i++) if (isImageFile(files[i])) imgFiles.push(files[i]);
        push(imgFiles, '附件');
        return lines;
      }

      /** 备注/历史记录 → 上下文的纯文本行（尾部 ACTION_MAX_IN_CONTEXT 条）。 */
      function renderActions(detail) {
        var acts = (detail && Array.isArray(detail.actions)) ? detail.actions : [];
        if (!acts.length) return [];
        var tail = acts.slice(-ACTION_MAX_IN_CONTEXT);
        var lines = [];
        if (acts.length > ACTION_MAX_IN_CONTEXT) {
          lines.push('（共 ' + acts.length + ' 条动态，这里只列出最近 ' + ACTION_MAX_IN_CONTEXT + ' 条）');
        }
        var escapeRe = function (t) { return String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
        for (var i = 0; i < tail.length; i++) {
          var a = tail[i] || {};
          var text = String(a.comment || '').trim();
          if (!text) {
            // 没写备注时禅道给的 desc 形如「2026-11-09 21:26:46, 由 张三 创建。」；
            // 时间与人名下面已经单独渲染，这里剥掉，避免同一行出现两遍。
            text = String(a.desc || '').trim()
              .replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?,?\s*/, '')
              .trim();
            if (text && a.actor) {
              try { text = text.replace(new RegExp('^由\\s*' + escapeRe(a.actor) + '\\s*'), '').trim(); } catch (e) { /* 保留原文 */ }
            }
          }
          if (!text) continue;
          var who = a.actor ? (' ' + a.actor) : '';
          var when = a.date ? (a.date + ' ') : '';
          var label = a.action ? (HISTORY_ACTION_LABEL[a.action] || a.action) : '';
          var body = text.replace(/\n+/g, ' ').trim();
          // 正文本身以动作词开头（如「创建。」）时不再重复加前缀
          var what = (label && body.indexOf(label) !== 0) ? (label + '：') : '';
          lines.push('- ' + when + who + (what ? ' ' + what : ' ') + body);
        }
        return lines;
      }

      /** 回写弹层每行的默认备注模板。 */
      function defaultCommentFor(item) {
        var title = String((item && item.title) || '').trim();
        return 'AI 已处理：#' + String((item && item.id) == null ? '' : item.id) + (title ? ' ' + title : '') + ' —— 结论：';
      }

      // ───────────────────── 上下文 Markdown（CONTRACT.md 第 5 节） ─────────────────────
      var WRITEBACK_SECTION = [
        '## 回写要求（重要）',
        '处理完成后，必须对每条使用工具回写禅道，无需人工登录：',
        '- 备注：`zentao_add_comment`',
        '- 状态：`zentao_update_status`（action: resolve/close/activate）',
        '- 多条：`zentao_write_back`',
      ].join('\n');

      function describeItem(item, detail) {
        var desc = (detail && detail.desc) || '';
        var steps = (detail && detail.steps) || '';
        var body = String(desc || '').trim();
        if (!String(steps || '').trim()) return body;
        var stepText = String(steps).trim();
        if (body && body.indexOf(stepText) >= 0) return body;
        return body ? (body + '\n\n重现步骤：\n' + stepText) : ('重现步骤：\n' + stepText);
      }

      /**
       * 所选条目 → 会话上下文 Markdown。
       * @param {Array} items Card/Detail 列表（Detail 优先，缺则退化 descBrief）
       * @param {string} instruction 处理要求
       * @param {{url?:string,title?:string}} [opts]
       */
      function buildContext(items, instruction, opts) {
        var list = Array.isArray(items) ? items.filter(Boolean) : [];
        var o = opts || {};
        var url = String(o.url || (list[0] && list[0].url) || '').trim();
        var kinds = {};
        for (var k = 0; k < list.length; k++) kinds[list[k].kind] = true;
        var kindKeys = Object.keys(kinds);
        var kindWord = kindKeys.length === 1 ? kindLabel(kindKeys[0]) : '条目';
        var siteWord = String(o.siteName || '禅道').trim() || '禅道';

        var lines = [];
        lines.push('# ' + siteWord + ' ' + kindWord + ' 处理任务（' + siteWord + '链接）');
        lines.push('共 ' + list.length + ' 条' + (url ? '，来自 ' + url : ''));
        lines.push('');

        for (var i = 0; i < list.length; i++) {
          var it = list[i] || {};
          lines.push('## ' + (i + 1) + '. #' + String(it.id == null ? '' : it.id) + ' ' + String(it.title || '（无标题）'));
          var facts = ['状态：' + String(it.status == null ? '' : it.status)];
          if (it.pri !== null && it.pri !== undefined && it.pri !== '') facts.push('优先级：' + it.pri);
          if (it.severity !== null && it.severity !== undefined && it.severity !== '') facts.push('严重程度：' + it.severity);
          if (it.assignedTo) facts.push('指派：' + it.assignedTo);
          if (it.moduleTitle) facts.push('模块：' + it.moduleTitle);
          lines.push('- ' + facts.join(' · '));
          if (it.url) lines.push('- 链接：' + it.url);
          var imgLines = imageLines(it);
          for (var j = 0; j < imgLines.length; j++) lines.push(imgLines[j]);
          var attLines = (o.attachmentLines && o.attachmentLines[itemKey(it)]) || [];
          for (var m = 0; m < attLines.length; m++) lines.push(attLines[m]);
          lines.push('### 描述/重现步骤');
          var body = describeItem(it, it);
          lines.push(body || String(it.descBrief || '').trim() || '（无描述）');
          var actLines = renderActions(it);
          if (actLines.length) {
            lines.push('### 备注与历史记录');
            for (var n = 0; n < actLines.length; n++) lines.push(actLines[n]);
          }
          lines.push('');
        }

        lines.push('## 处理要求');
        lines.push(String(instruction == null ? '' : instruction).trim() || DEFAULT_INSTRUCTION);
        lines.push('');
        lines.push(WRITEBACK_SECTION);
        return lines.join('\n');
      }

      /** buildContext 的便捷包装：接受 {items,url,title} 或裸数组。 */
      function contextMarkdownFor(selection, instruction) {
        var sel = selection || {};
        var items = Array.isArray(sel) ? sel : (sel.items || []);
        var opts = {};
        if (sel.url) opts.url = sel.url;
        if (sel.title) opts.title = sel.title;
        return buildContext(items, instruction, opts);
      }

      // ───────────────────── 回写条目（CONTRACT.md WriteItem） ─────────────────────
      /**
       * 弹层行 → WriteItem[]：跳过无效行，只带实际用得到的字段。
       * @param {Array<{kind,id,action,comment?,resolution?,resolvedBuild?,assignedTo?,enabled?}>} entries
       */
      function buildWriteItems(entries) {
        var out = [];
        var list = Array.isArray(entries) ? entries : [];
        for (var i = 0; i < list.length; i++) {
          var e = list[i] || {};
          if (e.enabled === false) continue;
          var kind = String(e.kind || '');
          var id = Number(e.id);
          if (!kind || !isFinite(id) || id <= 0) continue;
          var action = String(e.action || 'comment');
          // 只发 host 矩阵里的动作（KIND_ACTIONS 与 host 逐项一致）：不认识的动作用成写备注，
          // 绝不把非法状态流转发到禅道（host 会整条失败，用户只看到一条红字）。
          if (KIND_ACTIONS[kind] && KIND_ACTIONS[kind].indexOf(action) < 0) action = 'comment';
          var item = { kind: kind, id: id, action: action };
          var comment = String(e.comment == null ? '' : e.comment).trim();
          if (comment) item.comment = comment;
          if (action === 'resolve') {
            item.resolution = String(e.resolution || '').trim() || 'fixed';
            var rb = String(e.resolvedBuild || '').trim();
            if (rb) item.resolvedBuild = rb;
          }
          var at = String(e.assignedTo || '').trim();
          if (at) item.assignedTo = at;
          out.push(item);
        }
        return out;
      }

      // ───────────────────────── 本地存储（模板/上次 URL/指令） ─────────────────────────
      var memStore = {};
      function store() {
        try { return root.localStorage || null; } catch (e) { return null; }
      }
      function storeGet(key) {
        var s = store();
        if (s) { try { return s.getItem(key); } catch (e) { /* 落到内存 */ } }
        return Object.prototype.hasOwnProperty.call(memStore, key) ? memStore[key] : null;
      }
      function storeSet(key, value) {
        var s = store();
        if (s) { try { s.setItem(key, value); return; } catch (e) { /* 落到内存 */ } }
        memStore[key] = value;
      }
      function normTemplates(raw) {
        if (!Array.isArray(raw)) return [];
        var out = [];
        for (var i = 0; i < raw.length && out.length < MAX_TEMPLATES; i++) {
          var t = String(raw[i] == null ? '' : raw[i]).trim();
          if (t && out.indexOf(t) < 0) out.push(t);
        }
        return out;
      }
      function loadTemplates() {
        var raw = storeGet(TEMPLATES_KEY);
        if (!raw) return [];
        try { return normTemplates(JSON.parse(raw)); } catch (e) { return []; }
      }
      function saveTemplates(list) {
        var norm = normTemplates(list);
        storeSet(TEMPLATES_KEY, JSON.stringify(norm));
        return norm;
      }
      function loadLastUrl() {
        var v = storeGet(LAST_URL_KEY);
        return (v && String(v).trim()) || '';
      }
      function saveLastUrl(url) { if (url) storeSet(LAST_URL_KEY, String(url)); }
      function loadInstruction() {
        var v = storeGet(INSTRUCTION_KEY);
        return (v && String(v).trim()) || DEFAULT_INSTRUCTION;
      }
      function saveInstruction(text) { storeSet(INSTRUCTION_KEY, String(text == null ? '' : text)); }

      // ───────────────────────── DSH 服务懒查找 / RPC ─────────────────────────
      var appCtx = null; // apply() 时注入

      /** cordis inject 是硬门槛，这里用 ctx.get() 懒解析：服务缺失只降级，不抛错。 */
      function lookupService(name) {
        var svc = null;
        try { if (appCtx && typeof appCtx.get === 'function') svc = appCtx.get(name) || null; } catch (e) { svc = null; }
        if (svc) return svc;
        try { if (appCtx && appCtx.reflect && typeof appCtx.reflect.get === 'function') svc = appCtx.reflect.get(name) || null; } catch (e) { svc = null; }
        if (svc) return svc;
        try { if (appCtx && name in appCtx) svc = appCtx[name] || null; } catch (e) { svc = null; }
        return svc;
      }

      function rpcCall(endpoint, payload) {
        if (!appCtx || !appCtx.connection || !appCtx.connection.rpc || typeof appCtx.connection.rpc.call !== 'function') {
          return Promise.reject(new Error('RPC 通道不可用（connection 服务缺失）'));
        }
        return appCtx.connection.rpc.call(CHANNEL, endpoint, payload || {});
      }

      /** 信封解包：成功取 value，失败抛带 message 的 Error（调用方统一 catch）。 */
      function rpcValue(endpoint, payload) {
        return Promise.resolve(rpcCall(endpoint, payload)).then(function (r) {
          if (r && r.ok === true) return r.value;
          var err = (r && r.error) || {};
          var msg = err.message || err.code || '未知错误';
          var e = new Error(String(msg));
          e.code = err.code || 'rpc-error';
          e.details = err.details;
          throw e;
        }, function (e) {
          var err = new Error((e && e.message) || String(e) || 'RPC 调用失败');
          err.code = 'transport';
          throw err;
        });
      }

      // ───────────────────────── 会话集成 ─────────────────────────
      // 当前主视图会话 id：st.current（新版）→ byId[*].retainedBy.mainView > 0 → 模块级 lastSessionId
      // （由会话头部按钮写回）。DSH 0.2.2-rc.1 的 SessionListState = {ids,byId,phase,...}，
      // 没有 current，所以 mainView retain 是主路径。
      var lastSessionId = null;

      function currentSessionId(sessions, fallback) {
        try {
          if (sessions && sessions.list && typeof sessions.list.getSnapshot === 'function') {
            var st = sessions.list.getSnapshot();
            if (st && typeof st.current === 'string' && st.current) return st.current;
            var byId = (st && st.byId) || {};
            var ids = Array.isArray(st && st.ids) ? st.ids : Object.keys(byId);
            for (var i = 0; i < ids.length; i++) {
              var row = byId[ids[i]];
              if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return ids[i];
            }
          }
        } catch (e) { /* 忽略，走兜底 */ }
        var fb = fallback === undefined ? lastSessionId : fallback;
        return fb || null;
      }

      function sessionRow(sessions, id) {
        try { return (sessions.list.getSnapshot().byId || {})[id] || null; } catch (e) { return null; }
      }

      /**
       * 目标会话的输入目标 {sessionId,scope,facade,conversation,retainRef}；不可用返回 null。
       * @param {boolean} [doRetain] 仅在「新建会话」路径上 retain（已有会话由 mainView 保活，
       *   额外 retain 既不释放会泄漏、释放又会 retire scope 丢草稿）。
       */
      function inputTargetFor(sessionId, doRetain) {
        var sessions = lookupService('sessions');
        var conversation = lookupService('conversation');
        if (!sessions || !conversation || !conversation.input || typeof conversation.input.for !== 'function') return null;
        var retainRef = null;
        var scope = null;
        if (doRetain) {
          try {
            if (typeof sessions.retain === 'function') retainRef = sessions.retain(sessionId, { source: 'zentao-ai-workbench' });
          } catch (e) { retainRef = null; }
        }
        try { scope = typeof sessions.scope === 'function' ? sessions.scope(sessionId) : null; } catch (e) { scope = null; }
        var facade = null;
        try { facade = scope ? conversation.input.for(scope) : null; } catch (e) { facade = null; }
        if (!facade || typeof facade.setDraft !== 'function') {
          if (retainRef && typeof retainRef.release === 'function') { try { retainRef.release(); } catch (e2) { /* 忽略 */ } }
          return null;
        }
        return { sessionId: sessionId, scope: scope, facade: facade, conversation: conversation, retainRef: retainRef };
      }

      function releaseTarget(target, delayMs) {
        if (!target || !target.retainRef) return;
        var rel = function () {
          try { if (target.retainRef && typeof target.retainRef.release === 'function') target.retainRef.release(); } catch (e) { /* 已被释放 */ }
        };
        if (delayMs > 0 && typeof setTimeout === 'function') setTimeout(rel, delayMs); else rel();
      }

      function currentInputTarget() {
        var sessions = lookupService('sessions');
        if (!sessions) return null;
        var cur = currentSessionId(sessions);
        if (!cur) return null;
        return inputTargetFor(cur, false);
      }

      // ── 图片附件（禅道 file-read → host RPC → File → 草稿附件） ──
      var IMAGE_MAX_DIMENSION = 8192;
      var IMAGE_MAX_PIXELS = 64000000;
      var IMAGE_MAX_BYTES = 20 * 1024 * 1024;
      var IMAGE_CACHE_MAX = 24;
      var imageCache = new Map();
      var imageFailed = new Set();

      function bytesFromBase64(b64) {
        var bin = atob(String(b64 || ''));
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
      function imageDataUrlParts(dataUrl) {
        var m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(String(dataUrl || ''));
        return m ? { mediaType: m[1], base64: m[2] } : null;
      }
      function cachedImageSrc(url) { return imageCache.get(url) || null; }
      function rememberImageSrc(url, dataUrl) {
        if (!url || typeof dataUrl !== 'string' || !dataUrl) return;
        imageCache.delete(url);
        imageCache.set(url, dataUrl);
        while (imageCache.size > IMAGE_CACHE_MAX) {
          var oldest = imageCache.keys().next().value;
          imageCache.delete(oldest);
        }
      }
      /** url → {name,mediaType,base64}（缓存优先），失败 null。 */
      function fetchImageValue(img) {
        if (!img || typeof img.url !== 'string' || !img.url) return Promise.resolve(null);
        var hit = cachedImageSrc(img.url);
        if (hit) {
          var parts = imageDataUrlParts(hit);
          if (parts) return Promise.resolve({ name: img.name, mediaType: parts.mediaType, base64: parts.base64 });
        }
        return rpcValue('image', { url: img.url }).then(function (v) {
          if (!v || !v.base64) { imageFailed.add(img.url); return null; }
          rememberImageSrc(img.url, 'data:' + (v.mediaType || 'image/png') + ';base64,' + v.base64);
          imageFailed.delete(img.url);
          return v;
        }, function () { imageFailed.add(img.url); return null; });
      }
      /** 超大截图先缩到 2048 长边，避免宿主拒绝整条 prompt。 */
      function normalizeImageFile(file) {
        if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return Promise.resolve(file);
        return Promise.resolve(createImageBitmap(file)).then(function (bmp) {
          var w = bmp.width, h = bmp.height;
          var oversized = w > IMAGE_MAX_DIMENSION || h > IMAGE_MAX_DIMENSION
            || (w * h) > IMAGE_MAX_PIXELS || (file.size || 0) > IMAGE_MAX_BYTES;
          if (!oversized) {
            try { if (typeof bmp.close === 'function') bmp.close(); } catch (e) { /* 忽略 */ }
            return file;
          }
          var scale = Math.min(2048 / Math.max(w, h), 1);
          var cw = Math.max(1, Math.round(w * scale));
          var ch = Math.max(1, Math.round(h * scale));
          try {
            var canvas = document.createElement('canvas');
            canvas.width = cw; canvas.height = ch;
            canvas.getContext('2d').drawImage(bmp, 0, 0, cw, ch);
            try { if (typeof bmp.close === 'function') bmp.close(); } catch (e2) { /* 忽略 */ }
            return new Promise(function (resolve) {
              try {
                canvas.toBlob(function (blob) {
                  if (!blob) { resolve(file); return; }
                  var base = String(file.name || 'image').replace(/\.[^.]+$/, '');
                  resolve(new File([blob], base + '.png', { type: 'image/png' }));
                }, 'image/png');
              } catch (e3) { resolve(file); }
            });
          } catch (e4) { return file; }
        }, function () { return file; });
      }

      /**
       * 把禅道图片挂成草稿附件：RPC 取字节 → File → conversation.createDrafts → facade.addAttachments。
       * 任一环不可用返回 {ok:false, reason}，文本已插入不受影响。
       */
      function attachImagesToDraft(images, target) {
        var list = (Array.isArray(images) ? images : []).filter(Boolean).slice(0, IMAGE_MAX_ATTACHMENTS);
        if (!list.length || !target || !target.conversation || !target.facade) {
          return Promise.resolve({ ok: false, reason: 'unavailable', count: 0 });
        }
        var conversation = target.conversation;
        var facade = target.facade;
        if (typeof conversation.createDrafts !== 'function' || typeof facade.addAttachments !== 'function'
          || typeof File !== 'function' || typeof atob !== 'function') {
          return Promise.resolve({ ok: false, reason: 'unsupported', count: 0 });
        }
        return Promise.all(list.map(fetchImageValue)).then(function (values) {
          var files = [];
          for (var i = 0; i < values.length; i++) {
            var v = values[i];
            if (!v || !v.base64) continue;
            try {
              var name = v.name || list[i].name || ('image-' + (i + 1) + '.png');
              files.push(new File([bytesFromBase64(v.base64)], name, { type: v.mediaType || 'image/png' }));
            } catch (e) { /* 单张失败不影响其它 */ }
          }
          if (!files.length) return { ok: false, reason: 'download', count: 0 };
          return Promise.all(files.map(normalizeImageFile)).then(function (prepared) {
            var drafts = null;
            try { drafts = conversation.createDrafts(target.sessionId, prepared); } catch (e2) { drafts = null; }
            var ids = (drafts || []).map(function (d) { return d && d.id; }).filter(Boolean);
            if (!ids.length) return { ok: false, reason: 'drafts', count: 0 };
            var added = false;
            try { added = facade.addAttachments(ids) !== false; } catch (e3) { added = false; }
            if (!added) {
              try {
                if (typeof conversation.releaseDraftAttachments === 'function') conversation.releaseDraftAttachments(drafts);
              } catch (e4) { /* 忽略 */ }
              return { ok: false, reason: 'busy', count: 0 };
            }
            return { ok: true, count: ids.length };
          });
        });
      }

      // ── DOM composer / 剪贴板降级 ──
      function fillComposerEditable(text) {
        if (typeof document === 'undefined') return false;
        var editable = document.querySelector('[data-composer-input]');
        if (!editable) return false;
        try { editable.focus(); } catch (e) { /* 忽略 */ }
        try {
          var selection = typeof document.getSelection === 'function' ? document.getSelection() : null;
          if (selection) {
            var range = document.createRange();
            range.selectNodeContents(editable);
            selection.removeAllRanges();
            selection.addRange(range);
          }
        } catch (e2) { /* 忽略 */ }
        var ok = false;
        try { ok = document.execCommand('insertText', false, text); } catch (e3) { ok = false; }
        if (ok) return true;
        try {
          editable.textContent = text;
          editable.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        } catch (e4) { return false; }
      }
      function tryInsertIntoComposer(md) {
        if (fillComposerEditable(md)) return true;
        if (typeof document === 'undefined') return false;
        var ta = document.querySelector('textarea[placeholder], form textarea');
        if (!ta || ta.readOnly || ta.disabled) return false;
        try {
          var start = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
          var end = ta.selectionEnd == null ? ta.value.length : ta.selectionEnd;
          var v = ta.value.slice(0, start) + md + ta.value.slice(end);
          var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, v);
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          try { ta.focus(); } catch (e) { /* 忽略 */ }
          return true;
        } catch (e2) { return false; }
      }
      function copyToClipboard(text) {
        var s = String(text == null ? '' : text);
        try {
          var nav = root.navigator;
          if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
            return Promise.resolve(nav.clipboard.writeText(s)).then(function () { return true; }, function () { return copyViaDom(s); });
          }
        } catch (e) { /* 走 DOM 兜底 */ }
        return Promise.resolve(copyViaDom(s));
      }
      function copyViaDom(s) {
        if (typeof document === 'undefined') return false;
        try {
          var ta = document.createElement('textarea');
          ta.value = s;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          return Boolean(ok);
        } catch (e) { return false; }
      }

      /**
       * 写入当前会话草稿：服务级 setDraft（优先）→ DOM composer → 剪贴板。
       * @returns {Promise<{mode:'service'|'dom'|'clipboard', attached:number, imageError?:string|null, failed?:boolean}>}
       */
      function insertToCurrentChat(md, images, sessionIdOverride) {
        var target = sessionIdOverride ? inputTargetFor(sessionIdOverride, false) : currentInputTarget();
        var mode = null;
        if (target && target.facade && typeof target.facade.setDraft === 'function') {
          try {
            target.facade.setDraft(md);
            try { if (typeof target.facade.focus === 'function') target.facade.focus(); } catch (e) { /* 忽略 */ }
            mode = 'service';
            lastSessionId = target.sessionId;
          } catch (e2) { mode = null; }
        }
        if (!mode) {
          var domOk = false;
          try { domOk = tryInsertIntoComposer(md); } catch (e3) { domOk = false; }
          if (domOk) mode = 'dom';
        }
        if (!mode) {
          return copyToClipboard(md).then(function (ok) {
            return { mode: 'clipboard', attached: 0, failed: !ok };
          });
        }
        var imgs = Array.isArray(images) ? images : [];
        if (!imgs.length || !target) return Promise.resolve({ mode: mode, attached: 0 });
        return attachImagesToDraft(imgs, target).then(function (r) {
          return {
            mode: mode,
            attached: r && r.ok ? r.count : 0,
            imageError: r && !r.ok ? r.reason : null,
          };
        });
      }

      /**
       * 目标会话的工作目录（新会话/当前会话一致的口径）：附件落盘要用它。
       */
      function resolveTargetCwd(choice) {
        try {
          if (choice && choice.cwd) return String(choice.cwd);
          var sessions = lookupService('sessions');
          if (!sessions) return null;
          var cur = currentSessionId(sessions);
          var row = cur ? sessionRow(sessions, cur) : null;
          return (row && row.cwd) ? String(row.cwd) : null;
        } catch (e) { return null; }
      }

      /** 指定会话的权威工作目录（新建会话的 cwd 来源）；快照里还没出现就返回 null。 */
      function sessionCwdOf(sessions, sessionId) {
        try {
          if (!sessions || !sessionId) return null;
          var row = sessionRow(sessions, sessionId);
          return (row && row.cwd) ? String(row.cwd) : null;
        } catch (e) { return null; }
      }

      /**
       * 新会话公共前段（不写草稿）：sessions.create({cwd}) → retain → scope → input.for。
       * 返回的 cwd 优先取新会话自己的目录，供随后构建上下文时把附件落盘到正确位置。
       * 缺 sessions.create 时由调用方降级 uiWorkspace.startSession() + 剪贴板。
       * @returns {Promise<{ok:true,sessionId,target,cwd}|{ok:false,mode,message,sessionId?}>}
       */
      function openNewSession(choice) {
        var sessions = lookupService('sessions');
        var conversation = lookupService('conversation');
        if (!sessions || typeof sessions.create !== 'function') {
          return Promise.resolve({ ok: false, mode: 'unavailable', message: 'sessions 服务不可用（DSH 版本过旧？）' });
        }
        var opts = {};
        if (choice && choice.workspaceId) opts.workspaceId = choice.workspaceId;
        else if (choice && choice.cwd) opts.cwd = choice.cwd;
        else {
          // 未指定 → 继承当前会话工作目录
          try {
            var cur = currentSessionId(sessions);
            var row = cur ? sessionRow(sessions, cur) : null;
            if (row && row.cwd) opts = { cwd: row.cwd };
          } catch (e) { /* 忽略 */ }
        }
        return Promise.resolve()
          .then(function () { return sessions.create(opts); })
          .then(function (sessionId) {
            if (!sessionId) throw new Error('sessions.create 未返回会话 id');
            if (!conversation || !conversation.input || typeof conversation.input.for !== 'function') {
              return { ok: false, mode: 'unavailable', sessionId: sessionId, message: 'conversation 服务不可用，新会话输入接口缺失' };
            }
            var target = inputTargetFor(sessionId, true);
            if (!target) {
              return { ok: false, mode: 'unavailable', sessionId: sessionId, message: '会话输入接口不可用（会话可能未就绪）' };
            }
            return {
              ok: true, sessionId: sessionId, target: target,
              cwd: sessionCwdOf(sessions, sessionId) || (opts && opts.cwd) || resolveTargetCwd(choice),
            };
          })
          .catch(function (err) {
            return { ok: false, mode: 'failed', message: '新会话创建失败：' + ((err && err.message) || String(err)) };
          });
      }

      /** 建会话 + 写草稿（旧路径：上下文已先构建，cwd 只能取自当前会话）。 */
      function createDraftSession(md, images, choice) {
        return openNewSession(choice).then(function (p) {
          if (!p.ok) return p;
          try { p.target.facade.setDraft(md); } catch (e) {
            releaseTarget(p.target, 0);
            return { ok: false, mode: 'unavailable', sessionId: p.sessionId, message: '草稿写入失败：' + ((e && e.message) || String(e)) };
          }
          // 草稿真正写进去了才算「这个会话可用」，再把这它记为最近会话
          lastSessionId = p.sessionId;
          return p;
        });
      }

      /** 草稿已写好：挂图片 → 250ms 后 submit → 3s 后释放后台 retain（不跳转，用户留在面板）。 */
      function commitDraft(target, images) {
        return attachImagesToDraft(images, target).then(function (att) {
          setTimeout(function () {
            try { if (typeof target.facade.submit === 'function') target.facade.submit(); } catch (e) { /* 已填草稿，交给用户 */ }
            releaseTarget(target, 3000);
          }, 250);
          return att;
        });
      }

      /** 图片/附件结果 → 状态栏尾巴（没选到图片时不提图片，避免「图片未挂上」的噪音）。 */
      function imageSuffix(att, imageCount) {
        if (!imageCount) return '';
        if (att && att.ok) return '（含 ' + att.count + ' 张图片）';
        return (att && att.reason) ? '（图片未挂上：' + imageReasonText(att.reason) + '）' : '';
      }

      /**
       * 「新建会话并处理」旧路径：上下文已构建好再建会话。
       * 前段失败 → 降级 uiWorkspace.startSession() + 剪贴板。
       */
      function dispatchToNewSession(md, images, choice) {
        return createDraftSession(md, images, choice).then(function (p) {
          if (!p.ok) return degradeNewSession(md, images, p);
          return commitDraft(p.target, images).then(function (att) {
            return {
              ok: true, mode: 'dispatched', sessionId: p.sessionId, att: att, cwd: p.cwd,
              message: '已新建会话并下发任务背景' + imageSuffix(att, Array.isArray(images) ? images.length : 0),
            };
          });
        });
      }

      /**
       * 「新建会话并处理」主路径：先建会话 → 用它自己的 cwd 构建上下文（非图片附件落盘到该 cwd）
       * → 写草稿 → 挂图片 → submit。顺序反了的话「今天第一批」会在无当前会话时把附件退化成裸链接。
       * 上下文构建失败时由 build 自己退化成卡片摘要；真的抛错也保留会话并给出可粘贴的提示。
       * @param {(cwd: string|null) => Promise<{md:string,images:Array,att?:object,degraded?:boolean}>} build
       * @param {{workspaceId?:string,cwd?:string}} [choice]
       */
      function dispatchToNewSessionWithCwd(build, choice) {
        var buildSafe = function (cwd) {
          return Promise.resolve()
            .then(function () { return build(cwd); })
            .then(function (built) {
              var b = built || {};
              return {
                md: String(b.md == null ? '' : b.md),
                images: Array.isArray(b.images) ? b.images : [],
                att: b.att,
                degraded: Boolean(b.degraded),
              };
            });
        };
        return openNewSession(choice).then(function (p) {
          if (!p.ok) {
            // 会话没建起来：仍要把上下文交给用户（空白会话 + 剪贴板），不能只说失败
            return buildSafe(null).then(function (built) { return degradeNewSession(built.md, built.images, p); });
          }
          var target = p.target;
          var cwd = p.cwd || resolveTargetCwd(choice);
          return buildSafe(cwd).then(function (built) {
            try { target.facade.setDraft(built.md); } catch (e) {
              releaseTarget(target, 0);
              return {
                ok: false, mode: 'unavailable', sessionId: p.sessionId, att: built.att,
                message: '新会话已建好，但草稿写入失败：' + ((e && e.message) || String(e)) + '（会话保留，可手动粘贴上下文）',
              };
            }
            lastSessionId = p.sessionId;
            return commitDraft(target, built.images).then(function (att) {
              var suffix = imageSuffix(att, built.images.length) + (built.degraded ? '（详情读取失败，已用卡片摘要生成上下文）' : '');
              return {
                ok: true, mode: 'dispatched', sessionId: p.sessionId, att: built.att, cwd: cwd,
                message: '已新建会话并下发任务背景' + suffix,
              };
            });
          }, function (err) {
            releaseTarget(target, 0);
            return {
              ok: false, mode: 'failed', sessionId: p.sessionId,
              message: '新会话已建好，但上下文准备失败：' + ((err && err.message) || String(err)) + '（会话保留，可手动粘贴上下文）',
            };
          });
        });
      }

      /** 新会话不可用时的降级：开一个空白会话视图 + 内容进剪贴板。 */
      function degradeNewSession(md, images, failure) {
        var ws = null;
        try { ws = lookupService('uiWorkspace'); } catch (e) { ws = null; }
        var started = false;
        if (ws && typeof ws.startSession === 'function') {
          try { ws.startSession(); started = true; } catch (e2) { started = false; }
        }
        return copyToClipboard(md).then(function (copied) {
          return {
            ok: false, mode: 'unavailable',
            message: (failure && failure.message ? failure.message : '新会话不可用')
              + (started ? '；已新建空白会话' : '')
              + (copied ? '，上下文已复制到剪贴板，请粘贴发送' : '，复制失败，请手动从面板复制'),
          };
        });
      }

      // ───────────────────────── 面板级内存缓存（切走再回来不丢内容） ─────────────────────────
      var paneCache = {
        status: null, list: null, selected: {}, expanded: {}, notice: null,
        url: null, instruction: null, templates: null,
      };

      // ───────────────────────── 详情/图片加载 ─────────────────────────
      function loadDetail(kind, id) {
        return rpcValue('detail', { kind: kind, id: id }).catch(function () { return null; });
      }

      // ───────────────────────── 组件 ─────────────────────────
      function ZentaoAiSidebarIcon(props) {
        return h(ZentaoGlyph, { size: (props && props.size) || 16, className: (props && props.className) || undefined });
      }

      function StatusDot(props) {
        var status = props && props.status;
        var cls = 'ztaw-dot';
        var title = '未配置禅道账号';
        if (status && status.loggedIn) { cls += ' ok'; title = '已登录禅道'; }
        else if (status && status.configured) { cls += ' warn'; title = '已配置但登录态失效'; }
        else if (props && props.error) { cls += ' err'; title = '读取状态失败'; }
        return h('span', { className: cls, title: title, 'aria-label': title });
      }

      function ChipRow(props) {
        var templates = props.templates || [];
        return h('div', { className: 'ztaw-chips' },
          templates.map(function (t, i) {
            return h('button', {
              key: 'tpl-' + i, type: 'button', className: 'ztaw-chip', title: '套用模板：' + t,
              onClick: function () { props.onUse(t); },
            }, t.length > 16 ? t.slice(0, 16) + '…' : t);
          }),
          h('button', {
            type: 'button', className: 'ztaw-chip ztaw-chip-add', title: '把当前指令存为模板（最多 ' + MAX_TEMPLATES + ' 条）',
            onClick: props.onSave,
          }, '存为模板'),
          templates.length ? h('button', {
            type: 'button', className: 'ztaw-chip ztaw-chip-add', title: '清空已存模板',
            onClick: props.onClear,
          }, '清空模板') : null,
        );
      }

      function DetailBlock(props) {
        var card = props.card;
        var detail = props.detail;
        var images = imagesOf(card, detail);
        if (!detail && props.loading) return h('div', { className: 'ztaw-detail' }, h('span', { className: 'ztaw-muted' }, '正在读取详情…'));
        var desc = detail ? String(detail.desc || '').trim() : String(card.descBrief || '').trim();
        var steps = detail ? String(detail.steps || '').trim() : '';
        return h('div', { className: 'ztaw-detail' },
          h('div', { className: 'ztaw-detail-k' }, '描述'),
          h('div', { className: 'ztaw-detail-sec' }, desc || '（无描述）'),
          steps ? h('div', null,
            h('div', { className: 'ztaw-detail-k' }, '重现步骤'),
            h('div', { className: 'ztaw-detail-sec' }, steps),
          ) : null,
          detail && detail.files && detail.files.length
            ? h('div', null,
              h('div', { className: 'ztaw-detail-k' }, '附件（' + detail.files.length + '，下发时会下载到会话目录供模型读取）'),
              h('div', { className: 'ztaw-detail-sec' }, detail.files.map(function (f) {
                return '· ' + (f.name || '未命名') + (isImageFile(f) ? '（图片，会作为图片附件挂上）' : '');
              }).join('\n')),
            )
            : null,
          detail && detail.commentImages && detail.commentImages.length
            ? h('div', { className: 'ztaw-detail-k' }, '备注里的图片：' + detail.commentImages.length + ' 张（会作为图片附件挂上）')
            : null,
          detail && detail.actions && detail.actions.length
            ? h('div', null,
              h('div', { className: 'ztaw-detail-k' }, '最近动态（' + detail.actions.length + '）'),
              h('div', { className: 'ztaw-detail-sec' }, detail.actions.slice(-6).map(function (a, i) {
                return (a.actor || '') + ' ' + (a.action || '') + ' ' + (a.date || '') + ((a.comment || a.desc) ? ('：' + (a.comment || a.desc)) : '');
              }).join('\n')),
            )
            : null,
          images.length ? h('div', null,
            h('div', { className: 'ztaw-detail-k' }, '图片（' + images.length + '）'),
            h('div', { className: 'ztaw-thumbs' }, images.slice(0, 6).map(function (img, i) {
              var src = cachedImageSrc(img.url);
              if (src) return h('img', { key: 'img-' + i, className: 'ztaw-thumb', src: src, alt: img.name || '禅道图片' });
              var failed = imageFailed.has(img.url);
              return h('div', {
                key: 'img-' + i, className: 'ztaw-thumb-ph', title: (failed ? '图片下载失败：' : '加载中：') + img.url,
              }, failed ? '下载失败' : '加载中…');
            })),
          ) : null,
          card.url ? h('div', { style: { marginTop: '8px' } },
            h('a', { className: 'ztaw-link', href: card.url, target: '_blank', rel: 'noreferrer noopener' }, '在禅道中打开 ' + card.url),
          ) : null,
        );
      }

      function ListItem(props) {
        var card = props.card;
        var key = itemKey(card);
        var detail = props.detail;
        var on = Boolean(props.selected);
        var open = Boolean(props.expanded);
        return h('div', { className: 'ztaw-item' + (on ? ' on' : ''), 'data-ztaw-card': key },
          h('div', { className: 'ztaw-item-head' },
            h('input', {
              type: 'checkbox', className: 'ztaw-cbx', checked: on,
              'aria-label': '选择 #' + card.id,
              onChange: function () { props.onToggle(key); },
            }),
            h('button', {
              type: 'button', className: 'ztaw-exp', title: open ? '收起详情' : '展开详情',
              'aria-expanded': open ? 'true' : 'false',
              onClick: function () { props.onExpand(key); },
            }, h(ChevronIcon, { open: open })),
            h('span', { className: 'ztaw-id' }, '#' + card.id),
            h('span', { className: 'ztaw-title', title: card.title || '' }, card.title || '（无标题）'),
            h('span', { className: 'ztaw-tag ' + statusTone(card.status), title: '禅道状态：' + (card.status || '') }, statusLabel(card.status)),
            card.assignedTo ? h('span', { className: 'ztaw-owner', title: '指派：' + card.assignedTo }, card.assignedTo) : null,
            card.severity !== null && card.severity !== undefined && card.severity !== ''
              ? h('span', { className: 'ztaw-sev' }, '严重 ' + card.severity) : null,
          ),
          open ? h(DetailBlock, { card: card, detail: detail, loading: props.detailLoading }) : null,
        );
      }

      /**
       * 自绘弹层的可访问性：Esc 关闭、初始焦点移入弹层、Tab 焦点在弹层内循环。
       * 宿主不会替覆盖层代管焦点，缺了这些键盘用户只能困在背景面板上。
       * @param {() => void} onClose 关闭回调
       */
      function useDialogA11y(onClose) {
        useEffect(function () {
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
          var FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
          var maskOf = function () {
            try { return document.querySelector('[data-ztaw-dialog]'); } catch (e) { return null; }
          };
          var focusables = function (mask) {
            var nodes = mask ? mask.querySelectorAll(FOCUSABLE) : [];
            var out = [];
            for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
            return out;
          };
          var mask = maskOf();
          try {
            // 初始焦点优先落到首个输入控件（登录/备注），键盘用户不必先从背景 Tab 进来。
            var first = mask
              ? (mask.querySelector('input:not([type="hidden"]),textarea,select') || focusables(mask)[0])
              : null;
            if (first && typeof first.focus === 'function') first.focus();
          } catch (e2) { /* 焦点转移失败不影响弹层使用 */ }
          var onKey = function (e) {
            if (!e || typeof e.key !== 'string') return;
            if (e.key === 'Escape' || e.key === 'Esc') {
              try { e.preventDefault(); e.stopPropagation(); } catch (e3) { /* 忽略 */ }
              onClose();
              return;
            }
            if (e.key !== 'Tab') return;
            var list = focusables(mask);
            if (!list.length) return;
            var idx = list.indexOf(document.activeElement);
            var last = list.length - 1;
            if (e.shiftKey && idx <= 0) {
              try { e.preventDefault(); list[last].focus(); } catch (e4) { /* 忽略 */ }
            } else if (!e.shiftKey && idx === last) {
              try { e.preventDefault(); list[0].focus(); } catch (e5) { /* 忽略 */ }
            }
          };
          document.addEventListener('keydown', onKey, true);
          return function () {
            try { document.removeEventListener('keydown', onKey, true); } catch (e6) { /* 已清理 */ }
          };
        }, []);
      }

      function LoginModal(props) {
        var status = props.status || {};
        var [baseUrl, setBaseUrl] = useState(status.baseUrl || '');
        var [account, setAccount] = useState(status.account || '');
        var [password, setPassword] = useState('');
        var [alias, setAlias] = useState(status.alias || '');
        var [busy, setBusy] = useState(false);
        var [err, setErr] = useState('');
        useDialogA11y(props.onClose);

        var submit = function () {
          if (busy) return;
          if (!String(baseUrl).trim() || !String(account).trim() || !password) {
            setErr('请填写禅道地址、账号与密码'); return;
          }
          setBusy(true); setErr('');
          rpcValue('login', { baseUrl: String(baseUrl).trim(), account: String(account).trim(), password: password, alias: String(alias || '').trim() })
            .then(function (st) { setBusy(false); props.onDone(st, '登录成功，已切换禅道账号'); })
            .catch(function (e) { setBusy(false); setErr((e && e.message) || '登录失败'); });
        };
        var accounts = Array.isArray(status.accounts) ? status.accounts : [];

        return h('div', { className: 'ztaw-mask', role: 'dialog', 'aria-modal': 'true', 'data-ztaw-dialog': '1', 'aria-label': '禅道账号设置' },
          h('div', { className: 'ztaw-modal' },
            h('div', { className: 'ztaw-modal-head' },
              h('span', { className: 'ztaw-modal-title' }, '禅道账号设置'),
              h('span', { className: 'ztaw-grow' }),
              h('button', { type: 'button', className: 'ztaw-btn ztaw-btn-sm', onClick: props.onClose, title: '关闭' }, h(CloseIcon, null)),
            ),
            h('div', { className: 'ztaw-modal-body' },
              h('div', { className: 'ztaw-field' },
                h('label', null, '禅道地址'),
                h('input', {
                  className: 'ztaw-input', value: baseUrl, spellCheck: false,
                  placeholder: 'http://zentao.example.com/zentao/',
                  onChange: function (e) { setBaseUrl(e.target.value); },
                }),
                h('div', { className: 'ztaw-hint' }, '填禅道根地址即可（到 /zentao 一层），保存后用于读取列表与回写。'),
              ),
              h('div', { className: 'ztaw-field-row' },
                h('div', { className: 'ztaw-field' },
                  h('label', null, '账号'),
                  h('input', { className: 'ztaw-input', value: account, spellCheck: false, onChange: function (e) { setAccount(e.target.value); } }),
                ),
                h('div', { className: 'ztaw-field' },
                  h('label', null, '密码'),
                  h('input', {
                    className: 'ztaw-input', type: 'password', value: password,
                    onChange: function (e) { setPassword(e.target.value); },
                    onKeyDown: function (e) { if (e.key === 'Enter') submit(); },
                  }),
                ),
              ),
              h('div', { className: 'ztaw-field' },
                h('label', null, '别名（可选）'),
                h('input', {
                  className: 'ztaw-input', value: alias, placeholder: '例如：某公司',
                  onChange: function (e) { setAlias(e.target.value); },
                }),
                h('div', { className: 'ztaw-hint' }, '密码仅保存在本机 host 配置中，用于 cookie 失效时静默重登。'),
              ),
              err ? h('div', { className: 'ztaw-wbres fail' }, err) : null,
              accounts.length ? h('div', null,
                h('div', { className: 'ztaw-detail-k' }, '已保存账号（' + accounts.length + '）'),
                accounts.map(function (a, i) {
                  return h('div', { key: 'acct-' + i, className: 'ztaw-acct' },
                    h('span', { className: 'ztaw-dot' + (a.loggedIn ? ' ok' : '') }),
                    h('span', { className: 'ztaw-acct-main', title: (a.baseUrl || '') + ' · ' + (a.account || '') },
                      (a.alias ? a.alias + ' · ' : '') + (a.account || '') + ' @ ' + (a.baseUrl || '')),
                    h('button', {
                      type: 'button', className: 'ztaw-btn ztaw-btn-sm',
                      onClick: function () { setBaseUrl(a.baseUrl || ''); setAccount(a.account || ''); setAlias(a.alias || ''); },
                    }, '填入'),
                    h('button', {
                      type: 'button', className: 'ztaw-btn ztaw-btn-sm',
                      onClick: function () { props.onLogout(a.id); },
                    }, '登出'),
                  );
                }),
              ) : null,
            ),
            h('div', { className: 'ztaw-modal-foot' },
              h('span', { className: 'ztaw-grow' }),
              h('button', { type: 'button', className: 'ztaw-btn', onClick: function () { props.onLogout(); } }, '登出当前账号'),
              h('button', { type: 'button', className: 'ztaw-btn ztaw-btn-primary', disabled: busy, onClick: submit }, busy ? '登录中…' : '登录并保存'),
            ),
          ),
        );
      }

      function WritebackModal(props) {
        var rows = props.rows || [];
        var results = props.results || {};
        useDialogA11y(props.onClose);
        return h('div', { className: 'ztaw-mask', role: 'dialog', 'aria-modal': 'true', 'data-ztaw-dialog': '1', 'aria-label': '回写禅道' },
          h('div', { className: 'ztaw-modal' },
            h('div', { className: 'ztaw-modal-head' },
              h('span', { className: 'ztaw-modal-title' }, '回写禅道'),
              h('span', { className: 'ztaw-count' }, '共 ' + rows.length + ' 条'),
              h('span', { className: 'ztaw-grow' }),
              h('button', { type: 'button', className: 'ztaw-btn ztaw-btn-sm', onClick: props.onClose, title: '关闭' }, h(CloseIcon, null)),
            ),
            h('div', { className: 'ztaw-modal-body' },
              rows.length ? rows.map(function (r) {
                var key = cardKey(r.kind, r.id);
                var res = results[key];
                return h('div', { key: key, className: 'ztaw-wbrow' },
                  h('div', { className: 'ztaw-wbrow-head' },
                    h('span', { className: 'ztaw-id' }, '#' + r.id),
                    h('span', { className: 'ztaw-wbrow-title', title: r.title || '' }, r.title || '（无标题）'),
                    h('span', { className: 'ztaw-tag ' + statusTone(r.status) }, statusLabel(r.status)),
                    h('span', { className: 'ztaw-sev' }, kindLabel(r.kind)),
                  ),
                  h('div', { className: 'ztaw-wbrow-ctl' },
                    h('select', {
                      className: 'ztaw-select', value: r.action,
                      'aria-label': '动作',
                      onChange: function (e) { props.onChange(key, { action: e.target.value }); },
                    }, actionsFor(r.kind).map(function (a) {
                      return h('option', { key: a.action, value: a.action }, a.label);
                    })),
                    r.action === 'resolve' ? h('input', {
                      className: 'ztaw-input', value: r.resolution || 'fixed', placeholder: 'resolution（默认 fixed）',
                      spellCheck: false,
                      onChange: function (e) { props.onChange(key, { resolution: e.target.value }); },
                    }) : null,
                    r.action === 'resolve' ? h('input', {
                      className: 'ztaw-input', value: r.resolvedBuild || '', placeholder: 'resolvedBuild（默认 trunk）',
                      spellCheck: false,
                      onChange: function (e) { props.onChange(key, { resolvedBuild: e.target.value }); },
                    }) : null,
                  ),
                  h('textarea', {
                    className: 'ztaw-textarea', value: r.comment,
                    'aria-label': '备注内容',
                    onChange: function (e) { props.onChange(key, { comment: e.target.value }); },
                  }),
                  res ? h('div', { className: 'ztaw-wbres ' + (res.ok ? 'ok' : 'fail') },
                    (res.ok ? '成功：' : '失败：') + (res.message || '') + '（' + (res.action || r.action) + '）') : null,
                );
              }) : h('div', { className: 'ztaw-empty' }, '没有选中的条目；先在上面勾选需要回写的 Bug。'),
            ),
            h('div', { className: 'ztaw-modal-foot' },
              h('span', { className: 'ztaw-count' }, props.summary || ''),
              h('span', { className: 'ztaw-grow' }),
              h('button', { type: 'button', className: 'ztaw-btn', onClick: props.onClose }, '关闭'),
              h('button', {
                type: 'button', className: 'ztaw-btn ztaw-btn-primary',
                disabled: props.submitting || !rows.length,
                onClick: props.onSubmit,
              }, props.submitting ? '提交中…' : '全部提交'),
            ),
          ),
        );
      }

      // ───────────────────────── 主面板 ─────────────────────────
      function ZentaoPanel() {
        var [status, setStatus] = useState(paneCache.status);
        var [statusError, setStatusError] = useState(false);
        // 不要把 EXAMPLE_URL 当默认值写进输入框：示例地址与真实实例不同源，
        // 用户直接点「读取」只会拿到「链接与已登录实例不同源」。示例留在 placeholder 里。
        var [url, setUrl] = useState(paneCache.url || loadLastUrl() || '');
        var [list, setList] = useState(paneCache.list);
        var [selected, setSelected] = useState(paneCache.selected || {});
        var [expanded, setExpanded] = useState(paneCache.expanded || {});
        var [details, setDetails] = useState({});
        var [detailLoading, setDetailLoading] = useState({});
        var [imgTick, setImgTick] = useState(0);
        var [search, setSearch] = useState('');
        var [instruction, setInstruction] = useState(paneCache.instruction || loadInstruction());
        var [templates, setTemplates] = useState(paneCache.templates || loadTemplates());
        var [notice, setNotice] = useState(paneCache.notice || { text: '就绪。填入禅道 Bug 浏览链接后点「读取」。', tone: 'info' });
        var [busy, setBusy] = useState('');
        var [showLogin, setShowLogin] = useState(false);
        var [showWriteback, setShowWriteback] = useState(false);
        var [wbRows, setWbRows] = useState([]);
        var [wbResults, setWbResults] = useState({});
        var [wbSubmitting, setWbSubmitting] = useState(false);

        var detailPromise = useRef({});
        var urlTouched = useRef(false);
        // 列表请求序号：旧请求的迟到响应必须丢弃，否则会把新 URL 的列表覆盖回旧结果。
        var readSeq = useRef(0);
        // 「新建会话」在途锁：busy 是渲染状态，同一 tick 的两次点击可能都读到空值。
        var dispatchLock = useRef(false);

        var say = function (text, tone) {
          var n = { text: text, tone: tone || 'info' };
          setNotice(n);
          paneCache.notice = n;
        };

        var applyStatus = function (st, msg) {
          if (st) { setStatus(st); paneCache.status = st; setStatusError(false); }
          if (msg) say(msg, 'ok');
        };

        var refreshStatus = function (silent) {
          return rpcValue('status', {}).then(function (st) {
            applyStatus(st, null);
            if (!silent) say('已刷新：' + (st && st.loggedIn ? '已登录 ' + (st.account || '') : '未登录/未配置'), st && st.loggedIn ? 'ok' : 'warn');
            return st;
          }).catch(function (e) {
            setStatusError(true);
            if (!silent) say('读取状态失败：' + ((e && e.message) || ''), 'err');
            return null;
          });
        };

        useEffect(function () {
          injectCss();
          refreshStatus(true).then(function (st) {
            // 用户没动过输入框且本机也没存过：用 host 记的上次 URL（首次仍是示例链接）
            if (st && st.lastUrl && !urlTouched.current && !paneCache.url && !loadLastUrl()) setUrl(st.lastUrl);
          });
        }, []);

        // 面板卸载（切到会话视图）后重挂时恢复现场
        useEffect(function () {
          paneCache.url = url; paneCache.instruction = instruction;
          paneCache.selected = selected; paneCache.expanded = expanded;
          paneCache.list = list; paneCache.templates = templates;
        });

        var items = (list && Array.isArray(list.items)) ? list.items : [];

        var filtered = useMemo(function () {
          var q = String(search || '').trim().toLowerCase();
          if (!q) return items;
          return items.filter(function (c) {
            var hay = [String(c.id), c.title, c.assignedTo, c.status, c.moduleTitle, c.productName]
              .join(' ').toLowerCase();
            return hay.indexOf(q) >= 0;
          });
        }, [items, search]);

        var selectedItems = useMemo(function () {
          return items.filter(function (c) { return selected[itemKey(c)]; });
        }, [items, selected]);

        var allOn = filtered.length > 0 && filtered.every(function (c) { return selected[itemKey(c)]; });

        var doRead = function (refresh) {
          var target = String(url || '').trim();
          if (!target) { say('请先填写禅道浏览链接', 'warn'); return Promise.resolve(null); }
          var seq = readSeq.current + 1;
          readSeq.current = seq;
          setBusy('read');
          say(refresh ? '正在刷新禅道状态…' : '正在读取禅道列表…', 'info');
          return rpcValue('list', { url: target, refresh: Boolean(refresh) }).then(function (r) {
            if (seq !== readSeq.current) return null; // 已被更新的请求取代：不写列表、不动 busy
            setBusy('');
            if (!r || !Array.isArray(r.items)) { say('返回数据格式异常：缺少 items', 'err'); return null; }
            setList(r);
            paneCache.list = r;
            saveLastUrl(target);
            // 刷新后保留仍然存在的选中项
            setSelected(function (prev) {
              var next = {};
              for (var i = 0; i < r.items.length; i++) {
                var k = itemKey(r.items[i]);
                if (prev[k]) next[k] = true;
              }
              return next;
            });
            say('读取成功：' + r.items.length + ' 条'
              + (r.pager && r.pager.total ? '（共 ' + r.pager.total + ' 条，第 ' + r.pager.page + ' 页）' : '')
              + (r.title ? ' · ' + r.title : ''), 'ok');
            return r;
          }).catch(function (e) {
            if (seq !== readSeq.current) return null;
            setBusy('');
            say('读取失败：' + ((e && e.message) || '未知错误'), 'err');
            return null;
          });
        };

        var toggle = function (key) {
          setSelected(function (prev) {
            var next = {};
            for (var k in prev) if (prev[k]) next[k] = true;
            if (next[key]) delete next[key]; else next[key] = true;
            return next;
          });
        };
        var toggleAll = function () {
          setSelected(function (prev) {
            var next = {};
            for (var k in prev) if (prev[k]) next[k] = true;
            var on = allOn;
            for (var i = 0; i < filtered.length; i++) {
              var key = itemKey(filtered[i]);
              if (on) delete next[key]; else next[key] = true;
            }
            return next;
          });
        };
        var invert = function () {
          setSelected(function (prev) {
            var next = {};
            for (var k in prev) if (prev[k]) next[k] = true;
            for (var i = 0; i < filtered.length; i++) {
              var key = itemKey(filtered[i]);
              if (next[key]) delete next[key]; else next[key] = true;
            }
            return next;
          });
        };

        var loadImages = function (cards) {
          var all = [];
          for (var i = 0; i < cards.length; i++) {
            var imgs = imagesOf(cards[i], details[itemKey(cards[i])]);
            for (var j = 0; j < imgs.length; j++) all.push(imgs[j]);
          }
          if (!all.length) return Promise.resolve();
          return Promise.all(all.slice(0, 12).map(function (img) {
            if (cachedImageSrc(img.url)) return Promise.resolve(null);
            return fetchImageValue(img);
          })).then(function () { setImgTick(function (n) { return n + 1; }); }, function () { /* 忽略 */ });
        };

        var fetchDetail = function (card) {
          var key = itemKey(card);
          if (details[key]) return Promise.resolve(details[key]);
          if (detailPromise.current[key]) return detailPromise.current[key];
          setDetailLoading(function (prev) { var n = {}; for (var k in prev) n[k] = prev[k]; n[key] = true; return n; });
          var p = loadDetail(card.kind, card.id).then(function (d) {
            delete detailPromise.current[key];
            setDetailLoading(function (prev) { var n = {}; for (var k in prev) n[k] = prev[k]; delete n[key]; return n; });
            if (d) {
              setDetails(function (prev) { var n = {}; for (var k in prev) n[k] = prev[k]; n[key] = d; return n; });
              loadImages([d]);
            }
            return d;
          });
          detailPromise.current[key] = p;
          return p;
        };

        var onExpand = function (key) {
          setExpanded(function (prev) {
            var next = {}; for (var k in prev) next[k] = prev[k];
            next[key] = !next[key];
            return next;
          });
          var card = items.filter(function (c) { return itemKey(c) === key; })[0];
          if (card && !details[key]) fetchDetail(card);
        };

        /** 保证选中条目都有 detail（Markdown 用描述/步骤），失败退化成卡片摘要。 */
        var ensureDetails = function (cards) {
          return Promise.all(cards.slice(0, 20).map(function (c) {
            return details[itemKey(c)] || fetchDetail(c) || Promise.resolve(null);
          })).then(function (rows) {
            var map = {};
            for (var i = 0; i < rows.length; i++) if (rows[i]) map[itemKey(rows[i])] = rows[i];
            return cards.map(function (c) { return details[itemKey(c)] || map[itemKey(c)] || c; });
          });
        };

        /** 选中条目上可下发的图片：明细已加载的用 detail.images，否则退化卡片 images。 */
        var selectionImages = function (merged) {
          var out = [];
          for (var i = 0; i < merged.length; i++) {
            var imgs = imagesOf(merged[i], merged[i]);
            for (var j = 0; j < imgs.length; j++) out.push(imgs[j]);
          }
          return out.slice(0, IMAGE_MAX_ATTACHMENTS);
        };

        var requireSelection = function () {
          if (!selectedItems.length) { say('请先勾选至少一条 Bug', 'warn'); return false; }
          return true;
        };

        /** 附件/图片统计文案（状态栏用）。 */
        var attachSummary = function (att) {
          var bits = [];
          if (att && att.saved) bits.push(att.saved + ' 个附件');
          if (att && att.failed && att.failed.length) {
            bits.push(att.failed.length + ' 个附件未落盘（' + (att.noDir ? '无会话工作目录' : att.failed[0].message) + '）');
          }
          return bits.length ? '，' + bits.join('；') : '';
        };

        /**
         * 统一的前置：补详情 → 落盘非图片附件 → 产出带「备注/附件」的上下文。
         * @returns {Promise<{md:string, merged:Array, att:object}>}
         */
        var prepareContext = function (merged, choice) {
          var dir = resolveTargetCwd(choice);
          return saveAttachments(merged, dir).then(function (att) {
            var md = buildContext(merged, instruction, {
              url: (list && list.url) || url,
              attachmentLines: att && att.lines,
            });
            return { md: md, merged: merged, att: att || { saved: 0, failed: [] } };
          });
        };

        var addToCurrent = function () {
          if (!requireSelection() || busy) return;
          setBusy('insert');
          say('正在整理上下文并写入当前会话…', 'info');
          ensureDetails(selectedItems).then(function (merged) {
            return prepareContext(merged, {}).then(function (p) {
              return insertToCurrentChat(p.md, selectionImages(p.merged)).then(function (r) {
                setBusy('');
                if (r && r.mode === 'service') say('已加入当前会话草稿' + (r.attached ? '（含 ' + r.attached + ' 张图片）' : '') + attachSummary(p.att) + (r.imageError ? '；图片未挂上：' + imageReasonText(r.imageError) : ''), 'ok');
                else if (r && r.mode === 'dom') say('已写入当前输入框（服务不可用，走 DOM 降级）' + attachSummary(p.att), 'warn');
                else if (r && r.failed) say('无法写入会话，复制到剪贴板也失败，请手动复制上下文', 'err');
                else say('没有可用的会话输入接口，上下文已复制到剪贴板，请粘贴发送', 'warn');
              });
            });
          }).catch(function (e) {
            setBusy('');
            say('加入当前会话失败：' + ((e && e.message) || ''), 'err');
          });
        };

        var newSession = function () {
          if (!requireSelection() || busy || dispatchLock.current) return;
          // busy 是渲染状态，同一 tick 的两次点击可能都读到空值：用 ref 锁住，绝不建出两个会话
          dispatchLock.current = true;
          setBusy('dispatch');
          say('正在新建会话并下发…', 'info');
          // 先建会话，再用新会话自己的 cwd 构建上下文（非图片附件落盘到该 cwd）：顺序反了会在
          // 「今天第一批、还没有当前会话」时把附件全部退化成裸链接。
          var build = function (cwd) {
            return ensureDetails(selectedItems).then(function (merged) {
              return prepareContext(merged, cwd ? { cwd: cwd } : {}).then(function (p) {
                return { md: p.md, images: selectionImages(p.merged), att: p.att };
              });
            }).catch(function () {
              // 详情/落盘链路异常时退化成卡片摘要上下文：会话仍可用，不出现「静默半发送」
              var cards = selectedItems || [];
              return {
                md: buildContext(cards, instruction, { url: (list && list.url) || url }),
                images: selectionImages(cards),
                att: { saved: 0, failed: [] },
                degraded: true,
              };
            });
          };
          var finish = function (r) {
            dispatchLock.current = false;
            setBusy('');
            if (r && r.ok) say(r.message + attachSummary(r.att), 'ok');
            else say((r && r.message) || '新建会话失败', 'warn');
          };
          dispatchToNewSessionWithCwd(build, {}).then(finish).catch(function (e) {
            dispatchLock.current = false;
            setBusy('');
            say('新建会话失败：' + ((e && e.message) || ''), 'err');
          });
        };

        var copyContext = function () {
          if (!requireSelection()) return;
          setBusy('copy');
          ensureDetails(selectedItems).then(function (merged) {
            return prepareContext(merged, {}).then(function (p) {
              return copyToClipboard(p.md).then(function (ok) {
                setBusy('');
                say(ok ? '上下文已复制到剪贴板（' + selectedItems.length + ' 条' + attachSummary(p.att) + '）' : '复制失败，请检查浏览器剪贴板权限', ok ? 'ok' : 'err');
              });
            });
          }).catch(function (e) {
            setBusy('');
            say('复制失败：' + ((e && e.message) || ''), 'err');
          });
        };

        var openWriteback = function () {
          if (!requireSelection()) return;
          setWbRows(selectedItems.map(function (c) {
            return {
              kind: c.kind, id: c.id, title: c.title, status: c.status,
              action: 'comment', comment: defaultCommentFor(c), resolution: '', resolvedBuild: '',
            };
          }));
          setWbResults({});
          setShowWriteback(true);
        };

        var onWbChange = function (key, patch) {
          setWbRows(function (prev) {
            return prev.map(function (r) {
              if (cardKey(r.kind, r.id) !== key) return r;
              var next = {}; for (var k in r) next[k] = r[k];
              for (var p in patch) next[p] = patch[p];
              return next;
            });
          });
        };

        var submitWriteback = function () {
          if (wbSubmitting) return; // 重入保护：双击/重复触发只允许一个在途写回
          var payload = buildWriteItems(wbRows);
          if (!payload.length) { say('没有可提交的回写条目', 'warn'); return; }
          setWbSubmitting(true);
          say('正在回写 ' + payload.length + ' 条…', 'info');
          rpcValue('writeback', { items: payload }).then(function (v) {
            var results = (v && Array.isArray(v.results)) ? v.results : [];
            var map = {};
            var okCount = 0;
            for (var i = 0; i < results.length; i++) {
              var r = results[i] || {};
              map[cardKey(r.kind, r.id)] = r;
              if (r.ok) okCount++;
            }
            setWbResults(map);
            setWbSubmitting(false);
            // 分母用「提交了几条」而不是「返回了几条」：宿主少返回/不返回结果时不能误报成功。
            var summary = '回写完成：成功 ' + okCount + ' / ' + payload.length + ' 条'
              + (results.length < payload.length ? '（宿主只返回 ' + results.length + ' 条结果）' : '');
            var tone = (payload.length > 0 && okCount === payload.length && results.length === payload.length) ? 'ok' : 'warn';
            say(summary, tone);
            // 成功后自动刷新状态；刷新自己的提示会盖掉回写结论，所以在刷新结束后把结论写回状态栏。
            if (list) doRead(true).then(function () { say(summary, tone); });
          }).catch(function (e) {
            setWbSubmitting(false);
            say('回写失败：' + ((e && e.message) || '未知错误'), 'err');
          });
        };

        var useTemplate = function (t) { setInstruction(t); saveInstruction(t); };
        var saveTemplate = function () {
          var next = saveTemplates(templates.concat([instruction]));
          setTemplates(next);
          paneCache.templates = next;
          say(next.length > templates.length ? '已存为模板（' + next.length + '/' + MAX_TEMPLATES + '）' : '模板未变化或已达上限', 'ok');
        };
        var clearTemplates = function () {
          var next = saveTemplates([]);
          setTemplates(next);
          paneCache.templates = next;
          say('已清空指令模板', 'ok');
        };

        var doLoginDone = function (st, msg) {
          setShowLogin(false);
          applyStatus(st, msg);
        };
        var doLogout = function (id) {
          rpcValue('logout', id ? { id: id } : {}).then(function (st) {
            applyStatus(st, id ? '已登出该账号' : '已登出当前账号');
          }).catch(function (e) { say('登出失败：' + ((e && e.message) || ''), 'err'); });
        };

        var statusText = status
          ? ((status.alias ? status.alias + ' · ' : '') + (status.account || '未登录') + ' @ ' + (status.baseUrl || '未配置'))
          : (statusError ? '状态读取失败' : '正在读取状态…');

        var wbSummary = (function () {
          var keys = Object.keys(wbResults);
          if (!keys.length) return '';
          var ok = 0;
          for (var i = 0; i < keys.length; i++) if (wbResults[keys[i]].ok) ok++;
          return '成功 ' + ok + ' / ' + keys.length;
        })();

        return h('div', { className: 'ztaw-root' },
          h('div', { className: 'ztaw-mast' },
            h('span', { className: 'ztaw-mark' }, h(ZentaoGlyph, { size: 16 })),
            h('span', { className: 'ztaw-mast-title' }, '禅道AI工作台'),
            h('span', { className: 'ztaw-grow' }),
            h('span', { className: 'ztaw-mast-sub', title: statusText }, statusText),
            h(StatusDot, { status: status, error: statusError }),
            h('button', { type: 'button', className: 'ztaw-btn ztaw-btn-sm', onClick: function () { setShowLogin(true); } }, '设置/登录'),
          ),

          h('div', { className: 'ztaw-row ztaw-row-url' },
            h('input', {
              className: 'ztaw-input', style: { flex: '1', minWidth: '0' }, value: url, spellCheck: false,
              placeholder: EXAMPLE_URL,
              'aria-label': '禅道浏览链接',
              onChange: function (e) { urlTouched.current = true; setUrl(e.target.value); },
              onKeyDown: function (e) { if (e.key === 'Enter') doRead(false); },
            }),
            h('button', { type: 'button', className: 'ztaw-btn ztaw-btn-primary', disabled: busy === 'read', onClick: function () { doRead(false); } }, busy === 'read' ? '读取中…' : '读取'),
          ),

          h('div', { className: 'ztaw-row ztaw-row-tool' },
            h('label', { className: 'ztaw-check' },
              h('input', { type: 'checkbox', className: 'ztaw-cbx', checked: allOn, onChange: toggleAll }),
              '全选',
            ),
            h('button', { type: 'button', className: 'ztaw-btn ztaw-btn-sm', onClick: invert }, '反选'),
            h('span', { className: 'ztaw-count' }, '已选 ' + selectedItems.length + '/' + items.length),
            h('input', {
              className: 'ztaw-search', value: search, placeholder: '搜索 ID/标题/负责人',
              'aria-label': '搜索条目',
              onChange: function (e) { setSearch(e.target.value); },
            }),
            h('button', { type: 'button', className: 'ztaw-btn ztaw-btn-sm', disabled: busy === 'read', onClick: function () { refreshStatus(true); doRead(true); } }, '刷新状态'),
          ),

          h('div', { className: 'ztaw-list' },
            filtered.length
              ? filtered.map(function (c) {
                var key = itemKey(c);
                return h(ListItem, {
                  key: key, card: c, detail: details[key], selected: Boolean(selected[key]),
                  expanded: Boolean(expanded[key]), detailLoading: Boolean(detailLoading[key]),
                  onToggle: toggle, onExpand: onExpand,
                });
              })
              : h('div', { className: 'ztaw-empty' }, items.length ? '没有匹配的条目' : '还没有数据。填入链接后点「读取」。'),
          ),

          h('div', { className: 'ztaw-instr' },
            h('textarea', {
              className: 'ztaw-textarea', value: instruction, 'aria-label': '处理指令',
              onChange: function (e) { setInstruction(e.target.value); saveInstruction(e.target.value); },
            }),
            h(ChipRow, { templates: templates, onUse: useTemplate, onSave: saveTemplate, onClear: clearTemplates }),
          ),

          h('div', { className: 'ztaw-actions' },
            h('button', { type: 'button', className: 'ztaw-btn ztaw-btn-primary', disabled: Boolean(busy), onClick: addToCurrent }, '加入当前会话'),
            h('button', { type: 'button', className: 'ztaw-btn ztaw-btn-primary', disabled: Boolean(busy), onClick: newSession }, busy === 'dispatch' ? '新建中…' : '新建会话并处理'),
            h('button', { type: 'button', className: 'ztaw-btn', disabled: !selectedItems.length, onClick: openWriteback }, '回写禅道'),
            h('button', { type: 'button', className: 'ztaw-btn', disabled: Boolean(busy), onClick: copyContext }, '复制上下文'),
          ),

          h('div', {
            className: 'ztaw-statusbar' + (notice.tone && notice.tone !== 'info' ? ' ' + notice.tone : ''),
            role: 'status', 'aria-live': 'polite',
          },
            h('span', { className: 'ztaw-txt', title: notice.text }, notice.text),
          ),

          showLogin ? h(LoginModal, {
            status: status, onClose: function () { setShowLogin(false); },
            onDone: doLoginDone, onLogout: doLogout,
          }) : null,

          showWriteback ? h(WritebackModal, {
            rows: wbRows, results: wbResults, submitting: wbSubmitting, summary: wbSummary,
            onClose: function () { setShowWriteback(false); },
            onChange: onWbChange, onSubmit: submitWriteback,
          }) : null,
        );
      }

      function ZentaoAiMainPanel() {
        useEffect(function () { injectCss(); }, []);
        return h('div', { className: 'ztaw-main' },
          h('div', { className: 'ztaw-dragband', 'data-window-drag': true, 'aria-hidden': 'true' }),
          h(ZentaoPanel, null),
        );
      }

      /**
       * 会话头部「禅道AI」按钮（conversation.session.header.actions）。
       * inject(sessionId) 经 props.zentaoAiSessionId 传入 → 记进模块级 lastSessionId，
       * 「加入当前会话」就能精确落在这个会话上。
       */
      function ZentaoAiHeaderAction(props) {
        // 头部动作是 session 作用域 slot：sessionId 同时以 standard prop 和 inject 结果两种方式到达，
        // 任一可用就记下，保证「加入当前会话」落在这个会话上。
        var sessionId = (props && (props.zentaoAiSessionId || props.sessionId)) || null;
        return h('button', {
          type: 'button',
          className: 'ztaw-btn ztaw-btn-sm',
          title: '打开禅道AI工作台（加入会话时写入本会话）',
          onClick: function () {
            if (sessionId) lastSessionId = sessionId;
            try {
              var layout = lookupService('layout');
              if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID);
            } catch (e) { /* 面板未注册时不跳转，只是不切换视图 */ }
          },
        }, h(ZentaoGlyph, { size: 13 }), h('span', null, '禅道AI'));
      }

      /** 旧版 DSH（无 main/sidebar.panellist slot）悬浮兜底入口。 */
      function ZentaoFab() {
        useEffect(function () { injectCss(); }, []);
        var [open, setOpen] = useState(false);
        if (!open) {
          return h('button', {
            type: 'button', className: 'ztaw-fab',
            onClick: function () { setOpen(true); },
          }, '禅道AI');
        }
        return h('div', {
          style: {
            position: 'fixed', right: '18px', bottom: '18px', zIndex: 41,
            width: 'min(560px, calc(100vw - 36px))', height: 'min(78vh, 720px)',
            display: 'flex', flexDirection: 'column',
            border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-md)',
            background: 'var(--dsw-alias-bg-layer-2)', overflow: 'hidden',
            boxShadow: '0 12px 40px rgba(0,0,0,.28)',
          },
          role: 'dialog', 'aria-label': '禅道AI工作台',
        },
          h('div', { className: 'ztaw-mast' },
            h('span', { className: 'ztaw-mark' }, h(ZentaoGlyph, { size: 16 })),
            h('span', { className: 'ztaw-mast-title' }, '禅道AI工作台'),
            h('span', { className: 'ztaw-grow' }),
            h('button', { type: 'button', className: 'ztaw-btn ztaw-btn-sm', onClick: function () { setOpen(false); } }, '关闭'),
          ),
          h('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } },
            h(ZentaoPanel, null),
          ),
        );
      }

      // ───────────────────────── 注册 ─────────────────────────
      var inject = ['slots', 'connection'];
      var leftWired = false;
      // apply 里创建的资源（slot 注册 / 样式 / 定时器）必须可回收：插件禁用或热重载会再执行一次 apply，
      // 不回收就会在同一页面里叠出第二个图标、第二个面板和第二个样式节点。
      var overlayTimer = null;

      /**
       * 注册左侧栏全局面板：sidebar.panellist（图标行）+ main（keyed slot，key 与图标 id 同值）。
       * 声明感知嵌套 inject：两个 slot 都就绪才整组注册，任一失败回滚另一侧。
       */
      function registerPanelGroup(id, order, labelOf, IconComp, MainComp) {
        var slots = appCtx.slots;
        return slots.inject('main', function () {
          return slots.inject('sidebar.panellist', function () {
            var stopMain = slots.register({ name: 'main', key: id }, MainComp);
            var stopIcon;
            try {
              stopIcon = slots.register({ name: 'sidebar.panellist', id: id, order: order, label: labelOf }, IconComp);
            } catch (e) {
              try { stopMain(); } catch (e2) { /* 忽略 */ }
              throw e;
            }
            return function () {
              try { stopIcon(); } catch (e2) { /* 忽略 */ }
              try { stopMain(); } catch (e2) { /* 忽略 */ }
            };
          });
        });
      }

      function registerLeftSidebar() {
        var stop = registerPanelGroup(PANEL_ID, 33, function () { return '禅道AI'; }, ZentaoAiSidebarIcon, ZentaoAiMainPanel);
        leftWired = true;
        return stop;
      }

      function registerHeaderAction() {
        return appCtx.slots.inject('conversation.session.header.actions', function () {
          return appCtx.slots.register({
            name: 'conversation.session.header.actions',
            id: 'zentao-ai',
            order: 50,
            inject: function (sessionId) { return { zentaoAiSessionId: sessionId }; },
          }, ZentaoAiHeaderAction);
        });
      }

      function registerOverlay() {
        if (leftWired) return;
        try {
          return appCtx.slots.inject('shell.overlay', function () {
            return appCtx.slots.register({ name: 'shell.overlay', id: OVERLAY_ID, order: 20 }, ZentaoFab);
          });
        } catch (e) {
          try { console.error('[dsh-zentao-ai-workbench] overlay slot unavailable', e); } catch (e2) { /* 忽略 */ }
        }
        return undefined;
      }

      function apply(ctx) {
        appCtx = ctx;
        if (!hasReact) return; // node 自检环境：不注册 UI，只保留 _test 可用的服务上下文
        injectCss();
        var disposers = [];
        try {
          var stopLeft = registerLeftSidebar();
          if (typeof stopLeft === 'function') disposers.push(stopLeft);
        } catch (e) {
          try { console.error('[dsh-zentao-ai-workbench] register panel failed', e); } catch (e2) { /* 忽略 */ }
        }
        try {
          var stopHeader = registerHeaderAction();
          if (typeof stopHeader === 'function') disposers.push(stopHeader);
        } catch (e) {
          try { console.error('[dsh-zentao-ai-workbench] register header action failed', e); } catch (e2) { /* 忽略 */ }
        }
        if (typeof setTimeout === 'function') {
          if (overlayTimer) { try { clearTimeout(overlayTimer); } catch (e) { /* 忽略 */ } overlayTimer = null; }
          var timer = setTimeout(function () {
            if (overlayTimer === timer) overlayTimer = null;
            if (!leftWired) registerOverlay();
          }, 2500);
          overlayTimer = timer;
          // 只清理自己那一次 apply 的定时器：重载后新旧两代 apply 可能交错，别把新定时器掐掉。
          disposers.push(function () {
            try { clearTimeout(timer); } catch (e) { /* 已清理 */ }
            if (overlayTimer === timer) overlayTimer = null;
          });
        }
        var dispose = function () {
          leftWired = false;
          for (var i = 0; i < disposers.length; i++) {
            try { disposers[i](); } catch (e) { /* 已清理 */ }
          }
          disposers.length = 0;
        };
        // 用 ctx.effect 把清理权交给插件 fiber（CONTRACT §5 的装载形态；旧版宿主没有 effect 就只返回清理函数）。
        if (typeof ctx.effect === 'function') {
          try { ctx.effect(function () { return dispose; }, 'dsh-zentao-ai-workbench: ui'); } catch (e) {
            try { console.warn('[dsh-zentao-ai-workbench] ctx.effect unavailable, UI cleanup not owned', e); } catch (e2) { /* 忽略 */ }
          }
        }
        return dispose;
      }

      exports.name = 'dsh-zentao-ai-workbench';
      exports.inject = inject;
      exports.apply = apply;
      exports._test = {
        // 常量
        CHANNEL: CHANNEL,
        PANEL_ID: PANEL_ID,
        EXAMPLE_URL: EXAMPLE_URL,
        DEFAULT_INSTRUCTION: DEFAULT_INSTRUCTION,
        MAX_TEMPLATES: MAX_TEMPLATES,
        WRITEBACK_SECTION: WRITEBACK_SECTION,
        // 纯函数
        buildContext: buildContext,
        contextMarkdownFor: contextMarkdownFor,
        buildWriteItems: buildWriteItems,
        kindLabel: kindLabel,
        statusLabel: statusLabel,
        statusTone: statusTone,
        actionsFor: actionsFor,
        actionLabel: actionLabel,
        cardKey: cardKey,
        itemKey: itemKey,
        imagesOf: imagesOf,
        imageLines: imageLines,
        HISTORY_ACTION_LABEL: HISTORY_ACTION_LABEL,
        renderActions: renderActions,
        isImageFile: isImageFile,
        attachmentsOf: attachmentsOf,
        saveAttachments: saveAttachments,
        IMAGE_MAX_ATTACHMENTS: IMAGE_MAX_ATTACHMENTS,
        ACTION_MAX_IN_CONTEXT: ACTION_MAX_IN_CONTEXT,
        describeItem: describeItem,
        defaultCommentFor: defaultCommentFor,
        imageReasonText: imageReasonText,
        useDialogA11y: useDialogA11y,
        // 存储
        loadTemplates: loadTemplates,
        saveTemplates: saveTemplates,
        normTemplates: normTemplates,
        loadLastUrl: loadLastUrl,
        loadInstruction: loadInstruction,
        // 服务 / 会话
        lookupService: lookupService,
        rpcCall: rpcCall,
        rpcValue: rpcValue,
        currentSessionId: currentSessionId,
        resolveTargetCwd: resolveTargetCwd,
        sessionCwdOf: sessionCwdOf,
        currentInputTarget: currentInputTarget,
        inputTargetFor: inputTargetFor,
        insertToCurrentChat: insertToCurrentChat,
        openNewSession: openNewSession,
        createDraftSession: createDraftSession,
        commitDraft: commitDraft,
        dispatchToNewSession: dispatchToNewSession,
        dispatchToNewSessionWithCwd: dispatchToNewSessionWithCwd,
        KIND_ACTIONS: KIND_ACTIONS,
        attachImagesToDraft: attachImagesToDraft,
        fetchImageValue: fetchImageValue,
        bytesFromBase64: bytesFromBase64,
        imageDataUrlParts: imageDataUrlParts,
        imageCache: imageCache,
        tryInsertIntoComposer: tryInsertIntoComposer,
        copyToClipboard: copyToClipboard,
        paneCache: paneCache,
        getLastSessionId: function () { return lastSessionId; },
        setLastSessionId: function (v) { lastSessionId = v || null; return lastSessionId; },
        // 组件（注册契约自检用）
        ZentaoAiSidebarIcon: ZentaoAiSidebarIcon,
        ZentaoAiMainPanel: ZentaoAiMainPanel,
        ZentaoAiHeaderAction: ZentaoAiHeaderAction,
        ZentaoFab: ZentaoFab,
        ZentaoPanel: ZentaoPanel,
        ListItem: ListItem,
        DetailBlock: DetailBlock,
        LoginModal: LoginModal,
        WritebackModal: WritebackModal,
        StatusDot: StatusDot,
        ChipRow: ChipRow,
        registerPanelGroup: registerPanelGroup,
        registerLeftSidebar: registerLeftSidebar,
        registerHeaderAction: registerHeaderAction,
        registerOverlay: registerOverlay,
        isLeftWired: function () { return leftWired; },
      };
      return module.exports;
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
