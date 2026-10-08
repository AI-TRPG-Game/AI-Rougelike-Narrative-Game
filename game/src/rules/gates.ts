// 闸门 9 条，LLM 无权放行」
//
// `evalGates` 一律返回**完整的 9 条**（不适用也算一条，标 pass + 原因），这样 UI 与测试都能拿到稳定形状。
//
// ⚠️ **别把 `evalGates` 的 9 与 `gatesOf()` 的 10 混为一谈**（审计 C2 记过这一条）：
//    `gatesOf()`（本文件末尾）返回的是 **10 条** = 这 9 条闸门 ＋ 末条 `gateSnapshotOf` 的
//    「**当前状态**」快照行。快照行**不是闸门**、只是读数；它与闸门 ① **同名**（都是 `ACTION_POINTS`），
//    所以任何"面板平铺 10 行"或"标题写死 9 条 / 10 条"的写法都会出错 ——
//    P5-B 已经把它拆成独立导出，面板不把它列进任何一栏。
//
// ⚠️ 2026-09-18 时钟模型改造后的判据切换（**这是本次改动最容易埋雷的地方**）：
//    · 闸门 ① 的「行动点」不再是 `actionPoints.player`，而是**时间轴读数** `clock.usedToday`；
//      并且它**不再拦 `advanceDay`** —— "进下一天"恰恰是时间用尽后**唯一**的出路。
//    · 闸门 ② 分两种语义：`cost ≤ 4`（单日事件）要求该人**今天剩余够做完**；
//      `cost > 4`（跨天事件）只要求**今天还能启程**（他启程时把当天剩余一次性扣走）。
import type { GateCode, GateResult, Ledger, Person } from '../ledger/types.ts';
import { PLAYER_ID, findPerson, isAvailable, player } from '../ledger/types.ts';
import { nowOf, reached, remainingToday } from './clock.ts';
import { availableToday, BASE_ACTION_POINTS } from './x.ts';

/** 每人携带位 */
export const CARRY_CAP = 4;

export type GateAction = 'handle' | 'reveal' | 'advanceDay' | 'pay' | 'dial' | 'cross';

export interface GateInput {
  ledger: Ledger;
  today: number;
  action: GateAction;
  eventId?: string;
  participants?: string[];
  goldToPay?: number;
  /** 拨时针的点数（闸门 ⑩ 用；不在 9 条内，见 `dialRange`） */
  dialPoints?: number;
  /** 装填动作：要把哪些物品给谁 */
  loadItems?: string[];
  loadTo?: string;
}

function g(code: GateCode, pass: boolean, reason: string): GateResult {
  return { code, pass, reason };
}

export function evalGates(input: GateInput): GateResult[] {
  const { ledger: l, today } = input;
  const ev = input.eventId ? l.events.live.find((e) => e.id === input.eventId) : undefined;
  const parts: Person[] = (input.participants ?? []).map((id) => findPerson(l, id)).filter((p): p is Person => !!p);
  const results: GateResult[] = [];

  // ① 玩家当日时间已用尽（4/4）⇒ 不能**新开**排布与支付，只能进入下一天
  {
    const left = remainingToday(l);
    // ⚠️ 不拦 `advanceDay`：进下一天是时间用尽后的唯一出路，拦它 = 死锁。
    // ⚠️ 不拦 `dial` / `cross`：它们的合法性由 `dialRange` 与"事件是否已排布"决定。
    const applies = input.action === 'handle' || input.action === 'pay';
    results.push(
      applies && left <= 0
        ? g('ACTION_POINTS', false, `玩家当日时间已用尽（${l.clock.usedToday}/${BASE_ACTION_POINTS}）⇒ 只能进入下一天`)
        : g(
            'ACTION_POINTS',
            true,
            applies ? `玩家当日剩余时间 ${left}/${BASE_ACTION_POINTS}` : '本次动作不受玩家时间约束',
          ),
    );
  }

  // ② 该参与者当日容量不够做完（单日）/ 不够启程（跨天）
  {
    if (!ev || parts.length === 0) {
      results.push(g('PARTICIPANT_BUDGET', true, '本次动作不派参与者'));
    } else {
      const singleDay = ev.cost <= BASE_ACTION_POINTS;
      const lacks = (p: Person): boolean => {
        // ⚠️ 玩家的时间预算记在 `clock.usedToday`（闸门 ① 专管），**不在 `byNpc` 里**。
        //    这里若不排除玩家，就会拿一个"从来没人重置过"的 `byNpc['npc000']` 幽灵计数去卡他。
        if (p.id === PLAYER_ID) return false;
        // ⚠️ 2026-10-08 起：容量是**时间流速 + 今日已承诺**的合成读数（`availableToday`）——
        //    拨时间全员一起掉（闲置者也掉），排布占的是「今日已承诺」那份。
        const left = availableToday(l, p, today);
        return singleDay ? left < ev.cost : left <= 0;
      };
      const bad = parts.filter(lacks);
      results.push(
        bad.length === 0
          ? g(
              'PARTICIPANT_BUDGET',
              true,
              singleDay
                ? `${parts.length} 人当日剩余均 ≥ 处理时长 ${ev.cost}`
                : `${parts.length} 人当日均还能启程（跨天事件，占今日剩余）`,
            )
          : g(
              'PARTICIPANT_BUDGET',
              false,
              bad
                .map((p) => {
                  const left = availableToday(l, p, today);
                  return singleDay
                    ? `${p.name}(${p.id}) 剩余 ${left} < 处理时长 ${ev.cost}`
                    : `${p.name}(${p.id}) 剩余 ${left} ⇒ 今天已无法启程`;
                })
                .join('；'),
            ),
      );
    }
  }

  // ③ 「派遣」这条路走不走得通 —— 两层判据，**都不在 LLM 手里**：
  //    · 人的状态：已派遣未归还 / HP ≤ 1 / SAN ≤ 1 / 死亡或疯狂（`isAvailable`）；
  //    · 事件的**处理方式限制**（`dispatchable`）：「仅亲自」不许派人、「仅派遣」不许玩家自己上。
  //      ⚠️ 2026-09-19 补：此前 `dispatchable` **只写在 schema 里**（当提示词用），规则层一行没读
  //      ⇒「只能派人去」在实现里**根本不存在**（与旧 `race` / `identity` 同类：schema-only 假机制）。
  {
    const bad = parts.filter((p) => p.id !== PLAYER_ID && !isAvailable(p, l, today));
    const troubles: string[] = bad.map((p) => `${p.name}(${p.id}) 不可派遣（HP ${p.hp} / SAN ${p.san}）`);

    const dispatched = parts.filter((p) => p.id !== PLAYER_ID);
    if (ev && ev.dispatchable === '仅亲自' && dispatched.length > 0) {
      troubles.unshift(
        `「${ev.title}」限**亲自**处理 ⇒ 不能派 ${dispatched.map((p) => `${p.name}(${p.id})`).join('、')}`,
      );
    }
    if (ev && ev.dispatchable === '仅派遣' && parts.some((p) => p.id === PLAYER_ID)) {
      troubles.unshift(`「${ev.title}」限**派遣**处理（远征 / 潜伏这类长离岗的事）⇒ 玩家本人去不了`);
    }
    // · **非他不可**（`required_person`，2026-09-22 落地）：说的是「**必须包含他**」——
    //   允许再带帮手，与 `max_people` **各自独立算**（两条理由能同时报出来）。
    //   ⚠️ 他**不可用**时不另开口子：上面 `bad` 那条已经把理由报出来了（受伤 / 已派出 / 尚未入队），
    //     玩家该做的就是**等**（`deadline` 过期结算就是那条逃生通道）。
    //   ⚠️ 复用本闸门、**不加第 10 条**：`GateCode` 是封闭联合，加一条要动《规则.md》§四 A
    //     与 UI 分栏、以及「恰好 9 条」的断言（2026-09-20 用户裁定）。
    if (ev && ev.required_person) {
      const req = l.entities.people.find((x) => x.id === ev.required_person);
      const reqWho = req ? `${req.name}(${req.id})` : `未知(${ev.required_person})`;
      if (!parts.some((x) => x.id === ev.required_person)) {
        troubles.unshift(`「${ev.title}」非 ${reqWho} 不可 ⇒ 这次去的人里必须有他（其余的人照派）`);
      }
    }

    results.push(
      parts.length === 0
        ? g('CANNOT_DISPATCH', true, '本次动作不派参与者')
        : troubles.length === 0
          ? g('CANNOT_DISPATCH', true, '全部参与者可派遣')
          : g('CANNOT_DISPATCH', false, troubles.join('；')),
    );
  }

  // ④ 档 A（强制弹窗）未清 ⇒ 禁止进下一天
  // ⚠️⚠️ 2026-10-07 用户裁定：**档 A 与常规事件同级** ——「要允许玩家在未处理预生成结算类的
  //   事件时，也能点击常规事件（相当于这些事件同级了）」⇒ `handle`（排布 / 自建 / 进场景）
  //   **不再被档 A 拦**；只剩「进下一天」还要求先清档 A（跳过一整天等于把强制事件扔下不管，
  //   那一步要不要一起放开，等用户单独裁定）。
  {
    const pending = l.events.live.filter((e) => e.tier === 'A' && e.status === '待处理');
    const applies = input.action === 'advanceDay';
    results.push(
      pending.length === 0 || !applies
        ? g('POPUP_PENDING', true, pending.length === 0 ? '无未清的档 A' : '本次动作不受档 A 约束')
        : g('POPUP_PENDING', false, `档 A 未清 ${pending.length} 条：${pending.map((e) => e.title).join('、')}`),
    );
  }

  // ⑤ 携带位已满 / 物品已被他人持有
  {
    const problems: string[] = [];
    if (input.loadTo && input.loadItems) {
      const who = findPerson(l, input.loadTo);
      if (!who) problems.push(`装填对象 ${input.loadTo} 不存在`);
      else {
        const now = who.items.length;
        if (now + input.loadItems.length > CARRY_CAP) {
          problems.push(`${who.name} 携带位已满（${now} + ${input.loadItems.length} > ${CARRY_CAP}）`);
        }
        for (const id of input.loadItems) {
          const it = l.entities.items.find((x) => x.id === id);
          if (it && it.holder && it.holder !== who.id) problems.push(`${it.name} 已被 ${it.holder} 持有`);
        }
      }
    }
    // 不变式：未消耗的物品至多属于一个人（双持是账本自身的 bug，顺手抓）
    for (const p of l.entities.people) {
      if (p.items.length > CARRY_CAP) problems.push(`${p.name} 携带 ${p.items.length} 件，超出 ${CARRY_CAP} 位`);
    }
    results.push(
      problems.length === 0
        ? g('CARRY_OR_HOLDER', true, input.loadItems ? '装填合法' : '本次动作不涉及装填')
        : g('CARRY_OR_HOLDER', false, problems.join('；')),
    );
  }

  // ⑥ 参与人数少于事件 min_people ⇒ 禁止处理（人不够，UI 置灰）
  {
    const n = parts.length;
    if (!ev || n === 0) results.push(g('MIN_PEOPLE', true, '本次动作不派参与者'));
    else if (n < ev.min_people) results.push(g('MIN_PEOPLE', false, `参与 ${n} 人 < 最少 ${ev.min_people} 人`));
    else results.push(g('MIN_PEOPLE', true, `参与 ${n} 人 ≥ 最少 ${ev.min_people} 人`));
  }

  // ⑦ 参与人数超出事件 max_people ⇒ 禁止再派人
  {
    const n = parts.length;
    if (!ev || n === 0) results.push(g('MAX_PEOPLE', true, '本次动作不派参与者'));
    else if (n > ev.max_people) results.push(g('MAX_PEOPLE', false, `参与 ${n} 人 > 上限 ${ev.max_people} 人`));
    else results.push(g('MAX_PEOPLE', true, `参与 ${n} 人 ≤ 上限 ${ev.max_people} 人`));
  }

  // ⑧ 时间还没走到 `reveal_at` ⇒ 不产出结果
  {
    const now = nowOf(l);
    if (input.action !== 'reveal') {
      results.push(g('NOT_REVEALED', true, '本次动作不是揭晓'));
    } else if (!ev) {
      results.push(g('NOT_REVEALED', false, '揭晓目标事件不存在'));
    } else if (ev.reveal_at === null) {
      results.push(g('NOT_REVEALED', false, `${ev.title} 尚未排布，没有揭晓时刻`));
    } else if (!reached(now, ev.reveal_at)) {
      results.push(
        g('NOT_REVEALED', false, `${ev.title} 揭晓于第 ${ev.reveal_at.day} 天第 ${ev.reveal_at.used} 点 > 现在`),
      );
    } else {
      results.push(g('NOT_REVEALED', true, `${ev.title} 已到揭晓时刻（第 ${ev.reveal_at.day} 天）`));
    }
  }

  // ⑨ 应付金币 > 当前余额 ⇒ 禁止提交该支付（医馆 / 神殿同理）
  {
    const need = input.goldToPay ?? 0;
    if (need <= 0) results.push(g('GOLD_INSUFFICIENT', true, '本次动作无需付金币'));
    else if (need > l.scalars.gold)
      results.push(g('GOLD_INSUFFICIENT', false, `应付 ${need} > 余额 ${l.scalars.gold}`));
    else results.push(g('GOLD_INSUFFICIENT', true, `应付 ${need} ≤ 余额 ${l.scalars.gold}`));
  }

  return results;
}

export function blocked(results: readonly GateResult[]): GateResult[] {
  return results.filter((r) => !r.pass);
}

export function gatesOf(l: Ledger, today: number): GateResult[] {
  return evalGates({ ledger: l, today, action: 'handle' }).concat([gateSnapshotOf(l)]);
}

/**
 * 面板用的「**当前状态**」快照行 —— ⚠️ **它不是闸门**（虽然 `code` 与闸门 ① 同名）。
 *
 * 它答的是另一个问题：**现在的读数**（玩家剩余时间 ＋ HP ＋ SAN，一屏看完）。
 * 闸门 ① 问的是"现在还能不能新开排布／支付" —— 判据（`remainingToday`）重叠、**理由不同**。
 *
 * ⚠️ P5-B（2026-09-22）之前，面板把 `gatesOf` 的 10 条一栏平铺 ⇒ **首尾两条同名**，
 *    看起来像闸门 ① 被列了两遍。现在它是**独立导出的一行**，面板拿它当读数渲染，
 *    **不列进任何一栏**（分栏/去噪的那一处修的就是它）。
 */
export function gateSnapshotOf(l: Ledger): GateResult {
  return g(
    'ACTION_POINTS',
    remainingToday(l) > 0,
    `玩家当日剩余时间 ${remainingToday(l)}/${BASE_ACTION_POINTS} · ${player(l).name} HP ${player(l).hp} SAN ${player(l).san}`,
  );
}

// ── 面板分栏（P5-B · 2026-09-22）────────────────────────────────
//
// 9 条闸门按「**它到底在拦什么**」分两栏。判据住在规则层 —— UI **不许**自己再编一份分类
// （`ui/index.html` 只读视图里的 `lane`）。
//
//   · 「**动作拦截**」= 与**具体哪条事件无关**、决定"现在还能不能点"的那几条
//     （时间用尽 / 档 A 未清 / 还没到揭晓点）⇒ 玩家的感受是"**按钮点了没反应**"。
//   · 「**控件置灰**」= 必须**对着一条具体待办**才算得出来的那几条
//     （人选不出来 / 人数不合 / 金币不够 / 携带位满）⇒ 玩家的感受是"**那个按钮是灰的**"。
//
// ⇒ 一栏平铺的代价：还没有任何动作时，后六条齐刷刷写着「本次动作不派参与者」——
//    六行空话把前三条真正的拦截淹掉。分栏之后每栏只说自己那一类。
export type GateLane = '动作拦截' | '控件置灰';

export const GATE_LANE: Record<GateCode, GateLane> = {
  ACTION_POINTS: '动作拦截',
  POPUP_PENDING: '动作拦截',
  NOT_REVEALED: '动作拦截',
  PARTICIPANT_BUDGET: '控件置灰',
  CANNOT_DISPATCH: '控件置灰',
  CARRY_OR_HOLDER: '控件置灰',
  MIN_PEOPLE: '控件置灰',
  MAX_PEOPLE: '控件置灰',
  GOLD_INSUFFICIENT: '控件置灰',
};
