// P6 · 存档**流程** —— 把「一局会话」与「存档库里的一个槽」接起来的那一层。
//
// 它是**唯一**同时认识两边的模块：
//   · `Session.snapshot()/restore()` 只认一份 JSON，不知道什么叫"槽"；
//   · `SaveDb` 只认列与一段**不透明**字符串，不知道什么叫"一局"。
// ⇒"摘要列怎么算"与"快照怎么序列化"这两个口径都只写在这一处，别处不许再算一遍。
//
// ⚠️ 本模块**不碰 HTTP**（路由在 `ui/server.ts`）。这样它能在单测里直接拿一个临时库文件
//    跑通"存 → 列 → 读 → 续跑"，不必起服务端。
// ⚠️ 它 import 了 `save/db.ts`（带顶层 await 与 `node:sqlite`）⇒ 引入它的模块也会是异步求值的。
//    `ui/session.ts` 刻意**不**引它（只 `import type` 拿形状），那条链路才不必加载 sqlite。
import { player } from '../ledger/types.ts';
import { desireBandOf } from '../rules/desire.ts';
import { SaveDb, SLOT_COUNT, type SaveRow, type SaveSummary } from '../save/db.ts';
import type { Brain } from '../turn/brain.ts';
import { Session, type SessionSnapshot } from './session.ts';

export { SLOT_COUNT };
export type { SaveRow, SaveSummary };

/** 一次写入要交给 `SaveDb.write` 的那几列（不含 `slot` 与两个时间戳 —— 那两个归槽位与库管） */
export type SaveColumns = Omit<SaveSummary, 'slot' | 'createdAt' | 'updatedAt'>;

/**
 * 存档卡上的那一行标题。
 *
 * ⚠️⚠️ **2026-10-05：这里原来用"开局那两张牌"**（欲望原卡终生不变，四个槽因此长得不一样，
 *    玩家认得出哪个是哪个）。**牌已从欲望侧彻底删掉**（用户裁定：欲望与塔罗无关）
 *    ⇒ 改用**欲望宣言**做标题：它同样终生不变、同样一眼能认出，而且比两个牌名更像一句话。
 *    开局之前（还没选）退回天数。
 */
export function titleOf(s: Session): string {
  const m = s.ledger.desire.manifesto;
  if (m) return m.length > 14 ? `${m.slice(0, 13)}…` : m;
  const d = s.ledger.clock.day;
  return d <= 0 ? '序幕' : `第 ${d} 天的金庭城`;
}

/**
 * 会话 ⇒ 摘要列。
 *
 * ⚠️ `desireBand`（区间名）与 `desire`（数值）**两个都存**，但**读者不同**：
 *    · 区间名 → 玩家面（存档卡上就印它）；
 *    · 数值   → 只在上帝视角 / 排错时看。
 *    《规则.md》:640「欲念由规则层独算，不给任何 LLM（含区间名）」是**对模型**说的；
 *    对玩家给的是**区间语义**。⇒ 存数值是为了"存得完整"，不是为了"印给玩家"。
 */
export function columnsOf(s: Session): SaveColumns {
  const l = s.ledger;
  return {
    title: titleOf(s),
    day: l.clock.day,
    chapter: l.clock.chapter,
    phase: l.clock.phase,
    gold: l.scalars.gold,
    desire: l.desire.value,
    desireBand: desireBandOf(l.desire.value),
    hp: player(l).hp,
    ended: l.ending !== null,
    endingName: l.ending ? l.ending.name : null,
    steps: s.steps,
  };
}

/**
 * 存档库的**唯一入口**（服务端只跟它打交道）。
 * ⚠️ 它只做"会话 ⇄ 槽"，一行游戏规则都不加 —— 摘要列全部来自 `columnsOf`。
 */
export class SaveStore {
  private db: SaveDb;

  constructor(file?: string) {
    this.db = new SaveDb(file);
  }

  /** 库文件路径（启动日志会印它 —— 玩家该知道自己的一局存在哪儿） */
  get file(): string {
    return this.db.file;
  }

  /** 四个槽（**定长**：空槽是 `null`，位置即槽号） */
  list(): Array<SaveSummary | null> {
    return this.db.list();
  }

  /** 存 / 覆盖一个槽（`created_at` 由库保留第一次建档的值） */
  put(slot: number, s: Session): void {
    this.db.write(slot, columnsOf(s), JSON.stringify(s.snapshot()));
  }

  /**
   * 读一个槽 ⇒ 一局会话（空槽 ⇒ `null`）。
   *
   * ⚠️ 坏 JSON / 快照版本不符 ⇒ **抛**，不静默开新局：
   *    那会让"档坏了"看起来像"这一局从头开始"，而玩家会以为自己的进度没了 ——
   *    其实是**读不动**（与 `save/db.ts` 表版本不符时宁可起不来是同一条纪律）。
   */
  load(slot: number, brain: Brain): Session | null {
    const row = this.db.read(slot);
    if (row === null) return null;
    let snap: SessionSnapshot;
    try {
      snap = JSON.parse(row.state) as SessionSnapshot;
    } catch (e) {
      throw new Error(`槽 ${slot} 的存档不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
    }
    return Session.restore(snap, brain);
  }

  remove(slot: number): void {
    this.db.remove(slot);
  }

  close(): void {
    this.db.close();
  }
}
