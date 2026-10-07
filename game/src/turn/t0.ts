// T0 · 每日开场（「起床」）
//   **揭晓 → 过期结算 →（重写命题）→ 章节占卜 → 概要归并 → 生成**
//
// ⚠️ 2026-09-18 时钟模型改造后的职责缩减：
//    「揭晓」**不再由 T0 驱动** —— 它是**时间点事件**（`reveal_at`），
//    由 `turn/time.ts` 在时间推进的每一步兑现（"走到几点，就结算到几点"）。
//    T0 只剩**开场动作**：过期兜底 +（重写命题）+（章节占卜）+ 生成今天的自由事件
//    （重写命题 = Phase 4 侧链，2026-09-19 落地；**章节占卜 = 2026-09-22 落地**；
//     **概要归并 = 2026-09-22 落地**）。
//    翻日（`turnOver`）也挪到了本文件，供 `time.ts` 在跨日时调用。
//
// ⚠️ 2026-09-18 「过期转种子」已废（用户裁定）：**过期事件也走一次标准结算**
//    （LLM 按"玩家选择忽略这件事"生成后果与概要）⇒ 它落账后就是 `已结算`，
//    与"处理完的"在账本里**没有区别**、也**不再需要**第二个终态或过期种子。
import { consumeOneShots } from '../rules/ability.ts';
import { applyDelta, commitBatch } from '../ledger/apply.ts';
import { emptyBatch } from '../ledger/batch.ts';
import { nextSeedCode } from '../ledger/ids.ts';
import { applyVouchers } from '../ledger/vouchers.ts';
import { PLAYER_ID, type GameEvent, type Ledger, type TimePoint } from '../ledger/types.ts';
import { chapterOf, isExpired, nowOf, payrollForDay, phaseOf } from '../rules/clock.ts';
import { isDivinationDay } from '../rules/chapter-shift.ts';
import { planArchive } from '../rules/archive.ts';
import { dangerZoneOf, desireDelta, DESIRE_MAX, DESIRE_MIN, driftOf } from '../rules/desire.ts';
import { clamp } from '../rules/num.ts';
import type { Rng } from '../rules/rng.ts';
import { drawDivinationCards } from '../rules/tarot.ts';
import { BASE_ACTION_POINTS } from '../rules/x.ts';
import type { Brain } from './brain.ts';
import { applyChapterShift, divinationRng } from './chapter-shift.ts';
import { applyArchive } from './archive.ts';
import { landCompose } from './land-compose.ts';

export interface DayStartResult {
  ledger: Ledger;
  log: string[];
  /** 今天新生成、**直接进事件池**的事件（模拟器统计用） */
  created: GameEvent[];
  /** 今天新生成、但被某条选项的 `trigger` 引用 ⇒ 先藏在 `events.hidden` 的条数 */
  hidden: number;
  /**
   * 今天这一次**章节占卜**落了什么（非占卜日 / 失败 ⇒ `null`）。
   * ⚠️ 只回传**氛围** —— 它是这一次产出里**唯一玩家可见**的那一半；
   *    欲念变化与命中判定留在 `log` 里（开发侧），**不给播报用**（用户 2026-09-22 的分层要求）。
   */
  divination: { ambience: string } | null;
  /**
   * 今天这一次**概要归并**落了什么（没触发 / 失败 ⇒ `null`）。
   * ⚠️ 它是四条侧链里**唯一不给玩家看**的一条（产物只进账本与 prompt）——
   *    章级概要由 UI 的左栏读 `view().archive` 渲染，**不需要占卜那样的专属播报**。
   */
  archived: { days: number[]; segment: string } | null;
}

/**
 * 进入某一天的**开场动作**（= 开发规划里的 T0）。
 * ⚠️ 本函数**不翻日**（`day` 已经是今天）—— 翻日是 `turnOver` 的职责。
 * ⚠️ **async**：`composeDay` 是 LLM 调用（Phase 3 起是真调用；Phase 2 仍是假事件）。
 * ⚠️ `seed` 只喂给**占卜那条独立随机流**（`divinationRng(seed, day)`）——
 *    它**不碰** `rng` 这个入参。两个理由：① 正文那条流是"整局轨迹"，
 *    插 4 个 `int` 会把所有基线种子的 28 天整体挪位；② 占卜抽什么牌**本就不该**
 *    受"前面几天掷了多少次骰"影响。见 `turn/chapter-shift.ts·divinationRng`。
 *    ⚠️ 默认 0 只为测试与竖切路径能直接调 —— 两个**真实**入口（`simulate` / `Session`）
 *    都必须把种子传进来，否则三个种子会抽到同一副占卜牌。
 */
export async function enterDay(
  ledger: Ledger,
  rng: Rng,
  brain: Brain,
  seed = 0,
): Promise<DayStartResult> {
  let l: Ledger = structuredClone(ledger);
  const log: string[] = [];

  // ① 过期兜底（正常路径下 `pushTime` 已在每个时间点判过；这是"直接跳进某天"时的唯一入口）
  const ex = await settleExpired(l, nowOf(l), brain);
  l = ex.ledger;
  log.push(...ex.log);

  // ② 章节占卜（Phase 4 侧链 · 每章一次）—— 第 1 / 8 / 15 / 22 天日初、**生成之前**。
  //    ⚠️ 2026-10-05：这里原来还有一个 ②'「重写命题」段（欲念首破 60 的次日调 `rewrite_desire`
  //       改写欲望命题）—— 已随**侧链整体删除**：欲望命题现在**一生只写一次**
  //       （`opening` 里一次成型），T0 开头不再有任何"改写"动作。
  //    T0 内部顺序因此只剩四步：**过期结算 → 章节占卜 → 概要归并 → 生成**。
  //    一条顺序纪律在这里有着落：它排在**生成之前**。
  //    ⚠️ 谓词用 `rules/chapter-shift.ts·isDivinationDay`，**不是** `isChapterStart` ——
  //       后者在第 1 天返回 false，而占卜日含第 1 天（那个坑写在那个文件顶上）。
  //    ⚠️ **失败 / 空输出 ⇒ 保留上一章的氛围、记警告**：一条侧链失败不该炸掉整个 T0。
  //       氛围与欲念变化是**原子**的 ⇒ 失败即两样都不落。
  //    ⚠️ 抽牌走 `divinationRng(seed, day)`（**独立流**），不伸进正文那条 `rng`。
  let divination: { ambience: string } | null = null;
  if (isDivinationDay(l.clock.day)) {
    const cards = drawDivinationCards(divinationRng(seed, l.clock.day));
    try {
      const raw = await brain.chapterShift(l, cards);
      const r = applyChapterShift(l, raw, cards);
      l = r.ledger;
      log.push(...r.log);
      divination = { ambience: r.ambience };
    } catch (e) {
      log.push(
        `⚠️ 第 ${l.clock.day} 天 chapter_shift 调用失败，本周氛围保持上一版：` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ③ 概要归并（Phase 4 侧链 · 全局约 2~3 次）—— 排在**章节占卜之后、生成之前**。
  //    T0 内部顺序：**过期结算 → 章节占卜 → 概要归并 → 生成**。
  //    · 排在**生成之前**是必须的：生成侧是概要的最大消费者，
  //      先并后生成，当天生成与结算看到的才是**同一份历史**；
  //    · 「白天绝不归并」：归并会在 prompt 中段刻出一个新分叉点，当天剩余 `resolve` 一起失配
  //      ⇒ 所以它只在换日 T0 这个唯一时点上跑（这一段本来就在 T0 里）。
  //    ⚠️ **触发判据全在 `rules/archive.ts·planArchive`**：章首软触发（逐条区 > 2000 字）
  //       或任意日硬触发（总量 > 5000 字），且**永远保留最近一整天**（`N = min(7, 天数 − 1)`）。
  //       ⚠️ 用户 2026-09-22 裁定「放宽标准」（压缩会减损信息量）⇒ 阈值按文档原值落，
  //          **标准 28 天里它一次都不触发** —— 那是设计意图。覆盖率靠 `driveArchive` 驱动点亮。
  //    ⚠️ **失败 / 空输出 ⇒ 概要保持原样、记警告**：一条侧链失败不该炸掉整个 T0
  //       （与上面「章节占卜」同一条纪律）。
  let archived: { days: number[]; segment: string } | null = null;
  {
    const plan = planArchive(l.clock.day, l.summaries.recent, l.summaries.archive);
    if (plan.trigger) {
      try {
        const raw = await brain.archive(l, plan);
        const r = applyArchive(l, raw, plan);
        l = r.ledger;
        log.push(...r.log);
        archived = { days: r.days, segment: r.segment };
      } catch (e) {
        log.push(
          `⚠️ 第 ${l.clock.day} 天 archive 调用失败，概要保持原样：` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  // ④ 生成今天的自由事件 —— 【LLM】→ **落地层**（校验 / 改编号 / 分通道 / 核销种子）
  //    ⚠️ `landCompose` **会就地写账本**（`events` / `seeds` / `entities.places` / `idWatermark`），
  //       所以这里不再自己 push —— "哪条进 `live`、哪条进 `hidden`"是落地层一个人的决定。
  let fresh: GameEvent[] = [];
  let hidden = 0;
  try {
    const raw = await brain.composeDay(l, rng);
    const landed = landCompose(l, raw);
    fresh = landed.live;
    hidden = landed.hidden.length;
    log.push(...landed.log);
    for (const p of landed.problems) log.push(`⚠️ ${p}`);
    if (fresh.length > 0 || hidden > 0) {
      log.push(
        `第 ${l.clock.day} 天生成 ${fresh.length} 条自由事件` +
          (hidden > 0 ? `（另有 ${hidden} 条隐藏事件，等 trigger 唤醒）` : ''),
      );
    }
  } catch (e) {
    // ⚠️ **不静默吞掉**：生成半失败 ⇒ 今天没有自由事件，但必须留一条刺眼的日志。
    //    静默 `[]` 会造出"今天本来就没事件"的假象 —— 正是「绿了但没测到」那一类
    //    （与 `brain-llm.ts` 里那句"刻意抛错而不是返回空数组"是同一条纪律的延续）。
    log.push(
      `⚠️ 第 ${l.clock.day} 天生成半调用失败，今天没有自由事件：${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return { ledger: l, log, created: fresh, hidden, divination, archived };
}

/**
 * 翻日：`day + 1`、时间读数归零、周例钱、下属容量重置。
 * ⚠️ 周例钱在**进入第 1 / 8 / 15 / 22 天**时发；第 1 天那次**就是**序幕占位数值里的「金币 5」。
 * ⚠️ 本函数**不生成事件**（生成是 `enterDay` 的事）—— 跨日推进时由 `pushTime` 接力调用。
 */
export function turnOver(l: Ledger): string[] {
  const log: string[] = [];
  l.clock.day += 1;
  l.clock.usedToday = 0;
  l.clock.phase = phaseOf(l.clock.day);
  l.clock.chapter = chapterOf(l.clock.day);
  const pay = payrollForDay(l.clock.day);
  if (pay > 0) {
    l.scalars.gold += pay;
    log.push(`第 ${l.clock.day} 天周例钱 +${pay}`);
  }

  // ② 危险区漂移—— **翻日瞬间**落账，与周例钱、容量重置同批。
  //    · 判据取"昨夜结束时"的欲念（此刻还没被今天的任何结算动过）；
  //    · 迷失区 1~24 每天 −2、沉溺区 81~99 每天 +2、常态与窗口 0（无税）；
  //    · **不设缓冲日**（2026-09-21 用户裁定）—— 跨入当天就开始漂（与《设定.md》§二不一致，以代码为准）；
  //    · 它把欲念推到 0 / 100 ⇒ 那一局终结，由调用侧的 `terminateIfOver` 收走
  //      （本函数**不判结局**：「写账」与「判定」分家，见 `turn/ending.ts` 顶栏那条纪律）。
  {
    const zone = dangerZoneOf(l.desire.value);
    const d = driftOf(zone);
    if (d !== 0) {
      const before = l.desire.value;
      l.desire.value = clamp(before + d, DESIRE_MIN, DESIRE_MAX);
      log.push(`危险区漂移（${zone}）：欲念 ${before} ${d > 0 ? '+' : ''}${d} → ${l.desire.value}`);
    }
  }

  for (const p of l.entities.people) {
    if (p.id !== PLAYER_ID) l.actionPoints.byNpc[p.id] = BASE_ACTION_POINTS;
  }
  // 玩家**永远不进** `byNpc`（他的预算读数是 `clock.usedToday`）——顺手清掉任何历史遗留。
  delete l.actionPoints.byNpc[PLAYER_ID];
  l.gates = [];
  log.push(`进入第 ${l.clock.day} 天（第 ${l.clock.chapter} 章 · ${l.clock.phase}）`);
  return log;
}

/**
 * **过期结算** —— 过了窗口、还没人处理的「待处理」事件，**当作一次"玩家选择忽略"的标准结算**。
 *
 * 《规则.md·过期》＋ 2026-09-18 用户裁定。取代了原来的"过期转种子"，三个后果：
 *   · **`已过期` 状态取消**：落账后就是 `已结算`，账本里不再有第二个终态；
 *   · **过期种子取消**：不再需要靠种子向生成侧"通风报信"—— 概要里已经有了；
 *   · **结算侧终于看得见它**：此前"没人管的事"对 `resolve` 完全隐形（不进概要，而种子属生成侧那一格）。
 *
 * ⚠️ **直接落账、不经 `pending`**：过期是"等到时间才发生"，没有额外的等待可言 ——
 *    "算 / 揭分离"（那套是为"派遣要等"准备的）在这里没有意义。
 * ⚠️ **async ＋ 要 brain**：换日路径上唯一的一次 LLM 调用。它能被集中在这里，
 *    全靠 `deadline` 的单位是**天**（用户裁定）⇒ **过期只落在日界上**。
 * ⚠️ **逐条 commit**：每条忽略都是一次独立结算 ⇒ 各自成一批、各自"批末钳一次"，
 *    与 `handleEvent`"一条事件一个 batch"同构。
 */
export async function settleExpired(
  ledger: Ledger,
  now: TimePoint,
  brain: Brain,
): Promise<{ ledger: Ledger; log: string[]; expired: string[] }> {
  const log: string[] = [];
  const expired: string[] = [];
  let l: Ledger = ledger;

  // ⚠️ 先固化 id 列表：循环里 `l` 会被整个换掉（`commitBatch` 返回新对象）⇒ 不能持有旧数组的引用
  const dueIds = l.events.live
    .filter((e) => e.status === '待处理' && isExpired(e, now))
    .map((e) => e.id);

  for (const id of dueIds) {
    const ev = l.events.live.find((e) => e.id === id);
    if (!ev) continue;
    const raw = await brain.ignore(ev, l);

    const batch = emptyBatch(l);
    // ⚠️ **角色词不映射**：忽略没有主事者与参与者 —— 写「参与者 / 主事者」解析不到人（记一笔 error 后丢弃），
    //    而不是把它们错记到玩家头上。要指名道姓时，模型照【实体状态】里的 id 写。
    //    （「玩家」不受影响：`roleTarget` 对它恒返回 `PLAYER_ID`。）
    applyDelta(l, (raw.delta ?? { ops: [] }) as never, { roleMap: {} }, batch);
    // 凭证 —— 与 `delta` **同一批、同一个时刻**
    const vou = applyVouchers(l, raw.vouchers, batch, { day: now.day, eventId: id });
    log.push(...vou.report);
    // ⚠️ 2026-10-06：一次性物品**用掉**（本路径**绕过** `revealDue` ⇒ 消耗要自己调）。
    //    ⚠️ 过期结算的语义是「玩家选择**忽略**这件事」（`t0.ts·settleExpired` 顶栏）——
    //       那么**他并没有派谁去**，也就没人"处理了某事件"……
    //       ⇒ 这里仍消耗，是按「东西已经挂在参与者身上了，这一局就结束」的读法：
    //       它不会凭空进下一个人的背包（人都可能已经没了），但也不能留在账上装样子。
    //       ⚠️ 若将来定了"忽略 ⇒ 不消耗"，改**这一行**即可（判据集中在一处）。
    for (const line of consumeOneShots(l, id)) log.push(line);
    for (const w of vou.problems) log.push(`⚠️ ${w}`);
    if (raw.欲向) batch.desire += desireDelta(raw.欲向);
    if (raw.summary) {
      l.summaries.recent.push({ day: now.day, text: raw.summary });
      // ⚠️ 与 `revealDue` 同一条口径：生成侧「已处理」清单要标题＋概括配对（第十五批）。
      ev.settled_summary = raw.summary;
    }
    for (const s of raw.next_seeds ?? []) {
      // ⚠️ 编号走 `nextSeedCode()`（**不是** `l.seeds.length + 1`）：硬种子跨天留存 ⇒
      //    池子可能带洞，`length + 1` 会与留着的那条撞号（`claimSeed` 按 code 查 ⇒ 静默双核销）。
      l.seeds.push({ code: nextSeedCode(l.seeds), title: s, content: s, source: 'LLM' });
    }
    ev.status = '已结算';

    const { ledger: committed, report } = commitBatch(l, batch);
    l = committed;
    expired.push(id);
    log.push(`过期结算：「${ev.title}」—— 没人处理，按「忽略」结了账`);
    log.push(...report);
  }

  return { ledger: l, log, expired };
}
