// 竖切的输入：一条**手写的事件卡**
//
// `compose_day` 是 Phase 3 的事，所以 Phase 2 的竖切必须**自带燃料**——这就是那块燃料。
// （⚠️ 生成半已于 2026-09-19 落地，但竖切**刻意仍自带燃料**：它只想验"一条事件走完全程"，
//   不需要一堆别的自由事件掺进来。要走生成半就用 28 天无头驱动。）
//
// ⚠️ 沿用夹具纪律：顶栏要写明**"这是真实 LLM 大概会怎么产"的理由**。
//    事件卡本身要进 user ③ 的【事件卡】块 ⇒ **它同时是被测对象的一部分**，所以：
//    · **文案要正经、可信**
//      真实的规则、真实的后果、不配合表演。你生成的事件要正经、可信"；
//    · **参考属性给 1~3 个**（`participants` 的上限就是 3，`calcA` 也会断言）；
//    · **`min_gold > 0`** —— 让"托管投入 / 结算退差额"这条路径**真的被走到**，
//      而不是"绿了但没测到"。
//
// ⚠️ 用的是 `ledger/initial.ts` 那套**最小假数据**（三王子 / 护卫 / 文书；金庭 / 下城），
//    所以地点固定写 `loc002`。真实开局数据（10 人 / 9 地点 / 序幕）属 Phase 4。
import type { AttrKey, Difficulty } from '../contract/types.ts';
import { initialLedger } from '../ledger/initial.ts';
import { PLAYER_ID, type GameEvent, type Ledger } from '../ledger/types.ts';

/** 形状照《契约.md》§6.4 的 `CanvasEvent`（这里手写，不经 LLM） */
export interface EventCardSpec {
  title: string;
  /** 地点 —— 用账本里**已有**的 `loc` id（新地点的登记由生成半的落地层负责） */
  location: string;
  /**
   * **显示用地点名** —— 就是《契约.md》§6.4 里 LLM 会写的那个 `stage` 字符串。
   * ⚠️ 它与 `location`（id）**必须指同一处**；`makeEventCard` 两个都记下来，
   *    因为【事件卡】块印的是**名字**（`ev.stage`），而账本里的引用/查找用的是 **id**。
   */
  stage: string;
  content: string;
  tier: 'A' | 'B' | 'C';
  hint_attr: AttrKey[];
  min_people: number;
  max_people: number;
  /** 处理时长（行动点）：≤ 4 单日完结；> 4 跨天、且挡位是 4 的倍数 */
  cost: number;
  /** 最低投入（托管 P 的下限） */
  min_gold: number;
  difficulty: Difficulty;
  /** 允许的处理窗口（**天**，挡位 `1 / 2 / 4`；最短 1 天） */
  deadline: number;
}

export const EVENT_CARD: EventCardSpec = {
  title: '下城谷仓的一笔烂账',
  location: 'loc002',
  stage: '下城',
  content:
    '下城的谷物商托人递话上来：去年秋收有一批王粮从他手上过账，账上短了三成。他留着一张签署不全的提货单，只认得出半个火漆印，另半个被人用刀刮去了。他给你的人三天工夫去核这笔账——核不出来，他就把单子直接递到王室审计官那里去。',
  tier: 'B',
  hint_attr: ['智慧', '社交'],
  min_people: 1,
  max_people: 2,
  cost: 2,
  min_gold: 2,
  difficulty: '无修正',
  deadline: 4,
};

export function makeEventCard(spec: EventCardSpec = EVENT_CARD, id = 'e1', day = 1): GameEvent {
  return {
    id,
    title: spec.title,
    content: spec.content,
    stage: spec.stage,
    location: spec.location,
    tier: spec.tier,
    dispatchable: '两者皆可',
    // 竖切那张卡不指定谁非去不可（`EventCardSpec` 因此不加这个字段 —— 不加就没得测）
    required_person: '',
    cost: spec.cost,
    min_gold: spec.min_gold,
    min_people: spec.min_people,
    max_people: spec.max_people,
    deadline: spec.deadline,
    options: [],
    delta: null,
    hint_attr: [...spec.hint_attr],
    difficulty: spec.difficulty,
    status: '待处理',
    created_day: day,
    started_at: null,
    reveal_at: null,
    handler: null,
    participants: [],
    gold_locked: 0,
    depart_cost: null,
  };
}

/**
 * 竖切用的开局：**第 1 天 · 正文**，手上 8 金币，事件池里就这一条卡。
 *
 * ⚠️ 刻意**不走 `turnOver` / `enterDay`** —— 那两条会调 `compose_day`，
 *    竖切只想验"一条事件走完全程"，不需要一堆别的自由事件掺进来。
 */
export function sliceLedger(spec: EventCardSpec = EVENT_CARD): Ledger {
  const l = initialLedger();
  l.clock = { day: 1, phase: '正文', chapter: 1, usedToday: 0 };
  l.scalars.gold = 8;
  l.events.live.push(makeEventCard(spec, 'e1', 1));
  return l;
}

/** 默认处理方案：派**文书**（`npc002`，智慧 15）去核这笔账，按事件最低投入付 2 金币 */
export const DEFAULT_HANDLING = {
  eventId: 'e1',
  participants: ['npc002'] as string[],
  goldInput: EVENT_CARD.min_gold,
  usedItemId: null,
  note: '先去核单子上那半个火漆印，再去谷仓对去年的出入库底账；对不上就别声张。',
};

export { PLAYER_ID };
