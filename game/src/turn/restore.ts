// 恢复 · 医馆疗伤 / 神殿净化
//
// ⚠️⚠️ **2026-10-07 用户裁定（第十五批）：恢复不再当场生效** —— 它与正常事件走**同一条**
//    「算 / 揭分离」：提交 ＝ 排布（扣诊金、占被治疗者容量、立一条「处理中」的**功能事件**）；
//    **生效 ＝ 玩家把时针拨到点**（或进下一天），由 `turn/time.ts·revealDue` 统一兑现。
//    旧模型（提交即回满）的问题：结果当场跳变、手牌区的人物行动点读数与画布状态对不上，
//    而且玩家本人被治疗时还会被 `pushTime` 冷不丁推走一段时间。
//
//    实现口径：**复用事件池的整条通道**，不另开第二条揭晓路径——
//      · 一条合成事件进 `events.live`（status = 揭晓待办、reveal_at = now + 点数）：
//        画布上自然出现「处理中：还需 N 点行动力」、`dialRange` 自然被它限上限、
//        【未处理 · 处理中】块里 LLM 也看得见这件事在办；
//      · 一条**机械**的 `pending`（零 LLM）：揭晓那一刻回满 hp/san ＋ 固定表述进【已处理概要】；
//      · 过期与它无关：`settleExpired` 只结「待处理」，这条事件生下来就是「揭晓待办」。
//
//    规格不变（2026-10-07 早前裁定）：
//      · **医馆疗伤** —— **1 金币** ⇒ HP **一次回满（3）**；占被治疗者 **3 点**行动力
//      · **神殿净化** —— **3 金币** ⇒ SAN **一次回满（3）**；占被治疗者 **2 点**行动力
//      · **固定只放一个人**；HP / SAN = 3（已满）**不用治**、= 0（死亡 / 永久疯狂）**不可治**。
//
// ⚠️ 诊金**提交即扣**（与正常事件的托管 P 同一刻）；被治疗者容量**提交即占**（与排布即扣同一口径）。
// ⚠️ **同一人同时只有一单**：他还在「处理中」时不收第二单（否则等于花两份钱办同一件事）。
import { commitBatch } from '../ledger/apply.ts';
import { emptyBatch } from '../ledger/batch.ts';
import { formatEventId } from '../ledger/ids.ts';
import { findPerson, PLAYER_ID, type Ledger, type Person } from '../ledger/types.ts';
import { addPoints, nowOf } from '../rules/clock.ts';
import { availableToday } from '../rules/x.ts';
import type { Rng } from '../rules/rng.ts';
import type { Brain } from './brain.ts';

export type RestorePlace = '医馆' | '大神殿';

export interface RestoreSpec {
  /** 合成事件与画布功能卡共用的标题（两处同源） */
  title: string;
  /** 每人诊金 */
  goldPerPerson: number;
  /** 占被治疗者几点行动力（医馆 3 · 神殿 2 —— 2026-10-07 用户裁定） */
  points: number;
  /** 回满哪个字段 */
  field: 'hp' | 'san';
  /** 被治疗者的称谓（日志用） */
  treatWord: string;
  /** 揭晓那刻的**机械叙事**（零 LLM —— 这件事没有悬念，结果早就定死了） */
  doneNarrative: (name: string) => string;
  /** 【已处理概要】的固定表述（2026-10-07 用户裁定：恢复要在 LLM 上下文里留痕） */
  summaryOf: (name: string) => string;
}

export const RESTORE_SPEC: Record<RestorePlace, RestoreSpec> = {
  医馆: {
    title: '医馆 · 疗伤',
    goldPerPerson: 1,
    points: 3,
    field: 'hp',
    treatWord: '被治疗者',
    doneNarrative: (n) => `郎中一套行针推拿下来，${n} 的伤好了。`,
    summaryOf: (n) => `玩家在医馆治疗了${n}，${n}的身体已经恢复`,
  },
  大神殿: {
    title: '神殿 · 净化',
    goldPerPerson: 3,
    points: 2,
    field: 'san',
    treatWord: '被安抚者',
    // ⚠️ 内部键保持「大神殿」不动（序幕第 2 条叙事事件也在大神殿，同一个舞台）；
    //    事件标题与概要里用**显示名**「神殿」。
    doneNarrative: (n) => `晨钟与诵祷声里，${n} 的心神安定了下来。`,
    summaryOf: (n) => `玩家在神殿净化了${n}，${n}的精神已经恢复`,
  },
};

/** 每次至多 **1 人**（2026-10-07 用户裁定：「固定只能放一个人」） */
export const RESTORE_MAX_PEOPLE = 1;
/** 回满到这个值 */
export const RESTORE_FULL = 3;

export interface RestoreInput {
  place: RestorePlace;
  /** 被治疗者 id（可含玩家 `npc000`） */
  targets: string[];
}

export interface RestoreResult {
  ledger: Ledger;
  /** **空数组 = 成功**；非空 = 被拦下（账本一个字节没动） */
  rejected: string[];
  /** 本次诊金总额 */
  cost: number;
  log: string[];
  /**
   * ⚠️ 旧模型玩家本人被治疗时会当场 `pushTime` —— 延迟模型下**不存在**这一步
   *    （他的点是时间，由玩家自己拨针付）⇒ 恒为 `null`，字段仅为调用方兼容保留。
   */
  time: null;
}

/**
 * 提交一次恢复（＝ **排布**一单恢复）。**闸门全部先跑完、任一不过则整批不落账**——
 * 与「批 = 要么全落要么全不落」同一条纪律。
 * ⚠️ 生效要等玩家拨针到点（`reveal_at`）—— 本函数**只排布、不结算、零 LLM**。
 */
export function restore(
  ledger: Ledger,
  input: RestoreInput,
  _rng: Rng,
  _brain: Brain,
): RestoreResult {
  const spec = RESTORE_SPEC[input.place];
  if (!spec) {
    return { ledger, rejected: [`未知的恢复入口「${input.place}」`], cost: 0, log: [], time: null };
  }

  const rejected: string[] = [];
  const ids = [...new Set(input.targets)];
  if (ids.length === 0) rejected.push('未指定被治疗者');
  if (ids.length !== input.targets.length) rejected.push('被治疗者名单里有重复 id');
  if (ids.length > RESTORE_MAX_PEOPLE) {
    rejected.push(`每次至多 ${RESTORE_MAX_PEOPLE} 人（本次 ${ids.length} 人）`);
  }

  const field = spec.field;
  const people: Person[] = [];
  for (const id of ids) {
    const p = findPerson(ledger, id);
    if (!p) {
      rejected.push(`人物 ${id} 不存在`);
      continue;
    }
    if (!p.affiliated) {
      rejected.push(`${p.name}(${p.id}) 不属于你，这里治不了`);
      continue;
    }
    // 「= 0 即死亡 / 永久疯狂，直接进入结局，不可治疗」
    if (p[field] <= 0) {
      rejected.push(`${p.name}(${p.id}) 的 ${field.toUpperCase()} = 0（死亡 / 永久疯狂）⇒ 不可治疗`);
      continue;
    }
    // 「= 3 即已满，不用治」（2026-10-07 补：收了诊金却什么都不发生 = 白抢钱）
    if (p[field] >= RESTORE_FULL) {
      rejected.push(`${p.name}(${p.id}) 的 ${field.toUpperCase()} 已满 ⇒ 不需要治疗`);
      continue;
    }
    // ⚠️ 同一人同一时刻只有一单（延迟模型新增）：他还有一单在「处理中」就不再收
    const busy = ledger.events.live.some(
      (e) => e.status === '揭晓待办' && e.handler === p.id && e.title === spec.title,
    );
    if (busy) {
      rejected.push(`${p.name}(${p.id}) 的${spec.title}还有一单在办 ⇒ 等它到点再说`);
      continue;
    }
    people.push(p);
  }

  // 各人当日剩余够这次的点数 —— 2026-10-08 起统一走 `availableToday`
  // （NPC = 时间流速余额与「今日已承诺」取小；玩家 = 今天剩余时间）
  const leftOf = (p: Person): number => availableToday(ledger, p, ledger.clock.day);
  for (const p of people) {
    const left = leftOf(p);
    if (left < spec.points) {
      rejected.push(`${spec.treatWord} ${p.name}(${p.id}) 当日剩余 ${left} < ${spec.points} ⇒ 置灰`);
    }
  }

  const cost = spec.goldPerPerson * people.length;
  if (cost > ledger.scalars.gold) rejected.push(`应付 ${cost} > 余额 ${ledger.scalars.gold}`);

  if (rejected.length > 0) return { ledger, rejected, cost, log: [], time: null };

  // ── 排布：走唯一写入口（批内只累加，批末钳一次）──────────────
  // ⚠️ 2026-10-08 起医治**不再即时扣 byNpc**：这一单是「今日启程、在办的揭晓待办」，
  //    自然计入 `availableToday` 的「今日已承诺」——与普通排布同一条平衡；
  //    点数照旧随拨钟全员同速流逝（`turn/time.ts·pushTime`）。
  const l: Ledger = structuredClone(ledger);
  const batch = emptyBatch(l);
  const log: string[] = [];
  batch.gold -= cost;

  // ── 合成事件：复用事件池的「处理中 → 揭晓」整条通道 ──────────
  const target = people[0];
  const name = target.name;
  const now = nowOf(l);
  const reveal = addPoints(now, spec.points);
  l.idWatermark.event += 1;
  const evId = formatEventId(l.idWatermark.event);
  l.events.live.push({
    id: evId,
    title: spec.title,
    content: `${name} 正在这里接受${field === 'hp' ? '疗伤' : '净化'}，需要 ${spec.points} 点行动力，到点便见起色。`,
    stage: input.place,
    location: null,
    tier: 'B',
    dispatchable: '两者皆可',
    required_person: target.id,
    cost: spec.points,
    min_gold: 0,
    min_people: 1,
    max_people: 1,
    deadline: 1, // 恒不触发：它生下来就是「揭晓待办」，`settleExpired` 只结「待处理」
    options: [],
    delta: null,
    hint_attr: [],
    difficulty: '无修正',
    status: '揭晓待办',
    created_day: l.clock.day,
    started_at: now,
    reveal_at: reveal,
    handler: target.id,
    participants: [target.id],
    gold_locked: 0,
    depart_cost: null,
  });

  // ── 预计算结果：**机械**（零 LLM）—— 揭晓那一刻由 `revealDue` 照单兑现 ──
  const refill = RESTORE_FULL - target[field];
  l.pending.push({
    eventId: evId,
    tier: '成功',
    narration: spec.doneNarrative(name),
    delta: {
      ops: [
        {
          change: {
            who: target.id,
            hp: field === 'hp' ? refill : 0,
            san: field === 'san' ? refill : 0,
            attrs: [],
            in_your_eyes: '',
            openness: 0,
            affiliated: '保持',
          },
        },
      ],
    },
    summary: spec.summaryOf(name),
    next_seeds: [],
    vouchers: [],
    欲向: '无关',
  });

  const { ledger: after, report } = commitBatch(l, batch);
  log.push(...report);
  log.push(
    `${input.place}：${name} 开始${field === 'hp' ? '疗伤' : '净化'}` +
      `（诊金 ${cost} · 占 ${spec.points} 点行动力，第 ${reveal.day} 天第 ${reveal.used} 点见效）`,
  );

  return { ledger: after, rejected: [], cost, log, time: null };
}
