// 拆键 —— Phase 0 §五 的确定处置
//
// 背景（实测）：`anyOf` 语义上只是「满足其一」，**不提供互斥保证**。7 次完整 Delta 中 2 次出现
// 单个 op 同时带 `entities` + `change`；而服务端**不会拒**（`additionalProperties:false` 未生效）。
//
// 处置：不改 schema、不改 prompt —— **规则层无条件拆键**：对每个 op，按它带的键拆成 N 个单键 op。
// 因为 Delta 的合并语义本就逐键独立（gold/rep 求和、entities 纯追加、change 逐人、lost 拼接），
// 拆键**语义完全等价、零损耗**。
import { OP_KEYS, type Delta, type DeltaOp, type OpKey } from './types.ts';

export interface SplitResult {
  ops: DeltaOp[];
  /** 原 op 带多键的次数（可打点观察混键率是否随 prompt 调整而变化） */
  mixedCount: number;
  /** 出现过的非法键（该键被丢弃，其余合法键照常拆出） */
  unknownKeys: string[];
  /** 整个 op 被丢弃的次数（不是对象 / 一个合法键都没有） */
  droppedOps: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 接受 `[op, ...]` 或 `{ ops: [...] }` 两种形态（模型两种都可能给） */
export function asOpArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isPlainObject(raw) && Array.isArray(raw.ops)) return raw.ops;
  return [];
}

export function splitMixedOps(raw: unknown): SplitResult {
  const out: SplitResult = { ops: [], mixedCount: 0, unknownKeys: [], droppedOps: 0 };
  for (const item of asOpArray(raw)) {
    if (!isPlainObject(item)) {
      out.droppedOps++;
      continue;
    }
    const keys = Object.keys(item);
    const known = keys.filter((k): k is OpKey => (OP_KEYS as readonly string[]).includes(k));
    for (const k of keys) {
      if (!(OP_KEYS as readonly string[]).includes(k) && !out.unknownKeys.includes(k)) {
        out.unknownKeys.push(k);
      }
    }
    if (known.length === 0) {
      out.droppedOps++;
      continue;
    }
    if (known.length > 1) out.mixedCount++;
    for (const k of known) {
      out.ops.push({ [k]: item[k] } as unknown as DeltaOp);
    }
  }
  return out;
}

export function toDelta(ops: DeltaOp[]): Delta {
  return { ops };
}
