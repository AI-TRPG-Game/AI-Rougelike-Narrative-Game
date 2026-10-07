// P6 · 存档 / 读档 / 直接结算
//
// 这一套的**核心判据**只有一条：**读档之后接着走，必须与"没退出过"逐字一致。**
// 它一次性验证三件事：账本整份保真、**两条随机流的游标接上了**、播报/日志/步数没丢。
//
// ⚠️ 为什么不满足于"快照能 JSON 化 + 字段对得上"：那只能证明**形状**对，
//    证明不了"**接着跑**还对" —— 而"接不上游标"这种错**恰恰只在续跑时才现形**
//    （读档那一刻的状态是完美的，走两步就开始漂）。本项目已经栽过三次
//    "断言存在 ≠ 路径被走到"，这一条是它的同一族。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeBrain } from '../fixtures/fake.ts';
import { desireBandOf } from '../rules/desire.ts';
import { FAILURE_LINES, fillDaySlot } from '../rules/ending.ts';
import { makeRng } from '../rules/rng.ts';
import { SaveDb } from '../save/db.ts';
import { prologueRng } from '../turn/prologue.ts';
import { columnsOf, SaveStore, titleOf } from '../ui/save-flow.ts';
import { Session, SNAPSHOT_VERSION } from '../ui/session.ts';
import type { SessionSnapshot } from '../ui/session.ts';
import type { Suite } from './harness.ts';

const SEED = 7;

/**
 * 把当天还没点掉的**档 A 弹窗**逐条点掉。
 *
 * ⚠️ **不点掉，「进下一天」会被闸门 ④ 挡下**（"档 A 未清 ⇒ 禁止换日"）—— 那样这条测试
 *    就成了一场空转：`nextDay` 一步都没走（失败分支不走 `adopt`），时间只在 `dial` 上扣，
 *    "两条线一不一致"测的东西整个错位。（本轮实测：`nextDay ok=false`，两条线的游标却完全相同
 *    —— 那是"没测到"的样子，不是"接上了"的样子。）
 * ⚠️ 每点一条视图就变一次（序幕更是"点掉一条才铺下一条"）⇒ 每轮**重新取一遍**，
 *    不能先把数组拿在手里。
 */
async function clearPopups(s: Session): Promise<void> {
  for (let guard = 0; guard < 64; guard++) {
    const p = s.view().popups[0];
    if (!p) return;
    await s.clickPopup(p.id, 0);
  }
  throw new Error('弹窗点了 64 条还没清完 —— 编排是不是死循环了？');
}

/**
 * 走一局的几步**真的会推进、真的会掷骰**的动作：清弹窗 → 换日（T0：过期 / 重写命题 /
 * 章节占卜 / 生成，全都吃随机数）→ 拨时间（到点揭晓）。
 *
 * ⚠️ **每一个动作都必须 `await`**：`Session` 上的动作都是 `async`（内部要 `await` 规则层
 *    与 brain）。漏掉一个 `await`，快照就可能拍在"这一步还没落账"的中间态上 —— 那样
 *    两条线的差别来自**拍快照的时机**，与"读档接没接上游标"毫无关系
 *    （本轮实测就是这么假红过一次：`s.dial(2)` 没 await，快照少了一步 `dial`）。
 */
async function step(s: Session, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await clearPopups(s);
    await s.nextDay();
    await s.dial(2);
  }
}

/** 经一次 JSON 往返 —— 模拟"落盘再读回来"，顺带证明快照确实是**纯数据** */
function throughJson(snap: SessionSnapshot): SessionSnapshot {
  return JSON.parse(JSON.stringify(snap)) as SessionSnapshot;
}

// ── 随机流游标 ────────────────────────────────────────────────

const 随机流可续: Suite = {
  name: 'P6 · 随机流游标（存档的前置条件）',
  register(t) {
    t.test('★ 从游标续跑 ⇒ 后续序列与原来**逐个相同**', () => {
      const a = makeRng(12345);
      const head = [a.d20(), a.d20(), a.d20()];
      const mark = a.state;
      const tail = [a.d20(), a.d20(), a.d20(), a.int(4)];

      const b = makeRng(12345, mark);
      t.deep([b.d20(), b.d20(), b.d20(), b.int(4)], tail, '续跑的尾巴接上了');
      t.ok(head.length === 3, '前三个是热身的，不参与比较');
    });

    t.test('★ 不传游标 ⇒ 与原行为逐字一致（改写没动基线）', () => {
      // ⚠️ 比的是**两条各自的整条序列**，不是"一条流掷两次 vs 两个实例各掷一次"。
      //    后者只证明了"第一掷相同"（同种子第一掷当然相同），却把 `[20, 20]` 当成期望 ——
      //    那是**把两件不同的事当成同一件事**（本轮就是这么写错一次的）。
      const a1 = makeRng(999);
      const a2 = makeRng(999);
      t.deep([a2.d20(), a2.d20()], [a1.d20(), a1.d20()], '同一个 seed 两次独立构造 ⇒ 整条序列相同');

      const b1 = makeRng(999);
      const b2 = makeRng(999, undefined);
      t.deep([b2.d20(), b2.d20()], [b1.d20(), b1.d20()], '显式传 undefined 等于不传（整条序列）');
    });

    t.test('游标随掷骰前进；续跑的会话能一路走下去', () => {
      const r = makeRng(3);
      const s0 = r.state;
      r.d20();
      const s1 = r.state;
      t.ok(s0 !== s1, '掷一次 ⇒ 游标变了');
      const r2 = makeRng(3, s1);
      t.deep([r2.d20(), r2.d20()], [r.d20(), r.d20()], '连掷两次仍接得上');
    });

    t.test('序幕流也有游标，且两条流互不相干', () => {
      const p = prologueRng(7);
      p.d4();
      p.d4();
      const mark = p.state;
      const tail = [p.d4(), p.d4()];
      t.deep([prologueRng(7, mark).d4(), prologueRng(7, mark).d4()], tail, '序幕流可续');
      t.ok(makeRng(7).state !== prologueRng(7).state, '正文流与序幕流不是同一条');
    });
  },
};

// ── 快照形状 ──────────────────────────────────────────────────

const 快照形状: Suite = {
  name: 'P6 · 快照形状',
  register(t) {
    t.test('★ 快照是**纯数据**：JSON 往返后逐字相同（没有函数/Map/Set 混进去）', async () => {
      const s = await Session.start({ seed: SEED, skipPrologue: true });
      const snap = s.snapshot();
      t.deep(throughJson(snap), snap, 'JSON 往返无损');
    });

    t.test('快照**不含** brain —— "怎么算"不该跟着"这一局是什么"一起存', async () => {
      const s = await Session.start({ seed: SEED, skipPrologue: true });
      const keys = Object.keys(s.snapshot()).sort();
      // ⚠️ **11 个**（不是 10 个）：2026-10-05 加了 `choice`（玩家挑的欲望 ＋ 分配的优势属性）。
      //    它落盘的理由见下面那条「实例字段 ⇄ 快照字段」里的注释 ——
      //    那是**玩家做过的决定**，丢掉它 = 静默丢玩家数据。
      t.deep(
        keys,
        ['choice', 'endingAnnounced', 'feed', 'flip', 'ledger', 'log', 'pRngState', 'rngState', 'seed', 'steps', 'v'],
        '快照的字段清单恰好是这 11 个',
      );
    });

    t.test('快照带上版本号，且与库表版本是两件事', async () => {
      const s = await Session.start({ seed: SEED, skipPrologue: true });
      t.eq(s.snapshot().v, SNAPSHOT_VERSION, '快照自带版本');
    });

    /**
     * ★ 这一条是**参考项目踩过的坑那一半**（`参考项目可借鉴机制.md` §4）：
     *   他们的 `normalizeSession` 用**白名单**逐个列字段归一化，漏了一个 ⇒ **静默丢数据**，
     *   而且丢的是"整个机制"级别的字段（他们自己的注释原话：API 已创建的试炼会话
     *   一写进 IndexedDB，就退化成"没有时钟的普通会话"）。
     *
     * ⚠️ 上面那条"快照的字段清单恰好这 10 个"只钉住了**快照那一半**，它拦不住：
     *    给 `Session` 加一个 `this.xxx` 却根本没打算存它 ——
     *    **不会有任何断言变红**，读档那一刻也看不出来（那一刻它是默认值，与"没存"长得一样）。
     * ⇒ 这条把两边的清单**绑在一起**：加字段必须在这里露面（进"落盘"对照表，或进"不落盘"并写理由）。
     */
    t.test('★★ Session 的实例字段 ⇄ 快照字段：多一个字段就必须在这里做一次决定', async () => {
      const s = await Session.start({ seed: SEED, skipPrologue: true });
      /** 实例字段 → 它在快照里的名字（两条随机流是"状态 ⇄ 读数"，所以会改名） */
      const 落盘: Record<string, string> = {
        seed: 'seed',
        ledger: 'ledger',
        rng: 'rngState',
        pRng: 'pRngState',
        flip: 'flip',
        // ⚠️ 2026-10-05 加了 `choice`（玩家亲手挑的欲望 ＋ 分配的优势属性）⇒ 它**落盘**。
        //    理由：那是**玩家做过的决定**，"选好了还没开局就退出"时丢掉它 = 静默丢玩家数据
        //    —— 与本条测试顶上那个"白名单漏一个字段 ⇒ 整个机制退化"是同一类坑。
        //    ⚠️ 快照里它是**可选键**（`choice?`）⇒ 旧档没有时 `restore` 保留从账本回填的那份，
        //    `SNAPSHOT_VERSION` 刻意不 +1（理由见 `SessionSnapshot` 那段注释）。
        choice: 'choice',
        log: 'log',
        feed: 'feed',
        steps: 'steps',
        endingAnnounced: 'endingAnnounced',
      };
      /** 刻意不落盘的（理由写在 `Session.snapshot()` 顶上那段注释里） */
      // ⚠️ 2026-10-05 加了 `lastRoll`（判定盘那张骰面要的投骰明细）⇒ 它**不落盘**。
      //    理由：它是一次性的**演出状态**。落盘会有两个具体坏处 ——
      //      ① 读档回来就**重画一次骰面**，玩家以为"我刚投过一次"，而那不是他做的事；
      //      ② 旧存档要跟着改形状（`snapshot` 的形状一变，读档保真那条整条要重测）。
      //    真正需要它跨会话的地方**一处也没有** —— 它只被"刚排布完那一个浮层"读一次。
      //    ⚠️ 账本侧那份 `ledger.roll`（`{档位, 加成}`）**照旧落盘** ——
      //      那是世界的一部分（"上次判定成没成"要跨存档留着），与这个演出状态无关。
      // ⚠️ 2026-10-07 加了 `rollByEvent`（在路上的骰：排布时掷、揭晓时播的那份明细）⇒ **不落盘**。
      //    理由与 `lastRoll` 同族：纯**演出态**。读档回来"在路上的骰"没有动画可播 ——
      //    那次揭晓直接出结算结果（前端对缺 `roll` 的条目走原行为），玩法不受影响。
      const 不落盘 = ['brain', 'lastRoll', 'rollByEvent'];

      t.deep(
        Object.keys(s).sort(),
        [...Object.keys(落盘), ...不落盘].sort(),
        '★ 实例字段清单变了：新字段要么进"落盘"对照表，要么进"不落盘"并写清理由',
      );
      t.deep(
        Object.keys(s.snapshot())
          .filter((k) => k !== 'v')
          .sort(),
        Object.values(落盘).sort(),
        '★ 快照里也不许有"实例上没有"的字段（那它就是从别处飘来的）',
      );
    });
  },
};

// ── 读档保真 ──────────────────────────────────────────────────

const 读档保真: Suite = {
  name: 'P6 · 读档保真（★ 核心判据）',
  register(t) {
    t.test('★ 读档那一刻：视图与账本与存档时**逐字一致**', async () => {
      const a = await Session.start({ seed: SEED, skipPrologue: true });
      await step(a, 2);
      const b = Session.restore(throughJson(a.snapshot()), fakeBrain());
      t.deep(b.view(), a.view(), '视图一致（含 day / gold / desire / 待办 / 候选池）');
      t.deep(b.ledger, a.ledger, '账本整份一致');
      t.deep(b.feed, a.feed, '播报一致（读档回来不该发现播报没了）');
      t.eq(b.steps, a.steps, '步数一致');
    });

    t.test('★★ 读档之后**接着走三步**，账本仍与没退出过的那一份逐字一致', async () => {
      const a = await Session.start({ seed: SEED, skipPrologue: true });
      await step(a, 2);
      const b = Session.restore(throughJson(a.snapshot()), fakeBrain());

      // 两条线各走同样三步 —— 中间会换日（T0 掷骰、占卜、生成）与拨时间
      await step(a, 3);
      await step(b, 3);

      t.deep(b.ledger, a.ledger, '★ 续跑三步后账本仍逐字一致 ⇒ 随机流游标确实接上了');
      t.deep(b.view(), a.view(), '视图也一致');
      t.deep(b.log, a.log, '日志一致');
    });

    t.test('读档**不重放、不补算**：档案里那天的数值原样回来', async () => {
      const a = await Session.start({ seed: SEED, skipPrologue: true });
      await step(a, 3);
      const before = {
        day: a.ledger.clock.day,
        gold: a.ledger.scalars.gold,
        desire: a.ledger.desire.value,
        steps: a.steps,
      };
      const b = Session.restore(throughJson(a.snapshot()), fakeBrain());
      t.deep(
        { day: b.ledger.clock.day, gold: b.ledger.scalars.gold, desire: b.ledger.desire.value, steps: b.steps },
        before,
        '读档不推进任何东西',
      );
    });

    t.test('版本不符 ⇒ **明确抛错**，不硬读（硬读会把"列对不上"变成一堆静默 undefined）', async () => {
      const s = await Session.start({ seed: SEED, skipPrologue: true });
      const bad = { ...throughJson(s.snapshot()), v: 99 };
      t.throws(() => Session.restore(bad, fakeBrain()), '存档快照版本不符');
    });

    t.test('读档出来的是一个**独立**的会话：动它不影响原会话', async () => {
      const a = await Session.start({ seed: SEED, skipPrologue: true });
      await step(a, 1);
      const b = Session.restore(throughJson(a.snapshot()), fakeBrain());
      const goldA = a.ledger.scalars.gold;
      await step(b, 2);
      t.eq(a.ledger.scalars.gold, goldA, '原会话没被读档出来的那份带着走');
    });
  },
};

// ── 直接结算 ──────────────────────────────────────────────────

const 直接结算: Suite = {
  name: 'P6 · 直接结算（按 HP 归 0 算）',
  register(t) {
    t.test('★ 走的是**规则层既有的**总表第 1 行（HP ≤ 0），不是另写一套话术', async () => {
      const s = await Session.start({ seed: SEED, skipPrologue: true });
      await step(s, 2);
      t.ok(s.ledger.ending === null, '动手之前还没终局');

      const r = s.abandon();
      t.eq(r.ok, true, '直接结算成功');
      t.eq(r.ended, true, '结果标记为已终局');

      const e = s.ledger.ending!;
      t.eq(e.row, 1, '★ 结局取自**总表第 1 行**');
      t.eq(e.name, '陨命', '结局名就是 HP ≤ 0 那一条（「提前散了」是它的话术正文，不是名字）');
      t.eq(e.reason, 'HP ≤ 0', '触发的就是那条条件原文');
      t.eq(e.kind, '失败', '中途暴毙归在失败那一类');
      // ⚠️ 预期的是"**这一段**是系统预写的"，不是"某句具体台词在某一行里" ——
      //    「提前散了」是总表**第 3 行（迷失）**的话术，不在第 1 行里
      //    （本轮把两行的台词记串过一次）。⇒ 直接与总表那一行逐字对，`〔N〕` 也要对上。
      const row1 = FAILURE_LINES.find((f) => f.row === 1)!;
      t.eq(e.text, fillDaySlot(row1.text, e.day), '★ 话术逐字等于总表第 1 行那一段（`〔N〕` 已按实际天数填好）');
      t.eq(s.ledger.entities.people.find((p) => p.id === 'npc000')!.hp, 0, 'HP 确实归 0');
    });

    t.test('结算完就**锁住**：再拨时间 / 再进下一天都不许动', async () => {
      const s = await Session.start({ seed: SEED, skipPrologue: true });
      await step(s, 1);
      s.abandon();
      const after = s.ledger;
      const g = await s.nextDay();
      t.eq(g.ok, false, '已终局 ⇒ nextDay 被挡');
      t.ok(g.error.includes('已经结束'), '挡的理由说得清楚');
      t.deep(s.ledger, after, '账本一个字节都没动');
    });

    t.test('中途暴毙**没有放格子这一步** ⇒ 三格留空，不在账本里编出一组填过的格子', async () => {
      const s = await Session.start({ seed: SEED, skipPrologue: true });
      await step(s, 1);
      s.abandon();
      t.deep(s.ledger.ending!.placements, { 成果: null, 手段: null, 共鸣: null }, '三格空着');
    });

    t.test('播报里补上一条**终局**（玩家看得见"这一局到此为止"）', async () => {
      const s = await Session.start({ seed: SEED, skipPrologue: true });
      await step(s, 1);
      s.abandon();
      const last = s.feed[s.feed.length - 1];
      t.eq(last.kind, '终局', '最后一条播报是终局');
      t.ok(last.text.length > 0, '终局有话说');
    });

    t.test('重复结算 ⇒ 被 guard 挡下（不会把结局改写一遍）', async () => {
      const s = await Session.start({ seed: SEED, skipPrologue: true });
      await step(s, 1);
      s.abandon();
      const again = s.abandon();
      t.eq(again.ok, false, '第二次被挡');
      t.eq(s.ledger.ending!.row, 1, '结局没被改写');
    });

    t.test('结算后的快照照样能存档、能读回（终局也是一局）', async () => {
      const a = await Session.start({ seed: SEED, skipPrologue: true });
      await step(a, 1);
      a.abandon();
      const b = Session.restore(throughJson(a.snapshot()), fakeBrain());
      t.deep(b.ledger.ending, a.ledger.ending, '终局记录原样读回');
      t.deep(b.view(), a.view(), '终局视图一致');
    });
  },
};

// ── 存档库（真 SQLite）─────────────────────────────────────────
//
// ⚠️ 上面三套只验到 `Session` 的快照**形状**；真正把它**落进数据库**的是 `save/` 那一层
//    （`SaveDb` 的列与不透明 `state` 字段 ＋ `SaveStore` 的映射）。
//    这一套是唯一一处把它**整条走一遍**的地方：存 → 列 → 读 → 续跑，而且用的是**真的库文件**。
// ⚠️ 「**关库再开**仍然在」是这一套里最要紧的一条：库里那点东西要能过**进程边界**。
//    只在一个进程里读回来，用不着数据库 —— 一个全局变量就够了（那也就测不出什么）。
// ⚠️ 每个用例用自己的**临时库文件**（`os.tmpdir()`），跑完删掉：
//    绝不碰 `game/saves/game.db`（那是玩家的档）。

const 存档库往返: Suite = {
  name: 'P6 · 存档库往返（真 SQLite · 临时库文件）',
  register(t) {
    const tmpFile = (tag: string): string =>
      path.join(os.tmpdir(), `wangguo3-save-${process.pid}-${tag}.db`);

    /** 连带清掉 WAL / SHM 两个边车文件 —— 只删主文件会留下一个"半个库" */
    const wipe = (f: string): void => {
      for (const sfx of ['', '-wal', '-shm']) fs.rmSync(f + sfx, { force: true });
    };

    t.test('★ 存 → 列 → 读 → 续跑：账本逐字一致（真的过了一遍磁盘）', async () => {
      const f = tmpFile('rt');
      wipe(f);
      const store = new SaveStore(f);
      try {
        const a = await Session.start({ seed: SEED, skipPrologue: true });
        await step(a, 2);
        store.put(0, a);

        const list = store.list();
        t.eq(list.length, 4, '列表定长 4 个槽（空槽也要有位置）');
        t.eq(list[1], null, '没存过的槽是 null');
        const s = list[0]!;
        t.eq(s.day, a.ledger.clock.day, '摘要的 day 与账本一致');
        t.eq(s.gold, a.ledger.scalars.gold, '金币一致');
        t.eq(s.hp, a.ledger.entities.people.find((p) => p.id === 'npc000')!.hp, 'HP 一致');
        t.eq(s.desire, a.ledger.desire.value, '数值存下来了（给上帝视角 / 排错用）');
        t.eq(s.desireBand, desireBandOf(a.ledger.desire.value), '★ 区间名来自规则层那**同一个**函数，不是库里另算一份');
        t.eq(s.steps, a.steps, '步数存下来了');
        t.eq(s.ended, false, '还没终局');
        t.eq(s.endingName, null, '没有结局名');

        const b = store.load(0, fakeBrain())!;
        t.deep(b.ledger, a.ledger, '★ 读回来的账本逐字一致');
        t.deep(b.feed, a.feed, '播报也回来了（读档不该发现"播报没了"）');
        t.eq(b.steps, a.steps, '步数一致');
        t.eq(b.rng.state, a.rng.state, '★ 正文随机流的游标接上了');
        t.eq(b.pRng.state, a.pRng.state, '★ 序幕随机流的游标也接上了');

        await step(a, 3);
        await step(b, 3);
        t.deep(b.ledger, a.ledger, '★★ 各自再走三步，账本仍逐字一致 ⇒ 这一局真的"接得上"');
      } finally {
        store.close();
        wipe(f);
      }
    });

    t.test('★ 覆盖写不重置 createdAt；remove 之后回到空槽', async () => {
      const f = tmpFile('over');
      wipe(f);
      const store = new SaveStore(f);
      try {
        const a = await Session.start({ seed: SEED, skipPrologue: true });
        store.put(1, a);
        const created = store.list()[1]!.createdAt;
        const day1 = store.list()[1]!.day;

        await step(a, 2);
        store.put(1, a);
        const after = store.list()[1]!;
        t.eq(after.createdAt, created, '★ 「这一局什么时候开局的」不被覆盖写改掉');
        t.ok(after.day > day1, `内容换成了新的（${day1} → ${after.day}）`);
        t.ok(after.updatedAt >= created, 'updatedAt 至少不早于 createdAt');

        store.remove(1);
        t.eq(store.list()[1], null, '删掉之后是空槽');
        t.eq(store.load(1, fakeBrain()), null, '空槽读出来就是 null（不是抛错）');
        t.eq(store.list()[0], null, '★ 删一个槽不影响别的槽');
      } finally {
        store.close();
        wipe(f);
      }
    });

    t.test('★ 数据过得了**进程边界**：关库再开，档还在、账本还在', async () => {
      const f = tmpFile('persist');
      wipe(f);
      const first = new SaveStore(f);
      const a = await Session.start({ seed: 3, skipPrologue: true });
      await step(a, 1);
      first.put(2, a);
      const created = first.list()[2]!.createdAt;
      first.close(); // ⇐ 关键：把库关掉

      const second = new SaveStore(f);
      try {
        const row = second.list()[2];
        t.ok(row !== null, '★ 重开库，档仍然在（不是"进程内存里还留着"）');
        t.eq(row!.createdAt, created, 'createdAt 原样');
        const b = second.load(2, fakeBrain())!;
        t.deep(b.ledger, a.ledger, '★ 账本整份还在');
      } finally {
        second.close();
        wipe(f);
      }
    });

    t.test('★ 坏档 / 版本不符 ⇒ **明确抛错**（不静默开新局，让人以为进度没了）', async () => {
      const f = tmpFile('bad');
      wipe(f);
      const a = await Session.start({ seed: SEED, skipPrologue: true });
      const cols = columnsOf(a);

      // ① `state` 不是合法 JSON
      const raw1 = new SaveDb(f);
      raw1.write(0, cols, '这不是 JSON');
      raw1.close();
      const store = new SaveStore(f);
      try {
        t.throws(() => store.load(0, fakeBrain()), '不是合法 JSON');

        // ② JSON 合法，但快照版本对不上
        const raw2 = new SaveDb(f);
        raw2.write(1, cols, JSON.stringify({ v: 99 }));
        raw2.close();
        t.throws(() => store.load(1, fakeBrain()), '存档快照版本不符');

        t.ok(store.list()[0] !== null && store.list()[1] !== null, '坏档仍**列得出来**（摘要列是好的）—— 坏的是里面那份 JSON');
      } finally {
        store.close();
        wipe(f);
      }
    });

    // ⚠️ 2026-10-06：标题的**来源变了** —— 原来是"开局那两张牌"（塔罗，已删），
    //    现在是**欲望宣言**（同样终生不变、同样一眼认得出）。断言用意没变：
    //    ① 认得出是这一局；② 走了几天也不变（否则四个槽会长得一模一样）。
    t.test('★ 存档卡的标题用**欲望宣言**（终生不变），不是"第 N 天"', async () => {
      const a = await Session.start({ seed: SEED, skipPrologue: true });
      const t0 = titleOf(a);
      t.ok(t0.length > 0, `开局之后标题非空：${t0}`);
      const m = a.ledger.desire.manifesto;
      t.ok(m.startsWith(t0.replace('…', '')) || t0 === m, `标题该取自宣言（宣言「${m}」／标题「${t0}」）`);

      await step(a, 3);
      t.eq(titleOf(a), t0, '★ 走了几天，标题不变 —— 否则四个槽会长得一模一样，玩家认不出');
    });

    t.test('还没开局（序幕里）⇒ 标题退回「序幕」', async () => {
      const p = await Session.start({ seed: SEED });
      t.eq(p.ledger.desire.manifesto, '', '前提：序幕里还没定下欲望');
      t.eq(titleOf(p), '序幕');
    });
  },
};

export const suites: Suite[] = [随机流可续, 快照形状, 读档保真, 直接结算, 存档库往返];
