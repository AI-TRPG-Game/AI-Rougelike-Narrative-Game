// **玩家自建事件**的编排层 —— 「我想做点什么」一句话 ⇒ 账本里多一条待办。
//
// 《契约.md》§三「创建事件」＋ §6.4（时间线上的 T2-d：`compose_day` 单条版 · **1 次**调用）。
//
// ⚠️ 它**不是第六条侧链**。侧链是"系统在某个时点自动叫一次"（T0 / 章首 / 终局…），
//    而这条是**玩家主动**点的一次 —— 与 `turn/restore.ts` 的医馆 / 大神殿同族：
//    一个动作 = 一次调用 = 一次落账，不占时点、不进 T0 的编排序。
//
// ⚠️ **豁免全部额度检测**：
//    不占自由事件条数（`N ≤ 5`）、不进 `L` 预算、不吃盈余 —— 它是**玩家主动性的唯一出口**。
//    这条豁免的落点在**两处**，都要在：
//      ① 落地层 `landCompose(l, raw, { mode: 'create' })` —— 不进 `FREE_EVENT_CAP` 那个循环；
//      ② 本文件**不碰** `dispatchBlock` / `calcL` 里的任何一个数（`renderCreateUser` 已把
//         【本日调度】整块换成【玩家的处理方式】，`prompt/blocks.ts` 那边也不需要改）。
//
// ⚠️ **唯一的约束是它自己照常按档位消耗行动力** ⇒ "行动力耗尽的闸门照样拦"落在
//    **调用侧**（`ui/session.ts` 走 `evalGates({action:'handle'})` 拦下）。本函数
//    **不做闸门检查** —— 与 `handleEvent` / `restore` 同一条分工：闸门在入口，规则在这里。
//
// ⚠️ 它**不消耗玩家当下的时间**：产出的是一条 `待处理` 的事件，真正花时间的是
//    **将来处理它**那一步（派遣 / 亲自 ⇒ `handleEvent` 扣容量与时钟）。
//    "自建"与"处理"是两件事 —— 别在这里扣 `clock.usedToday`（那会变成"提一句就花掉 2 点"）。
import type { GameEvent, Ledger } from '../ledger/types.ts';
import type { Brain } from './brain.ts';
import { landCompose } from './land-compose.ts';

export interface CreateResult {
  /** 换过的新账本（**不是**传入那个） */
  ledger: Ledger;
  log: string[];
  /** 这次自建真的落进事件池的那条（模型没产出 / 被落地层丢弃 ⇒ `[]`） */
  created: GameEvent[];
  /** 落地层的硬问题 —— 自建路径上正常恒为空（硬种子收口在 T0，见 `landCompose` ⑦） */
  problems: string[];
}

/**
 * 玩家自建一件事 —— **一次调用 ＋ 一次落地**，不推进时间、不掷骰、不落 `pending`。
 *
 * ⚠️ **异步**：`brain.createEvent` 是一次 LLM 调用（Phase 6 联网后是真的）。
 * ⚠️ **就地在 clone 上改**（与 `turn/t0.ts·enterDay` 同风格）：调用方拿到的是一个**新账本**。
 *    抛错时**不返回半个账本** —— 让调用侧原样把异常交出去。
 *    （与 `opening` 那条"失败即抛、不静默降级"同一条纪律：自建的失败是**肉眼可见**的
 *     ——玩家敲了一句话，什么也没发生。偷偷补一条默认事件比这坏得多。）
 * ⚠️ **空原话在这里就挡掉**：`renderCreateUser` 会把原话**逐字**写进 user ③
 *    （`approachBlock` = `【玩家的处理方式】"${approach}"`）⇒ 空串等于给模型一个空题目。
 *    这一条**故意不放在 UI 层** —— 将来无头驱动 / 别的入口也该受同一条约束。
 *    用法：调用侧 `try/catch` 或先自行 trim 判空（`ui/session.ts` 走后者，好给一句人话）。
 */
export async function createEvent(
  ledger: Ledger,
  approach: string,
  brain: Brain,
): Promise<CreateResult> {
  const text = approach.trim();
  if (text === '') throw new Error('自建事件要一句非空的「打算怎么做」');

  const l: Ledger = structuredClone(ledger);
  const log: string[] = [`玩家自建：「${text}」`];

  const raw = await brain.createEvent(l, text);
  // ⚠️ 落地走的是**同一个 `landCompose`**（`mode: 'create'`）—— 输出形状与生成半逐字相同
  //    （`RawComposeOutput`），没有任何理由开第二条路。两处差异（只认 1 条 canvas /
  //    种子只核销不收口）**都写在落地层里**，不在这里补。
  const landed = landCompose(l, raw, { mode: 'create' });
  log.push(...landed.log);
  for (const p of landed.problems) log.push(`⚠️ ${p}`);

  return { ledger: l, log, created: landed.live, problems: landed.problems };
}
