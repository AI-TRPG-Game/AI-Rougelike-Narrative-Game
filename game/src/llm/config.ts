// 配置 —— 从 `game/.env` 读。**这是全项目唯一读密钥的地方。**
//
// ⚠️ `llm/` 是第二个允许碰 Node 的目录（第一个是 `ledger/store-json.ts`）。
//    同构约束仍然成立：`contract/` `ledger/`(除 store-json) `rules/` `prompt/` `schema/`
//    一律不得 import Node —— 它们要能在浏览器里跑。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface LlmConfig {
  apiKey: string;
  betaBaseUrl: string;
  model: string;
}

/**
 * 极简 `.env` 解析：`KEY=VALUE`，忽略注释与空行，值两侧引号剥掉。
 * ⚠️ **行内注释自动剥离**：值里（引号外）出现的 `#` 起注释，`#` 及之后整段丢弃。
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    // ⚠️ 2026-10-09（用户裁定）：行内注释**自动剥**，不再让玩家手动修 ——
    //    旧版 .env.example 曾写 `DEEPSEEK_MODEL=deepseek-flash ##注释`，而本函数
    //    原先只跳过整行 `#` 开头的注释 ⇒ 注释尾巴整个混进 model 名发给 API，
    //    真实玩家当场 HTTP 400（supported: deepseek-flash… but you passed
    //    "deepseek-flash ##目前暂时只兼容deepseek家族的模型"）。
    //    key / URL / 模型名里都**不可能合法出现 `#`**（用户拍板）⇒ 按惯例当注释剥。
    //    引号内的 `#` 保留（显式引用的值算数）—— 与 dotenv 家族同一套规矩。
    if (v.startsWith('"') || v.startsWith("'")) {
      const q = v[0];
      const close = v.indexOf(q, 1);
      v = close > 0 ? v.slice(1, close) : v; // 闭合引号之后的东西（含行内注释）一并丢弃
    } else {
      const hash = v.indexOf('#');
      if (hash >= 0) v = v.slice(0, hash).trim();
    }
    out[k] = v;
  }
  return out;
}

/** `game/.env` 的绝对路径（本模块在 `game/src/llm/`） */
export const ENV_PATH = new URL('../../.env', import.meta.url);

export function loadConfig(): LlmConfig {
  let text = '';
  try {
    text = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    throw new Error(
      `读不到 ${fileURLToPath(ENV_PATH)}\n　　⇒ 复制 game/.env.example 为 game/.env，填入 DEEPSEEK_API_KEY`,
    );
  }
  const env = parseEnv(text);
  const apiKey = env.DEEPSEEK_API_KEY ?? '';
  if (apiKey === '' || apiKey.startsWith('sk-replace')) {
    throw new Error('game/.env 里的 DEEPSEEK_API_KEY 还没填（或仍是占位符）');
  }
  return {
    apiKey,
    betaBaseUrl: env.DEEPSEEK_BETA_BASE_URL || 'https://api.deepseek.com/beta',
    model: env.DEEPSEEK_MODEL || 'deepseek-flash',
  };
}

/**
 * 可用模型名 —— Phase 0 实测（`probe/models.mjs`）。
 * ❌ `deepseek-v4.1-flash` 不在其中：那是本产品的模型名，公开 API 不认。
 */
export const KNOWN_MODELS: readonly string[] = [
  'deepseek-flash',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-chat',
  'deepseek-reasoner',
];
