// 批（Batch）—— 唯一写入口的累加器
//
// 《契约.md》§6.11：**批 = 一次向玩家呈现结果的时刻**（点选档 A / 排布 / 多轮每轮 /
// 场景收尾 / 揭晓）。批内所有 Delta **只累加、不中途钳**，批末**统一钳一次**。
// 理由：结算可能并行（同一段行动点里玩家与下属同时跑完、揭晓时多个到期事件同时落账，彼此看不见）
// ⇒ "够不够"**不能在单条结算里判**。`余额 ← max(0, 余额 + ΣΔ)` 与批内顺序无关。
import { ATTR_KEYS, REP_KEYS, type AttrKey, type NewItem, type NewPerson, type NewPlace, type RepKey } from '../contract/types.ts';
import { cloneWatermark, initialWatermark, type IdWatermark } from './ids.ts';
import type { RecallRequest, VoucherRecord } from './types.ts';

export interface Batch {
  gold: number;
  rep: Record<RepKey, number>;
  hp: Record<string, number>;
  san: Record<string, number>;
  attrs: Record<string, Record<AttrKey, number>>;
  openness: Record<string, number>;
  /** ⚠️ **覆盖型**：同一人在同一批里出现多次，**以最后一条为准**（全系统唯一的顺序敏感字段） */
  inYourEyes: Record<string, string>;
  /**
   * **归属变更**（2026-09-22 新增）—— 同样是**覆盖型**：同一批里对同一人给了两次相反表态，
   * 以**最后一条**为准。⚠️ 它**不是累加型** —— `affiliated` 是布尔，「入队 + 入队」没有意义。
   */
  affiliated: Record<string, boolean>;
  entities: { places: NewPlace[]; people: NewPerson[]; items: NewItem[] };
  lost: { people: string[]; items: string[] };
  /** 系统独写（LLM 摸不到）：欲念 */
  desire: number;
  /**
   * 系统独写：**下属的容量预算**。
   * ⚠️ 玩家的**时间**预算不在这里 —— 它是 `clock.usedToday`，由时间流逝层推进，不经 Batch。
   */
  actionPoints: { byNpc: Record<string, number> };
  /** 用掉的物品 —— ⚠️ **至今无人往里写**（消耗走 `rules/ability.ts·consumeOneShots`，不走这里）*/
  consumeItems: string[];
  /**
   * **凭证产出**（账本第 8 组）。
   * ⚠️ 它为什么不走 `Delta`：《契约.md》§6.2 明写「凭证不进 `Delta`」——
   *    三种结局凭证由 `resolve` 的独立字段 `vouchers` 声明，翻译与钳制在 `ledger/vouchers.ts`。
   */
  vouchers: VoucherRecord[];
  /** **凭证收回请求**（每次结算至多 1 条 · 批末按它去标 `recalled_day`） */
  vouchersRecalled: RecallRequest[];
  /** 「系统已落账」清单碎片 —— 供 Phase 3 拼装结算指令 */
  notes: string[];
  // ── 批内 id 工作区（跨多次 applyDelta 共享，避免同批撞号）──
  idWatermark: IdWatermark;
  /** 临时编号 → 正式 id */
  tempIds: Record<string, string>;
}

export function emptyBatch(ledger?: { idWatermark: IdWatermark }): Batch {
  const rep = {} as Record<RepKey, number>;
  for (const k of REP_KEYS) rep[k] = 0;
  return {
    gold: 0,
    rep,
    hp: {},
    san: {},
    attrs: {},
    openness: {},
    inYourEyes: {},
    affiliated: {},
    entities: { places: [], people: [], items: [] },
    lost: { people: [], items: [] },
    desire: 0,
    actionPoints: { byNpc: {} },
    consumeItems: [],
    vouchers: [],
    vouchersRecalled: [],
    notes: [],
    idWatermark: ledger ? cloneWatermark(ledger.idWatermark) : initialWatermark(),
    tempIds: {},
  };
}

export function foldChange(
  b: Batch,
  who: string,
  c: {
    hp: number;
    san: number;
    attrs: Array<{ attr: AttrKey; delta: number }>;
    in_your_eyes: string;
    openness: number;
    /** 归属变更（2026-09-22 新增）。**可选**：老夹具不带这一格 ⇒ 视为「保持」 */
    affiliated?: string;
  },
): void {
  if (c.hp) b.hp[who] = (b.hp[who] ?? 0) + c.hp;
  if (c.san) b.san[who] = (b.san[who] ?? 0) + c.san;
  if (c.openness) b.openness[who] = (b.openness[who] ?? 0) + c.openness;
  if (c.attrs.length > 0) {
    const row = b.attrs[who] ?? (b.attrs[who] = {} as Record<AttrKey, number>);
    for (const a of c.attrs) {
      if (!ATTR_KEYS.includes(a.attr)) continue;
      row[a.attr] = (row[a.attr] ?? 0) + a.delta;
    }
  }
  // 覆盖型：非空才覆盖（空串在契约里是"无变化"的哨兵）
  if (c.in_your_eyes) b.inYourEyes[who] = c.in_your_eyes;
  // 覆盖型（归属）：三态里只有「入队」「离队」动手；「保持」与缺失都等于不动
  if (c.affiliated === '入队') b.affiliated[who] = true;
  else if (c.affiliated === '离队') b.affiliated[who] = false;
}

/** 批是否什么都没改（用于"跳过落盘"的短路） */
export function batchIsEmpty(b: Batch): boolean {
  return (
    b.gold === 0 &&
    Object.values(b.rep).every((v) => v === 0) &&
    Object.keys(b.hp).length === 0 &&
    Object.keys(b.san).length === 0 &&
    Object.keys(b.attrs).length === 0 &&
    Object.keys(b.openness).length === 0 &&
    Object.keys(b.inYourEyes).length === 0 &&
    Object.keys(b.affiliated).length === 0 &&
    b.entities.places.length === 0 &&
    b.entities.people.length === 0 &&
    b.entities.items.length === 0 &&
    b.lost.people.length === 0 &&
    b.lost.items.length === 0 &&
    b.vouchers.length === 0 &&
    b.vouchersRecalled.length === 0 &&
    b.desire === 0 &&
    Object.keys(b.actionPoints.byNpc).length === 0
  );
}
