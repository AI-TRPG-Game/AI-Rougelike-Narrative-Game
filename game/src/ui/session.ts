// P5-0 · 最小可交互 UI 的**会话层** —— 一局游戏在内存里的样子。
//
// ⚠️ 它**不含任何规则**：每个动作都是"把 `turn/` 里那一个函数调一次，然后把账本换掉"。
//    自有的逻辑只有两件 UI 专属的事：**防剧透的读数时机** 与 **给玩家的播报**（见下）。
//
// ⚠️ **`pending` 的读数纪律**（本文件最要紧的一处）：
//    `Ledger.pending` 是"已经发生、玩家还不知道"的未来（注入标签「永不」）。
//    ⇒ 它不是"绝不能读"，而是"**只在事件离开「揭晓待办」之后才能读**"。
//    做法：每次动作**之前**把这些条目的 `pending.narration` 先扣在手里（`probe()`），
//    动作**之后**看谁已经不是「揭晓待办」了 —— 那一刻才播报出去。
//    ⇒ "排布 → 等时间 → 揭晓"这条链路终于有了**玩家看得见的那一句话**。
//    （规则层不需要为此改一个字：`revealDue` 兑现完就把它从 `pending` 删了，
//      UI 若不在此刻截住，那句叙事**永远不会再出现** —— 这是做 P5-0 才暴露出的缺口。）
//
// ⚠️ **逐次检查**：每次动作之后一律过 `terminateIfOver`。
//    漏挂过的代价，`turn/ending.ts` 顶上那段注释里记着账。
import {
  ATTR_KEYS,
  type AttrKey,
  type Attrs,
  type Difficulty,
  type Dispatchable,
  type Rep5,
  VOUCHER_ACHIEVEMENT,
  VOUCHER_RESONANCE,
  VOUCHER_WAY,
  type VoucherDim,
  type VoucherRarity,
} from '../contract/types.ts';
import { fakeBrain } from '../fixtures/fake.ts';
import { initialLedger } from '../ledger/initial.ts';
import {
  derivePersonStatus,
  findPerson,
  isAvailable,
  isAway,
  player,
  PLAYER_ID,
  type EndingRecord,
  type EventStatus,
  type EventTier,
  type GameEvent,
  type GateResult,
  type Ledger,
  type PersonStatus,
  type Placements,
  type TimePoint,
} from '../ledger/types.ts';
import { carriedItems, effectiveAttrsOf, effectiveItems } from '../rules/ability.ts';
import { chapterOf, dialRange, phaseOf, remainingToday, TOTAL_DAYS } from '../rules/clock.ts';
import { dangerZoneOf, desireBandOf, DESIRE_BAND_NOTE, type DesireBand } from '../rules/desire.ts';
import { DESIRE_KITS, kitOf, ATTR_ADV_MAX, type DesireKit } from '../rules/desire-kits.ts';
import type { DangerZone } from '../rules/dice.ts';
import { isFinalDay } from '../rules/ending.ts';
import { daypartOf } from '../rules/clock.ts';
import { CARRY_CAP, evalGates, GATE_LANE, gatesOf, type GateLane } from '../rules/gates.ts';
import { makeRng, type Rng } from '../rules/rng.ts';
import { SCENE_ROUND_CAP } from '../rules/scene.ts';
import type { DrawnCard } from '../rules/tarot.ts';
import { availableToday, BASE_ACTION_POINTS } from '../rules/x.ts';
import type { Brain } from '../turn/brain.ts';
import { createEvent as createUserEvent } from '../turn/create.ts';
import { closeGame, terminateIfOver, writeEnding } from '../turn/ending.ts';
import { handleEvent, type HandleInput } from '../turn/handle.ts';
import { choosePopup } from '../turn/popup.ts';
import { restore, type RestorePlace } from '../turn/restore.ts';
import { openScene, sceneLeave, sceneStep, type SceneOpenInput } from '../turn/scene.ts';
import { DEFAULT_CHOICE, type OpeningChoice } from '../turn/opening.ts';
import {
  afterPrologueCard,
  currentPrologueCard,
  driveOpening,
  prologuePending,
  prologueRng,
  skipToOpening,
  startPrologue,
} from '../turn/prologue.ts';
import { PROLOGUE_MAX_SEQ, PROLOGUE_OPENING_ID, PROLOGUE_TOTAL } from '../rules/prologue.ts';
import { placementPools, type PlacementPools } from '../turn/simulate.ts';
import { DIM_LABEL } from '../ledger/vouchers.ts';
import { enterDay, turnOver } from '../turn/t0.ts';
import { dial, nextDay } from '../turn/time.ts';

// ── 给 UI 看的形状（**只读快照**，不含任何 pending 内容）──────────────

export interface UiItem {
  id: string;
  name: string;
  kind: string;
  desc: string;
  holder: string | null;
  consumed: boolean;
  bonus: string[];
}

export interface UiPerson {
  id: string;
  name: string;
  basic: string;
  identity: string;
  /**
   * **LLM 写的那句描述**（`Person.desc`）—— 2026-10-05 透到玩家面。
   *
   * ⚠️ 它在 `ledger/types.ts:54` 是**身份骨架**（注入标签 ①、永不变），
   *    所以它记的是"他**是**谁"，**不是**"他**现在**怎么样"。
   *    ⇒ 拿它演死亡/离队是**错的**（那两件事他一变就变，而 desc 不会跟着变）。
   *    真正能演"他怎么了"的是 `status`（派生：死亡/疯狂/濒死/重伤）。
   *
   * ⚠️ 那为什么还要透上来：用户的判断是「物品的状态栏或者描述里 LLM 应当可以表示出来」——
   *    对**物品**成立（`Item.desc` 本来就在 view 里，`consumed` 也在），
   *    对**人**要靠 `status`。`desc` 是补上"他是谁"那一半，
   *    让卡面不必把 `basic` ＋ `identity` 两行都摊开。
   */
  desc: string;
  race: string;
  hp: number;
  san: number;
  status: PersonStatus;
  affiliated: boolean;
  /** 在册 ∩ 未被派遣 ∩ HP/SAN > 1（闸门 ③ 的判据，UI 拿它把人置灰） */
  available: boolean;
  /**
   * **物品带来的属性加成**（2026-10-05 用户裁定：「如果携带的物品有数值加成，
   * 在人物卡对应属性后面显示 (+x)」）。
   *
   * ⚠️ **数字不是 UI 算的** —— `rules/ability.ts·bonusesOf` 是既有口径
   *    （本人 `attr_bonus` ＋ 他身上每件没被消耗的物品的 `attr_bonus`），
   *    UI 再写一份就会与它漂（物品被消耗时立刻对不上）。
   *    ⇒ 这里**透出它的结果**，UI 只负责显示。
   * ⚠️ 形状是**逐项**的（`{attr, bonus}[]`）而不是一个加总：
   *    「敏捷 +3、感知 +1」与「敏捷 +4」是两回事 ——
   *    玩家要能看见**是哪件东西**让他变强（点开就知道），加总会把这个信息抹掉。
   * ⚠️ 只给**物品**带来的（不含 `Person.attr_bonus` 那个自身字段）——
   *    用户说的是"携带的物品有数值加成"，自身那条是另一回事，不混进来。
   */
  itemBonuses: Array<{ attr: AttrKey; bonus: number }>;
  /**
   * 他身上**哪几件**正在生效（`BONUS_CAP = 2` 那两件）—— 2026-10-06 用户裁定
   * 「最多生效两件物品的数值加成效果」。
   *
   * ⚠️ **这是"生效取舍"，不是"携带限制"**（用户**修正过**最初那句
   *    「至多 2 件带加成的」）：东西**都能带**（携带位仍受 `CARRY_CAP` 管），
   *    只是只有 `effectiveItems` 选出的那两件算数。
   *    ⇒ UI 必须让玩家看见**哪几件白带**，否则他会以为四件都在生效。
   * ⚠️ 与 `rules/ability.ts·effectiveItems` **同一条口径**（同函数）——
   *    UI 自己再排一次就会与判定漂。
   * ⚠️ 形状带 `on` 标记：不用让 UI 去算差集（`items` 与生效集都给了，比对是 UI 的活）。
   */
  effectiveItemIds: string[];
  /**
   * **他的有效属性合计**（基础 ＋ 生效物品加成）—— 2026-10-06 用户裁定（清单第 5 条 5.4）
   * 「事件标题左侧显示处理事件所需要的属性（**一开始是 0，会根据放上去的人物卡属性
   * 而实时变化**）」。
   *
   * ⚠️ **数字不是 UI 算的**：`rules/ability.ts·effectiveAttrs` 是既有口径，
   *    而 `gates.ts` 判属性门槛用的是**同一个函数** ⇒ 界面上那个数与"过不过得了闸门"
   *    **永远一致**，不会出现"显示够了但过不去"。
   * ⚠️ **前端只做加法**（几个人一起办就加起来）—— 逐人的数由规则层给，
   *    前端**不重算一遍**（那会与 `gates.ts` 漂）。
   * ⚠️ 与 `attrs` 的差别：`attrs` 是**裸值**（不含物品）⇒ 这份是"算完的"。
   */
  effectiveAttrs: Attrs;
  away: boolean;
  /** 今天还剩多少点：下属 = 容量；玩家 = 当天剩余**时间** */
  ap: number;
  attrs: Attrs;
  in_your_eyes: string;
  openness: number;
  items: UiItem[];
  recognized: string[];
}

export interface UiOption {
  /** 选项文字。⚠️ **`result_text` 不在这里** —— 那是"选了之后才知道"的东西 */
  text: string;
}

/**
 * 一条闸门 ＋ 它属于哪一栏（`rules/gates.ts·GATE_LANE`）。
 * ⚠️ **`lane` 由规则层给**，UI 不许自己按 `code` 再编一份分类（同一个口径两处实现的老坑）。
 */
export interface UiGate extends GateResult {
  lane: GateLane;
}

/**
 * **一条欲望原型**（给 UI 渲染选择面板用）—— `rules/desire-kits.ts·DesireKit` 的投影。
 *
 * ⚠️ **刻意只带 UI 真的要显示的三项**（`index` / `label` / `manifesto` / `proposition`）：
 *    **别把整个原型对象递出去** —— UI 若拿到完整对象，它就会开始自己解释它的结构，
 *    那个解释迟早与规则层漂移。
 */
export interface UiDesireKit {
  /** 下标 = 玩家要传回来的 `kit` */
  index: number;
  label: string;
  /** 宣言 —— 玩家自己写下的中二原话（只上卡面与终局，不进判定） */
  manifesto: string;
  /** 手段 —— 判「正当的手段」只用它 */
  means: string;
  /** 目的 —— 判「欲向」（每天"更近了没有"）只用它 */
  proposition: string;
}

export interface UiCard {
  id: string;
  title: string;
  content: string;
  stage: string;
  location: string | null;
  tier: EventTier;
  status: EventStatus;
  dispatchable: Dispatchable;
  /** 「非他不可」—— `null` = 没指定。给卡面那颗 tag 用（`name` 已在会话层解析好） */
  requiredPerson: { id: string; name: string } | null;
  cost: number;
  min_gold: number;
  min_people: number;
  max_people: number;
  deadline: number;
  hint_attr: AttrKey[];
  difficulty: Difficulty;
  created_day: number;
  handler: string | null;
  handlerName: string | null;
  participants: string[];
  options: UiOption[];
  /** `揭晓待办` 才有：第几天第几点出结果 */
  reveal_at: TimePoint | null;
  /** 过期日（`created_day + deadline`）；档 A 恒 `null`（它只受"当天必须清"约束） */
  expiresOn: number | null;
  /**
   * **这条事件被锁住的金币** —— 玩家提交那一刻扣下、锁在事件里，结算时按**实际消耗**退差额。
   *
   * ⚠️ 2026-09-22 补：它此前只递到 `UiScene`（多轮场景那一格），**单轮事件那一格看不见它**
   *    ⇒ 右栏「经过」卡上"这件事我投了多少钱"是个空白。这不是新加的机制，只是把账本上
   *    早就有的那个数**递给界面**（`GameEvent.gold_locked`）。
   */
  goldLocked: number;
}

/**
 * 一张**凭证卡牌**（`UiView.vouchers` 的元素）—— 见那一处的口径说明。
 *
 * ⚠️ `dim` 是**它属于哪一行**（`成果` / `手段` / `共鸣`），前端据此决定拖进哪几个槽。
 *    第四行「如一的初衷」**没有凭证**（它只实时显示欲念值）⇒ 不在这个联合里。
 */
export interface UiVoucher {
  /** 卡牌的稳定 id —— 前端拖拽/选中用它（不是 `item` / `event` / `person` 那个 id） */
  id: string;
  /**
   * 属于哪一行 —— ⚠️ **直接透传 `VoucherDim` 的英文枚举值**，不另造一个中文联合：
   * 那会让"前端的中文行名"与"账本里的 `dim`"成两份映射，两处迟早漂。
   * 显示用 `dimLabel`（`ledger/vouchers.ts·DIM_LABEL` 是唯一拷贝）。
   */
  dim: VoucherDim;
  /** 行名（'伟大的成果' / '正当的手段' / '他者的共鸣'）—— 显示用 */
  dimLabel: string;
  /** **卡片正面的标题** —— 物品名 / 人物名 / 事件标题 */
  title: string;
  /** **卡片背面的描述** —— `item.desc` / 凭证 `desc` / 事件 `summary` */
  detail: string;
  /** 稀有度（2026-10-08 用户裁定）：普通 / 罕见 / 珍稀 / 传说 —— 卡面与详情页都显示 */
  rarity: VoucherRarity;
}

export interface UiScene {
  eventId: string;
  title: string;
  round: number;
  cap: number;
  present: Array<{ id: string; name: string }>;
  /** 逐轮记录（收尾时它就是【场景经过】那一份的最后一次露面） */
  turns: string[];
  ledgered: string[];
  spent: number;
  goldLocked: number;
  lastTier: string | null;
}

export interface UiView {
  seed: number;
  steps: number;
  day: number;
  totalDays: number;
  chapter: number;
  phase: string;
  /**
   * **现在是哪一段**（早上/下午/傍晚/深夜）—— 2026-10-06 用户裁定（清单第 25 条）。
   * ⚠️ **纯派生**（`rules/clock.ts·daypartOf`，从"今天已用几点"算）⇒ 不新增存储字段。
   * ⚠️ `phase` 那个「序幕/正文/终局」**保留**（别处还在读它，两者不是一回事：
   *    一个说"这一局走到哪了"，一个说"今天现在几点"）。
   */
  daypart: '早上' | '下午' | '傍晚' | '深夜';
  usedToday: number;
  apTotal: number;
  remaining: number;
  /**
   * **拨时针的合法区间**（2026-10-07 清单第 9.1 条）——
   * `{min: 1, max: n}`；`max < min` 表示**空区间**（已用尽 / 被处理中的事压到 0）。
   * ⚠️ 由 `rules/clock.ts·dialRange` 算好，UI 只读不算。
   */
  dial: { min: number; max: number };
  isFinalDay: boolean;
  isOver: boolean;
  gold: number;
  rep: Rep5;
  desire: {
    value: number;
    /**
     * **欲念区间**（迷失 / 常态 / 窗口 / 沉溺 · 4 值）—— 逐字取《设定.md》的区间列。
     *
     * ⚠️ **2026-09-22 用户裁定推翻了旧口径**：此前玩家面**只给区间名、数值谁都不给**；
     *    现在**区间名 ＋ 数值一起印**（顶栏那颗 chip 与存档卡都用 `value`）。
     * ⚠️ 《规则.md》:640 的前半句**仍然成立**：欲念由规则层独算、**不给任何 LLM** ——
     *    实测 `game/src/prompt/` 目录对 `desire.value` / `desire.band` **零命中**。
     *    被推翻的只是它的后半句（"玩家只能从区间语义与「欲向」的手感里摸"）。
     * ⚠️ 它与 `zone`（危险区 · 3 值）**不是同一个东西** —— 后者把"常态"与"窗口"合成 `正常`，
     *    因为规则层对这两段一视同仁（都不收税、都不修正）⇒ 它**只该出现在上帝视角**里。
     */
    band: DesireBand;
    /** 区间的一句话读数—— 只作悬停提示 */
    bandNote: string;
    /** **目的**（＝判「欲向」的那一句） */
    proposition: string;
    /**
     * **手段**（2026-10-06 新增）—— 「通过 X 来 Y」里的 X：他打算怎么去要。
     * ⚠️ 它是 `vouchers.the_proper_way`（**正当的手段**）的判据，也是玩家自己的路子
     *    ⇒ 玩家**必须看得见**（不然他在终局判"正当"时不知道自己被判的是什么）。
     * ⚠️ 旧存档没有它 ⇒ `''`。
     */
    means: string;
    /**
     * **欲望宣言**（中二体 · 玩家自己写下的）—— 2026-10-05 用户裁定「双文本」新增。
     * ⚠️ 它与 `proposition` 是**两个读者**：宣言上卡面（给玩家看情绪），
     *    命题进每一次判定（给规则层判"更近了没有"）。⚠️ 旧存档没有它 ⇒ `''`。
     */
    manifesto: string;
    /** 玩家挑的是 `DESIRE_KITS` 的第几条（0~4）—— UI 靠它回显"你选了哪条" */
    kit: number;
    // ⚠️⚠️ **2026-10-05 用户裁定：牌与欲望彻底解耦**（「根本不需要塔罗牌的参与」）
    //    ⇒ 视图里**不再有 `desire.cards`**，「这一局」面板上那两行牌也一并删掉。
    //    ⚠️ 章节占卜**仍然抽牌**，但它只出现在 `ambience` 里（世界层），与欲望无关。
  };
  /**
   * 本周氛围（`chapter_shift` 每章一次）—— 这一次产出里**唯一玩家可见**的那一半。
   * ⚠️ 它必须常驻在视图上：播报只念一次（`feed` 会被裁到 200 条），
   *    而氛围是那一整章的底色，玩家随时该看得到。还没占卜过 ⇒ null。
   */
  ambience: string | null;
  /**
   * 本章占卜抽到的两张牌（牌名＋正逆位）—— 2026-10-08 起随氛围落账、玩家可见（签文旁展示）。
   * 旧档（`cards` 落账之前存的）没有 ⇒ null，签文旁不显示牌（优雅降级）。
   * ⚠️ 它只描述世界氛围，**不参与欲念计算**（2026-10-05 用户裁定）。
   */
  divCards: Array<{ name: string; reversed: boolean }> | null;
  /**
   * **序幕（`day 0` · 界面显示「Day 0」）还没读完** —— 不在序幕 / 已走完 ⇒ `null`。
   *
   * ⚠️ 为什么必须往视图上递：2026-10-08 起序幕**除末条外一次全铺、自由点选**
   *    （`turn/prologue.ts`）⇒ 界面要靠它区分三种局面：① 序幕在读（地图顶上该说
   *    「以下是你要处理的事件…」）；② 末条出现没有（「直接正式开始游戏」按钮该不该在）；
   *    ③ 序幕读完、还停 day 0（那句话要等新的一天真的开始才换成「这些是摆在…」）。
   * ⚠️ `seq` = live 里**第一条待处理**的序号（自由点选后"当前在读"不再唯一，
   *    它只用于 `needsChoice` 的"站在末条上"判定）；`remaining` = 还剩几条没读。
   * ⚠️ `day` = **序幕的第几天**（`1 | 2`），**不是** `clock.day`（序幕期恒 `0`）。
   * ⚠️ `openingLaid` = 末条「原初欲望的觉醒」铺出来没有（按钮随之消失 —— 用户裁定）。
   */
  prologue: { seq: number; total: number; day: number; remaining: number; openingLaid: boolean } | null;
  /**
   * **5 条欲望原型 ＋ 玩家当前的选择**（2026-10-05 用户裁定：开局自己挑）。
   *
   * ⚠️ **为什么要往视图上递**：序幕末条那条「原初欲望的觉醒」只有**一个选项**
   *    （"迎接你『真实的自我』"）—— 玩家点了它就该**选欲望**，但那一步没有任何输入口。
   *    没有这块，UI 只能：① 偷偷用默认值（玩家失去选择权），
   *    或 ② 自己 import 规则层（那就多了一份口径，正是本项目反复踩的坑）。
   * ⇒ **`kits` 是静态数据**（`Session.desireKits()` 的同一份），`choice` 是**会话态**
   *    （还没落账 —— 落账在 `clickPopup` 点到末条那一刻）。
   * ⚠️ `needsChoice` = **"正站在末条上、且还没选过"** ⇒ UI 该弹选择面板的判据。
   */
  desirePick: {
    kits: UiDesireKit[];
    choice: { kit: number; advantages: string[] };
    needsChoice: boolean;
  };
  me: UiPerson;
  people: UiPerson[];
  items: UiItem[];
  popups: UiCard[];
  todo: UiCard[];
  waiting: UiCard[];
  settled: UiCard[];
  hiddenCount: number;
  scene: UiScene | null;
  sceneCap: number;
  /**
   * 9 条闸门 ＋ 每条的**栏位**（`动作拦截` / `控件置灰`）——
   * ⚠️ **不含**末尾那条「当前状态」快照行（见 `statusLine`）：它与闸门 ① 同名，
   *    混进这里会让面板首尾看起来像重复列了一条。
   */
  gates: UiGate[];
  /**
   * `rules/gates.ts·gateSnapshotOf` 那一行「**当前状态**」读数（玩家剩余时间 ＋ HP ＋ SAN）。
   * ⚠️ **它不是闸门**，UI 拿它当读数渲染、不要列进闸门两栏。
   */
  statusLine: GateResult;
  /**
   * 当前危险区（由欲念推导 `dangerZoneOf`）。
   * ⚠️ **它是规则层自用口径（3 值）**，只该出现在"上帝视角"里 —— 玩家面上给的是 `desire.band`（4 值）。
   */
  zone: DangerZone;
  /**
   * **凭证卡牌**（`ledger.vouchers` 里 `recalled_day === null` 的那些）——
   * 2026-10-06 清单第 22 条（用户原话：「我们需要专门设置一种新卡牌类型--**凭证**，
   * 也是放在手牌区，但**只能在『你的欲望』事件中使用**」）。
   *
   * ⚠️ **id 已经在规则层解析成名字与描述了** —— 前端**不自己查** `items` / `people` / `events`：
   *    那会是"两处各查一遍"，而事件概要、人物名都可能变。`ledger/vouchers.ts·DIM_LABEL`
   *    是三维标签的**唯一拷贝**，这儿直接用它给的字。
   *
   * ⚠️ **`detail` 是给玩家看的"这张凭证是什么"**，三种来源各不相同：
   *    · 物品类 ⇒ **物品自己的 `desc`**（用户裁定：「物品/情感显 `desc`」）
   *    · 人物情感类 ⇒ **凭证自己的 `desc`**（不是那个人物的简介 —— 那是"他是什么样的人"）
   *    · 事件类 ⇒ **事件的概要 `summary`**（用户裁定：「事件显**事件概要**」）
   *    找得到不到都退化成凭证自己的 `desc`，**不静默丢一张卡**。
   */
  vouchers: UiVoucher[];
  /** 第 28 天放格子的**三格候选池** —— 读 `turn/simulate.ts·placementPools` 的**唯一口径**，UI 不再自算一份 */
  placementPools: PlacementPools;
  ending: EndingRecord | null;
  recentSummaries: Array<{ day: number; text: string }>;
  archive: string[];
  /**
   * 种子队列。⚠️ 它是**系统账**（"世界强加的账"），不是玩家的东西 ⇒ 只在上帝视角里出现。
   * `source`：`硬种子`（checkpoint · **必出**）／ `LLM`（软钩子 · 未被承接当天作废）。
   */
  seeds: Array<{ code: string; title: string; source: string }>;
  /**
   * **最近一次投骰**（2026-10-05）—— 只给 UI 演出判定盘那张骰面。
   *
   * ⚠️ **为什么 d20 能到玩家面、却不违反「永不外泄」那条口径**：
   *    `ledger/project.ts·FIELD_TAGS` 那张表是**账本 → LLM 上下文**的映射
   *    （`永不` = 不注入任何 prompt），理由是**防剧透与防模型复述数字**。
   *    这条是 **UI 通路**，一个 prompt 都不进。先例在同一张表里：`ending`
   *    那行写着「结局名 / 话术 / 判定依据（**只给 UI**）」、同样标 `永不`。
   * ⚠️ `null` ＝ 上一次动作**没有掷骰**（档 A 点选 / 场景轮次 / 直接成功失败）
   *    ⇒ UI 自然不画骰面，不需要它自己判断"该不该显示"。
   * ⚠️ 它**不落账本**：存进 `Ledger` 会让读档与回放都背上它，而它对世界没有影响。
   */
  roll: {
    tier: string;
    raw: number;
    adjusted: number;
    a: number;
    diceRolls: number[];
    modifierTotal: number;
    endpoint: string | null;
    leaderName: string;
    attrs: AttrKey[];
  } | null;
}

/**
 * **一次投骰的展示明细**（2026-10-07 新增）—— 给前端的**骰子动画弹窗**用。
 *
 * ⚠️ 与 `lastRoll` 同一条口径：它是 **UI 演出态**，不进任何 prompt
 *    （「d20 / A / R 永不外泄」管的是账本 → LLM 上下文那条路，UI 不在管辖内）。
 * ⚠️ 为什么要在**排布时**就把它存起来：投骰发生在**排布那一刻**（`turn/handle.ts`），
 *    而骰子动画要在**揭晓那一刻**播（「先看骰子怎么落的，再看结算结果」——用户裁定）。
 *    两次之间隔着 `reveal_at`，`lastRoll` 那份"只留最近一次"的口径撑不过去
 *    ⇒ 按 `eventId` 各存各的，揭晓时取走即删。
 * ⚠️ **不进快照**（同 `lastRoll`）：读档回来正在路上的骰没有动画可播——
 *    那次揭晓直接出结算结果（前端对 `roll` 缺失的条目就是原行为）。
 */
export interface UiRollDetail {
  tier: string;
  /** 原始 d20 */
  raw: number;
  /** R = d20 ± 修正骰之后的值 */
  adjusted: number;
  /** 钳在 [1,20] 的目标值 A */
  a: number;
  /** 钳前均值（向下取整）—— 弹窗上那句「实际生效数值为均值为 zz」 */
  mean: number;
  diceRolls: number[];
  modifierTotal: number;
  endpoint: string | null;
  /** 主事者名字（排布时从账本现查，揭晓时人可能换了名字也照播当时的） */
  leaderName: string;
  /** 判定属性（`xx` / `yy`）＋ 主事者在各项上的**有效值**（含物品加成） */
  attrs: Array<{ attr: AttrKey; value: number }>;
  /** 参与者名单（弹窗右侧那排卡槽） */
  participants: Array<{ id: string; name: string }>;
}

/** 播报 —— 玩家**看得见**的一句话。三类来源：刚刚揭晓的结果 / 档 A 点选 / 场景里的轮次与收场 */
export interface FeedItem {
  day: number;
  kind: '揭晓' | '弹窗' | '场景' | '收场' | '占卜' | '终局';
  title: string;
  text: string;
  /**
   * 这条播报**属于哪一条事件**（`''` = 不属于任何事件 —— 章节占卜与终局是**世界级**消息）。
   *
   * ⚠️ 2026-09-22 加：右栏要**按事件分区**呈现（用户裁定「一次结算 = 一个结果分区」）。
   *    没有这个字段，界面只能靠「标题 ＋ 天数」去猜哪段结果属于哪件事 ——
   *    而标题**会重复**（实测同一局里同名事件不止一条，夹具的标题池就那么几个）
   *    ⇒ 猜错就把结果挂到别的事上，而且**看起来完全正常**。
   *    ⇒ 关联关系**由产生它的那一处写死**，不留给渲染层去推断。
   */
  eventId: string;
  /**
   * 这次揭晓**配的骰**（2026-10-07）—— 简略处理那一路在排布时掷的骰，
   * 揭晓时随这条播报发给前端播动画。没掷过骰（档 A / 免判定 / 读档丢掉的）就没有这个字段。
   */
  roll?: UiRollDetail;
}

export interface ActionResult {
  ok: boolean;
  /** `ok=false` 时的原因（闸门 / 前置不成立） */
  error: string;
  /** 需要**立刻**给玩家看的文案（档 A 的 `result_text` / 场景那一轮的叙事 / 终局话术） */
  notice: string;
  /** 这一步新产生的日志 */
  log: string[];
  /** 这一步之后这一局是否已终结 */
  ended: boolean;
}

export interface SessionOptions {
  seed?: number;
  brain?: Brain;
  /**
   * ⚠️⚠️ **这一局是真游戏**（`ui/server.ts --live` 会传 true）—— 2026-10-06 新增。
   *
   * ⚠️ **为什么需要它**（用户裁定的问题 8「我明明用 live 打开，却还会有不该出现的假事件」）：
   *   原来 `start()` 里是 `o.brain ?? fakeBrain()` ⇒ **任何没显式传 brain 的路径
   *   都会静默回落到假 brain**，造出"这一局是真的"的假象，而且**没有任何报错**。
   *   ⇒ 现在：`requireLive = true` 且没传 `brain` ⇒ **当场抛**（宁可不启动，也不静默变假）。
   *
   * ⚠️ **默认 false** ⇒ 离线路径（无头驱动的替身、`ui.test.ts`、截图脚本）行为**一个字不变**。
   */
  requireLive?: boolean;
  /**
   * **跳过序幕**（`day 0` 的 10 条档 A）—— 默认**不跳过**。
   *
   * ⚠️ 默认跑序幕 = **真实开局**：先逐条读完两天巡礼（认人 · 认地点），
   *    点下「迎接你『真实的自我』」才翻两张塔罗，再点「进下一天」进正文。
   * ⚠️ 打开它 ⇒ 退回 P4-D 之前的行为：不铺那 10 条，直接开在**第 1 天**。
   *    与无头驱动的 `SimOptions.skipPrologue` **是同一件事** —— 两处必须一致，
   *    否则"UI 试出来的手感"与"标定用的 28 天"就不是同一局了。
   */
  skipPrologue?: boolean;

  /**
   * **跳过序幕时，要不要当场翻牌**（`turn/prologue.ts·driveOpening`）—— 默认**开**。
   *
   * ⚠️ 名字是"替身"年代的遗留（那会儿这里会塞一组**手写**六维 `{7,9,12,11,10,6}`；
   *    P4-C 落地后替身已删、改走真链路）。现在它只剩一个作用：`skipPrologue` 那条路上
   *    "翻不翻牌"。
   * ⚠️ **走序幕那条路时它不起作用** —— 末条「原初欲望的觉醒」必然翻牌，
   *    那是 `opening` 这条侧链**唯一**的设计触发点。
   * ⚠️ 翻不翻牌的区别是"这一局有没有欲望"：关掉它，六维留在占位全 5、命题为空、
   *    `desire.cards` 为 null ⇒ UI 上"欲望"整块是空的（那正是 P4-C 之前的样子）。
   */
  standIn?: boolean;

  /**
   * **玩家的两项选择**（欲望原型下标 ＋ 点亮的优势属性）—— 2026-10-05 用户裁定。
   *
   * ⚠️ **走序幕那条路上它是玩家在 UI 上现点的**（见 `Session.pickDesire`），
   *    这里这份只是给 **`skipPrologue: true`** 的调试/测试路径当默认值。
   * ⚠️ 省略 ⇒ 走 `DEFAULT_CHOICE`（与无头驱动同一个值，两条路同构）。
   */
  choice?: OpeningChoice;
}

/**
 * **存档快照** —— 一局的**全部可变状态**，序列化成一份 JSON。
 *
 * ⚠️ 为什么这些字段**缺一不可**（每一条都是有理由的，不是"顺手都存上"）：
 *    · `ledger` —— 游戏状态的**唯一**载体：连场景多轮（`scene`）、预计算结果（`pending`）、
 *      骰子读数（`roll`）、硬种子门槛（`repMarks`）、id 水位（`idWatermark`）都在里面。
 *      ⇒ 只要它整份还在，世界就完整；
 *    · `rngState` / `pRngState` —— 两条随机流的**游标**。⚠️ 只存 `seed` 不够：
 *      那只能从头重放，而重放得重放整局动作（真模型下 = 重烧一遍钱）。
 *      见 `rules/rng.ts·Rng.state`；
 *    · `log` / `feed` / `steps` / `endingAnnounced` —— 这条是"**给玩家看的**"
 *      与"哪些一次性播报已经做过了"。丢了不会崩，但玩家读档回来会发现**播报没了**、
 *      终局话术**又播一遍**；
 *    · `flip` —— 序幕末条翻不翻牌（`skipPrologue` 那条路要靠它）。
 * ⚠️ 刻意**不含** `brain`：那是"怎么算"，不是"这一局是什么"。读档时由调用方现给
 *    ⇒ 同一份存档，**离线假 brain 与真模型都能开**。
 */
export interface SessionSnapshot {
  v: number;
  seed: number;
  rngState: number;
  pRngState: number;
  ledger: Ledger;
  flip: boolean;
  /**
   * **玩家的两项选择**（2026-10-05）—— 见 `Session.choice`。
   * ⚠️ 落盘的理由：它是**玩家亲手做的决定**，"选好了还没开局就退出"时丢掉它 = 静默丢玩家数据
   *    （与 `test/save.test.ts` 那条"白名单漏一个字段 ⇒ 整个机制退化"是同一类坑）。
   * ⚠️ **可选字段**：旧存档（v1 早于这次改动）没有这个键 ⇒ `restore` 读作
   *    `undefined` 并回退到账本/默认值。⇒ **`SNAPSHOT_VERSION` 刻意不 +1**：
   *    加一个带兜底的可选键**不破坏**任何一份旧档，而 +1 会让玩家现有的槽位全部读不出来
   *    （`restore` 是**硬抛**）。同一条思路也用在 `Ledger.desire` 新增的
   *    `manifesto` / `kit` / `advantages` 三个键上（全部 `??` 兜底）。
   */
  choice?: OpeningChoice;
  log: string[];
  feed: FeedItem[];
  steps: number;
  endingAnnounced: boolean;
}

/**
 * 快照**形状**版本 —— 改了 `SessionSnapshot` 的**既有字段含义**就 +1。
 * 与"库表结构版本"（`save/db.ts·DB_SCHEMA_VERSION`）是两件事：那个管列，这个管 JSON。
 *
 * ⚠️ **2026-10-05**：`opening` 那次改动往快照里**加了一个可选键** `choice`，
 *    而版本**仍是 1** —— 判据是「加带兜底的可选键不算破坏性变更」，
 *    `+1` 会把玩家现有的四份 v1 存档全部变成"读不出来"（`restore` 硬抛）。
 *    ⚠️ 真正破坏性的变更（改既有字段的含义 / 删字段 / 换账本结构）**仍然要 +1**。
 */
export const SNAPSHOT_VERSION = 1;

export const DEFAULT_UI_SEED = 20260921;
const LOG_KEEP = 400;
const FEED_KEEP = 200;

/** 终局那一句给人看的话：失败走系统预写话术；成功的话术由 `ending` 侧链（未建）产出 */
export function endingText(e: EndingRecord): string {
  if (e.text) return e.text;
  return `（这一局的话术还没落到纸上 —— 只留下一句判词：「${e.name}」，第 ${e.day} 天。）`;
}

/**
 * 按 id 找出**场景挂着的那个事件**（判定盘要读它的 `hint_attr` —— 见 `sceneSay` 那处）。
 *
 * ⚠️ 为什么自己找而不加个 `findEvent` 导出：场景那条是**唯一**需要"从账本找事件"的
 *   场合（别处都是先拿到 `target` 再用），为一个调用点开一个导出不划算。
 * ⚠️ 找不到就返回 `undefined`（**不抛**）：它只喂 UI 演出，缺了不该把一次
 *   成功的场景轮次变成 500。
 */
function sceneEventOf(l: Ledger, id: string): GameEvent | undefined {
  if (!id) return undefined;
  return l.events.live.find((e) => e.id === id);
}

/**
 * **凭证卡牌列表** —— `ledger.vouchers` 里还没被收回的那些，解析成前端能直接画的形状。
 *
 * ⚠️ **只给 `recalled_day === null` 的**（`ledger/vouchers.ts` 那条纪律：收回**不新写一条**，
 *    只把已挂着的那条标上日期）⇒ 被收回的凭证**不该再出现在手牌区**，否则玩家会拖一张
 *    已经失效的卡进格子、而服务端把它当有效的那条处理。
 *
 * ⚠️ **正面来源按维度各不相同；背面（`detail`）统一以凭证自己的 `desc` 为先**
 *    （2026-10-08 用户第 2 条：点开凭证卡读的应是 LLM 结算时写的 30~75 字说明）；
 *    凭证 `desc` 为空才回退旧来源（旧档兼容）：
 *    | 维度 | 正面 `title` | 背面 `detail`（⇐ 回退） |
 *    | --- | --- | --- |
 *    | 成果（物品） | 物品名 | **凭证 `desc`** ⇐ 物品自己的 `desc` |
 *    | 手段（事件） | 事件标题 | **凭证 `desc`** ⇐ 事件的 `summary`（概要，不是正文） |
 *    | 共鸣（人物） | 人物名 | **凭证 `desc`**（那个人给过什么认可） |
 *
 * ⚠️ **卡牌 id 用 `v:{dim}:{绑定id}` 而不是凭证记录的下标** —— 前端拖拽要一个稳定串，
 *    而 `VoucherRecord` 没有自己的 id 字段（它是数组里的一项）。
 * ⚠️ **找不到绑定实体时**（物品被销毁、事件被归档）：正面退回凭证 `desc` 的头 8 字、
 *    背面用 `desc` 全文 ⇒ **不静默丢卡**（丢了玩家会以为"我明明有凭证"）。
 */
function vouchersOf(l: Ledger): UiVoucher[] {
  const out: UiVoucher[] = [];
  // ⚠️⚠️ **字段是 `l.vouchers`（顶层），不是 `l.entities.vouchers`** ——
  //   我第一版写成了后者，而 `?? []` 正好**把这个错藏了起来**：迭代一个恒 undefined 的
  //   属性得到空数组 ⇒ 界面上一张凭证卡都没有、探针只报 `vouchers = 0`，看着像"还没产出"。
  //   ⇒ 现在读真字段。**那条 `?? []` 也一并删** —— `l.vouchers` 是账本第 8 组、
  //   恒存在（`ledger/apply.ts:346` 就是往它 push），留个空数组兜底只会再藏一次错。
  for (const v of l.vouchers) {
    if (v.recalled_day !== null) continue;
    let title = v.desc;
    let detail = v.desc;
    if (v.dim === VOUCHER_ACHIEVEMENT) {
      const it = l.entities.items.find((x) => x.id === v.item);
      if (it) {
        title = it.name;
        // ⚠️ 2026-10-08（用户第 2 条）：detail 以**凭证自己的 `desc`** 为先（LLM 的 30~75 字说明），
        //    空则回退物品 `desc`（旧档兼容 —— 旧档的凭证 desc 本就是成就一句话）。
        detail = v.desc || it.desc;
      }
    } else if (v.dim === VOUCHER_RESONANCE) {
      const p = l.entities.people.find((x) => x.id === v.person);
      if (p) title = p.name;
    } else {
      const e = l.events.live.find((x) => x.id === v.event)
        ?? l.events.hidden.find((x) => x.id === v.event);
      if (e) {
        title = e.title;
        // ⚠️ 2026-10-08（用户第 2 条）：同上 —— 凭证 `desc` 为先；为空才回退**概要**（`summary`），
        //    绝不用 `content` —— 正文可能有几百字，卡面放不下。
        detail = v.desc || e.summary;
      }
    }
    out.push({
      id: `v:${v.dim}:${v.item || v.person || v.event}`,
      dim: v.dim,
      dimLabel: DIM_LABEL[v.dim],
      title: title || '（无名）',
      detail,
      // ⚠️ 旧档的凭证没有 rarity 键 ⇒ 兜「普通」（读档自愈也会补，这里双保险）
      rarity: v.rarity ?? '普通',
    });
  }
  return out;
}

export class Session {
  seed: number = DEFAULT_UI_SEED;
  ledger: Ledger;
  rng: Rng;
  brain: Brain;
  /**
   * **序幕专用随机流**（`turn/prologue.ts·prologueRng`）—— 与正文那条 `rng` 分开。
   * ⚠️ 它只被"末条翻牌"消费一次（两张牌 × 牌名 / 正逆位）。存在会话上而不是
   *    每次现算：翻牌要跨 `clickPopup` 与 `Session.start` 两条路，而"牌由系统抽"这条
   *    纪律要求**同一个种子同一副牌**。
   */
  pRng: Rng;
  /** 走序幕那条路时，末条必然翻牌；跳过序幕时由 `standIn` 决定（见 `SessionOptions`） */
  flip: boolean;
  /**
   * **玩家的两项选择**（欲望原型下标 ＋ 点亮的优势属性）—— 2026-10-05 用户裁定。
   *
   * ⚠️ **它挂在会话上、不落账本** —— 因为它在 `applyPlayerChoice` 落账**之前**就要存在，
   *    而那是**玩家点选那一刻**的事（`pickDesire` 这次动作）。
   *    ⚠️ 落账之后账本里的 `desire.kit` / `desire.advantages` 才是事实源 ⇒ 读档回来时
   *    用 `restore()` 从账本**回填**这一份（见构造函数）—— 否则读档后玩家会看到
   *    "未选择"，可账本里明明有一条。
   * ⚠️ 之所以不落账本：`OpeningChoice` 是**输入**，不是**世界状态**——
   *    世界状态是"他选了第 2 条、点亮了争斗"，那才是账本里的 `kit` / `advantages`。
   */
  choice: OpeningChoice;
  /** 给 UI 的日志（最新的在最后） */
  log: string[] = [];
  /** 给 UI 的播报（最新的在最后） */
  feed: FeedItem[] = [];
  /** 走过几步（重绘 / 幂等判断用） */
  steps = 0;
  /**
   * **最近一次投骰**（2026-10-05 新增）—— 只给 UI 演出用。
   *
   * ⚠️⚠️ **它不违反「`d20` / `A` / `R` 永不外泄」那条口径** —— 那是
   *    `ledger/project.ts·FIELD_TAGS` 里的**账本 → LLM 上下文**映射（`永不` = 不注入 prompt），
   *    理由是**防剧透与防模型复述数字**。这里给的是 **UI**，不进任何 prompt。
   *    先例就在同一张表里：`ending` 那行写着「结局名 / 话术 / 判定依据（**只给 UI**）」、
   *    同样标 `永不`，而 UI 照样拿得到。
   * ⚠️ **不落账本**：它是**页面级**的演出状态。存进 `Ledger` 会让读档/回放都背上它，
   *    而它对"世界长什么样"没有任何影响（`ledger.roll` 那份 `{档位, 加成}` 才是账）。
   * ⚠️ 每一次 `handleEvent` 覆盖它 —— 玩家只会看到**最近那一次**的骰。
   */
  lastRoll: {
    tier: string;
    raw: number;
    adjusted: number;
    a: number;
    diceRolls: number[];
    modifierTotal: number;
    endpoint: string | null;
    leaderId: string;
    /** 本次用到的属性（判定盘上那几枚符号） */
    attrs: AttrKey[];
  } | null = null;
  /** 终局播报只做一次 */
  endingAnnounced = false;
  /**
   * **在路上的骰**（2026-10-07）—— `eventId → 排布时掷出的那份明细`。
   *
   * ⚠️ 投骰在排布那一刻、动画在揭晓那一刻，两次之间隔着 `reveal_at`；
   *    `lastRoll` 只留最近一次，同一时段排两件事就会把前一件事的骰挤掉
   *    ⇒ 按 `eventId` 各存各的，揭晓时取走即删（`adopt`）。
   * ⚠️ **不进快照**（同 `lastRoll`）：读档回来在路上的骰没有动画可播，
   *    那次揭晓直接出结算结果 —— 前端对缺 `roll` 的条目走原行为。
   */
  private rollByEvent = new Map<string, UiRollDetail>();

  constructor(seed: number, rng: Rng, brain: Brain, ledger: Ledger, pRng?: Rng) {
    this.seed = seed;
    this.rng = rng;
    this.brain = brain;
    this.ledger = ledger;
    this.pRng = pRng ?? prologueRng(seed);
    this.flip = true;
    // ⚠️ **未选就是未选**（2026-10-05）：**刻意不用 `DEFAULT_CHOICE`**。
    //    那个默认值是给**无头驱动**（`turn/simulate.ts`）的"没人点按钮"准备的；
    //    拿它当 UI 的初始值，会让面板**一打开就预亮一项优势**（实测抓到过）
    //    ⇒ 玩家没点任何东西就点「就这样」，等于白捡一个优势。
    //    ⇒ 开局的判据是 `kit === -1`（"还没挑"），不是"挑了第 0 条"。
    this.choice =
      ledger.desire.manifesto === ''
        ? { kit: -1, advantages: [] }
        : { kit: ledger.desire.kit ?? 0, advantages: [...(ledger.desire.advantages ?? [])] };
    // ⚠️ `lastRoll` **刻意不**从存档恢复（2026-10-05）：它是一次性的演出状态。
    //    读档回来就重画一次骰面会让玩家以为"刚投过一次"，而那不是他做的事。
  }

  /**
   * 开一局。
   *
   * ⚠️ **默认走序幕**（P4-D 起）：铺下 `e1`、**停在 `day 0`**，等玩家一条条读完
   *    （每点一条 `clickPopup` 才铺下一条，见 `turn/prologue.ts`）；点下末条
   *    「原初欲望的觉醒」时翻两张塔罗 ⇒ 再点「进下一天」才做 T0 进正文。
   *    在这里**不翻日、不 `enterDay`**：序幕没有时间预算，也不是"第 1 天"。
   * ⚠️ `skipPrologue` ⇒ 开场动作与 `turn/simulate.ts` 的 `skipPrologue` **逐字同构**：
   *    `day 0 → day 1` 再 `enterDay`。两处若不一致，"UI 试出来的手感"与"标定用的 28 天"
   *    就不是同一局了（`ui.test.ts` 走的就是这条路）。
   */
  static async start(o: SessionOptions = {}): Promise<Session> {
    const seed = o.seed ?? DEFAULT_UI_SEED;
    const rng: Rng = makeRng(seed);
    // ⚠️⚠️ 2026-10-06（用户裁定的问题 8）：**live 模式缺 brain 就抛错**，不再静默回落。
    //    原来 `o.brain ?? fakeBrain()` 是一句**无条件**的回落 ⇒ 任何漏传 brain 的路径
    //    都会悄悄换成假模型，造出"这一局是真的"的假象（实测踩过：live 局里出现了
    //    「（假事件文案）」，那正是回落后的产物）。
    //    ⇒ 判据是 `requireLive`（`ui/server.ts --live` 传 true）＋ 没传 brain ⇒ 抛。
    //    ⚠️ **离线默认一个字不变**（`requireLive` 默认 false ⇒ 仍走 `fakeBrain()`）。
    if (o.requireLive && !o.brain) {
      throw new Error(
        '这一局标记为「真游戏」（requireLive），但**没有传 brain** —— ' +
          '宁可不启动也不静默换成假模型（那会造出"这一局是真的"的假象）。' +
          '检查 `ui/server.ts` 的 `llmBrain(...)` 有没有传进来。',
      );
    }
    const brain: Brain = o.brain ?? fakeBrain();
    // ⚠️ 与无头驱动同一条流（`prologueRng`）—— 两处必须一致，"UI 的手感"才等于"标定的那一局"
    const pRng = prologueRng(seed);
    let l = initialLedger();

    if (o.skipPrologue) {
      let openingLog: string[] = [];
      const choice = o.choice ?? DEFAULT_CHOICE;
      if (o.standIn !== false) {
        // ⚠️ 开局**在 `turnOver` 之前** —— 序幕属于"第 0 天"，那是这一刻定的（与驱动同序）。
        //    顺序反过来会让 `chapter_shift`（第 1 天日初）读到空的 `cards`。
        const op = await driveOpening(l, brain, choice);
        l = op.ledger;
        openingLog = op.log;
      }
      turnOver(l);
      // ⚠️ `seed` 必须传进去（理由同 `turn/simulate.ts`）：它派生占卜那条独立随机流。
      const e = await enterDay(l, rng, brain, seed);
      const s = new Session(seed, rng, brain, e.ledger, pRng);
      s.flip = o.standIn !== false;
      s.choice = choice;
      s.note([`第 ${s.ledger.clock.day} 天 · 第 ${s.ledger.clock.chapter} 章 · ${s.ledger.clock.phase}`, ...e.log]);
      if (openingLog.length > 0) s.note(['序幕末条「原初欲望的觉醒」：', ...openingLog]);
      // 第 1 天本身就是占卜日 ⇒ 开局这一次的氛围要**当场播报**给玩家
      s.announceDivination(e.divination);
      return s;
    }

    // ── 序幕（默认）──
    const sp = startPrologue(l);
    l = sp.ledger;
    const s = new Session(seed, rng, brain, l, pRng);
    s.note([
      `序幕开始 · ${PROLOGUE_TOTAL} 条档 A · 显示「Day 0」（前 2 天不计入 28 天）`,
      '序幕不走 T0：不揭晓、不生成、无欲念漂移；0 行动点、0 调用。除末条外一次全铺、自由点选；' +
        '「原初欲望的觉醒」在其余事件处理完（或点「直接正式开始游戏」）后出现。',
      ...sp.log,
    ]);
    return s;
  }

  // ── 存档：导出快照 / 从快照恢复 / 直接结算 ────────────────────

  /**
   * **导出快照**（存档）—— 把这一局的可变状态整份交出去。
   *
   * ⚠️ 用 `structuredClone` 隔一层：调用方会把它 `JSON.stringify` 落库，
   *    若不克隆，后续动作换账本时**已经交出去的那份也会跟着变**
   *    （本项目 `apply*` 确实是"返回新账本、不改入参"，但快照这一层不该依赖那个约定）。
   */
  snapshot(): SessionSnapshot {
    return {
      v: SNAPSHOT_VERSION,
      seed: this.seed,
      rngState: this.rng.state,
      pRngState: this.pRng.state,
      ledger: structuredClone(this.ledger),
      flip: this.flip,
      choice: { kit: this.choice.kit, advantages: [...this.choice.advantages] },
      log: [...this.log],
      feed: structuredClone(this.feed),
      steps: this.steps,
      endingAnnounced: this.endingAnnounced,
    };
  }

  /**
   * **读档** —— 从快照重建一个会话。
   *
   * ⚠️ 两条随机流必须**回到存档时的游标**，否则"读档之后的世界"与"没退出之前的世界"
   *    会走出两条不同轨迹 —— 那不叫读档，那叫重开。
   * ⚠️ 不重放、不补算：账本整份照搬。**读档的那一刻状态就完全等于存的那一刻**
   *    （唯一会不同的是后续 LLM 的措辞 —— 那是采样，本来就不保证可复现）。
   */
  static restore(snap: SessionSnapshot, brain: Brain): Session {
    if (snap.v !== SNAPSHOT_VERSION) {
      throw new Error(`存档快照版本不符：档里是 v${snap.v}，代码要 v${SNAPSHOT_VERSION}`);
    }
    const rng = makeRng(snap.seed, snap.rngState);
    const pRng = prologueRng(snap.seed, snap.pRngState);
    // ── 读档自愈（2026-10-08）：携带不变式「在某人身上 = holder 指向他 ＋ 他的 items 含它」──
    //    批次落地修复（apply.ts·commitBatch 的双向对齐）之前落账的旧档带着这些脏形态：
    //    · 物品 holder 落成**空串**（而非 null）⇒ 手牌区 / 成果池的严格比较全不认它（隐形）；
    //    · 只写了一边（holder 或 items）⇒ 另一边悬空 —— 最坑的是「items 有它、holder 是空」：
    //      卡面画着词条、详情页槽里摆着它，**却拖不回手牌区**（`canDropOn` 把无 holder 的当手牌物拒收）。
    //    ⚠️ 以物品的 holder 为主事实（与 commitBatch 同一条纪律）：能对齐就对齐，
    //      对不齐（人不存在 / 携带位满 / 引用悬空）一律放回手牌区或清掉引用 —— 不静默留脏。
    const ledger = structuredClone(snap.ledger);
    // ⚠️ 2026-10-08（用户第 5 条）：旧档没有 `difficulty` 键（strip-only 不校验、缺键不报错）
    //    ⇒ 读作 0（"还没选"）。`renderStaticHead` 对 0 一律按 1 档渲染 —— 旧档的叙事
    //    风味与改版前一致，不会炸、也不会悄悄换口味。
    if (ledger.difficulty === undefined || ledger.difficulty === null) ledger.difficulty = 0;
    // ⚠️ 2026-10-08（用户第 6 条）：旧档的凭证没有 `rarity` 键 ⇒ 读档时补「普通」——
    //    与 difficulty 同一条自愈纪律：新键只在读档处归一一次，渲染层不再各判各的。
    for (const v of ledger.vouchers) {
      if (v.rarity === undefined || v.rarity === null) v.rarity = '普通';
    }
    for (const it of ledger.entities.items) {
      if (it.holder === '') it.holder = null;
      if (it.holder === null) continue;
      const who = ledger.entities.people.find((p) => p.id === it.holder);
      if (!who) {
        it.holder = null;
        continue;
      }
      if (!who.items.includes(it.id)) {
        if (who.items.length >= CARRY_CAP) {
          it.holder = null;
          continue;
        }
        who.items.push(it.id);
      }
    }
    for (const p of ledger.entities.people) {
      p.items = p.items.filter((id) => {
        const it = ledger.entities.items.find((x) => x.id === id);
        return !!it && it.holder === p.id;
      });
    }
    const s = new Session(snap.seed, rng, brain, ledger, pRng);
    s.flip = snap.flip;
    // ⚠️ 优先用快照里那一份（"选好了还没开局就退出"的场合）⇒ 旧存档没这个键时
    //    **保留构造函数从账本回填的那份**（开局过了就从账本取，没开局就是默认值）。
    if (snap.choice) s.choice = { kit: snap.choice.kit, advantages: [...snap.choice.advantages] };
    s.log = [...snap.log];
    s.feed = structuredClone(snap.feed);
    s.steps = snap.steps;
    s.endingAnnounced = snap.endingAnnounced;
    return s;
  }

  /**
   * **直接结算** —— 玩家主动放弃这一局，**按 HP 归 0 算**。
   *
   * ⚠️ 刻意**不新造结局口径**：`hp ≤ 0` 本来就是总表**第 1 行**「陨命」的触发条件
   *    （`rules/ending.ts·instantEndingOf`）⇒ 把 HP 打到 0、交给**同一个** `adopt`
   *    （它内部就是 `terminateIfOver`），得到的就是规则层认定的那个结局。
   *    自己另写一句"玩家放弃了"的话术，会造出**第二套真相**。
   * ⚠️ 中途暴毙（总表 1~4）**没有放格子这一步** ⇒ `enterEnding` 的默认空三格正是对的。
   * ⚠️ 直接改 HP 而**不走 `applyDelta`** 是**有意**的：这不是一次"世界里发生的事"，
   *    而是玩家在**操作层面**结束本局 ⇒ 它不该产生 Delta、不该被闸门拦、不该耗行动点。
   *    改动只落在那个**用完即弃的克隆**上。
   */
  abandon(): ActionResult {
    const g = this.guard();
    if (g) return g;
    const l = structuredClone(this.ledger);
    player(l).hp = 0;
    this.adopt(this.probe(), l, ['玩家选择「直接结算」⇒ HP 归 0（按中途暴毙那条判）']);
    const e = this.ledger.ending;
    if (!e) {
      return {
        ok: false,
        error: '这一步走不下去了 —— 局面没能收住。读档再来一次就好。',
        notice: '',
        // ⚠️ 开发线索走 `log`（上帝视角「系统日志」），**不进玩家面**（2026-09-24 · §2.10）
        log: ['⚠️ 不变量没成立：`abandon()` 把 HP 置 0 之后 `settleEnding` 没判出结局 —— 查《契约.md》结局总表第 1 行（HP ≤ 0）是否仍挂着。'],
        ended: false,
      };
    }
    return {
      ok: true,
      error: '',
      notice: endingText(e),
      log: [`★ 终局：${e.name}（直接结算 · HP 归 0 · 总表第 ${e.row} 行）`],
      ended: true,
    };
  }

  // ── 内部：日志 / 播报 / 换账本 ────────────────────────────────

  note(lines: readonly string[]): void {
    for (const x of lines) {
      if (x !== '') this.log.push(x);
    }
    if (this.log.length > LOG_KEEP) this.log = this.log.slice(-LOG_KEEP);
  }

  trimFeed(): void {
    if (this.feed.length > FEED_KEEP) this.feed = this.feed.slice(-FEED_KEEP);
  }

  /**
   * 章节占卜里**玩家可见**的那一半 —— 只有氛围进播报（欲念变化一个字都不给它）。
   *
   * ⚠️ 用户 2026-09-22 的分层要求：一次占卜产出两样东西，**性质不同** ——
   *    · `章节氛围` → **玩家可见**；
   *    · `章节欲念变化` / 命中了哪张牌 / 走查表还是模型 → **只进 `log`**（开发者看的）。
   *    ⇒ 这也正是 `turn/chapter-shift.ts` 只把 `ambience` 交出来的原因；
   *      欲念在界面上本来就是「无仪表提示」，连数值都不给玩家看。
   */
  announceDivination(d: { ambience: string } | null): void {
    if (!d || d.ambience.trim() === '') return;
    this.feed.push({
      day: this.ledger.clock.day,
      kind: '占卜',
      title: `第 ${this.ledger.clock.chapter} 章`,
      text: d.ambience,
      eventId: '',
    });
    this.trimFeed();
  }

  /**
   * 动作**之前**：把当前「揭晓待办」的那几句 `pending.narration` 扣在手里。
   * ⚠️ 扣在手里 ≠ 给玩家看：见 `adopt()` —— 只有"已经不是「揭晓待办」"的那些才播报。
   */
  probe(): Map<string, string> {
    const m = new Map<string, string>();
    for (const e of this.ledger.events.live) {
      if (e.status !== '揭晓待办') continue;
      const p = this.ledger.pending.find((x) => x.eventId === e.id);
      if (p && p.narration) m.set(e.id, p.narration);
    }
    return m;
  }

  /** 动作**之后**：换账本 → 逐次检查 → 播报刚刚揭晓的话 → 终局播报 */
  adopt(pre: Map<string, string>, l: Ledger, lines: readonly string[] = []): void {
    const next = terminateIfOver(l) ?? l;
    for (const [id, text] of pre) {
      const ev = next.events.live.find((e) => e.id === id);
      if (!ev || ev.status === '揭晓待办') continue; // 还没到点 ⇒ 一个字都不许露
      if (text.trim() === '') continue;
      // ⚠️ 2026-10-07：揭晓时把排布时存下的那份骰**取走**（取走即删 —— 它是一次性的
      //   演出态，留在 Map 里会变成内存垃圾，还会在读档重开的另一局里张冠李戴）。
      const roll = this.rollByEvent.get(id);
      this.rollByEvent.delete(id);
      this.feed.push({
        day: next.clock.day,
        kind: '揭晓',
        title: ev.title,
        text: text.trim(),
        eventId: ev.id,
        ...(roll ? { roll } : {}),
      });
    }
    this.ledger = next;
    this.steps += 1;
    this.note(lines);
    if (next.ending && !this.endingAnnounced) {
      this.endingAnnounced = true;
      this.feed.push({ day: next.clock.day, kind: '终局', title: next.ending.name, text: endingText(next.ending), eventId: '' });
      this.note([`★ 终局：${next.ending.name}（第 ${next.ending.day} 天 · 总表第 ${next.ending.row} 行）`]);
    }
    this.trimFeed();
  }

  guard(): ActionResult | null {
    const e = this.ledger.ending;
    if (!e) return null;
    return {
      ok: false,
      error: `这一局已经结束（${e.name} · 第 ${e.day} 天）⇒ 要接着玩请重开一局`,
      notice: '',
      log: [],
      ended: true,
    };
  }

  // ── 动作 ────────────────────────────────────────────────────

  /**
   * **玩家选定欲望 ＋ 分配六维**（2026-10-05 用户裁定）—— **纯会话态，零 LLM、零落账**。
   *
   * ⚠️ **它只写 `this.choice`**：真正的落账在 `turn/opening.ts·applyPlayerChoice`，
   *    由 `clickPopup` 点到序幕末条那一次触发。
   *    ⇒ **为什么分两步**：① 模型必须先看得见"他挑了什么"才写得出人物描述
   *    （`renderOpeningUser` 的两块从账本读）；② 玩家点完到点末条之间可能反悔
   *    —— 存在会话上让他随便改，**落账只发生一次**。
   * ⚠️ **返回值只是给 UI 重绘用** —— 规则层此刻什么都没变。
   * ⚠️ 越界值在这里**就挡掉**（回一句人话 + 不改状态），而不是等 `applyPlayerChoice` 抛
   *    —— 那条抛是给"调用方漏了校验"兜底的，这条是给玩家看的。
   */
  pickDesire(kit: number, advantages: readonly string[]): ActionResult {
    const k = kitOf(kit);
    if (!k) {
      return {
        ok: false,
        error: `没有第 ${kit} 条欲望（只有 ${DESIRE_KITS.map((_, i) => i).join(' / ')}）`,
        notice: '',
        log: [],
        ended: false,
      };
    }
    const adv = [...new Set(advantages)].filter((a) => (ATTR_KEYS as readonly string[]).includes(a));
    if (adv.length > ATTR_ADV_MAX) {
      return {
        ok: false,
        error: `优势属性最多点 ${ATTR_ADV_MAX} 项（现在点了 ${adv.length} 项）`,
        notice: '',
        log: [],
        ended: false,
      };
    }
    this.choice = { kit, advantages: adv };
    const log = [
      `选定欲望【${k.label}】：宣言「${k.manifesto}」`,
      `判据：「${k.proposition}」`,
      `点亮优势：${adv.length === 0 ? '无（六项一样平庸）' : adv.join('、')}`,
    ];
    this.note(log);
    this.steps += 1;
    return { ok: true, error: '', notice: '', log, ended: false };
  }

  /**
   * **游戏难度（叙事风味）选择**（2026-10-08 用户第 5 条）—— 觉醒刚完成、第 1 天
   * 还没铺开的那一步（`/api/difficulty`）。落账 `ledger.difficulty`，喂
   * `renderStaticHead` 挑三档人设；与欲望选择同一条纪律：**一次性**、越界就挡（回人话）。
   * ⚠️ 纯会话态一次动作：零 LLM、零事件 —— 只写一个数。离线（fake brain）路径
   *    照样能走、字段照落账（假 brain 不读它）。
   */
  pickDifficulty(level: number): ActionResult {
    if (level !== 1 && level !== 2 && level !== 3) {
      return {
        ok: false,
        error: `没有第 ${level} 档难度（只有 1 / 2 / 3）`,
        notice: '',
        log: [],
        ended: false,
      };
    }
    this.ledger.difficulty = level;
    const log = [`选定游戏难度：第 ${level} 档（${['', '热情迎合', '规则偶尔纵容', '严肃真实'][level]}）`];
    this.note(log);
    this.steps += 1;
    return { ok: true, error: '', notice: '', log, ended: false };
  }

  /** 给 UI 读：5 条欲望原型（**静态数据**，不进账本） */
  static desireKits(): readonly DesireKit[] {
    return DESIRE_KITS;
  }

  /**
   * 档 A 点选。
   *
   * ⚠️ **规则侧仍然零 LLM / 零掷骰 / 零行动点**（`turn/popup.ts` 一个字都没改）——
   *    变成 `async` 只因为**序幕的编排**挂在了这里：点掉一条之后要"铺下一条 / 末条开局"，
   *    而末条开局是一次 LLM 调用（`opening`）。
   *    ⚠️ 为什么不把它挪到 `nextDay`：设计写的是"玩家点下按钮**即出牌**"
   *      —— 按钮就是那个触发点。
   *    ⚠️ 为什么不在 `Session` 里另写一遍"if 末条 then 翻牌"：那个判断住在
   *      `turn/prologue.ts·afterPrologueCard`（**唯一**编排入口）—— 本项目反复踩过
   *      "同一个口径两处实现、迟早各漂各的"。
   */
  async clickPopup(eventId: string, optionIndex = 0): Promise<ActionResult> {
    const g = this.guard();
    if (g) return g;
    // ⚠️⚠️ **2026-10-05 补的预检**：点序幕末条**之前**必须已经选好欲望。
    //    为什么必须挡在这里、而不是让 `applyPlayerChoice` 抛：
    //    它抛的时机在 ①（`choosePopup`）**之后** ⇒ 那一条已经被点掉、`已结算`
    //    ⇒ 玩家再点只会得到"这条已经结算过了"，**弹窗卡死**（2026-09-23 修过的那个症状，
    //    这里会以另一条路径复现）。⇒ 预检在 `choosePopup` **之前**，一个字节都不动。
    //    ⚠️ 判据是 `kit < 0`（＝"还没挑"，见构造函数那条注释），
    //    **不是** `kit !== 0` —— 后者会把"选了第 0 条"也拦掉。
    if (eventId === PROLOGUE_OPENING_ID && this.flip && this.choice.kit < 0) {
      const why = '先在上面挑一句你想要什么 —— 那句话会陪你走完这 28 天。';
      this.note([`⚠️ 末条被拦下：${why}`]);
      return { ok: false, error: why, notice: '', log: [`⚠️ 末条被拦下：${why}`], ended: false };
    }
    const r = choosePopup(this.ledger, eventId, optionIndex);
    if (r.rejected) {
      this.note(r.log);
      return { ok: false, error: r.rejected, notice: '', log: r.log, ended: false };
    }
    // ① 先落点选 —— 这一条**已经成立**，不该因为后面的翻牌失败被回滚掉
    this.adopt(this.probe(), r.ledger, r.log);
    if (r.option) {
      this.feed.push({ day: this.ledger.clock.day, kind: '弹窗', title: r.option.text, text: r.resultText, eventId });
      this.trimFeed();
    }
    // ② 再推进序幕：铺下一条 / 末条开局。非序幕 id ⇒ 零副作用、同一个账本引用。
    //    ⚠️ **失败不再往上抛**（2026-09-23 修 —— 这是"弹窗卡死"的真凶）。
    //      开局的落地层是**原子**的：`applyPlayerChoice` 已经落好了欲望与六维，
    //      而 `applyOpening`（写人物描述）失败时**只丢后半截**。
    //      此前那个异常一路穿到 `server.ts` 的兜底 catch ⇒ HTTP 500，而且
    //      **`autoSave()` 被跳过** —— 可账本**已经把这一条点掉了**（上面 ①，那是刻意
    //      "不回滚"的）。于是前端手里那份**旧信封**让弹窗原地不动，玩家再点一次只会得到
    //      "这条已经结算过了" ⇒ 表现为**卡死**（只能手工刷新）。
    //    ⚠️ **超长那一路已经不再拒了**（2026-09-23 用户裁定：超限照样落账 ＋ 标注，
    //      见 `turn/opening.ts` 顶栏 ② 档）—— 但这里的兜底**照样必须留着**：
    //      ①档（人物描述为空、账本没有玩家）与传输失败仍然会抛，
    //      而"卡死"的机制与诱发原因无关。
    //    ⇒ 这里接住它（`turn/opening.ts` 顶栏原话：「调用侧负责**接住**并留一条刺眼的日志」），
    //      换成一份 **ok:false 的结果**：前端拿到的是**新信封** ⇒ 弹窗能前进 ⇒ 至少看得见出了什么事。
    //    ⚠️ `driveOpening` 里已经有"同一副牌再要一次"——
    //      走到这里说明**两次都被拒**，是真失败了，不是抖动。**不静默补默认六维。**
    if (!this.flip && eventId === PROLOGUE_OPENING_ID) {
      this.note(['（`standIn:false` ⇒ 序幕末条不开局：六维留在占位全 5、欲望为空）']);
      return { ok: true, error: '', notice: r.resultText, log: r.log, ended: !!this.ledger.ending };
    }
    let nxt: { ledger: Ledger; log: string[] };
    try {
      nxt = await afterPrologueCard(this.ledger, eventId, this.brain, this.choice);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      const log = [
        `❌ 序幕编排失败：这一条（${eventId}）已经点掉，但它后面那一步没做成 —— ${why}`,
        '（账本停在"点掉了、没开局"：欲望与六维是空的。这是**看得见的错**，不是被吞掉的。）',
      ];
      this.note(log);
      return {
        ok: false,
        error: `「${r.option ? r.option.text : eventId}」之后那一步没做成：${why}`,
        notice: r.resultText,
        log,
        ended: !!this.ledger.ending,
      };
    }
    if (nxt.ledger !== this.ledger) this.adopt(this.probe(), nxt.ledger, nxt.log);
    return {
      ok: true,
      error: '',
      notice: r.resultText,
      log: [...r.log, ...nxt.log],
      ended: !!this.ledger.ending,
    };
  }

  /**
   * **「直接正式开始游戏」**（2026-10-08 用户裁定 · 序幕地图顶上那颗按钮）：
   * 跳过还没读的序幕事件，翻开末条「原初欲望的觉醒」。
   *
   * ⚠️ **同步、零 LLM**（它只裁 `events.live`：掐掉 day 0 的待处理档 A ＋ 铺末条）。
   * ⚠️ 判据全在 `turn/prologue.ts·skipToOpening`（唯一口径）：不是序幕 ⇒ 原样返回。
   * ⚠️ 走 `adopt` ⇒ `steps +1`、自动存档照常 —— 它是一次玩家的**决定**，不是纯渲染。
   */
  skipPrologueRest(): ActionResult {
    const g = this.guard();
    if (g) return g;
    const r = skipToOpening(this.ledger);
    if (r.ledger !== this.ledger) this.adopt(this.probe(), r.ledger, r.log);
    return { ok: true, error: '', notice: '', log: r.log, ended: !!this.ledger.ending };
  }

  /** 排布一条（派遣 / 玩家亲自 · 一次了结）—— 不推进时间，只扣下属容量 / 锁金币 */
  async arrange(input: HandleInput): Promise<ActionResult> {
    const g = this.guard();
    if (g) return g;
    // ⚠️ **目标必须还在「待处理」**（2026-09-20 补，`.workbuddy/probe-concurrent.py` 逼出来的）。
    //    闸门那 9 条**没有一条**问过"这条事件现在还能不能排"：它们只问时间 / 人 / 人数 / 金币 / 档 A。
    //    实测：对一条**已经排布**的事件再排一次，9 条全 pass、照样再掷一次骰、再调两次 LLM，
    //    并通过 `pending` 把**上一次的结果覆盖掉**（`steps` 涨 2、账本里只有 1 条）。
    //    它与并发**无关**：单发也复现 —— 在第二个标签页里点一下那个陈旧页面就够了
    //    （旧页面上的这张卡还写着「待处理」）。
    // ⚠️ 为什么这个守卫住在**会话层**、而不加进闸门：闸门是《规则.md》§四 A 那 **9 条**
    //    （`GateCode` 是个封闭联合），加第 10 条要动设计文档；而"请求体是**不可信输入**、
    //    按状态拒绝不合时宜的提交"本来就是本层的既有职责 —— 先例：
    //    `sceneSay` 查"当前有没有进行中的场景"、`dial` 查点数范围、`guard()` 查结局。
    const target = this.ledger.events.live.find((e) => e.id === input.eventId);
    // ⚠️ **认不出来的 id 也要报错**（2026-09-20 用户裁定「出现这种问题需要报错」）。
    //    在此之前这条请求会一路走到 `turn/handle.ts:157` 的 `throw new Error('事件 X 不存在')`，
    //    被 `server.ts` 的兜底 catch 变成 **HTTP 500** —— 玩家看到的是一句"服务器内部错误"，
    //    分不清"我点错了"还是"游戏坏了"；而它其实是**陈旧页面**（第二个标签页 / 浏览器后退）
    //    上那条早已了结或翻篇的事件。
    //    ⚠️ 它同族于下面那道状态守卫：都是"请求体是**不可信输入**、按账本现状拒绝" ——
    //      所以住在会话层，而不是往闸门里加判据（那要动《规则.md》§四 A 与 `GateCode`）。
    if (!target) {
      return {
        ok: false,
        error: `账本里没有「${input.eventId}」这件事 —— 页面大概是旧的（它已经了结或者翻篇了）⇒ 刷新一下再试`,
        notice: '',
        log: [],
        ended: false,
      };
    }
    if (target.status !== '待处理') {
      return {
        ok: false,
        // ⚠️ 2026-10-07 用户裁定：旧那句「（重复提交会把上一次的结果覆盖掉）」是**错的**
        //   —— 服务端根本不允许覆盖，谈不上"覆盖掉"；而且正常玩家根本不该走到这一步
        //   （前端对「处理中」的事件只给只读回看，✔ 都不出现）。话术照实说。
        error: `「${target.title}」已经排上或了结（现在是「${target.status}」）—— 不能再来一次`,
        notice: '',
        log: [],
        ended: false,
      };
    }
    // ⚠️ **派不出人也要报错**：`turn/handle.ts:160` 对"效参与者为空"是 `throw`，
    //    同样会变成 500。而这条连**故意构造**都不用 —— `server.ts·ids()` 对缺失 / 非数组
    //    的 `participants` 一律返回 `[]`（陈旧页面派不出去时就可能发出来）。
    //    ⚠️ 只拒"**一个都认不出来**"：账本上没有的个别 id 仍由 `handle.ts` 静默滤掉
    //      （那是既有行为，本次不动它）。
    if ((Array.isArray(input.participants) ? input.participants : []).filter((id) => !!findPerson(this.ledger, id)).length === 0) {
      return {
        ok: false,
        error: '这次排布里一个账本上的人都没有 —— 先挑一个派得出去的人再提交（页面上的人可能已经离场）',
        notice: '',
        log: [],
        ended: false,
      };
    }
    // ⚠️ **指定的物品必须在「这次去的人」身上**（2026-09-20 用户裁定「收窄到这次去的人身上带的」）。
    //    在此之前服务端**完全不校验它**：`usedItemId` 一路进 `prompt/blocks.ts:230`，
    //    塞一个不存在的 id 也只是渲染成「未知(it999)」（`probe-badinput.py` 那一族的同一个型）。
    //    ⚠️ 为什么这条也住在会话层：它与 UI 的选项源**是同一个口径**（`index.html·carrierPoolOf`），
    //      而闸门那 9 条是《规则.md》§四 A 的封闭清单 —— 加第 10 条要动设计文档。
    //    ⚠️ 口径**与 UI 逐字对齐**：池子 = 参与者的 `person.items` 去重；
    //       一个人都没勾时池子为空 ⇒ 任何 `usedItemId` 都被拒（而 UI 那时也只给「（不用物件）」）。
    if (input.usedItemId) {
      const who = (Array.isArray(input.participants) ? input.participants : []).filter((id) => !!findPerson(this.ledger, id));
      const carried = new Set<string>();
      for (const id of who) {
        const p = findPerson(this.ledger, id);
        for (const it of p ? p.items : []) carried.add(it);
      }
      if (!carried.has(input.usedItemId)) {
        return {
          ok: false,
          error: '这件东西不在这次去的人身上 —— 只有随行者带着的东西才能在这次派上用（页面上那格列的就是它）',
          notice: '',
          log: [],
          ended: false,
        };
      }
    }
    const pre = this.probe();
    const r = await handleEvent(this.ledger, input, this.rng, this.brain);
    if (r.blockedBy.length > 0) {
      this.note(r.log);
      return { ok: false, error: r.blockedBy.map((x) => x.reason).join('；'), notice: '', log: r.log, ended: false };
    }
    this.adopt(pre, r.ledger, r.log);
    // ⚠️ 2026-10-05：把这次投骰留下来给 UI 演出（判定盘那张骰面）。
    //    ⚠️ **每一次 handle 都覆盖它**（含不掷骰的那几种）⇒ 不掷骰时它是 `null`，
    //    浮层自然不画骰面 —— 不会残留"上一局的骰"。
    //    ⚠️ 只存**主事者 id ＋ 用到的属性**：名字在 UI 侧从 `people` 现查
    //    （此刻 `r.ledger` 已经被换掉了，回头取"当时的名字"已经取不到）。
    this.lastRoll = r.roll
      ? {
          tier: r.roll.tier,
          raw: r.roll.raw,
          adjusted: r.roll.adjusted,
          a: r.roll.a,
          diceRolls: [...r.roll.diceRolls],
          modifierTotal: r.roll.modifierTotal,
          endpoint: r.roll.endpoint,
          leaderId: r.roll.leaderId,
          attrs: [...(r.check.participants.length > 0 ? r.check.participants : target.hint_attr)],
        }
      : null;
    // ⚠️ 2026-10-07（用户裁定「先播骰子动画，再看结算结果」）：把这次投骰的**展示明细**
    //   存到「在路上的骰」，揭晓那一刻（`adopt`）随播报发给前端播动画。
    //   ⚠️ 只有真掷过骰才有得存 —— 免判定那几种 `r.roll` 为 `null`，揭晓时直接出结果。
    if (r.roll) {
      const keys: readonly AttrKey[] =
        r.check.participants.length > 0 ? r.check.participants : target.hint_attr;
      const leaderAfter = findPerson(r.ledger, r.roll.leaderId);
      const eff = leaderAfter ? effectiveAttrsOf(r.ledger, leaderAfter) : null;
      this.rollByEvent.set(input.eventId, {
        tier: r.roll.tier,
        raw: r.roll.raw,
        adjusted: r.roll.adjusted,
        a: r.roll.a,
        // ⚠️ 钳前均值就地重算一遍（`RollOutcome` 只带了钳后的 `a` 与溢出，
        //   没带均值本身；一行算术不值得为它改规则层的返回形状）
        mean:
          keys.length > 0 && eff
            ? Math.floor(keys.reduce((s, k) => s + (eff[k] ?? 0), 0) / keys.length)
            : r.roll.a,
        diceRolls: [...r.roll.diceRolls],
        modifierTotal: r.roll.modifierTotal,
        endpoint: r.roll.endpoint,
        leaderName: leaderAfter ? leaderAfter.name : '—',
        attrs: keys.map((k) => ({ attr: k, value: eff ? (eff[k] ?? 0) : 0 })),
        participants: input.participants
          .map((id) => findPerson(this.ledger, id))
          .filter((p): p is NonNullable<typeof p> => !!p)
          .map((p) => ({ id: p.id, name: p.name })),
      });
    }
    // ⚠️⚠️ 2026-10-07（用户报「结算的所有动画都不能正常显示了」）：**当场揭晓也要播报**。
    //   `cost ≤ 0` 的事件在 `handleEvent` 内部就走完了 `revealDue` —— 它们排布前是「待处理」，
    //   `probe()` 抓不到 ⇒ `adopt()` 的揭晓循环永远轮不到它们 ⇒ **结果一个字都没弹过**。
    //   ⇒ `handle.ts` 现在把当场揭晓的正文带出来（`revealedTexts`），这里补发「揭晓」播报
    //     （带骰 —— 排布时存的 `rollByEvent` 同样取走即删）。
    for (const { id, text } of r.revealedTexts) {
      const ev = this.ledger.events.live.find((e) => e.id === id);
      if (!ev) continue;
      const roll = this.rollByEvent.get(id);
      this.rollByEvent.delete(id);
      this.feed.push({
        day: this.ledger.clock.day,
        kind: '揭晓',
        title: ev.title,
        text,
        eventId: id,
        ...(roll ? { roll } : {}),
      });
    }
    if (r.revealedTexts.length > 0) this.trimFeed();
    return {
      ok: true,
      error: '',
      notice: r.tier ? `已经安排下去了 · ${r.intentSummary}（判定 ${r.tier}）` : '',
      log: r.log,
      ended: !!this.ledger.ending,
    };
  }

  /**
   * **玩家自建一件事**（「我想做点什么」· 《契约.md》§三「创建事件」）。
   *
   * ⚠️ **闸门走 `'handle'` 那一套**（与 `arrange` 同源）：9 条判据里真正会拦的只有
   *    ①（当天时间用尽）—— ⚠️ 2026-10-07 用户裁定「档 A 与常规事件同级」后，
   *      闸门 ④ 不再拦 `handle`（只拦换日）；其余判据因为"不派参与者"恒 pass。
   *    这正是《规则.md》:100 那句「**唯一的约束是它自己照常按档位消耗行动力**」的落点：
   *    自建**豁免额度**（条数 / `L` / 盈余），但豁免的**不含**"今天还有没有时间"。
   *    （判据只有一份 —— `rules/gates.ts`；UI 那颗按钮的置灰是**同一个判据的展示**，
   *     真正的拦截在这里。）
   * ⚠️ **它自己不扣时间**：扣时间的是将来处理这条事件那一步（`arrange` ⇒ `handleEvent`）。
   *    在这里扣 = "提一句就花掉 2 点"，与设计不符。
   * ⚠️ 结局已定 ⇒ `guard()` 先拦（与所有动作一样）。
   * ⚠️ **失败即抛 → 原样交给玩家看**（与 `opening` 那条"不静默降级"同一条纪律）：
   *    敲了一句话却什么都没发生，是**肉眼可见**的；悄悄补一条默认事件比这坏得多。
   */
  async createEvent(approach: string): Promise<ActionResult> {
    const g = this.guard();
    if (g) return g;
    const text = approach.trim();
    if (text === '') {
      return {
        ok: false,
        error: '得写一句你「打算怎么做」（空白连题目都算不上）',
        notice: '',
        log: [],
        ended: false,
      };
    }
    const stop = evalGates({ ledger: this.ledger, today: this.ledger.clock.day, action: 'handle' }).filter(
      (x) => !x.pass,
    );
    if (stop.length > 0) {
      this.note(stop.map((x) => `⛔ 闸门 ${x.code}：${x.reason}`));
      return { ok: false, error: stop.map((x) => x.reason).join('；'), notice: '', log: [], ended: false };
    }
    const pre = this.probe();
    let r: Awaited<ReturnType<typeof createUserEvent>>;
    try {
      r = await createUserEvent(this.ledger, text, this.brain);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.note([`⚠️ 自建失败：${msg}`]);
      return { ok: false, error: `自建失败：${msg}`, notice: '', log: [], ended: false };
    }
    this.adopt(pre, r.ledger, r.log);
    const made = r.created[0];
    return {
      ok: true,
      error: '',
      notice: made
        ? `你提出了一件事：「${made.title}」（处理要 ${made.cost} 点）`
        : '这句话没能变成一件能做的事 —— 换个说法再试',
      log: r.log,
      ended: !!this.ledger.ending,
    };
  }

  /** 拨时针（不跨天、无代价） */
  /**
   * **把东西交给某人 / 收回来**（2026-10-06 用户裁定：「能拖过去就能拖回来」）。
   *
   * ⚠️ **这条通路此前根本不存在** —— `loadTo` / `loadItems` 早就在
   *    `rules/gates.ts` 的闸门 ⑤ 里（`CARRY_CAP = 4` ＋ 持有者唯一），
   *    但 `loadItems` 在整个 `ui/` 里**零引用**（`卡槽与LLM分工.md` §1.2 原话：
   *    「判据在，但**生产路径无入口**」）。本方法就是那个入口。
   * ⚠️ **不调 `adopt`**：它会 `steps += 1` 并跑一次 `terminateIfOver` ——
   *    借一件东西**不是**一个时间动作，也不该推进任何进度或触发终局检查。
   *    借东西不掷骰、不调 LLM、不花时间（`卡槽与LLM分工.md` §1.1 的"结构性约束归系统"）。
   * ⚠️ **单写者**：`structuredClone` 隔一层再改，不就地改 `this.ledger`
   *    （那是全项目的硬约定，`snapshot()` 那条测试靠它）。
   * @param toWhom 交给谁（`npc000` = 装备到玩家自己身上；**`''` = 无人携带**（2026-10-08
   *   用户裁定：拖回手牌区 ＝ 摘下，不挂到任何人名下 —— 手牌区不占携带位））
   * @param itemIds 哪几件
   */
  async give(toWhom: string, itemIds: readonly string[]): Promise<ActionResult> {
    const g = this.guard();
    if (g) return g;
    const ids = itemIds.filter((x) => !!x);
    if (ids.length === 0) {
      return { ok: false, error: '没说要给哪一件', notice: '', log: [], ended: !!this.ledger.ending };
    }
    // ⚠️ 2026-10-08（无人携带）：`to === ''` ＝ 摘下回手牌区 —— 不找目标人、
    //    不过闸门 ⑤（手牌区没有携带位上限；`loadTo` 为空时 ⑤ 本来就整段跳过）。
    const who = toWhom === '' ? null : findPerson(this.ledger, toWhom);
    if (toWhom !== '' && !who) {
      return { ok: false, error: `账本上没有 ${toWhom} 这个人`, notice: '', log: [], ended: !!this.ledger.ending };
    }
    // ⚠️ 借出**必须先经过闸门 ⑤**（`CARRY_CAP` ＋ "已被他人持有"两条）——
    //    UI 侧的置灰是**同一个判据的展示**，真正的拦截在这里。
    // ⚠️ `evalGates(input)` 是**单参数**（内部从 `input.ledger` 取账本）——
    //    我第一版写成 `(ledger, {...})` 两个参数，它把 `input` 读成 undefined 就炸了
    //    （实测报 `Cannot read properties of undefined (reading 'clock')`）。
    //    ⚠️ ⑤ 那条闸门只读 `loadTo` / `loadItems`（**不看 `action`**），
    //    所以这里 `action` 填哪一个都不影响它 —— 用 `'handle'` 是因为
    //    「把东西交给他去办事」在语义上就是一次 `handle` 的准备动作。
    // ⚠️⚠️ **先把它从旧主名下摘出来，再判**（2026-10-06 实测踩到）：
    //    物品可能本来就在某人名下（开局直发那会儿是 `holder = npc000`；
    //    2026-10-08 起开局改 `holder = null`（无人携带），但**转移**（从我身上
    //    给别人）仍会撞上这句判据），而 ⑤ 那句判据是
    //    `it.holder && it.holder !== who.id ⇒「已被 X 持有」`
    //    ⇒ **原样判的话"从玩家交给属下"永远被自己拦死**（实测报「短匕首 已被 npc000 持有」）。
    //    这不是 ⑤ 判错了，是它假设「`loadItems` 里的东西本来不在任何人名下」——
    //    那个假设在**装填**语义下不成立（东西可能本来就有主）。
    //    ⇒ 判据用一份**摘过旧主的副本**；真账本在判通过之后才换（单写者）。
    const staged = structuredClone(this.ledger);
    for (const id of ids) {
      const it0 = staged.entities.items.find((x) => x.id === id);
      const old0 = staged.entities.people.find((p) => p.items.indexOf(id) >= 0);
      if (it0) it0.holder = null;              // 摘干净，让 ⑤ 只判"目标有没有满"
      if (old0) old0.items = old0.items.filter((x) => x !== id);
    }
    const gate = evalGates({
      ledger: staged,
      today: this.ledger.clock.day,
      action: 'handle',
      loadTo: toWhom,
      loadItems: ids,
    });
    const carry = gate.find((x) => x.code === 'CARRY_OR_HOLDER');
    if (carry && !carry.pass) {
      return { ok: false, error: carry.reason, notice: '', log: [], ended: !!this.ledger.ending };
    }
    const next = structuredClone(this.ledger);
    const lines: string[] = [];
    for (const id of ids) {
      const it = next.entities.items.find((x) => x.id === id);
      if (!it) continue;
      // 旧主：谁原来拿着（要把他那一栏里摘掉）
      const old = next.entities.people.find((p) => p.items.indexOf(id) >= 0);
      if (old) old.items = old.items.filter((x) => x !== id);
      if (toWhom === '') {
        // ⚠️ 2026-10-08（无人携带）：摘下 ＝ 不进任何人的 `items[]`，`holder=null`。
        //    口径与账本层"摘干净"（apply/give 暂存）一致 —— `null` 就是"没人拿着"。
        it.holder = null;
        lines.push(`${it.name} 回到手牌区（无人携带）`);
      } else if (toWhom !== PLAYER_ID) {
        const target = findPerson(next, toWhom);
        if (target) target.items = [...target.items, id];
        it.holder = toWhom;
        lines.push(`${who!.name} 带上 ${it.name}`);
      } else {
        // 玩家**也在 `entities.people` 里**（`npc000` 那一行）⇒ 装备到玩家身上
        // 就是"挂回 npc000 名下"。⚠️ 这是**主动装备**（拖到他那张卡上），
        // 与"拖回手牌区（无人携带）"是两个动作 —— 2026-10-08 起 UI 不再把
        // "收回"发成 to=npc000。
        const meP = findPerson(next, PLAYER_ID);
        if (meP) meP.items = [...meP.items, id];
        it.holder = toWhom;
        lines.push(`${it.name} 装备到 ${meP ? meP.name : '你'} 身上`);
      }
    }
    this.ledger = next;
    this.note(lines);
    // ⚠️ **不 `steps += 1`**：借东西不是一步棋。
    //    但 view 要能看到变化 ⇒ 那靠 `this.ledger` 换了就够（`probe()` 每次现读）。
    return {
      ok: true,
      error: '',
      notice: lines.join(' · '),
      log: lines,
      ended: !!this.ledger.ending,
    };
  }

  /**
   * **槽位排序**（2026-10-07 用户裁定：人物详情页四个物品卡槽支持拖动换位）。
   *
   * ⚠️ **为什么要有这个入口**：`effectiveItems` 已改为**纯槽位顺序**（前 2 件有加成的生效），
   *    槽位顺序 = `Person.items` 的数组顺序 ⇒ "调换左右顺序"就是在改账本字段 ——
   *    需要一条**只改顺序、不改归属**的写通路（`/api/give` 只会 push 到尾，调不出"挪到最前"）。
   * ⚠️ **校验两条**：名单必须是**现有携带物的同集重排**（多一件少一件都不收）；
   *    目标人物必须是自己或已入队（与 `/api/give` 闸门 ⑤ 的对象口径一致）。
   * ⚠️ **与 `give` 同一档的动作**：不掷骰、不调 LLM、不花时间、不 `steps += 1`。
   *
   * @param who   哪个人的槽位（`npc000` = 玩家自己）
   * @param order 排好序的物品 id（**全量** —— 4 格从左到右）
   */
  reorderItems(who: string, order: readonly string[]): ActionResult {
    const g = this.guard();
    if (g) return g;
    const p = findPerson(this.ledger, who);
    if (!p) return { ok: false, error: `账本上没有 ${who} 这个人`, notice: '', log: [], ended: !!this.ledger.ending };
    if (!p.affiliated && who !== PLAYER_ID) {
      return { ok: false, error: `${p.name} 还没入队，他的槽位调不动`, notice: '', log: [], ended: !!this.ledger.ending };
    }
    const cur = [...p.items];
    const sameSet =
      order.length === cur.length &&
      [...order].sort().join('\u0000') === [...cur].sort().join('\u0000');
    if (!sameSet) {
      return { ok: false, error: '排序名单与现有携带物不一致（只许重排，不许增删）', notice: '', log: [], ended: !!this.ledger.ending };
    }
    // ⚠️ 单写者：克隆一层再换（`snapshot()` 那条测试靠这个纪律）
    const next = structuredClone(this.ledger);
    const np = findPerson(next, who)!;
    np.items = [...order];
    this.ledger = next;
    const line = `${p.name} 的携带顺序调整为 ${order.length} 件（第 1 格：${
      next.entities.items.find((i) => i.id === order[0])?.name ?? '空'
    }）`;
    this.note([line]);
    return { ok: true, error: '', notice: line, log: [line], ended: !!this.ledger.ending };
  }

  async dial(n: number): Promise<ActionResult> {
    const g = this.guard();
    if (g) return g;
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, error: `拨时针要一个 ≥ 1 的整数（收到 ${n}）`, notice: '', log: [], ended: false };
    }
    const left = remainingToday(this.ledger);
    if (n > left) {
      return { ok: false, error: `当天只剩 ${left} 点 ⇒ 拨不出 ${n} 点（想跨天请点「进下一天」）`, notice: '', log: [], ended: false };
    }
    const pre = this.probe();
    // ⚠️ 拨时针**按设计不跨天**（`dialRange` 把粒度限在当天剩余之内）⇒ 这里 `divination` 恒为 null。
    //    种子照传：万一以后粒度放宽，「占卜抽什么牌」不该跟着漂。
    const r = await dial(this.ledger, n, this.rng, this.brain, this.seed);
    this.adopt(pre, r.ledger, r.log);
    this.announceDivination(r.divination);
    return { ok: true, error: '', notice: `时间走了 ${n} 点`, log: r.log, ended: !!this.ledger.ending };
  }

  /** 进下一天（时间用尽后唯一的出路；序幕里 = "开始正式的第一天"） */
  async nextDay(): Promise<ActionResult> {
    const g = this.guard();
    if (g) return g;

    // ⚠️ **"进下一天"要过闸门 ④**（2026-09-19 序幕落地时补的这一处）。
    //    闸门里那条 `POPUP_PENDING` 的判据**本来就含 `advanceDay`**（`rules/gates.ts`），
    //    但在此之前**没有任何调用侧问过它** —— 那个 `applies` 分支只活在单测里。
    //    后果在序幕上是致命的：10 条档 A 还没读，玩家一按「进下一天」就把整个展示期跳过去了。
    //    ⇒ 这里补上"当天入口"的那一次问（与 `arrange` / `restore` 走的是同一份 9 条判据）。
    const stop = evalGates({ ledger: this.ledger, today: this.ledger.clock.day, action: 'advanceDay' }).filter(
      (x) => !x.pass,
    );
    if (stop.length > 0) {
      this.note(stop.map((x) => `⛔ 闸门 ${x.code}：${x.reason}`));
      return { ok: false, error: stop.map((x) => x.reason).join('；'), notice: '', log: [], ended: false };
    }

    if (isFinalDay(this.ledger)) {
      return {
        ok: false,
        error: `已经是第 ${TOTAL_DAYS} 天 ⇒ 「进下一天」不再推进 —— 该放格子了`,
        notice: '',
        log: [],
        ended: false,
      };
    }

    // ── 序幕 → 第 1 天 ────────────────────────────────────────────
    // ⚠️ 这条路**不走 `pushTime`**：序幕没有时间预算（0 行动点），`remainingToday` 那个
    //    "4 − usedToday" 在这里毫无意义；真走了它，`toAbs(t) = day*4 + used` 会先在
    //    "第 0 天"里耗掉 4 点、再撞上跨日逻辑，一开局就是两套日界。
    //    ⇒ 它与驱动里那句 `turnOver(l); enterDay(...)` **逐字同构**（`turn/simulate.ts` 开场）。
    // ⚠️ 顺序：`turnOver`（翻日 · 周例钱 · 漂移 · 容量重置）→ `enterDay`（T0：过期 →
    //    重写命题 → 章节占卜 → 概要归并 → 生成）。序幕这 9 条固定概要此时**本来就在**
    //    `summaries.recent` 里（`day = 0`）⇒ 《契约.md》§5.7 ⓪ 那句"第 1 天 T0 并入"不需要
    //    一次搬运，它自己就并进去了。
    if (this.ledger.clock.day <= 0) {
      const l = structuredClone(this.ledger);
      const overLog = turnOver(l);
      const e = await enterDay(l, this.rng, this.brain, this.seed);
      // ⚠️⚠️ 2026-10-07 用户裁定：「占卜结果应当是**每天最先**出现的东西」⇒ 占卜播报
      //   必须排在 `adopt`（揭晓播报）**之前** —— feed 是按推送顺序弹的，反了玩家就要
      //   先看完一夜的揭晓（还要掷骰）才轮到占卜。
      this.announceDivination(e.divination);
      this.adopt(this.probe(), e.ledger, [...overLog, ...e.log]);
      return {
        ok: true,
        error: '',
        notice: `序幕结束 ⇒ 进入第 ${this.ledger.clock.day} 天（第 ${this.ledger.clock.chapter} 章）`,
        log: [...overLog, ...e.log],
        ended: !!this.ledger.ending,
      };
    }

    const pre = this.probe();
    const r = await nextDay(this.ledger, this.rng, this.brain, this.seed);
    // ⚠️⚠️ 2026-10-07 用户裁定：「占卜结果应当是**每天最先**出现的东西」——
    //   必须排在 `adopt`（揭晓播报）之前，理由见序幕→第 1 天那一条。
    this.announceDivination(r.divination);
    this.adopt(pre, r.ledger, r.log);
    return { ok: true, error: '', notice: `进入第 ${this.ledger.clock.day} 天`, log: r.log, ended: !!this.ledger.ending };
  }

  /** 进场景（档 B/C 的「穿越」·多轮）—— 不调 LLM、不推进时钟 */
  openScene(input: SceneOpenInput): ActionResult {
    const g = this.guard();
    if (g) return g;
    let r: ReturnType<typeof openScene>;
    try {
      r = openScene(this.ledger, input);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), notice: '', log: [], ended: false };
    }
    if (r.blockedBy.length > 0) {
      this.note(r.log);
      return { ok: false, error: r.blockedBy.map((x) => x.reason).join('；'), notice: '', log: r.log, ended: false };
    }
    this.adopt(this.probe(), r.ledger, r.log);
    return { ok: true, error: '', notice: `进入场景（第 0 轮 / 上限 ${r.cap}）`, log: r.log, ended: false };
  }

  /**
   * 场景里说一句。
   * ⚠️ **2026-10-07 用户裁定：场景内不做投掷判定** ⇒ 没有 `zone` 覆写、没有判定盘 ——
   *    危险区只对「简略处理」那条裁定/掷骰链生效（`turn/handle.ts`）。
   */
  async sceneSay(text: string, onNarrDelta?: (chunk: string, reset: boolean) => void): Promise<ActionResult> {
    const g = this.guard();
    if (g) return g;
    if (!this.ledger.scene) return { ok: false, error: '当前没有进行中的场景', notice: '', log: [], ended: false };
    // ⚠️ 2026-10-08 用户裁定：轮数用尽**只禁输入、不自动跳结算** —— 服务端先拒一步
    //    （前端已禁输入框；这道闸防的是绕过 UI 直接打接口）。
    if (this.ledger.scene.round >= SCENE_ROUND_CAP) {
      return { ok: false, error: `本场轮数已用尽（${SCENE_ROUND_CAP} 轮）—— 请点「结束对话」进行收尾结算`, notice: '', log: [], ended: false };
    }
    if (text.trim() === '') return { ok: false, error: '得说点什么（空话连裁定都过不了）', notice: '', log: [], ended: false };
    // ⚠️ 场景 id 要**在 `adopt` 之前**抓下来 —— 收场那一轮结束后 `ledger.scene` 会被清掉，
    //    而这两条播报都要挂到那条 C 档事件上（右栏按事件分区，见 `FeedItem.eventId`）。
    const sceneId = this.ledger.scene?.eventId ?? '';
    const pre = this.probe();
    // ⚠️ 2026-10-07 用户裁定：回应以流式呈现 ⇒ 增量回调原样透传（离线假 brain 忽略之）。
    const r = await sceneStep(this.ledger, text, this.rng, this.brain, onNarrDelta);
    this.adopt(pre, r.ledger, r.log);
    if (r.narration.trim() !== '') {
      this.feed.push({ day: this.ledger.clock.day, kind: '场景', title: `第 ${r.round} 轮`, text: r.narration, eventId: sceneId });
    }
    if (r.close) {
      this.feed.push({
        day: this.ledger.clock.day,
        kind: '收场',
        title: r.close.reason,
        text: r.close.summary || r.close.narration,
        eventId: sceneId,
      });
    }
    this.trimFeed();
    return { ok: true, error: '', notice: r.narration, log: r.log, ended: !!this.ledger.ending };
  }

  /** 主动退出场景（退出不是"什么都没发生"—— 这一场的 delta 已经逐轮落过账了） */
  async sceneLeave(): Promise<ActionResult> {
    const g = this.guard();
    if (g) return g;
    if (!this.ledger.scene) return { ok: false, error: '当前没有进行中的场景', notice: '', log: [], ended: false };
    // ⚠️ 同上：id 必须在 `adopt` 之前抢（退出之后 `ledger.scene` 就没了）。
    const sceneId = this.ledger.scene.eventId;
    const pre = this.probe();
    const r = await sceneLeave(this.ledger, this.rng, this.brain);
    this.adopt(pre, r.ledger, r.log);
    this.feed.push({
      day: this.ledger.clock.day,
      kind: '收场',
      title: r.reason,
      text: r.summary || r.narration,
      eventId: sceneId,
    });
    this.trimFeed();
    return { ok: true, error: '', notice: r.summary, log: r.log, ended: !!this.ledger.ending };
  }

  /**
   * 医馆 / 大神殿 —— **排布一单恢复**（2026-10-07 用户裁定：延迟生效）。
   * 提交即扣诊金、占被治疗者容量，并立一条「处理中」的功能事件；
   * 玩家拨时针到点（或进下一天）才回满 —— 与正常事件同一条「算 / 揭分离」。
   */
  async restore(place: RestorePlace, targets: readonly string[]): Promise<ActionResult> {
    const g = this.guard();
    if (g) return g;
    const pre = this.probe();
    const r = await restore(this.ledger, { place, targets: [...targets] }, this.rng, this.brain);
    if (r.rejected.length > 0) {
      this.note(r.log);
      return { ok: false, error: r.rejected.join('；'), notice: '', log: r.log, ended: false };
    }
    this.adopt(pre, r.ledger, r.log);
    return {
      ok: true,
      error: '',
      notice: `${place}：已安排（诊金 ${r.cost}）—— 拨时针到点生效`,
      log: r.log,
      ended: !!this.ledger.ending,
    };
  }

  /**
   * 终局：放格子 → 判定。
   *
   * ⚠️⚠️ 2026-10-06 清单第 4B 条（用户裁定第 16 条）：**`autoPlace` 兜底已删** ——
   *    「删掉」是用户对"按建议值"那颗按钮的原话，而服务端那个 `?? autoPlace(...)`
   *    与它是**同一个决定**：都是"玩家没放就替他填"。
   *    ⇒ 现在**必须显式传 `placements`**；不传 ＝ 拒，并说清为什么。
   *    ⚠️ **`turn/simulate.ts·autoPlace` 本体留着** —— `main.ts` 的 28 天驱动与
   *      `ending.test.ts` 靠它跑基线，删了 600 多条测试全断。
   */
  async finish(placements?: Placements): Promise<ActionResult> {
    const g = this.guard();
    if (g) return g;
    if (!isFinalDay(this.ledger)) {
      return {
        ok: false,
        error: `还没到第 ${TOTAL_DAYS} 天（现在是第 ${this.ledger.clock.day} 天）⇒ 放格子是终局的事`,
        notice: '',
        log: [],
        ended: false,
      };
    }
    if (!placements) {
      return {
        ok: false,
        error: '放格子没有带上 —— 「确定」必须显式提交三格（autoPlace 兜底已按裁定删除）',
        notice: '',
        log: [],
        ended: false,
      };
    }
    const p = placements;
    // ⚠️ **判定同步落账、话术随后补**：`ending` 只在**成功**结局时被调一次
    //    （七条失败结局是系统播预写话术、0 调用）⇒ 对失败结局 `writeEnding` 就是一次空操作。
    //    这样 `finish` 的手感与模拟器完全一致（同一份 `writeEnding`，UI 侧不再自己拼一遍）。
    const closed = closeGame(this.ledger, p);
    const w = await writeEnding(closed, this.brain);
    const l = w.ledger;
    this.adopt(
      this.probe(),
      l,
      [`放格子：成果 ${p.成果 ?? '（空）'} / 手段 ${p.手段 ?? '（空）'} / 共鸣 ${p.共鸣 ?? '（空）'} → 判定`, ...w.log],
    );
    const e = this.ledger.ending!;
    return { ok: true, error: '', notice: endingText(e), log: [`★ 终局：${e.name}`], ended: true };
  }

  // ── 视图 ────────────────────────────────────────────────────

  personOf(id: string): UiPerson {
    const l = this.ledger;
    const p = findPerson(l, id)!;
    return {
      id: p.id,
      name: p.name,
      basic: p.basic,
      identity: p.identity,
      desc: p.desc,
      race: p.race,
      hp: p.hp,
      san: p.san,
      status: derivePersonStatus(p),
      affiliated: p.affiliated,
      available: isAvailable(p, l, l.clock.day),
      // ⚠️ 口径：`carriedItems` 已滤掉 `consumed` 的物品（`rules/ability.ts`），
      //    所以"他带的那把刀已经用掉了"会自动体现在这里（加成消失）。
      itemBonuses: carriedItems(l, p)
        .flatMap((it) => it.attr_bonus ?? [])
        .map((b) => ({ attr: b.attr, bonus: b.bonus })),
      // ⚠️ 这两项**必须同源**：`itemBonuses` 是 `bonusesOf` 算的（已取前 2 件），
      //    `effectiveItemIds` 是 `effectiveItems`（同一个截断）—— 不许各算一份。
      effectiveItemIds: effectiveItems(l, p).map((it) => it.id),
      // ⚠️ 与 `gates.ts` 判属性门槛**同一个函数**（见上面类型上的说明）
      effectiveAttrs: effectiveAttrsOf(l, p),
      away: isAway(p.id, l, l.clock.day),
      // ⚠️ 2026-10-08 起 NPC 的容量 = `availableToday`（时间流速余额 × 今日已承诺 取小）：
      //    手牌区闲置者的行动力也随拨钟一起掉（用户裁定「拨的是所有人的时间」），
      //    已接的活在办期间占「今日已承诺」那份 —— 卡面数字与闸门 ② 同源。
      ap: availableToday(l, p, l.clock.day),
      attrs: { ...p.attrs },
      in_your_eyes: p.in_your_eyes,
      openness: p.openness,
      // ⚠️⚠️ 2026-10-07（用户报告"点开人物卡和折叠人物卡看到的物品不一样"）：
      //    **consumed 在 view 层就滤掉** —— 此前只靠各渲染点自己滤（手牌带滤了、
      //    卡面词条/`@n`/详情页四槽都没滤）⇒ 同一件消耗品"手牌上没了、卡面上还在"。
      //    ⇒ 口径只有一份：**`p.items` 进 view 时就是"身上真带着的"**，
      //      消耗品从人物身上消失后，词条、`@n`、卡槽、加成四处同时消失。
      items: p.items.map((i) => this.itemOf(i)).filter((x): x is UiItem => !!x && !x.consumed),
      recognized: [...p.recognized],
    };
  }

  itemOf(id: string): UiItem | null {
    const it = this.ledger.entities.items.find((x) => x.id === id);
    if (!it) return null;
    return {
      id: it.id,
      name: it.name,
      kind: it.kind,
      desc: it.desc,
      holder: it.holder,
      consumed: it.consumed,
      bonus: (it.attr_bonus ?? []).map((b) => `${b.attr ?? ''}+${b.bonus}${b.cond ? `（${b.cond}）` : ''}`),
    };
  }

  cardOf(e: GameEvent): UiCard {
    const l = this.ledger;
    return {
      id: e.id,
      title: e.title,
      content: e.content,
      stage: e.stage,
      location: e.location,
      tier: e.tier,
      status: e.status,
      dispatchable: e.dispatchable,
      requiredPerson: (() => {
        if (!e.required_person) return null;
        const p = l.entities.people.find((x) => x.id === e.required_person);
        return { id: e.required_person, name: p ? p.name : e.required_person };
      })(),
      cost: e.cost,
      min_gold: e.min_gold,
      min_people: e.min_people,
      max_people: e.max_people,
      deadline: e.deadline,
      hint_attr: [...e.hint_attr],
      difficulty: e.difficulty,
      created_day: e.created_day,
      handler: e.handler,
      handlerName: e.handler ? (findPerson(l, e.handler)?.name ?? e.handler) : null,
      participants: [...e.participants],
      // ⚠️ **只给 `text`**：`result_text` 是"选了之后才知道"的东西 —— 提前推到 UI 就是剧透
      options: e.options.map((o) => ({ text: o.text })),
      reveal_at: e.reveal_at ? { ...e.reveal_at } : null,
      expiresOn: e.tier === 'A' ? null : e.created_day + e.deadline,
      goldLocked: e.gold_locked,
    };
  }

  /**
   * 一次重绘要的全部东西。
   * ⚠️ **绝不含 `pending` 的任何内容**（`narration` / `delta` / `summary`）：
   *    「揭晓待办」那几条只给**牌面**（标题 / 地点 / 内容 / 什么时候揭晓）——
   *    这与玩家在真实界面里看到的一致，也是 `INJECT_NEVER` 那条纪律在 UI 侧的落点。
   */
  view(): UiView {
    const l = this.ledger;
    const live = l.events.live;
    const popups = live.filter((e) => e.tier === 'A' && e.status === '待处理').map((e) => this.cardOf(e));
    const todo = live
      .filter((e) => e.tier !== 'A' && e.status === '待处理')
      .sort((a, b) => a.created_day - b.created_day || (a.id < b.id ? -1 : 1))
      .map((e) => this.cardOf(e));
    const waiting = live.filter((e) => e.status === '揭晓待办').map((e) => this.cardOf(e));
    const settled = live
      .filter((e) => e.status === '已结算')
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((e) => this.cardOf(e));

    // ⚠️ `gatesOf` 恒返回 10 条 = **9 条真闸门 ＋ 末条「当前状态」快照行**（P5-B 起）。
    //    切法只写在这一处；UI 侧别按 `code` 去猜 —— 快照行的 code 与闸门 ① **同名**。
    const gateAll = gatesOf(l, l.clock.day);
    const gateRows = gateAll.slice(0, gateAll.length - 1);
    const statusLine = gateAll[gateAll.length - 1];

    const sc = l.scene;
    const scene: UiScene | null = sc
      ? {
          eventId: sc.eventId,
          title: live.find((e) => e.id === sc.eventId)?.title ?? sc.eventId,
          round: sc.round,
          cap: SCENE_ROUND_CAP,
          present: sc.present.map((id) => ({ id, name: findPerson(l, id)?.name ?? id })),
          turns: [...sc.turns],
          ledgered: [...sc.ledgered],
          spent: sc.spent,
          goldLocked: live.find((e) => e.id === sc.eventId)?.gold_locked ?? 0,
          lastTier: sc.lastTier,
        }
      : null;

    return {
      seed: this.seed,
      steps: this.steps,
      day: l.clock.day,
      totalDays: TOTAL_DAYS,
      chapter: chapterOf(l.clock.day),
      phase: phaseOf(l.clock.day),
      daypart: daypartOf(l.clock.usedToday),
      usedToday: l.clock.usedToday,
      apTotal: BASE_ACTION_POINTS,
      remaining: remainingToday(l),
      // ⚠️⚠️ 2026-10-07 清单第 9.1 条（补核）：**拨时针的合法区间** `[min, max]`。
      //   用户原话：「若有任何正在处理的事件，设它们消耗的行动力集合为 A，A 中最小数为 x，
      //   玩家只能拨动 **[1, min(当前剩余的行动力, x)]** 之间的点数（该区间可能为空），
      //   其余按键变灰不可选中」。
      //   ⚠️ 规则层**早就写好了**（`rules/clock.ts·dialRange` ＋ `pendingCosts`），
      //      缺的只是"没有透到 view"⇒ 页脚那四颗按钮一直按"当天剩余"画，没读它。
      //   ⚠️ **UI 只读这个数，不自己算** —— 否则按钮的灰与服务端对拨点的判会两处漂。
      dial: dialRange(l),
      isFinalDay: isFinalDay(l),
      isOver: !!l.ending,
      gold: l.scalars.gold,
      rep: { ...l.scalars.rep },
      desire: {
        value: l.desire.value,
        // ⚠️ 区间与读数都在**这里**算好（规则层函数），UI 不许自己按数值分段
        band: desireBandOf(l.desire.value),
        bandNote: DESIRE_BAND_NOTE[desireBandOf(l.desire.value)],
        proposition: l.desire.proposition,
        // ⚠️ `?? ''`：旧存档没有 `manifesto` / `means` / `advantages` 这几个键（strip-only 不报错）
        means: l.desire.means ?? '',
        manifesto: l.desire.manifesto ?? '',
        kit: l.desire.kit ?? 0,
      },
      ambience: l.divination?.ambition ?? null,
      divCards: l.divination?.cards ?? null,
      // ⚠️ 只看 live 里**第一条待处理**（2026-10-08 平铺后"当前在读"不再唯一）——
      //    它是 `needsChoice`（站在末条上）的判据，也是"还剩几条"的唯一来源
      //    （`prologuePending` 与它同源同一条判据）。`openingLaid` 给 UI 的
      //    「直接正式开始游戏」按钮用：末条出现 ⇒ 按钮消失（用户裁定）。
      prologue: (() => {
        const pc = currentPrologueCard(l);
        return pc
          ? {
              seq: pc.seq,
              total: PROLOGUE_TOTAL,
              day: pc.day,
              remaining: prologuePending(l),
              openingLaid: l.events.live.some((e) => e.id === PROLOGUE_OPENING_ID),
            }
          : null;
      })(),
      // ⚠️ **2026-10-05**：欲望选择的输入口。
      //    `needsChoice` 的判据是「**正站在末条上**」—— 用 `currentPrologueCard` 的 `seq`
      //    （`PROLOGUE_MAX_SEQ`）而不是"账本里欲望还空着"：后者在**读档回来**时会一直为真，
      //    于是选择面板在正文里也弹出来（那是"没开局过"的账本，不是"该选了"的那一刻）。
      //    ⚠️ 2026-10-07：判据必须用**最大 seq（10）**而不是条数（9）—— 删掉原第 5 条后
      //      两者不相等，用条数会让"站在末条上"永远判不中（实测：欲望选择面板不再弹）。
      desirePick: {
        // ⚠️ 牌已从这一侧删干净（2026-10-05）⇒ 一个原型只有**三样**东西：标签 / 宣言 / 判据。
        kits: Session.desireKits().map((k, i) => ({
          index: i,
          label: k.label,
          manifesto: k.manifesto,
          means: k.means,
          proposition: k.proposition,
        })),
        choice: { kit: this.choice.kit, advantages: [...this.choice.advantages] },
        needsChoice: (() => {
          const pc = currentPrologueCard(l);
          return pc !== null && pc.seq === PROLOGUE_MAX_SEQ && l.desire.manifesto === '';
        })(),
      },
      me: this.personOf(PLAYER_ID),
      people: l.entities.people.filter((p) => p.id !== PLAYER_ID).map((p) => this.personOf(p.id)),
      items: l.entities.items.map((i) => this.itemOf(i.id)!).filter((x) => !!x),
      popups,
      todo,
      waiting,
      settled,
      hiddenCount: l.events.hidden.length,
      scene,
      sceneCap: SCENE_ROUND_CAP,
      gates: gateRows.map((g) => ({ ...g, lane: GATE_LANE[g.code] })),
      statusLine,
      zone: dangerZoneOf(l.desire.value),
      vouchers: vouchersOf(l),
      placementPools: placementPools(l),
      ending: l.ending ? { ...l.ending, placements: { ...l.ending.placements } } : null,
      recentSummaries: l.summaries.recent.map((s) => ({ ...s })),
      archive: [...l.summaries.archive],
      // ⚠️ `source` 要一起给：`[硬]`（硬种子 · 必出）与软钩子在**上帝视角**里必须能分辨 ——
      //    这正是 `prompt/blocks.ts·dispatchBlock` 加 `[硬]` 前缀的同一个理由
      seeds: l.seeds.map((s) => ({ code: s.code, title: s.title, source: s.source })),
      // ⚠️ 2026-10-05：判定盘那张骰面要用的数据（详见 `View.roll` 的口径说明）。
      //    名字在**此刻**现查（`l` 还是这一局的账本）；`attrs` 在 `arrange` 那一刻已快照。
      roll: this.lastRoll
        ? {
            tier: this.lastRoll.tier,
            raw: this.lastRoll.raw,
            adjusted: this.lastRoll.adjusted,
            a: this.lastRoll.a,
            diceRolls: [...this.lastRoll.diceRolls],
            modifierTotal: this.lastRoll.modifierTotal,
            endpoint: this.lastRoll.endpoint,
            leaderName: this.lastRoll.leaderId === PLAYER_ID
              ? '你'
              : (l.entities.people.find((p) => p.id === this.lastRoll!.leaderId)?.name ?? '—'),
            attrs: [...this.lastRoll.attrs],
          }
        : null,
    };
  }
}

export { PLAYER_ID, player };
