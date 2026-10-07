// 基础类型与字段常量 —— 与《契约.md》§6.1 / §6.3 一一对应
// ⚠️ Node 的类型擦除（type stripping）不支持 enum / namespace / 参数属性 ⇒ 全部用 const + union

// ── 属性与声望 ────────────────────────────────────────────────
export const ATTR_KEYS = ['争斗', '敏捷', '智慧', '魅力', '社交', '感知'] as const;
export type AttrKey = (typeof ATTR_KEYS)[number];

export const REP_KEYS = ['善名', '恶名', '侠名', '怪名', '权势'] as const;
export type RepKey = (typeof REP_KEYS)[number];

export type Attrs = Record<AttrKey, number>;
export type Rep5 = Record<RepKey, number>;

// ── 档位（五档）─────────────────────────────────────────────
export const TIERS = ['大成功', '困难成功', '成功', '失败', '大失败'] as const;
export type Tier = (typeof TIERS)[number];

// ── 判定请求（Check，§6.3）──────────────────────────────────
// ⚠️ 2026-10-07 用户裁定：**「拒绝」整条机制已摘除** —— 荒诞 / 不合理输入一律由模型按
//    世界观合理化（那是核心玩法），不再给模型拒绝的 api 渠道（`verdict` 无「拒绝」、
//    `reject_reason` / `reject_note` 两字段已删）。
export const VERDICTS = ['本次不裁定', '无需判定', '直接成功', '直接失败', '投骰'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const DIFFICULTIES = ['无修正', '惩罚1', '惩罚2', '奖励1', '奖励2'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export type DirectResult = '无' | Tier;

export interface Check {
  verdict: Verdict;
  participants: AttrKey[];
  difficulty: Difficulty;
  direct_result: DirectResult;
}

// ── 欲向（§三）五档 ─────────────────────────────────────────
export const DESIRE_TIERS = ['无关', '偏离', '趋近', '得偿', '盛宴'] as const;
export type DesireTier = (typeof DESIRE_TIERS)[number];

/** 档 A 的 options[].欲向 只允许这三档（不含 得偿 / 盛宴） */
export const POPUP_DESIRE_TIERS: readonly DesireTier[] = ['无关', '偏离', '趋近'];

// ── 处理方式限制（§6.4 `CanvasEvent.dispatchable`）─────────────
// ⚠️ 这个 enum 曾经**只活在 schema 里**（给模型当提示词用），规则层一行都没读
//    ⇒「只能派人去」是一条**纸上机制**（与旧 `race` / `identity` 同一类 bug）。
//    2026-09-19 起由 `rules/gates.ts` 的闸门 ③ 真正执行 —— 改这里必须同时看它。
export const DISPATCHABLES = ['两者皆可', '仅亲自', '仅派遣'] as const;
export type Dispatchable = (typeof DISPATCHABLES)[number];

// ── 物品加成 ────────────────────────────────────────────────
export interface AttrBonus {
  attr: AttrKey;
  bonus: number;
}

// ── Delta（§6.1）—— 键名即判别符 ─────────────────────────────

/**
 * 新人物**出场时的归属**（2026-09-22 新增 · `NewPerson` 专用）。
 * ⚠️ 用中文枚举而不是 boolean，是为了让 schema 的 description 能配上话 ——
 *    这一格问的是「谁算你的人」，必须由模型**显式表态**，不能靠 `true/false` 的默认值糊过去。
 */
export const NEW_PERSON_AFFILIATIONS = ['入队', '不入队'] as const;
export type NewPersonAffiliation = (typeof NEW_PERSON_AFFILIATIONS)[number];

/**
 * 既有角色的**归属变更**（2026-09-22 新增 · `ChangeEntry` 专用）。
 * ⚠️ 必须是**三态**：strict 模式下 `ChangeEntry` 每次都要填满，若只有两态，
 *    模型每写一次 change 就被迫对「他是不是你的人」表态一次 —— 而绝大多数结算里
 *    根本没有这种事发生。`保持` 就是「这次不提这一格」。
 */
export const AFFILIATION_MOVES = ['保持', '入队', '离队'] as const;
export type AffiliationMove = (typeof AFFILIATION_MOVES)[number];

export interface NewPerson {
  id: string; // 批次内临时编号（@p1）
  etype: 'person';
  name: string;
  desc: string;
  race: string;
  basic: string;
  identity: string;
  attrs: Attrs;
  attr_bonus: AttrBonus[];
  in_your_eyes: string;
  openness: number;
  items: string[];
  /**
   * **他登场时就属于你吗**（2026-09-22 新增）。
   * ⚠️ 与 `ChangeEntry.affiliated` 是**两条不同的通道**：这里管「刚登场时算不算你的人」，
   *    那边管「既有角色改判归属」。两条落进账本都是 `Person.affiliated`（boolean）。
   * ⚠️ 缺失 / 非法一律落成 `不入队` —— 与升级之前的实际行为**完全一致**
   *    （落 person 本就不带这一列 ⇒ 运行期 undefined ⇒ 恒未入队）⇒ 老夹具不漂。
   */
  affiliated: NewPersonAffiliation;
}

export interface NewItem {
  id: string; // 批次内临时编号（@it1）
  etype: 'item';
  /** **物品大类**（`装备` / `消耗品` / `特殊物品`）—— 全链路恒存的那一档分类 */
  kind: string;
  name: string;
  desc: string;
  attr_bonus: AttrBonus[];
  holder: string;
}

export interface NewPlace {
  id: string; // 批次内临时编号（@loc1）
  etype: 'place';
  name: string;
  desc: string;
}

export type NewEntity = NewPerson | NewItem | NewPlace;

export interface ChangeEntry {
  who: string; // 正式 id / 角色词 / 本批临时编号
  hp: number;
  san: number;
  attrs: Array<{ attr: AttrKey; delta: number }>;
  in_your_eyes: string;
  openness: number;
  /**
   * **归属变更**（2026-09-22 新增）：`保持` / `入队` / `离队`。
   * 落进账本就是 `Person.affiliated`（⇒ 直接决定他能不能被派遣、以及算不算进 X）。
   */
  affiliated: AffiliationMove;
}

export interface GoldOp { gold: number }
export interface RepOp { rep: Partial<Rep5> }
export interface EntitiesOp { entities: { places?: NewPlace[]; people?: NewPerson[]; items?: NewItem[] } }
export interface ChangeOp { change: ChangeEntry[] }
export interface LostOp { lost: { people?: string[]; items?: string[] } }

export type DeltaOp = GoldOp | RepOp | EntitiesOp | ChangeOp | LostOp;
export type Delta = { ops: DeltaOp[] };

export const OP_KEYS = ['gold', 'rep', 'entities', 'change', 'lost'] as const;
export type OpKey = (typeof OP_KEYS)[number];

/**
 * ⚠️ **它是数组、不是对象**（2026-09-21 更正为与 schema 一致）。
 *
 * 此前这里写的是 `{ produced: [...], recalled: [...] }` —— 与《契约.md》§6.2 的
 * `"type": "array"` 和 `schema/defs.ts·VOUCHERS` **都不一致**。而真正决定模型输出形状的是
 * **schema**（服务端不校验取值、但 `tool_choice` 会按它要参数）⇒ 落地层
 * （`ledger/vouchers.ts`）必须按**数组**读。这份类型只是在追认 schema，不是第二个事实源。
 *
 * ⚠️ 五个字段**全必填**（strict 模式）—— `produce` 时不适用的引用位**填空字符串**。
 */
export interface VoucherDecl {
  /** 三个维度之一 */
  dim: VoucherDim;
  /** `produce` = 本次新增一条；`recall` = 撤回一条已有的 */
  action: 'produce' | 'recall';
  /**
   * 仅 `the_great_achievement` 用：绑定的**物件 id**。
   * `produce` 可填本批临时编号（`@it1`，与本批 `entities.items` 里的 `id` 一致）或既有物品的正式 id；
   * `recall` **只能**填失效那件既有物品的正式 id（系统会一并把它移出账本）。其余维度填空串。
   */
  item: string;
  /**
   * 仅 `the_resonance_of_the_other` 用：绑定的**人物 id**（`@p1` 或 `npc003`）。其余维度填空串。
   * ⚠️ `the_proper_way` 的「事件」引用**不由模型给** —— 系统落地时自动绑定本次结算的事件 id。
   */
  person: string;
  /** 这条凭证的【描述】（给玩家在最终清单里看的说明）。`recall` 时填撤回原因，可空串。 */
  desc: string;
}

export type Vouchers = VoucherDecl[];

/** 凭证三维 —— 必须与 `schema/defs.ts` 的 `Vouchers.items.dim` 枚举**逐字一致**（同 `ITEM_KINDS` 的镜像纪律） */
export const VOUCHER_DIMS = ['the_great_achievement', 'the_proper_way', 'the_resonance_of_the_other'] as const;
export type VoucherDim = (typeof VOUCHER_DIMS)[number];

/**
 * 三个维度的**具名常量** —— 由 `VOUCHER_DIMS` 的下标取出（不是另抄一遍字面量）
 * ⇒ 枚举若改了，这里会跟着改，不会悄悄漂移。全项目引用这三个名字，别写裸字符串。
 */
export const VOUCHER_ACHIEVEMENT = VOUCHER_DIMS[0];
export const VOUCHER_WAY = VOUCHER_DIMS[1];
export const VOUCHER_RESONANCE = VOUCHER_DIMS[2];

// ── resolve 的完整输出（Phase 2 用；本阶段只用于类型占位）────────
export interface ResolveOutput {
  intent_summary: string;
  check: Check;
  narration: string;
  delta: Delta;
  scene_over: boolean;
  summary: string;
  next_seeds: string[];
  vouchers: Vouchers;
  欲向: DesireTier;
}
