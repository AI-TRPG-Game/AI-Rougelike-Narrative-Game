// P5-C · **玩家自建事件**（「我想做点什么」）
//
// 三层各管一段，本文件三层都钉住：
//   ① **落地层**（`turn/land-compose.ts` 的 `mode: 'create'`）—— 只认 1 条 canvas、
//      豁免条数检测、种子只核销不收口（与 `'day'` 那一套并排对照）；
//   ② **编排层**（`turn/create.ts`）—— 一次调用 ＋ 一次落地、不扣时间、单写者；
//   ③ **模拟器**（`SimOptions.driveCreate`）—— 覆盖率只在被驱动时才断言。
//
// ⚠️ 本文件**不测装配**（`assembleCreate` / `renderCreateUser` / `INSTRUCTION_CREATE`）：
//    那三样在 `test/prompt.test.ts` 里早就有 9 条断言钉着（P4 之前就写好了，
//    只是当时**除测试外零调用**）。P5-C 补的是**接线**，不是装配 —— 别在这里重测一遍。
//
// ⚠️ 三条"绿了但没测到"的高危区，各自都被下面一条断言对着：
//    · **只认 1 条**：模型多产时若照收，玩家敲一句话会凭空多出五件事；
//    · **豁免条数**：若照走 `FREE_EVENT_CAP` 循环，看起来"也没事"（1 ≤ 5），
//      但那说明两条路没有真的分岔 —— 所以要用**同一批 6 条**做对照实验；
//    · **种子只核销不收口**：收口的两个副作用（丢软种子 / 重复报 problems）
//      在"当天没有软种子"的普通局面下**完全看不出来**。
import type { Ledger, Seed } from '../ledger/types.ts';
import { fakeBrain } from '../fixtures/fake.ts';
import { initialLedger } from '../ledger/initial.ts';
import { FREE_EVENT_CAP } from '../schema/compose.ts';
import { createEvent } from '../turn/create.ts';
import { landCompose } from '../turn/land-compose.ts';
import { DRIVE_CREATE_DAY, DRIVE_CREATE_WORD, simulate } from '../turn/simulate.ts';
import type { Suite, T } from './harness.ts';

// ── 小工具 ────────────────────────────────────────────────────

/** 一条合法的 `canvas_event`（**原始形状**：本地编号 ＋ schema 的字段名，不是账本字段） */
function canvasRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'e1',
    title: '城郊立碑',
    seed_id: '',
    stage: '金庭',
    content: '他想去城郊给母亲立一块碑。',
    hint_attr: ['社交'],
    min_people: 1,
    max_people: 2,
    tier: 'B',
    cost: 2,
    min_gold: 0,
    deadline: 2,
    dispatchable: '两者皆可',
    ...over,
  };
}

/** 自建的原始输出（默认：1 条合法 canvas、档 A 空数组 —— 与指令的要求逐字一致） */
function rawCreate(canvases: unknown[] = [canvasRaw()], popups: unknown[] = []) {
  return { popup_events: popups, canvas_events: canvases };
}

/** 一条**在正文里**的账本（`day` 推到 3，免得用例断言里到处是 0） */
function ledgerAtDay3(): Ledger {
  const l = initialLedger();
  l.clock.day = 3;
  return l;
}

function seed(code: string, source: 'LLM' | '硬种子'): Seed {
  return { code, title: `${code} 的题目`, content: `${code} 的内容`, source };
}

/** 账本里某条种子还在不在 */
const hasSeed = (l: Ledger, code: string): boolean => l.seeds.some((s) => s.code === code);

// ══════════════════════════════════════════════════════════════
// ① 落地层
// ══════════════════════════════════════════════════════════════

const 落地层自建: Suite = {
  name: 'P5-C · 落地层 · `mode: "create"`',
  register(t: T) {
    t.test('★ 只认 1 条 canvas_event —— 多产的只取第 1 条（规则层是唯一防线）', () => {
      const l = ledgerAtDay3();
      const r = landCompose(
        l,
        rawCreate([canvasRaw({ id: 'e1', title: '第一件' }), canvasRaw({ id: 'e2', title: '第二件' })]),
        { mode: 'create' },
      );
      t.eq(r.live.length, 1, '自建只产 1 条）');
      t.eq(r.live[0].title, '第一件', '只认**第 1 条**，不是"随便留一条"');
      t.ok(
        r.log.some((x) => x.includes('只认第 1 条')),
        '多产要留一条哨兵日志 —— 不然"模型不听话"这件事没人看得见',
      );
    });

    t.test('★ 档 A 一律忽略 —— 玩家敲一句话不该凭空冒出一个强制弹窗', () => {
      const l = ledgerAtDay3();
      const popup = {
        id: 'e9',
        title: '一只乌鸦落在窗台上',
        seed_id: '',
        stage: '金庭',
        content: '（模型多产的档 A）',
        deadline: 1,
        options: [{ label: '看看', result_text: '（结果）', summary: '（概要）', delta: { ops: [] }, trigger: '', 欲向: '无关' }],
      };
      const r = landCompose(l, rawCreate([canvasRaw()], [popup]), { mode: 'create' });
      t.eq(r.live.length, 1, '产出的仍是那 1 条 canvas');
      t.eq(r.live[0].tier, 'B', '档 A 没有混进来');
      t.ok(
        !l.events.live.some((e) => e.tier === 'A'),
        '账本里一条档 A 都不许多 —— 档 A 会触发闸门 ④，等于把"当天必须先清弹窗"交给玩家自己按',
      );
      t.ok(r.log.some((x) => x.includes('档 A')), '忽略档 A 也要留日志');
    });

    t.test('★ 与 `"day"` 并排对照：同一批 6 条 canvas —— day 丢到 5、create 只留 1', () => {
      const many = Array.from({ length: 6 }, (_, i) => canvasRaw({ id: `e${i + 1}`, title: `第 ${i + 1} 件` }));

      const day = landCompose(ledgerAtDay3(), rawCreate(many), { mode: 'day' });
      t.eq(day.live.length, FREE_EVENT_CAP, `换日那条路照旧受条数硬顶（≤${FREE_EVENT_CAP}）`);
      t.ok(
        day.log.some((x) => x.includes(`自由事件 ≤${FREE_EVENT_CAP}`)),
        'day 那条路会报"超出条数"—— 这是对照组的证据',
      );

      const create = landCompose(ledgerAtDay3(), rawCreate(many), { mode: 'create' });
      t.eq(create.live.length, 1, '自建那条路**不进**条数循环 ⇒ 只会被"只认 1 条"收口');
      t.ok(
        !create.log.some((x) => x.includes('自由事件 ≤')),
        '★ 自建**豁免额度检测**⇒ 它的日志里不该出现条数铁律 —— ' +
          '出现了就说明两条路没有真的分岔',
      );
    });

    t.test('★ 默认 `"day"` —— 老调用点不传选项时行为逐字不变（拿真正的 T0 形状对照）', () => {
      const withOpt = landCompose(ledgerAtDay3(), rawCreate([canvasRaw()]), { mode: 'day' });
      const noOpt = landCompose(ledgerAtDay3(), rawCreate([canvasRaw()]));
      t.eq(noOpt.live.length, withOpt.live.length, '不传 `mode` ⇒ 与显式 `"day"` 逐字同构');
      t.eq(noOpt.log.length, withOpt.log.length, '日志条数也一样（没有多一句哨兵）');
    });

    t.test('★ 产物一律进 `live`，不进 `hidden`（canvas 没有 `options` ⇒ 不可能被 `trigger` 引用）', () => {
      const l = ledgerAtDay3();
      const r = landCompose(l, rawCreate(), { mode: 'create' });
      t.eq(r.hidden.length, 0, '自建没有隐藏事件这一说');
      t.ok(
        l.events.live.some((e) => e.title === '城郊立碑'),
        '事件真的进了池子（玩家马上就能在待办里看到它）',
      );
    });

    t.test('落地照旧认结构：`created_day` = 今天、档 B、`待处理`、`cost` 按挡位收口', () => {
      const l = ledgerAtDay3();
      const r = landCompose(l, rawCreate([canvasRaw({ cost: 6 })]), { mode: 'create' });
      const ev = r.live[0];
      t.eq(ev.created_day, 3, '生成日 = 今天（换日那条路也读同一个 `l.clock.day`）');
      t.eq(ev.tier, 'B', 'canvas 通道默认档 B');
      t.eq(ev.status, '待处理', '自建产出的是一条待办，不是已经发生的事');
      t.eq(ev.cost, 4, '`cost` 挡位只有 0/1/2/4 与 4 的倍数：6 不是挡位 ⇒ 收口到附近的 4');
    });

    t.test('地点：`stage` 写了个没注册过的名字 ⇒ 规则层照旧当场补登记', () => {
      const l = ledgerAtDay3();
      const before = l.entities.places.length;
      const r = landCompose(l, rawCreate([canvasRaw({ stage: '城郊' })]), { mode: 'create' });
      t.eq(l.entities.places.length, before + 1, '「城郊」不在预置 9 处里 ⇒ 补一个 loc 号');
      t.ok(r.live[0].location !== null, '补上之后 `location` 解析得到，不是 null');
    });

    t.test('模型什么都没产 ⇒ 不静默：一条事件都不进池，但留一句刺眼的日志', () => {
      const l = ledgerAtDay3();
      const r = landCompose(l, rawCreate([], []), { mode: 'create' });
      t.eq(r.live.length, 0, '没产出就是没产出（不替它编一条）');
      t.ok(
        r.log.some((x) => x.includes('没有事件进池')),
        '必须留一句"玩家敲了那句话，但什么也没发生" —— 静默会造出"本来就没这回事"的假象',
      );
    });
  },
};

// ══════════════════════════════════════════════════════════════
// ② 落地层的种子池：只核销、不收口
// ══════════════════════════════════════════════════════════════

const 种子收口: Suite = {
  name: 'P5-C · 落地层 · 种子池：自建只核销、不收口',
  register(t: T) {
    t.test('★ 自建承接一条软种子 ⇒ 只把**它**划掉，别的软种子一个都不许碰', () => {
      const l = ledgerAtDay3();
      l.seeds.push(seed('S1', 'LLM'), seed('S2', 'LLM'));
      const r = landCompose(l, rawCreate([canvasRaw({ seed_id: 'S1' })]), { mode: 'create' });
      t.ok(!hasSeed(l, 'S1'), 'S1 被承接 ⇒ 核销（声明式消费，与换日那条路同口径）');
      t.ok(
        hasSeed(l, 'S2'),
        '★ S2 必须**原样留着** —— "软种子当天作废"指的是"到本日 T0 为止"，' +
          '自建发生在白天，替它提前丢掉等于把 T0 刚生成的钩子作废',
      );
      t.ok(
        !r.log.some((x) => x.includes('软种子今天没人承接')),
        '没有"丢弃软种子"那句日志 —— 收口是 T0 那一次的事',
      );
    });

    t.test('★ 自建**不报**「硬种子没人承接」—— T0 已经报过，再报一次就是重复告警', () => {
      const l = ledgerAtDay3();
      l.seeds.push(seed('S1', '硬种子'));
      const r = landCompose(l, rawCreate(), { mode: 'create' });
      t.eq(r.problems.length, 0, '自建路径上 `problems` 恒为空');
      t.ok(hasSeed(l, 'S1'), '没人承接的硬种子照样留到明天（"必出"不能靠自觉）');
    });

    t.test('★★ 并排对照：同一局面走 `"day"` ⇒ 软种子被丢、硬种子报 problems', () => {
      // 对照组：这正是"收口"那两件事在 T0 该有的样子 —— 两相对照才证明自建**故意**少做了一半
      const l = ledgerAtDay3();
      l.seeds.push(seed('S1', 'LLM'), seed('S2', '硬种子'));
      const r = landCompose(l, rawCreate(), { mode: 'day' });
      t.ok(!hasSeed(l, 'S1'), 'day 那条路：没人承接的软种子当天丢弃（不跨天）');
      t.ok(hasSeed(l, 'S2'), 'day 那条路：硬种子留存');
      t.eq(r.problems.length, 1, 'day 那条路：硬种子没人承接 ⇒ 报进 `problems`（"必出"要有人管）');
    });
  },
};

// ══════════════════════════════════════════════════════════════
// ③ 编排层（turn/create.ts）
// ══════════════════════════════════════════════════════════════

const 编排层: Suite = {
  name: 'P5-C · 编排层 · `turn/create.ts`（一次调用 ＋ 一次落地）',
  register(t: T) {
    t.test('★ 合格原话 ⇒ 账本多一条待办，且**入参账本一个字节不动**（单写者）', async () => {
      const l = ledgerAtDay3();
      const beforeLive = l.events.live.length;
      const beforeDay = l.clock.day;
      const r = await createEvent(l, '我想去城郊给我母亲立一块碑', fakeBrain());

      t.eq(l.events.live.length, beforeLive, '旧账本不许被改（返回的是新账本）');
      t.eq(r.ledger.events.live.length, beforeLive + 1, '新账本多一条');
      t.eq(r.ledger.clock.day, beforeDay, '不翻日');
      t.eq(r.created.length, 1, '`created` 就是那条新事件');
      t.eq(r.created[0].status, '待处理', '它是待办，不是已发生的事');
    });

    t.test('★ **不扣玩家时间** —— 提名目不花时间，办它才花（设计口径）', async () => {
      const l = ledgerAtDay3();
      l.clock.usedToday = 1;
      const r = await createEvent(l, '我想去城郊替我母亲立一块碑', fakeBrain());
      t.eq(r.ledger.clock.usedToday, 1, '自建不推进时钟（扣时间的是将来处理它那一步）');
    });

    t.test('★ 原话**逐字**进账本（trim 之外一个字都不改）—— 它是玩家输入，不是系统文案', async () => {
      const l = ledgerAtDay3();
      const words = '我想去城郊给我母亲立一块碑';
      const r = await createEvent(l, `  ${words}  `, fakeBrain());
      t.ok(
        r.created[0].title.includes(words.slice(0, 6)),
        `事件标题取自原话（实得「${r.created[0].title}」）—— 证明这一条**确实是那句话**变成的`,
      );
      t.ok(r.log.some((x) => x.includes(words)), '日志里留着原话，排错时看得见玩家到底写了什么');
    });

    t.test('空原话 / 全空白 ⇒ 当场抛（不占口径：空题目连模型都没法做）', async () => {
      const l = ledgerAtDay3();
      t.rejects(() => createEvent(l, '', fakeBrain()), '非空');
      t.rejects(() => createEvent(l, '   \n  ', fakeBrain()), '非空');
    });

    t.test('★ 一次调用 ＋ 一次落地 —— `brain.createEvent` 走的是与生成半**同一个形状**的输出', async () => {
      const l = ledgerAtDay3();
      const brain = fakeBrain();
      let calls = 0;
      const spy = {
        ...brain,
        async createEvent(lg: Ledger, approach: string) {
          calls += 1;
          return brain.createEvent(lg, approach);
        },
      };
      await createEvent(l, '我想去城郊替我母亲立一块碑', spy);
      t.eq(calls, 1, '自建只调一次');
    });
  },
};

// ══════════════════════════════════════════════════════════════
// ④ 模拟器接线
// ══════════════════════════════════════════════════════════════

const 驱动接线: Suite = {
  name: 'P5-C · 28 天驱动（基线不自己开口 · 驱动局必被走到）',
  register(t: T) {
    t.test('★ 驱动局（`driveCreate`）⇒ 那条覆盖率被真的点亮 ＋ 0 违规', async () => {
      const r = await simulate(7, 28, { driveCreate: true });
      const cov = r.coverage.find((c) => c.name.includes('玩家自建被走到'));
      t.ok(cov, '驱动打开 ⇒ 那条覆盖率必须存在（不是"没断言就算过"）');
      t.ok(cov!.ok, `覆盖率必须达标（${cov!.detail}）`);
      t.eq(r.violations.length, 0, `驱动局 0 违规（实得 ${r.violations.slice(0, 3).join('；')}）`);
      t.ok(r.stats.createdByPlayer >= 1, '`createdByPlayer` 记下了这次自建（与 T0 的 `created` 分开计）');
    });

    t.test('★ 不驱动 ⇒ 覆盖率里**没有**那一条（不写无条件断言 = 不留一条永远假绿的断言）', async () => {
      const r = await simulate(7, 28, {});
      t.ok(
        !r.coverage.some((c) => c.name.includes('玩家自建被走到')),
        '基线局不该出现这条 —— 出现了就说明写了无条件断言，而标准 28 天没人会自己开口',
      );
      t.eq(r.stats.createdByPlayer, 0, '基线局自建 0 条');
    });

    t.test('★ 自建那条**真的被办过**（不只是"造出来放进池子"）—— 覆盖率的判据两段都要', async () => {
      const r = await simulate(7, 28, { driveCreate: true });
      const cov = r.coverage.find((c) => c.name.includes('玩家自建被走到'))!;
      t.ok(
        cov.detail.includes('已排布 1 条') || /已排布 [1-9]/.test(cov.detail),
        `自建的事件必须真的被排布过（实得「${cov.detail}」）`,
      );
    });

    t.test('驱动常量与驱动日对得上（驱动器不是"永远不触发"的死代码）', () => {
      t.eq(DRIVE_CREATE_DAY, 4, '自建驱动日 = 第 4 天（与 checkpoint 5 / 归并 7 / 暴毙 12 全部错开）');
      t.ok(DRIVE_CREATE_WORD.trim() !== '', '驱动那句话非空');
      t.ok(
        DRIVE_CREATE_WORD.includes('我想去'),
        '驱动那句话写成"打算怎么做"—— 不踩【边界】那条"我做到了 XX"',
      );
    });
  },
};

export const suites: Suite[] = [落地层自建, 种子收口, 编排层, 驱动接线];
