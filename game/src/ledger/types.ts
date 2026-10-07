// 账本运行时类型 —— 与《契约.md》§6.11 的十二组字段一一对应
import type {
  AttrBonus,
  Attrs,
  AttrKey,
  Delta,
  DesireTier,
  Difficulty,
  Dispatchable,
  Rep5,
  Tier,
  VoucherDim,
} from '../contract/types.ts';
// ⚠️ 同族：`RepMarks` 的形状（门槛档位）由 `rules/checkpoint.ts` 独占定义 ——
//    账本只**记**"哪几档已经出过"，不解释"多少分算达标"。
import type { RepMarks } from '../rules/checkpoint.ts';

// ── 时间点 ──────────────────────────────────────────────────

/**
 * 时间点 = 「第 `day` 天 · 当天已消耗 `used` 点」。
 *
 * ⚠️ **不存全局累计点数**（`day × 4 + used` 现场算）——天数是 28 的小量，没必要引入第二个事实源。
 * ⚠️ `{day:d, used:4}` 与 `{day:d+1, used:0}` **表示同一时刻**（当天末尾 = 次日开头）：
 *    - `addPoints` 用满当天时**保留** `used = 4`（能表达"就发生在当天末尾"）；
 *    - `nextDay` 推进到的时间点正好也是 `{d, 4}`；
 *    - 比较一律走 `toAbs`，两种写法天然等价。
 */
export interface TimePoint {
  day: number;
  used: number;
}

// ── 实体（§6.2 $def: Item / Person / Place）──────────────────

/** 人物状态**一律派生**（不存字段）——避免"HP 与 status 打架"这类双事实源 bug */
export type PersonStatus = '正常' | '重伤' | '濒死' | '死亡' | '疯狂' | '在途';

export interface Person {
  id: string;
  /**
   * 实体类别判别符（**系统内部字段，不进 prompt**）。
   * ⚠️ 它**不是**《契约.md》里那个 `kind` —— 那是**物品大类**（装备/消耗品/特殊物品），见 `Item.kind`。
   */
  etype: 'person';
  // 身份骨架（注入标签 ①，永不变）
  name: string;
  race: string;
  basic: string;
  identity: string;
  desc: string;
  /**
   * 是否属于你的人（⇒ **能不能派他办事**，`isAvailable` 第一行就读它）。
   * ⚠️ 它**不在《设定.md》那张阵容表里** —— 表里没有这一列，是 `initial.ts` 手工给的
   *    （2026-09-22 起：开局**只有皮普**为真）。
   * ⚠️ **写它的只有两处**：开局预设（`initial.ts`）与 **Delta** ——
   *    `entities.people[].affiliated`（出场时的归属）＋ `change[].affiliated`（既有角色改判）。
   *    后者就是 2026-09-22 新增的「**入队 / 离队**」通道。
   */
  affiliated: boolean;
  // 状态（注入标签 ③，会变）
  attrs: Attrs;
  attr_bonus: AttrBonus[];
  hp: number; // 0~3
  san: number; // 0~3
  in_your_eyes: string;
  openness: number; // 0~20
  items: string[];
  recognized: string[]; // 已给出的认可（共鸣凭证的派生去重）
}

export interface Item {
  id: string;
  etype: 'item';
  /**
   * **物品大类**：`装备` / `消耗品` / `特殊物品` —— 与《契约.md》§6.2 的 `Item.kind` 同名同义。
   * ⚠️ 它是**身份骨架**（注入标签 ①）⇒ 进静态头段 ②，且**永不变**。
   * 品级不进 schema、由 `attr_bonus` 派生。
   */
  kind: string;
  name: string;
  desc: string;
  attr_bonus: AttrBonus[];
  // 状态
  holder: string | null; // null = 留在账本（未携带）
  consumed: boolean;
}

export interface Place {
  id: string;
  etype: 'place';
  name: string;
  desc: string;
}

export type Entity = Person | Item | Place;

// ── 事件状态机 ──────────────────────────────────────────────
export type EventTier = 'A' | 'B' | 'C'; // A 弹窗 / B 派遣 / C 亲自

/**
 * ⚠️ **揭晓待办**（2026-09-18 时钟模型改造引入）：结果**已经算好**（排在 `Ledger.pending`），
 * 但时间还没走到 `reveal_at` ⇒ **绝不可落账、绝不可进 prompt**。
 * 旧状态 `进行中` 已删除：它的全部语义都被「揭晓待办」吸收。
 *
 * ⚠️ **`已过期` 已删除**（2026-09-18 用户裁定，见 `turn/t0.ts·settleExpired`）：
 *    没人处理的事件**也走一次标准结算**（LLM 按"玩家选择忽略这件事"生成后果与概要），
 *    落账后就是 **`已结算`** —— 它和"处理完的"在账本里**没有区别**，只在历史原因上不同。
 *    ⇒ 不再需要第二个"终态"，也不再有过期种子。
 */
export type EventStatus = '待处理' | '揭晓待办' | '已结算';

/**
 * 档 A 的选项 —— **不调 LLM** ⇒ 分支、文案、数值全部预写在这里。
 *
 * ⚠️ 字段名与 `compose_day` 的 `$def/PopupEvent.options[]` **不是逐字相同** ——
 *    这是**落地层**（`turn/land-compose.ts`）的职责：schema 的 `label` → 这里的 `text`。
 *    两处名字各自贴合自己的读者（schema 那边给模型看"按钮"，这边给 UI 看"选项文字"）。
 */
export interface EventOption {
  /** 选项文字（玩家点选前看到的按钮）← schema 的 `label` */
  text: string;
  /** 选中后立即显示的**结算文案** ← schema 的 `result_text`。档 A 不调 LLM ⇒ 它是"结果"的唯一载体 */
  result_text: string;
  欲向: DesireTier;
  delta: Delta;
  /** 落进「已处理概要」的事件级事实记录（≤75 字）—— 档 A 在历史上留下的**唯一痕迹** */
  summary: string;
  /**
   * 选中后**当场出现**的隐藏事件（**全局 id**，此前放在 `events.hidden` 里等这一刻）；不触发则 `null`。
   * ⚠️ 血统**单向**：父指子。被触发的子事件**绝不回填父 id**（双向写会互相漂移，明确禁止）。
   * ⚠️ 落地时**至多 1 个选项**带它 —— 这是"封住触发爆炸"的硬顶。
   */
  trigger: string | null;
}

export interface GameEvent {
  id: string;
  title: string;
  content: string;
  stage: string;
  location: string | null;
  tier: EventTier;
  /**
   * **处理方式限制**——
   * 说的是"**谁去做**"，与 `tier`（判定几次）**正交**：
   *   · `两者皆可` —— 默认；
   *   · `仅亲自`   —— 玩家无法派人（闸门 ③ 拦下任何非玩家的参与者）；
   *   · `仅派遣`   —— 玩家无法亲自（远征 / 潜伏 / 商队这类**长离岗**的事）。
   * ⚠️ 档 A 恒 `两者皆可`（它根本没有参与者 —— 点击即结算）。
   * ⚠️ 2026-09-19 之前它**只写在 schema 里**（`schema/compose.ts`），规则层一行都没读 ⇒
   *    "只能派人去"是个**纸上机制**。现在由 `rules/gates.ts` 的闸门 ③ 真正执行。
   */
  dispatchable: Dispatchable;
  /**
   * **非他不可**——
   * LLM 生成的**人物 id**（形如 `npc004`）；空串 = 没有指定。
   *
   * ⚠️ 语义是「**必须包含他**」，不是「只能是他」（2026-09-20 用户裁定）——
   *    允许再带帮手，与 `min_people` / `max_people` **各自独立算**（两条理由可以同时报）。
   * ⚠️ 他**不可用**时（受伤 / 已派出 / 尚未入队）**只能等** —— 不开「破例放行」的后门，
   *    `deadline` 过期结算就是那条逃生通道（2026-09-20 用户裁定）。
   * ⚠️ 它是**系统侧约束**：LLM 只负责说「这件事非谁不可」，「现在能不能」由闸门 ③ 判。
   * ⚠️ LLM 编一个不在实体表里的 id ⇒ 落地层按「未指定」忽略 ＋ 留一条 ⚠️ 日志
   *    （与 `seed_id` 填错编号同款处置）。
   * ⚠️ 档 A 恒空串（它没有参与者 —— 点击即结算）。
   */
  required_person: string;
  /**
   * **处理时长**（行动点）。
   * `≤ 4` = 单日完结（当天去当天回）；`> 4` = 跨天（占用人多天，见 `depart_cost`）。
   */
  cost: number;
  min_gold: number;
  min_people: number;
  max_people: number;
  /**
   * 允许的处理窗口，**按天计** —— 挡位 `1 / 2 / 4`，**最短 1 天**。
   * 过期时刻 = `{created_day + deadline, used: 0}`。
   * ⚠️ 2026-09-18 用户裁定：**只能按天**（精度到天、最短 1 天）—— 这样过期永远落在**日界**上，
   *    过期结算就能在换日那一刻集中做，不必往时间推进的每一步里插一次 LLM 调用。
   * ⚠️ 档 A 恒 1 且**永不过期**（它只受"当天必须清"约束 ⇒ 根本走不到过期）。
   */
  deadline: number;
  options: EventOption[]; // 档 A
  delta: Delta | null; // 档 A / if-else 生成时预写的效果
  /** 默认参与属性（裁定半可改，结算半不再动） */
  hint_attr: AttrKey[];
  /** 事件自身难度（LLM 判定） */
  difficulty: Difficulty;
  status: EventStatus;
  created_day: number;
  /** 排布时刻 —— `reveal_at` 的记账起点 */
  started_at: TimePoint | null;
  /** 揭晓时刻 = `started_at + cost`；时间推到这里即落账（**揭晓 ≡ 处理完成**） */
  reveal_at: TimePoint | null;
  handler: string | null;
  participants: string[];
  gold_locked: number; // 玩家为它投入、已扣下但尚未结算的托管金币
  /** 跨天事件：主事者**启程日**实际被扣的点数 d（归队日只回升 d 点） */
  depart_cost: number | null;
  /**
   * 结算那刻写回的**事件概括**（LLM 结算时的 `summary` / 档 A 点选项的 `summary`）。
   * ⚠️ 2026-10-07 用户裁定（第十五批）：生成侧要把「已处理」写成 **标题＋概括** ——
   *    概要块（`summaries.recent`）本身不带标题，配不了对 ⇒ 写回在事件身上一份。
   * ⚠️ **可选**：旧档没有它；没写出概括的结算也不写（块里跳过空值）。
   */
  settled_summary?: string;
}

// ── 预计算结果（注入标签 **永不**）──────────────────────────

/**
 * 排布那一刻**已经算好**、但尚未揭晓的结算结果。
 *
 * ⚠️ **注入标签「永不」**：这是"已经发生了、但玩家还不知道"的未来。
 *    结构性防剧透 ⇒ 它**绝不进 prompt、绝不给 LLM 看、绝不在 UI 提前露出**。
 *    Phase 1 用「存放位置」本身做保证（`Ledger.pending` 与 `events.live` 不同组）——
 *    组 prompt 时只要不遍历 `pending` 即可，不需要依赖任何一层记得"不要剧透"。
 */
export interface PendingResult {
  eventId: string;
  tier: Tier | null;
  narration: string;
  /** ⚠️ **原始** delta（未校验）—— 揭晓那一刻才 `applyDelta`，投骰结果到这里才落地 */
  delta: unknown;
  summary: string;
  next_seeds: string[];
  /**
   * **凭证**（`resolve.vouchers` 的**原始**形状，未校验）—— 与 `delta` 同一条纪律：
   * 「排布那一刻算好、揭晓那一刻才落账」。
   *
   * ⚠️ 2026-09-21 补：它此前**根本没被存进 `pending`**（`turn/handle.ts` 只取了
   *    `delta` / `summary` / `next_seeds` / `欲向`，独独漏了它）⇒ `resolve.vouchers`
   *    从 schema 到 prompt 一路俱在、**落地层直接丢弃**：账本第 8 组恒 `[]`、
   *    `Person.recognized` 永远为空。现场证据：三个基线种子跑满 28 天，终局那一格
   *    永远是「**共鸣=空**」—— 而所有断言照样全绿。
   */
  vouchers: unknown;
  欲向: DesireTier;
}

/** 注入标签「永不」—— 唯一用途是给 prompt 组装层做白名单断言 */
export const INJECT_NEVER = '永不';

// ── 其余组 ──────────────────────────────────────────────────
export interface Seed {
  code: string; // s1 / s2
  title: string;
  content: string;
  /**
   * ⚠️ **`'过期'` 已删除**（2026-09-18 用户裁定）：没人处理的事件**不再转种子** ——
   *    它走一次标准结算（按"玩家忽略"生成后果与概要），归宿与正常处理完全一样。
   *    种子的来源只剩两种：LLM 结算里产出的钩子、以及开局硬种子。
   */
  source: 'LLM' | '硬种子';
}

export interface VoucherRecord {
  dim: VoucherDim;
  desc: string;
  item: string; // 成果：物品 id
  person: string; // 共鸣：人物 id
  event: string; // 手段：事件 id（系统落账时自动绑定）
  recalled_day: number | null;
}

/**
 * **凭证收回请求**（批内的工作单，不是账本字段）。
 * ⚠️ 收回**不新写一条记录**，而是把已挂着的那条标上 `recalled_day` —— 于是"这条凭证几时失效的"
 *    在账本里只剩一处事实源，"产出 / 收回"也不必各记一遍。
 */
export interface RecallRequest {
  dim: VoucherDim;
  /** 成果：那件既有物品的正式 id（其余维度空串） */
  item: string;
  /** 共鸣：人物 id（其余维度空串） */
  person: string;
}

/**
 * 「穿越」场景的**进行时状态** —— 多轮期间唯一能回答"现在到哪了"的地方。
 *
 * ⚠️ **它只在场景进行中存在**（`null` = 不在场景里）。收尾那一刻置回 `null` ⇒
 *    "在不在场景里"没有第二个判据，也就不会出现"两个字段互相打架"。
 * ⚠️ 中途轮的 `delta` **当场落账**，所以本状态要能回答
 *    "前几轮已经记过什么"（`ledgered`）与"整场花了多少钱"（`spent`）—— 后者是收尾时
 *    与托管 `P` 结清的唯一依据（`gold_locked` 记的是**上限**，不是已花）。
 */
export interface SceneState {
  eventId: string;
  /** 已经走完几轮（`0` = 玩家还没开口） */
  round: number;
  /** 在场者（玩家 ＋ 他带上的人）—— 【场景背景】的"在场"取它 */
  present: string[];
  /** 这一场要用到的物品（进【玩家的处理】块，**不自动消耗**） */
  usedItemId: string | null;
  /** 「系统已落账」清单碎片（**整场累计**）。⚠️ 托管投入 `P` **永不入内**（它是上限） */
  ledgered: string[];
  /** 逐轮记录（玩家说了什么 · 判定 · 关键回应）—— 收尾的【场景经过】取它 */
  turns: string[];
  /** 整场**已报告**的金币花销（正数、累计）；收尾时与 `ev.gold_locked` 结清 */
  spent: number;
  /** 最近一轮的档位 —— 收尾时写进 `pending.tier`（揭晓那条路要它） */
  lastTier: Tier | null;
  /**
   * **累积的对话凭据**（不透明）。
   *
   * ⚠️ 规则层**只搬运、不解读**它 —— 与 `Adjudication.continuation` 完全同一套纪律：
   *    里面装的是 `llm/` 的私事（`ChatMessage[]`），`turn/` 不该知道消息角色。
   * ⚠️ 为什么挂账本而不是留在内存：**《契约.md》§2.4「同一场景内保留 assistant 历史」**
   *    ⇒ 存档 / 断线 / 中途退出再回来，这串历史都不能丢（`ledger/store-json.ts` 原样存）。
   * ⚠️ 形状由 `llm/brain-llm.ts` 独占定义（`SceneConv`）；这里只能是 `unknown`，
   *    否则 `ledger/` 就会反向依赖 `llm/`。
   */
  conv: unknown;
}

export interface RollState {
  tier: string;
  bonuses: string[];
}

/** 闸门结果（注入标签 永不 —— 只给 UI，绝不进 prompt） */
export interface GateResult {
  code: GateCode;
  pass: boolean;
  reason: string;
}

export type GateCode =
  | 'ACTION_POINTS'
  | 'PARTICIPANT_BUDGET'
  | 'CANNOT_DISPATCH'
  | 'POPUP_PENDING'
  | 'CARRY_OR_HOLDER'
  | 'MIN_PEOPLE'
  | 'MAX_PEOPLE'
  | 'NOT_REVEALED'
  | 'GOLD_INSUFFICIENT';

// ── 终局（放格子 ＋ 结局）────────────────────────────────────

/**
 * 玩家最后一天手动放的**三个格子**。
 * ⚠️「如一的初衷」**没有格子** —— 它由**欲念窗口**自动判定。
 * ⚠️ 值 = 该格放下的实体 id：成果 = 物品 id · 手段 = 事件 id · 共鸣 = 人物 id；空着 = `null`。
 */
export const PLACEMENT_SLOTS = ['成果', '手段', '共鸣'] as const;
export type PlacementSlot = (typeof PLACEMENT_SLOTS)[number];
export type Placements = Record<PlacementSlot, string | null>;

/** ⚠️ 必须每次新建 —— 共享一个可变对象会让"两个格子互不干扰"变成假的 */
export function emptyPlacements(): Placements {
  return { 成果: null, 手段: null, 共鸣: null };
}

/**
 * **13 · 终局**：放格子结果 ＋ 规则层判定出的结局。
 *
 * ⚠️ 它在这份类型表的 **12 组之外**—— 是 2026-09-19 做终局时新增的：
 *    《设定.md》把"放格子的结果"与"结局话术"写成了规则层的产物，但**两者都需要一个落账位置**；
 *    §5.8 又要求把"放格子结果"注入 `ending` 那一次的 user ③。
 *    ⇒ **待裁定是否补进《契约.md》§6.11 第 13 行**（设计文档不擅改）。
 *
 * ⚠️ 它**只在终局出现**（`null` = 还没结束）⇒ 与 `scene` 同族：靠"平时是 null"自然不进主链 prompt。
 */
export interface EndingRecord {
  /** 总表那一列的结局名（陨命 / 疯癫 / 迷失 / 沉溺 / 未竟 / 空手 / 四种风味名） */
  name: string;
  /**
   * **这一局的标题**（≤8 字）。
   * ⚠️ 与 `name` 分工不同：`name` = 总表那一列的**分类名**；`title` = **这一局**的收束名字。
   *    失败结局系统直接播预写话术 ⇒ 恒 `null`（它的话术小标题在 `rules/ending.ts·FailureLine.title`，
   *    **尚未**接到这里）；成功结局由 `ending` 侧链写。
   * ⚠️ 同 `EndingRecord` 本身：**待裁定是否补进《契约.md》§6.11 第 13 行**（设计文档不擅改）。
   */
  title: string | null;
  kind: '失败' | '成功';
  flavor: 'A' | 'B' | 'C' | 'D' | null;
  /** 命中的总表行号（1~7 = 失败，8 = 成功） */
  row: number;
  /** 判定发生在第几天（1~4 可远早于第 28 天） */
  day: number;
  reason: string;
  /** 失败 = 系统预写话术（`〔N〕` 已填）；成功 = `ending` 产出（未接线前为 `null`） */
  text: string | null;
  /** 放格子结果 —— 中途暴毙时三格全空 */
  placements: Placements;
}

export interface Ledger {
  /**
   * 1 —— `usedToday` = 玩家当天**已消耗的行动点**（时间轴读数）。
   * 玩家剩余 = `BASE_ACTION_POINTS − usedToday`（见 `rules/clock.ts·remainingToday`）。
   * ⇒ 「玩家行动点」**只有一个事实源**：不再有 `actionPoints.player` 这份冗余副本。
   */
  clock: { day: number; phase: '序幕' | '正文' | '终局'; chapter: 1 | 2 | 3 | 4; usedToday: number };
  /** 2 */ entities: { places: Place[]; people: Person[]; items: Item[] };
  /**
   * 3 scalars，那是因为**玩家本人就是 people 里的 npc000**。
   * 实现上 HP / SAN **只存在 `entities.people`（每人一份）**，此处不再复制一份 ⇒ 消除双事实源。
   */
  /** 3 */ scalars: { gold: number; rep: Rep5 };
  /** 4 */ events: { live: GameEvent[]; hidden: GameEvent[] };
  /**
   * 4.5 **预计算结果**（注入标签 永不）—— 排布时算好、揭晓时兑现。
   * 与 `events` 分开成组，是为了让"防剧透"成为**结构保证**而不是纪律要求。
   */
  pending: PendingResult[];
  /** 5 */ summaries: { archive: string[]; recent: Array<{ day: number; text: string }> };
  /** 6 */ seeds: Seed[];
  /** 7 */ divination: { ambition: string } | null;
  /** 8 */ vouchers: VoucherRecord[];
  /**
   * 9 desire —— 玩家的欲望。字段同属一组，**注入标签却分两半**（见 `ledger/project.ts`）：
   * `proposition` / `manifesto` ⇒ ③（user 首块【他的欲望】，常驻）；`value` / `past` ⇒ **永不**。
   *
   * ⚠️ **2026-10-05 用户裁定：欲望不再由 LLM 生成，改成玩家从 `rules/desire-kits.ts`
   *    的 5 条原型里挑一条。** 下面两段口径连同 `turn/opening.ts` 顶栏都已整条换掉：
   *    · `proposition` = **欲望命题**（干燥的陈述句，≤30 字）—— **玩家从预写表里挑的**，
   *      **每天判「这一手离它更近了没有」只用它**。
   *    · `manifesto` = **欲望宣言**（中二体，玩家自己写下的）—— **只上卡面与终局，不进判定**。
   *      它与命题是**两个读者**（判据 / 情感），沿用「欲念区间名给玩家、数值不给玩家」那条纪律。
   *    · `kit` = 玩家挑的是第几条（`DESIRE_KITS` 的下标）—— UI 要靠它回显"你选了哪条"，
   *      旧存档没有这个字段时读作 `0`（见 `turn/opening.ts` 的兼容处理）。
   * ⚠️ `past`（过往概述）**不再是"从欲望倒推的过去"** —— 它现在是
   *    **「按这六维 ＋ 这条欲望，写出他是个什么样的人」**（玩家分配属性后生成的人物描述）。
   *    玩家可见 / 系统要用，但模型不必看。
   * ⚠️⚠️ **`cards` 字段已删除**（2026-10-05 用户裁定：「玩家的欲望就根本不需要塔罗牌的
   *    参与，不要画蛇添足」）。连带删掉的还有 `chapter_shift` 的「命中原卡」双轨 ——
   *    那条轨的**比对基准就是这副原卡**，原卡不存在了它无法存在。
   *    ⇒ `rules/chapter-shift.ts·resolveDesireChange` 现在**只走模型轨**。
   *    ⇒ 塔罗**只剩一处用场**：`drawDivinationCards`（章节占卜读世界氛围），与欲望无关。
   *    ⚠️ 旧存档里那个 `cards` 键会被**静默忽略**（strip-only 不校验、多一个键不报错）——
   *    读档不会炸，但那份数据也不再被任何代码读。
   * ⚠️ **这里曾经有第四个字段 `reached60_day`**（首次跨 60 的日子）—— 它只服务于
   *    已删除的 `rewrite_desire` 侧链（触发表）。留着它 ⇒ 旧存档能读，但那个字段永远是 null。
   */
  /** 9 */ desire: {
    value: number;
    /**
     * **目的**（＝《契约.md》§6.8 那个「欲望命题」）—— 干燥的一句「他想要什么」。
     * ⚠️ **只给「欲向」判定**（每天判「这一手离它更近了没有」）。
     */
    proposition: string;
    /**
     * **手段** —— 「通过 **X** 来 Y」里的 X：他打算怎么去要（2026-10-06 新增）。
     * ⚠️ **只给 `vouchers.the_proper_way`（正当的手段）判定**：
     *    「正当」不是客观道德，而是**他自己认定的那条路子**。
     * ⚠️ 它与 `proposition` 是**两个半句、两个判据**，别把任何一边删掉 ——
     *    删了 `means`，那一维立刻变回"无从判定"（它原本的判据是塔罗手段牌，牌已删）。
     * ⚠️ 旧存档缺这个字段 ⇒ 读作 `''`（`??` 兜底）。
     */
    means: string;
    /** 欲望宣言（中二 · 只给卡面与终局） */
    manifesto: string;
    /** 玩家挑的是 `DESIRE_KITS` 的第几条（0~4）；旧存档缺这个字段 ⇒ 读作 0 */
    kit: number;
    /**
     * 玩家点亮的优势属性（0~2 个键名）—— **六维是它算出来的，不是独立存的**
     *（`rules/desire-kits.ts·distributeAttrs`）。
     * ⚠️ 为什么要单独存这一份：六维值本身住在 `entities.people[npc000].attrs`，
     *    但那是**算完的结果**；这一份是**玩家的原始选择**（"他只敢点亮魅力"），
     *    UI 要靠它回显勾选状态、`opening` 侧链要靠它告诉模型"他点亮了什么"。
     *    ⚠️ **不要拿 `attrs` 反推**（15 / 12 有别的组合可能）—— 反推口径会漂。
     *    旧存档缺这个字段 ⇒ 读作 `[]`（见 `prompt/blocks.ts·openingAttrsBlock`）。
     */
    advantages: AttrKey[];
    // ⚠️⚠️ **2026-10-06 删掉了 `past: string`** —— 玩家的人物描述不再由模型生成，
    //    改为**硬编码在 `entities.people[npc000].desc`**（与**其余所有人物**同一字段）。
    //    「他是个什么样的人」那条 UI 词条同时删除。详见 `ledger/initial.ts·PLAYER_DESC`。
  };
  /** 10 */ scene: SceneState | null;
  /** 11 */ roll: RollState | null;
  /** 12 */ gates: GateResult[];
  /** 13 —— **终局**（放格子 ＋ 结局）；`null` = 还没结束 */
  ending: EndingRecord | null;
  /**
   * 14 —— **硬种子 checkpoint 的「已出过」标记**。
   * 五格声望各一份：已经出过 checkpoint 的**门槛档位**（`10` / `15` / `20`，升序）。
   *
   * ⚠️ **为什么必须落账本**：触发条件是「**首次**达到 10 / 15 / 20」——
   *    「首次」是**历史事实**，从当前 `scalars.rep` 推不出来：声望会跌回去、再升回来，
   *    那种"再次达到"**不触发**（《规则.md》原文）。
   * ⚠️ **为什么记门槛而不是计数**：跌回去再升回来时 `before < N ≤ after` 会再次成立，
   *    只有门槛清单才分得清"这条早出过了"。
   * ⚠️ 判定与写账在 `ledger/apply.ts·commitBatch`（**批末**）；形状与三档门槛的唯一拷贝
   *    在 `rules/checkpoint.ts`。开局五格都是空数组（`权势` 开局 5，还没到 10）。
   */
  repMarks: RepMarks;
  /**
   * 系统独写：**下属的容量预算**（不在 Delta 里 ⇒ 结构上杜绝"重复扣"）。
   * ⚠️ 玩家的时间预算**不在这里**，它是 `clock.usedToday`。
   */
  actionPoints: { byNpc: Record<string, number> };
  /** id 发号器的水位（单调递增、永不复用） */
  idWatermark: { npc: number; it: number; loc: number; event: number };
}

export const PLAYER_ID = 'npc000';

// ── 派生 ────────────────────────────────────────────────────
export function findPerson(l: Ledger, id: string): Person | undefined {
  return l.entities.people.find((p) => p.id === id);
}
export function findItem(l: Ledger, id: string): Item | undefined {
  return l.entities.items.find((i) => i.id === id);
}
export function player(l: Ledger): Person {
  const p = findPerson(l, PLAYER_ID);
  if (!p) throw new Error('账本缺少玩家 npc000');
  return p;
}

/** 状态一律派生：HP=0 死亡 · SAN=0 疯狂 · HP=1 濒死 · HP=2 重伤 · 否则正常 */
export function derivePersonStatus(p: Person): PersonStatus {
  if (p.hp <= 0) return '死亡';
  if (p.san <= 0) return '疯狂';
  if (p.hp === 1) return '濒死';
  if (p.hp === 2) return '重伤';
  return '正常';
}

/** 「可用」= 在册 ∩ 未派遣 ∩ HP > 1 ∩ SAN > 1 ∩ 未死亡/疯狂 */
export function isAvailable(p: Person, l: Ledger, today: number): boolean {
  if (!p.affiliated) return false;
  if (p.hp <= 1 || p.san <= 1) return false;
  if (isAway(p.id, l, today)) return false;
  return true;
}

/**
 * 今天这个人是否在路上（已被派遣、且尚未到归队日）。
 * ⚠️ 归队**日**（`reveal_at.day`）当天他人已经回来了 ⇒ 判 `today < reveal_at.day`。
 */
export function isAway(npcId: string, l: Ledger, today: number): boolean {
  return l.events.live.some(
    (e) =>
      e.status === '揭晓待办' &&
      e.handler === npcId &&
      e.started_at !== null &&
      e.started_at.day < today && // 启程日当天他仍可做别的事（出发之前）
      e.reveal_at !== null &&
      today < e.reveal_at.day,
  );
}

/**
 * 今天这个人的归队事件（若有）—— 归队日只回升 `d` 点。
 * ⚠️ 不筛「揭晓待办」：揭晓发生在归队日**当天下午**（`reveal_at.used` 那一刻），
 * 但**当天上午他还在归队路上**，所以这天仍要按 `d` 计点。
 * ⚠️ 必须 `started_at.day < today`：否则"当天启程、当天归队"的单日事件会被误判成归队。
 * ⚠️ 原先还有一条 `status !== '已过期'` 的筛 —— **2026-09-18 已删**：过期不再是一个状态，
 *    而且过期事件**从来没有** `handler`（没人排布过它）⇒ 上面这行 `handler === npcId` 已经挡住。
 */
export function returnToday(npcId: string, l: Ledger, today: number): GameEvent | undefined {
  return l.events.live.find(
    (e) =>
      e.handler === npcId &&
      e.started_at !== null &&
      e.started_at.day < today &&
      e.reveal_at !== null &&
      e.reveal_at.day === today,
  );
}
