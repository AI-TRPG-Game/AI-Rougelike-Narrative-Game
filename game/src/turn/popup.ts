// 档 A（强制弹窗）的**点选入口**
//
// 一条档 A 落进 `events.live`（`status = 待处理`）之后，玩家**当天必须清掉它**：
// 闸门 ④ 会拦住其它排布**与「进下一天」** ⇒ 它是"强制"的，不是"可选"的。
//
// ⚠️ **为什么单独成文件**：`turn/simulate.ts` 里的 `clickPopup` 是**笨策略的驱动动作**，
//    它恒点 `options[0]`（那是覆盖率的需要，不是玩法）。玩家要的是**自己挑**。
//    两处各写一遍 ⇒ 金币口径、`trigger` 唤醒、欲向落账迟早各漂各的
//    （`revealDue` 里"金币冲回"那处实测踩过的坑，就是同一种漂移）。
//    ⇒ 规则侧只留**这一个**实现，驱动的 `clickPopup` 改为调它（`optionIndex = 0`）。
//
// ⚠️ **本动作不经闸门**（刻意，不是漏了）：9 条闸门回答的是"能不能**排布**这一手"，
//    而档 A 点选是"**清掉一条挡路的弹窗**"—— 它恰恰是闸门 ④ **解除的唯一方式**。
//    拿闸门去拦它，"时间用尽 ＋ 档 A 未清"就变成死锁：既不让你点、又不让你过日。
//    ⇒ 只留三条"这个动作本身成不成立"的前置：
//       事件在池里 / 它是**待处理**的档 A / 选项下标有效。
//
// ⚠️ **同步 · 零 LLM · 零掷骰 · 零行动点**：档 A 的结算**全都预写**在选项里
//    （`text` / `result_text` / `delta` / `欲向` / `summary` / `trigger`，见《契约.md》§6.4）
//    ⇒ 它是整局里唯一"玩家点击即落账"的一处，也是唯一不掷骰的结算。
import { applyDelta, commitBatch } from '../ledger/apply.ts';
import { emptyBatch } from '../ledger/batch.ts';
import type { EventOption, Ledger } from '../ledger/types.ts';
import { desireDelta } from '../rules/desire.ts';

export interface PopupResult {
  ledger: Ledger;
  /** 被点中的选项；`null` = 被拒（见 `rejected`）或这条弹窗没有选项（见 `log`） */
  option: EventOption | null;
  /**
   * 选中后**立即**给玩家看的那句结算文案（`result_text`）。
   * ⚠️ 档 A 不调 LLM ⇒ 它就是"结果"的**唯一载体**。
   *    UI 在点选**之前**不该拿到它 —— 那是剧透（`ui/session.ts·view()` 有对应的断言）。
   */
  resultText: string;
  /** 这个选项**当场唤醒**的隐藏事件 id（血统单向：子事件绝不回填父 id） */
  triggered: string[];
  /** 非 `null` = 被拒：**账本一个字节没动** */
  rejected: string | null;
  log: string[];
}

/**
 * 点选一条档 A 的第 `optionIndex` 个选项。**未点选的选项不生效**。
 *
 * ⚠️ **无选项的兜底**：档 A 若没有任何选项，它就**永远清不掉** ⇒ 闸门 ④ 会把这一局钉死。
 *    宁可当场收口（记 `已结算`、什么都不落账），也不给一个死锁 —— 这是结构性问题，
 *    所以日志里必须刺眼地写出来（`⚠️`），不能静默抹平。
 */
export function choosePopup(ledger: Ledger, eventId: string, optionIndex = 0): PopupResult {
  const refuse = (reason: string): PopupResult => ({
    ledger,
    option: null,
    resultText: '',
    triggered: [],
    rejected: reason,
    log: [`档 A 点选被拒：${reason}`],
  });

  const ev = ledger.events.live.find((e) => e.id === eventId);
  if (!ev) return refuse(`事件 ${eventId} 不在事件池里`);
  if (ev.tier !== 'A') return refuse(`「${ev.title}」是档 ${ev.tier}（不是弹窗）⇒ 走派遣 / 穿越`);
  if (ev.status !== '待处理') return refuse(`「${ev.title}」当前是 ${ev.status} ⇒ 已经清掉了`);

  const l: Ledger = structuredClone(ledger);
  const e2 = l.events.live.find((e) => e.id === eventId)!;
  const log: string[] = [];

  if (e2.options.length === 0) {
    e2.status = '已结算';
    log.push(`⚠️「${e2.title}」没有任何选项（结构性错误）⇒ 直接收口，不落账（否则闸门 ④ 会把这一局钉死）`);
    return { ledger: l, option: null, resultText: '', triggered: [], rejected: null, log };
  }
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= e2.options.length) {
    return refuse(`选项下标 ${optionIndex} 越界（这条弹窗有 ${e2.options.length} 个选项）`);
  }

  const opt = e2.options[optionIndex];
  const batch = emptyBatch(l);
  // ⚠️ **角色词不映射**：档 A 的 `delta` 是**生成侧预写**的，它指名道姓写「玩家」
  //    （`applyDelta` 的 `roleTarget` 对「玩家」恒解析到 `PLAYER_ID`）。
  //    这里没有"主事者 / 参与者"可言 —— 与 `revealDue` / `settleExpired` 那两处传 `roleMap` 是两回事。
  const out = applyDelta(l, opt.delta, {}, batch);
  batch.desire += desireDelta(opt.欲向);
  if (opt.summary) {
    l.summaries.recent.push({ day: l.clock.day, text: opt.summary });
    // ⚠️ 与 `revealDue` 同一条口径：生成侧「已处理」清单要标题＋概括配对（第十五批）。
    //    ⚠️ 写在 `commitBatch` **之前**的 `l` 上没用 —— 那个对象会被换掉；见下面状态收口的同一坑。
  }

  const { ledger: after, report } = commitBatch(l, batch);
  log.push(`点选「${e2.title}」→「${opt.text}」`);
  log.push(...report);
  for (const e of out.errors) log.push(`⚠️ ${e}`);

  // 状态收口写在 `commitBatch` **之后**：那是换对象的，之前拿到的 `e2` 已经不在新账本里。
  const settled = after.events.live.find((e) => e.id === eventId)!;
  settled.status = '已结算';
  // ⚠️ 「已处理」清单的标题＋概括配对（第十五批）—— 与状态收口同一家：也要在**之后**写。
  if (opt.summary) settled.settled_summary = opt.summary;

  const triggered: string[] = [];
  if (opt.trigger) {
    const i = after.events.hidden.findIndex((e) => e.id === opt.trigger);
    if (i >= 0) {
      const [child] = after.events.hidden.splice(i, 1);
      after.events.live.push(child);
      triggered.push(child.id);
      log.push(`这个选择当场引出「${child.title}」`);
    } else {
      log.push(`⚠️ 选项指向的隐藏事件 ${opt.trigger} 不在 hidden 里（结构性错误）⇒ 不唤醒`);
    }
  }

  return { ledger: after, option: opt, resultText: opt.result_text, triggered, rejected: null, log };
}
