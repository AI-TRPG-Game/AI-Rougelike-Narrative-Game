// 多轮「穿越」的**状态机**
//
// 一条事件走「亲自 · 多轮」时的**往返循环**：
//
//   开场景 ─┐
//           ├─ 第 n 轮：玩家说一句话 → 一次叙事调用（**不掷骰**，2026-10-07 用户裁定）
//           │            n ≤ SCENE_ROUND_CAP；玩家随时可退出
//   收尾  ─┘  ← 末轮已 `scene_over=true` ⇒ **并入末轮，不再发那一次**
//
// 四条纪律（每一条都在结构里有落点，不是注释）：
//   · **同一场景内保留 assistant 历史**（§2.4）：凭据挂在 `Ledger.scene.conv`，
//     规则层**只搬不解读**；跨天 / 跨事件才全清 —— 那由"场景置回 `null`"自然完成。
//   · **每轮恰好一次调用**：场景不掷骰 ⇒ 没有裁定半、没有第二段
//     （原"两段式下界 n / 上界 2n"的算术随之作废，n ≤ 7 ⇒ 恒 7 次）。
//     ⚠️ 历史里的 `assistant(tool_calls)` 必须**紧跟同 id 的 `tool` 回执**（DeepSeek 硬校验，
//     2026-10-07 实测 400）—— 那份配对由 `llm/brain-llm.ts·sceneTurn` 维护。
//   · **中途轮的资源冻结**（2026-10-06 清单第 4A.1 条）：`delta` 逐轮**丢弃**，
//     资源在收尾那一次落 —— 模型每一轮看得见的是【场景经过】与对话历史。
//   · **收场走「算 / 揭分离」的同一条通道**：收尾结果只进 `pending`、事件转「揭晓待办」，
//     再由 `pushTime(cost)` 走到 `reveal_at` 兑现 —— **不为多轮另开第二条揭晓路径**。
//
// ⚠️ **调用方契约**：场景进行中（`l.scene !== null`）不得再排布别的事件。
//    这一条**刻意没做进闸门**（9 条闸门回答的是"能不能做这一手"，不认场景），
//    而是由 `openScene` 拒绝"第二次开场景"来兜住"同一时刻只有一个场景"。
import { consumeOneShots } from '../rules/ability.ts';
import { applyDelta, commitBatch } from '../ledger/apply.ts';
import { emptyBatch } from '../ledger/batch.ts';
import { reportedCostOf, settleEscrow } from '../ledger/gold.ts';
import { applyVouchers } from '../ledger/vouchers.ts';
import { findPerson, PLAYER_ID, type GameEvent, type GateResult, type Ledger, type SceneState } from '../ledger/types.ts';
import type { DesireTier } from '../contract/types.ts';
import { addPoints, nowOf } from '../rules/clock.ts';
import { blocked, evalGates } from '../rules/gates.ts';
import type { Rng } from '../rules/rng.ts';
import { SCENE_ROUND_CAP, type SceneEndReason } from '../rules/scene.ts';
import type { HandlingRecord } from '../prompt/blocks.ts';
import type { Brain, SceneView } from './brain.ts';
import { pushTime } from './time.ts';

// ── 对外形状 ──────────────────────────────────────────────────

export interface SceneOpenInput {
  eventId: string;
  /** 参与者（默认只有玩家自己）。**必须含玩家** —— 穿越 = 亲自，见下 */
  participants?: readonly string[];
  /** 投入金币 `P`（托管上限，`0` = 不投入） */
  goldInput?: number;
  /** 这一场要用到的物品（进【玩家的处理】块，**不自动消耗**） */
  usedItemId?: string | null;
}

export interface SceneOpenResult {
  ledger: Ledger;
  gates: GateResult[];
  blockedBy: GateResult[];
  log: string[];
  /** 开完场是第 **0** 轮（玩家还没开口） */
  round: number;
  cap: number;
  present: string[];
}

/** 收尾的产物（不含账本 —— 调用方那边已经是收尾之后的账本了） */
export interface SceneCloseResult {
  reason: SceneEndReason;
  narration: string;
  /** 事件级概要 —— 它会**覆盖**本场景的逐轮记录（§2.4） */
  summary: string;
  /** 收尾花了几次调用（`0` = 并入末轮，那一次**没发**） */
  calls: number;
  /** 本次推进中揭晓的事件 id */
  revealed: string[];
  daysPassed: number;
}

export interface SceneLeaveResult extends SceneCloseResult {
  ledger: Ledger;
  log: string[];
}

export interface SceneStepResult {
  ledger: Ledger;
  log: string[];
  /** 刚走完的轮次 */
  round: number;
  narration: string;
  /** 本轮花了几次调用（**恒 1** —— 场景不掷骰，2026-10-07 起没有第二段） */
  calls: number;
  /** 非 `null` ⇒ 场景已收尾（落账 / 揭晓 / 扣时间都做完了） */
  ended: SceneEndReason | null;
  close: SceneCloseResult | null;
}

// ── 小工具 ────────────────────────────────────────────────────

function findEvent(l: Ledger, id: string): GameEvent {
  const ev = l.events.live.find((e) => e.id === id);
  if (!ev) throw new Error(`事件 ${id} 不在事件池里`);
  return ev;
}

function sceneOf(l: Ledger): SceneState {
  if (!l.scene) throw new Error('当前没有进行中的场景 —— 先用 openScene() 进场景');
  return l.scene;
}

/** 一轮在【场景经过】里留下的那一行 —— 收尾时它是逐轮细节**最后一次**露面 */
function turnRecord(round: number, text: string, narration: string): string {
  const said = text.trim() === '' ? '（无补充）' : text.trim();
  return `第 ${round} 轮｜玩家「${said}」｜${narration.trim() || '（无回应）'}`;
}

/**
 * 场景内的**一次落账** —— 中途轮与收尾共用这一条。
 *
 * ⚠️ 金币的口径与 `revealDue` **完全一致**：`applyDelta` 会把 `delta.gold` 全额算进批里，
 *    而托管纪律是「**提交那一刻即扣 `P`**，结算只补差额 / 退差额」⇒ **负的那部分必须冲回**
 *    —— 它是"报告"，不是第二笔支出（2026-09-18 `--live` 实测踩过：不冲回则同一笔钱扣两次）。
 * ⚠️ 冲回之后**余额不动**，但花销必须**报给模型**（【本场景已落账】）—— 否则它下一轮
 *    不知道自己还剩多少额度。⇒ 花销同时记进 `spent`（收尾时与 `P` 一次结清）。
 * ⚠️ `applyDelta` 的 `errors`（解析不到的人 / 物）**不静默吞掉** —— 它照样进清单。
 */
function landSceneDelta(
  l: Ledger,
  raw: unknown,
  roleMap: Record<string, string>,
  eventId: string,
): { after: Ledger; report: string[]; notes: string[]; spent: number } {
  const batch = emptyBatch(l);
  const out = applyDelta(l, (raw ?? { ops: [] }) as never, { roleMap } as never, batch);
  // 凭证 —— 多轮**每一轮**的结算都能产 / 收。
  //    ⚠️ 收尾那一次也走这里（末轮已 `scene_over` 或 `sceneWrap`）⇒ 整场的凭证都落在轮上，
  //       所以 `finish()` 推 `pending` 时凭证给**空**（同 `delta` 的理由：再落一次就是双记）。
  const vou = applyVouchers(l, (raw as { vouchers?: unknown } | null)?.vouchers, batch, {
    day: l.clock.day,
    eventId,
  });
  const spent = reportedCostOf(raw);
  if (spent > 0) batch.gold += spent; // 冲回（见上）
  // ⚠️ 2026-10-06：一次性物品**用掉**（本路径**绕过** `revealDue` ⇒ 消耗要自己调）。
  //    ⚠️ 必须在 `commitBatch` **之后** —— 那才是账本被换掉的那一刻，
  //    而 `consumeOneShots` 就地改那个新账本。
  const usedLines = consumeOneShots(l, eventId);
  const { ledger: after, report } = commitBatch(l, batch);
  const notes = [...report, ...vou.report, ...usedLines];
  for (const w of vou.problems) notes.push(`⚠️ ${w}`);
  if (spent > 0) notes.push(`本轮花费 ${spent} 金币（整场结束时与投入上限结清）`);
  for (const e of out.errors) notes.push(`⚠️ ${e}`);
  return { after, report, notes, spent };
}

// ── 开场景 ────────────────────────────────────────────────────

/**
 * **进场景**（玩家点了「穿越」）—— 闸门 → 锁 `P` → 建场景状态。**不调 LLM**（玩家还没开口）。
 *
 * ⚠️ **不推进时钟**：处理完才自动扣（那在 `finish()` 里）。开场景就扣，会让"进来看一眼
 *    又退出去"白花时间 —— 而退出是玩家的合法权利。
 * ⚠️ 闸门照 **`handle`** 走：进场景本来就是一次排布，没有第二条入口
 *    ⇒ 闸门 ①（时间用尽）/ ④（档 A 未清）/ ③（`仅派遣`）/ ⑥⑦（人数）/ ⑨（金币）全部生效。
 */
export function openScene(ledger: Ledger, input: SceneOpenInput): SceneOpenResult {
  if (ledger.scene !== null) {
    throw new Error(`已有进行中的场景（事件 ${ledger.scene.eventId} 第 ${ledger.scene.round} 轮）⇒ 先收尾再开新的`);
  }
  const ev = findEvent(ledger, input.eventId);
  if (ev.tier === 'A') throw new Error(`「${ev.title}」是档 A 弹窗（点击即结算）⇒ 没有场景可穿越`);
  if (ev.status !== '待处理') throw new Error(`「${ev.title}」当前是 ${ev.status} ⇒ 不能开场景`);

  const present = [
    ...(input.participants && input.participants.length > 0 ? input.participants : [PLAYER_ID]),
  ];
  if (!present.includes(PLAYER_ID)) throw new Error('「穿越」= 玩家亲自 ⇒ 参与者里必须有玩家');
  for (const id of present) {
    if (!findPerson(ledger, id)) throw new Error(`在场者 ${id} 不在账本里`);
  }
  const gold = Math.max(0, input.goldInput ?? 0);

  const gates = evalGates({
    ledger,
    today: ledger.clock.day,
    action: 'handle',
    eventId: ev.id,
    participants: present,
    goldToPay: gold,
  });
  const hard = blocked(gates);
  if (hard.length > 0) {
    return {
      ledger,
      gates,
      blockedBy: hard,
      log: [`开场景被闸门拦下：${hard.map((g) => g.reason).join('；')}`],
      round: 0,
      cap: SCENE_ROUND_CAP,
      present,
    };
  }

  const l: Ledger = structuredClone(ledger);
  const e2 = findEvent(l, ev.id);
  const log: string[] = [];
  const batch = emptyBatch(l);
  // 托管投入 `P`：提交那一刻即扣（同 `handleEvent`）—— 它是**上限**，不是已花的钱
  if (gold > 0) {
    batch.gold -= gold;
    e2.gold_locked = gold;
    log.push(`投入金币 ${gold}（托管上限，已扣）`);
  }
  const { ledger: after, report } = commitBatch(l, batch);
  log.push(...report);

  after.scene = {
    eventId: e2.id,
    round: 0,
    present,
    usedItemId: input.usedItemId ?? null,
    ledgered: [],
    turns: [],
    spent: 0,
    lastTier: null,
    conv: null,
  };
  log.push(
    `进入「${e2.title}」场景（在场 ${present.map((id) => findPerson(after, id)?.name ?? id).join('、')}，轮次上限 ${SCENE_ROUND_CAP}）`,
  );

  return { ledger: after, gates, blockedBy: [], log, round: 0, cap: SCENE_ROUND_CAP, present };
}

// ── 推进一轮 ──────────────────────────────────────────────────

/**
 * **走一轮**（玩家说了这句话）—— 一次调用：叙事 →（收尾合并判断）。
 *
 * ⚠️⚠️ **2026-10-07 用户裁定：场景内不做投掷判定**（用户原话「场景内的LLM对话不需要投掷
 *    判定，去掉相关的输出要求和系统逻辑」）⇒ 原来的两段式（裁定半 → 规则层投骰 → 叙事半）
 *    **整条退休**：没有 `verdict`、没有档位、没有危险区修正 —— 每轮就是**一次**纯叙事调用，
 *    资源照旧冻结到收尾（2026-10-06 清单第 4A.1 条不变）。
 * ⚠️ **主事者恒为玩家本人**：穿越的定义就是"他亲自去"，在场的人只影响叙事。
 * ⚠️ 轮次到达 `SCENE_ROUND_CAP` 时**自动收尾**（`轮数用尽`）—— 上限是**规则层强制的**，
 *    不指望模型在 prompt 里看到"（上限 7）"就自己收（那是把纪律交给最不该给的一方）。
 */
export async function sceneStep(
  ledger: Ledger,
  text: string,
  rng: Rng,
  brain: Brain,
  /** **2026-10-07 用户裁定：回应以流式呈现** —— 原样透传给 `sceneTurn`（假 brain 忽略之） */
  onNarrDelta?: (chunk: string, reset: boolean) => void,
): Promise<SceneStepResult> {
  const sc0 = sceneOf(ledger);
  let l: Ledger = structuredClone(ledger);
  const ev = findEvent(l, sc0.eventId);
  const round = sc0.round + 1;
  const h: HandlingRecord = {
    participants: [...sc0.present],
    usedItemId: sc0.usedItemId,
    goldInput: ev.gold_locked,
    note: text,
  };
  const view: SceneView = { round, presentIds: [...sc0.present], ledgered: [...sc0.ledgered] };
  const log: string[] = [];

  // ── ① 一轮（唯一一次调用：对玩家这句话给出场景里的文字回应）──
  const step = await brain.sceneTurn(ev, l, h, view, sc0.conv, onNarrDelta);
  log.push(`第 ${round} 轮 · 场景回应（不掷骰）`);

  const narr = step.value;
  const calls = 1;

  // ⚠️⚠️⚠️ 2026-10-06 清单第 4A.1 条（用户裁定第 12 条）：**中途轮不再落账** ——
  //   「场景内相当于**资源系统进入冻结状态**…LLM **输出正常文本即可**；
  //     多轮场景的**最后一轮时**…再把整个场景的完整对话上下文注入，
  //     并在指令**明确要求 LLM 根据对话上下文，一次性更新资源系统**」
  //   ⇒ `narr.delta` **这一轮原样丢弃**（不进批、不落账）；资源在**收尾时一次性**落。
  //   ⚠️ **`spent` 也不记**（那是从 delta 里算出来的）—— 收尾那次会连它一起给。
  {
    const sc = l.scene!;
    sc.round = round;
    sc.conv = step.conv;
    sc.lastTier = null; // 场景不掷骰 ⇒ 没有档位可言（收尾的 pending.tier 记 null）
    sc.turns.push(turnRecord(round, text, narr.narration ?? ''));
  }

  const partial: Omit<SceneStepResult, 'ended' | 'close'> = {
    ledger: l,
    log: [...log],
    round,
    narration: narr.narration ?? '',
    calls,
  };

  // ── ② 收场：末轮自己收了 ⇒ **并入**（省一次调用）；轮数用尽 ⇒ 还要一次收尾 ──
  if (narr.scene_over === true) {
    const close = await finish(l, '已自然收束', rng, brain, {
      merged: true,
      summary: narr.summary ?? '',
      seeds: narr.next_seeds ?? [],
      desire: narr.欲向 ?? '无关',
      narration: narr.narration ?? '',
    });
    return {
      ...partial,
      ledger: close.ledger,
      log: [...log, ...close.log],
      calls: calls + close.calls,
      ended: close.reason,
      close: stripLedger(close),
    };
  }
  if (round >= SCENE_ROUND_CAP) {
    const close = await finish(l, '轮数用尽', rng, brain, { merged: false });
    return {
      ...partial,
      ledger: close.ledger,
      log: [...log, ...close.log],
      calls: calls + close.calls,
      ended: close.reason,
      close: stripLedger(close),
    };
  }
  return { ...partial, ended: null, close: null };
}

// ── 收尾 ──────────────────────────────────────────────────────

function stripLedger(r: SceneLeaveResult): SceneCloseResult {
  return {
    reason: r.reason,
    narration: r.narration,
    summary: r.summary,
    calls: r.calls,
    revealed: r.revealed,
    daysPassed: r.daysPassed,
  };
}

interface FinishOpts {
  /**
   * 末轮已经 `scene_over=true` 并把收尾字段一并填好了 ⇒ **不再发收尾那一次调用**。
   * 《规则.md》§二 路径⑤：「收尾结算可与最后一轮的叙事调用合并」——
   * 省下来的正是全场最贵那一处的**最后一次**往返。
   */
  merged: boolean;
  summary?: string;
  seeds?: readonly string[];
  desire?: DesireTier;
  narration?: string;
}

/**
 * **收场** —— 收尾（可省）→ 金币结清 → 事件转「揭晓待办」→ 扣 `cost` 并揭晓。
 *
 * ⚠️ **`delta` 给空**：整场的 `delta` **已经逐轮落过账**了 —— 再落一次就是双记
 *    （`revealDue` 会照单全收）。而 `summary` / `next_seeds` / `欲向` 反之：
 *    它们只在**收场那一次**算数（多轮取最后一次，同 `summary`），所以交给揭晓兑现。
 * ⚠️ **`gold_locked` 在推 `pending` 之前清零**：那笔钱已经在上面的 `settleEscrow` 里
 *    结清了。不清零 ⇒ 揭晓那一步会拿一份空 delta 再结一次账，把整笔 `P` 当成退款吐回来。
 */
async function finish(
  ledger: Ledger,
  reason: SceneEndReason,
  rng: Rng,
  brain: Brain,
  o: FinishOpts,
): Promise<SceneLeaveResult> {
  let l: Ledger = structuredClone(ledger);
  const log: string[] = [];
  const calls = o.merged ? 0 : 1;

  let summary = o.summary ?? '';
  let seeds: readonly string[] = o.seeds ?? [];
  let desire: DesireTier = o.desire ?? '无关';
  let narration = o.narration ?? '';
  /** ⚠️ 2026-10-06：收尾那次调用产出的凭证（**原先写死空** ⇒ 场景永不产凭证）。 */
  let 收尾凭证: unknown = [];

  if (!o.merged) {
    const sc = sceneOf(l);
    const ev = findEvent(l, sc.eventId);
    const w = await brain.sceneWrap(
      ev,
      l,
      reason,
      { turns: [...sc.turns], ledgered: [...sc.ledgered] },
      sc.conv,
    );
    const res = w.value;
    // ⚠️⚠️ 2026-10-06 清单第 4A.1 条：**这里是整场唯一一次落资源的地方**。
    //   中途轮全部冻结（见 `sceneStep` ④），所以这一次 `res.delta` 就是"整场的最终账"。
    //   ⚠️ `spent` 也在这一次算（中途不再记）⇒ 下面的托管结清拿到的 `sc3.spent` 才是完整的。
    const landed = landSceneDelta(l, res.delta, { 参与者: PLAYER_ID, 主事者: PLAYER_ID }, sc.eventId);
    l = landed.after;
    log.push(...landed.report);
    const sc2 = l.scene!;
    sc2.spent += landed.spent;
    sc2.ledgered.push(...landed.notes);
    // ⚠️ **凭证也在这里一次给全**（原先写死空数组 ⇒ 场景永不产凭证）
    收尾凭证 = (res as { vouchers?: unknown }).vouchers;
    summary = res.summary ?? '';
    seeds = res.next_seeds ?? [];
    desire = res.欲向 ?? '无关';
    narration = res.narration ?? narration;
    log.push(`收尾结算（${reason}）：${summary || '（无概要）'}`);
  } else {
    log.push(`末轮已自行收束（${reason}）⇒ **省掉**收尾那一次调用`);
  }

  const sc3 = l.scene!;
  const e2 = findEvent(l, sc3.eventId);

  // ── 金币结清：净额 = −min(整场实际花销, P)，与单轮完全同一口径 ──
  const batch = emptyBatch(l);
  if (e2.gold_locked > 0) {
    const esc = settleEscrow(sc3.spent, e2.gold_locked);
    batch.gold += esc.refund;
    log.push(`托管结清（${esc.note}）`);
  }

  // ── 事件收场：走「算 / 揭分离」的同一条通道 ──
  const now = nowOf(l);
  e2.status = '揭晓待办';
  e2.handler = PLAYER_ID;
  e2.participants = [...sc3.present];
  e2.started_at = now;
  e2.reveal_at = addPoints(now, e2.cost);
  e2.gold_locked = 0;
  const rounds = sc3.round;
  const cost = e2.cost;
  const title = e2.title;
  l.pending.push({
    eventId: e2.id,
    tier: sc3.lastTier,
    narration,
    // ⚠️⚠️ 2026-10-06：**不再给空 delta** —— 收尾那次算出来的资源变化**在这里兑现**
    //   （`landSceneDelta` 已经把它记进 `sc2.ledgered` 供人看；账由那一批 `commitBatch` 落）。
    //   ⚠️ 这条与"算 / 揭分离"同族：**结果在 pending 里等着，拨到 `reveal_at` 才 `revealDue`**。
    delta: { ops: [] },
    summary,
    next_seeds: [...seeds],
    // ⚠️⚠️ 2026-10-06：**给收尾那次产出的凭证**（原先写死 `[]` ⇒ 场景永远产不出凭证）。
    //   理由与 `delta` 同一条：中途轮不再落 ⇒ 这里**不是双记**，是**头一次也是唯一一次**。
    vouchers: (收尾凭证 ?? []) as never,
    欲向: desire,
  });
  // ⚠️ 场景到此为止 —— "在不在场景里"只有 `scene === null` 这一个判据（`conv` 随之弃掉）
  l.scene = null;

  const { ledger: closed, report } = commitBatch(l, batch);
  log.push(...report);
  log.push(`场景收场：${rounds} 轮 · ${reason} ⇒ 「${title}」转「揭晓待办」（${cost} 点后揭晓）`);

  // ── 扣时间：处理完**自动扣**，走到 `reveal_at` 即揭晓 ──
  const t = await pushTime(closed, cost, rng, brain);
  log.push(...t.log);

  return {
    ledger: t.ledger,
    log,
    reason,
    narration,
    summary,
    calls,
    revealed: t.revealed,
    daysPassed: t.daysPassed,
  };
}

/**
 * **玩家主动退出**（或上层因别的原因强制收场）。
 *
 * ⚠️ 退出**不是**"什么都没发生"：这一场的 `delta` 已经逐轮落过账了，
 *    所以仍要走一次收尾结算把 `summary` 补上（`轮数用尽` 之外的两个原因之一）。
 */
export async function sceneLeave(
  ledger: Ledger,
  rng: Rng,
  brain: Brain,
  reason: SceneEndReason = '玩家主动退出',
): Promise<SceneLeaveResult> {
  sceneOf(ledger); // 没场景就抛 —— 与 `sceneStep` 同一条前置
  return await finish(ledger, reason, rng, brain, { merged: false });
}
