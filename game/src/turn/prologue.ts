// 序幕（前 2 天 · 10 条档 A）—— **写入侧**
//
// 这个文件做五件事：
//   ① `startPrologue` —— 开局把序幕**除末条外一次全铺**（`e1`…`e4`、`e6`…`e9`）；`e1`~`e10` 这十个号在
//      `initialLedger()` 里就已经订走了（见 `ledger/ids.ts·initialWatermark`）；
//   ② `advancePrologue` —— 点完一条之后看一眼：其余事件**全都处理完了**才铺末条「原初欲望的觉醒」；
//   ②′ `skipToOpening` —— 玩家点「直接正式开始游戏」：掐掉还没读的那些，直接铺末条；
//   ③ `afterPrologueCard` —— **唯一的编排入口**：点完一条之后该干什么（末条 ⇒ 翻牌；其余 ⇒ `advancePrologue`）；
//   ④ `driveOpening` / `prologueRng` —— 末条「原初欲望的觉醒」的实质内容（翻两张塔罗 → `opening`）。
//
// ⚠️ **它是"写账"不是"判定"**：这里**不判结局、不推进时钟**；档 A 的结算全在
//    `turn/popup.ts·choosePopup`（那里零 LLM、零掷骰）。"点下末条之后要翻牌、要进第 1 天"
//    由调用侧（`ui/session.ts` / `turn/simulate.ts`）编排 —— 与"写账 / 判定分家"同一条纪律。
//
// ── ⚠️⚠️ **平铺 ＋ 末条条件出现**（2026-10-08 用户裁定，取代原先的"一次只铺一条"）──
// 用户原话：序幕事件要**平铺在地图上、没有强制的点击顺序**；末条「原初欲望的觉醒」是特殊的，
// **其余事件点完后、或玩家点「直接正式开始游戏」按钮后**才出现（按钮随之消失），其后逻辑不变。
//    ⇒ 除末条外开局一次全铺（`startPrologue`），点选顺序完全自由（`choosePopup` 本就不走闸门）；
//    ⇒ 末条只在两条路上出现：其余全部结算（`advancePrologue` ①步步看）/ 按钮直通（`skipToOpening`）。
//
// ⚠️ **"序幕没走完就不许干别的"不靠这里保证，靠闸门 ④**：只要还有一条是「待处理」，
//    闸门 ④ 就拦下**其它排布**与**「进下一天」**（条与条之间的先后**不再**约束 —— 2026-10-08）。
//    （闸门 ④ 对 `advanceDay` 的拦截此前**只存在于单测里**：`nextDay` 从不问闸门。
//      序幕落地时在 `ui/session.ts·nextDay` 补了当天入口的拦截，见那里。）
//
// ⚠️ **它们不是"生成侧的事件"**：`source` 概念只存在于种子；这 10 条
//    `created_day = 0`、`tier = 'A'`、无 `hint_attr`、`cost = 0`、`delta` 留空 ——
//    生成侧那套（难度 / 属性 / 期限）**对它们无意义**，别顺手补上默认值。
//
// ⚠️ **欲向 = `无关`**：序幕期欲念是**固定占位 30**
//    ⇒ 给别的档会当场把 30 改掉。理由与四条纪律写在 `rules/prologue.ts` 顶栏。
//
// ⚠️ **概要不用这里的代码搬**：每条文案各附一句「并入概要」，`choosePopup` 点选时按
//    `options[].summary` ＋ `day = clock.day`（= 0）推进 `summaries.recent` ⇒ 序景点完，
//    `recent` 里就躺着 9 条 `day = 0` 的固定概要（末条「原初欲望的觉醒」`summary: ''` 不计入）。
//    这正是《契约.md》§5.7 ⓪ 说的"第 1 天 T0 并入" —— 它**不是一次搬运**，而是
//    "进第 1 天时它本来就在【已处理概要】里了"。⚠️ 归并**不许**碰它们：见 `rules/archive.ts`
//    里那句 `filter((d) => d > 0)`（序幕固定概要是后续生成唯一的"开局记忆"）。
import { formatEventId } from '../ledger/ids.ts';
import { PLAYER_ID, type EventOption, type GameEvent, type Ledger } from '../ledger/types.ts';
import type { Rng } from '../rules/rng.ts';
import { makeRng } from '../rules/rng.ts';
import {
  PROLOGUE_CARDS,
  PROLOGUE_DESIRE_TIER,
  PROLOGUE_MAX_SEQ,
  PROLOGUE_OPENING_ID,
  PROLOGUE_TOTAL,
  isPrologueEventId,
  prologueCardOf,
  prologueSeqOf,
  type PrologueCardSpec,
} from '../rules/prologue.ts';
import type { Brain } from './brain.ts';
import { applyPlayerChoice, type OpeningChoice } from './opening.ts';

const EMPTY_DELTA = { ops: [] } as const;

/** 按**名字**找账本里的地点 id（`initialLedger` 的 9 处预置地点是唯一来源） */
function placeIdOf(l: Ledger, name: string): string | null {
  return l.entities.places.find((p) => p.name === name)?.id ?? null;
}

/** 一条序幕文案 → 一条档 A 的 `GameEvent` */
function cardToEvent(l: Ledger, c: PrologueCardSpec, log: string[]): GameEvent {
  const locId = placeIdOf(l, c.place);
  if (locId === null) {
    // 结构性错误：地点名写错不该静默 —— 序列表里少一处地界，玩家就会看见一个没有舞台的事件
    log.push(`⚠️ 序幕「${c.title}」的地点「${c.place}」不在账本里（结构性错误）⇒ 这一条没有地点`);
  }
  const options: EventOption[] = c.options.map((o) => ({
    text: o.text,
    result_text: o.resultText,
    欲向: PROLOGUE_DESIRE_TIER,
    delta: { ops: [] },
    // ⚠️ 概要**照挂**：`choosePopup` 会把它按 `day = 0` 推进 `summaries.recent`
    //    （末条是 `''` ⇒ 自动跳过）。见顶栏最后一段。
    summary: c.summary,
    trigger: null,
  }));
  return {
    id: formatEventId(c.seq),
    title: c.title,
    content: c.scene,
    stage: c.stage ?? c.place,
    location: locId,
    tier: 'A',
    // 档 A 恒 `两者皆可`（它根本没有参与者 —— 点击即结算）
    dispatchable: '两者皆可',
    // 序幕那 10 条也是档 A（恒无参与者）⇒ 同一条口径
    required_person: '',
    cost: 0,
    min_gold: 0,
    min_people: 0,
    max_people: 0,
    // 档 A 恒 1 且**永不过期**（`expiresAt` 对档 A 直接返回 null）——它只受"当天必须清"约束
    deadline: 1,
    options,
    // 档 A 的效果写在 `options[].delta` 里（这里留空 —— 序幕本来就不动账）
    delta: null,
    hint_attr: [],
    difficulty: '无修正',
    status: '待处理',
    created_day: 0,
    started_at: null,
    reveal_at: null,
    handler: null,
    participants: [],
    gold_locked: 0,
    depart_cost: null,
  };
}

/**
 * 铺开序幕 —— **开局的第一个动作**（`day 0 / 序幕`）。
 *
 * ⚠️⚠️ **除末条外一次全铺**（2026-10-08 用户裁定「平铺、无强制点击顺序」）：
 *    末条「原初欲望的觉醒」**不在这里铺** —— 它只在①其余事件全部结算（`advancePrologue`）
 *    或②玩家点「直接正式开始游戏」（`skipToOpening`）之后出现。
 * ⚠️ **幂等**：牌池里已经能找到任意一条序幕 id（说明序幕已经开始过了）就**原样返回**，
 *    只记一行日志。开一篇新局是 `initialLedger()` 的事，不是"再铺一遍"。
 *    ⚠️ 幂等判据是"有没有序幕 id"，**不是**"第 1 条是否还在待处理" ——
 *       否则点到一半再调一次会**从 e1 重来一遍**（e1 已被点掉 ⇒ 判据落空 ⇒ 又铺一条 e1）。
 * ⚠️ **水位在 `initialLedger()` 里就已经订到 10**（`ledger/ids.ts·initialWatermark`）——
 *    这里再 `Math.max` 一次只是**防御**（手搭的账本 / 旧存档可能还是 0）。
 *    正文第一条**生成**的事件恒从 `e11` 起，与跑不跑序幕无关。
 *    顺位纪律是"单调递增、永不复用"，不是"从 1 开始"—— 序幕先把 1~10 订下了。
 * ⚠️ 玩家**不动** `actionPoints`：序幕 0 行动点（玩家本来就不在 `byNpc` 里）。
 */
export function startPrologue(ledger: Ledger): { ledger: Ledger; log: string[] } {
  const l: Ledger = structuredClone(ledger);
  const log: string[] = [];
  if (l.events.live.some((e) => isPrologueEventId(e.id))) {
    log.push('序幕已经铺过 ⇒ 原样返回（`startPrologue` 幂等）');
    return { ledger: l, log };
  }

  // ⚠️ **除末条（`opening: true`）外全铺**：末条条件出现，见顶栏「平铺 ＋ 末条条件出现」。
  const laid = PROLOGUE_CARDS.filter((c) => c.opening !== true);
  if (laid.length === 0) {
    // 结构性错误：序列表空了。**不静默** —— 没有序幕的一局等于"六维全 5 + 命题为空"的残局。
    log.push('⚠️ 序幕事件表是空的（结构性错误）⇒ 没有铺任何东西，直接进正文');
    return { ledger: l, log };
  }
  for (const c of laid) l.events.live.push(cardToEvent(l, c, log));
  // ⚠️ `Math.max` 而不是直接赋值：水位**只许涨**（顺位纪律）。
  //    ⚠️ 用 **`PROLOGUE_MAX_SEQ`（10）** 而不是条数（9）：各条保留原号，
  //    `e5` 是空号，正文第一条生成事件恒从 `e11` 起（2026-10-07 删卡不改号）。
  l.idWatermark.event = Math.max(l.idWatermark.event, PROLOGUE_MAX_SEQ);

  const d1 = PROLOGUE_CARDS.filter((c) => c.day === 1).length;
  log.push(
    `序幕开始（显示「Day 0」· 共 ${PROLOGUE_TOTAL} 条档 A：第 1 天 ${d1} 条 / 第 2 天 ${PROLOGUE_TOTAL - d1} 条）—— ` +
      '全档 A、0 行动点、0 调用；除末条外**一次全铺、自由点选**，末条「原初欲望的觉醒」条件出现后触发 `opening`',
  );
  log.push(
    `事件顺位：${formatEventId(1)} ~ ${formatEventId(PROLOGUE_MAX_SEQ)}（正文第一条生成事件从 ${formatEventId(PROLOGUE_MAX_SEQ + 1)} 起）` +
      `　·　末条在其余事件处理完（或点「直接正式开始游戏」）后出现`,
  );
  return { ledger: l, log };
}

/**
 * 点完一条序幕事件之后看一眼（原「铺下一条」，2026-10-08 改判）：
 *   ① **补齐**：live 里缺的非末条序幕卡一次补齐 —— 这是给**旧档的迁移**（旧模型"一次只铺
 *      一条"，读回来的档只铺过前几条 ⇒ 补齐后旧档玩家也进新模型的"平铺"体验）；
 *   ② **末条**：其余序幕事件全都铺出、且没有一条还「待处理」⇒ 铺「原初欲望的觉醒」。
 *
 * ⚠️ 幂等：没事可做 ⇒ 原样返回、零日志、**同一个账本对象**。
 *    调用侧可以放心地"点一次、看一次"，不必自己数。
 * ⚠️ 判据是**逐条看状态**而不是"最大序号 + 1"：2026-10-07 删掉原第 5 条后 seq 中间空 5，
 *    按"加一"找会找不到卡；且新模型下铺出的先后不再等于点掉的先后。
 *    也不在这里翻牌 —— 翻牌是 `afterPrologueCard` 的事。
 */
export function advancePrologue(ledger: Ledger): { ledger: Ledger; log: string[] } {
  const log: string[] = [];
  const seqs = ledger.events.live.map((e) => prologueSeqOf(e.id)).filter((n): n is number => n !== null);
  if (seqs.length === 0) return { ledger, log }; // 序幕还没开始 ⇒ 不在这里替它开始
  // ⚠️ **克隆放在判后**：本函数会被每一次档 A 点选调用（正文的档 A 也算），
  //    而这些调用**大多该是零开销的空转** ⇒ 先判、后克隆，不白克隆一个账本。
  const missing = PROLOGUE_CARDS.filter((c) => c.opening !== true && !seqs.includes(c.seq));
  const openingLaid = ledger.events.live.some((e) => e.id === PROLOGUE_OPENING_ID);
  const restPending = ledger.events.live.some((e) => {
    const s = prologueSeqOf(e.id);
    return e.status === '待处理' && s !== null && s !== PROLOGUE_MAX_SEQ;
  });
  if (missing.length === 0 && (openingLaid || restPending)) return { ledger, log }; // 没事可做
  const l: Ledger = structuredClone(ledger);
  for (const c of missing) l.events.live.push(cardToEvent(l, c, log));
  if (!openingLaid && !restPending && missing.length === 0) {
    const oc = prologueCardOf(PROLOGUE_MAX_SEQ);
    if (oc) {
      l.events.live.push(cardToEvent(l, oc, log));
      log.push('序幕的其余事件都处理完了 ⇒「原初欲望的觉醒」出现了');
    }
  }
  return { ledger: l, log };
}

/**
 * **「直接正式开始游戏」**（UI 那颗按钮的后端，2026-10-08 用户裁定）：
 * 掐掉**还没读**的序幕事件（非末条 · 待处理），然后铺末条「原初欲望的觉醒」。
 *
 * ⚠️ 为什么要**掐掉**而不是留着：留着的全是 day 0 的档 A「待处理」⇒ 闸门 ④ 会把
 *    正文里的排布与「进下一天」永远拦下去；它们又不再有入口收尾（序幕界面已经翻篇）。
 *    已结算的那些**保留**（它们是这一局的开局记忆，`prologueFinished` 也靠它们成立）。
 * ⚠️ 幂等：不是序幕（一条序幕 id 都没有）⇒ 原样返回；末条已在 ⇒ 只掐不铺。
 */
export function skipToOpening(ledger: Ledger): { ledger: Ledger; log: string[] } {
  const log: string[] = [];
  const seqs = ledger.events.live.map((e) => prologueSeqOf(e.id)).filter((n): n is number => n !== null);
  if (seqs.length === 0) return { ledger, log }; // 不是序幕 ⇒ 一个字不动
  const l: Ledger = structuredClone(ledger);
  const before = l.events.live.length;
  l.events.live = l.events.live.filter((e) => {
    const s = prologueSeqOf(e.id);
    return s === null || s === PROLOGUE_MAX_SEQ || e.status !== '待处理';
  });
  const skipped = before - l.events.live.length;
  if (skipped > 0) log.push(`「直接正式开始游戏」：跳过 ${skipped} 条还没读的序幕事件`);
  if (!l.events.live.some((e) => e.id === PROLOGUE_OPENING_ID)) {
    const oc = prologueCardOf(PROLOGUE_MAX_SEQ);
    if (oc) {
      l.events.live.push(cardToEvent(l, oc, log));
      log.push('「原初欲望的觉醒」出现了 —— 点下它，选定你的欲望，这 28 天正式开始');
    }
  }
  return { ledger: l, log };
}

/** 序幕里还剩几条**待处理**的档 A（= 玩家还要读几条） */
export function prologuePending(l: Ledger): number {
  return l.events.live.filter((e) => isPrologueEventId(e.id) && e.status === '待处理').length;
}

/** 序幕走完了没（10 条都不再是「待处理」） */
export function prologueFinished(l: Ledger): boolean {
  return l.events.live.some((e) => isPrologueEventId(e.id)) && prologuePending(l) === 0;
}

/** 这条就是末条「原初欲望的觉醒」吗（点下它 ⇒ 翻牌 ⇒ 进第 1 天） */
export function isOpeningCardId(eventId: string): boolean {
  return eventId === PROLOGUE_OPENING_ID;
}

/** 玩家是不是还停在序幕（`day 0`）—— UI 用它决定"能不能进下一天" */
export function inPrologue(l: Ledger): boolean {
  return l.clock.day <= 0;
}

/**
 * 此刻**该呈现的那一条**序幕（＝唯一还「待处理」的那条）—— UI 拿它渲染弹窗标题。
 * 没有 ⇒ `null`（序幕走完，或还没开始）。
 */
export function currentPrologueCard(l: Ledger): PrologueCardSpec | null {
  const pending = l.events.live.find((e) => isPrologueEventId(e.id) && e.status === '待处理');
  if (!pending) return null;
  const seq = prologueSeqOf(pending.id);
  return seq === null ? null : prologueCardOf(seq);
}

/**
 * **序幕专用随机流** —— 与正文 28 天的那条 `rng` **分开**。
 *
 * ⚠️ **2026-10-05：开局已经不抽牌了**（用户裁定：欲望与塔罗无关）⇒ 这条流**当前没有消费者**。
 *    它**保留**是因为 `SessionSnapshot.pRngState` 还在存它的游标（存档形状），
 *    删掉要连带改快照与四份存量测试的期望值 —— 那是**另一件事**，不夹在这里做。
 *    ⚠️ 若日后序幕又要用随机（新的幕间内容），理由仍照旧：**别伸进正文那条流**。
 *    原文的教训留着：那是一次真事故（2026-09-18 让 seed 7 的「隐藏事件被 `trigger` 唤醒」
 *    由 ✓ 变 ✗）—— 多摇 4 个 `int` 就能让精心调过的 28 天基线整体挪位。
 *    （`fixtures/fake.ts·roll()` 为"凭证判定"立过同样的先例：**与轨迹无关的随机不要伸进那条流**。）
 */
export function prologueRng(seed: number, resume?: number): Rng {
  // 乘一个与正文流无关的质数 ＋ 偏移，避开"两条流前几个数相关"这种尴尬
  // ⚠️ `resume`（游标）只为存档：见 `rules/rng.ts·Rng.state`。不传就是原行为。
  return makeRng(seed * 7919 + 104729, resume);
}

/**
 * 开局落账 —— **纯规则层 · 零 LLM**（2026-10-06 用户裁定后彻底简化）。
 *
 * ⚠️ **它现在就是 `applyPlayerChoice` 的别名**：欲望 ＋ 六维都改成玩家自己挑之后，
 *    曾经唯一剩下的那件"写人物描述"也**硬编码进 `Person.desc`** 了
 *    ⇒ 序幕**没有任何模型输出需要校验** ⇒ **零网络调用**。
 * ⚠️ **`brain` 参数保留但不使用** —— 调用侧（`ui/session.ts` / `turn/simulate.ts`）
 *    仍按原样传它，**不必改**；⚠️ 但它是**遗留签名**，日后清理时两处一起改。
 * ⚠️ **不再抛"两次都被拒"**：唯一的 `OpeningRejected` 来自**玩家输入**
 *    （下标越界 / 优势属性非法）⇒ 直接穿透，调用侧照样靠这个类分辨。
 *
 * ⚠️ **失败两档与重试通道整个退休**（2026-10-06）：
 *    旧实现是「抽牌 → `brain.opening` → `applyOpening`，被拒就用**同一副牌**再要一次，
 *    仍被拒才抛」（`OPENING_TRIES = 2`）。那段机制连同它那两段长注释一起删掉了 ——
 *    **没有模型输出，就没有需要重试的校验失败**。
 *    留着的教训：**重试通道是给"模型这次不行"准备的**；当模型不再参与，那条通道就是死代码。
 */
export function driveOpening(
  l: Ledger,
  _brain: Brain,
  choice: OpeningChoice,
): { ledger: Ledger; log: string[] } {
  return applyPlayerChoice(l, choice);
}

/**
 * 点完一条序幕事件之后的唯一编排入口 —— 末条 ⇒ 开局；其余 ⇒ `advancePrologue`
 * （2026-10-08 起＝看一眼要不要铺末条 / 迁移补齐，不再"铺下一条"）。
 *
 * ⚠️ 为什么要有它：`Session` 与 `simulate` 两处都要做"点完一条之后的下一件事"，
 *    两处各写一遍 `if (末条) 开局 else 铺下一条` ⇒ 迟早漂移（本项目反复踩过的坑：
 *    同一个口径两处实现）。⇒ 规则侧只留**这一个**判断。
 * ⚠️ 传进来的 `eventId` **不是**序幕那 10 条 ⇒ 原样返回（正文的档 A 走到这里什么都不该发生）。
 * ⚠️ **它不判结局、不推进时钟**：调用侧照旧自己过 `terminateIfOver` / `afterSettle`。
 *
 * ⚠️ **2026-10-05**：`choice` 是**玩家在 UI 上挑好的**（欲望 ＋ 优势属性），
 *    原样透传给 `driveOpening` —— **无头驱动**（`turn/simulate.ts`）传一条**确定的默认值**，
 *    否则"同一 seed 同一局"这条可重放性就破了（见 `simulate.ts` 里的 `DEFAULT_CHOICE`）。
 * ⚠️ **2026-10-06**：`driveOpening` 已是同步的 ⇒ 本函数**保留 `async`**（不逼调用侧改）
 *    但内部不再有 `await`。
 */
export async function afterPrologueCard(
  l: Ledger,
  eventId: string,
  brain: Brain,
  choice: OpeningChoice,
): Promise<{ ledger: Ledger; log: string[]; opening: boolean }> {
  if (!isPrologueEventId(eventId)) return { ledger: l, log: [], opening: false };
  if (isOpeningCardId(eventId)) {
    const r = driveOpening(l, brain, choice);
    return {
      ledger: r.ledger,
      log: ['序幕末条「原初欲望的觉醒」—— 选定欲望 ＋ 分配六维（**零 LLM**）', ...r.log],
      opening: true,
    };
  }
  const r = advancePrologue(l);
  return { ledger: r.ledger, log: r.log, opening: false };
}

// ⚠️ 顺带把"这条 id 是不是序幕的"再导出一次：调用侧（`turn/simulate.ts`、`ui/session.ts`）
//    只该认 `turn/prologue.ts` 这一个入口，不用各自去 `rules/` 里翻表。
export { PLAYER_ID, EMPTY_DELTA, isPrologueEventId };
