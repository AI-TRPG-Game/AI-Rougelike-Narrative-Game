// 终局（放格子 → 判定 → 结局话术）—— Phase 4 下半场的核心：**让 28 天有个出口**。
//
// 覆盖四层：
// ① 规则层判定
// ② 话术保真（7 条写死 ＋ 唯一插槽「第〔N〕天」）
// ③ 账本写入（`turn/ending.ts`：原子、单写者、不改旧账本）
// ④ 编排接线（`simulate` 的第 28 天放格子；三格候选池各自独立）
//
// ⚠️ 判据来源：**判定顺序 = 从上到下、先命中先结束**；`5 优先于 6、6 优先于 7`。
//    这两条是本套件的重点 —— 它们错了不会有任何症状，只会"结局名看着不太对"。
import { makeEvent } from '../fixtures/fake.ts';
import { initialLedger } from '../ledger/initial.ts';
import { emptyPlacements, PLACEMENT_SLOTS, type Ledger, type Placements } from '../ledger/types.ts';
import { TOTAL_DAYS } from '../rules/clock.ts';
import {
  DESIRE_WINDOW_MAX,
  DESIRE_WINDOW_MIN,
  FAILURE_LINES,
  FLAVOR_NAMES,
  fillDaySlot,
  finalEndingOf,
  flavorOf,
  instantEndingOf,
  isFinalDay,
} from '../rules/ending.ts';
import { closeGame, enterEnding, terminateIfOver } from '../turn/ending.ts';
import { autoPlace, DRIVE_BREAK_DAY, simulate, type SimResult } from '../turn/simulate.ts';
import type { Suite } from './harness.ts';

/** 摆到「第 28 天、欲念 = v、玩家还活着」的账本 */
function finalDayLedger(v: number): Ledger {
  const l = initialLedger();
  l.clock = { day: TOTAL_DAYS, phase: '终局', chapter: 4, usedToday: 0 };
  l.desire.value = v;
  return l;
}

function place(all: boolean, partial: Partial<Placements> = {}): Placements {
  const p = emptyPlacements();
  if (all) {
    p.成果 = 'it001';
    p.手段 = 'e1';
    p.共鸣 = 'npc001';
  }
  return { ...p, ...partial };
}

const player = (l: Ledger): { hp: number; san: number } => l.entities.people.find((p) => p.id === 'npc000')!;

/**
 * 每套件最多跑一次 28 天 —— `simulate` 是全量驱动，重复跑纯属浪费。
 * （但**必须真的跑**：这两条端到端断言的价值就在于"整条链子接起来了没有"。）
 */
let cached: Promise<SimResult> | null = null;
const sim1 = (): Promise<SimResult> => (cached ??= simulate(1));

export const suites: Suite[] = [
  {
    name: '★ 终局 · 总表与话术',
    register(t) {
      t.test('总表：7 条失败，行号 1~7 连续且不重', () => {
        t.eq(FAILURE_LINES.length, 7);
        t.deep(
          FAILURE_LINES.map((f) => f.row),
          [1, 2, 3, 4, 5, 6, 7],
        );
      });

      t.test('★ 结局名共 6 个 —— 「沉溺」按设计出现两次（欲念 = 100 与 第 28 天欲念 > 80）', () => {
        const names = FAILURE_LINES.map((f) => f.name);
        const uniq = [...new Set(names)];
        t.eq(uniq.length, 6);
        for (const n of ['陨命', '疯癫', '迷失', '沉溺', '未竟', '空手']) t.ok(uniq.includes(n), `缺结局名「${n}」`);
        t.eq(names.filter((n) => n === '沉溺').length, 2, '沉溺既是「火烧到了底」也是「要到手之后」');
      });

      t.test('★ 唯一系统插槽：②③④ 带「第〔N〕天」（① 2026-10-08 改写后不提天数），⑤⑥⑦ 恒「第 28 天」', () => {
        t.deep(
          FAILURE_LINES.filter((f) => f.daySlot).map((f) => f.row),
          [2, 3, 4],
        );
        for (const f of FAILURE_LINES) {
          t.eq(f.text.includes('〔N〕'), f.daySlot, `第 ${f.row} 行「${f.title}」的插槽与 daySlot 不一致`);
        }
      });

      t.test('话术小标题逐字（七条各自的小标题，不是结局名）', () => {
        t.deep(
          FAILURE_LINES.map((f) => f.title),
          ['一页潦草', '落锁的房间', '什么都不要了', '火烧到了底', '差一口火', '要到手之后', '差一点点'],
        );
      });

      t.test('fillDaySlot：全局替换「〔N〕」，填完不许再有残留、也不许留下双空格', () => {
        // ⚠️ 补空格是有意的：原文是「第〔N〕天」，而 ⑤⑥⑦ 写死的是「第 28 天」—— 同一排版。
        t.eq(fillDaySlot('第〔N〕天，你什么都没了', 9), '第 9 天，你什么都没了');
        t.eq(fillDaySlot('（无插槽）', 28), '（无插槽）');
        t.eq(fillDaySlot('第〔N〕天', 10).includes('  '), false, '不许出现双空格');
        // ⑤⑥⑦ 走同一条替换（只是对它们是空操作）⇒ 断言"替换后与原文逐字相同"
        for (const f of FAILURE_LINES.filter((x) => !x.daySlot)) {
          t.eq(fillDaySlot(f.text, TOTAL_DAYS), f.text);
        }
      });

      t.test('三格名字 —— 「如一的初衷」不在其中（它没有格子，由欲念窗口自动判定）', () => {
        t.deep([...PLACEMENT_SLOTS], ['成果', '手段', '共鸣']);
      });
    },
  },

  {
    name: '★ 终局 · 逐次检查（总表 1~4 · 每一次结算之后）',
    register(t) {
      const onDay5 = (fn: (l: Ledger) => void): Ledger => {
        const l = initialLedger();
        l.clock.day = 5;
        fn(l);
        return l;
      };
      const kill = (field: 'hp' | 'san'): Ledger =>
        onDay5((l) => {
          player(l)[field] = 0;
        });

      t.test('HP ≤ 0 ⇒ 总表第 1 行「陨命」', () => {
        const e = instantEndingOf(kill('hp'))!;
        t.eq(e.row, 1);
        t.eq(e.name, '陨命');
        t.eq(e.kind, '失败');
      });

      t.test('SAN ≤ 0 ⇒ 第 2 行「疯癫」', () => {
        const e = instantEndingOf(kill('san'))!;
        t.eq(e.row, 2);
        t.eq(e.name, '疯癫');
      });

      t.test('欲念 = 0 ⇒ 第 3 行「迷失」', () => {
        const l = onDay5((x) => (x.desire.value = 0));
        const e = instantEndingOf(l)!;
        t.eq(e.row, 3);
        t.eq(e.name, '迷失');
      });

      t.test('欲念 = 100 ⇒ 第 4 行「沉溺」', () => {
        const l = onDay5((x) => (x.desire.value = 100));
        const e = instantEndingOf(l)!;
        t.eq(e.row, 4);
        t.eq(e.name, '沉溺');
      });

      t.test('★ 判定顺序：HP ≤ 0 与 欲念 = 0 同时成立 ⇒ 走第 1 行（先命中先结束）', () => {
        const l = onDay5((x) => {
          x.desire.value = 0;
          player(x).hp = 0;
        });
        t.eq(instantEndingOf(l)!.row, 1);
      });

      t.test('★ 判定顺序：SAN ≤ 0 与 欲念 = 100 同时成立 ⇒ 走第 2 行', () => {
        const l = onDay5((x) => {
          x.desire.value = 100;
          player(x).san = 0;
        });
        t.eq(instantEndingOf(l)!.row, 2);
      });

      t.test('一条都没命中 ⇒ null（正常的一天不该被判结局）', () => {
        t.eq(instantEndingOf(initialLedger()), null);
      });

      t.test('★ 开局账本不能被逐次检查判死 —— 欲念占位 30', () => {
        // 这条守的是 2026-09-19 那次修正：开局欲念曾写成 0 ⇒ 档 A 点一个「偏离」（−3）就归零
        // ⇒ 第 1 天就该判「失败 · 迷失」，而当时模拟器会继续跑满 28 天（逐次检查还没实现）。
        t.eq(initialLedger().desire.value, 30);
        t.eq(instantEndingOf(initialLedger()), null);
      });

      t.test('★ 提前终结的话术当场填「第〔N〕天」—— 落账的就是玩家会读到的那份', () => {
        // ⚠️ 2026-10-08 起 row1（陨命）话术按用户改写后**不含**天数插槽 ⇒ 换 row2（疯癫）
        //    验证同一条纪律：「〔N〕当场填、玩家读到的就是填好的那份」。
        const e = instantEndingOf(kill('san'))!;
        t.eq(e.day, 5);
        t.ok(!e.text!.includes('〔N〕'), '插槽必须已填');
        t.ok(e.text!.includes('第 5 天'), `话术里应出现实际天数：${e.text!.split('\n')[0]}`);
        // row1 改写后的契约：没有插槽 ⇒ 落账的与总表原文**逐字相同**（fillDaySlot 空操作）
        const r1 = instantEndingOf(kill('hp'))!;
        t.eq(r1.text, FAILURE_LINES[0].text, '★ 2026-10-08：陨命新话术不含插槽，落账逐字等于原文');
      });
    },
  },

  {
    name: '★ 终局 · 终局检查（总表 5~7 ＋ 成功 · 第 28 天放格子之后）',
    register(t) {
      t.test('欲念 < 75 ⇒ 第 5 行「未竟」', () => {
        const e = finalEndingOf(finalDayLedger(DESIRE_WINDOW_MIN - 1), place(true));
        t.eq(e.row, 5);
        t.eq(e.name, '未竟');
        t.eq(e.day, TOTAL_DAYS);
      });

      t.test('欲念 > 80 ⇒ 第 6 行「沉溺」', () => {
        const e = finalEndingOf(finalDayLedger(DESIRE_WINDOW_MAX + 1), place(true));
        t.eq(e.row, 6);
        t.eq(e.name, '沉溺');
      });

      t.test('★ 窗口是**闭区间** [75, 80]：两个端点都必须放行到"成功那一步"', () => {
        // 端点若被排除，会静默变成"差一点点"—— 不报错，只是结局名不对。
        t.eq(finalEndingOf(finalDayLedger(DESIRE_WINDOW_MIN), place(true)).row, 8);
        t.eq(finalEndingOf(finalDayLedger(DESIRE_WINDOW_MAX), place(true)).row, 8);
      });

      // ⚠️⚠️ 2026-10-06 用户裁定（改）：「**欲念值只有门槛作用**」
      //   ⇒ 改前这里是「成果格空 ⇒ 第 7 行『空手』」（那是**第二把钥匙**）。
      //   ⇒ 那把钥匙**已撤掉**：欲念落在窗口内就是成功，**成果格空不判失败**。
      //   ⚠️ 判据的**意图**（"窗口内就该成功"）一字未动 —— 只是把
      //     **"成果格非空"这个额外条件**去掉，所以结果从"空手（失败）"
      //     变成"成功（风味由手段/共鸣决定）"。
      t.test('欲念在窗口内 ⇒ 成功（**成果格空不再是失败条件**）', () => {
        const e = finalEndingOf(finalDayLedger(77), place(false, { 手段: 'e1', 共鸣: 'npc001' }));
        t.eq(e.kind, '成功');
        t.eq(e.row, 8);
      });
      // ⚠️ 总表第 7 行（「空手」）**现在不可达**了 —— 那把钥匙已撤。
      //   ⇒ 断言它的**不可达**，比删掉断言更防回归（将来谁加回来会被这条抓住）。
      t.test('★ 第 7 行「空手」**已不可达**（成果格那把钥匙按裁定撤掉了）', () => {
        t.eq(finalEndingOf(finalDayLedger(77), place(false)).row, 8);
        t.eq(finalEndingOf(finalDayLedger(50), place(false)).row, 5);   // 欲念太低仍走第 5 行
        t.eq(finalEndingOf(finalDayLedger(90), place(false)).row, 6);   // 欲念太高仍走第 6 行
      });

      t.test('★ 优先级：欲念低于窗口 且 成果格空 ⇒ 走第 5 行（未竟），不是成功', () => {
        t.eq(finalEndingOf(finalDayLedger(50), place(false)).row, 5);
      });

      t.test('★ 优先级：欲念 > 80 且 成果格空 ⇒ 走第 6 行（沉溺），不是第 7 行', () => {
        t.eq(finalEndingOf(finalDayLedger(95), place(false)).row, 6);
      });

      t.test('两把钥匙都齐 ⇒ 第 8 行「成功」，且**话术留空**等 `ending` 写', () => {
        const e = finalEndingOf(finalDayLedger(77), place(true));
        t.eq(e.row, 8);
        t.eq(e.kind, '成功');
        t.eq(e.text, null, '★ 成功话术由 `ending`（LLM）写 —— 系统不得自己编一段');
      });

      // ⚠️⚠️ 2026-10-06 用户裁定：四档收敛成**两档** ——
      //   「正当的手段和他者的共鸣**都不缺**」⇒ A；「**缺任何一个（包括都缺）**」⇒ B。
      //   ⇒ 「有手段无共鸣」与「无手段有共鸣」**同档**（原 B 与原 C 合并）。
      t.test('★★ 风味只由「手段 / 共鸣 有没有同时放下」决定（两档 · 2026-10-06）', () => {
        t.eq(flavorOf(place(true)), 'A', '两个都不缺 ⇒ 得偿所愿');
        t.eq(flavorOf(place(true, { 共鸣: null })), 'B', '缺共鸣 ⇒ 差一步美满');
        t.eq(flavorOf(place(true, { 手段: null })), 'B', '★ 缺手段也是同一档（原 C 已并入 B）');
        t.eq(flavorOf(place(true, { 手段: null, 共鸣: null })), 'B', '★ 两个都缺仍是这一档');
      });

      t.test('★★ 风味名 = 用户给的两个（2026-10-06）', () => {
        t.deep([FLAVOR_NAMES.A, FLAVOR_NAMES.B], ['得偿所愿', '差一步美满']);
        t.eq(finalEndingOf(finalDayLedger(77), place(true, { 手段: null })).name, '差一步美满');
      });

      t.test('isFinalDay：只有走到第 28 天才放格子', () => {
        t.eq(isFinalDay(finalDayLedger(77)), true);
        const l = finalDayLedger(77);
        l.clock.day = 27;
        t.eq(isFinalDay(l), false);
      });
    },
  },

  {
    name: '★ 终局 · 写账本（`turn/ending.ts` · 单写者 · 原子）',
    register(t) {
      t.test('enterEnding：写定终局，**旧账本一个字节没动**', () => {
        const l = finalDayLedger(50);
        const after = enterEnding(l, finalEndingOf(l, place(true)), place(true));
        t.eq(l.ending, null, '旧账本不该被就地改');
        t.ok(after.ending !== null);
        t.eq(after.ending!.name, '未竟');
        t.eq(after.ending!.placements.成果, 'it001');
      });

      t.test('★ 中途暴毙（总表 1~4）**没有放格子这一步** ⇒ 三格全空', () => {
        const l = initialLedger();
        player(l).hp = 0;
        const after = enterEnding(l, instantEndingOf(l)!);
        t.deep(after.ending!.placements, { 成果: null, 手段: null, 共鸣: null });
      });

      t.test('terminateIfOver：未命中 ⇒ null（调用方照常继续）', () => {
        t.eq(terminateIfOver(initialLedger()), null);
      });

      t.test('terminateIfOver：命中 ⇒ 新账本带终局，旧账本不变', () => {
        const l = finalDayLedger(0);
        const after = terminateIfOver(l)!;
        t.eq(after.ending!.row, 3);
        t.eq(l.ending, null);
      });

      t.test('★ 单写者：已经结束过的账本**不重复判、不覆盖**', () => {
        const l = finalDayLedger(0);
        const done = terminateIfOver(l)!;
        t.eq(terminateIfOver(done), null, '第二次调用必须什么都不做');
      });

      t.test('closeGame：走满 28 天判成功 ⇒ 风味与放格子一起落账', () => {
        const after = closeGame(finalDayLedger(77), place(true, { 共鸣: null }));
        t.eq(after.ending!.row, 8);
        t.eq(after.ending!.flavor, 'B');
        t.eq(after.ending!.name, '差一步美满');
        // ⚠️ 2026-10-06：标题**也在这一刻写定**（两档），不必等 ending 侧链
        t.eq(after.ending!.title, '差一步美满', '★★ 标题当场有值（全屏动画靠它先出标题）');
        t.eq(after.ending!.placements.手段, 'e1');
      });

      t.test('★ closeGame 仍先兜一遍 1~4（"1~4 优先于 5~7"不依赖调用方）', () => {
        const l = finalDayLedger(77);
        player(l).san = 0;
        t.eq(closeGame(l, place(true)).ending!.row, 2);
      });
    },
  },

  {
    name: '★ 终局 · 放格子候选池与模拟器接线（第 28 天 → 结局）',
    register(t) {
      t.test('★ 三格**各自独立**：只有成果候选 ⇒ 手段 / 共鸣 留空（⇒ 两档里的 B）', () => {
        const l = finalDayLedger(77);
        l.events.live = []; // 没有"已记的事件"
        for (const p of l.entities.people) p.recognized = []; // 没有"给过认可的人"
        const p = autoPlace(l);
        t.ok(p.成果 !== null, '自己在账本里的物品 = 成果候选');
        t.eq(p.手段, null);
        t.eq(p.共鸣, null);
        t.eq(flavorOf(p), 'B', '★ 2026-10-06：两个都缺 ⇒ 差一步美满（原 D 已并入 B）');
      });

      t.test('★ 手段候选只认**已结算**的事件 —— 待处理的不算"已记的事件"', () => {
        const l = finalDayLedger(77);
        l.events.live = [makeEvent({ id: 'e900', title: '还没人管的事', status: '待处理' })];
        t.eq(autoPlace(l).手段, null);
        l.events.live = [makeEvent({ id: 'e901', title: '办完了的事', status: '已结算' })];
        t.eq(autoPlace(l).手段, 'e901');
      });

      t.test('共鸣候选来自「给过认可的人」（`recognized` 非空）', () => {
        const l = finalDayLedger(77);
        l.entities.people.find((p) => p.id === 'npc002')!.recognized = ['你懂他要什么'];
        t.eq(autoPlace(l).共鸣, 'npc002');
      });

      t.test('★ 端到端：28 天跑完**必须有一个结局**（这就是 Phase 4 的出口）', async () => {
        const r = await sim1();
        t.ok(r.ledger.ending !== null, '★ 走完 28 天却没有结局 —— 出口没接上');
        t.eq(r.ledger.ending!.day, TOTAL_DAYS, '没提前终结');
        t.ok(r.ledger.ending!.text !== null, '失败结局的话术必须由系统预写（0 调用）');
        t.ok(!r.ledger.ending!.text!.includes('〔N〕'), '插槽必须已填');
      });

      t.test('★ 端到端：覆盖率数组里「终局已判定」这条真的被走到（不是只写在代码里）', async () => {
        const r = await sim1();
        const c = r.coverage.find((x) => x.name.includes('终局已判定'))!;
        t.ok(c.ok, c.detail);
        t.ok(c.detail.includes('总表第'), c.detail);
        t.eq(r.violations.filter((v) => v.includes('命中终结条件')).length, 0, '逐次检查不许漏挂');
      });
    },
  },

  {
    name: '★ 终局 · 中途暴毙被驱动走一遍（覆盖率专用 · 总表 1~4 不等第 28 天）',
    register(t) {
      /**
       * ⚠️ 这一局**故意**被推了一把：第 `DRIVE_BREAK_DAY` 天把玩家 HP 打到 0。
       *
       * 夹具按顶栏假设 ② 不制造永久减员 ⇒ 三个基线种子**都不提前终结**；
       * 若把「逐次终结被走到」无条件写成覆盖率断言，它就是一条**永远假绿**的断言
       * （**断言存在 ≠ 路径被走到** —— 与 `forceSelf` / `neglected` 同族）。
       * ⇒ 它只在驱动打开时才进 `coverage`；而**驱动打开时它必须真的被走到**，本用例就是那条"必须"。
       */
      let cachedBreak: Promise<SimResult> | null = null;
      const simBreak = (): Promise<SimResult> =>
        (cachedBreak ??= simulate(1, TOTAL_DAYS, { driveInstantEnding: true }));

      t.test('★ 逐次检查**当场**收走它：终结日 = 驱动日，而不是拖到第 28 天', async () => {
        const r = await simBreak();
        t.ok(r.ledger.ending !== null, '★ 第 12 天 HP 已归零，却一路跑到第 28 天 —— 逐次检查没接上');
        t.eq(r.ledger.ending!.day, DRIVE_BREAK_DAY);
        t.eq(r.violations.filter((v) => v.includes('命中终结条件')).length, 0, '结构底线：命中即终结');
      });

      t.test('★ HP ≤ 0 ⇒ 总表第 1 行「陨命」，且话术的天数**当场**就填好了', async () => {
        const en = (await simBreak()).ledger.ending!;
        t.eq(en.row, 1);
        t.eq(en.name, '陨命');
        t.eq(en.kind, '失败');
        t.ok(en.text !== null && !en.text.includes('〔N〕'), '落账的必须是玩家会读到的那份');
      });

      t.test('★ 中途暴毙**没有放格子这一步** ⇒ 三格全空（不是"挑不到候选"，是"根本没轮到"）', async () => {
        const en = (await simBreak()).ledger.ending!;
        t.deep(en.placements, { 成果: null, 手段: null, 共鸣: null });
      });

      t.test('★ 驱动那条覆盖率被真的点亮（成对关系：驱动打开 ⇒ 路径必被走到）', async () => {
        const r = await simBreak();
        const c = r.coverage.find((x) => x.name.includes('逐次终结被走到'));
        t.ok(c !== undefined, '驱动打开时这条覆盖率必须存在');
        t.ok(c!.ok, c!.detail);
        t.ok(c!.detail.includes('第 12 天'), `详情应写明终结日：${c!.detail}`);
      });

      t.test('这一局 0 违规（提前终结把"28 天级"覆盖率换成"若走满"的前提，其余照旧）', async () => {
        const r = await simBreak();
        t.deep(r.violations, []);
      });

      t.test('★ 放行只对"被截断的局"生效：同一个种子走满 28 天，那条覆盖率照样必须达标', async () => {
        // 这条是**配对防线**：`过期结算走通` 对截断的局放行，前提是"走满的局仍然要它"。
        // 少了这条，放行就会慢慢退化成一条**永远假绿**的断言（"断言存在 ≠ 路径被走到"）。
        const full = await sim1();
        const c = full.coverage.find((x) => x.name.includes('过期结算走通'))!;
        t.ok(c.ok, `走满 28 天的局不许拿"日历不够"当借口：${c.detail}`);
        t.eq(full.ledger.ending!.day, TOTAL_DAYS, '前提：基线种子不得提前终结，否则上一条就没有意义');
      });
    },
  },
];
