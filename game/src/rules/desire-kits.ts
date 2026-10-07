// 欲望原型表 —— **玩家从这 4 条里选其一**，LLM 不发明欲望（2026-10-05 用户裁定）。
//
// ⚠️ **这是欲望的唯一事实源**（`turn/opening.ts` 从这里取，落进 `desire.manifesto` /
//    `desire.means` / `desire.proposition`）—— 主链只**读**，27 天里不重写。
//
// ── 一句话，三个读者（2026-10-06 用户裁定「我明确了什么是手段什么是目的」）──
// 每条原型都是一句 **「通过 X 来 Y」**，三个字段各管一件事、**互不干扰**：
//
//   · `manifesto` **宣言** —— 玩家自己写下的中二原话。
//       只上卡面与终局，**不进任何判定**。（情感）
//   · `means` **手段** ＝ X —— 「他打算怎么去要」。
//       **唯一判据：`vouchers.the_proper_way`（正当的手段）**。「正当」不是客观道德，
//       而是"这一手是不是走的他自己说的那条路子"。（路子）
//   · `proposition` **目的** ＝ Y —— 「他到底想要什么」。
//       **唯一判据：`欲向`（无关 / 偏离 / 趋近 / 得偿 / 盛宴）**，每天每一手都拿它判
//       "离它更近了还是更远了"。（目标）
//
// ⚠️⚠️ **为什么「正当的手段」终于能工作了**（2026-10-06）：
//    它的判据**原本是一张塔罗「手段」牌**（「战车 · 逆位」）—— 模型得先自己猜那张抽象牌
//    指向哪条路子，再判这一手算不算。而 2026-10-05 牌被整条删掉 ⇒ 那一维**失去了判据**。
//    现在判据换成**玩家亲口写下的那句具象话**（「协助一位风流的大侠在王都惩恶扬善」）：
//    不用猜，只要判"这一手是不是走的这条路子" ⇒ **比原来那版更硬**。
//    ⇒ ⚠️ 别再把 `means` 删掉：删了它，`the_proper_way` 就又变成一条无从判定的空维。
//
// ⚠️ **宣言逐字不可动** —— 它们是**玩家自己写下的**（第一/二/三条沿用 2026-10-05 那批，
//    第四条是 2026-10-06 用户新写的）。改字＝改玩家在这一局里扮演过的那个人。
import type { AttrKey, Attrs } from '../contract/types.ts';

// ── 六维分配（**玩家点亮 0~2 个优势属性**，2026-10-05 用户裁定）────────────
//
// ⚠️ **总和恒 = 60**，不多不少（用户原话）⇒ 三种分配都自动满足：
//   · 点亮 0 个 → 六个 10          → 10 × 6 = 60
//   · 点亮 1 个 → 15 ＋ 五个 9      → 15 + 45 = 60
//   · 点亮 2 个 → 两个 12 ＋ 四个 9 → 24 + 36 = 60
// ⇒ **总量恒定时"专精"必然以"平庸"为代价** —— 取舍是**结构自带的**，不需要另加惩罚项。
export const ATTR_TOTAL = 60;
/** 六项均分时的值 —— 点亮 0 个优势就长这样 */
export const ATTR_BASE = 10;
/** 点亮 1 个时那项的值（代价：其余五项各降 1） */
export const ATTR_SOLO = 15;
/** 点亮 2 个时那两项的值（代价：其余四项各降 1） */
export const ATTR_DUO = 12;
/** 最多能点亮几个优势属性（用户裁定 0~2） */
export const ATTR_ADV_MAX = 2;

/** 六维列序 —— 与 `ledger/initial.ts·AttrTuple` 逐字同序（**它才是那个事实源**，这里只借顺序） */
const ORDER: readonly AttrKey[] = ['争斗', '敏捷', '智慧', '魅力', '社交', '感知'];

/**
 * 分配六维 —— `advantages` 是玩家点亮的优势属性（**0~`ATTR_ADV_MAX` 个**，重复的按一次算）。
 *
 * ⚠️ **纯算术，不校验**：点亮了 3 个、或传了不在 `ORDER` 里的键 —— 本函数照样算完给出六维，
 *    合法性由 `turn/opening.ts·applyPlayerChoice` 判并抛 `OpeningRejected`（**单写者在那儿**）。
 * ⚠️ 为什么不 `throw` 在这里：`rules/` 是纯算术层，抛不抛是**校验口径**，
 *    而校验口径全项目只有一处（`turn/opening.ts`），别在这里开第二条。
 */
export function distributeAttrs(advantages: readonly AttrKey[]): Attrs {
  const adv = [...new Set(advantages)].filter((k) => ORDER.includes(k));
  const vals = new Map<AttrKey, number>();
  for (const k of ORDER) vals.set(k, adv.includes(k) ? (adv.length === 1 ? ATTR_SOLO : ATTR_DUO) : ATTR_BASE - 1);
  if (adv.length === 0) for (const k of ORDER) vals.set(k, ATTR_BASE);
  const out = {} as Attrs;
  for (const k of ORDER) out[k] = vals.get(k)!;
  return out;
}

/** 六维之和 —— **恒 = `ATTR_TOTAL`**（单测钉死的那条不变量） */
export function sumOfAttrs(a: Attrs): number {
  return ORDER.reduce((s, k) => s + a[k], 0);
}

// ── 4 条欲望原型 ──────────────────────────────────────────────
//
// ⚠️ **这里一张牌都没有，也不该有**（2026-10-05 用户裁定：「玩家的欲望就根本不需要塔罗牌的
//    参与，不要画蛇添足」）。塔罗只剩一处用场：**章节占卜**（读世界氛围），与欲望无关。

export interface DesireKit {
  /** 短标签 —— UI 列表与卡面小标题用它（宣言太长，撑不住列表） */
  readonly label: string;
  /**
   * **欲望宣言** —— 玩家自己写下的中二原话。逐字不可动。
   * ⚠️ 只上卡面与终局，**不进任何判定**（那是 `means` / `proposition` 的活）。
   */
  readonly manifesto: string;
  /**
   * **手段** ＝ 「通过 **X** 来 Y」里的 **X**：他打算怎么去要。
   * ⚠️ **唯一判据是 `vouchers.the_proper_way`（正当的手段）** —— 见顶栏那段。
   */
  readonly means: string;
  /**
   * **目的** ＝ 「通过 X 来 **Y**」里的 **Y**：他到底想要什么。
   * ⚠️ **唯一判据是 `欲向`**（每天判「更近了没有」）。
   * ⚠️ 字段名仍叫 `proposition`（＝《契约.md》§6.8 的「欲望命题」）—— 别改，
   *    文档口径对得上；**语义上它就是「目的」**。
   */
  readonly proposition: string;
}

export const DESIRE_KITS: readonly DesireKit[] = [
  {
    label: '美人',
    manifesto: '全金庭的男男女女啊，沉醉地拜倒在我的石榴裙下吧！',
    means: '成为全王国最美的男子，靠这张脸与一身美貌行事',
    proposition: '获取至高的权力',
  },
  {
    label: '侠',
    manifesto: '兄弟，请替我圆了这大侠梦！',
    means: '协助一位风流的大侠在王都惩恶扬善',
    proposition: '深刻改变朝堂的权力结构',
  },
  {
    label: '制',
    manifesto: '经济基础决定上层建筑，消灭一切阻碍生产力发展的旧事物！',
    means: '推动王国的生产力进步',
    proposition: '把王国的政治体制变为君主立宪制',
  },
  {
    label: '哲',
    manifesto: '人生的意义是什么？被社会所建构的价值是否值得追寻？世界的本质与真理又为何？',
    means: '在王都掀起哲学思辨的热潮',
    proposition: '让贵族都以追求真理为人生目标',
  },
];

/** 玩家选的是**下标**（0 ~ 3）—— UI 传数字，账本 `desire.kit` 也存它 */
export type DesireChoice = number;

/** 越界即 `null`（**不抛**：调用侧要的是"重挑一个"，不是崩） */
export function kitOf(choice: number): DesireKit | null {
  return Number.isInteger(choice) && choice >= 0 && choice < DESIRE_KITS.length
    ? DESIRE_KITS[choice]
    : null;
}
