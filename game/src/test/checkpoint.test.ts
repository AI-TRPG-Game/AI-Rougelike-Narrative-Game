// 硬种子 checkpoint 全链测试（P4-E · 《规则.md》§二 S5-P4）
//   规则层门槛与提示语 → 账本侧批末出种 → 装配（进 prompt 的样子）→ 落地层「必出」两半 → 28 天驱动
//
// ⚠️ 这条链最值得测的是**四处没有任何东西替我们兜的地方**：
//   ① **「首次」是一条历史事实**：声望会跌回去、再升回来 —— 那种"再次达到"**不触发**
//      （《规则.md》§358）。⇒ 判据不能只看 `before / after`，必须配一份**已出过门槛**的账本标记
//      （`Ledger.repMarks`）。写成纯区间判断的话，"升回来"会**反复出种**，而没有任何断言会红。
//   ② **三条提示语逐字**：`title` ＋ ` —— ` ＋ `content` 拼起来**恰好**等于文档那条原文
//      —— 因为 `dispatchBlock` 的渲染格式就是 `${code} ${title} —— ${content}`。
//      ⇒ 这里把**文档原文**硬写进断言（不引用代码里的常量，否则等于自己和自己比）。
//   ③ **「必出」是两半**：出种（`commitBatch`）＋ **不占条数**（`land-compose` ①的豁免）。
//      少了后半，模型产满 5 条自由事件时那第 6 条（硬种子）会被条数兜底静默吃掉。
//   ④ **标记与出种原子**：没有 await、没有岔路。只做一半 ⇒ 要么"记了标记没出种"，
//      要么"出了种没记标记"（后者会让这条 checkpoint **永远不再触发**）。
//
// ⚠️ 还有一个**必须写明的覆盖率前提**：三个基线种子的声望终值是
//    `善0 恶0 侠5 怪5 权5` / `善0 恶0 侠3 怪8 权5` / `善0 恶0 侠5 怪7 权5`
//    —— **峰值 8，一个门槛都碰不到** ⇒ 标准 28 天 `checkpoint` **一次都不触发**。
//    这是**设计如此**（夹具的 `rep` 变化只有「大成功 侠名 +1」与混键 `怪名 +1`），
//    不是缺口 ⇒「硬种子 checkpoint 被走到」这条覆盖率**只在 `driveCheckpoint` 被打开时才断言**
//    （与 `driveArchive` / `driveEnding` / `driveInstantEnding` 同族）。
import { initialLedger } from '../ledger/initial.ts';
import { applyDelta, commitBatch } from '../ledger/apply.ts';
import { emptyBatch } from '../ledger/batch.ts';
import { nextSeedCode } from '../ledger/ids.ts';
import type { Ledger, Seed } from '../ledger/types.ts';
import type { Rep5, RepKey } from '../contract/types.ts';
import {
  CHECKPOINT_CONTENT,
  CHECKPOINT_STEPS,
  checkpointPrompt,
  checkpointTitle,
  crossedCheckpoints,
  emptyRepMarks,
} from '../rules/checkpoint.ts';
import { chapterOf } from '../rules/clock.ts';
import { assembleCompose } from '../prompt/assemble.ts';
import { dispatchBlock, renderComposeUser } from '../prompt/blocks.ts';
import { landCompose } from '../turn/land-compose.ts';
import { DRIVE_CHECKPOINT_BEFORE, DRIVE_CHECKPOINT_DELTA, DRIVE_CHECKPOINT_DAY, simulate } from '../turn/simulate.ts';
import { TOTAL_DAYS } from '../rules/clock.ts';
import type { Suite } from './harness.ts';

// ── 夹具 ─────────────────────────────────────────────────────────

/** 第 N 天的账本（其余照 `initialLedger` 的序幕占位） */
function atDay(day: number): Ledger {
  const l = structuredClone(initialLedger());
  l.clock.day = day;
  l.clock.chapter = chapterOf(day);
  l.clock.usedToday = 0;
  return l;
}

/** 把某几格声望**直接摆到**某个读数上（"它本来就是这个值" —— 不是要走一次变化） */
function atRep(rep: Partial<Rep5>, day = 3): Ledger {
  const l = atDay(day);
  Object.assign(l.scalars.rep, rep);
  return l;
}

/** 走**真实的一批**声望变化：`applyDelta` 只写批 → `commitBatch` 批末落账 */
function bumpRep(l: Ledger, rep: Partial<Rep5>) {
  const batch = emptyBatch(l);
  applyDelta(l, { ops: [{ rep }] } as never, {}, batch);
  return commitBatch(l, batch);
}

/** 一条**原始形状**的档 B 事件（字段名与 `schema/compose.ts` 逐字一致） */
function canvas(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'e1',
    title: '城门口的一张无名告示',
    seed_id: '',
    stage: '下城',
    content: '（告示）',
    hint_attr: ['智慧'],
    min_people: 1,
    max_people: 3,
    tier: 'B',
    cost: 2,
    min_gold: 0,
    deadline: 2,
    dispatchable: '两者皆可',
    ...over,
  };
}

// ── 《规则.md》S5-P4 三条提示语的**文档原文**（硬写 —— 不引用代码里的常量）──
const DOC: Record<number, string> = {
  10: '善名达到 10 —— 小有名声：这号名声第一次显形，开始有人（民间 / 朝中）念叨起你。',
  15: '善名达到 15 —— 名声在外：它已经传到你管不着的地方去了。',
  20: '善名达到 20 —— 名满王城：这号名声成了你的标签，事情开始自己找上门。',
};

export const suites: Suite[] = [
  // ── ① 规则层 · 门槛与提示语（唯一拷贝）──────────────────────────
  {
    name: 'P4-E · 规则层：三档门槛与三条提示语',
    register(t) {
      t.test('★ 三档门槛 = 10 / 15 / 20（升序）', () => {
        t.deep([...CHECKPOINT_STEPS], [10, 15, 20], '门槛档位只有这三档');
      });

      t.test('★ 三条提示语**逐字**（对着文档原文比，不引代码常量）', () => {
        for (const step of [10, 15, 20] as const) {
          t.eq(checkpointPrompt('善名', step), DOC[step], `第 ${step} 档提示语必须逐字`);
        }
      });

      t.test('★ `title ＋ 「 —— 」 ＋ content` **恰好**等于提示语全文 —— 种子渲染格式就是为它定的', () => {
        // `dispatchBlock` 渲染种子是 `${code} ${title} —— ${content}`
        // ⇒ 拆成两半装进 `Seed` 之后，渲染出来还得**逐字**是那条提示语。
        for (const step of [10, 15, 20] as const) {
          const line = `${checkpointTitle('善名', step)} —— ${CHECKPOINT_CONTENT[step]}`;
          t.eq(line, DOC[step], `第 ${step} 档：两半拼回去要逐字相等`);
        }
      });

      t.test('★ 判据 `before < N ≤ after`：**恰好落在门槛上**也算（9 → 10 命中）', () => {
        t.deep(crossedCheckpoints(9, 10, []), [10], '端点上的 `>=` 少一个等号，"第一次显形"就永远不发生');
        t.deep(crossedCheckpoints(9, 9, []), [], '没跨过就不出');
        t.deep(crossedCheckpoints(10, 14, []), [], '10 → 14 没碰 15');
        t.deep(crossedCheckpoints(14, 15, [10]), [15], '已出过 10 ⇒ 只出 15');
      });

      t.test('★ 已出过的门槛不再出；**跌回去再升回来**也不出（"首次"是历史事实）', () => {
        t.deep(crossedCheckpoints(9, 10, [10]), [], '出过 10 ⇒ 再跨 10 也不出');
        t.deep(crossedCheckpoints(9, 12, [10, 15]), [], '两档都出过 ⇒ 什么都不出');
        t.deep(crossedCheckpoints(9, 12, [10]), [], '15 还没到，本来就不该出');
      });

      t.test('`emptyRepMarks()` 每次新建、五格齐全 —— 共享一个可变对象会让"没出过"变成假的', () => {
        const a = emptyRepMarks();
        const b = emptyRepMarks();
        t.deep(Object.keys(a).sort(), ['善名', '权势', '恶名', '怪名', '侠名'].sort(), '五格声望各一份');
        a.侠名.push(10);
        t.deep(b.侠名, [], '两份必须是**各自独立**的数组');
        t.deep(a.善名, []);
      });
    },
  },

  // ── ② 账本侧 · 批末判「首次达标」并出种 ────────────────────────
  {
    name: 'P4-E · 账本侧：`commitBatch` 批末出种（标记 ＋ 种子，原子）',
    register(t) {
      t.test('★ 声望 9 → 10：账本标记落下来 ＋ **必出** 1 条 `source: 硬种子`', () => {
        const l = atRep({ 善名: 9 });
        const r = bumpRep(l, { 善名: 1 });
        t.eq(r.ledger.scalars.rep.善名, 10, '前提：真的推到了门槛上');
        t.deep(r.ledger.repMarks.善名, [10], '★ 「首次达 10」要落进账本（跌回去再升回来时唯一的分辨依据）');
        t.eq(r.ledger.seeds.length, 1, '★ 必出 1 条种子');
        t.eq(r.ledger.seeds[0].source, '硬种子', '★ 来源是硬种子，不是 LLM 钩子');
        t.deep(r.checkpoints, ['善名达到 10'], '★ 结构读数（覆盖率 / 调试用，不去 grep 那句人话）');
        t.ok(
          r.report.some((s) => s.includes('硬种子 checkpoint：善名 首次达到 10')),
          '落账报告里要看得见（不静默）',
        );
      });

      t.test('★★ 它进了 prompt 之后**逐字**是《规则.md》那条提示语', () => {
        const l = atRep({ 善名: 9 });
        const r = bumpRep(l, { 善名: 1 });
        const block = dispatchBlock(r.ledger);
        t.ok(block.includes(`[硬] s1 ${DOC[10]}`), `装配出来的种子行必须逐字对上文档：\n${block}`);
        // ⚠️ 反面：**不能**不带 `[硬]` 前缀 —— 硬种子与软钩子长得一样，
        //    「硬种子必须被承接」那句指令就没有指称对象。
        t.ok(!block.includes(`s1 ${DOC[10]}`) || block.includes(`[硬] s1 ${DOC[10]}`));
      });

      t.test('★★ 硬种子**不占条数、不占行动点**（额外叠加 —— 只出了一条种子）', () => {
        const l = atRep({ 善名: 9 });
        const eventsBefore = l.events.live.length + l.events.hidden.length;
        const r = bumpRep(l, { 善名: 1 });
        t.eq(r.ledger.clock.usedToday, 0, '★ 不占玩家时间读数');
        t.eq(r.ledger.events.live.length + r.ledger.events.hidden.length, eventsBefore, '★ 不往事件池里塞东西');
        t.deep(r.ledger.actionPoints, l.actionPoints, '★ 不占任何人的容量预算');
        t.eq(r.ledger.seeds.length, 1, '它只做一件事：往种子池里放一条');
      });

      t.test('★ 标记与出种**原子**：`repMarks` 的条数 ≡ `checkpoints` 的条数', () => {
        const l = atRep({ 善名: 9, 怪名: 14 });
        const r = bumpRep(l, { 善名: 1, 怪名: 1 });
        const marks = (Object.keys(r.ledger.repMarks) as RepKey[]).reduce(
          (n, k) => n + r.ledger.repMarks[k].length,
          0,
        );
        t.eq(marks, r.checkpoints.length, '★ 记了标记就必须出种（只记不出 ⇒ 这条 checkpoint 永远不再触发）');
        t.eq(r.ledger.seeds.length, r.checkpoints.length, '★ 出了种就必须记标记（只出不记 ⇒ 反复出）');
        t.deep(r.checkpoints, ['善名达到 10', '怪名达到 15'], '两格各自出各自的（不合并）');
      });

      t.test('同批跨两档 ⇒ 各出一条（"单次 rep ≤ 5"是**生成侧**约束，规则层不在这里替它兜底）', () => {
        // ⚠️ `validateDelta` 的 `LIMITS.rep` 是 ±20（不是 ±5）—— 「单次 ≤ 5」写在生成侧指令里，
        //    服务端与规则层都不拦。⇒ 真出现 8 → 17 时，10 与 15 各自都是合法的"首次达到"
        //    ⇒ 各出一条。这里把它钉住，免得以后有人"顺手"加一个只有 1 条的假设。
        const l = atRep({ 善名: 8 });
        const r = bumpRep(l, { 善名: 9 });
        t.eq(r.ledger.scalars.rep.善名, 17);
        t.deep(r.checkpoints, ['善名达到 10', '善名达到 15'], '跨两档 ⇒ 两档各出 1 条');
        t.deep(r.ledger.repMarks.善名, [10, 15]);
      });

      t.test('★ 跌回去再升回来 ⇒ **不再出**（首次是一条历史事实，从当前值推不出来）', () => {
        const l0 = atRep({ 善名: 9 });
        const a = bumpRep(l0, { 善名: 1 }); // 9 → 10：出第一条
        t.eq(a.checkpoints.length, 1);
        const b = bumpRep(a.ledger, { 善名: -6 }); // 10 → 4：跌回去
        t.eq(b.ledger.scalars.rep.善名, 4);
        t.deep(b.checkpoints, [], '往下走不触发任何东西');
        const c = bumpRep(b.ledger, { 善名: 8 }); // 4 → 12：又跨过 10
        t.eq(c.ledger.scalars.rep.善名, 12);
        t.deep(c.checkpoints, [], '★ 这一格"早就出过 10 了" ⇒ 不许再出');
        t.deep(c.ledger.repMarks.善名, [10], '标记只有一条，没有被重复写进去');
        t.eq(c.ledger.seeds.length, 1, '种子池里仍然只有最初那一条');
      });

      t.test('没有 `rep` 变化的批 ⇒ checkpoint 零副作用', () => {
        const l = atRep({ 善名: 9 });
        const r = bumpRep(l, { 善名: 0 });
        t.deep(r.checkpoints, []);
        t.deep(r.ledger.repMarks, emptyRepMarks(), '标记一个都不动');
        t.eq(r.ledger.seeds.length, 0, '种子一条都不出');
      });

      t.test('★ 种子编号取「现有最大序号 + 1」—— 池子带洞时不撞号', () => {
        // ⚠️ 硬种子**跨天留存**（没被承接就留到明天）⇒ 池子会变成 `[s2]` 这种"带洞"的样子。
        //    若按 `length + 1` 发号，新种子也叫 `s2` —— 而 `claimSeed` 是按 code 查的
        //    ⇒ 一次承接会把两条一起核销（**静默**，没有任何断言会红）。
        t.eq(nextSeedCode([]), 's1');
        t.eq(nextSeedCode([{ code: 's1' }]), 's2');
        t.eq(nextSeedCode([{ code: 's2' }]), 's3', '★ 池子里只剩 s2 ⇒ 下一条是 s3，不是 s2');
        t.eq(nextSeedCode([{ code: 's3' }, { code: 's1' }]), 's4');

        const l = atRep({ 善名: 9 });
        l.seeds = [{ code: 's2', title: '先留下来的硬种子', content: '旧', source: '硬种子' }];
        const r = bumpRep(l, { 善名: 1 });
        t.eq(r.ledger.seeds.length, 2);
        t.eq(r.ledger.seeds[1].code, 's3', '★ 新出的那条不许与留下的 s2 撞号');
      });
    },
  },

  // ── ③ 装配 · 进 prompt 的样子 ─────────────────────────────────
  {
    name: 'P4-E · 装配：硬种子与软钩子在【本日调度】里**必须能分辨**',
    register(t) {
      const hard: Seed = { code: 's1', title: '善名达到 10', content: CHECKPOINT_CONTENT[10], source: '硬种子' };
      const soft: Seed = { code: 's2', title: '「城门口的一张无名告示」的后续', content: '有人记住了你', source: 'LLM' };

      t.test('硬种子带 `[硬]` 前缀、软钩子不带 —— 否则「硬种子必须被承接」没有指称对象', () => {
        const l = atDay(3);
        l.seeds = [hard, soft];
        const block = dispatchBlock(l);
        t.ok(block.includes(`[硬] s1 ${DOC[10]}`), `硬种子要带前缀且提示语逐字：\n${block}`);
        t.ok(!block.includes(`[硬] s2`), '软钩子不许带 `[硬]`');
        t.ok(block.includes(`s2 ${soft.title} —— ${soft.content}`), '软钩子的渲染格式一字不改');
      });

      t.test('没有种子时仍写哨兵「无」（既有口径不动）', () => {
        const l = atDay(3);
        l.seeds = [];
        t.ok(dispatchBlock(l).includes('种子：无'));
      });

      t.test('★ 种子真的到了 `compose_day` 的 user ③ 里（不是只写进了账本）', () => {
        const l = atDay(3);
        l.seeds = [hard];
        const user = renderComposeUser(l);
        t.ok(user.includes(`[硬] s1 ${DOC[10]}`), '★ 生成侧看得见这条硬种子');
        const full = assembleCompose(l);
        t.ok(JSON.stringify(full).includes('善名达到 10'), '整份请求体里也有它（不是只渲染到一个没人用的桶里）');
      });
    },
  },

  // ── ④ 落地层 · 「必出」的另一半 ───────────────────────────────
  {
    name: 'P4-E · 落地层：「必出」＝ 出种 ＋ 不占条数（两半都要）',
    register(t) {
      const HARD: Seed = { code: 's1', title: '善名达到 10', content: CHECKPOINT_CONTENT[10], source: '硬种子' };

      t.test('★ 没人承接 ⇒ 报进 `problems` ＋ 种子**留到明天**（"必出"不能靠自觉）', () => {
        const l = atDay(3);
        l.seeds = [HARD];
        const r = landCompose(l, { canvas_events: [canvas({ seed_id: '' })] });
        t.eq(r.problems.length, 1, '★ 硬种子没人承接必须报出来');
        t.ok(r.problems[0].includes('s1') && r.problems[0].includes('必出'));
        t.eq(l.seeds.length, 1, '★ 硬种子跨天留存（不像软种子当天丢弃）');
        t.eq(l.seeds[0].code, 's1');
      });

      t.test('★ 有人承接 ⇒ 核销、不留（硬种子不是"永不清"）', () => {
        const l = atDay(3);
        l.seeds = [HARD];
        const r = landCompose(l, { canvas_events: [canvas({ seed_id: 's1' })] });
        t.deep(r.problems, [], '承接了就不该再报"没人管"');
        t.eq(l.seeds.length, 0, '被承接即核销');
        t.ok(r.log.some((s) => s.includes('种子 s1') && s.includes('承接')), '要留一条承接日志');
      });

      t.test('★★ 承接硬种子的事件**不占**「自由事件 ≤5」', () => {
        // ⚠️ 少了这一条，"必出"会被条数兜底静默吃掉：6 条一起产、硬种子那条排最后 ⇒
        //    它被丢 ⇒ 硬种子没人承接 ⇒ 只剩一条"没人承接"的警告，真实原因（配额）看不见。
        const l = atDay(3);
        l.seeds = [HARD];
        const free = ['甲', '乙', '丙', '丁', '戊'].map((s, i) =>
          canvas({ id: `e${i + 1}`, title: `自由事件${s}`, seed_id: '' }),
        );
        const hardEv = canvas({ id: 'e6', title: '善名的传言出了城', seed_id: 's1' });
        const r = landCompose(l, { canvas_events: [...free, hardEv] });
        t.eq(r.live.length, 6, '★ 5 条自由 ＋ 1 条硬种子 = 6 条都进池子');
        t.ok(
          r.live.some((e) => e.title === '善名的传言出了城'),
          '★ 排在最后的那条（硬种子）真的落地了 —— 它没有被条数兜底吃掉',
        );
        t.deep(r.problems, [], '硬种子被承接了');
        t.eq(l.seeds.length, 0, '被承接即核销');
        t.ok(
          r.log.some((s) => s.includes('不占')),
          `要留一条"豁免额度"的日志（不静默）：\n${r.log.join('\n')}`,
        );
      });

      t.test('★ 反过来：**软钩子**超产照样被条数兜底丢掉（豁免只给硬种子）', () => {
        const l = atDay(3);
        l.seeds = [{ code: 's1', title: '软种子甲', content: '甲', source: 'LLM' }];
        const free = ['甲', '乙', '丙', '丁', '戊'].map((s, i) =>
          canvas({ id: `e${i + 1}`, title: `自由事件${s}`, seed_id: '' }),
        );
        const softEv = canvas({ id: 'e6', title: '软钩子的续章', seed_id: 's1' });
        const r = landCompose(l, { canvas_events: [...free, softEv] });
        t.eq(r.live.length, 5, '软钩子不豁免 ⇒ 仍然只剩 5 条');
        t.ok(
          !r.live.some((e) => e.title === '软钩子的续章'),
          '★ 第 6 条（软钩子）被丢 —— 豁免不是"条数上限失效"',
        );
        t.ok(r.log.some((s) => s.includes('超出「自由事件 ≤5」')), '超产的日志照留');
      });
    },
  },

  // ── ⑤ 28 天驱动（覆盖率）─────────────────────────────────────
  {
    name: 'P4-E · 28 天驱动（标准局恒 0 触发 · 驱动局必被走到）',
    register(t) {
      t.test('★ 标准 28 天：三种子 `repMarks` 全空 —— 声望峰值 8，一个门槛都碰不到（设计意图）', async () => {
        // ⚠️ 这不是"没测到"，是**如实记录一个设计结果**：夹具的 `rep` 变化只有
        //    「大成功 侠名 +1」与混键 `怪名 +1`，28 天攒不到 10（实测终值 善0 恶0 侠5 怪5 权5 /
        //    善0 恶0 侠3 怪8 权5 / 善0 恶0 侠5 怪7 权5）。
        //    ⚠️ 它同时是一条**绊线**：哪天标定把声望调快了，这条会红 —— 那时该重看的是
        //       "28 天里出几次 checkpoint 才合适"，不是把断言删掉。
        for (const seed of [1, 7, 42]) {
          const r = await simulate(seed, TOTAL_DAYS);
          const marks = Object.values(r.ledger.repMarks).flat();
          t.deep(marks, [], `seed ${seed}：标准局不该跨过任何门槛`);
          t.ok(
            !r.coverage.some((c) => c.name.includes('硬种子')),
            `seed ${seed}：未被驱动时这条覆盖率不该出现（出现了就是一条永远假绿的断言）`,
          );
        }
      });

      t.test('★ 驱动局（`driveCheckpoint`）⇒ 那条覆盖率被真的点亮 ＋ 0 违规', async () => {
        const r = await simulate(1, TOTAL_DAYS, { driveCheckpoint: true });
        const c = r.coverage.find((x) => x.name.includes('硬种子 checkpoint 被走到'));
        t.ok(c !== undefined, '被驱动时这条覆盖率**必须**出现');
        t.ok(c?.ok === true, `必须达标：${c?.detail}`);
        t.deep(r.violations, [], '推一次声望不该造出任何违规');
        t.ok(
          r.ledger.repMarks.善名.includes(10),
          `第 ${DRIVE_CHECKPOINT_DAY} 天把善名从 ${DRIVE_CHECKPOINT_BEFORE} 推过 ${DRIVE_CHECKPOINT_BEFORE + DRIVE_CHECKPOINT_DELTA} ⇒ 门槛 10 应落进账本`,
        );
      });

      t.test('★ 驱动只改声望、不改别的：同一个种子走满 28 天，日历 / 结局 / 欲念一步不差', async () => {
        // `rep` 不参与任何判定（欲念窗口 / 成果格 / HP·SAN），也不消耗 `rng`
        // ⇒ 驱动对整局轨迹**零影响**。这条是"驱动没有偷偷改别的东西"的配对防线。
        const a = await simulate(7, TOTAL_DAYS);
        const b = await simulate(7, TOTAL_DAYS, { driveCheckpoint: true });
        t.eq(b.ledger.clock.day, a.ledger.clock.day, '日历一步不差');
        t.eq(b.stats.daysEntered, a.stats.daysEntered, '进入下一天的次数不变');
        t.eq(b.ledger.desire.value, a.ledger.desire.value, '欲念轨迹没动');
        t.eq(b.ledger.ending!.day, a.ledger.ending!.day, '终结日不变');
        t.eq(b.ledger.ending!.name, a.ledger.ending!.name, '结局名不变');
        t.eq(b.stats.revealed, a.stats.revealed, '揭晓条数不变');
        t.deep(b.stats.idleDays, a.stats.idleDays, '空转日不变');
      });
    },
  },
];
