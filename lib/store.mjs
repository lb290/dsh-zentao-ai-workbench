// dsh-zentao-ai-workbench — 本机配置存储
//
// 独立于已安装的 dsh-zentao-panel：自己的文件在 ~/.dsh/zentao-ai-workbench/config.json。
// 首次启动若本文件不存在，则从 ~/.dsh/zentao-panel/config.json 导入账号与 cookie
// （用户已经登录过禅道面板，就不必在新的工作台里再输一次密码）。
//
// 说明：密码按既有插件的惯例做 base64 存储（仅避免明文直读，不是加密）；
// 本机文件权限 0600。cookie 是长期登录态（za/zp/keepLogin），失效时用密码静默重登。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const SCHEMA_VERSION = 1;

function dshHome() {
  return process.env.DSH_HOME && String(process.env.DSH_HOME).trim()
    ? String(process.env.DSH_HOME).trim()
    : join(homedir(), '.dsh');
}

export function configPath() {
  return join(dshHome(), 'zentao-ai-workbench', 'config.json');
}

export function legacyPanelConfigPath() {
  return join(dshHome(), 'zentao-panel', 'config.json');
}

/** 地址 + 账号 → 稳定短 id（与 dsh-zentao-panel 同法，便于两边识别同一账号）。 */
export function accountId(baseUrl, account) {
  return createHash('sha1').update(`${String(baseUrl).replace(/\/+$/, '')}|${String(account)}`).digest('hex').slice(0, 12);
}

export function normAlias(v) {
  return String(v ?? '').trim().slice(0, 40);
}

export function encodeSecret(plain) {
  return Buffer.from(String(plain ?? ''), 'utf8').toString('base64');
}

export function decodeSecret(stored) {
  if (typeof stored !== 'string' || stored === '') return '';
  try { return Buffer.from(stored, 'base64').toString('utf8'); } catch { return ''; }
}

const EMPTY = () => ({ version: SCHEMA_VERSION, accounts: [], activeId: '', lastUrl: '' });

/** 读取本插件配置；文件缺失/损坏 → 空配置（不抛错，面板照常起）。 */
export function readConfig() {
  // 同步读：init() 在插件启动路径上，避免把 apply 变成 async。
  try {
    const raw = readFileSync(configPath(), 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return EMPTY();
  }
}

function normalizeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return EMPTY();
  const accounts = Array.isArray(cfg.accounts)
    ? cfg.accounts
        .filter((a) => a && typeof a === 'object' && a.baseUrl && a.account)
        .map((a) => ({
          id: typeof a.id === 'string' && a.id ? a.id : accountId(a.baseUrl, a.account),
          baseUrl: String(a.baseUrl).replace(/\/+$/, ''),
          account: String(a.account),
          alias: normAlias(a.alias),
          password: typeof a.password === 'string' ? a.password : '',
          cookies: a.cookies && typeof a.cookies === 'object' ? a.cookies : {},
          savedAt: Number(a.savedAt) || 0,
        }))
    : [];
  const activeId = accounts.some((a) => a.id === cfg.activeId) ? cfg.activeId : (accounts[0]?.id ?? '');
  return {
    version: SCHEMA_VERSION,
    accounts,
    activeId,
    lastUrl: typeof cfg.lastUrl === 'string' ? cfg.lastUrl : '',
  };
}

/** 原子写（同目录临时文件 + rename 语义；写失败只记日志不抛）。 */
export async function writeConfig(cfg) {
  const path = configPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(normalizeConfig(cfg), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { await chmod(path, 0o600); } catch { /* 平台不支持则忽略 */ }
    return true;
  } catch {
    return false;
  }
}

export async function clearConfig() {
  try { await rm(configPath(), { force: true }); return true; } catch { return false; }
}

/**
 * 从已安装的 dsh-zentao-panel 配置导入账号（含 cookie），供首启无缝使用。
 * 返回 {accounts, activeId} 或 null（无旧配置）。
 */
export async function importFromPanel() {
  try {
    const raw = await readFile(legacyPanelConfigPath(), 'utf8');
    const cfg = JSON.parse(raw);
    const list = Array.isArray(cfg?.accounts) ? cfg.accounts : [];
    const accounts = list
      .filter((a) => a && typeof a === 'object' && a.baseUrl && a.account)
      .map((a) => ({
        id: accountId(a.baseUrl, a.account),
        baseUrl: String(a.baseUrl).replace(/\/+$/, ''),
        account: String(a.account),
        alias: normAlias(a.alias),
        password: typeof a.password === 'string' ? a.password : '',
        cookies: a.cookies && typeof a.cookies === 'object' ? a.cookies : {},
        savedAt: Number(a.savedAt) || Date.now(),
      }));
    if (!accounts.length) return null;
    const activeId = accounts.some((a) => a.id === cfg.activeId) ? cfg.activeId : accounts[0].id;
    return { accounts, activeId };
  } catch {
    return null;
  }
}

export { SCHEMA_VERSION };
