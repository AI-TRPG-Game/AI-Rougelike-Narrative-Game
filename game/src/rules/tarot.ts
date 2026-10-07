// 塔罗抽牌 —— ⚠️ **现在只剩一处用场：章节占卜**（`drawDivinationCards`）。
//
// ⚠️⚠️ **2026-10-05 用户裁定：「玩家的欲望就根本不需要塔罗牌的参与，不要画蛇添足」**
//    ⇒ 本文件里**原来那套"开局抽两张（牌Ⅰ欲望 / 牌Ⅱ手段）"已整条删除**：
//      · `OpeningCards`（那张"终生不变的欲望原卡"）—— 删
//      · `drawOpeningCards`（开局抽牌）—— 删
//      · `drawCardsFor`（2026-10-05 上午我自己加的"按原型抽牌"）—— 删（**它本身就是画蛇添足**）
//      · `drawFrom`（只为上面那个服务的池子抽取）—— 删
//    ⇒ 牌与欲望之间**没有任何代码路径**。欲望是玩家挑的一句话 ＋ 规则层算的六维。
//    ⚠️ **别再"顺手"加回来** —— 那是用户明确划掉的东西，而且现在连账本字段都没有了。
//
// ⚠️ **不建牌库**：
//    这里只有 22 张大阿卡纳的**牌名**，一行牌义都没有 —— 牌义由 LLM 用通用塔罗知识**现场读**，
//    约束写在 prompt 里。原「手写 22 张牌义库」的路线已废。
//
// ⚠️ **这套名字是唯一事实源**（`MAJOR_ARCANA`）—— 抽牌、牌面文字、占卜都比对它。
//    改名字等于改所有出现牌面的地方，三处必须同源。
import type { Rng } from './rng.ts';

/** 22 张大阿卡纳的**通行中文译名**（按传统序号排列；抽牌不看顺序） */
export const MAJOR_ARCANA = [
  '愚者', '魔术师', '女祭司', '女皇', '皇帝', '教皇', '恋人', '战车',
  '力量', '隐士', '命运之轮', '正义', '倒吊人', '死神', '节制', '恶魔',
  '高塔', '星星', '月亮', '太阳', '审判', '世界',
] as const;

export type ArcanaName = (typeof MAJOR_ARCANA)[number];

/** 一张抽出来的牌 = **牌名 ＋ 正逆位** */
export interface DrawnCard {
  name: ArcanaName;
  reversed: boolean;
}

/** 出牌面用 —— 如「皇帝 · 正位」。**牌面文字进 prompt 的唯一入口**（不要在各处手拼） */
export function cardLabel(c: DrawnCard): string {
  return `${c.name} · ${c.reversed ? '逆位' : '正位'}`;
}

/** 抽一张、避开 `taken` 里的牌名。⚠️ 每次恰好消耗 2 个 `int`（牌名 ＋ 正逆位）⇒ 确定性可复现 */
function drawOne(rng: Rng, taken: readonly ArcanaName[]): DrawnCard {
  const pool = MAJOR_ARCANA.filter((n) => !taken.includes(n));
  const name = pool[rng.int(pool.length) - 1];
  // 正逆位各自独立 50%（`int(2)`：1 ⇒ 正位、2 ⇒ 逆位）
  return { name, reversed: rng.int(2) === 2 };
}

/**
 * 占卜日抽的两张牌 —— **并列、无顺序**。
 *
 * ⚠️ 用**元组**而不是 `{desire, means}`：这两张没有牌位。套上"欲望 / 手段"的名字，
 *    下游就会有人按牌位去读它 —— 而文档明写"都表达下周王城的变化 / 氛围"。
 * ⚠️ 抽法与开局牌阵**同一套**（两张不重复、各自独立 50% 正逆位、每次恰好 4 个 `int`），
 *    但**不共用那一副** —— 占卜是每一次新翻的两张。
 */
export type DivinationCards = readonly [DrawnCard, DrawnCard];

export function drawDivinationCards(rng: Rng): DivinationCards {
  const first = drawOne(rng, []);
  const second = drawOne(rng, [first.name]);
  return [first, second];
}
