// 概要归并的**规则层**/ §5.7 两层概要。
//
// 这个文件只回答两个问题，两个都是**算术或纯判定**（不碰账本、不碰 LLM、不碰 Node）：
//   ① **这一次要不要归并**（`planArchive`）—— 章首软触发 / 任意日硬触发；
//   ② **归并哪几天**（同函数）—— 最老的 `min(7, 逐条天数 − 1)` 天，**永远保留最近一整天**。
//
// ⚠️ **四个阈值只有这一份**（唯一拷贝）：`ARCHIVE_SOFT_LIMIT` / `ARCHIVE_HARD_LIMIT` /
//    `ARCHIVE_MAX_DAYS` / `ARCHIVE_SEGMENT_MAX`。指令文案、装配、测试、日志一律从这里读 ——
//    本项目已经踩过"同一个数两处各写一个"的亏（`deadline` 挡位、`FREE_EVENT_CAP`）。
//
// ⚠️ **2026-09-22 用户裁定「放宽标准」** —— 压缩会减损信息量，所以 `archive` **本该少触发**。
//    ⇒ 两个阈值按《契约.md》§5.7 的原值落（2000 / 5000 字），**不往下标定**。
//    代价（实测、且是**设计意图而非缺口**）：**标准 28 天里它一次都不触发** ——
//    第 8 天章首时逐条区只有数百字（三种子 28 天约 39 次结算 ⇒ 每天 ≈1.4 条 × ≤75 字）。
//    ⇒ 「概要归并被走到」**不能写成无条件覆盖率断言**（那就是一条永远假绿的断言：
//      断言存在 ≠ 路径被走到）。改为照 `driveInstantEnding` 的先例**明着驱动走一遍**
//      （`turn/simulate.ts·SimOptions.driveArchive`），且只在被驱动时才断言。
//
// ⚠️ 判据用 `clock.ts·isChapterStart`（= 第 8 / 15 / 22 天），**不是** `chapter_shift` 那条
//    `isDivinationDay`（= 含第 1 天的 1 / 8 / 15 / 22）。两者**结论不同、理由也不同**：
//    §6.10 明写「第 1 天无内容」—— 第 1 天账本上一条概要都还没有，归并无从谈起。
//    （这也是 `isChapterStart` **唯一正确**的用法之一：它答"是不是**切换到**新一章"。）
import { isChapterStart } from './clock.ts';

/** 逐条概要区的**软触发**字数 —— 章首检查，超过就归并 */
export const ARCHIVE_SOFT_LIMIT = 2000;
/** 概要总量（归档 ＋ 逐条）的**硬触发**字数 —— 越过就**当天立即**归并，不问章首（§5.7「硬触发」） */
export const ARCHIVE_HARD_LIMIT = 5000;
/** 一次归并最多并几天（§5.7：`N = min(7, 逐条概要已有天数 − 1)`） */
export const ARCHIVE_MAX_DAYS = 7;
/** 归档段字数上限（§6.10 的 `归档段` 字段 / §5.1 长度表） */
export const ARCHIVE_SEGMENT_MAX = 300;

/** 逐条概要的一条 —— 与 `ledger/types.ts` 第 5 组的 `recent` 逐字同形（这里不 import，规则层不依赖账本） */
export interface RecentSummary {
  day: number;
  text: string;
}

/** 按**码点**计长（`[...s].length`，中文一字算一个）—— 与 `turn/chapter-shift.ts·len` 同一口径 */
export function charCount(s: string): number {
  return [...s].length;
}

/**
 * 逐条概要里出现过的**天**，升序去重。
 *
 * ⚠️ 归并的粒度是**天**、不是条：一天可能有多条概要（一次结算产出 1 条），
 *    而 §5.7 的「− 1」保留的是**一整天**（那一天的所有条目一起留下）。
 *    ⇒ 必须先去重成"有哪些天"，再按天切。
 */
export function distinctDays(recent: readonly RecentSummary[]): number[] {
  return [...new Set(recent.map((r) => r.day))].sort((a, b) => a - b);
}

/** 这一次为什么（不）归并 —— 开发侧日志与断言用，**不给玩家看** */
export type ArchiveReason =
  /** 章首检查发现逐条区越软顶 */
  | '章首·逐条超软顶'
  /** 总量（归档 ＋ 逐条）越硬顶 ⇒ 当天立即，**不问章首** */
  | '总量超硬顶'
  /** 是章首，但还没到软顶 —— 让它继续长 */
  | '章首但未超软顶'
  /** 不是章首，也没越硬顶 */
  | '非章首且未超硬顶'
  /** 逐条区只有 1 天（或空）—— 「− 1」把最近一整天钉住了，没有可并的 */
  | '逐条不足 2 天';

export interface ArchivePlan {
  /** 这一次要不要真的调 `archive` */
  trigger: boolean;
  reason: ArchiveReason;
  /** 参与归并的**天**（从最老一天起连续 N 天）；`trigger=false` 时为空 */
  days: number[];
  /** 参与归并的**条目**（按 `recent` 原顺序 = 时间序）；`trigger=false` 时为空 */
  items: RecentSummary[];
  /** 保留下来的天（**最近一整天必在其中，且永远完整**）；`trigger=false` 时 = 全部天 */
  keptDays: number[];
  /** 判据用到的实测字数（开发侧日志 / 断言用） */
  chars: { recent: number; total: number };
  /** 今天是不是章首（`isChapterStart`）—— 调用侧只看 `trigger`，这个字段是留给日志的 */
  chapterStart: boolean;
}

/**
 * 归并计划 —— 一次纯算术，算出"这一次要不要并、并哪几天、留哪几天"。
 *
 * ⚠️ **两条触发路径的优先级**：硬顶**与章首无关**（`§5.7`：「防玩家把概要写飞」）——
 *    它任何一天都能点着；软顶只在章首检查。两者都触发时记硬顶（更强的那个理由）。
 * ⚠️ **「− 1」是不可协商的**：`N = min(ARCHIVE_MAX_DAYS, 天数 − 1)` ——
 *    「永久保留最近一整天」是 §5.7 明写的，不是优化。天数 ≤ 1 ⇒ N ≤ 0 ⇒ 不归并
 *    （**不能**让 N 变成负数去 slice，那是"把最近一整天也并掉"的静默 bug）。
 * ⚠️ 条数不足也不归并：`archive` 的产物是一段 ≤300 字的历史，并一天等于把那天的话
 *    压成一段 —— 只有当"不压就会撑爆窗口"时才值得付这个信息损失（用户 2026-09-22 口径）。
 */
export function planArchive(
  day: number,
  recent: readonly RecentSummary[],
  archive: readonly string[],
): ArchivePlan {
  // ⚠️ **序幕固定概要（`day 0`）不进归并候选**（2026-09-19 · 序幕落地时补）：
  //    它是规则层**写死**的展示期文本（10 条文案各附一句，见 `rules/prologue.ts`），
  //    不是"某一天的逐条概要"。并进 ≤300 字的归档段 = 把展示期的固定文案压掉，
  //    而那几句是后续生成唯一的"开局记忆"。
  //    ⇒ 它照旧计入字数（它确实占 prompt 的位置），但**不作候选**。
  //    副作用（有意）：`keptDays` 里也不含它 —— 它天然被保留。
  const days = distinctDays(recent).filter((d) => d > 0);
  const recentChars = recent.reduce((s, r) => s + charCount(r.text), 0);
  const totalChars = recentChars + archive.reduce((s, a) => s + charCount(a), 0);
  const chars = { recent: recentChars, total: totalChars };
  const chapterStart = isChapterStart(day);

  // ① 「− 1」先算：它把"最近一整天"钉住，是**前提**而不是分支（不足 2 天 ⇒ 一并不归并）
  const n = Math.min(ARCHIVE_MAX_DAYS, days.length - 1);
  if (n <= 0) {
    return { trigger: false, reason: '逐条不足 2 天', days: [], items: [], keptDays: days, chars, chapterStart };
  }

  const hard = totalChars > ARCHIVE_HARD_LIMIT;
  const soft = chapterStart && recentChars > ARCHIVE_SOFT_LIMIT;
  if (!hard && !soft) {
    return {
      trigger: false,
      reason: chapterStart ? '章首但未超软顶' : '非章首且未超硬顶',
      days: [],
      items: [],
      keptDays: days,
      chars,
      chapterStart,
    };
  }

  const picked = days.slice(0, n);
  return {
    trigger: true,
    reason: hard ? '总量超硬顶' : '章首·逐条超软顶',
    days: picked,
    items: recent.filter((r) => picked.includes(r.day)),
    keptDays: days.slice(n),
    chars,
    chapterStart,
  };
}
