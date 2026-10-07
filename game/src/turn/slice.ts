// 竖切驱动器 —— **一条事件走完全程**（排布 → 投骰 → 结算 → 落账 → 揭晓）
//
// 这一层只是把已经存在的零件按真实顺序串起来，不新增任何机制：
//   `handleEvent`（裁定＋投骰＋结算＋锁金币/扣容量）→ 拨时间 → `revealDue`（落账）
// 它存在的意义是**把中间态摆出来给人看**：模型原文 vs 校验后的 delta、被拦下的条目、
// 落账前后 diff。Phase 1 的 28 天驱动只告诉你"没崩"，这里告诉你"这一步具体长什么样"。
//
// ⚠️ 时间推进**只用 `dial`**（不跨天）—— 跨天要调 `compose_day`，那是 Phase 3 的事。
//    竖切的事件卡因此固定是单日事件（`cost ≤ 4`）。
import type { Check, DesireTier, DeltaOp, Tier } from '../contract/types.ts';
import { validateDelta, type Drop, type Fix } from '../contract/validate.ts';
import { hash } from '../frozen/static-head.ts';
import {
  DEFAULT_HANDLING,
  EVENT_CARD,
  makeEventCard,
  sliceLedger,
  type EventCardSpec,
} from '../fixtures/event-card.ts';
import type { GameEvent, Ledger, Person } from '../ledger/types.ts';
import { remainingToday } from '../rules/clock.ts';
import { makeRng } from '../rules/rng.ts';
import type { DangerZone } from '../rules/dice.ts';
import { handleEvent, type HandleInput, type HandleResult } from './handle.ts';
import { dial } from './time.ts';
import type { Brain } from './brain.ts';

export interface Reading {
  gold: number;
  desire: number;
  rep: Record<string, number>;
  people: Array<{ id: string; name: string; hp: number; san: number; attrs: Record<string, number> }>;
  items: Array<{ id: string; name: string; holder: string | null; consumed: boolean }>;
  seedCount: number;
  summaryCount: number;
  liveCount: number;
  pendingCount: number;
}

export function readLedger(l: Ledger): Reading {
  return {
    gold: l.scalars.gold,
    desire: l.desire.value,
    rep: { ...l.scalars.rep },
    people: [...l.entities.people]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p: Person) => ({ id: p.id, name: p.name, hp: p.hp, san: p.san, attrs: { ...p.attrs } })),
    items: [...l.entities.items]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((i) => ({ id: i.id, name: i.name, holder: i.holder, consumed: i.consumed })),
    seedCount: l.seeds.length,
    summaryCount: l.summaries.recent.length,
    liveCount: l.events.live.length,
    pendingCount: l.pending.length,
  };
}

export interface SliceOptions {
  card?: EventCardSpec;
  handling?: HandleInput;
  zone?: DangerZone;
}

export interface SliceReport {
  /** 链路是否跑完（false ⇒ 看 `stopped`） */
  ok: boolean;
  /** 没跑完的原因（闸门 / 调用失败 / 需要跨天） */
  stopped: string | null;
  card: GameEvent;
  /** ① 裁定 */
  intentSummary: string;
  check: Check | null;
  tier: Tier | null;
  /** ② 判定 */
  rollLine: string;
  bonuses: string[];
  /** ③ 结算 —— 模型原文 */
  narration: string;
  deltaRaw: unknown;
  summary: string;
  nextSeeds: string[];
  欲向: DesireTier;
  /** ③′ 结算 —— 经 `validateDelta` 六项校验之后 */
  deltaOps: DeltaOp[];
  fixes: Fix[];
  drops: Drop[];
  mixedCount: number;
  /** ④ 落账（`commitBatch` 的人话报告） */
  ledgerLog: string[];
  /** ⑤ 揭晓 */
  revealed: string[];
  timeLog: string[];
  before: Reading;
  after: Reading;
  /** **逐字比对用的载荷**：`--replay` 就是拿它跟 `--live` 的结果对齐 */
  payload: string;
  digest: string;
}

/**
 * 推进时间直到这条事件揭晓。**只用 `dial`**（不跨天）。
 * ⇒ 竖切的事件卡必须是单日事件；跨天会在这里**明确报出**，而不是悄悄翻日。
 */
async function advanceToReveal(
  l: Ledger,
  eventId: string,
  rng: ReturnType<typeof makeRng>,
  brain: Brain,
): Promise<{ ledger: Ledger; revealed: string[]; log: string[]; stopped: string | null }> {
  let cur = l;
  const revealed: string[] = [];
  const log: string[] = [];
  for (let i = 0; i < 8; i++) {
    const ev = cur.events.live.find((e) => e.id === eventId);
    if (!ev || ev.status !== '揭晓待办') break;
    const left = remainingToday(cur);
    if (left === 0) {
      return {
        ledger: cur,
        revealed,
        log,
        stopped: '当天时间已用尽、事件却还没到 reveal_at ⇒ 需要跨天；跨天会调 compose_day（Phase 3）',
      };
    }
    const r = await dial(cur, left, rng, brain);
    cur = r.ledger;
    revealed.push(...r.revealed);
    log.push(...r.log);
    if (r.revealed.includes(eventId)) break;
  }
  return { ledger: cur, revealed, log, stopped: null };
}

function emptyReport(card: GameEvent, stopped: string, before: Reading): SliceReport {
  return {
    ok: false,
    stopped,
    card,
    intentSummary: '',
    check: null,
    tier: null,
    rollLine: '',
    bonuses: [],
    narration: '',
    deltaRaw: null,
    summary: '',
    nextSeeds: [],
    欲向: '无关',
    deltaOps: [],
    fixes: [],
    drops: [],
    mixedCount: 0,
    ledgerLog: [],
    revealed: [],
    timeLog: [],
    before,
    after: before,
    payload: '',
    digest: '',
  };
}

export async function runSlice(seed: number, brain: Brain, opts: SliceOptions = {}): Promise<SliceReport> {
  const rng = makeRng(seed);
  const spec = opts.card ?? EVENT_CARD;
  const start = sliceLedger(spec);
  const card = start.events.live.find((e) => e.id === 'e1') ?? makeEventCard(spec, 'e1', 1);
  const before = readLedger(start);
  const input: HandleInput = opts.handling ?? { ...DEFAULT_HANDLING, zone: opts.zone };

  // ── ①②③ 排布：裁定（LLM）→ 投骰（规则层）→ 结算（LLM）→ 扣容量 / 锁金币 ──
  let hr: HandleResult;
  try {
    hr = await handleEvent(start, input, rng, brain);
  } catch (e) {
    return emptyReport(card, `调用失败：${e instanceof Error ? e.message : String(e)}`, before);
  }
  if (hr.blockedBy.length > 0) {
    return emptyReport(card, `被闸门拦下：${hr.blockedBy.map((g) => g.reason).join('；')}`, before);
  }

  const arranged = hr.ledger;
  const pending = arranged.pending.find((p) => p.eventId === input.eventId);
  if (!pending) {
    return emptyReport(card, '结构性错误：排布后 pending 里没有这条事件的结果', before);
  }

  // 模型的 `delta` 是**没校验过**的任意形状 —— 这里正是"规则层是唯一防线"的展示位
  const v = validateDelta(pending.delta);

  // ── ④⑤ 拨时间 → 揭晓落账（**零 LLM 调用**：结果早在 pending 里）──
  const adv = await advanceToReveal(arranged, input.eventId, rng, brain);
  const after = readLedger(adv.ledger);

  const payload = JSON.stringify({
    tier: hr.tier,
    bonuses: hr.bonuses,
    deltaOps: v.delta.ops,
    drops: v.drops,
    fixes: v.fixes,
    revealed: adv.revealed,
    ledger: adv.ledger,
  });

  return {
    ok: adv.stopped === null,
    stopped: adv.stopped,
    card,
    intentSummary: hr.intentSummary,
    check: hr.check,
    tier: hr.tier,
    rollLine: hr.log.find((x) => x.startsWith('投骰：') || x.startsWith('免判定：')) ?? '',
    bonuses: hr.bonuses,
    narration: pending.narration,
    deltaRaw: pending.delta,
    summary: pending.summary,
    nextSeeds: pending.next_seeds,
    欲向: pending.欲向,
    deltaOps: v.delta.ops,
    fixes: v.fixes,
    drops: v.drops,
    mixedCount: v.mixedCount,
    ledgerLog: hr.log,
    revealed: adv.revealed,
    timeLog: adv.log,
    before,
    after,
    payload,
    digest: hash(payload),
  };
}
