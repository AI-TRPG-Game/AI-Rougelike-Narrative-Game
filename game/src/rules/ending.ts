// 结局判定与话术
//
// ⚠️ **判定全在规则层**：条件、优先级、话术的取用都由系统定。
//    LLM 只在**成功结局**时写一段话术（`ending` · 全局至多 1 次）；
//    **七条失败结局系统直接播预写话术、0 调用**。
//
// ⚠️ 本模块是**纯函数 ＋ 常量**（不碰账本、无副作用）—— 写账本那一步在 `turn/ending.ts`。
//    与 `rules/clock.ts` / `turn/time.ts` 的分工同族。
//
// ⚠️ **判定顺序 = 总表从上到下，先命中先结束**：
//    1~4 在**每一次结算之后**查（命中即终结，不进第 28 天）；5~7 ＋ 成功只在第 28 天放完格子后查。
//    ⚠️ 2026-10-06 用户裁定后：`成果格空` **不再判失败**（那把钥匙撤了）
//    ⇒ 优先级现在只剩一条：欲念低于窗口 ⇒ 走 ⑤（见 `finalEndingOf`）。
import type { Ledger, Placements } from '../ledger/types.ts';
import { PLAYER_ID } from '../ledger/types.ts';
import { TOTAL_DAYS } from './clock.ts';
import { DESIRE_MAX, DESIRE_MIN } from './desire.ts';

// ── 两把钥匙 ────────────────────────────────────────────────
//
// ⚠️⚠️ 2026-10-06 用户裁定（改）：「**欲念值只有门槛作用**」
//   ⇒ **钥匙一（成果格必须非空）已撤掉**；现在**只有一把钥匙**：
//     终局欲念 ∈ [70, 80] —— **规则层硬数值**（`DESIRE_WINDOW_MIN/MAX`）。
//   ⚠️ 原来这里是"两把钥匙"（成果格 ≥1 件成果凭证 ＋ 欲念窗口 [75,80]），
//     失败文案里有专门一行写"成果格空"（总表第 7 行）。
//   ⚠️ 「正当的手段」与「他者的共鸣」**不参与通关**（用户 2026-10-06 原话：
//     「不决定【结局为失败还是成功】」）—— 它们决定的是成功结局的**标题与判词调子**
//     （`flavorOf` 的**两档**）。

// ⚠️⚠️ 2026-10-06 用户裁定：「**欲念值只有门槛作用，门槛放宽到 70-80**」
//   ⇒ `MIN` 由 75 放宽到 **70**。
//   ⚠️ **这个窗口是"成功"的唯一门槛**（下面 `finalEndingOf` 里那把"成果格钥匙"
//     已按裁定去掉）⇒ 28 天结束时欲念落在 [70,80] 之外 ⇒ 失败结局。
export const DESIRE_WINDOW_MIN = 70;
export const DESIRE_WINDOW_MAX = 80;

// ── `ending` 产物的长度（唯一拷贝）─────────────────────────────
//
// ⚠️ 这三个数**只有这一份**：`schema/ending.ts` 的字段说明、`prompt/instructions.ts` 的
//    `INSTRUCTION_ENDING` 正文、`turn/ending.ts·applyEnding` 的校验一律从这里读 ——
//    本项目已经踩过"同一个数两处各写一个"的亏（`deadline` 挡位 / `FREE_EVENT_CAP` /
//    `archive` 那四个阈值）。
// ⚠️ **服务端对模型输出完全不校验**（Phase 0 §三：`minLength` / `maxLength` 一概穿透）
//    ⇒「话术 100~200 字」**没有任何一层替我们兜**，只能由 `applyEnding` 兜。
// ⚠️⚠️ **2026-10-06 用户裁定**：
//   · **`结局标题` 字段整个删掉** —— 标题改由规则层给（`FLAVOR_NAMES` 两档），
//     模型只写**一段纯文本**（用户原话：「LLM 只需要输出结局纯文本」）。
//   · 话术长度从 **150~300** 改成 **100~200**。
//   ⇒ `ENDING_TITLE_MAX` **已删除**，谁再引用它就是没跟上这次裁定。

/** 结局话术下限（用户裁定 100~200 字） */
export const ENDING_TEXT_MIN = 100;
/** 结局话术上限（用户裁定 100~200 字） */
export const ENDING_TEXT_MAX = 200;

// ── 成功结局的两档（2026-10-06 用户裁定：四档收敛成两档）──
//
// ⚠️⚠️ **原来是四档**（`FLAVORS = ['A','B','C','D']`），按"手段 / 共鸣各有没有放下"
//    分四种组合。用户裁定收成**两档**：
//      · **两个都不缺**（手段有 ＋ 共鸣有）⇒「**得偿所愿**」
//      · **缺任何一个**（含**两个都缺**）⇒「**差一步美满**」
//    ⇒ 原来的 B（有手段无共鸣）与 C（无手段有共鸣）**合并成同一档**。
//
// ⚠️ **成败判定与这一维无关**（用户原话：「正当的手段和他者的共鸣
//    **不决定**【结局为失败还是成功】」）—— 成功**只看欲念 ∈ [70,80]**。
//    这一维决定的是**标题** ＋ **注入给 LLM 的风味段**（＝判词的调子）。
//
// ⚠️ **标题由规则层定，LLM 改不了**（2026-10-06）：`EndingResult.title` 现在恒为
//    这两个常量之一；`turn/ending.ts·applyEnding` 不再接受模型给的标题
//    （那个字段已从 schema 删掉）。
export const FLAVORS = ['A', 'B'] as const;
export type EndingFlavor = (typeof FLAVORS)[number];

/** 风味名 ＝ **结局标题**（成功那一路）。两档。 */
export const FLAVOR_NAMES: Record<EndingFlavor, string> = {
  A: '得偿所愿',
  B: '差一步美满',
};

/**
 * 两档判据 —— **纯函数**，只看「正当的手段」与「他者的共鸣」两格。
 *
 * ⚠️ **它不参与通关**（成败只看欲念窗口，见 `finalEndingOf`）——
 *    它决定的是**这一局的标题** ＋ **给 LLM 的风味段**。
 * ⚠️ 「缺任何一个」**包含两个都缺**（用户原话：「缺任何一个（包括都缺）」）。
 */
export function flavorOf(p: Placements): EndingFlavor {
  return p.手段 !== null && p.共鸣 !== null ? 'A' : 'B';
}

// ── 判定结果 ────────────────────────────────────────────────

export interface EndingResult {
  /** 总表那一列的结局名：陨命 / 疯癫 / 迷失 / 沉溺 / 未竟 / 空手 / 四种风味名 */
  name: string;
  /**
   * **这一局的标题** —— 与 `name` 分工不同：`name` 是《结局总表》那一列的
   * **分类名**，`title` 是**这一局**的收束名字。
   *
   * ⚠️⚠️ **2026-10-06 用户裁定：标题不再由 LLM 给。**
   *   · **成功结局** ⇒ 恒为 `FLAVOR_NAMES[flavor]`（**两档**：得偿所愿 / 差一步美满），
   *     判完那一刻就有值（`finalEndingOf` 里写定），**不需要等 `ending` 侧链**。
   *   · **失败结局** ⇒ 恒为 `null`（它的话术小标题在 `FailureLine.title`，
   *     **尚未**接到这里）。
   * ⚠️ 那条"『还没叫它写』与『它写不出来』要能分开"的顾虑**只对 `text` 成立**，标题不再有。
   */
  title: string | null;
  kind: '失败' | '成功';
  /** 成功才有；失败恒 `null` */
  flavor: EndingFlavor | null;
  /** 命中的是总表**第几行**（1~7 = 失败，8 = 成功）—— 判定顺序的证据，测试直接断言它 */
  row: number;
  /** 判定发生在第几天（1~4 可远早于第 28 天） */
  day: number;
  /** 为什么判成这样（UI 与调试用；**不进任何 prompt**） */
  reason: string;
  /**
   * 话术：**失败 = 系统预写**（`〔N〕` 已填实际天数）；
   * **成功 = `ending` 产出** —— 未接线前保持 `null`（"没话术"与"系统还没叫它写"要能分开）。
   */
  text: string | null;
}

// ── 七条失败结局（写死 · 系统播）─────────────────────────────

export interface FailureLine {
  row: number;
  /** 话术小标题 */
  title: string;
  /** 结局名 */
  name: string;
  /** 判定条件（原文） */
  cond: string;
  /**
   * **唯一的系统插槽**：`true` ⇒ 文本里的 `〔N〕` 填实际天数；`false` ⇒ 恒为「第 28 天」。
   * ⚠️ ②③④ 是 `true`；①（2026-10-08 用户改写话术后不再提天数）与 ⑤⑥⑦ 是 `false`
   *    —— 这一点由测试钉死。
   */
  daySlot: boolean;
  text: string;
}

export const FAILURE_LINES: readonly FailureLine[] = [
  {
    row: 1,
    title: '一页潦草',
    name: '陨命',
    cond: 'HP ≤ 0',
    // ⚠️ 2026-10-08 用户改写第一句与最后一句 —— 新句**不含**「第〔N〕天」插槽
    //    ⇒ daySlot 由 true 改 false（"哪天死的"不再写进这段话里；
    //    测试钉子随行同步：ending.test.ts「只有 ②③④ 带〔N〕」）。
    daySlot: false,
    text: [
      '三王子莫名其妙地死了，也许是自杀，也许是他杀，又也许只是单纯地不幸。',
      '御医照例写了一份很长的折子，把死因归给"急症"——写折子的人心里清楚，那不过是不想惹麻烦。王宫停了三天朝，第四天，一切照旧。',
      '一位王子要在不到一个月的时间把自己弄死，其实也算一种本事。',
    ].join('\n'),
  },
  {
    row: 2,
    title: '落锁的房间',
    name: '疯癫',
    cond: 'SAN ≤ 0',
    daySlot: true,
    text: [
      '从第〔N〕天起，王宫东角多了一间常年落锁的屋子，宫人们私下叫它"小殿下的房间"。',
      '你有时候唱很久的歌，有时候谁都不认，只在有人穿蓝衣服走过时会安静下来一会儿。没有人知道为什么，也没有人敢问。',
      '神殿的人来念过一次经，念到一半停了，摇了摇头。他们最后说，这不是神的意思。',
      '金庭城照常热闹。你的名字后来只剩下宴席上的一句"可惜了"。',
    ].join('\n'),
  },
  {
    row: 3,
    title: '什么都不要了',
    name: '迷失',
    cond: '欲念 = 0',
    daySlot: true,
    text: [
      '第〔N〕天，你什么都没了——不是丢了什么，是你不要了。',
      '你本来想要的那样东西，起初还偶尔想起，后来懒得想，再后来，连"想要"这件事本身都嫌麻烦。你照常起身、照常赴宴、照常对每个人点头，只是再没有一件事值得你多看一眼。',
      '后来有个伺候了你半辈子的老仆说了一句很准的话：三殿下不是死了，是提前散了。',
      '有人输给这个世界。你连输都懒得输。',
    ].join('\n'),
  },
  {
    row: 4,
    title: '火烧到了底',
    name: '沉溺',
    cond: '欲念 = 100',
    daySlot: true,
    text: [
      '第〔N〕天，你终于要到了你要的那样东西——全部的它，一点都不剩。',
      '拿到的第二天，你就发现它不够了，于是要更多。你不再问代价，也不再问那是谁的代价：先是自己的，后来是别人的。',
      '金庭城的人起初觉得你可怕，后来觉得你可怜，最后又觉得你可怕——因为可怜的人，不会连累那么多人。',
      '你到死都没想明白：明明要到了，为什么还是饿。',
    ].join('\n'),
  },
  {
    row: 5,
    title: '差一口火',
    name: '未竟',
    // ⚠️ 2026-10-06 用户裁定：门槛放宽到 **[70,80]**（`DESIRE_WINDOW_MIN`=70）
    cond: '第 28 天 · 欲念 < ' + DESIRE_WINDOW_MIN,
    daySlot: false,
    text: [
      '28 天过去了，金庭城什么都没有发生。',
      '你想要的那样东西，一直在那儿等着你。你其实从没缺过机会；你甚至不止一次走到了门口，然后转身，去了别处。',
      '第 28 天夜里你照常睡了，第二天醒来，还是那些事、那些人。',
      '后来你活得很长，长到足够明白：一个人不必非得活成什么样子。只是偶尔的某个下午，你会忽然想起自己本来想要什么，然后低下头，接着做手头的事。',
    ].join('\n'),
  },
  {
    row: 6,
    title: '要到手之后',
    name: '沉溺',
    cond: '第 28 天 · 欲念 > 80',
    daySlot: false,
    text: [
      '28 天过去了。你要到了很多，多到旁人已经记不清——只是每一样到手的时候，都跟你想象中的不太一样。',
      '你还是不满意。不是对世界不满意，是对"到手"这件事本身不满意：你要的好像从来不是那样东西，是那个"正在要"的你。于是你把日子过成了一场不肯停手的索取。',
      '你赢了，赢得彻底，也赢得空。',
      '后来有人提起你，最后总会补一句：三殿下这辈子最像个样子的时刻，是他还没要到的时候。',
    ].join('\n'),
  },
  {
    row: 7,
    title: '差一点点',
    name: '空手',
    cond: '第 28 天 · 成果格空',
    daySlot: false,
    text: [
      '28 天过去了。你想要的那样东西，你确实一直在要——可到第 28 天，你手里什么都没有。',
      '也不是没努力。你问过很多人，走过很多地方，应下过一些事，也得罪过一些人。只是每一件都差那么一点：差一点火候，差一点运气，或者差一点你自己不肯给的那份决心。',
      '有人安慰你，说重要的是过程。你点点头，礼貌地没有反驳。',
      '想要而没要成，其实比不想要更累——因为你还记得。',
    ].join('\n'),
  },
];

/**
 * 唯一插槽：`〔N〕` → 实际天数。
 *
 * ⚠️ **两侧补空格** —— 原文写的是「第**〔N〕**天」（插槽贴着字），而 ⑤⑥⑦ 里系统直接写死的
 *    是「第**空格**28**空格**天」。⇒ 只替换成裸数字会得到「第5天」，与同一份文档里的排版不一致。
 *    补空格后输出「第 5 天」，与写死那三条**同一排版**。
 * ⚠️ ⑤⑥⑦ 的文本里根本没有 `〔N〕` ⇒ 对它们是空操作（不必特判）。
 */
export function fillDaySlot(text: string, day: number): string {
  return text.split('〔N〕').join(` ${day} `);
}

/** 由一行总表条目造出结果 —— 话术**当场填插槽**，落账的就是玩家会读到的那份 */
function fromFailure(f: FailureLine, day: number): EndingResult {
  return {
    name: f.name,
    title: null, // ← 失败结局的话术小标题在 `FailureLine.title`，尚未接到账本（见 `EndingResult.title`）
    kind: '失败',
    flavor: null,
    row: f.row,
    day,
    reason: f.cond,
    text: fillDaySlot(f.text, day),
  };
}

const lineOfRow = (row: number): FailureLine => {
  const f = FAILURE_LINES.find((x) => x.row === row);
  if (!f) throw new Error(`总表第 ${row} 行不存在（1~7 才是失败行）`);
  return f;
};

// ── 两个检查点 ──────────────────────────────────────────────

/**
 * **逐次检查**（总表 1~4）—— 「**每一次结算之后**」调用。
 * 命中即**立即终结**，**不等第 28 天**；判定顺序从上到下，先命中先结束。
 *
 * ⚠️ 它必须挂在**每一次结算之后**，而不只是换日。
 *    实测教训：开局欲念占位若被写成 0，`档 A` 点一个「偏离」（−3）就当场归零 ⇒
 *    这一局按设计早该结束；若检查漏挂，模拟器会**继续跑一场已经死了的局**，
 *    而所有 28 天级断言照样全绿。
 */
export function instantEndingOf(l: Ledger): EndingResult | null {
  const me = l.entities.people.find((p) => p.id === PLAYER_ID);
  if (!me) return null; // 账本缺玩家 = 结构性错误，不是"该终结"（交给上层抛）
  const day = l.clock.day;
  if (me.hp <= 0) return fromFailure(lineOfRow(1), day);
  if (me.san <= 0) return fromFailure(lineOfRow(2), day);
  if (l.desire.value <= DESIRE_MIN) return fromFailure(lineOfRow(3), day);
  if (l.desire.value >= DESIRE_MAX) return fromFailure(lineOfRow(4), day);
  return null;
}

/**
 * **终局检查**（总表 5~7 ＋ 成功）—— 第 28 天、玩家**放完格子之后**。
 *
 * ⚠️ 优先级**不能按"看起来更严重"重排**：`欲念` 低于窗口时走 ⑤（未竟）。
 *   ⚠️ 2026-10-06：原来还有一条「`成果格空` ⇒ 走 ⑦（空手）」，
 *   **按用户裁定撤掉了**（欲念值只有门槛作用）⇒ 现在**成功只看欲念**。
 *    这是《设定.md》明文（"5 优先于 6、6 优先于 7"）。
 * ⚠️ 成功**只认欲念窗口这一把钥匙**；手段 / 共鸣**决定标题与判词调子，不决定成败**。
 */
export function finalEndingOf(l: Ledger, placements: Placements): EndingResult {
  const day = TOTAL_DAYS;
  const v = l.desire.value;
  // ⚠️⚠️ 2026-10-06 用户裁定：「**欲念值只有门槛作用**」
  //   ⇒ **去掉「成果格必须非空」那把钥匙**（改前是"两把钥匙"：成果格 ≥1 ＋ 欲念窗口）。
  //   ⇒ 现在：**欲念 ∈ [70,80] 就是成功**，否则失败。
  //   ⚠️ `placements` **仍然读**——它决定**标题与风味**（两档），
  //     那一维**不参与成败**（用户原话：「不决定【结局为失败还是成功】」）。
  if (v < DESIRE_WINDOW_MIN) return fromFailure(lineOfRow(5), day);
  if (v > DESIRE_WINDOW_MAX) return fromFailure(lineOfRow(6), day);
  // ⚠️ 原 `if (placements.成果 === null) return fromFailure(lineOfRow(7), day);`
  //   —— **按裁定撤掉**（成果格空不再是失败条件）。
  //   ⚠️ 总表第 7 行（`lineOfRow(7)`）因此**不再被用到**；它仍在 `lineOfRow` 里
  //   留着（那是设定文档的原文，撤掉它会让行号错位 ⇒ 别的行会指向别的句子）。
  const flavor = flavorOf(placements);
  return {
    name: FLAVOR_NAMES[flavor],
    // ⚠️⚠️ 2026-10-06：**标题当场写定**（两档），**不再等 `ending` 侧链** ——
    //   「结局标题」字段已从 schema 删掉，模型只写一段纯文本（`text`）。
    //   ⇒ 这也让全屏动画不必等网络：标题先出，正文后到。
    title: FLAVOR_NAMES[flavor],
    kind: '成功',
    flavor,
    row: 8,
    day,
    reason: `欲念 ∈ [${DESIRE_WINDOW_MIN}, ${DESIRE_WINDOW_MAX}]（唯一的门槛）`,
    text: null, // ← 由 `ending`（LLM · 全局至多 1 次）写；未接线前保持 null
  };
}

/** 走没走到第 28 天（放格子的前提） */
export function isFinalDay(l: Ledger): boolean {
  return l.clock.day >= TOTAL_DAYS;
}
