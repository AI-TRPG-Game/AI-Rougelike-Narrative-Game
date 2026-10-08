// 「排布一条事件」—— 派遣 / 玩家亲自（不穿越）
//
// 顺序：闸门 → **裁定（LLM）** → 投骰（规则层）→ **结算（LLM）** → 锁金币
//       → 事件进入「揭晓待办」→ 结果存进 `pending`
//       （2026-10-08 起排布**不再即时扣下属容量** —— 容量随时间全员同速流逝，见 `turn/time.ts`）
//
// ⚠️ 2026-09-18 时钟模型改造后，本函数**不再推进玩家时间、也不再当场落账**：
//    · 玩家时间只在 A（场景穿越）/ B（拨时针）/ C（进下一天）三处流动；
//    · 结算结果**现在就调 LLM 算好**（减少延迟），但只进 `Ledger.pending`（注入标签 **永不**），
//      要等时间走到 `reveal_at`、由 `turn/time.ts·revealDue` 兑现。
//    ⇒ "算"与"揭"的分离，在代码结构上是**两个不同的存放位置**，不是一句纪律。
//
// ⚠️ 2026-09-18（Phase 2）**两段式**：`resolve` 的两条走法在这里合流——
//    · `verdict=投骰`  ⇒ 先 `adjudicate`（只出裁定半），规则层投骰，再 `settle`（出结算半）；
//    · 其余三种        ⇒ 模型一次就把两半填完（`settle` 只是**取出**已经拿到的结算半，不再发网络）。
//    ⚠️ 2026-10-07：「拒绝」走法已随整条拒绝机制摘除 —— 荒诞 / 不合理输入由模型按世界观
//      合理化，不再有"当场收口、不落账"的那条支路。
//    ⚠️ 关键纪律：**修正先于叙事** —— 裁定必须在投骰之前定、叙事必须在投骰之后写。
import type { AttrKey, Check, Tier } from '../contract/types.ts';
import { commitBatch } from '../ledger/apply.ts';
import { emptyBatch } from '../ledger/batch.ts';
import { findPerson, PLAYER_ID, type GameEvent, type GateResult, type Ledger } from '../ledger/types.ts';
import { calcA, carriedItems, effectiveAttrsOf, pickLeader } from '../rules/ability.ts';
import { outcomeForNonRoll, resolveRoll, type RollOutcome } from '../rules/check.ts';
import { addPoints, nowOf, reached } from '../rules/clock.ts';
import { dangerZoneOf } from '../rules/desire.ts';
import type { DangerZone } from '../rules/dice.ts';
import { blocked, evalGates } from '../rules/gates.ts';
import type { Rng } from '../rules/rng.ts';
import { availableToday, BASE_ACTION_POINTS } from '../rules/x.ts';
import type { Brain } from './brain.ts';
import { revealDue } from './time.ts';

export interface HandleInput {
  eventId: string;
  participants: string[];
  /** 投入金币（托管 P）；0 = 不投入 */
  goldInput?: number;
  /** 玩家指定使用的物品（无则 null）—— 进【玩家的处理】块，**不自动消耗** */
  usedItemId?: string | null;
  /** 玩家的补充原话（进【玩家的处理】块；没有就空串） */
  note?: string;
  /**
   * ⚠️ **只为调试 / 竖切留下的显式覆写**（`turn/slice.ts` 的 `--zone`）。
   *    不传 ⇒ **由欲念推导**（`dangerZoneOf`）—— 那是唯一正确的来源：
   *    危险区是「欲念 → 危险区 → 判定修正」这条**规则层恒定**链的结果。
   *
   * ⚠️ 2026-09-21 之前这里恒 `?? '正常'`，而**没有任何调用方真的传过它**（UI 侧也没传）
   *    ⇒ 「迷失区 +1d4 不利 / 沉溺区 −1d4 有利」这条规则**从来没有生效过**。
   *    UI 侧现已不再暴露这个参数：它没有资格命名一个危险区。
   */
  zone?: DangerZone;
}

export interface HandleResult {
  ledger: Ledger;
  gates: GateResult[];
  blockedBy: GateResult[];
  /**
   * 模型的裁定半（`verdict` / `participants` / `difficulty`）。
   * ⚠️ **不是为了落账** —— 参与属性与难度都已经折算进档位了；透出来是给竖切报告、日志与 UI 看的。
   */
  check: Check | null;
  roll: RollOutcome | null;
  tier: Tier | null;
  log: string[];
  /** 本次排布里**当场揭晓**了的事件 id（只有 `cost ≤ 0` 会立刻揭晓） */
  revealedNow: string[];
  /**
   * 当场揭晓那几条的**叙事正文**（`{id, text}`，与 `revealedNow` 一一对应）。
   * ⚠️⚠️ 2026-10-07（用户报「结算的所有动画都不能正常显示了」的根因之一）：
   *   揭晓正文住在 `pending.narration` 里，而 `revealDue` 兑现完就把 `pending` 条目删了
   *   ⇒ 会话层事后**再也取不到**，当场揭晓的那几条**从来没播报过** ——
   *   玩家点了 ✔，骰也掷了，结果却一个字的演出都没有。
   *   ⇒ 在 `revealDue` **之前**把正文抓下来带出去，会话层据此补发「揭晓」播报（带骰）。
   */
  revealedTexts: Array<{ id: string; text: string }>;
  /** 模型这句话复述了玩家要干嘛（日志 / UI 确认用） */
  intentSummary: string;
  /** 回填给结算半的加成标签（只会进 `tool` 消息与【判定结果】块） */
  bonuses: string[];
}

/**
 * 参与者逐人的**加成标签**。
 * ⚠️ 只作叙事提示 —— 数值早已由 `calcA(effectiveAttrsOf(...))` 折进 `A` 里，
 *    这里再列一遍是让结算半"知道这次赢在什么东西上"，不是第二套算术。
 */
export function bonusLabels(l: Ledger, participants: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of participants) {
    const p = findPerson(l, id);
    if (!p) continue;
    for (const b of p.attr_bonus ?? []) out.push(`${p.name} 固有 +${b.bonus}`);
    for (const it of carriedItems(l, p)) {
      for (const b of it.attr_bonus ?? []) out.push(`${it.name} +${b.bonus}`);
    }
  }
  return out;
}

export async function handleEvent(
  ledger: Ledger,
  input: HandleInput,
  rng: Rng,
  brain: Brain,
): Promise<HandleResult> {
  const log: string[] = [];
  const today = ledger.clock.day;
  const gates = evalGates({
    ledger,
    today,
    action: 'handle',
    eventId: input.eventId,
    participants: input.participants,
    goldToPay: input.goldInput ?? 0,
  });
  const hard = blocked(gates);
  if (hard.length > 0) {
    return {
      ledger,
      gates,
      blockedBy: hard,
      check: null,
      roll: null,
      tier: null,
      log: [`被闸门拦下：${hard.map((g) => g.reason).join('；')}`],
      revealedNow: [],
      revealedTexts: [],
      intentSummary: '',
      bonuses: [],
    };
  }

  const l: Ledger = structuredClone(ledger);
  const ev = l.events.live.find((e) => e.id === input.eventId);
  if (!ev) throw new Error(`事件 ${input.eventId} 不存在`);

  const members = input.participants.map((id) => findPerson(l, id)).filter((p) => !!p);
  if (members.length === 0) throw new Error('参与者为空');

  // ── ① 裁定半（LLM）── 只回答"能不能做、要不要判定"，**不含任何结果** ──
  const handling = {
    participants: [...input.participants],
    usedItemId: input.usedItemId ?? null,
    goldInput: Math.max(0, input.goldInput ?? 0),
    note: input.note ?? '',
  };
  const adj = await brain.adjudicate(ev, l, handling);
  log.push(`裁定：${adj.intent_summary}　⇒ verdict=${adj.check.verdict}`);

  // ── ② 定档位：需要掷骰 ⇒ 规则层投骰；否则查表直取 ──
  // ⚠️ 参与属性**以裁定半为准**（默认取事件卡 `hint_attr`）；模型给空则退回事件卡。
  // ⚠️ `本次不裁定` 属于结算半的语义，不该出现在裁定半 —— 兜进掷骰那条最保守的路：
  //    档位仍由规则层投出来，不会因为一个畸形枚举就凭空给玩家一个成败（2026-10-07）。
  const wantRoll = adj.check.verdict === '投骰' || adj.check.verdict === '本次不裁定';
  const keys: readonly AttrKey[] =
    adj.check.participants.length > 0
      ? adj.check.participants
      : ev.hint_attr.length > 0
        ? ev.hint_attr
        : ['智慧'];

  // 主事者 = 参与者中「本次参与属性集合上取值最高的人」（判据见 `rules/ability.ts`）
  const leader = pickLeader(l, members, keys) ?? members[0];

  let outcome: RollOutcome | null = null;
  let tier: Tier;
  // 危险区：由欲念推导（规则层恒定，《规则.md》§一「来源三」）—— `input.zone` 只是调试用的显式覆写
  const zone = input.zone ?? dangerZoneOf(l.desire.value);
  if (wantRoll) {
    const { a, overflow } = calcA(effectiveAttrsOf(l, leader), keys);
    outcome = resolveRoll(
      {
        a,
        overflow,
        leaderId: leader.id,
        eventDifficulty: adj.check.difficulty,
        participants: members.length,
        minPeople: ev.min_people,
        maxPeople: ev.max_people,
        zone,
      },
      rng,
    );
    tier = outcome.tier;
    log.push(
      `投骰：主事者 ${leader.name}（A=${a}${overflow > 0 ? ` 溢出 ${overflow}` : ''}）→ ${tier}${
        outcome.endpoint
          ? '（端点，恒定）'
          : `（d20=${outcome.raw} 修正 ${outcome.modifierTotal >= 0 ? '+' : ''}${outcome.modifierTotal}）`
      }${zone !== '正常' ? ` · 危险区「${zone}」生效` : ''}`,
    );
  } else {
    const nr = outcomeForNonRoll(adj.check);
    tier = nr.tier;
    log.push(`免判定：verdict=${adj.check.verdict} ⇒ 直接取档位 ${tier}`);
  }

  const bonuses = bonusLabels(l, input.participants);

  // ── 跨天事件：记下主事者**启程时还能接活多少**（`depart_cost`，记录口径）──
  // ⚠️⚠️ 2026-10-08 用户裁定「拨时间拨的是所有人的时间」⇒ 排布**不再即时扣容量**：
  //    参与者的时间与闲置者**同速流逝**（`turn/time.ts·pushTime` 全员扣），
  //    「一人一天 ≤ 4 点」的平衡改由 `rules/x.ts·availableToday`（今日已承诺）把关。
  //    `depart_cost` 保留：归队日只回升 `d` 点（`rules/x.ts·subordinatePoints`）——
  //    数值从「扣光当日剩余」改为「启程时当日还能接活的点数」，语义更贴时间流速。
  const batch = emptyBatch(l);
  const crossDay = ev.cost > BASE_ACTION_POINTS;
  /** 【系统已落账】清单 —— ⚠️ **托管投入 P 永不入内**（它是上限，不是已花的钱） */
  const landed: string[] = [];
  const departCost =
    crossDay && leader.id !== PLAYER_ID ? availableToday(l, leader, l.clock.day) : 0;

  // ── 锁金币（托管 P：提交那一刻即扣）─────────────────────────
  const pay = Math.max(0, input.goldInput ?? 0);
  if (pay > 0) {
    batch.gold -= pay;
    ev.gold_locked = pay;
    log.push(`投入金币 ${pay}（托管上限，已扣）`);
  }

  // ── 事件状态机 + 揭晓时刻（系统写）──────────────────────────
  const startedAt = nowOf(l);
  ev.started_at = startedAt;
  ev.reveal_at = addPoints(startedAt, ev.cost);
  ev.handler = leader.id;
  ev.participants = [...input.participants];
  ev.depart_cost = crossDay && leader.id !== PLAYER_ID ? departCost : null;
  ev.status = '揭晓待办';
  log.push(
    `处理时长 ${ev.cost} 点 ⇒ 第 ${ev.reveal_at.day} 天第 ${ev.reveal_at.used} 点揭晓（主事者 ${leader.name}）`,
  );

  // ── ③ 结算半（LLM）── 现在就把结果算出来，但**存进 pending 等时间** ──
  //    ⚠️ 一段式（无需判定 / 直接成功 / 直接失败）在这里**不发网络**：
  //       `settle` 只是把第一次调用里已经填好的结算半取出来。
  const raw = await brain.settle(ev, l, handling, adj, { tier, bonuses, landed });
  l.pending.push({
    eventId: ev.id,
    tier,
    narration: raw.narration ?? '',
    delta: raw.delta ?? { ops: [] },
    summary: raw.summary ?? '',
    next_seeds: raw.next_seeds ?? [],
    // ⚠️ 凭证**必须存下来** —— 它在排布时就算好了，但只能在揭晓那一刻落账（与 `delta` 同理）。
    //    漏掉这一行 = 整条凭证链路在离线路径上不存在（见 `ledger/vouchers.ts` 顶栏）。
    vouchers: raw.vouchers ?? [],
    欲向: raw.欲向 ?? '无关',
  });

  const { ledger: committed, report } = commitBatch(l, batch);
  log.push(...report);

  // 处理时长 0 ⇒ `reveal_at === started_at` ⇒ 当场揭晓。
  // ⚠️ 走的是**同一条**揭晓通道（不开后门）：否则"零时长"会变成第二套结算路径。
  // ⚠️ 正文必须在 `revealDue` **之前**抓 —— 它兑现完就删 `pending`（见 `revealedTexts` 的说明）。
  const revealedNow: string[] = [];
  const nowAtReveal = nowOf(committed);
  const dueTexts = new Map<string, string>();
  for (const e of committed.events.live) {
    if (e.status !== '揭晓待办' || e.reveal_at === null || !reached(nowAtReveal, e.reveal_at)) continue;
    const p = committed.pending.find((x) => x.eventId === e.id);
    dueTexts.set(e.id, p?.narration ?? '');
  }
  const after = revealDue(committed, nowAtReveal, log, revealedNow);
  const revealedTexts = revealedNow
    .map((id) => ({ id, text: (dueTexts.get(id) ?? '').trim() }))
    .filter((x) => x.text !== '');

  return {
    ledger: after,
    gates,
    blockedBy: [],
    check: adj.check,
    roll: outcome,
    tier,
    log,
    revealedNow,
    revealedTexts,
    intentSummary: adj.intent_summary,
    bonuses,
  };
}

export type { GameEvent };
