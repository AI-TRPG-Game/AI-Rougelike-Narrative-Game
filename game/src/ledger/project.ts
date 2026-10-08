// 投影层**接口** —— Phase 1 只定形状，Phase 2 才真正拼 prompt。
//
// 《契约.md》§6.11：账本里**没有"给谁看"的字段** —— 是否注入由**标签与调用点**决定，不由数据决定。
// 所以这张"字段组 → 标签"表就是「账本 → 上下文」映射的唯一事实源。
import type { Ledger } from './types.ts';

export type InjectTag = '①' | '③' | '派生' | '永不';

export const FIELD_TAGS: Record<keyof Ledger, InjectTag> = {
  clock: '永不',
  entities: '①', // ⚠️ 组内分裂：身份骨架 → ①，状态 → ③（见下方 SPLIT_TAGS）
  scalars: '③',
  events: '③',
  /**
   * ⚠️⚠️ **`pending` 是"已经发生了、但玩家还不知道"的未来** —— 必须 永不。
   * 这一行就是"算 / 揭分离"的防剧透底线：漏掉它 ⇒ 预计算结果会随 `events` 一起进 prompt，
   * LLM 会把玩家还没等到的结果当既成事实写出来（而且**不会报错**，只是剧情提前泄底）。
   * Node 的 type stripping **不做类型检查** ⇒ 这里少一个 key 不会有人告诉你。
   */
  pending: '永不',
  summaries: '③',
  seeds: '③',
  divination: '③',
  vouchers: '派生',
  desire: '永不', // ⚠️ 组内分裂：proposition → ③（首块【他的欲望】常驻）
  scene: '③',
  roll: '永不', // ⚠️ 只回填 {档位, 加成}
  gates: '永不',
  /**
   * ⚠️ **终局（放格子 ＋ 结局）**：平时是 `null` ⇒ 与 `scene` 同族，靠"平时没有"自然不进主链 prompt。
   * 标 永不 的理由：**结局名与话术只给 UI**（判定依据 `reason` 更是只有开发者要）；
   * 唯一要注入的那一块（"放格子结果"进 `ending` 的 user ③）由 §5.8 单独点名，
   * **不是通用 ③** —— 随主链注入会让每次调用都多出两块"（未定）"。
   */
  ending: '永不',
  actionPoints: '永不',
  idWatermark: '永不',
  /**
   * ⚠️ **2026-10-08 用户第 5 条（难度选择）**：`difficulty` 只喂 `renderStaticHead` ——
   * 装配 system 段 ① 时**按档挑人设**（`staticProseOf`），不进任何一次调用的 user ③ 块，
   * 也不该让模型在上下文里看见"难度"这个概念本身 ⇒ 标 永不（与 `ending`「只给 UI」同族：
   * 那行是"只给 UI"，这行是"只给 system 装配"）。
   */
  difficulty: '永不',
  /**
   * ⚠️ **2026-09-20 补**：`repMarks`（每格声望的 10 / 15 / 20 **哪几档已经出过种**）
   * 是 P4-E 加进账本的顶层字段，但**本表漏了它一行** —— 于是它不属于任何一个组：
   * `groupsWithTag` 四个组都查不到它，`projectionPlan().never` 也不列它。
   * 症状不是崩溃，是**静默**（这张表是"账本 → 上下文"的唯一事实源，漏一行就等于
   * 声明了一条不存在的字段、同时让一条真实存在的字段没有归属）。
   * 业务上它显然是**永不**：出种记账只有规则层要读，模型一个字都不该看见。
   * ⇒ 同批补了 `test/ledger.test.ts` 的完整性守卫：表必须与 `Object.keys(initialLedger())`
   *    **一一对应**，多一条少一条都红。
   */
  repMarks: '永不',
};

/** 组内分裂的字段（唯一事实源仍是《契约.md》§6.11 那张表） */
export const SPLIT_TAGS: Record<string, { part: string; tag: InjectTag }[]> = {
  entities: [
    { part: '身份骨架（name/race/basic/identity/kind/desc/attr_bonus）', tag: '①' },
    { part: '状态（attrs/status/in_your_eyes/openness/holder/已给出的认可）', tag: '③' },
  ],
  desire: [
    // ⚠️ `cards`（开局两张原卡）属「永不」：它是**判定依据**、不是展示内容 ——
    //    命中的**后果**由规则层算完（系统查表 ±10），模型不需要看见那两张牌叫什么。
    //    把它当 ③ 注入，等于让主链每一次调用都多看两行与它无关的牌名。
    { part: 'value / past / cards（判定依据）', tag: '永不' },
    { part: 'proposition（首块【他的欲望】· 常驻）', tag: '③' },
  ],
  roll: [
    { part: 'd20 / A / R', tag: '永不' },
    { part: '{档位, 加成}', tag: '③' },
  ],
  ending: [
    { part: '结局名 / 话术 / 判定依据（只给 UI）', tag: '永不' },
    { part: '放格子结果（**只给 `ending` 那一次** user ③ —— §5.8，不是通用 ③）', tag: '③' },
  ],
};

export function groupsWithTag(tag: InjectTag): string[] {
  return (Object.keys(FIELD_TAGS) as (keyof Ledger)[]).filter((k) => FIELD_TAGS[k] === tag);
}

/**
 * Phase 2 的入口占位。现在只回答"这次调用该看到哪些组"，
 * 真正把内容拼成文本是 Phase 2 的事。
 */
export function projectionPlan(): { system1: string[]; user3: string[]; derived: string[]; never: string[] } {
  return {
    system1: groupsWithTag('①'),
    user3: groupsWithTag('③'),
    derived: groupsWithTag('派生'),
    never: groupsWithTag('永不'),
  };
}
