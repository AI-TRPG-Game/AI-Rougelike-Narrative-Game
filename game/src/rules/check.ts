// 投骰 → 档位
//
// ⚠️ 这里有一条**绝不能写错**的规则：
//   端点必须在「原始骰」层判，**先于一切修正**。
//   一个 −d4 会把自然 20 救成 16，"5% 恒定大失败"当场失效。
import type { Check, Difficulty, Tier } from '../contract/types.ts';
import { composeDice, difficultyDice, peopleDice, rollModifier, zoneDice, type DangerZone, type DiceCount } from './dice.ts';
import type { Rng } from './rng.ts';

/** 纯阈值查表（唯一天然 20/1 的端点判定**不在这里**，见 resolveRoll） */
export function tierFrom(r: number, a: number): Tier {
  if (r <= Math.floor(a / 5)) return '大成功';
  if (r <= Math.floor(a / 2)) return '困难成功';
  if (r <= a) return '成功';
  return '失败';
}

export interface RollInput {
  a: number; // 主事者有效属性均值（已钳 [1, 20]）
  overflow: number;
  leaderId: string;
  eventDifficulty: Difficulty;
  participants: number;
  minPeople: number;
  maxPeople: number;
  zone: DangerZone;
}

export interface RollOutcome {
  tier: Tier;
  /** 原始 d20（**永不进 prompt**） */
  raw: number;
  /** R = d20 ± 难度骰 */
  adjusted: number;
  a: number;
  overflow: number;
  leaderId: string;
  diceCount: DiceCount;
  diceRolls: number[];
  modifierTotal: number;
  /** 端点命中时记录是哪一端（此时难度骰**不被消耗**） */
  endpoint: '大成功' | '大失败' | null;
}

export function resolveRoll(input: RollInput, rng: Rng): RollOutcome {
  const raw = rng.d20();
  const diceCount = composeDice(
    difficultyDice(input.eventDifficulty),
    peopleDice(input.participants, input.minPeople, input.maxPeople),
    zoneDice(input.zone),
  );
  const base = {
    a: input.a,
    overflow: input.overflow,
    leaderId: input.leaderId,
    diceCount,
  };

  // ① 端点恒定，先于一切修正判定 —— 注意此处 **不掷难度骰**
  if (raw === 20) {
    return { ...base, tier: '大失败', raw, adjusted: raw, diceRolls: [], modifierTotal: 0, endpoint: '大失败' };
  }
  if (raw === 1) {
    return { ...base, tier: '大成功', raw, adjusted: raw, diceRolls: [], modifierTotal: 0, endpoint: '大成功' };
  }

  // ② 其余情况：R = d20 ± 难度骰（有利减、不利加），再与 A 比档
  const mod = rollModifier(diceCount, rng);
  const adjusted = raw + mod.total;
  return {
    ...base,
    tier: tierFrom(adjusted, input.a),
    raw,
    adjusted,
    diceRolls: mod.rolls,
    modifierTotal: mod.total,
    endpoint: null,
  };
}

export interface NoRollOutcome {
  tier: Tier;
}

/**
 * 不需要掷骰的三种裁定（直接成功 / 直接失败 / 无需判定）。
 *
 * ⚠️ **契约的一处空缺**：`check.direct_result` 的 description 写「仅 verdict=直接成功/直接失败 时填，
 * 其余填『无』」，于是 `无需判定` 时**该给什么档位并没有写死**。
 * 本实现取一个明确默认：**`无需判定` → 成功**（另可被 `direct_result` 覆盖）。
 * ⇒ 待你裁定后回填文档；此处先按最保守的读法实现。
 * ⚠️ 2026-10-07：「拒绝」分支已随整条拒绝机制摘除 —— 荒诞 / 不合理输入由模型合理化，
 *    走法只剩这三种（`投骰` / `本次不裁定` 到不了这里，由调用方归入掷骰那条路）。
 */
export function outcomeForNonRoll(check: Check): NoRollOutcome {
  if (check.verdict === '无需判定') {
    return { tier: check.direct_result === '无' ? '成功' : check.direct_result };
  }
  // 直接成功 / 直接失败
  const fallback: Tier = check.verdict === '直接成功' ? '成功' : '失败';
  return { tier: check.direct_result === '无' ? fallback : check.direct_result };
}
