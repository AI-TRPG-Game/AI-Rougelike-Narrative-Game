// `archive` 的**落地层** —— 与 `turn/opening.ts` / `turn/chapter-shift.ts` / `turn/land-compose.ts`
// 同一条纪律：模型给的是**未校验的任意形状**，这里才是它变成账本字段的唯一入口。
//
// ⚠️ **服务端对模型输出完全不校验**（Phase 0 §三：`strict` 只管 schema **定义**的合法性）
//    ⇒「归档段非空且 ≤300 字」这一条**没有任何一层替我们兜**，只能在这里兜。
//
// ⚠️ **单写者**：`summaries.archive` 只有这一个函数追加、`summaries.recent` 只有它搬走 ——
//    `recent` 的另外三个写者（`turn/popup.ts` 档 A 选项、`turn/time.ts` 揭晓、
//    `turn/t0.ts·settleExpired` 过期结算）**只追加、从不删** ⇒ 职责不重叠。
//
// ⚠️ **原子**：① 新段追加进归档区、② 被并掉的那几天从逐条区移出 —— 是**同一次归并的两半**，
//    要么全落、要么全不落。只做①会让那几天**同时活在两处**（归档段里一遍、逐条区里一遍），
//    而【已处理概要】会把两份都渲染给模型看 ⇒ 生成侧以为同一件事发生过两次，
//    且**没有人会报错**。
//
// ⚠️ **产出是"一段"、不是"重写全篇"**：旧归档段**原样保留**，新段**追加**在末尾
//    ⇒ 只动 user 尾部，缓存代价最小。
import { ARCHIVE_SEGMENT_MAX, charCount, type ArchivePlan } from '../rules/archive.ts';
import type { Ledger } from '../ledger/types.ts';

/** 归并被拒（校验不过）—— 与"网络 / 解析失败"分开，便于调用侧分辨该不该重试 */
export class ArchiveRejected extends Error {}

export interface ArchiveResult {
  ledger: Ledger;
  log: string[];
  /** 这一次产出的归档段（≤300 字）—— `archive` 的产物**不给玩家看**，只进账本与 prompt */
  segment: string;
  /** 被并掉的天（从逐条区移出） */
  days: number[];
  /** 落账前后的规模（开发侧日志与断言用） */
  before: { archive: number; recent: number };
  after: { archive: number; recent: number };
}

/** 只收非空字符串，顺带 trim */
function asText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 校验 ＋ 落账。`raw` 是 `Brain.archive()` 的**未校验**输出（任意形状）。
 *
 * ⚠️ **计划由调用侧算好带进来**：`plan` 是 `rules/archive.ts·planArchive` 的产物。
 *    落地层**不自己再算一遍**"该并不该并、并哪几天" —— 那会造出两份判据，
 *    而模型看到的那几天（装配时渲染进 user ③）与真正被搬走的那几天必须**是同一批**，
 *    否则账本与它读到的输入对不上（同 `applyChapterShift` 里"牌必须是同一副"那条）。
 */
export function applyArchive(l: Ledger, raw: unknown, plan: ArchivePlan): ArchiveResult {
  // ⚠️ 不该归并却调了 = 调用侧的接线错误 ⇒ **当场抛**，不要静默落一段没来由的归档。
  //    （与"模型输出不合规"分开：那是数据问题，这是结构问题。）
  if (!plan.trigger) {
    throw new ArchiveRejected(`第 ${l.clock.day} 天没有要归并的（${plan.reason}）`);
  }

  const segment = asText((raw as Record<string, unknown> | null | undefined)?.['归档段']);
  if (segment === '') throw new ArchiveRejected('归档段为空（必须是 ≤300 字的一段历史）');
  if (charCount(segment) > ARCHIVE_SEGMENT_MAX) {
    throw new ArchiveRejected(`归档段 ${charCount(segment)} 字 > ${ARCHIVE_SEGMENT_MAX} 字`);
  }

  // ── 校验全过 ⇒ 两半一起落账（原子）──
  const next = structuredClone(l);
  const before = { archive: next.summaries.archive.length, recent: next.summaries.recent.length };
  next.summaries.archive.push(segment);
  // 被并掉的那几天**移出**逐条区（它们已经进新段了）—— 判据用 `plan.days`，
  // 而不是"条目文本等于某条"：同一天可能有多条，按天整批搬走才是 §5.7 的口径。
  next.summaries.recent = next.summaries.recent.filter((r) => !plan.days.includes(r.day));

  const log: string[] = [
    `概要归并（第 ${l.clock.day} 天 · ${plan.reason}）：并入第 ${plan.days[0]}~${plan.days[plan.days.length - 1]} 天` +
      `共 ${plan.items.length} 条 ⇒ 归档段 ${charCount(segment)} 字`,
    `逐条区实测 ${plan.chars.recent} 字 / 总量 ${plan.chars.total} 字（软顶超限 ${plan.chapterStart ? '是' : '否'}）`,
    `归档区 ${before.archive} → ${next.summaries.archive.length} 段 · 逐条区 ${before.recent} → ${next.summaries.recent.length} 条`,
  ];

  return {
    ledger: next,
    log,
    segment,
    days: [...plan.days],
    before,
    after: { archive: next.summaries.archive.length, recent: next.summaries.recent.length },
  };
}
