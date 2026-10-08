// 时间流逝的**三种方式** + 揭晓
//
//   A. **场景穿越**（玩家亲自处理）→ `turn/scene.ts`：进场景多轮对话，处理完**自动扣**行动点
//   B. **拨时针**（主动跳过时间）→ `dial`：`[1, 当天剩余]`，不跨天、**无代价**
//   C. **进入下一天** → `nextDay`：让当天剩余时间流完，再翻日
//
// ⚠️ **排布不推进时间** —— 给下属派活只扣下属**容量**，玩家时钟纹丝不动。
//    这就是"算 / 揭分离"的物理形态：结果早就有了，但玩家必须**等**（消耗等价的时间）才看得到。
//
// 三者最终都走同一条底层 `pushTime`：逐点推进 → 到点揭晓 → 到点过期结算 → 跨日收尾。
// 「时间」是唯一的驱动：**没有第二个地方能触发揭晓**。
//
// ⚠️ **async 只有浅浅一层**：本文件要 await 的只有 `enterDay`（它调 `composeDay`）与
//    `settleExpired`（过期也要过一次 LLM 结算）。
//    ⚠️ **揭晓路径（`revealDue`）依然零 LLM 调用** —— 结果早在排布时算好放在 `pending` 里，
//    这里只是把它兑现。⇒ 异步渗不进"揭晓"这个核心，`rules/clock.ts` 一行都不用改。
//    ⚠️ 过期结算**不会**把 await 带进逐点推进的每一步：`deadline` 的单位是**天**（用户裁定）
//    ⇒ 过期只可能落在**日界**上。
import { applyDelta, commitBatch } from '../ledger/apply.ts';
import { emptyBatch } from '../ledger/batch.ts';
import { deltaGoldSum, reportedCostOf, settleEscrow } from '../ledger/gold.ts';
import { nextSeedCode } from '../ledger/ids.ts';
import { findPerson, PLAYER_ID, type GameEvent, type Ledger, type TimePoint } from '../ledger/types.ts';
import { applyVouchers } from '../ledger/vouchers.ts';
import { consumeOneShots } from '../rules/ability.ts';
import { dialRange, nowOf, reached, remainingToday } from '../rules/clock.ts';
import { desireDelta } from '../rules/desire.ts';
import { BASE_ACTION_POINTS } from '../rules/x.ts';
import type { Rng } from '../rules/rng.ts';
import type { Brain } from './brain.ts';
import { enterDay, settleExpired, turnOver } from './t0.ts';

export interface TimeResult {
  ledger: Ledger;
  log: string[];
  /** 本次推进中**揭晓**的事件 id（落账已完成） */
  revealed: string[];
  /** 本次推进中**过期结算**了的事件 id（它们已经落账、状态 = 已结算） */
  expired: string[];
  /** 本次推进跨过了几个日界 */
  daysPassed: number;
  /** 本次推进中（跨日时）新生成的事件条数 */
  created: number;
  /**
   * 本次推进里**章节占卜**落了什么（非占卜日 / 失败 ⇒ `null`）。
   * ⚠️ 只回传**氛围** —— 它是占卜产出里**唯一玩家可见**的那一半（用户 2026-09-22 的分层要求）：
   *    UI 的播报只念这一句；欲念变化与"命中了哪张牌"留在 `log` 里给开发者看。
   */
  divination: { ambience: string } | null;
  /**
   * 本次推进里**概要归并**落了什么（没触发 / 失败 ⇒ `null`）。
   * ⚠️ 产物**不给玩家播报**（与 `divination` 不同）—— 章级概要由 UI 左栏读 `view().archive`。
   */
  archived: { days: number[]; segment: string } | null;
}


/**
 * 揭晓：把所有 `reveal_at ≤ now` 的「揭晓待办」兑现落账。返回**新账本**。
 *
 * ⚠️ 这是「算 / 揭」里**揭**的唯一出口。结果早在排布时就算好放在 `Ledger.pending` 里
 *    （注入标签 **永不**），此刻只是把它兑现 —— **不会再调一次 LLM**（那是"重复掷骰"类 bug 的温床）。
 *    ⇒ 本函数**永远是同步的**，`async` 到此为止。
 */
export function revealDue(ledger: Ledger, now: TimePoint, log: string[], out: string[]): Ledger {
  const due = ledger.events.live.filter(
    (e) => e.status === '揭晓待办' && e.reveal_at !== null && reached(now, e.reveal_at),
  );
  if (due.length === 0) return ledger;

  const l: Ledger = structuredClone(ledger);
  const batch = emptyBatch(l);

  for (const snapshot of due) {
    const ev = l.events.live.find((e) => e.id === snapshot.id)!;
    const p = l.pending.find((x) => x.eventId === ev.id);
    if (!p) {
      // 结构性错误：不外泄、不猜、不补算 —— 直接收口（宁可不给结果，也不给错结果）
      log.push(`⚠️ 揭晓「${ev.title}」时找不到预计算结果（结构性错误：pending 与 events 不同步）`);
      ev.status = '已结算';
      out.push(ev.id);
      continue;
    }
    const who = ev.handler ?? PLAYER_ID;
    applyDelta(l, (p.delta ?? { ops: [] }) as never, { roleMap: { 参与者: who, 主事者: who } }, batch);
    // 凭证 —— 与 `delta` **同批落账**：`pending.vouchers` 是排布那一刻算好的原始形状，此刻才兑现。
    //    ⚠️ 必须在 `applyDelta` **之后**：本批新建的物品 / 人物这时才有正式 id，`@it1` 才解析得出来。
    const vou = applyVouchers(l, p.vouchers, batch, { day: now.day, eventId: ev.id });
    log.push(...vou.report);
    // ── 一次性物品：**揭晓这一刻**用掉（2026-10-06 用户裁定）────────────
    //    裁定原文：「一次性物品，只要被角色装备 ＋ 该角色处理了某事件
    //    （视为在该事件中使用了该物品），该物品自动消耗。」
    //    拆成三条**可算**的判据（`卡槽与LLM分工.md` §0：算术归系统）：
    //      ① `kind === '消耗品'`（`rules/ability.ts·isOneShot`，由 kind 推导）；
    //      ② 他**带着**它（`p.items` 含它 —— 装备着）；
    //      ③ 它**正在生效**（在 `effectiveItems` 那两件里）—— 白带的不会被动。
    //    ⚠️ 为什么落在**揭晓**这一刻而不是排布那一刻：消耗是"他办完了这件事"的
    //    后果，而"办完"＝揭晓（`handle.ts` 那行注释：「揭晓 ≡ 处理完成」）。
    //    排布那一刻结果只是**算好**还没公开（`pending`）。
    //    ⚠️ **不进档案**（用户裁定）：消耗品不进结局三格 —— 那是成果，不是耗材。
    //    ⇒ 所以**不走** `batch.lost.items`（那条会进档案，见 `apply.ts` 的 lost 段）。
    for (const line of consumeOneShots(l, ev.id)) log.push(line);
    for (const w of vou.problems) log.push(`⚠️ ${w}`);
    if (p.欲向) batch.desire += desireDelta(p.欲向);
    if (p.summary) {
      l.summaries.recent.push({ day: now.day, text: p.summary });
      // ⚠️ 2026-10-07 用户裁定（第十五批）：生成侧的「已处理」清单要 **标题＋概括** 配对
      //    ⇒ 概括同时在事件身上留一份（概要块不带标题，配不了对）。
      ev.settled_summary = p.summary;
    }
    for (const s of p.next_seeds) {
      // ⚠️ 编号走 `nextSeedCode()`（**不是** `l.seeds.length + 1`）：硬种子跨天留存 ⇒
      //    池子可能带洞，`length + 1` 会与留着的那条撞号（`claimSeed` 按 code 查 ⇒ 静默双核销）。
      l.seeds.push({ code: nextSeedCode(l.seeds), title: s, content: s, source: 'LLM' });
    }
    // ── 金币：把**两条腿合并成一步**（这是一处必须在这写清的口径）──────
    //   · 上面 `applyDelta` 已经把 delta 的 `gold` **全额**算进了 `batch.gold`（负 = 花掉）
    //   · 而托管纪律是「**提交那一刻即扣 P**，结算只补差额 / 退差额」(《规则.md》§四 纪律 5)
    //   ⇒ 负的那部分必须**冲回** —— 它是"报告"，不是第二笔支出。
    //   ⇒ 净额 = `−min(实际, P)`（有收益时另加收益）= `refund + max(0, goldSum)`。
    //   ⚠️ 2026-09-18 `--live` 实测踩过：不冲回 ⇒ 同一笔钱扣两次（8 → 4，应为 6）。
    //   ⚠️ 与 `gold.ts` 顶栏那条「`P` 不进【已落账】清单」是同一枚硬币的两面。
    const goldSum = deltaGoldSum(p.delta);
    const clawback = goldSum < 0 ? -goldSum : 0;
    if (clawback > 0) batch.gold += clawback;
    if (ev.gold_locked > 0) {
      const { refund, note } = settleEscrow(reportedCostOf(p.delta), ev.gold_locked);
      batch.gold += refund;
      ev.gold_locked = 0;
      log.push(
        `揭晓「${ev.title}」· 托管结清（${note}${clawback > 0 ? `；冲回模型报告的花销 ${clawback}` : ''}）`,
      );
    } else {
      log.push(`揭晓「${ev.title}」（主事者 ${who}）`);
    }
    ev.status = '已结算';
    l.roll = { tier: p.tier ?? '成功', bonuses: [] };
    out.push(ev.id);
  }

  const dueIds = new Set(due.map((e) => e.id));
  l.pending = l.pending.filter((x) => !dueIds.has(x.eventId));

  const { ledger: after, report } = commitBatch(l, batch);
  log.push(...report);
  return after;
}

/**
 * **底层时间推进**：把时钟往前走 `n` 点，沿途在每个时间点上兑现揭晓与过期，跨日则翻日并开场。
 * 上层三个入口（A / B / C）都是它的薄封装 —— 这是"时间只有一条通道"的结构保证。
 */
export async function pushTime(
  ledger: Ledger,
  n: number,
  rng: Rng,
  brain: Brain,
  seed = 0,
): Promise<TimeResult> {
  let l: Ledger = structuredClone(ledger);
  const log: string[] = [];
  const revealed: string[] = [];
  const expired: string[] = [];
  let daysPassed = 0;
  let created = 0;
  /** 跨日时最后一次落地的章节占卜（一次推进**理论上**至多跨两个日界，只留最新那一份给 UI） */
  let divination: { ambience: string } | null = null;
  let archived: { days: number[]; segment: string } | null = null;
  let left = Math.max(0, n);

  while (left > 0) {
    if (remainingToday(l) === 0) {
      // 当天已用尽，但还有时间要流 ⇒ **必须先翻日**
      // （拨时针走不到这里：它的粒度被 `dialRange` 限在当天剩余之内）
      log.push(...turnOver(l));
      const e = await enterDay(l, rng, brain, seed);
      l = e.ledger;
      log.push(...e.log);
      created += e.created.length;
      if (e.divination) divination = e.divination;
      if (e.archived) archived = e.archived;
      daysPassed += 1;
      continue;
    }

    const step = Math.min(left, remainingToday(l));
    l.clock.usedToday += step;
    left -= step;

    // ⚠️⚠️ 2026-10-08 用户裁定：「玩家每次拨时间，拨的是**所有人的时间**」⇒ 时间流速全表一致：
    //    手牌区**闲置者**的容量也一起流逝（含场景收尾的被动拨时 —— A/B/C 三通道全走本函数，
    //    改这一处即全覆盖）。排布**不再**即时扣容量（旧口径），
    //    「一人一天 ≤ 4 点」的派遣平衡由 `rules/x.ts·availableToday`（今日已承诺）把关。
    //    ⚠️ 玩家不进 `byNpc`：他的预算就是上面那行 `usedToday`。
    for (const p of l.entities.people) {
      if (p.id === PLAYER_ID) continue;
      l.actionPoints.byNpc[p.id] = Math.max(
        0,
        (l.actionPoints.byNpc[p.id] ?? BASE_ACTION_POINTS) - step,
      );
    }

    // 时间走到哪，就结算到哪 —— 顺序不能反：先揭晓（用满当天时 now = 当天末尾），再判过期
    l = revealDue(l, nowOf(l), log, revealed);
    // ⚠️ 过期**也要过一次结算**（LLM 按"玩家选择忽略"生成后果与概要）⇒ 这里会 await 一次调用。
    //    因为 `deadline` 的单位是**天**，过期只落在日界上 ⇒ 这个 await 不会渗进逐点推进的每一步。
    const ex = await settleExpired(l, nowOf(l), brain);
    l = ex.ledger;
    log.push(...ex.log);
    expired.push(...ex.expired);

    if (left > 0) {
      log.push(...turnOver(l));
      const e = await enterDay(l, rng, brain, seed);
      l = e.ledger;
      log.push(...e.log);
      created += e.created.length;
      if (e.divination) divination = e.divination;
      if (e.archived) archived = e.archived;
      daysPassed += 1;
    }
  }

  return { ledger: l, log, revealed, expired, daysPassed, created, divination, archived };
}

/**
 * **B · 拨时针**：主动跳过 `n` 点时间。不跨天、无代价。
 * 合法粒度 `[1, 当天剩余]`；已用尽（剩余 0）⇒ 只能 `nextDay`。
 * ⚠️ `seed` 只用于占卜那条独立随机流（拨时间若跨了日界且那天是占卜日）——
 *    见 `turn/t0.ts·enterDay` 的说明。
 */
export async function dial(
  ledger: Ledger,
  n: number,
  rng: Rng,
  brain: Brain,
  seed = 0,
): Promise<TimeResult> {
  const r = dialRange(ledger);
  if (!Number.isInteger(n) || n < r.min || n > r.max) {
    throw new Error(
      `拨时针 ${n} 点不合法：允许区间 [${r.min}, ${r.max}]（当天剩余 ${remainingToday(ledger)}，已用 ${ledger.clock.usedToday}）`,
    );
  }
  return await pushTime(ledger, n, rng, brain, seed);
}

/**
 * **C · 进入下一天**：让当天剩余时间自然流完（剩余为 0 也一样），然后翻日并开场。
 * ⚠️ 这是玩家在"时间用尽"后唯一的出路 ⇒ 闸门 ① 不得拦它。
 */
export async function nextDay(
  ledger: Ledger,
  rng: Rng,
  brain: Brain,
  seed = 0,
): Promise<TimeResult> {
  const r = await pushTime(ledger, remainingToday(ledger), rng, brain, seed);
  const l: Ledger = structuredClone(r.ledger);
  const log: string[] = [...r.log];
  log.push(...turnOver(l));
  const e = await enterDay(l, rng, brain, seed);
  log.push(...e.log);
  return {
    ledger: e.ledger,
    log,
    revealed: r.revealed,
    expired: r.expired,
    daysPassed: r.daysPassed + 1,
    created: r.created + e.created.length,
    divination: e.divination ?? r.divination,
    archived: e.archived ?? r.archived,
  };
}

/**
 * **A · 场景穿越** —— 玩家亲自进场景、多轮对话，处理完行动点**自动扣**。
 *
 * ⚠️ **2026-09-19 起由 `turn/scene.ts` 的状态机独占**：本文件此前那个 `crossScene()`
 *    只实现了"时间语义"（按 `cost` 推进时钟），是 Phase 1 的占位。
 *    现在 A 只有一条路 —— `openScene()` → `sceneStep()`（逐轮）→ `sceneLeave()`
 *    或末轮 `scene_over=true` 自行收束；「扣 `cost` 并当场揭晓」由那条路的
 *    `finish()` 在收尾之后调 `pushTime()` 完成（**不在这里、也不为它开第二条揭晓路径**）。
 */

/** 便捷：这次推进里有没有发生任何事（给 UI 判断要不要刷结算面板） */
export function isQuiet(r: TimeResult): boolean {
  return r.revealed.length === 0 && r.expired.length === 0 && r.daysPassed === 0;
}

export type { GameEvent };
