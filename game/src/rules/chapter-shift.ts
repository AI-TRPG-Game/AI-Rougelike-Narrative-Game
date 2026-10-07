// 章节占卜的**规则层**。
//
// 这个文件只回答两个问题，两个都是**算术或纯判定**（不碰账本、不碰 LLM、不碰 Node）：
//   ① **哪天要占卜**（`isDivinationDay`）—— 见下面那条「第 1 天」的坑；
//   ② **这一次欲念变多少**（`resolveDesireChange`）—— 钳制后落账。
//
// ⚠️⚠️ **2026-10-05 用户裁定：删掉「命中原卡」双轨**（「玩家的欲望就根本不需要塔罗牌的参与，
//    不要画蛇添足」）。原来这里是两条轨：
//   · 命中开局那副「欲望原卡」⇒ **系统查表**（正位 +10 / 逆位 −10），**丢弃** LLM 给的相关性；
//   · 一张都没中 ⇒ 采用 LLM 判的相关性（钳 −20~+20）。
//   而**原卡本身就是欲望的一部分**（`desire.cards`）—— 那个字段已删，
//   轨一的**比对基准不复存在** ⇒ 轨一无法存在。
//   ⇒ **现在只有一条轨**：`delta` = 模型判的相关性，钳在 [−20, +20]，第 1 天恒 0。
//   ⚠️ **不要**把它改回"抽到什么牌就查什么表" —— 那需要重新引入一个"欲望与牌的关联"，
//      而那正是用户明确划掉的东西。
//   ⚠️ 牌**仍然抽**（`rules/tarot.ts·drawDivinationCards`）：占卜要读的是**世界层**的
//      氛围（这一周王城在渴望什么），它与玩家的欲望**不共用任何东西**。
//
// ⚠️ 为什么这个谓词**不能写成 `isChapterStart(day)`**：
//    `clock.ts·isChapterStart` 是 `day > 1 && (day-1) % 7 === 0` —— 它回答的是
//    「今天是不是**切换**到了新一章」，而**第 1 天不是"切换到第 1 章"，它本来就是第 1 章**
//    ⇒ 那个谓词在第 1 天返回 **false**。
//    但占卜日**含第 1 天**：《设定.md》§三 明写「第 1 章的氛围由**第 1 天的章节占卜**定」。
//    ⇒ 两个集合**长得像、其实不是一个**：`{8,15,22}` vs `{1,8,15,22}`。
//    （顺带一提：`clock.ts·PAYROLL_DAYS` 恰好也是这四天 —— 两者**结论相同、理由无关**，
//      所以**不共用一份常量**：周例钱的口径一动，不该顺手把占卜日也挪走。）
import { isChapterStart } from './clock.ts';
import { clamp } from './num.ts';
import type { DrawnCard } from './tarot.ts';

// ── ① 哪天占卜 ────────────────────────────────────────────────

/** 全局的四个占卜日（第 1 / 8 / 15 / 22 天）—— 覆盖率断言与文档里的「每章 1 次」共用一份 */
export const DIVINATION_DAYS: readonly number[] = [1, 8, 15, 22];

/** 占卜日：第 1 / 8 / 15 / 22 天 */
export function isDivinationDay(day: number): boolean {
  return day === 1 || isChapterStart(day);
}

// ── ② 这一次欲念变多少 ────────────────────────────────────────

/** 模型判的**相关性**的合法区间 */
export const CORRELATION_MIN = -20;
export const CORRELATION_MAX = 20;

/** 占卜文案 ≤30 字 */
export const AMBIENCE_MAX = 30;

/** 这一次走的是哪条轨 —— 也是**开发侧日志**要写清的那件事（玩家不看它） */
export type DivinationTrack =
  /** 采用模型判的相关性（钳 −20~+20）—— **现在只有这一条轨** */
  | '模型'
  /** 第 1 天 ⇒ **不结算** */
  | '不结算';

export interface DesireChange {
  track: DivinationTrack;
  /** 这一次抽到的两张（**只作氛围与日志用**，不再参与欲念计算 —— 见顶栏） */
  drawn: readonly DrawnCard[];
  /** 实际要落账的 Δ（第 1 天恒 0） */
  delta: number;
  /** 模型原文给的数（未钳制，仅日志用） */
  llmRaw: number;
  /** 钳制后的模型相关性（**这就是落账的那个数**） */
  llmClamped: number;
}

/**
 * 欲念变化 —— **只走模型相关性这一条轨**。
 *
 * ⚠️ 两条纪律落在这里：
 *   ① **第 1 天不落账**：`delta` 恒 0 —— 开局节奏不稳；
 *   ② 模型那个数**先钳 −20~+20**（服务端对输出**完全不校验**，Phase 0 §三 ⇒ 只能在这里钳）；
 *      非数字（模型给了字符串 / 缺键）⇒ 当 0 用，**不抛** —— 氛围还等着落账，
 *      为它废掉整次占卜不值得。
 *
 * @param llmValue 模型给的「章节欲念变化」—— **未校验的任意形状**。
 */
export function resolveDesireChange(
  day: number,
  drawn: readonly DrawnCard[],
  llmValue: unknown,
): DesireChange {
  const llmRaw = typeof llmValue === 'number' && Number.isFinite(llmValue) ? Math.trunc(llmValue) : 0;
  const llmClamped = clamp(llmRaw, CORRELATION_MIN, CORRELATION_MAX);

  // 第 1 天：氛围照写，但**欲念一个字都不动**
  if (day === 1) {
    return { track: '不结算', drawn, delta: 0, llmRaw, llmClamped };
  }
  return { track: '模型', drawn, delta: llmClamped, llmRaw, llmClamped };
}
