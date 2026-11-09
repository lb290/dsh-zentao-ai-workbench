// dsh-zentao-ai-workbench — host 插件入口
//
// 单包双半边（与已安装的 dsh-zentao-panel 同构）：
//   host 半边：本文件 + lib/*（登录/取数/写回/缓存 + loopback RPC + Agent 工具）；
//   client 半边：client/client.js（侧栏图标 + 主面板，dsh.client 声明装载）。
//
// 能力：
//   - 输入禅道浏览链接（如 bug-browse-…-10-20.html）读取该页条目；
//   - 面板多选后把上下文交给已有会话或新会话；
//   - AI 处理完用 zentao_add_comment / zentao_update_status / zentao_write_back 直接回写禅道，
//     不需要人工登录禅道操作。

import { createZentaoWorkbenchService } from './service.mjs';
import { installZentaoWorkbenchRpc } from './rpc.mjs';
import { installZentaoWorkbenchTools } from './tools.mjs';

const name = 'dsh-zentao-ai-workbench';

/** tools 是硬依赖（写回能力靠它）；webServer/connection 懒取（缺失时降级为无面板）。 */
const inject = ['tools'];

export function apply(ctx, config = {}) {
  let logger = console;
  try { logger = ctx.logger?.(name) ?? console; } catch { logger = console; }
  const service = createZentaoWorkbenchService({
    logger,
    cacheTtlMs: config.cacheTtlMs ?? 60_000,
  });

  const boot = service.init();
  if (boot.configured) {
    logger.info?.(`dsh-zentao-ai-workbench: 恢复禅道配置（${boot.count} 个账号，当前 ${boot.account} @ ${boot.baseUrl}${boot.imported ? '，已从禅道面板导入' : ''}）`);
  } else {
    logger.info?.('dsh-zentao-ai-workbench: 尚未配置禅道，等待面板内登录');
  }

  const disposeTools = installZentaoWorkbenchTools(ctx, { service, log: logger });
  const disposeRpc = installZentaoWorkbenchRpc(ctx, { service, log: logger });

  return () => {
    try { disposeRpc?.(); } catch { /* 已清理 */ }
    try { disposeTools?.(); } catch { /* 已清理 */ }
  };
}

export { name, inject };
