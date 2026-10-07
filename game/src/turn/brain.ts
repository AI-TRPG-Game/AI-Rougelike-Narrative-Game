// 「模型」的接口 —— Phase 1 由假 brain 实现，Phase 2 起由真实 LLM 实现。
//
// ⚠️ **2026-09-18（Phase 2）接口改造**：`settle` 一拆为二。
//    Phase 1 的 `settle(ev, tier, …)` 是"把已经定好的档位写出来"——它默认了
//    「投骰」这一条走法，裁定半被规则层用 `ev.hint_attr` 顶替了。
//    而《契约.md》§6.5 写明 `Check` 是**模型的裁定半**（verdict / participants / difficulty）。
//    ⇒ Phase 2 起：**先 `adjudicate`（裁定），规则层投骰，再 `settle`（结算）**。
//
// ⚠️ 两段都不推进时间、都不落账 —— 它们只"产出提议"。落账在 `turn/handle.ts`。
import type { Check, DesireTier, Tier } from '../contract/types.ts';
import type { GameEvent, Ledger } from '../ledger/types.ts';
import type { HandlingRecord } from '../prompt/blocks.ts';
import type { Rng } from '../rules/rng.ts';
import type { SceneEndReason } from '../rules/scene.ts';
import type { DivinationCards } from '../rules/tarot.ts';
import type { ArchivePlan } from '../rules/archive.ts';

// ── 多轮「穿越」的形状──────

/**
 * **每一轮**都要给模型看的视野 —— 它回答的是"此刻站在哪儿"。
 * ⚠️ 它**不含**前几轮的经过：【场景经过】只在收尾那一次出现，中途轮靠
 *    **累积的对话历史**（`conv`）记住前面发生了什么（§2.4「同一场景内保留 assistant 历史」）。
 */
export interface SceneView {
  round: number;
  presentIds: readonly string[];
  /** 【本场景已落账】的碎片（**整场累计**）。⚠️ 托管 `P` 永不入内 */
  ledgered: readonly string[];
}

/**
 * **收尾**那一次要的视野 —— 它要的是"整场经过了什么"，而不是"此刻站在哪儿"。
 * 两者刻意分成两个类型：一个字段错位就会让收尾的 `summary` 写成一轮的流水账。
 */
export interface SceneWrapView {
  /** 逐轮记录（`SceneState.turns`）—— 【场景经过】取它 */
  turns: readonly string[];
  ledgered: readonly string[];
}

/**
 * 场景里的一步：**值 ＋ 新的对话凭据**。
 *
 * ⚠️ 为什么多轮要单独把 `conv` 递出来（而 `settle` 不用）：`conv` 是**跨轮**的，
 *    而 `Adjudication.continuation` 只活在同一事件的两段之间。规则层拿到之后
 *    **原样存回** `Ledger.scene.conv`、下一轮**原样递回** —— 它自己一个字节都不解读。
 */
export interface SceneStep<T> {
  value: T;
  conv: unknown;
}

/** 模型产出的「未校验」原始结果（真实 LLM 会给任意形状 ⇒ 一律经 validateDelta） */
export interface RawResolution {
  narration?: string;
  delta?: unknown;
  summary?: string;
  next_seeds?: string[];
  /** 三种结局凭证的**原始**形状（未校验） */
  vouchers?: unknown;
  欲向?: DesireTier;
  /**
   * **这一轮场景是否已自然收束**—— 只有多轮用得上。
   * ⚠️ 单轮 / 派遣路径**不读它**（那边恒 true，语义由"这一次结算就是结果"承担）。
   * ⚠️ 它为 true 的那一轮必须**一并填好** `summary` / `next_seeds` ——
   *    那是 `turn/scene.ts` 跳过收尾调用的**唯一依据**（省一次调用，也省一次前缀钱）。
   */
  scene_over?: boolean;
}

/**
 * `compose_day` 的**原始输出** —— 与 `RawResolution` 同一条纪律：**未校验**，任意形状。
 *
 * ⚠️ 它为什么不是 `GameEvent[]`：两者之间隔着**落地层**（`turn/land-compose.ts`）——
 *    改本地编号 → 全局 id、`label` → `text`、`seed_id` 核销、`Delta` 过六项校验、
 *    条数硬顶，以及最要紧的那一步：**"进 `live` 还是进 `hidden`"**（被 `trigger` 引用的进后者）。
 *    Phase 1 曾经直接返回 `GameEvent[]` —— 那等于让模型自己写账本字段形状，
 *    而服务端**对模型输出完全不校验**（Phase 0 §三）⇒ 那一层薄得像没有。
 * ⚠️ 两个通道按**结构**分（档 A 不带 `tier`、带 `options`；档 B/C 反之），**不靠模型自报**。
 */
export interface RawComposeOutput {
  popup_events?: unknown;
  canvas_events?: unknown;
}

/**
 * `chapter_shift` 的**原始输出** —— 与上面三条同一条纪律：**未校验**，任意形状。
 * 「氛围非空且 ≤30 字 / 欲念变化是数字」由 `turn/chapter-shift.ts·applyChapterShift` 判；
 * 区间与**双轨**（命中 ⇒ 查表、未命中 ⇒ 采用模型相关性）全在 `rules/chapter-shift.ts`。
 */
export interface RawChapterShiftOutput {
  章节欲念变化?: unknown;
  章节氛围?: unknown;
}

/**
 * `archive` 的**原始输出** —— 与其它侧链同一条纪律：**未校验**，任意形状。
 * 「归档段非空且 ≤300 字」由 `turn/archive.ts·applyArchive` 判 ——
 * 服务端对模型输出**完全不校验**（Phase 0 §三），`strict` 只管 schema 定义的合法性。
 */
export interface RawArchiveOutput {
  归档段?: unknown;
}

/**
 * `ending` 的**原始输出** —— 与其它侧链同一条纪律：**未校验**，任意形状。
 * 「判词 100~200 字」由 `turn/ending.ts·applyEnding` 判 ——
 * 服务端对模型输出**完全不校验**（Phase 0 §三），`strict` 只管 schema 定义的合法性。
 * ⚠️ 它给的**只有一个**自由文本字段：判定那几项（`name` / `row` / `flavor` /
 *    `placements` / **`title`**）一个字都不由模型决定 ——
 *    "LLM proposes narrative skin; rule layer adjudicates outcomes"。
 *
 * ⚠️⚠️ **2026-10-06 用户裁定：模型只输出一段纯文本。**
 *   `结局标题` **删掉** —— 标题由规则层给（`rules/ending.ts·FLAVOR_NAMES` 两档：
 *   得偿所愿 / 差一步美满），模型**碰不到**。
 *   `结局话术` 改名 **`结局判词`**。
 *
 * ⚠️ **2026-10-06 顺手修掉一个既有隐患**：这个 interface 在本文件里**被写了两遍**
 *   （逐字相同，TypeScript 允许接口合并所以一直没报错）—— 现在合成一份。
 */
export interface RawEndingOutput {
  结局判词?: unknown;
}

/**
 * 裁定半的产出：一句话复述 ＋ 一个 `Check`（原样保留，便于回填与日志）。
 *
 * ⚠️ `continuation` 是**给 Brain 自己看的**不透明续接凭据（规则层不解、不存、不落账）。
 *    为什么要有它：`settle` 必须能**无缝续上** `adjudicate` 那一轮对话，
 *    而"续接"所需的东西（`tool_call_id` / 裁定半的原始 arguments / 一段式已填好的结算半）
 *    **全是 LLM 私事** —— 让 `handle.ts` 去保管它们，等于把 `prompt/` 与 `llm/` 的私事
 *    漏进规则层；让 `Brain` 自己存字段，又会让它变得**有状态**（回放器与并发都难做）。
 *    ⇒ 折中：`adjudicate` 把凭据**交出来**，`handle.ts` 原样**递回去**。
 *    这也顺手保证一件事：**同一事件的两段之间，不可能被别的调用插进来**。
 */
export interface Adjudication {
  intent_summary: string;
  check: Check;
  continuation: unknown;
}

/**
 * 结算半的输入 —— **回填给模型的东西全在这里**，且只有这些。
 * 分成三个字段而不是三个参数，是为了让"允许回传什么"成为**一处可核对的地方**。
 */
export interface SettleInput {
  /** 本次档位（`{档位}`） */
  tier: Tier;
  /** 物品加成标签（`{加成}`；无则空数组） */
  bonuses: readonly string[];
  /**
   * 【系统已落账】清单。
   * ⚠️ **托管投入 `P` 永不入内** —— 它是**上限**不是"已花的钱"，
   *    写进去会让模型以为金币已扣 ⇒ **全额退款式** bug（见 `prompt/blocks.ts` 的同名警告）。
   */
  landed: readonly string[];
}

export interface Brain {
  /**
   * **① 裁定半** —— 决定「能不能做、要不要判定」。
   * ⚠️ 必须在投骰**之前**，否则模型会提前剧透结果。
   * `verdict==='投骰'` ⇒ 由规则层投骰；其余四种 ⇒ `outcomeForNonRoll` 直接给档位。
   */
  adjudicate(ev: GameEvent, l: Ledger, h: HandlingRecord): Promise<Adjudication>;

  /**
   * **② 结算半** —— 给定已定档位，写叙事 + 提议 `delta` + 收尾字段。
   * ⚠️ 回填给模型的只有 `{档位, 加成}`：`d20` / `A` / `R` 是系统内部算术，
   *    回传只会诱导模型复述数字或二次揣测成败。
   * ⚠️ `adj` 必须**原样**来自本事件紧邻的那次 `adjudicate`（见 `continuation` 的说明）。
   * ⚠️ 一段式（`verdict≠投骰`）时 `settle` **不发网络**：把第一次调用里已填好的结算半取出来即可。
   */
  settle(
    ev: GameEvent,
    l: Ledger,
    h: HandlingRecord,
    adj: Adjudication,
    input: SettleInput,
  ): Promise<RawResolution>;

  /**
   * **③ 忽略结算** —— 事件**没人处理、等到过期**时走的那一次（2026-09-18 用户裁定）。
   * 它不是"第二条结算路径"：**system 与结算半逐字相同**（静态头 ＋ 结算指令 ⇒ 前缀缓存共享），
   * 只有 user 里【玩家的处理】换成"玩家选择忽略这件事…"，且【处理者能力】整段不存在。
   * ⚠️ **一次调用**：没有裁定、没有掷骰 ⇒ 不存在两段式。
   * ⚠️ 结果**直接落账**（不经 `pending`）：过期是"等到时间才发生"，没有额外的等待可言。
   */
  ignore(ev: GameEvent, l: Ledger): Promise<RawResolution>;

  /**
   * **④ 生成半** —— T0 换日，生成当天的自由事件。
   *
   * ⚠️ 返回的是 **`compose_day` 的原始输出**（未校验），不是 `GameEvent[]` —— 见 `RawComposeOutput`。
   *    落地（校验 / 编号 / 分通道 / 核销种子）由 `turn/land-compose.ts` 负责，**不能省**。
   * ⚠️ 玩家自建（「创建事件」）走的是**同一个 function ＋ 另一份指令**，输出形状逐字相同
   *    （只是 `popup_events` 恒为空数组）⇒ 落地路径完全复用。
   */
  composeDay(l: Ledger, rng: Rng): Promise<RawComposeOutput>;

  /**
   * **④-b 玩家自建** —— 玩家主动提出"我想做点什么"。
   *
   * ⚠️ 与 ④ 是**同一个 function**（`compose_day`）、**另一份指令**（`创建事件`）、
   *    **另一份 user ③**（`assembleCreate`：把【本日调度】换成【玩家的处理方式】）——
   *    输出形状逐字相同，所以它**不是第 10 条独立链**，而是 ④ 的另一半（编号才叫 ④-b）。
   * ⚠️ `popup_events` **不用在这里清洗成空数组**：落地层按结构分通道，
   *    `landCompose(l, raw, { mode: 'create' })` 会整批忽略档 A（理由见那里）。
   *    在这里顺手清一遍 = 同一个口径两处实现，而两处都能漏。
   * ⚠️ **豁免全部额度检测**：不占条数、不进 `L`、不吃盈余 ——
   *    "玩家主动性的唯一出口"。唯一的约束（行动力耗尽照样拦）落在**调用侧**的闸门 ①。
   * ⚠️ **不消耗当下时间**：产出的是 `待处理` 的一条，花时间的是将来处理它那一步。
   * ⚠️ **失败即抛**（与本文件其它方法同一条纪律）：由 `turn/create.ts` / UI 侧把异常交出去
   *    —— 悄悄补一条默认事件会让"玩家敲了话却什么都没发生"变成"莫名其妙多了一件事"。
   */
  createEvent(l: Ledger, approach: string): Promise<RawComposeOutput>;

  /**
   * **⑥ 章节占卜** —— 占卜日（第 1 / 8 / 15 / 22 天）日初、**生成之前**（每章一次）。
   *
   * ⚠️ **牌由系统抽、不由模型出**（与 `opening` 同）：`cards` 是调用侧
   *    `drawDivinationCards(rng)` 的结果，模型只负责**读牌**。
   * ⚠️ 触发条件由 `turn/t0.ts` 判（`isDivinationDay(day)`），**不在这里** ——
   *    Brain 只负责"被叫到就把这一件事做好"。
   * ⚠️ 它**同时产出两样东西**，而这两样的**可见性不同**（用户 2026-09-22 的 UI 分层要求）：
   *    · `章节氛围` —— **玩家可见**（占卜结果直接给玩家看，也是下周生成的灵感来源）；
   *    · `章节欲念变化` —— **玩家不可见**（欲念在界面上是"无仪表提示"，且命中原卡时
   *      这个数会被**系统查表覆盖**）⇒ 它只进开发侧日志。
   * ⚠️ **失败即抛**（`ChapterShiftRejected`）：氛围与欲念变化是**同一次落账**的原子两半；
   *    调用侧（`t0.ts`）记警告、这一章的氛围保持上一版 —— 但**不炸掉整个 T0**。
   */
  chapterShift(l: Ledger, cards: DivinationCards): Promise<RawChapterShiftOutput>;

  /**
   * **⑦ 概要归并** —— T0 的「概要归并」位（章首检查超限 / 总量越硬顶 · 全局约 2~3 次）。
   *
   * ⚠️ 触发条件由 `turn/t0.ts` 判（`rules/archive.ts·planArchive`），**不在这里** ——
   *    Brain 只负责"被叫到就把这一件事做好"（与 `chapterShift` 同一条职责边界）。
   * ⚠️ 它**只做一件事**：把最老的几天概要并成一段更短的历史。**不重写已有的归档段**、
   *    不碰欲望命题（四条侧链里**唯一不带欲望命题**的一条）⇒ 装配出的 system 只有两段。
   * ⚠️ `plan` **原样来自调用侧** —— 同一个对象既渲染进 user ③、也交给落地层搬 `days`。
   *    不要在这里重算，算两遍就是两份判据。
   * ⚠️ **失败即抛**：调用侧（`t0.ts`）记警告、概要保持原样 —— 但**不炸掉整个 T0**
   *    （与 `chapter_shift` 同一条纪律）。
   */
  archive(l: Ledger, plan: ArchivePlan): Promise<RawArchiveOutput>;

  /**
   * **⑧ 终局叙事** —— 第 28 天放完格子、判出**成功结局**之后（全局至多 1 次）。
   *
   * ⚠️ 触发条件由 `turn/ending.ts·writeEnding` 判（是不是成功、话术写没写过），**不在这里** ——
   *    Brain 只负责"被叫到就把这一件事做好"（与 `chapterShift` / `archive` 同一条职责边界）。
   * ⚠️ **不看"今天"、看整局**：输入 = 已处理概要**全量**（归档 ＋ 逐条）＋ 放格子结果 ＋
   *    欲望命题 ＋ 这一局的画像（装配见 `assembleEnding`；命题在 system 末段）。
   *    它与日常**相反** —— 日常靠"最近一天"跑，终局靠"整局"跑（§5.8）。
   * ⚠️ **失败结局不走这里**：七条失败话术由规则层直接播预写文案，**0 调用**。
   * ⚠️ 与 `opening` **对称**：一个是第一次调用，一个是最后一次调用。
   * ⚠️ **没有入参是"外部算好的"** —— 概要 / 放格子 / 命题 / 画像全在账本里
   *    ⇒ 与 `opening`（牌由调用侧抽）不同：这里再传一份就是第二份判据。
   * ⚠️ **失败即抛**：调用侧（`writeEnding`）记警告、话术保持缺失 —— 但 `closeGame`
   *    已经定下的结局**不受影响**（判定与话术是两件事）。
   */
  ending(l: Ledger): Promise<RawEndingOutput>;

  // ── 多轮「穿越」的两次调用──────────────────
  //
  // ⚠️ 为什么不复用上面的 `adjudicate` / `settle`：多轮多出一件**跨轮**的东西 ——
  //    累积的对话凭据（`conv`）。把它塞进 `Adjudication.continuation` 会让它**只活两段之间**，
  //    而场景要的是"活到收尾"；塞进 `HandlingRecord` 又会把 LLM 私事漏进【玩家的处理】块。
  //    ⇒ 单独两个方法，`conv` 作为**入参 ＋ 出参**由规则层原样搬运，Brain 保持无状态。
  // ⚠️⚠️ **2026-10-07 用户裁定：场景内不做投掷判定** ⇒ 原来的裁定半（`sceneAdjudicate`）
  //    与叙事半（`sceneNarrate`）**合并成一次调用**（`sceneTurn`）—— 每轮一次、纯文字回应，
  //    不再有 `{档位, 加成}` 的回填，也没有"一段式不发网络"的分叉。

  /**
   * **一轮** —— 对玩家这句话给出场景里的文字回应（含本轮的 `delta` 提议与 `scene_over`）。
   * ⚠️ 每轮**恰好一次网络调用**；`conv` 进出原样搬运。
   * ⚠️ **2026-10-07 用户裁定：回应以流式呈现** ⇒ 尾参 `onNarrDelta`（可选）：
   *    真模型把它接到流式调用的 `narration` 增量上（`reset=true` = 重试作废前文）；
   *    假 brain / replay 直接忽略 —— 接口对它们**零要求**（可选参数）。
   */
  sceneTurn(
    ev: GameEvent,
    l: Ledger,
    h: HandlingRecord,
    view: SceneView,
    conv: unknown,
    onNarrDelta?: (chunk: string, reset: boolean) => void,
  ): Promise<SceneStep<RawResolution>>;

  /**
   * **收尾** —— 场景已结束（退出 / 轮尽 / 未自然收束）时才发这一次；**末轮已 `scene_over=true`
   * 就整次省掉**。核心产物是 `summary`：它**覆盖**本场景的逐轮记录。
   */
  sceneWrap(
    ev: GameEvent,
    l: Ledger,
    reason: SceneEndReason,
    view: SceneWrapView,
    conv: unknown,
  ): Promise<SceneStep<RawResolution>>;
}
