// 可注入随机 —— 规则层**一律不接受裸随机数**，只接受 Rng。
// 两条好处：① 28 天冒烟可重放；② 边界测试可以点名要「天然 20」，而不是靠概率撞。
import { ATTR_KEYS, type AttrKey } from '../contract/types.ts';

export interface Rng {
  /** 1..20 */
  d20(): number;
  /** 1..4 */
  d4(): number;
  /** 1..n */
  int(n: number): number;
  /** 已消耗的骰子（测试可断言） */
  readonly log: number[];
  /**
   * mulberry32 的**内部游标**（那个 `a`）—— 存档的**唯一依据**。
   *
   * ⚠️ 为什么不能省：`log` 只记"吐出过哪些点数"，**推不回游标**；只存 seed 也够不着 ——
   *    那只能从头重放（而重放要重放整局动作，真模型下等于重烧一遍钱）。
   *    ⇒ `makeRng(seed, rng.state)` 才能在**同一个位置**接着往下跑。
   * ⚠️ 它是**实现细节**，语义上只保证"取出来再塞回去，序列能接上"，别拿它当随机性来源。
   */
  readonly state: number;
}

/**
 * mulberry32 —— 小而快、确定性好。
 *
 * ⚠️ 2026-09-20 改写成**显式持有游标**的写法（原先把 `let a` 关在闭包里、外面拿不到），
 *    好让 `Rng.state` 能把它交出去存档。
 *    **随机序列一字未变**：原来的第一句是 `a = seed >>> 0`，这里等价于 `a = (resume ?? seed) >>> 0`。
 *    ⇒ 基线（三种子收口 61 / 64 / 65）必须逐字不变 —— 这是这次改写的验收判据。
 *
 * @param resume 从 `Rng.state` 取回来的游标；不给就从头开始（原行为）
 */
export function makeRng(seed: number, resume?: number): Rng {
  let a = (resume ?? seed) >>> 0;
  const log: number[] = [];
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => {
    const v = Math.floor(next() * n) + 1;
    log.push(v);
    return v;
  };
  return {
    d20: () => int(20),
    d4: () => int(4),
    int,
    log,
    // ⚠️ 用 getter 而不是快照值：游标每掷一次都在动，必须**取的时候**才读
    get state() {
      return a;
    },
  };
}

/** 「剧本骰」：按队列顺序吐值；队列耗尽即抛错（防"没测到"被当成"测到了"） */
export function scriptedRng(script: number[]): Rng {
  const queue = [...script];
  const log: number[] = [];
  const next = (what: string) => {
    if (queue.length === 0) {
      throw new Error(`剧本骰耗尽：还需要一个 ${what}，但 script 已用完（已消耗 ${log.length} 个：${log.join(',')}）`);
    }
    const v = queue.shift() as number;
    log.push(v);
    return v;
  };
  return {
    d20: () => {
      const v = next('d20');
      if (v < 1 || v > 20) throw new Error(`剧本骰给了非法的 d20 = ${v}`);
      return v;
    },
    d4: () => {
      const v = next('d4');
      if (v < 1 || v > 4) throw new Error(`剧本骰给了非法的 d4 = ${v}`);
      return v;
    },
    int: (n: number) => {
      const v = next('int');
      if (v < 1 || v > n) throw new Error(`剧本骰给了非法的 int(${n}) = ${v}`);
      return v;
    },
    log,
  };
}

/** 随机挑一个属性（仅测试/假数据用） */
export function randomAttr(rng: Rng): AttrKey {
  return ATTR_KEYS[rng.int(ATTR_KEYS.length) - 1];
}
