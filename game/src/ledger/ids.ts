// id 顺位分配
// **单调递增、永不复用、永不重排**（重排会让概要 / 实体表里的旧引用全部错位）。
import { formatId, type EntityKind } from '../contract/tempids.ts';
import type { Ledger } from './types.ts';

export interface IdWatermark {
  npc: number;
  it: number;
  loc: number;
  event: number;
}

/**
 * 开局发号后的水位：地点 `loc001~009` · 人物 `npc000~010` · 物品 `it001~002`
 * · **事件 `e1~e10`（序幕那 10 条档 A）**。
 *
 * ⚠️ **事件水位为什么是 10 而不是 0**（2026-09-19 序幕落地时改）：序幕的 10 条档 A 用掉
 *    事件号 `e1`~`e10`，而 `isPrologueEventId` 是**纯 id 判据** —— 它分不出"序幕的朝会"
 *    与"正文生成出来的 e1"。水位若从 0 起，正文第一条生成事件就会叫 `e1`，于是被
 *    `prologuePending` / `currentPrologueCard` / `advancePrologue` 当成序幕第 1 条。
 *    实测踩到过：`Session.start({ skipPrologue: true })` 明明开在第 1 天，
 *    `view().prologue` 却凭空报了一个 `{seq:1,total:10,...}`。
 *    ⇒ **号在开局一次性订走**（与《规则.md》§四「顺位分配：开局由系统一次性发号」同一口径），
 *      铺不铺那 10 张牌是另一件事 —— 跳过序幕时号也照样订走，两条路的命名空间从此一致。
 * ⚠️ 于是**正文第一条生成事件恒为 `e11`**，与跑不跑序幕无关。
 */
export function initialWatermark(): IdWatermark {
  return { npc: 10, it: 2, loc: 9, event: 10 };
}

/** 事件 id 用 `e1` / `e2`（不加 `@`，含义与临时编号相同） */
export function formatEventId(n: number): string {
  return 'e' + n;
}

/**
 * 下一条**种子编号** —— `s1` / `s2` …
 *
 * ⚠️ **不能用 `seeds.length + 1`**（三处出种点原本都这么写）：硬种子（checkpoint）
 *    **跨天留存**（没被承接就留到明天，见 `turn/land-compose.ts` ⑦）⇒ 池子会被掏成
 *    `[s2]` 这种"带洞"的样子，而 `length + 1` 会跟留着的那条**撞号**。
 *    `claimSeed` 是按 `code` 查的 ⇒ 一次承接会把两条种子一起核销 ——
 *    **静默**，没有任何断言会红（这正是本仓反复踩的那类坑）。
 * ⚠️ 取"现有最大序号 + 1" ⇒ 只保证**池内不撞号**。池外复用没关系：
 *    模型只看得到**当天这一份**种子列表，`claimed` 也是每天一份。
 */
export function nextSeedCode(seeds: readonly { code: string }[]): string {
  let max = 0;
  for (const s of seeds) {
    const m = /^s(\d+)$/.exec(s.code);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `s${max + 1}`;
}

export class IdAllocator {
  // ⚠️ 同上：strip-only 模式不支持参数属性，手写字段声明。
  wm: IdWatermark;

  constructor(wm: IdWatermark) {
    this.wm = wm;
  }

  get watermark(): IdWatermark {
    return this.wm;
  }

  next(kind: EntityKind): string {
    this.wm[kind] += 1;
    return formatId(kind, this.wm[kind]);
  }

  nextEvent(): string {
    this.wm.event += 1;
    return formatEventId(this.wm.event);
  }
}

export function allocatorFor(wm: IdWatermark): IdAllocator {
  return new IdAllocator(wm);
}

export function cloneWatermark(wm: IdWatermark): IdWatermark {
  return { npc: wm.npc, it: wm.it, loc: wm.loc, event: wm.event };
}

export function watermarkOf(l: Ledger): IdWatermark {
  return cloneWatermark(l.idWatermark);
}
