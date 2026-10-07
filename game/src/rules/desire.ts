// 欲向五档
// **系统只做一道算术**：`欲念 ← clamp(欲念 + 表值, 0, 100)`。LLM 只给档名，**数值写在规则层**。
import { POPUP_DESIRE_TIERS, type DesireTier } from '../contract/types.ts';
import type { DangerZone } from './dice.ts';
import { clamp } from './num.ts';

export const TIER_VALUE: Record<DesireTier, number> = {
  无关: 0,
  偏离: -3,
  趋近: 2,
  得偿: 4,
  盛宴: 8,
};

export const DESIRE_MIN = 0;
export const DESIRE_MAX = 100;

export function desireDelta(tier: DesireTier): number {
  const v = TIER_VALUE[tier];
  if (v === undefined) throw new Error(`未知的欲向档：${String(tier)}`);
  return v;
}

export function applyDesire(current: number, tier: DesireTier): number {
  return clamp(current + desireDelta(tier), DESIRE_MIN, DESIRE_MAX);
}

/** 档 A 的 `options[].欲向` 只允许 无关 / 偏离 / 趋近（**不含 得偿 / 盛宴**） */
export function isPopupTierLegal(tier: DesireTier): boolean {
  return POPUP_DESIRE_TIERS.includes(tier);
}

// ⚠️ **这里曾经有一个 `REWRITE_THRESHOLD = 60` 与 `crossedRewriteThreshold()`**（2026-10-05 删）。
//    它们唯一的职责是"欲念首破 60 ⇒ 次日 T0 调 `rewrite_desire` 重写欲望命题"。
//    用户裁定：**欲望命题一生只写一次**（`opening` 里一次成型）⇒ 60 失去全部语义，
//    现在 `desire.value` 上**不存在任何"到某个数就触发某件事"的档位** ——
//    剩下的分段读法只有终局那个窗口（`WINDOW_MIN ~ WINDOW_MAX`，75~80），
//    而它也**不是触发器**：终局是第 28 天无条件判的，判的是"此刻落在窗口里没有"。

// ── 危险区────────────────
//
// ⚠️ **危险区由欲念唯一决定**
//    ⇒ 推导放在规则层这里，**不由调用方传**。2026-09-21 之前 `handleEvent` / `sceneStep`
//    的 `zone` 参数永远吃默认 `'正常'`（UI 侧从不传它）⇒
//    「迷失区 +1d4 不利 / 沉溺区 −1d4 有利」这条规则**从来没有生效过**：
//    `zoneDice()` 本身在单测里是绿的，但**没有任何地方真的把欲念换算成 zone**。
//    「绿了但没测到」的又一例 —— 单元测绿 ≠ 路径被走到。
//
// 区间（与《设定.md》的表逐字对齐）：
//   1~24 迷失 · 25~74 常态 · 75~80 窗口 · 81~99 沉溺
// ⚠️ `0` 与 `100` 是**立即终结**（总表第 3 / 4 行），它们的 zone 只作兜底：
//    归到各自那一侧的极值（迷失 / 沉溺），**不写「正常」** —— 那会同时说错两件事。
export const LOST_MAX = 24;
export const INDULGE_MIN = 81;

export function dangerZoneOf(value: number): DangerZone {
  if (value <= LOST_MAX) return '迷失';
  if (value >= INDULGE_MIN) return '沉溺';
  return '正常';
}

// ── 欲念区间────────────
//
// ⚠️ **它与 `DangerZone` 不是同一个东西，别合并**：
//    · `DangerZone`（3 值：迷失 / 正常 / 沉溺）= **规则层自己用**的 —— 决定每日漂移与判定修正。
//      它眼里"常态"与"窗口"是同一种东西（两者都不收税、判定都不修正）⇒ 合成 `正常` 是对的。
//    · 欲念区间（4 值：迷失 / 常态 / 窗口 / 沉溺）= **给人看**的那一层。
//      《规则.md》:640「**欲念由规则层独算，不给任何 LLM（含区间名）**；玩家只能从区间语义与
//      「欲向」的手感里摸」⇒ 区间名是**给玩家的**、**不是**给模型的（两个读者，两份口径）。
//
// ⚠️ 2026-09-22（P5-B）之前，UI 顶栏直接印 `欲念 61` 与 `危险区 正常`：
//    前者把规则层独算的**数值**摊给了玩家；后者把"窗口"和"常态"压成同一个词
//    —— 而"窗口是唯一好结局"这条正是玩家摸得着的那点手感（《设定.md》:122
//    「越接近窗口，越诱人冲一把，也越容易冲过 80」）。两处都不该这么写。
export const DESIRE_BANDS = ['迷失', '常态', '窗口', '沉溺'] as const;
export type DesireBand = (typeof DESIRE_BANDS)[number];

/** 窗口的上下界 */
export const WINDOW_MIN = 75;
export const WINDOW_MAX = 80;

/**
 * 欲念 → 区间。四段的断点逐字照《设定.md》的区间列：
 * `0` / `1~24 迷失` / `25~74 常态` / `75~80 窗口` / `81~99 沉溺` / `100`。
 * ⚠️ `0` 与 `100` 是**立即终结**（总表第 3 / 4 行）⇒ 它们归到各自那一侧的极值区间
 *   （迷失 / 沉溺），与 `dangerZoneOf` 的兜底口径**一致** —— 别在这里写「常态」。
 */
export function desireBandOf(value: number): DesireBand {
  if (value <= LOST_MAX) return '迷失';
  if (value < WINDOW_MIN) return '常态';
  if (value <= WINDOW_MAX) return '窗口';
  return '沉溺';
}

/**
 * 区间的一句话读数 —— **逐格取自《设定.md》表的「每天漂移 / 判定修正」两列**，
 * 不是新写的文案。
 * ⚠️ 它只用在**悬停提示**里（`ui/index.html` 的 `title=`）—— 面上仍然只给区间名。
 */
export const DESIRE_BAND_NOTE: Record<DesireBand, string> = {
  迷失: '每天 −2 · 判定恒定 +1d4 不利',
  常态: '无漂移 · 无税 · 判定正常',
  窗口: '无漂移 · 判定正常',
  沉溺: '每天 +2 · 判定恒定 −1d4 有利',
};

/**
 * 危险区的**每日漂移**—— 只在迷失 / 沉溺区收税，
 * 常态与窗口**无税**（那条"什么都不做 = 停在 30 = 结局失败"的手感全靠它）。
 *
 * ⚠️ 值 ±2 由《设定.md》的表写死，同时被 `README.md` 列为**待标定**（判据 = 浮力原则）。
 *    要回标就改这一处 —— `turn/t0.ts·turnOver` 是唯一的落账点。
 * ⚠️ **不设缓冲日**（2026-09-21 用户裁定）：跨入危险区的**当天**就开始漂移。
 *    这与《设定.md》§二「缓冲日：跨入危险区的第 1 天不结算漂移」**不一致** ——
 *    文档未同步，**代码以本条为准**。
 */
export const DAILY_DRIFT: Record<DangerZone, number> = { 正常: 0, 迷失: -2, 沉溺: +2 };

export function driftOf(zone: DangerZone): number {
  return DAILY_DRIFT[zone];
}
