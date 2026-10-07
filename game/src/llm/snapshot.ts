// 请求 / 响应快照落盘 —— 把每一次真实调用固化成**可复现的用例**
//
// 这是 Phase 2 最值钱的一件基础设施。模型输出天生不确定，没有快照就只能靠反复花钱撞；
// 有了它，`llm/replay.ts` 能在**不发一次网络**的前提下重跑同一条链路，
// 于是"这次落账对不对"变成可断言的事，而不是"看起来差不多"。
//
// 目录约定（沿用 `probe/out/` 已验证过的形状）：
//   game/runs/<YYYY-MM-DDTHH-mm-ss>/
//     ├── 01-resolve.check.request.json
//     ├── 01-resolve.check.response.json
//     ├── 02-resolve.settle.request.json
//     ├── 02-resolve.settle.response.json
//     └── INDEX.md            ← 人眼可读的调用清单
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `game/runs/`（本模块在 `game/src/llm/`） */
export const RUNS_DIR_URL = new URL('../../runs/', import.meta.url);
/** Windows 上不能直接用 `URL.pathname`（会得到 `/D:/...`）⇒ 一律走 fileURLToPath */
export const RUNS_DIR = fileURLToPath(RUNS_DIR_URL);

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(
    d.getMinutes(),
  )}-${p(d.getSeconds())}`;
}

export interface SnapshotEntry {
  seq: number;
  callPoint: string;
  request: unknown;
  response: unknown;
}

export class SnapshotWriter {
  readonly dir: string;
  private seq = 0;
  private readonly index: string[] = [];

  constructor(label?: string) {
    this.dir = path.join(RUNS_DIR, stamp() + (label ? `-${label}` : ''));
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** 记一次往返。`response` 是**原始 HTTP JSON**（不是解析后的 args）—— 证据要留全。 */
  record(callPoint: string, request: unknown, response: unknown, note?: string): void {
    this.seq += 1;
    const nn = String(this.seq).padStart(2, '0');
    const base = `${nn}-${callPoint}`;
    fs.writeFileSync(path.join(this.dir, `${base}.request.json`), JSON.stringify(request, null, 2), 'utf8');
    fs.writeFileSync(path.join(this.dir, `${base}.response.json`), JSON.stringify(response, null, 2), 'utf8');
    this.index.push(`| ${this.seq} | \`${callPoint}\` | ${note ?? ''} |`);
    this.flushIndex();
  }

  private flushIndex(): void {
    const md = [`# 调用快照 · ${path.basename(this.dir)}`, '', '| # | 调用点 | 备注 |', '|---|---|---|', ...this.index, ''].join('\n');
    fs.writeFileSync(path.join(this.dir, 'INDEX.md'), md, 'utf8');
  }
}

/** 读一个快照目录（按序号升序）。`--replay` 用它。 */
export function readSnapshots(dir: string): SnapshotEntry[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.request.json'));
  const out: SnapshotEntry[] = [];
  for (const f of files) {
    const m = /^(\d+)-(.+)\.request\.json$/.exec(f);
    if (!m) continue;
    const seq = Number(m[1]);
    const callPoint = m[2];
    const respPath = path.join(dir, `${m[1]}-${callPoint}.response.json`);
    out.push({
      seq,
      callPoint,
      request: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')),
      response: JSON.parse(fs.readFileSync(respPath, 'utf8')),
    });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * 从原始响应里摘出 `tool_calls[0]` —— **回放与实跑共用这一条解析**。
 * ⚠️ 共用是刻意的：回放若走另一套解析，就证明不了"实跑那条路"是对的。
 */
export function extractToolCall(raw: unknown): {
  finishReason: string | null;
  toolName: string | null;
  /**
   * `tool_calls[0].id` —— **回放与实跑共用**。
   * ⚠️ 两段式的第二次调用必须回填 `assistant(tool_calls) → tool(同 id)`；
   *    这个 id 是那次对话能不能接上的关键，所以要从响应里留住（不是重新编一个）。
   */
  toolCallId: string | null;
  argsRaw: string | null;
  usage: Record<string, number> | null;
} {
  const j = raw as {
    choices?: Array<{
      finish_reason?: string;
      message?: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
    }>;
    usage?: Record<string, number>;
  } | null;
  const choice = j && Array.isArray(j.choices) && j.choices[0] ? j.choices[0] : null;
  const tc = choice?.message?.tool_calls?.[0] ?? null;
  return {
    finishReason: choice?.finish_reason ?? null,
    toolName: tc?.function?.name ?? null,
    toolCallId: tc?.id ?? null,
    argsRaw: tc?.function?.arguments ?? null,
    usage: j?.usage ?? null,
  };
}
