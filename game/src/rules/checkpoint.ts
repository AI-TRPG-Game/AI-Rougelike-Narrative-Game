// 硬种子 checkpoint
//
// 五格声望（善名 / 恶名 / 侠名 / 怪名 / 权势）任一**首次达到** 10 / 15 / 20
// ⇒ **必出** 1 条 checkpoint 事件（种子 `source: '硬种子'`），
// **不占条数上限、不占行动点预算**（额外叠加在自由事件之上 —— P1 价值序）。
//
// ⚠️ **本模块是"门槛 ＋ 提示语"的唯一拷贝**：三条提示语的正文只写在这里，
//    `ledger/apply.ts`（判定与出种）与测试都从这里读 —— 本项目已经踩过
//    "同一个数 / 同一句话两处各写一份"的亏（`deadline` 挡位 / `FREE_EVENT_CAP` /
//    `archive` 那四个阈值 / `ENDING_TEXT_MIN`）。
// ⚠️ **本模块是纯算术 ＋ 常量**（不碰账本、无副作用、不 import Node）——
//    写账本那一步在 `ledger/apply.ts·commitBatch`（**批末**）。与 `rules/desire.ts`
//    「`crossedRewriteThreshold` 在这里、写账在 `commitBatch`」是同一套分工。
//
// ⚠️ **「首次」是一条历史事实，推不出来**：声望会跌回去、再升回来 ——
//    那种"再次达到"**不触发**（《规则.md》§358 原文：「此后该格的升降、跌回去再升回来，
//    都不再触发」）。⇒ 只能把"已经出过哪几档"记在账本上（`Ledger.repMarks`）。
//    ⚠️ 它记的是**门槛**（`10` / `15` / `20`）而不是"出过几条"：跌回去再升回来时
//       `before < N ≤ after` 会**再次成立**，只有门槛清单才分得清"这条早出过了"。
//
// ⚠️ 系统只给**语义提示**：提示语说"发生了什么、意味着什么"，
//    **不给档位 / `cost`**（那是 LLM 现定的，见《规则.md》§358「内容 / 档位 / cost 全由 LLM 现定」）。
import type { RepKey } from '../contract/types.ts';

/** 三档门槛（升序）—— 逐字对齐既定判据的门槛表（原出处文档已删） */
export const CHECKPOINT_STEPS = [10, 15, 20] as const;
export type CheckpointStep = (typeof CHECKPOINT_STEPS)[number];

/**
 * **已触发过的门槛** —— 五格声望各一份，升序去重。
 * ⚠️ 它是账本字段 `Ledger.repMarks` 的形状；`emptyRepMarks()` 每次新建
 *    （共享一个可变对象会让"五格互不干扰"变成假的）。
 */
export type RepMarks = Record<RepKey, number[]>;

export function emptyRepMarks(): RepMarks {
  return { 善名: [], 恶名: [], 侠名: [], 怪名: [], 权势: [] };
}

/**
 * 这一批里**首次跨过、且此前没出过**的门槛（升序；正常**至多 1 条**）。
 *
 * ⚠️ 「至多 1 条」的来源是**生成侧的硬约束**「所有 `rep` 单次变化 ≤ 5」
 *    ⇒ 一次最多跨一档。这里**不替那条约束兜底**
 *    （真要跨两档也各自是合法的"首次达到" ⇒ 各出一条，返回值本来就是数组）。
 * ⚠️ 判据是 `before < N && after >= N`：**包含**"恰好落在门槛上"那一档
 *    （`9 → 10` 命中）—— 端点上少一个等号，"第一次显形"就永远不会发生。
 */
export function crossedCheckpoints(
  before: number,
  after: number,
  marks: readonly number[],
): CheckpointStep[] {
  return CHECKPOINT_STEPS.filter((n) => before < n && after >= n && !marks.includes(n));
}

/**
 * 提示语的**后半句** —— 三条门槛表的右半，**逐字**照既定判据（原出处文档已删）。
 *
 * ⚠️ 它与 `checkpointTitle()` 拼起来**恰好等于**表格里那条原文：
 *    `prompt/blocks.ts·dispatchBlock` 渲染种子是 `${code} ${title} —— ${content}`
 *    ⇒ `s1 善名达到 10 —— 小有名声：…`，与表格里的「种子列表里的原文」逐字对上。
 *    （这不是巧合 —— 那个渲染格式本来就是为这条提示语定的。）
 */
export const CHECKPOINT_CONTENT: Record<CheckpointStep, string> = {
  10: '小有名声：这号名声第一次显形，开始有人（民间 / 朝中）念叨起你。',
  15: '名声在外：它已经传到你管不着的地方去了。',
  20: '名满王城：这号名声成了你的标签，事情开始自己找上门。',
};

/** 提示语的**前半句**：`<声望名>达到 <N>`（`RepKey` 本身就是中文名，直接用） */
export function checkpointTitle(rep: RepKey, step: CheckpointStep): string {
  return `${rep}达到 ${step}`;
}

/**
 * 提示语**全文**（<声望名>已达到 <N> 后的那一条，逐字）。
 * ⚠️ 只给测试与日志用 —— 进 prompt 的是 `title` / `content` 两半（见上）。
 */
export function checkpointPrompt(rep: RepKey, step: CheckpointStep): string {
  return `${checkpointTitle(rep, step)} —— ${CHECKPOINT_CONTENT[step]}`;
}
