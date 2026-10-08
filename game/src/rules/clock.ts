// 时钟 · 周例钱 · **行动点时间轴**
//
// 本模块是**纯算术**（无副作用、不碰账本字段）：把「第几天 · 当天已消耗几点」当成一个
// 可加减、可比较的**时间点**。真正推进时间、兑现揭晓的副作用在 `turn/time.ts`。
//
// ⚠️ 2026-09-18 时钟模型改造：旧模型的时间精度只到「天」（`duration` + `reveal_day`），
//    新模型的时间精度是**行动点**（`cost` + `started_at`/`reveal_at`）。
//    原因：《规则.md》§一里玩家的 4 点本来就是**时间预算** —— 精度只到天，会让
//    "处理要花多久 ⇒ 就等多久揭晓"这句话在一天之内无法表达。
import type { GameEvent, Ledger, TimePoint } from '../ledger/types.ts';
import { BASE_ACTION_POINTS } from './x.ts';

export const TOTAL_DAYS = 28;
export const DAYS_PER_CHAPTER = 7;
export const PROLOGUE_DAYS = 2; // 序幕不计入 28 天，界面显示「Day 0」

/** 周例钱：第 1 / 8 / 15 / 22 天，每次固定 20 金币（全场共 4 次）
 *  ⚠️ 2026-10-08 用户裁定：开局实测金币太少 ⇒ 由 5 提到 20。 */
export const PAYROLL_DAYS: readonly number[] = [1, 8, 15, 22];
export const PAYROLL_AMOUNT = 20;

/** ⚠️ 第 1 天那次**就是**序幕占位数值里那个「金币 5」——同一笔，不是两笔 */
export function payrollForDay(day: number): number {
  return PAYROLL_DAYS.includes(day) ? PAYROLL_AMOUNT : 0;
}

// ── 时间点算术 ───────────────────────────────────────────────

/**
 * 时间点 → **绝对点数** `day × 4 + used`。
 * `{day:1, used:4}` 与 `{day:2, used:0}` 同为 8 ⇒ 两种写法天然等价，比较前无需归一化。
 */
export function toAbs(t: TimePoint): number {
  return t.day * BASE_ACTION_POINTS + t.used;
}

export function compareTime(a: TimePoint, b: TimePoint): number {
  return toAbs(a) - toAbs(b);
}

/** `now` 是否已经走到（或走过）`target` */
export function reached(now: TimePoint, target: TimePoint): boolean {
  return toAbs(now) >= toAbs(target);
}

/**
 * 时间点 + n 点（n ≥ 0）。
 * ⚠️ **恰好用满当天时保留 `used = 4`**，而不是进位成 `{day+1, used:0}`：两种写法等价，
 *    但前者能表达"就发生在当天末尾"，与 `nextDay` 推进到的时间点、与 `expires_at` 的算法一致。
 */
export function addPoints(t: TimePoint, n: number): TimePoint {
  let day = t.day;
  let used = t.used;
  let left = n;
  while (left > 0) {
    const room = BASE_ACTION_POINTS - used;
    if (left <= room) {
      used += left;
      left = 0;
    } else {
      left -= room;
      day += 1;
      used = 0;
    }
  }
  return { day, used };
}

/** 当前时间点 —— `used` 记账的唯一读法 */
export function nowOf(l: Ledger): TimePoint {
  return { day: l.clock.day, used: l.clock.usedToday };
}

/** 玩家当日**剩余时间**（4 − 已消耗） */
export function remainingToday(l: Ledger): number {
  return Math.max(0, BASE_ACTION_POINTS - l.clock.usedToday);
}

/**
 * **正在处理中的事件**，它们各自"还要多少行动力才揭晓" —— 拨时针的**上限**由它决定。
 *
 * ⚠️⚠️ 2026-10-06 清单第 9.1 条（用户裁定第 24 条：「**『正在处理的事件』指的就是点了 ✔ 的事件**，
 *    因为我们有些事件的结算结果不是即时的，要靠玩家主动拨时针才能结算」）。
 *
 * ⚠️ **判据是 `status === '揭晓待办'`**，那个状态 `turn/handle.ts` 提交那一刻就写好了
 *    （`ev.status = '揭晓待办'` ＋ `ev.reveal_at = addPoints(started_at, ev.cost)`）
 *    ⇒ **本函数不需要新增任何状态**，只是把已有的那个读出来用。
 *
 * ⚠️ **剩下多少** = `reveal_at.used − now.used`（同一天内）。
 *    `reveal_at.day > now.day` 说明它跨天 ⇒ 剩下的不是"今天点几下"能解决 ⇒ **返回 0**，
 *    意思是"今天拨多少都点不掉它"（拨针时它会照常被 `revealDue` 结算，但区间上限为 0 ⇒ 空区间）。
 */
export function pendingCosts(l: Ledger): number[] {
  const now = nowOf(l);
  const out: number[] = [];
  for (const e of l.events.live) {
    if (e.status !== '揭晓待办' || !e.reveal_at) continue;
    // ⚠️⚠️ **"剩 0 点"要跳过，不是当成上限 0**（2026-10-06 实测踩到的）：
    //   序幕那 10 条档 A 的 `cost = 0` ⇒ `addPoints(t, 0)` 停在当天、`reveal_at.used === now.used`
    //   ⇒ 算出来"还剩 0 点"。若把它当上限，`dialRange` 会返回 `[1, 0]`
    //   ⇒ **全天都拨不动时针**（实测把 28 天驱动与 15 条测试全带红）。
    //   ⇒ 判据改成「**还剩至少 1 点**的那些才进表」——
    //   剩下 0 点的意思是"它本来就该揭晓了"，`revealDue` 会在下一次时间推进时收掉它，
    //   **不该反过来限制玩家拨针**。
    const left = e.reveal_at.day > now.day ? 0 : e.reveal_at.used - now.used;
    if (left >= 1) out.push(left);
  }
  return out;
}

/**
 * 拨时针的合法粒度：`[1, min(当天剩余, 正在处理的事件里最小的那笔)]`。
 *
 * ⚠️ **为什么上限要压到"最小的那笔"**（用户原话）：
 * 「若有任何正在处理的事件，设它们消耗的行动力集合为 A，**A 中最小数为 x**，
 *   玩家只能拨动 **[1, min(当前剩余的行动力, x)]** 之间的点数，其余按键变灰」
 *   —— 理由是**别一次拨过头**：拨过揭晓点那一刻结果就揭晓了，玩家会来不及看清。
 *
 * ⚠️ **一个都没有在处理** ⇒ 上限就是"当天剩余"（回到本函数改动前的老行为）。
 * ⚠️ **已用尽（剩余 0）** ⇒ `{min:1, max:0}`（**空区间**：min > max）—— 只能点「进入下一天」。
 * ⚠️ 下限恒为 1：`dial(0)` 也不合法（"拨 0 点"没有意义，只会让调用方漏判空区间）。
 * ⚠️ 拨时针**不跨天**、**无代价**。
 */
export function dialRange(l: Ledger): { min: number; max: number } {
  const left = remainingToday(l);
  const costs = pendingCosts(l);
  // ⚠️ `Math.min(...[])` 恒为 `Infinity` ⇒ 空数组要特判，否则上限会变成 Infinity。
  const x = costs.length ? Math.min(...costs) : left;
  return { min: 1, max: Math.max(0, Math.min(left, x)) };
}

// ── 过期 ─────────────────────────────────────────────────────

/**
 * 事件的**过期时刻** —— `{created_day + deadline, used: 0}`，**永远落在日界上**。
 *
 * ⚠️ 2026-09-18 起 `deadline` 的单位是**天**（不再是行动点）：`deadline = 1` ⇒ 生成当天末尾到期。
 *    与旧口径 `deadline = 4`（点）**是同一个时刻** —— 换算关系恒为 `4 点 = 1 天`。
 *    ⇒ 这正是"过期只在换日发生"的结构保证：过期结算因此**不必**插进逐点推进里。
 * ⚠️ **档 A 永不过期** ⇒ 返回 `null`。
 */
export function expiresAt(ev: GameEvent): TimePoint | null {
  if (ev.tier === 'A') return null;
  return { day: ev.created_day + ev.deadline, used: 0 };
}

/** 时间点已到 `expires_at` ⇒ 该事件过期 */
export function isExpired(ev: GameEvent, now: TimePoint): boolean {
  const at = expiresAt(ev);
  return at !== null && reached(now, at);
}

// ── 章节 ─────────────────────────────────────────────────────

export function chapterOf(day: number): 1 | 2 | 3 | 4 {
  if (day <= 0) return 1;
  const c = Math.ceil(day / DAYS_PER_CHAPTER);
  return Math.min(4, Math.max(1, c)) as 1 | 2 | 3 | 4;
}

/**
 * **模糊时间轴：现在是哪一段** —— 2026-10-06 用户裁定（清单第 25 条 / 原第 9.2 条）。
 *
 * ⚠️ **只有五个值**：早上 / 正午 / 下午 / 傍晚 / 深夜。
 * ⚠️ **纯派生**（从"今天已用了几点"算出来）⇒ **不新增任何存储字段**，
 *    也不改行动力模型 —— 一天仍是 4 点，**0~4 五个读数各对一个时段**，
 *    显示层只是把点数翻译成时段。
 *    （2026-10-07 用户裁定改五段，原话：「把上方的时间轴改成
 *    『现在是：早上/正午/下午/傍晚/深夜』——这样更自然，
 *    **深夜状态不需要出现两次**」—— 旧口径 3~4 点都读"深夜"，同名出现两遍。）
 *
 * @param usedToday 今天已用了几点（`l.clock.usedToday`）
 */
export function daypartOf(usedToday: number): '早上' | '正午' | '下午' | '傍晚' | '深夜' {
  const u = Math.max(0, Math.min(BASE_ACTION_POINTS, Math.trunc(usedToday)));
  // ⚠️ 五段对应 0~4 五个读数：0 早上 / 1 正午 / 2 下午 / 3 傍晚 / 4 深夜
  if (u <= 0) return '早上';
  if (u === 1) return '正午';
  if (u === 2) return '下午';
  if (u === 3) return '傍晚';
  return '深夜';
}

export function phaseOf(day: number): '序幕' | '正文' | '终局' {
  if (day <= 0) return '序幕';
  if (day >= TOTAL_DAYS) return '终局';
  return '正文';
}

/** 章节切换点：第 8 / 15 / 22 天进入新章（T0 触发 `chapter_shift`） */
export function isChapterStart(day: number): boolean {
  return day > 1 && (day - 1) % DAYS_PER_CHAPTER === 0;
}
