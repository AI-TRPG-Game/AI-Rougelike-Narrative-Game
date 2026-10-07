// 「入队 / 离队」通道（2026-09-22 落地）—— 用户裁定：**LLM 直接声明，走结算 Delta 的同一条通道**
//
// 背景：`affiliated`（语义 = 「是不是你的人」）此前**只有开局预设会写** ⇒ 开局 1 人 = 整局 1 人，
// 而它直接决定 `isAvailable` ⇒ 直接决定 X（`calcX` = 4 ＋ Σ 下属点数）。
// 2026-09-22 用户方案：不要把入队做成新机制，它**本来就是事件结算的一种结果** ——
// 加进 `entities.people[].affiliated` / `change[].affiliated` 即可（判别符仍 5 个）。
//
// 为什么单开一个套件：本项目吃过两次「**schema-only 假机制**」的亏（`dispatchable` / 旧 `race`、
// `identity` —— 字段只写在 schema 里、规则层一行没读）。这次要防的是**它的反面**：
// 「**代码-only**」—— 规则层通了，而模型压根不知道有这一格。所以这条链两面都钉：
//   ① 模型看得见：schema 两处都有、都进 `required`、`description` 真的写了「怎么样才算入队」；
//   ② 规则层真动手：validate 认得 → Batch 收得下（且不算空批）→ 账本布尔翻 → `isAvailable` 转真 → X 跟着涨。
//
// ⚠️ **本套件没覆盖到的**（明说，别当成已测）：
//   · 夹具 brain（`fakeComposeDay` / `fakeResolve`）**不产这一格** ⇒ 标准 28 天里恒「保持」，
//     端到端那一趟**没被走过**（与 `required_person` 同一个处境）。要用真链路走一遍，
//     得照 `driveArchive` / `driveCreate` 的先例加驱动 —— **待办里记着**。
//   · 「谁该入队」的**判断质量**属模型侧，测不了；这里只保证**通道不漏、语义不漂**。
import { applyDelta, commitBatch } from '../ledger/apply.ts';
import { batchIsEmpty, emptyBatch } from '../ledger/batch.ts';
import { initialLedger } from '../ledger/initial.ts';
import { PLAYER_ID, findPerson, isAvailable } from '../ledger/types.ts';
import { calcX } from '../rules/x.ts';
import { DELTA, PERSON } from '../schema/defs.ts';
import type { Suite } from './harness.ts';

const HIM = 'npc001';

/** 一条最小 change；`affiliated` 可选，好验「老数据」 */
function chg(who: string, affiliated?: string, hp = 0): Record<string, unknown> {
  const c: Record<string, unknown> = {
    who,
    hp,
    san: 0,
    attrs: [],
    in_your_eyes: '',
    openness: 0,
  };
  if (affiliated !== undefined) c.affiliated = affiliated;
  return { ops: [{ change: c }] };
}

/** 一个最小新人物（`@p1`）；`affiliated` 可选 */
function newPerson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '@p1',
    etype: 'person',
    name: '新来的',
    desc: '（正文）',
    race: '人类',
    basic: '',
    identity: '',
    attrs: { 争斗: 10, 敏捷: 10, 智慧: 10, 魅力: 10, 社交: 10, 感知: 10 },
    attr_bonus: [],
    in_your_eyes: '',
    openness: 10,
    items: [],
    ...over,
  };
}

/** 走一遍「唯一写入口」：applyDelta（只写批）→ commitBatch（批末落账） */
function run(l: ReturnType<typeof initialLedger>, raw: Record<string, unknown>, batchIn?: ReturnType<typeof emptyBatch>) {
  const b = batchIn ?? emptyBatch(l);
  const out = applyDelta(l, raw as never, {}, b);
  const c = commitBatch(l, b);
  return { out, batch: b, ledger: c.ledger, report: c.report };
}

export const suites: Suite[] = [
  {
    name: '「入队 / 离队」· 落地层（Delta → 账本 → X）',
    register(t) {
      t.test('★★ 起点：开局**只有皮普**算你的人 ⇒ X = 4（玩家）＋ 4（皮普）= 8', () => {
        const l = initialLedger();
        // ⚠️ 玩家自己（npc000）那格**也是 true** —— `makePerson` 的默认值 `?? true` 兜的。
        //    它**无害且必要**：`calcX` 跳过 PLAYER_ID（不算点数），而提示词层若要问玩家
        //    「他空闲吗」，该答「可行动」而不是「尚未入队」。⇒ 数人头必须**排除玩家**。
        const mine = l.entities.people.filter((p) => p.affiliated && p.id !== PLAYER_ID);
        t.eq(mine.length, 1, '除玩家自己外，预置 10 人里只有一个是你的人');
        t.eq(mine[0].name, '皮普', '而且是皮普 —— 国王 / 王储 / 大臣一律不是');
        t.eq(findPerson(l, PLAYER_ID)!.affiliated, true, '玩家自己那格是 true（`calcX` 跳过他，不折算点数）');
        t.eq(findPerson(l, HIM)!.affiliated, false, '国王不是你的下属（`initial.ts` 已修）');
        t.eq(isAvailable(findPerson(l, HIM)!, l, l.clock.day), false, '`isAvailable` 第一行就拦他');
        t.eq(calcX(l, l.clock.day).x, 8, 'X = 4 ＋ 4');
      });

      t.test('★★ `change.affiliated = 入队` ⇒ 账本布尔翻转 ＋ `isAvailable` 转真 ＋ **X 从 8 涨到 12**', () => {
        const l = initialLedger();
        const r = run(l, chg(HIM, '入队'));
        t.eq(r.out.drops.length, 0, '不许被丢弃');
        t.eq(findPerson(r.ledger, HIM)!.affiliated, true, '账本里变成布尔 true');
        t.eq(isAvailable(findPerson(r.ledger, HIM)!, r.ledger, r.ledger.clock.day), true, '从此可派遣');
        t.eq(calcX(r.ledger, r.ledger.clock.day).x, 12, 'X 是这条通道真正的出口');
      });

      t.test('★★ `离队` ⇒ 掉回去（**可逆**，不是一次性的单向门）', () => {
        const l = initialLedger();
        const r1 = run(l, chg(HIM, '入队'));
        t.eq(calcX(r1.ledger, r1.ledger.clock.day).x, 12);
        const r2 = run(r1.ledger, chg(HIM, '离队'));
        t.eq(findPerson(r2.ledger, HIM)!.affiliated, false, '又变回外人');
        t.eq(calcX(r2.ledger, r2.ledger.clock.day).x, 8, 'X 掉回 8');
      });

      t.test('★★ **老数据的形状**（没有这一格）⇒ 整条 change 照样生效、归属一动不动', () => {
        const l = initialLedger();
        // ⚠️ 这条断言用 hp −1 而不是 0：`foldChange` 写的是 `if (c.hp)` ——
        //    **0 是 falsy、本来就不会进批**，拿 0 当"其余字段照常生效"的证据会**假绿**。
        const r = run(l, chg(HIM, undefined, -1));
        t.eq(r.out.drops.length, 0, '⚠️ 缺这一格**不许**把整条 change 丢掉（那等于一次升级作废全部历史结算）');
        t.eq(r.out.batch.hp[HIM], -1, '其余字段照常进批');
        t.eq(r.batch.affiliated[HIM], undefined, '归属没被写入');
        t.eq(findPerson(r.ledger, HIM)!.affiliated, false, '账本纹丝不动');
      });

      t.test('★ 显式 `保持` 与「缺这一格」等价', () => {
        const l = initialLedger();
        const r = run(l, chg(HIM, '保持'));
        t.eq(r.batch.affiliated[HIM], undefined, '「保持」不许写进批');
        t.eq(findPerson(r.ledger, HIM)!.affiliated, false);
      });

      t.test('★★ 新建人物：`入队` ⇒ 落地即 true、**直接算进 X**；`不入队` / 缺失 ⇒ false', () => {
        const l = initialLedger();
        const b = emptyBatch(l);
        const r = run(l, { ops: [{ entities: { people: [newPerson({ affiliated: '入队' })] } }] }, b);
        const added = r.ledger.entities.people[r.ledger.entities.people.length - 1];
        t.eq(added.affiliated, true, '账本里是布尔（不是中文枚举原样塞进去）');
        t.eq(calcX(r.ledger, r.ledger.clock.day).x, 12, '他当场就有一份点数');

        for (const [label, over] of [
          ['不入队', { affiliated: '不入队' }],
          ['缺失', {}],
        ] as const) {
          const l2 = initialLedger();
          const r2 = run(l2, { ops: [{ entities: { people: [newPerson(over as Record<string, unknown>)] } }] });
          const a2 = r2.ledger.entities.people[r2.ledger.entities.people.length - 1];
          t.eq(a2.affiliated, false, `${label} ⇒ false`);
          t.eq(calcX(r2.ledger, r2.ledger.clock.day).x, 8, `${label} ⇒ X 不动`);
        }
      });

      t.test('★ 非法值 ⇒ 兜底成 `保持`/`不入队`，且**记一笔 fix**（不静默吞掉）', () => {
        const l = initialLedger();
        const r = run(l, chg(HIM, '当我的小弟'));
        t.ok(
          r.out.fixes.some((f) => f.path.includes('affiliated')),
          'fix 里得有它 —— 静默吞掉就再也发现不了模型在乱填',
        );
        t.eq(r.batch.affiliated[HIM], undefined, '非法值不许动手');
        t.eq(findPerson(r.ledger, HIM)!.affiliated, false);
      });

      t.test('★ 同批两次相反表态 ⇒ 以**最后一条**为准（覆盖型，与 `in_your_eyes` 同一条纪律）', () => {
        const l = initialLedger();
        const b = emptyBatch(l);
        applyDelta(l, chg(HIM, '入队') as never, {}, b);
        applyDelta(l, chg(HIM, '离队') as never, {}, b);
        t.eq(b.affiliated[HIM], false, '批内收敛为最后一条');
        const c = commitBatch(l, b);
        t.eq(findPerson(c.ledger, HIM)!.affiliated, false);
      });

      t.test('★★ `batchIsEmpty` 认得这一格 —— 只有归属变化的一批**不算空**', () => {
        const l = initialLedger();
        const b = emptyBatch(l);
        t.eq(batchIsEmpty(b), true, '空批');
        applyDelta(l, chg(HIM, '入队') as never, {}, b);
        t.eq(
          batchIsEmpty(b),
          false,
          '⚠️ 漏登记这一格 ⇒ 落盘会被短路跳过 ⇒ 归属变化**静默消失**（同类坑：`FIELD_TAGS` 漏 `pending`）',
        );
      });

      t.test('★ `commitBatch` 的 report 里有「入队」那一行（结算指令与调试都读它）', () => {
        const l = initialLedger();
        const name = findPerson(l, HIM)!.name;
        const r = run(l, chg(HIM, '入队'));
        t.ok(r.report.some((s) => s.includes(`${name} 入队`)), `report 里应见到「${name} 入队」`);
      });
    },
  },
  {
    name: '「入队 / 离队」· 协议层（schema 真的把它交给了模型）',
    register(t) {
      const anyOf = ((DELTA.properties as Record<string, never>).ops as unknown as Record<string, never>)
        .items as unknown as { anyOf: Array<Record<string, never>> };
      const change = (anyOf.anyOf[3] as unknown as { properties: Record<string, never> }).properties
        .change as unknown as {
        properties: Record<string, { enum?: string[]; description?: string }>;
        required: string[];
      };
      const person = PERSON as unknown as {
        properties: Record<string, { enum?: string[]; description?: string }>;
        required: string[];
      };

      t.test('★★ `change` 里有 `affiliated`：三态枚举 ＋ **进了 required**', () => {
        t.deep(change.properties.affiliated.enum, ['保持', '入队', '离队'], '必须是三态 —— 两态会逼模型每次表态');
        t.eq(change.required.includes('affiliated'), true, 'strict 模式：没进 required 等于模型不一定会填');
      });

      t.test('★★ `Person`（新建）里有 `affiliated`：两态 ＋ **进了 required**', () => {
        t.deep(person.properties.affiliated.enum, ['入队', '不入队']);
        t.eq(person.required.includes('affiliated'), true);
      });

      t.test('★★ 两处的 `description` 都真的写了「**怎么样才算入队**」', () => {
        const cd = String(change.properties.affiliated.description ?? '');
        const pd = String(person.properties.affiliated.description ?? '');
        t.ok(cd.length > 60, 'change 那条不能是一句空话');
        t.ok(pd.length > 60, 'Person 那条不能是一句空话');
        // 核心语义三条：① 与好感/亲近脱钩 ② 死亡离开走 lost ③ 别慷慨
        t.ok(cd.includes('好感'), '要写清「不是好感、不是关系变近」');
        t.ok(cd.includes('lost'), '要写清死亡 / 单纯离开走 `lost`');
        t.ok(pd.includes('国王'), '要写清「国王 / 大臣一律不入队」—— 这条 bug 刚修过');
      });
    },
  },
];
