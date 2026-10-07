// `opening` 的**落地层** —— 与 `turn/land-compose.ts` 同一条纪律：
//    系统给的是**玩家选好的原型**，这里才是它变成账本字段的唯一入口。
//
// ⚠️ **2026-10-06 整段重写**（用户裁定）：**序幕这一步彻底不再问模型。**
//    起因是 2026-10-05 那次改造已经把欲望与六维都改成玩家自己挑：
//      ① **欲望命题 ＋ 欲望宣言** —— 玩家从 `rules/desire-kits.ts` 里挑一条，规则层直接取；
//      ② **六维** —— 玩家点亮 0~2 个优势属性，规则层按 `distributeAttrs` 算。
//    ⇒ 这两条**都不问模型** ⇒ 曾经唯一剩下的第三件（`desire.past` 人物描述）
//      也没有了问模型的理由 ⇒ **整条 LLM 侧链删除**。
//
// ⚠️ **删掉之后，开局这三件事的落点变成**：
//    · 玩家的那句固定描述（"你自己，塞兰王国的三王子……"）—— **硬编码在 `ledger/initial.ts`
//      的玩家 `Person.desc`**（与**其余所有人物**的 `desc` 同一字段、同一位置）；
//    · 欲望 ＋ 六维 —— 就是下面 `applyPlayerChoice` 一个函数。
//    ⇒ `turn/prologue.ts·driveOpening` 退化成 `applyPlayerChoice` 的薄包装
//      （**调用侧不必改**，但它已经是**同步**的了，签名里的 `brain` 不再被使用）。
//
// ⚠️ **单写者**：`desire.proposition` / `desire.manifesto` / `desire.kit` /
//    `desire.advantages` ＋ 玩家 `attrs` 只有这一个函数写。
//
// ⚠️ **原子**：全部要么全落、要么全不落 —— 先把校验跑完，再一次性写进 `structuredClone`
//    出来的新账本。
//
// ⚠️⚠️ **2026-10-06：失败两档的说法整个退休**（那是人物描述时代的机制）。
//    旧规矩是"真的落不下 ⇒ 抛 `OpeningRejected` / 数值超建议值 ⇒ 照落 ＋ 标注"，
//    且**为它专门设了重试通道**（`OPENING_TRIES` ＋ 同一副牌再要一次）。
//    ⇒ 现在玩家选完欲望与优势就**当场落账**，**没有任何模型输出需要校验** ⇒
//      **重试通道一起删**（它在 `turn/prologue.ts` 里，本文件从未拥有它）。
//    `OpeningRejected` **保留** —— `applyPlayerChoice` 仍要抛它（下标越界 / 优势属性非法），
//    那是**玩家输入**的校验，调用侧照样靠这个类分辨"该不该重试"（答案永远是"不"）。
import { ATTR_KEYS, type AttrKey } from '../contract/types.ts';
import { PLAYER_ID, type Ledger } from '../ledger/types.ts';
import { DESIRE_KITS, ATTR_ADV_MAX, ATTR_TOTAL, distributeAttrs, kitOf, sumOfAttrs } from '../rules/desire-kits.ts';

/** 开局被拒（**真的落不下**）—— 现在只抛**玩家输入**的问题（下标越界 / 优势属性非法 / 账本没有玩家） */
export class OpeningRejected extends Error {}

export interface OpeningResult {
  ledger: Ledger;
  log: string[];
}

/** 玩家在开局这一次交上来的选择 —— **UI 与无头驱动都从这里进** */
export interface OpeningChoice {
  /** 玩家挑的是 `DESIRE_KITS` 的第几条（0~4） */
  kit: number;
  /** 玩家点亮的优势属性（0~`ATTR_ADV_MAX` 个键名） */
  advantages: readonly string[];
}

/**
 * 无头驱动（`turn/simulate.ts`）的**默认选择** —— 没人点按钮时的替身。
 *
 * ⚠️ **2026-10-05 用户裁定**：欲望 ＋ 六维都改成玩家自己挑 ⇒ 模拟器必须**有人替玩家挑**。
 *    选「侠」（下标 2）＋ 点亮 `争斗` —— 理由：它把"欲望与手段错位"这条判据
 *    演示得最清楚（想要的是"当大侠并改朝堂"，手上能打的只有 `争斗`；
 *    而 `智慧` 只有 9，**朝堂那一半他算不动**）。
 * ⚠️ **它必须是 `const` 的一条确定值**：不能从 `rng` 抽，否则"换 seed 换一局"会
 *    同时换掉欲望 ⇒ 基线种子之间比的就不是"同一条欲望下的事件流差异"了。
 * ⚠️ 想要别的组合走 `SimOptions.choice` **显式传参**。
 */
export const DEFAULT_CHOICE: OpeningChoice = { kit: 2, advantages: ['争斗'] };

/**
 * 玩家的两项选择**落账** —— **规则层，零 LLM**（2026-10-05 首建；2026-10-06 成为序幕唯一的落地入口）。
 *
 * ⚠️ **唯一的写者**：`desire.proposition` / `manifesto` / `kit` / `advantages`
 *    ＋ 玩家 `attrs`。
 *
 * ⚠️ **三处判据的分工**（旧版 `applyOpening` 那三条核对合并而来）：
 *   · `kitOf` / `readAdvantages` —— **形状与合法性**（越界、非法键名、超过 2 个）⇒ **抛**；
 *   · `sumOfAttrs` —— **内部一致性**（六维之和必须等于 `ATTR_TOTAL`）⇒ **抛**。
 *     它是**结构错误**（分配公式被改坏了），不是"玩家选得不好"，所以同样抛。
 *   · ⚠️ **任何模型产出都不参与校验了** —— 没有模型产出了。
 *
 * ⚠️ **不碰 `value` / `cards`** —— 欲念值走 `ledger/initial.ts` 的占位 30，
 *    `cards` 字段 2026-10-05 随"塔罗不参与欲望"一起退场。
 */
export function applyPlayerChoice(l: Ledger, choice: OpeningChoice): { ledger: Ledger; log: string[] } {
  const kit = kitOf(choice.kit);
  if (!kit) {
    throw new OpeningRejected(
      `欲望原型下标 ${JSON.stringify(choice.kit)} 不存在（只有 0 ~ ${DESIRE_KITS.length - 1}）`,
    );
  }
  const adv = readAdvantages(choice.advantages);
  const attrs = distributeAttrs(adv);
  const sum = sumOfAttrs(attrs);
  if (sum !== ATTR_TOTAL) {
    throw new OpeningRejected(`六维之和 ${sum} ≠ ${ATTR_TOTAL}（结构性错误：分配公式被改坏了）`);
  }
  const me = l.entities.people.find((p) => p.id === PLAYER_ID);
  if (!me) throw new OpeningRejected(`账本里没有玩家 ${PLAYER_ID}（结构性错误）`);

  const next = structuredClone(l);
  next.desire.proposition = kit.proposition;
  next.desire.means = kit.means;
  next.desire.manifesto = kit.manifesto;
  next.desire.kit = choice.kit;
  next.desire.advantages = adv;
  next.entities.people.find((p) => p.id === PLAYER_ID)!.attrs = attrs;

  return {
    ledger: next,
    log: [
      `玩家选中的欲望【${kit.label}】：宣言「${kit.manifesto}」`,
      `目的「${kit.proposition}」（判「欲向」只用这一句）`,
      `手段「${kit.means}」（判「正当的手段」只用这一句）`,
      `六维：${ATTR_KEYS.map((k) => `${k} ${attrs[k]}`).join(' · ')}` +
        `（点亮 ${adv.length} 个优势：${adv.length === 0 ? '无' : adv.join('、')} · **总和 ${sum}**）`,
    ],
  };
}

/** 校验优势属性并归一成 `AttrKey[]` —— 越界/ 非法键名**抛**（它是玩家的输入，不是模型的输出） */
function readAdvantages(raw: readonly unknown[]): AttrKey[] {
  if (!Array.isArray(raw)) {
    throw new OpeningRejected(`优势属性必须是数组（是 ${typeof raw}）`);
  }
  const out: AttrKey[] = [];
  for (const k of raw) {
    if (typeof k !== 'string' || !(ATTR_KEYS as readonly string[]).includes(k)) {
      throw new OpeningRejected(`优势属性 ${JSON.stringify(k)} 不在六维里（${ATTR_KEYS.join(' / ')}）`);
    }
    if (!out.includes(k as AttrKey)) out.push(k as AttrKey);
  }
  if (out.length > ATTR_ADV_MAX) {
    throw new OpeningRejected(`优势属性点了 ${out.length} 个，最多 ${ATTR_ADV_MAX} 个（用户裁定：0~2）`);
  }
  return out;
}
