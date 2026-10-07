// 难度骰
// 形式：±d4，最多 2 个。三源（事件难度 / 人数修正 / 危险区）**合计一律钳在 ±2d4**。
import type { Difficulty } from '../contract/types.ts';
import type { Rng } from './rng.ts';

/** 难度骰封顶（有符号 d4 个数） */
export const DICE_CAP = 2;

/** 危险区 */
export type DangerZone = '正常' | '迷失' | '沉溺';

/** 有符号 d4 个数：**正 = 惩罚（更难）**，**负 = 奖励（更易）** */
export type DiceCount = number;

/** 来源一：事件本身难度（LLM 判定） */
export function difficultyDice(d: Difficulty): DiceCount {
  switch (d) {
    case '无修正':
      return 0;
    case '惩罚1':
      return +1;
    case '惩罚2':
      return +2;
    case '奖励1':
      return -1;
    case '奖励2':
      return -2;
  }
}

/** 来源二：人数修正（规则层算）—— 正达门槛无修正；多 1 人 −1d4；多 ≥2 人 −2d4（封顶） */
export function peopleDice(participants: number, minPeople: number, maxPeople: number): DiceCount {
  if (participants > maxPeople) return 0; // 越界由闸门拦，这里不叠加
  const excess = participants - minPeople;
  if (excess <= 0) return 0;
  if (excess === 1) return -1;
  return -2;
}

/** 来源三：危险区修正（规则层恒定：迷失区 +1d4、沉溺区 −1d4） */
export function zoneDice(zone: DangerZone): DiceCount {
  switch (zone) {
    case '正常':
      return 0;
    case '迷失':
      return +1;
    case '沉溺':
      return -1;
  }
}

/** 三源合计 —— **一律钳在 ±2d4**（来源三自己也吃这个封顶） */
export function composeDice(...sources: DiceCount[]): DiceCount {
  const sum = sources.reduce((a, b) => a + b, 0);
  return Math.max(-DICE_CAP, Math.min(DICE_CAP, sum));
}

export interface ModifierRoll {
  count: DiceCount;
  rolls: number[];
  /** 加到 R 上的量：正 = 更难 */
  total: number;
}

export function rollModifier(count: DiceCount, rng: Rng): ModifierRoll {
  const n = Math.abs(count);
  const rolls: number[] = [];
  for (let i = 0; i < n; i++) rolls.push(rng.d4());
  const sum = rolls.reduce((a, b) => a + b, 0);
  return { count, rolls, total: Math.sign(count) * sum };
}
