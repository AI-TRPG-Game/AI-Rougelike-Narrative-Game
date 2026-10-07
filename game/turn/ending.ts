// 终局的**副作用入口** —— 判定本身的纯函数在 `rules/ending.ts`，这里只负责"写进账本"。
//
// 分工与 `rules/clock.ts` ↔ `turn/time.ts` 同族：**规则层只算，编排层才动账本**。
// ⚠️ 账本是**单写者**：终局一经写定就不再变（`l.ending !== null` 即"这一局已经结束"）。
import { emptyPlacements, type Ledger, type Placements } from '../ledger/types.ts';
import { finalEndingOf, instantEndingOf, type EndingResult } from '../rules/ending.ts';

/**
 * 把判定结果写进账本（**原子**：整份 `ending` 一次写定）。
 *
 * ⚠️ `placements` 默认三格全空 —— 中途暴毙（总表 1~4）**没有放格子这一步**，
 *    它不该在账本里留下一组"填过的格子"。
 */
export function enterEnding(l: Ledger, e: EndingResult, placements?: Placements): Ledger {
  const out = structuredClone(l);
  out.ending = { ...e, placements: placements ?? emptyPlacements() };
  return out;
}

/**
 * **逐次检查** —— 「每一次结算之后」调一次。
 *
 * 返回值语义刻意做成"要么给新账本、要么什么都不给"：
 * - 命中 ⇒ **新账本**（`ending` 已写定），调用方必须**立刻停手**（不再拨时间、不再进下一天）；
 * - 未命中 / 已经结束过 ⇒ `null`（调用方照常继续）。
 *
 * ⚠️ **先算后克隆**：本函数会被挂到每一次结算之后，命中是极少数
 *    ⇒ 不能为了"可能命中"每次都 `structuredClone` 一整份账本。
 */
export function terminateIfOver(l: Ledger): Ledger | null {
  if (l.ending) return null; // 已经结束过：不重复判、不覆盖
  const e = instantEndingOf(l);
  return e ? enterEnding(l, e) : null;
}

/**
 * **终局**：第 28 天放完格子之后判（总表 5~7 ＋ 成功）。
 * 与 `terminateIfOver` 的区别：这一条**必须**带放格子结果（成功与否都看它）。
 *
 * ⚠️ 仍然先按总表顺序兜一次 1~4："**1~4 优先于 5~7**"是总表的硬规则，
 *    不该依赖"调用方保证前面查过"。
 */
export function closeGame(l: Ledger, placements: Placements): Ledger {
  const e = instantEndingOf(l);
  if (e) return enterEnding(l, e);
  return enterEnding(l, finalEndingOf(l, placements), placements);
}
