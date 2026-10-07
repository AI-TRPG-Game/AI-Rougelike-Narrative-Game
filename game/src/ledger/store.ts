// 存储端口，不是设计决定」。
// 本文件保持**同构**（不 import 任何 Node / DOM API）；Node 实现见 `store-json.ts`。
import type { Ledger } from './types.ts';

export interface LedgerStore {
  load(): Ledger | null;
  /** 必须原子：要么整份换掉，要么一个字节都不动 */
  save(ledger: Ledger): void;
}

/** 测试与内存回放用 */
export class MemoryStore implements LedgerStore {
  private current: Ledger | null = null;

  load(): Ledger | null {
    return this.current ? structuredClone(this.current) : null;
  }

  save(ledger: Ledger): void {
    this.current = structuredClone(ledger);
  }
}
