// x 与 L
//
// `x` = 4（玩家）＋ Σ 每个下属「当日可用点数」
//      正常 4 点 · 在途 0 点 · 归队日 `d` 点（`d` = 他启程日的实际消耗）
//
// ⚠️ **两个口径，别混**（2026-09-18 时钟模型改造后尤其要分清）：
//    · `subordinatePoints` = 该人**今天的额度**（总量口径，用于生成侧的 `x` / `L`）；
//    · `actionPoints.byNpc[id]` = 该人**今天还剩多少容量**（余额口径，闸门 ② 只看这个）。
//    玩家不在这两个口径里 —— 他的预算是**时间读数** `clock.usedToday`（见 `rules/clock.ts`）。
import { PLAYER_ID, isAvailable, returnToday, type Ledger, type Person } from '../ledger/types.ts';
import { sum } from './num.ts';

/** 每个通道的日预算（玩家 = 时间；下属 = 容量） */
export const BASE_ACTION_POINTS = 4;
/** 自由事件条数铁律 `N ≤ 5` */
export const MAX_FREE_EVENTS = 5;

/** 单个下属「当日可用点数」 */
export function subordinatePoints(l: Ledger, p: Person, today: number): number {
  if (p.id === PLAYER_ID) return 0;
  if (!isAvailable(p, l, today)) return 0;
  const ret = returnToday(p.id, l, today);
  if (ret) return ret.depart_cost ?? ret.cost; // 归队日只回升 d 点
  return BASE_ACTION_POINTS;
}

export interface XResult {
  /** 当天可支配的行动点总量 */
  x: number;
  player: number;
  byNpc: Record<string, number>;
}

export function calcX(l: Ledger, today: number): XResult {
  const byNpc: Record<string, number> = {};
  let sub = 0;
  for (const p of l.entities.people) {
    if (p.id === PLAYER_ID) continue;
    const pts = subordinatePoints(l, p, today);
    byNpc[p.id] = pts;
    sub += pts;
  }
  return { x: BASE_ACTION_POINTS + sub, player: BASE_ACTION_POINTS, byNpc };
}

/**
 * 存量负荷 `C` = 往期未处理事件本日占用的成本（旧账优先）。
 * 事件需求 = **参与人数 × 每人档位** ⇒ 用 `cost × min_people`（最保守读法）。
 */
export function calcC(l: Ledger, today: number): number {
  return sum(
    l.events.live
      .filter((e) => e.status === '待处理' && e.created_day < today)
      .map((e) => e.cost * Math.max(1, e.min_people)),
  );
}

export interface LResult {
  x: number;
  c: number;
  /** 条数天然封顶：`N × 4` */
  byCount: number;
  /** 玩家能力封顶：`x − C` */
  byPoints: number;
  /** `L ≤ min(N × 4, x − C)`，只设上限、不设下限 */
  cap: number;
  /** 盈余 = `x − (C + L)` 的余量（生成侧给 LLM 看的） */
  surplus: number;
}

export function calcL(l: Ledger, today: number): LResult {
  const { x } = calcX(l, today);
  const c = calcC(l, today);
  const byCount = MAX_FREE_EVENTS * BASE_ACTION_POINTS;
  const byPoints = x - c;
  return {
    x,
    c,
    byCount,
    byPoints,
    cap: Math.max(0, Math.min(byCount, byPoints)),
    surplus: Math.max(0, byPoints),
  };
}
