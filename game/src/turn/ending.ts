// 终局的**副作用入口** —— 判定本身的纯函数在 `rules/ending.ts`，这里只负责"写进账本"。
//
// 分工与 `rules/clock.ts` ↔ `turn/time.ts` 同族：**规则层只算，编排层才动账本**。
// ⚠️ 账本是**单写者**：终局一经写定就不再变（`l.ending !== null` 即"这一局已经结束"）。
//
// ⚠️ 本文件有**两件事、两个不同的时点**，别把它们混成一件事：
//   ① `enterEnding` / `terminateIfOver` / `closeGame` —— **同步**：判定 ＋ 落账。
//      逐次检查挂在**每一次结算之后**，所以判定必须**当场**定，不能为了等一次网络往返
//      就把"这一局结束了"这件事推迟（那会让调用方继续玩一场已经死了的局）。
//   ② `writeEnding` —— **异步**：成功结局那一支才调 `ending` 侧链写话术（P4-C 第四条侧链）。
//      它是一次**回望式创作**，定完再补；补不上也不影响"这一局的结果"。
//      ⇒ ①的签名一个字节都不用改（simulate / session / 既有 `ending.test.ts` 少动）。
import { emptyPlacements, type Ledger, type Placements } from '../ledger/types.ts';
import {
  ENDING_TEXT_MAX,
  ENDING_TEXT_MIN,
  finalEndingOf,
  instantEndingOf,
  type EndingResult,
} from '../rules/ending.ts';
import type { Brain, RawEndingOutput } from './brain.ts';

/**
 * 把判定结果写进账本（**原子**：整份 `ending` 一次写定）。
 *
 * ⚠️ `placements` 默认三格全空 —— 中途暴毙（总表 1~4）**没有放格子这一步**，
 *    它不该在账本里留下一组"填过的格子"。
 */
export function enterEnding(l: Ledger, e: EndingResult, placements?: Placements): Ledger {
  const out = structuredClone(l);
  out.ending = { ...e, placements: placements ?? emptyPlacements() };
  return out;
}

/**
 * **逐次检查** —— 「每一次结算之后」调一次。
 *
 * 返回值语义刻意做成"要么给新账本、要么什么都不给"：
 * - 命中 ⇒ **新账本**（`ending` 已写定），调用方必须**立刻停手**（不再拨时间、不再进下一天）；
 * - 未命中 / 已经结束过 ⇒ `null`（调用方照常继续）。
 *
 * ⚠️ **先算后克隆**：本函数会被挂到每一次结算之后，而命中是极少数
 *    ⇒ 不能为了"可能命中"每次都 `structuredClone` 一整份账本。
 */
export function terminateIfOver(l: Ledger): Ledger | null {
  if (l.ending) return null; // 已经结束过：不重复判、不覆盖
  const e = instantEndingOf(l);
  return e ? enterEnding(l, e) : null;
}

/**
 * **终局**：第 28 天放完格子之后判（总表 5~7 ＋ 成功）。
 * 与 `terminateIfOver` 的区别：这一条**必须**带放格子结果（成功与否都看它）。
 *
 * ⚠️ 仍然先按总表顺序兜一次 1~4："**1~4 优先于 5~7**"是总表的硬规则，
 *    不该依赖"调用方保证前面查过"。
 */
export function closeGame(l: Ledger, placements: Placements): Ledger {
  const e = instantEndingOf(l);
  if (e) return enterEnding(l, e);
  return enterEnding(l, finalEndingOf(l, placements), placements);
}

// ── 成功结局的话术（`ending` 侧链 · 全局至多 1 次）───────────────────
//
// ⚠️ 与 `opening` **对称** —— 一个是第一次调用，一个是最后一次调用。
//    但它与另外四条侧链有一处决定性的不同：**它不改任何"还会被继续消费"的东西** ——
//    它写的是这一局的收束，写完就没有"下游"了。

/** 按**码点**计长（中文一字算一个）—— 与 `rules/archive.ts·charCount` / `turn/chapter-shift.ts·len` 同一口径 */
function len(s: string): number {
  return [...s].length;
}

/** 只收非空字符串，顺带 trim */
function asText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 话术被拒（校验不过）—— 与"网络 / 解析失败"分开，便于调用侧分辨该不该重试 */
export class EndingRejected extends Error {}

/**
 * 校验 ＋ 落账。`raw` 是 `Brain.ending()` 的**未校验**输出（任意形状）。
 *
 * ⚠️ **服务端对模型输出完全不校验**（Phase 0 §三：`strict` 只管 schema **定义**的合法性）
 *    ⇒「判词 100~200 字」**没有任何一层替我们兜**，只能在这里兜。
 * ⚠️ **只写话术，不动判定**：`name` / `kind` / `flavor` / `row` / `day` / `reason` /
 *    `placements` / **`title`** 全部来自规则层，模型一个字都改不了 ——
 *    它只能给"判词"这一个自由文本字段。
 *    （这正是"LLM proposes narrative skin; rule layer adjudicates outcomes"的落点。）
 *
 * ⚠️⚠️ **2026-10-06 用户裁定：模型只输出一段纯文本。**
 *   · `结局标题` **字段已从 schema 删掉** ⇒ 这里**不再读标题、不再校验标题**。
 *     标题在 `rules/ending.ts·finalEndingOf` 判出成功那一刻就**写定**了
 *     （两档：得偿所愿 / 差一步美满）。
 *   · 话术长度从 150~300 改成 **100~200**（`ENDING_TEXT_MIN/MAX`）。
 *   · 字段名从 `结局话术` 改成 **`结局判词`**。
 *   ⚠️ **旧回放快照里那个键不再读** —— `replay.ts` 走的是"逐字比对载荷"，
 *     真要重跑一份旧 run 得先 `--rebaseline`（那本来就是改过夹具后的例行动作）。
 */
export function applyEnding(l: Ledger, raw: unknown): Ledger {
  const e = l.ending;
  // ⚠️ 下面三条都是**调用侧的接线错误**，不是"模型输出不合规" ⇒ 当场抛，不要静默落一半。
  if (!e) throw new EndingRejected(`第 ${l.clock.day} 天还没有终局判定，不该写话术`);
  if (e.kind !== '成功') {
    throw new EndingRejected(`这一局是「${e.name}」失败结局 —— 系统已播预写话术，不该再调 ending`);
  }
  if (e.text !== null) {
    throw new EndingRejected('这一局的话术已经写过了（`ending` 全局至多 1 次）');
  }

  const o = (raw ?? {}) as Record<string, unknown>;
  const text = asText(o['结局判词']);

  if (text === '') throw new EndingRejected(`结局判词为空（必须是 ${ENDING_TEXT_MIN}~${ENDING_TEXT_MAX} 字）`);
  if (len(text) < ENDING_TEXT_MIN) {
    throw new EndingRejected(`结局判词 ${len(text)} 字 < ${ENDING_TEXT_MIN} 字`);
  }
  if (len(text) > ENDING_TEXT_MAX) {
    throw new EndingRejected(`结局判词 ${len(text)} 字 > ${ENDING_TEXT_MAX} 字`);
  }

  const next = structuredClone(l);
  // ⚠️ `title` **原样保留**（规则层在 `finalEndingOf` 里写定的那两档）——
  //    模型碰不到它，这里也**不许**用模型给的任何东西去覆盖它。
  next.ending = { ...next.ending!, text };
  return next;
}

export interface EndingWriteResult {
  ledger: Ledger;
  log: string[];
  /** 这一次**真的调了** `ending`（只有"成功结局且话术还没写过"才为真） */
  called: boolean;
  /** 话术真的落了账 */
  wrote: boolean;
}

/**
 * **成功结局的话术** —— 第 28 天放完格子、判出成功之后调一次（全局至多 1 次）。
 *
 * ⚠️ **三种情形一律原样返回、不抛**（`called = false`）：
 *    ① 还没有终局判定；② **失败结局**（七条预写话术，**0 调用**）；③ 话术已经写过了。
 *    —— 「全局至多 1 次」不靠调用方自觉，靠第 ③ 条这个**账本上的事实**：
 *    话术非空即"这一次已经发生过了"，不需要第二个标记位（与 `rewrite_desire`
 *    那条"触发日 = 次日 ⇒ 天然一生一次，不需要第二标记"同一个思路）。
 * ⚠️ **模型被拒 / 网络错一律吞掉、只留一条 ⚠️ 日志**（与 `turn/t0.ts` 那三条侧链同族）：
 *    它已经是这一局的**最后一步** —— 在这里抛会把"已经定好的结局"连带弄没
 *    （`closeGame` 的产物已经在账本里了，`writeEnding` 只是给它补一段文字）。
 *    ⇒ 「话术缺失」的可见性由**覆盖率断言**承担（`turn/simulate.ts` 的「成功结局话术被走到」），
 *      不靠"看起来没人报错"。
 * ⚠️ **不改 `closeGame` 的签名**：判定保持同步，只有话术这一趟是异步的。
 */
export async function writeEnding(l: Ledger, brain: Brain): Promise<EndingWriteResult> {
  const e = l.ending;
  if (!e || e.kind !== '成功' || e.text !== null) {
    return { ledger: l, log: [], called: false, wrote: false };
  }

  let raw: RawEndingOutput;
  try {
    raw = await brain.ending(l);
  } catch (err) {
    return {
      ledger: l,
      log: [`⚠️ ending 调用失败，这一局的话术缺失：${err instanceof Error ? err.message : String(err)}`],
      called: true,
      wrote: false,
    };
  }

  try {
    const next = applyEnding(l, raw);
    const done = next.ending!;
    return {
      ledger: next,
      log: [
        `★ 结局判词由 ending 侧链写就（标题「${done.title}」是规则层给的两档 · ${len(done.text!)} 字 · 风味 ${done.flavor}）`,
      ],
      called: true,
      wrote: true,
    };
  } catch (err) {
    return {
      ledger: l,
      log: [`⚠️ ending 输出被拒，这一局的话术保持缺失：${err instanceof Error ? err.message : String(err)}`],
      called: true,
      wrote: false,
    };
  }
}
