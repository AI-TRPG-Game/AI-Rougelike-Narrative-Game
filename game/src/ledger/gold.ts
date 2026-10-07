// 金币托管
//
// 玩家提交处理时投入 `P ≥ 事件 min_gold`（**可以多给**）——**提交那一刻即扣**、锁定在这条事件里。
// 结算时按**实际消耗**退还差额。
//
// ⚠️ **`P` 不进「已落账」清单**：它是**上限**、不是"已经花掉的钱"。
//    进了清单会让 LLM 以为"金币已扣过、不必再写" ⇒ **全额退款**。这是设计里后果最直接的一个坑。
import { validateDelta } from '../contract/validate.ts';

export function settleEscrow(
  reportedCost: number,
  locked: number,
): { consumed: number; refund: number; note: string } {
  if (reportedCost <= 0) {
    // 报告的净值为正（有收益）⇒ 全额退回 P，收益本身走 delta.gold
    return { consumed: 0, refund: locked, note: `净值非负 ⇒ 全额退回 ${locked}` };
  }
  const consumed = Math.min(reportedCost, locked);
  const refund = locked - consumed;
  return {
    consumed,
    refund,
    note: refund > 0 ? `实际消耗 ${consumed}（上限 ${locked}）⇒ 退回 ${refund}` : `实际消耗 ${consumed} = 上限`,
  };
}

/** 统一的负值钳制：`gold ≥ 0` 是**全局落账纪律**；净增不受任何上限 */
export function clampGold(v: number): number {
  return Math.max(0, v);
}

/** 事件需要的最少投入 */
export function minGoldOf(ev: { min_gold: number }): number {
  return Math.max(0, ev.min_gold);
}

// ⚠️ 2026-09-20 删掉 `escrowLegal(pay, minGold)`（`pay >= minGold && pay >= 0`）——
//    它**全仓零调用**，与当年 `dispatchable` 那条"schema-only 假机制"同型。
//    ⚠️⚠️ **但它删掉之后，"不可少给"这条规则在代码里就一处都不剩了**（这不是它的错）：
//      · 闸门 ⑨ `GOLD_INSUFFICIENT` 只问 `应付 > 余额`，**不问 `应付 ≥ min_gold`**；
//      · `turn/` 层全仓**没有** `min_gold` 的读点（`ui/session.ts` 只是把它透给界面）；
//      · 于是玩家**垫 0 金也能提交**一条 `min_gold = 2` 的事件 ——
//        而界面上钱格却按 `min_gold > 0` 画成**红实线 `.must`**。
//      ⇒ 要么把"不可少给"接进**会话层的输入有效性守卫**（本项目既有做法，**不进 `gates.ts`**），
//        要么承认 `min_gold` 只是提示、把 `.must` 那颗红标记撤掉。二选一，别停在中间。

/**
 * 从模型给的原始 delta 里算出 `gold` 的**代数和**（不取绝对值）。
 * 正 = 净得 · 0 = 没动钱 · 负 = 净花。
 * ⚠️ 一定要走 `validateDelta`：服务端不校验取值，畸形 `gold` 会直接流进来。
 */
export function deltaGoldSum(rawDelta: unknown): number {
  const v = validateDelta(rawDelta ?? { ops: [] });
  let gold = 0;
  for (const op of v.delta.ops) if ('gold' in op) gold += op.gold;
  return gold;
}

/**
 * 「报告的消耗」（= `−delta.gold` 的正数部分）。
 * ⚠️ 它是**结算的输入**，不是第二笔支出 —— 负向的 `gold` 落账时必须被**冲回**（见 `turn/time.ts`）。
 */
export function reportedCostOf(rawDelta: unknown): number {
  const s = deltaGoldSum(rawDelta);
  return s < 0 ? -s : 0;
}
