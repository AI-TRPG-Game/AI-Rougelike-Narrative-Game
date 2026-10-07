// 存档层 · **真数据库**（`node:sqlite` · Node 22 内置 ⇒ **零依赖、零安装**）。
//
//   game/saves/game.db
//
// 设计取舍（2026-09-20）：
//
// ⚠️ **为什么是"摘要列 ＋ 全量 JSON"而不是把账本拆成几百行表**：
//    存档要的是"**整份**换掉、要么一个字节都不动" —— 拆表就必然引入跨表事务与
//    "读了一半"的中间态。账本在内存里本来就是**一个不可变对象**
//    （`applyDelta` 单写入口、`apply*` 侧链全是"返回新账本"）⇒ 落盘就照它原样序列化。
//    而**摘要列**（天数 / 章节 / 金币 / 欲念 / HP / 是否终局）单独立出来，
//    是为了让"存档选择界面"**只查列、不解析 JSON** —— 那一屏要一次列 4 个槽。
//
// ⚠️ 本文件是**唯一** import `node:sqlite` 的地方。`ui/session.ts`（快照 / 恢复）
//    刻意**不**碰它 —— 这样 `ui.test.ts` 那条链路不必加载 sqlite。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// ⚠️ 这两行的**先后与写法**都是有语义的，别"顺手整理"：
//    ① 过滤器模块必须排在前面（它只装一个 warning 过滤器，零依赖）；
//    ② `node:sqlite` 必须**动态** import。
//    理由：那条 ExperimentalWarning 是在**模块加载阶段**打出去的
//    （`--trace-warnings` 显示 `at node:sqlite:8:1` ⇒ `compileForInternalLoader`），
//    而 ESM 会**先把整张依赖图的模块全部加载完、再开始求值** ⇒ 静态 import
//    不论写在第几行，过滤器都来不及装上。改用 `await import(...)` 才能把它
//    退到**求值阶段**，那时过滤器已经在位。
//    ⚠️ 代价：本模块带顶层 await ⇒ 引入它的模块（只有 `ui/server.ts`）也会是异步求值的。
import './sqlite-warning.ts';

const sqlite = await import('node:sqlite');
type Database = InstanceType<typeof sqlite.DatabaseSync>;

/** 槽位数 —— ⚠️ **唯一**的事实源：建表、列表、UI 都读它。改这里就多/少一个槽。 */
export const SLOT_COUNT = 4;

/**
 * **库表结构**版本 —— 只有"列的形状变了"才 +1。
 *
 * ⚠️ 与**快照 JSON** 的版本是**两件事**，别混：
 *    · 这个是"`saves` 表的列能不能认识"，归本文件管；
 *    · 快照里那个 `v`（`ui/session.ts·SNAPSHOT_VERSION`）是"JSON 的整体形状"，归会话层管。
 *    两个都刻意独立 —— 本文件把 `state` 当**不透明字符串**存取，一个字都不解析，
 *    这样 `save/` 不需要认识 `Ledger`（也就不会把 `node:sqlite` 拖进会话层的测试里）。
 */
export const DB_SCHEMA_VERSION = 1;

// ⚠️ 必须用 `fileURLToPath`，**不能**直接读 `new URL(import.meta.url).pathname`：
//    本项目路径里有中文（`AI原生游戏3`）⇒ `pathname` 是**百分号编码**的
//    （`%E5%8E%9F%E7%94%9F...`），拿它当路径会整个找不到目录。
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 默认库文件：`game/saves/game.db`（与 `src/` 平级，不进版本库） */
export function defaultDbPath(): string {
  return path.join(HERE, '..', '..', 'saves', 'game.db');
}

/** 存档界面要显示的那些字段（**只查列**，不含 JSON） */
export interface SaveSummary {
  slot: number;
  /** 给这一局起的一句话（默认取当前命题，或「第 N 天的金庭城」） */
  title: string;
  day: number;
  chapter: number;
  phase: string;
  gold: number;
  desire: number;
  /** 欲念**区间名**（迷失 / 常态 / 窗口 / 沉溺）—— 与 `desire`（数值）**一起**印在玩家面上（2026-09-22 用户裁定） */
  desireBand: string;
  hp: number;
  ended: boolean;
  endingName: string | null;
  steps: number;
  createdAt: string;
  updatedAt: string;
}

export interface SaveRow extends SaveSummary {
  /** 全量快照 JSON（`SessionSnapshot` 的序列化） */
  state: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS saves (
  slot        INTEGER PRIMARY KEY,
  title       TEXT    NOT NULL,
  day         INTEGER NOT NULL,
  chapter     INTEGER NOT NULL,
  phase       TEXT    NOT NULL,
  gold        INTEGER NOT NULL,
  desire      INTEGER NOT NULL,
  desire_band TEXT    NOT NULL,
  hp          INTEGER NOT NULL,
  ended       INTEGER NOT NULL,
  ending_name TEXT,
  steps       INTEGER NOT NULL,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  state       TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export class SaveDb {
  readonly file: string;
  private db: Database;

  constructor(file: string = defaultDbPath()) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new sqlite.DatabaseSync(file);
    // WAL：写的时候不挡读；`synchronous=NORMAL` 对"单机存档"够用且快得多
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);

    const cur = this.db.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version') as { v?: string } | undefined;
    if (cur === undefined) {
      this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('schema_version', String(DB_SCHEMA_VERSION));
    } else if (Number(cur.v) !== DB_SCHEMA_VERSION) {
      // ⚠️ **宁可起不来，也不硬读** —— 硬读会把"列对不上"变成一堆静默的 undefined
      //    （与 `ui/server.ts --live` 配置失败的处理同一条纪律：不假装成功）。
      throw new Error(
        `存档库的表结构版本不符：库里是 v${cur.v}，代码要 v${DB_SCHEMA_VERSION}。` +
        '（改过 `saves` 表的列 ⇒ 旧库读不了。要么删掉 game/saves/ 重开，要么写一次迁移。）',
      );
    }
  }

  /**
   * 列出**全部槽位**（长度恒为 `SLOT_COUNT`，空槽是 `null`）。
   *
   * ⚠️ 刻意返回定长数组而不是"只返回有档的那几条"：UI 那一屏要画 4 个格子，
   *    "哪个是空的、哪个是第几号"是**槽位**的属性，不该让 UI 自己补。
   */
  list(): Array<SaveSummary | null> {
    const rows = this.db.prepare(
      'SELECT slot, title, day, chapter, phase, gold, desire, desire_band, hp, ended, ending_name, steps, created_at, updated_at FROM saves',
    ).all() as Array<Record<string, unknown>>;
    const bySlot = new Map<number, SaveSummary>();
    for (const r of rows) {
      bySlot.set(Number(r.slot), {
        slot: Number(r.slot),
        title: String(r.title),
        day: Number(r.day),
        chapter: Number(r.chapter),
        phase: String(r.phase),
        gold: Number(r.gold),
        desire: Number(r.desire),
        desireBand: String(r.desire_band),
        hp: Number(r.hp),
        ended: Number(r.ended) !== 0,
        endingName: r.ending_name === null || r.ending_name === undefined ? null : String(r.ending_name),
        steps: Number(r.steps),
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
      });
    }
    const out: Array<SaveSummary | null> = [];
    for (let i = 0; i < SLOT_COUNT; i++) out.push(bySlot.get(i) ?? null);
    return out;
  }

  /** 读一个槽的**全量**（含快照 JSON）；空槽 ⇒ `null` */
  read(slot: number): SaveRow | null {
    const r = this.db.prepare('SELECT * FROM saves WHERE slot = ?').get(slot) as Record<string, unknown> | undefined;
    if (r === undefined) return null;
    return {
      slot: Number(r.slot),
      title: String(r.title),
      day: Number(r.day),
      chapter: Number(r.chapter),
      phase: String(r.phase),
      gold: Number(r.gold),
      desire: Number(r.desire),
      desireBand: String(r.desire_band),
      hp: Number(r.hp),
      ended: Number(r.ended) !== 0,
      endingName: r.ending_name === null || r.ending_name === undefined ? null : String(r.ending_name),
      steps: Number(r.steps),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      state: String(r.state),
    };
  }

  /**
   * 写一个槽（**整行覆盖**）。
   *
   * ⚠️ `created_at` 只在**首次**建档时写：之后每次覆盖都保留原值 ——
   *    "这一局是什么时候开局的"不该被一次自动存档改掉。
   */
  write(slot: number, s: Omit<SaveSummary, 'slot' | 'createdAt' | 'updatedAt'>, stateJson: string): void {
    const now = new Date().toISOString();
    const prev = this.db.prepare('SELECT created_at FROM saves WHERE slot = ?').get(slot) as { created_at?: string } | undefined;
    const created = prev?.created_at ?? now;
    this.db.prepare(
      `INSERT INTO saves (slot, title, day, chapter, phase, gold, desire, desire_band, hp, ended, ending_name, steps, created_at, updated_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slot) DO UPDATE SET
         title=excluded.title, day=excluded.day, chapter=excluded.chapter, phase=excluded.phase,
         gold=excluded.gold, desire=excluded.desire, desire_band=excluded.desire_band, hp=excluded.hp,
         ended=excluded.ended, ending_name=excluded.ending_name, steps=excluded.steps,
         updated_at=excluded.updated_at, state=excluded.state`,
    ).run(
      slot, s.title, s.day, s.chapter, s.phase, s.gold, s.desire, s.desireBand, s.hp,
      s.ended ? 1 : 0, s.endingName, s.steps, created, now, stateJson,
    );
  }

  remove(slot: number): void {
    this.db.prepare('DELETE FROM saves WHERE slot = ?').run(slot);
  }

  close(): void {
    this.db.close();
  }
}
