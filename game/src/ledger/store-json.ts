// 原子 JSON 快照 —— ⚠️ 这是 ledger/ 下**唯一**允许 import Node 内置模块的文件（同构约束）。
//
// 写 `ledger.json.tmp` → fsync → `rename` 到 `ledger.json`。
// ⇒ 崩溃只可能留下 `.tmp`，**永远不会留下半个账本**。
import fs from 'node:fs';
import path from 'node:path';
import type { Ledger } from './types.ts';
import type { LedgerStore } from './store.ts';

export class JsonFileStore implements LedgerStore {
  // ⚠️ 不用 TS「参数属性」简写（`constructor(private file: string)`）：Node 22 的
  // type stripping 是 strip-only 模式，参数属性属于**需改写代码**的语法，会直接报
  // `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。这里手写字段声明。
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  load(): Ledger | null {
    if (!fs.existsSync(this.file)) return null;
    return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Ledger;
  }

  save(ledger: Ledger): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(ledger, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  /** 是否残留了半写的临时文件（崩溃检测） */
  hasLeftoverTemp(): boolean {
    return fs.existsSync(this.file + '.tmp');
  }
}
