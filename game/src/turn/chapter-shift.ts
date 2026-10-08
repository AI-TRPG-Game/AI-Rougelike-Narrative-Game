// `chapter_shift` 的**落地层** —— 与 `turn/opening.ts` / `turn/land-compose.ts` 同一条纪律：
//    模型给的是**未校验的任意形状**，这里才是它变成账本字段的唯一入口。
//
// ⚠️ **服务端对模型输出完全不校验**（Phase 0 §三：`strict` 只管 schema **定义**的合法性，
//    模型的取值 / 类型 / 区间一概穿透）⇒「氛围非空且 ≤30 字」与「欲念变化钳 −20~+20」
//    这两条**没有任何一层替我们兜**，只能在这里兜。
//
// ⚠️ **单写者**：`ledger.divination` 与「章节占卜带来的欲念变化」只有这一个函数写。
//    欲念还有另外三个写者（`turn/t0.ts·turnOver` 的危险区漂移、`ledger/apply.ts` 批末钳制里的
//    `欲向`、`turn/popup.ts` 的档 A 选项），四者互不重叠：这里是**章节占卜那一次**的唯一入口。
//
// ⚠️ **原子**：氛围与欲念变化是**同一次占卜的两半**，要么全落、要么全不落 ——
//    先把校验跑完，再一次性写进 `structuredClone` 出来的新账本。
//    「氛围写了但欲念没写」会让这一章的事件生成与欲念节奏对不上，且**没人看得出**。
//
// ⚠️ **可见性分流**（用户 2026-09-22 的 UI 分层要求）—— 这一次产出的两样东西**性质不同**：
//    · `章节氛围` → **玩家可见**；
//    · `章节欲念变化`、命中了哪张牌、走的是查表还是模型 → **仅开发者可见**（God's-eye）。
//    ⇒ 本条链**只把氛围**交出去给播报（`ChapterShiftResult.ambience`），
//      判定细节一律留在 `log` 里 —— 那个字段的读者是开发者，不是玩家。
//      （欲念本身在界面上是"无仪表提示"，连数值都不给玩家看。）
import { clamp } from '../rules/num.ts';
import {
  AMBIENCE_MAX,
  resolveDesireChange,
  isDivinationDay,
  type DesireChange,
} from '../rules/chapter-shift.ts';
import { DESIRE_MAX, DESIRE_MIN } from '../rules/desire.ts';
import { makeRng, type Rng } from '../rules/rng.ts';
import { cardLabel, type DivinationCards } from '../rules/tarot.ts';
import type { Ledger } from '../ledger/types.ts';

/** 占卜被拒（校验不过）—— 与"网络 / 解析失败"分开，便于调用侧分辨该不该重试 */
export class ChapterShiftRejected extends Error {}

export interface ChapterShiftResult {
  ledger: Ledger;
  log: string[];
  /** 占卜文案 —— **这一次唯一允许流向玩家播报**的东西 */
  ambience: string;
  /** 双轨决策的完整结果（**开发侧**：命中 / 轨道 / 模型原文） */
  change: DesireChange;
  /** 落账前后的欲念（开发侧日志与断言用） */
  before: number;
  after: number;
}

/** 只收非空字符串，顺带 trim */
function asText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 按**码点**计长（`[...s].length`）—— 中文一字算一个，不能用 `s.length` */
function len(s: string): number {
  return [...s].length;
}

/**
 * 占卜专用的**第二条随机流** —— 与正文那条 `rng` **分开**（按 `(seed, day)` 派生）。
 *
 * ⚠️ 为什么不让它去动 `simulate` / `Session` 那条 `rng`：
 *    **那条流本身就是"整局轨迹"的一部分**。占卜日每次多摇 4 个 `int`（两张牌 × (牌名 ＋ 正逆位)），
 *    第 1 / 8 / 15 / 22 天各插一次 ⇒ 三个基线种子 28 天的每一步都会整体挪位，
 *    那些精心调过的覆盖率与预期结局会一起漂走。
 *    这与 `turn/simulate.ts·prologueRng`（开局翻牌）和 `fixtures/fake.ts·roll()`
 *    （凭证判定）是**同一条先例**：**与轨迹无关的随机决策不要伸进那条流**。
 * ⚠️ 按 `(seed, day)` 派生 ⇒ 同一种子同一章**永远抽到同一副牌**（可重放），
 *    且第 1 章抽什么**不受**前面几天消耗了多少骰子影响。
 */
export function divinationRng(seed: number, day: number): Rng {
  // 乘两个与正文流、与序幕流都无关的质数，避开"几条流前几个数相关"这种尴尬
  return makeRng(seed * 104729 + day * 7919 + 15485863);
}

/**
 * 校验 ＋ 落账。`raw` 是 `Brain.chapterShift()` 的**未校验**输出（任意形状）。
 *
 * ⚠️ **牌不由这里抽**：调用侧先 `drawDivinationCards(rng)` 拿到 `cards`，同一副牌既喂给模型、
 *    也用在这里判「命中原卡」 —— 两处**必须是同一副**，否则"读牌"与"命中判定"会各说各话。
 */
export function applyChapterShift(
  l: Ledger,
  raw: unknown,
  cards: DivinationCards,
): ChapterShiftResult {
  const day = l.clock.day;
  // ⚠️ 非占卜日调用 = 调用侧的接线错误 ⇒ **当场抛**，不要静默落一份"第 5 章的氛围"。
  //    （与"模型输出不合规"分开：那是数据问题，这是结构问题。）
  if (!isDivinationDay(day)) {
    throw new ChapterShiftRejected(`第 ${day} 天不是占卜日（只有第 1 / 8 / 15 / 22 天占卜）`);
  }

  const o = (raw ?? {}) as Record<string, unknown>;

  // ── ① 氛围（玩家可见的那一半）──
  const ambience = asText(o['章节氛围']);
  if (ambience === '') throw new ChapterShiftRejected('章节氛围为空（必须是 ≤30 字的一句占卜文案）');
  if (len(ambience) > AMBIENCE_MAX) {
    throw new ChapterShiftRejected(`章节氛围 ${len(ambience)} 字 > ${AMBIENCE_MAX} 字：「${ambience}」`);
  }

  // ── ② 欲念变化（规则层的事，这里只把结果用上）──
  //    ⚠️ **2026-10-05**：不再有「命中原卡」双轨 —— 原卡（`desire.cards`）已删，
  //    比对基准不存在，那条轨整条撤掉（理由见 `rules/chapter-shift.ts` 顶栏）。
  const change = resolveDesireChange(day, cards, o['章节欲念变化']);

  // ── 校验全过 ⇒ 一次性落账（原子）──
  const next = structuredClone(l);
  // ⚠️ 2026-10-08：两张牌随氛围一起落账（此前只进开发日志）—— UI 要在签文旁展示它们。
  //    ⚠️ 仍是「只读世界氛围、不参与欲念计算」—— 落账只是让它可见，不是让它生效。
  next.divination = {
    ambition: ambience,
    cards: cards.map((c) => ({ name: c.name, reversed: c.reversed })),
  };
  const before = next.desire.value;
  next.desire.value = clamp(before + change.delta, DESIRE_MIN, DESIRE_MAX);

  // ── 日志（**全部是开发侧信息**：玩家只该看到上面那句氛围）──
  const log: string[] = [
    `第 ${l.clock.chapter} 章占卜（第 ${day} 天）：「${ambience}」`,
    `本章抽牌：第一张 ${cardLabel(cards[0])}　第二张 ${cardLabel(cards[1])}` +
      `（并列无顺序；**只读世界氛围，不参与欲念计算**）`,
  ];
  if (change.track === '不结算') {
    log.push(`第 1 天：氛围照写、**欲念不结算**（模型给 ${change.llmRaw}，按《契约.md》§6.6 不落账）`);
  } else {
    log.push(
      `采用模型判的相关性 ${change.llmRaw}` +
        (change.llmClamped !== change.llmRaw ? `（钳 −20~+20 ⇒ ${change.llmClamped}）` : ''),
    );
  }
  if (change.delta !== 0) {
    log.push(`欲念 ${before} ${change.delta > 0 ? '+' : ''}${change.delta} → ${next.desire.value}`);
  } else {
    log.push(`欲念不变（${before}）`);
  }

  return { ledger: next, log, ambience, change, before, after: next.desire.value };
}
