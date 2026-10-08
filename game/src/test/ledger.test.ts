// 账本层：闸门 · 金币托管 · 唯一写入口 · id 分配 · 原子性
import { applyDelta, commitBatch } from '../ledger/apply.ts';
import { emptyBatch } from '../ledger/batch.ts';
import { clampGold, reportedCostOf, settleEscrow } from '../ledger/gold.ts';
import { initialLedger, makePerson } from '../ledger/initial.ts';
import { FIELD_TAGS, groupsWithTag, projectionPlan } from '../ledger/project.ts';
import { JsonFileStore } from '../ledger/store-json.ts';
import { MemoryStore } from '../ledger/store.ts';
import { PLAYER_ID, type Ledger } from '../ledger/types.ts';
import { CARRY_CAP, blocked, evalGates } from '../rules/gates.ts';
import { availableToday } from '../rules/x.ts';
import { makeRng, scriptedRng } from '../rules/rng.ts';
import { fakeBrain, makeEvent } from '../fixtures/fake.ts';
import { handleEvent } from '../turn/handle.ts';
import { restore } from '../turn/restore.ts';
import { dial, nextDay } from '../turn/time.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Suite } from './harness.ts';

function withEvent(cost = 2, minPeople = 1, maxPeople = 3): Ledger {
  const l = markAllInService(initialLedger());
  l.events.live.push(
    makeEvent({ id: 'e1', title: '测试事件', tier: 'B', cost, min_people: minPeople, max_people: maxPeople, min_gold: 3, created_day: 1 }),
  );
  return l;
}

/**
 * ⚠️ 2026-09-22（**世界数据变了，不是机制变了**）：`ledger/initial.ts` 现在只有**皮普**
 *    （`npc010`）在册 —— 用户裁定「难道国王等也是下属吗？」「当然只有皮普可以派遣」。
 *    而本文件里三个套件（闸门 / 时间轴 / 恢复）都拿 `npc001` / `npc002` 当「一个派得出去的
 *    下属」的**样本**。在册与否是**世界数据**，不是这些套件要测的机制（闸门判据 / 算揭分离 /
 *    医馆算术才是）⇒ 夹具自己把世界摆成「人都在册」，别去动机制。
 *    ⚠️ 真实开局的 `x` 是 `4 ＋ 4 = 8`（只有皮普），**不是 44** —— 那是另一笔账
 *    （28 天基线要不要跟着重推），不在这几个套件的射程里。
 */
function markAllInService(l: Ledger): Ledger {
  for (const p of l.entities.people) p.affiliated = true;
  return l;
}

export const suites: Suite[] = [
  {
    name: '闸门 9 条 · 《规则.md》§四 A',
    register(t) {
      t.test('判据：一律返回完整的 9 条（形状稳定，UI 与测试都靠它）', async () => {
        const r = evalGates({ ledger: withEvent(), today: 1, action: 'handle', eventId: 'e1', participants: ['npc001'] });
        t.eq(r.length, 9);
      });

      t.test('① 玩家当日时间用尽 ⇒ 禁止再排布；但**不拦**进入下一天（否则死锁）', async () => {
        const l = withEvent();
        l.clock.usedToday = 4;
        const r = blocked(evalGates({ ledger: l, today: 1, action: 'handle', eventId: 'e1', participants: ['npc001'] }));
        t.ok(r.some((g) => g.code === 'ACTION_POINTS'));
        const adv = blocked(evalGates({ ledger: l, today: 1, action: 'advanceDay' }));
        t.ok(!adv.some((g) => g.code === 'ACTION_POINTS'), '时间用尽后进下一天是唯一出路，不能被拦');
      });

      t.test('② 参与者当日剩余 < 档位（档位 4 要求当日未消耗）', async () => {
        const l = withEvent(4);
        l.actionPoints.byNpc['npc001'] = 2;
        const r = blocked(evalGates({ ledger: l, today: 1, action: 'handle', eventId: 'e1', participants: ['npc001'] }));
        t.ok(r.some((g) => g.code === 'PARTICIPANT_BUDGET'));
      });

      t.test('★ ② 跨天事件（cost > 4）：只要有剩余就能**启程**，不要求够做完', async () => {
        const l = withEvent(8, 1, 1);
        l.actionPoints.byNpc['npc001'] = 1; // 只剩 1 点，远不够 8
        const r = blocked(evalGates({ ledger: l, today: 1, action: 'handle', eventId: 'e1', participants: ['npc001'] }));
        t.ok(!r.some((g) => g.code === 'PARTICIPANT_BUDGET'), '跨天事件启程即扣光当日剩余，剩 1 点也能走');

        l.actionPoints.byNpc['npc001'] = 0;
        const r2 = blocked(evalGates({ ledger: l, today: 1, action: 'handle', eventId: 'e1', participants: ['npc001'] }));
        t.ok(r2.some((g) => g.code === 'PARTICIPANT_BUDGET'), '当天已无剩余 ⇒ 今天走不了');
      });

      t.test('★ 回归：玩家**不进** byNpc —— 闸门 ② 不得用幽灵计数卡玩家', async () => {
        // 旧实现：handleEvent 把玩家写进 byNpc，而翻日只重置非玩家 ⇒ 幽灵计数只减不增。
        // 表现：玩家亲自处理几次后被自己"余额不足"拦死，之后每天全空转（28 天冒烟里第 24~28 天）。
        const l = withEvent(2);
        l.actionPoints.byNpc[PLAYER_ID] = 0; // 幽灵记录
        l.clock.usedToday = 0; // 真实预算（归闸门 ① 管）
        const r = blocked(
          evalGates({ ledger: l, today: 1, action: 'handle', eventId: 'e1', participants: [PLAYER_ID] }),
        );
        t.ok(!r.some((g) => g.code === 'PARTICIPANT_BUDGET'), '玩家亲自不该被 byNpc 幽灵卡住');
      });

      t.test('③ 被指定者不可派遣（HP ≤ 1）', async () => {
        const l = withEvent();
        l.entities.people.find((p) => p.id === 'npc001')!.hp = 1;
        const r = blocked(evalGates({ ledger: l, today: 1, action: 'handle', eventId: 'e1', participants: ['npc001'] }));
        t.ok(r.some((g) => g.code === 'CANNOT_DISPATCH'));
      });

      t.test('★ ③ `dispatchable`（处理方式限制）两向都真的拦 —— 不是只写在 schema 里当提示词', async () => {
        // 坑的形状：`dispatchable` 曾**只存在于 schema**，规则层一行没读
        // ⇒「只能派人去」/「只能自己去」在实现里根本不存在（与旧 `race` / `identity` 同类）。
        const withMode = (mode: '两者皆可' | '仅亲自' | '仅派遣'): Ledger => {
          const l = withEvent(2, 1, 3);
          l.events.live.find((e) => e.id === 'e1')!.dispatchable = mode;
          return l;
        };
        const gateOf = (l: Ledger, who: string) =>
          blocked(evalGates({ ledger: l, today: 1, action: 'handle', eventId: 'e1', participants: [who] }));

        const selfOnly = withMode('仅亲自');
        t.ok(gateOf(selfOnly, 'npc001').some((g) => g.code === 'CANNOT_DISPATCH'), '「仅亲自」⇒ 不能派人');
        t.ok(!gateOf(selfOnly, PLAYER_ID).some((g) => g.code === 'CANNOT_DISPATCH'), '「仅亲自」⇒ 玩家本人可以');

        const dispatchOnly = withMode('仅派遣');
        t.ok(gateOf(dispatchOnly, PLAYER_ID).some((g) => g.code === 'CANNOT_DISPATCH'), '「仅派遣」⇒ 玩家本人去不了');
        t.ok(!gateOf(dispatchOnly, 'npc001').some((g) => g.code === 'CANNOT_DISPATCH'), '「仅派遣」⇒ 派人可以');

        const both = withMode('两者皆可');
        for (const who of [PLAYER_ID, 'npc001']) {
          t.ok(!gateOf(both, who).some((g) => g.code === 'CANNOT_DISPATCH'), `「两者皆可」⇒ ${who} 都行`);
        }

        // 两向都拦住时，理由必须点破方向（否则 UI 无法告诉玩家"为什么这人不让去"）
        t.ok(
          gateOf(selfOnly, 'npc001').some((g) => g.reason.includes('亲自')),
          '拦「仅亲自」的理由要说清是"限亲自"',
        );
        t.ok(
          gateOf(dispatchOnly, PLAYER_ID).some((g) => g.reason.includes('派遣')),
          '拦「仅派遣」的理由要说清是"限派遣"',
        );
      });

      t.test('④ 档 A 未清 ⇒ 禁止换日；⚠️ 2026-10-07 用户裁定「档 A 与常规事件同级」⇒ **不再拦 handle**', async () => {
        const l = withEvent();
        l.events.live.push(makeEvent({ id: 'e9', title: '强制弹窗', tier: 'A', cost: 0, created_day: 1 }));
        const r = blocked(evalGates({ ledger: l, today: 1, action: 'advanceDay', eventId: 'e1', participants: ['npc001'] }));
        t.ok(r.some((g) => g.code === 'POPUP_PENDING'), 'advanceDay 应被挡');
        const ok = blocked(evalGates({ ledger: l, today: 1, action: 'handle', eventId: 'e1', participants: ['npc001'] }));
        t.eq(ok.filter((g) => g.code === 'POPUP_PENDING').length, 0, '★ 排布不被档 A 拦（同级了）');
      });

      t.test('⑤ 携带位已满 ⇒ 拒绝装填', async () => {
        const l = withEvent();
        const items = Array.from({ length: CARRY_CAP + 1 }, (_, i) => `it${100 + i}`);
        const r = blocked(evalGates({ ledger: l, today: 1, action: 'handle', loadTo: 'npc001', loadItems: items }));
        t.ok(r.some((g) => g.code === 'CARRY_OR_HOLDER'));
      });

      t.test('⑥ 人数 < min_people ⇒ 禁止处理', async () => {
        const l = withEvent(2, 2, 3);
        const r = blocked(evalGates({ ledger: l, today: 1, action: 'handle', eventId: 'e1', participants: ['npc001'] }));
        t.ok(r.some((g) => g.code === 'MIN_PEOPLE'));
      });

      t.test('⑦ 人数 > max_people ⇒ 禁止再派人', async () => {
        const l = withEvent(2, 1, 1);
        const r = blocked(evalGates({ ledger: l, today: 1, action: 'handle', eventId: 'e1', participants: ['npc001', 'npc002'] }));
        t.ok(r.some((g) => g.code === 'MAX_PEOPLE'));
      });

      t.test('⑧ 时间还没走到 reveal_at ⇒ 不产出结果', async () => {
        const l = withEvent();
        l.clock = { day: 1, phase: '正文', chapter: 1, usedToday: 0 };
        const ev = l.events.live.find((e) => e.id === 'e1')!;
        ev.status = '揭晓待办';
        ev.started_at = { day: 1, used: 0 };
        ev.reveal_at = { day: 2, used: 0 };
        const r = blocked(evalGates({ ledger: l, today: 1, action: 'reveal', eventId: 'e1' }));
        t.ok(r.some((g) => g.code === 'NOT_REVEALED'));

        // 时间推到了 ⇒ 放行
        l.clock = { day: 2, phase: '正文', chapter: 1, usedToday: 0 };
        const ok = blocked(evalGates({ ledger: l, today: 2, action: 'reveal', eventId: 'e1' }));
        t.ok(!ok.some((g) => g.code === 'NOT_REVEALED'));
      });

      t.test('⑨ 应付金币 > 余额 ⇒ 禁止提交', async () => {
        const l = withEvent();
        l.scalars.gold = 1;
        const r = blocked(evalGates({ ledger: l, today: 1, action: 'handle', eventId: 'e1', participants: ['npc001'], goldToPay: 5 }));
        t.ok(r.some((g) => g.code === 'GOLD_INSUFFICIENT'));
      });

      t.test('全部条件满足时零拦截', async () => {
        const l = withEvent(2, 1, 3);
        l.scalars.gold = 10;
        const r = blocked(evalGates({ ledger: l, today: 1, action: 'handle', eventId: 'e1', participants: ['npc001'], goldToPay: 3 }));
        t.deep(r, []);
      });
    },
  },
  {
    name: '金币托管 · 《规则.md》§四 纪律 5',
    register(t) {
      t.test('实际消耗 ≤ P ⇒ 按实际扣、退回差额', async () => {
        t.deep(settleEscrow(5, 10), { consumed: 5, refund: 5, note: '实际消耗 5（上限 10）⇒ 退回 5' });
      });

      t.test('报告消耗 > P ⇒ 只扣 P（超出的部分不会发生）', async () => {
        const r = settleEscrow(20, 10);
        t.eq(r.consumed, 10);
        t.eq(r.refund, 0);
      });

      t.test('★ 回归：报告净值为正 ⇒ 全额退回 P 并另加利得（不是"全额退款式"bug）', async () => {
        const r = settleEscrow(0, 10);
        t.eq(r.consumed, 0);
        t.eq(r.refund, 10);
      });

      t.test('reportedCostOf：从原始 delta 里取 −gold', async () => {
        t.eq(reportedCostOf({ ops: [{ gold: -7 }] }), 7);
        t.eq(reportedCostOf({ ops: [{ gold: 3 }] }), 0, '净值非负 ⇒ 消耗 0');
        t.eq(reportedCostOf({ ops: [{ gold: -7 }, { gold: -2 }] }), 9);
        t.eq(reportedCostOf({ ops: [{ gold: -7, rep: { 善名: 1 } }] }), 7, '混键也要吃得住');
      });

      t.test('全局落账纪律：gold ≥ 0（净增不受上限）', async () => {
        t.eq(clampGold(-5), 0);
        t.eq(clampGold(0), 0);
        t.eq(clampGold(999999), 999999);
      });
    },
  },
  {
    name: '唯一写入口 · 拆键 / 校验 / 临时编号 先于 applyDelta',
    register(t) {
      t.test('★ entities 落地时分配正式 id，并按水位递增', async () => {
        const l = initialLedger();
        const batch = emptyBatch(l);
        const out = applyDelta(l, { ops: [{ entities: { people: [{ id: '@p1', name: '新人', desc: 'x', race: '人类', basic: '', identity: '', attrs: { 争斗: 10, 敏捷: 10, 智慧: 10, 魅力: 10, 社交: 10, 感知: 10 }, attr_bonus: [], in_your_eyes: '', openness: 10, items: [] }] } }] }, {}, batch);
        t.eq(batch.tempIds['@p1'], 'npc011', '水位从 npc010 之后开始');
        t.eq(batch.idWatermark.npc, 11);
        t.deep(out.tempIds, { '@p1': 'npc011' });
      });

      t.test('★ 同一批里同一临时编号重复出现 ⇒ 只落地一次', async () => {
        const l = initialLedger();
        const batch = emptyBatch(l);
        const person = { id: '@p1', name: '新人', desc: 'x', race: '人类', basic: '', identity: '', attrs: { 争斗: 10, 敏捷: 10, 智慧: 10, 魅力: 10, 社交: 10, 感知: 10 }, attr_bonus: [], in_your_eyes: '', openness: 10, items: [] };
        applyDelta(l, { ops: [{ entities: { people: [person] } }, { entities: { people: [person] } }] }, {}, batch);
        t.eq(batch.entities.people.length, 1);
        t.eq(batch.idWatermark.npc, 11, '水位只走一格');
      });

      t.test('change.who 用本批临时编号 ⇒ 被改写成正式 id', async () => {
        const l = initialLedger();
        const batch = emptyBatch(l);
        applyDelta(
          l,
          {
            ops: [
              { entities: { people: [{ id: '@p1', name: '新人', desc: 'x', race: '人类', basic: '', identity: '', attrs: { 争斗: 10, 敏捷: 10, 智慧: 10, 魅力: 10, 社交: 10, 感知: 10 }, attr_bonus: [], in_your_eyes: '', openness: 10, items: [] }] } },
              { change: { who: '@p1', hp: -1, san: 0, attrs: [], in_your_eyes: '', openness: 0 } },
            ],
          },
          {},
          batch,
        );
        t.eq(batch.hp['npc011'], -1, '临时编号应解析到正式 id');
      });

      t.test('change.who 用角色词「玩家」⇒ 解析到 npc000', async () => {
        const l = initialLedger();
        const batch = emptyBatch(l);
        applyDelta(l, { ops: [{ change: { who: '玩家', hp: -1, san: 0, attrs: [], in_your_eyes: '', openness: 0 } }] }, {}, batch);
        t.eq(batch.hp[PLAYER_ID], -1);
      });

      t.test('lost 引用不存在的 id ⇒ 记 error 且不落账', async () => {
        const l = initialLedger();
        const out = applyDelta(l, { ops: [{ lost: { items: ['it999'] } }] }, {}, emptyBatch(l));
        t.ok(out.errors.some((e) => e.includes('it999')));
      });

      t.test('批内只累加：同一 batch 跨两次 applyDelta', async () => {
        const l = initialLedger();
        const batch = emptyBatch(l);
        applyDelta(l, { ops: [{ gold: -3 }] }, {}, batch);
        applyDelta(l, { ops: [{ gold: 10 }] }, {}, batch);
        t.eq(batch.gold, 7);
      });

      t.test('★ 批末统一钳一次：批内先累加、不中途钳', async () => {
        const l = initialLedger();
        l.scalars.gold = 5;
        const batch = emptyBatch(l);
        applyDelta(l, { ops: [{ gold: -10 }] }, {}, batch);
        applyDelta(l, { ops: [{ gold: 3 }] }, {}, batch);
        const { ledger: after } = commitBatch(l, batch);
        t.eq(after.scalars.gold, 0, '5 − 10 + 3 = −2 ⇒ 批末钳到 0');
        t.eq(l.scalars.gold, 5, '★ 旧账本一个字节没动');
      });

      t.test('★ 覆盖型 in_your_eyes：同批多次 ⇒ 以最后一条为准', async () => {
        const l = initialLedger();
        const batch = emptyBatch(l);
        applyDelta(
          l,
          {
            ops: [
              { change: { who: 'npc001', hp: 0, san: 0, attrs: [], in_your_eyes: '第一条', openness: 0 } },
              { change: { who: 'npc001', hp: 0, san: 0, attrs: [], in_your_eyes: '第二条', openness: 0 } },
            ],
          },
          {},
          batch,
        );
        t.eq(batch.inYourEyes['npc001'], '第二条');
      });

      t.test('求和型 hp：同批多次相加', async () => {
        const l = initialLedger();
        const batch = emptyBatch(l);
        applyDelta(
          l,
          {
            ops: [
              { change: { who: 'npc001', hp: -1, san: 0, attrs: [], in_your_eyes: '', openness: 0 } },
              { change: { who: 'npc001', hp: -2, san: 0, attrs: [], in_your_eyes: '', openness: 0 } },
            ],
          },
          {},
          batch,
        );
        t.eq(batch.hp['npc001'], -3);
      });

      t.test('commitBatch 落账后 HP 钳在 [0,3]（HP=0 ⇒ 死亡，不再变成负数）', async () => {
        const l = initialLedger();
        const batch = emptyBatch(l);
        applyDelta(l, { ops: [{ change: { who: 'npc002', hp: -9, san: 0, attrs: [], in_your_eyes: '', openness: 0 } }] }, {}, batch);
        const { ledger: after } = commitBatch(l, batch);
        t.eq(after.entities.people.find((p) => p.id === 'npc002')!.hp, 0);
      });

      t.test('lost 人物 ⇒ 其随身物品回到「未携带」', async () => {
        const l = initialLedger();
        l.entities.items.push({ id: 'it002', etype: 'item', kind: '消耗品', name: '刀', desc: 'x', attr_bonus: [], holder: 'npc001', consumed: false });
        l.entities.people.find((p) => p.id === 'npc001')!.items = ['it002'];
        const batch = emptyBatch(l);
        applyDelta(l, { ops: [{ lost: { people: ['npc001'] } }] }, {}, batch);
        const { ledger: after } = commitBatch(l, batch);
        t.eq(after.entities.people.filter((p) => p.id === 'npc001').length, 0);
        t.eq(after.entities.items.find((i) => i.id === 'it002')!.holder, null);
      });

      t.test('欲念只做一道算术 + 钳制（**不再有任何"到某个数就触发什么"的档位**）', async () => {
        // ⚠️ 2026-10-05：这里原来断言「欲念首次达到 60 ⇒ 记 `reached60_day`」——
        //    `reached60_day` 与它服务的 `rewrite_desire` 侧链**已整条删掉**（命题一生只写一次）。
        //    ⇒ 同一段算术照旧要测（它仍是欲念唯一的落账路径），但**不再有跨 60 的副作用**。
        const l = initialLedger();
        l.clock.day = 6;
        l.desire.value = 55;
        const batch = emptyBatch(l);
        batch.desire = 8;
        const { ledger: after } = commitBatch(l, batch);
        t.eq(after.desire.value, 63, '55 + 8 = 63，落账照旧');
        t.eq(
          (after.desire as Record<string, unknown>).reached60_day,
          undefined,
          '★ 账本上不该再有 reached60_day 这个字段（旧存档读进来会是 undefined，正好不炸）',
        );
      });

      t.test('id 水位随批回写（单调递增、永不复用）', async () => {
        const l = initialLedger();
        const batch = emptyBatch(l);
        applyDelta(l, { ops: [{ entities: { items: [{ id: '@it1', name: 'x', desc: 'y', attr_bonus: [], holder: '' }] } }] }, {}, batch);
        const { ledger: after } = commitBatch(l, batch);
        t.eq(after.idWatermark.it, 3, '初始 it002 ⇒ 下一个 it003');
      });

      t.test('新建实体只追加、永不覆盖合并', async () => {
        const l = initialLedger();
        const before = l.entities.items.length;
        const batch = emptyBatch(l);
        applyDelta(l, { ops: [{ entities: { items: [{ id: '@it1', name: 'x', desc: 'y', attr_bonus: [], holder: '' }] } }] }, {}, batch);
        const { ledger: after } = commitBatch(l, batch);
        t.eq(after.entities.items.length, before + 1);
      });
    },
  },
  {
    name: '存储与原子性 · 《契约.md》§6.11 落盘与投影',
    register(t) {
      t.test('MemoryStore 往返 + 返回副本（外部改不动内部）', async () => {
        const s = new MemoryStore();
        t.eq(s.load(), null);
        const l = initialLedger();
        s.save(l);
        l.scalars.gold = 999;
        t.eq(s.load()!.scalars.gold, 0, '存的应是保存那一刻的快照');
      });

      t.test('JsonFileStore：临时文件 + rename，不留半份', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
        const file = path.join(dir, 'ledger.json');
        const s = new JsonFileStore(file);
        t.eq(s.load(), null);
        s.save(initialLedger());
        t.eq(s.load()!.clock.day, 0);
        t.eq(s.hasLeftoverTemp(), false, '正常路径不留 .tmp');
        fs.rmSync(dir, { recursive: true, force: true });
      });

      t.test('★ 落账失败不污染原账本：commitBatch 全程在克隆上做', async () => {
        const l = initialLedger();
        const snapshot = JSON.stringify(l);
        const batch = emptyBatch(l);
        applyDelta(l, { ops: [{ gold: -999 }] }, {}, batch);
        commitBatch(l, batch);
        t.eq(JSON.stringify(l), snapshot, '原始账本必须逐字不变');
      });

      t.test('每次 commitBatch 返回新对象（便于"要么全落要么全不落"）', async () => {
        const l = initialLedger();
        const batch = emptyBatch(l);
        const { ledger: a } = commitBatch(l, batch);
        t.ok(a !== l);
        t.eq(l.scalars.gold, 0);
      });
    },
  },
  {
    name: '新增人物的形状自检（防假数据本身写错）',
    register(t) {
      t.test('makePerson 的默认值完整', async () => {
        const p = makePerson({ id: 'npc099', name: '路人' });
        t.eq(p.etype, 'person');
        t.eq(p.hp, 3);
        t.eq(p.affiliated, true);
        t.eq(Object.keys(p.attrs).length, 6);
      });
    },
  },
  {
    name: '★ 时间轴集成 · 「算 / 揭」分离（排布 → 拨时针 → 揭晓）',
    register(t) {
      /** 第 1 天开局 + 一条 cost=2 的派遣事件 */
      function setup(cost = 2): Ledger {
        const l = markAllInService(initialLedger());
        l.clock = { day: 1, phase: '正文', chapter: 1, usedToday: 0 };
        l.events.live.push(
          makeEvent({ id: 'e1', title: '测试事件', tier: 'B', cost, min_people: 1, max_people: 3, min_gold: 0, deadline: 1, created_day: 1 }),
        );
        return l;
      }

      t.test('★ 判据：排布**不推进玩家时间**；结果算好但只进 pending、状态「揭晓待办」', async () => {
        const l = setup(2);
        const r = await handleEvent(l, { eventId: 'e1', participants: ['npc001'] }, makeRng(1), fakeBrain());
        t.eq(r.blockedBy.length, 0, '不该被闸门拦下');
        t.eq(r.ledger.clock.usedToday, 0, '排布不扣玩家时间 —— 时间只在 A/B/C 三处流动');
        t.eq(
          r.ledger.actionPoints.byNpc['npc001'],
          4,
          '★ 2026-10-08：排布**不即时扣容量** —— 时间流速口径，拨时间才扣',
        );
        t.eq(
          availableToday(r.ledger, r.ledger.entities.people.find((x) => x.id === 'npc001')!, 1),
          2,
          '★ 但今日已承诺 2 点（「一人一天 ≤ 4 点」由 availableToday 把关）',
        );
        const ev = r.ledger.events.live.find((e) => e.id === 'e1')!;
        t.eq(ev.status, '揭晓待办');
        t.deep(ev.started_at, { day: 1, used: 0 });
        t.deep(ev.reveal_at, { day: 1, used: 2 }, '揭晓时刻 = 排布时刻 + 处理时长');
        t.eq(r.ledger.pending.length, 1, '★ 结果已算好，但**只**存在于 pending');
        t.eq(l.pending.length, 0, '旧账本一个字节没动');
      });

      t.test('★ 时间没走到 ⇒ 不落账（pending 还在，状态不变）', async () => {
        const l = setup(2);
        const a = (await handleEvent(l, { eventId: 'e1', participants: ['npc001'] }, makeRng(1), fakeBrain())).ledger;
        const d = await dial(a, 1, makeRng(2), fakeBrain());
        t.eq(d.revealed.length, 0, '只拨 1 点，离 reveal_at（2 点）还差 1');
        t.eq(d.ledger.pending.length, 1);
        t.eq(d.ledger.events.live.find((e) => e.id === 'e1')!.status, '揭晓待办');
        t.eq(d.ledger.clock.usedToday, 1);
      });

      t.test('★ 时间走到 ⇒ 揭晓落账、pending 清空、状态「已结算」', async () => {
        const l = setup(2);
        const a = (await handleEvent(l, { eventId: 'e1', participants: ['npc001'] }, makeRng(1), fakeBrain())).ledger;
        const d = await dial(a, 2, makeRng(2), fakeBrain());
        t.eq(d.revealed.length, 1, '★ 走到第 2 点，正好揭晓');
        t.eq(d.ledger.pending.length, 0, 'pending 必须清空（否则"多出永远不会被兑现的结果"）');
        t.eq(d.ledger.events.live.find((e) => e.id === 'e1')!.status, '已结算');
      });

      t.test('★ 回归（2026-09-18 `--live` 实测）：托管金币**只扣一次** —— 揭晓须冲回 delta 的负向 gold', async () => {
        // 坑的形状：排布时扣掉托管上限 P = 2，揭晓时又把 delta 里的 `gold: −2` 记一遍
        // ⇒ 同一笔钱扣两次（8 → 4，应为 6）。夹具刻意照抄模型实产的形状：
        // 单对象 `change` + 独立 `gold` 负向 op + `goldInput` 恰好等于实花。
        const l = setup(2);
        l.scalars.gold = 8;
        l.events.live.find((e) => e.id === 'e1')!.min_gold = 2; // 让假 settle 真的报告一笔花销
        // 剧本骰（假 settle 会依次抽 4 个）：① `int(2) = 2` 报告的实花 = 2 = P
        //   ② `int(5) = 5` 避开那条混键 op　③ `int(3) = 3` 不产种子　④ `int(5) = 1` 欲向取「无关」
        const a = (
          await handleEvent(
            l,
            { eventId: 'e1', participants: ['npc001'], goldInput: 2 },
            makeRng(1),
            fakeBrain(scriptedRng([2, 5, 3, 1]), '直接失败'),
          )
        ).ledger;
        t.eq(a.scalars.gold, 6, '① 提交那一刻即扣 P = 2 —— 钱已离开账本、锁在事件里');
        t.eq(a.events.live.find((e) => e.id === 'e1')!.gold_locked, 2, '托管上限记在事件上');
        t.eq(
          reportedCostOf(a.pending[0].delta),
          2,
          '★ 前提：模型报告的实花正好 = 上限（否则这条测试测不到"两次相叠"）',
        );

        const d = await dial(a, 2, makeRng(2), fakeBrain());
        t.deep(d.revealed, ['e1']);
        t.eq(
          d.ledger.scalars.gold,
          6,
          '★ 净支出 = −min(实花 2, 上限 2) = 2 ⇒ 8 − 2 = 6（若冲回缺失，这里会是 4 —— 同一笔钱扣两次）',
        );
        t.eq(d.ledger.events.live.find((e) => e.id === 'e1')!.gold_locked, 0, '结清后托管归零');
      });

      t.test('★ 2026-10-08 排爆封顶：同一人今日已承诺 4 点 ⇒ 第三次排布被闸门②拦下', async () => {
        // 新模型下 byNpc 是**时间流速余额**（拨时间才掉），「一人一天 ≤ 4 点」的封顶
        // 全靠 `availableToday = byNpc ∩ (4 − committedToday)` 把关 —— 这条测试钉的就是它。
        const l = setup(2);
        l.events.live.push(
          makeEvent({ id: 'e2', title: '第二件事', tier: 'B', cost: 2, min_people: 1, max_people: 3, min_gold: 0, deadline: 1, created_day: 1 }),
          makeEvent({ id: 'e3', title: '第三件事', tier: 'B', cost: 2, min_people: 1, max_people: 3, min_gold: 0, deadline: 1, created_day: 1 }),
        );
        const a = (await handleEvent(l, { eventId: 'e1', participants: ['npc001'] }, makeRng(1), fakeBrain())).ledger;
        const r2 = await handleEvent(a, { eventId: 'e2', participants: ['npc001'] }, makeRng(1), fakeBrain());
        t.eq(r2.blockedBy.length, 0, '今日已承诺 2 点，再接 2 点的单子正好满额 ⇒ 放行');
        t.eq(
          availableToday(r2.ledger, r2.ledger.entities.people.find((x) => x.id === 'npc001')!, 1),
          0,
          '★ 4 − 已承诺 4 = 0：满了（byNpc 仍是 4 —— 排布不即时扣）',
        );
        t.eq(r2.ledger.actionPoints.byNpc['npc001'], 4, '流速余额没被排布动过');
        const r3 = await handleEvent(r2.ledger, { eventId: 'e3', participants: ['npc001'] }, makeRng(1), fakeBrain());
        t.ok(
          r3.blockedBy.some((g) => g.code === 'PARTICIPANT_BUDGET'),
          '★ 第三次排布被闸门②拦下（封顶由 availableToday 把关）',
        );
        t.eq(
          r3.ledger.events.live.find((e) => e.id === 'e3')!.status,
          '待处理',
          '被拦下 ⇒ e3 原样没动',
        );
      });

      t.test('★ 跨天：cost=8 的事件从第 1 天 0 点排布 ⇒ 第 2 天末尾揭晓', async () => {
        const l = setup(8);
        const a = (await handleEvent(l, { eventId: 'e1', participants: ['npc001'] }, makeRng(1), fakeBrain())).ledger;
        const ev = a.events.live.find((e) => e.id === 'e1')!;
        // ⚠️ 挡位只有 1 / 2 / 4 与 4 的倍数 —— 跨天就得是 8（**不存在 6**）
        t.deep(ev.reveal_at, { day: 2, used: 4 }, '{1,0} + 8 点 = 第 2 天末尾');
        t.eq(ev.depart_cost, 4, '跨天事件：记录主事者启程时的当日可接活点数（d=4）');
        t.eq(a.actionPoints.byNpc['npc001'], 4, '排布不即时扣容量（时间流速口径）');

        // 第 1 天拍满 4 点 —— 不该揭晓
        const d1 = await dial(a, 4, makeRng(2), fakeBrain());
        t.eq(d1.revealed.length, 0, '第 1 天末尾还不到 reveal_at');
        t.eq(d1.ledger.clock.day, 1, '拨时针**不跨天**');
        t.eq(d1.ledger.clock.usedToday, 4, '拍满一天');
        t.eq(
          d1.ledger.actionPoints.byNpc['npc001'],
          0,
          '★ 2026-10-08：拨满 4 点 ⇒ 全员（含在途者）容量随时间流走',
        );
        t.eq(
          d1.ledger.actionPoints.byNpc['npc002'],
          0,
          '★ 2026-10-08：闲置者容量也随拨钟流走（全员时间流速一致）',
        );
        t.rejects(async () => await dial(d1.ledger, 1, makeRng(9), fakeBrain()), '允许区间');

        // 跨天**只能**靠「进入下一天」——这是天界是硬墙的结构保证
        const nd = await nextDay(d1.ledger, makeRng(3), fakeBrain());
        t.eq(nd.ledger.clock.day, 2);
        t.eq(nd.ledger.clock.usedToday, 0);
        t.eq(nd.revealed.length, 0, '揭晓时刻是第 2 天第 4 点（末尾），进下一天只到 0 点');

        const d2 = await dial(nd.ledger, 4, makeRng(4), fakeBrain());
        t.eq(d2.revealed.length, 1, '第 2 天拍满 4 点 ⇒ 正好走到揭晓时刻');
        t.eq(d2.ledger.events.live.find((e) => e.id === 'e1')!.status, '已结算');
      });

      t.test('★ 拨时针粒度越界 ⇒ 抛错（不跨天、不超当天剩余）', async () => {
        const l = setup(2);
        t.rejects(async () => await dial(l, 5, makeRng(1), fakeBrain()), '允许区间');
        t.rejects(async () => await dial(l, 0, makeRng(1), fakeBrain()), '允许区间');
        const full = structuredClone(l);
        full.clock.usedToday = 4;
        t.rejects(async () => await dial(full, 1, makeRng(1), fakeBrain()), '允许区间');
      });

      t.test('★ 过期结算：没人处理 ⇒ 时间走过 expires_at 就按「忽略」结一次账', async () => {
        const l = setup(2); // deadline 1（**天**）⇒ 过期时刻 = 第 1 天末尾
        const d = await dial(l, 4, makeRng(1), fakeBrain());
        t.deep(d.expired, ['e1'], '★ 过期路径必须真的被走到（不做这个断言就是"绿了但没测到"）');
        t.eq(
          d.ledger.events.live.find((e) => e.id === 'e1')!.status,
          '已结算',
          '★ 过期 ⇒ 直接是「已结算」；账本里**没有**第二个终态',
        );
        t.ok(
          d.ledger.summaries.recent.some((r) => r.text.includes('无人处理')),
          '★ 过期也要留一条概要 —— 这样"没人管的事"在结算侧才看得见（此前它对 resolve 完全隐形）',
        );
        t.ok(
          !d.ledger.seeds.some((s) => s.content.includes('事件已过期')),
          '★ 过期**不再转种子**（2026-09-18 用户裁定）',
        );

        const early = await dial(l, 3, makeRng(1), fakeBrain());
        t.eq(early.ledger.events.live.find((e) => e.id === 'e1')!.status, '待处理', '差 1 点就还不算过期');
      });

      t.test('★ 过期：档 A **永不过期**（放着不动也不结算）', async () => {
        const l = initialLedger();
        l.clock = { day: 1, phase: '正文', chapter: 1, usedToday: 0 };
        l.events.live.push(
          makeEvent({ id: 'a1', title: '弹窗', tier: 'A', cost: 0, deadline: 1, created_day: 1 }),
        );
        const d = await dial(l, 4, makeRng(1), fakeBrain());
        t.eq(d.expired.length, 0);
        t.eq(d.ledger.events.live.find((e) => e.id === 'a1')!.status, '待处理');
      });

      // ⚠️ 路径 A（场景穿越）的三条断言**已迁到 `scene.test.ts`**（2026-09-19）。
      //    原因：Phase 1 的 `crossScene()` 只做"时间语义"（按 `cost` 推进时钟），
      //    而路径 A 的完整语义是**多轮往返循环** —— 它现在住在 `turn/scene.ts`。
      //    把断言留在旧入口，等于让一条已被删掉的实现继续"通过"。
    },
  },
  {
    name: '★ 防剧透 · 预计算结果（pending）绝不进 prompt',
    register(t) {
      t.test('★ pending 组必须标「永不」—— 这是「算 / 揭分离」的结构底线', async () => {
        t.eq(FIELD_TAGS.pending, '永不');
        t.ok(groupsWithTag('永不').includes('pending'));
        t.ok(!projectionPlan().user3.includes('pending'), '★ 绝不能随 events 一起注入');
        t.ok(!projectionPlan().system1.includes('pending'));
      });

      t.test('★ 回归：排布后那一刻，事件进的是「揭晓待办」而结果只在 pending 里', async () => {
        const l = markAllInService(initialLedger());
        l.clock = { day: 1, phase: '正文', chapter: 1, usedToday: 0 };
        l.events.live.push(
          makeEvent({ id: 'e1', title: '测试事件', tier: 'B', cost: 2, min_people: 1, max_people: 3, deadline: 1, created_day: 1 }),
        );
        const r = await handleEvent(l, { eventId: 'e1', participants: ['npc001'] }, makeRng(1), fakeBrain());
        // "别剧透"不是靠纪律：所有未被揭晓的结果**只**存在于 pending 这一组
        t.eq(r.ledger.pending.length, 1);
        t.eq(r.ledger.summaries.recent.length, 0, '摘要还没落账（它是揭晓时才写的）');
        t.eq(r.ledger.seeds.length, 0, '后续种子还没落账');
      });
    },
  },

  {
    /**
     * ⚠️ **`FIELD_TAGS` 的运行时完整性守卫**（2026-09-20 补）。
     *
     * 那个 `Record<keyof Ledger, InjectTag>` 注解**看起来**有类型保护，但本仓的 Node
     * 只做 type stripping、**不做类型检查** ⇒ 账本加了字段而这张表漏一行，**不会有任何人告诉你**。
     * 2026-09-20 实测就抓到一次：`repMarks`（P4-E 硬种子 checkpoint 的出种记账）是账本顶层字段，
     * 表里却一条都没有 ⇒ 它在四个组里**全查不到**，`projectionPlan().never` 也不列它。
     * 漏一条的后果不是崩溃，是**静默** —— 正是本仓反复踩的那一类。
     * ⚠️ 现状说明（别误读成"正在泄漏"）：`projectionPlan()` 目前**只被测试用**，
     *    真实拼装还没接这张表（`project.ts` 顶栏写着"Phase 1 只定形状"）⇒ 这次是**潜伏**缺陷。
     *    但等 Phase 2 真的按表拼 prompt 时，漏项就会变成真的泄漏口。
     * ⇒ 把它变成**断言**，而不是靠"记得同步"。
     */
    name: '★ 账本字段组表（FIELD_TAGS）必须与账本顶层字段一一对应',
    register(t) {
      t.test('★ 一一对应 —— 表里少一条、多一条都要红（不是"大致覆盖"）', () => {
        t.deep(
          Object.keys(FIELD_TAGS).sort(),
          Object.keys(initialLedger()).sort(),
          '★ 差集一旦非空，就会有字段**不属于任何一组**：该"永不"的可能泄漏进 prompt、' +
            '该"③"的可能永远不注入 —— 而且不会有任何报错',
        );
      });

      t.test('★ `repMarks` 必须是「永不」—— 它是出种记账，不是给模型看的内容', () => {
        t.eq(FIELD_TAGS.repMarks, '永不');
        t.ok(groupsWithTag('永不').includes('repMarks'));
        t.ok(!projectionPlan().user3.includes('repMarks'), '★ 绝不随 ③ 注入');
        t.ok(!projectionPlan().system1.includes('repMarks'));
      });

      t.test('四个标签的并集 = 全表（没有字段落在四组之外，也没有标签名写错）', () => {
        const union = new Set([
          ...groupsWithTag('①'),
          ...groupsWithTag('③'),
          ...groupsWithTag('派生'),
          ...groupsWithTag('永不'),
        ]);
        t.deep([...union].sort(), Object.keys(FIELD_TAGS).sort(), '并集必须等于全表');
      });
    },
  },

  {
    name: '恢复入口 · 医馆 / 大神殿',
    register(t) {
      function wounded(): Ledger {
        const l = markAllInService(initialLedger());
        l.clock = { day: 1, phase: '正文', chapter: 1, usedToday: 0 };
        l.scalars.gold = 10;
        return l;
      }
      const hpOf = (l: Ledger, id: string): number => l.entities.people.find((x) => x.id === id)!.hp;
      const sanOf = (l: Ledger, id: string): number => l.entities.people.find((x) => x.id === id)!.san;

      t.test('★ 医馆疗伤：提交＝排布（扣 1 金、占 3 点容量、立「处理中」事件）；**拨针到点才回满**', async () => {
        const l = wounded();
        l.entities.people.find((x) => x.id === 'npc001')!.hp = 1;
        const r = await restore(l, { place: '医馆', targets: ['npc001'] }, makeRng(1), fakeBrain());
        t.deep(r.rejected, []);
        t.eq(r.cost, 1);
        // ⚠️ 2026-10-07 用户裁定（第十五批）：恢复**延迟生效** —— 提交只排布
        t.eq(hpOf(r.ledger, 'npc001'), 1, '提交那一刻还没回满（要到点）');
        t.eq(r.ledger.scalars.gold, 9, '诊金提交即扣');
        t.eq(r.ledger.actionPoints.byNpc['npc001'], 4, '★ 2026-10-08：医治不即时扣 byNpc（时间流速口径）');
        t.eq(
          availableToday(r.ledger, r.ledger.entities.people.find((x) => x.id === 'npc001')!, 1),
          1,
          '★ 但今日已承诺 3 点（医治占用被治疗者的当日额度）',
        );
        const ev = r.ledger.events.live.at(-1)!;
        t.eq(ev.title, '医馆 · 疗伤');
        t.eq(ev.status, '揭晓待办', '合成事件直接进「处理中」');
        t.eq(ev.reveal_at!.day, 1);
        t.eq(ev.reveal_at!.used, 3);
        // 拨针到点 ⇒ 揭晓（走唯一通道 revealDue）⇒ 回满 ＋ 固定表述进概要
        const t2 = await dial(r.ledger, 3, makeRng(2), fakeBrain());
        t.eq(hpOf(t2.ledger, 'npc001'), 3, '到点回满到 3');
        t.eq(t2.ledger.events.live.at(-1)!.status, '已结算');
        t.eq(hpOf(l, 'npc001'), 1, '旧账本一个字节没动');
        t.eq(r.time, null, '治下属不动玩家时钟');
      });

      t.test('★ 神殿净化：3 金 · 占 2 点 · 拨针 2 点后 SAN 回满（2026-10-07 新口径）', async () => {
        const l = wounded();
        l.entities.people.find((x) => x.id === 'npc001')!.san = 1;
        const r = await restore(l, { place: '大神殿', targets: ['npc001'] }, makeRng(1), fakeBrain());
        t.deep(r.rejected, []);
        t.eq(r.cost, 3, '3 金');
        t.eq(sanOf(r.ledger, 'npc001'), 1, '提交还没生效');
        t.eq(r.ledger.scalars.gold, 7, '10 − 3');
        t.eq(r.ledger.actionPoints.byNpc['npc001'], 4, '医治不即时扣 byNpc（时间流速口径）');
        t.eq(
          availableToday(r.ledger, r.ledger.entities.people.find((x) => x.id === 'npc001')!, 1),
          2,
          '今日已承诺 2 点',
        );
        const t2 = await dial(r.ledger, 2, makeRng(2), fakeBrain());
        t.eq(sanOf(t2.ledger, 'npc001'), 3, '到点回满到 3');
      });

      t.test('★ 固定表述进【已处理概要】—— 揭晓那一刻才写（延迟模型）', async () => {
        const l = wounded();
        const p1 = l.entities.people.find((x) => x.id === 'npc001')!;
        p1.hp = 1;
        const r = await restore(l, { place: '医馆', targets: ['npc001'] }, makeRng(1), fakeBrain());
        t.ok(
          !r.ledger.summaries.recent.some((x) => x.text.includes('医馆治疗')),
          '提交那一刻**不写**概要（事情还没发生）',
        );
        const t2 = await dial(r.ledger, 3, makeRng(2), fakeBrain());
        const last = t2.ledger.summaries.recent.at(-1)!;
        t.eq(last.day, 1);
        t.eq(last.text, `玩家在医馆治疗了${p1.name}，${p1.name}的身体已经恢复`);
        // 神殿那条：把同一个人的 SAN 打下来再净化一次（拨针 3 点后容量只剩 4−3=1、
        // 当天读数也拨回早上 —— 不摆回去就拨不出神殿那 2 点；医馆那单已结清、不占承诺）
        const l2 = structuredClone(t2.ledger);
        l2.entities.people.find((x) => x.id === 'npc001')!.san = 1;
        l2.actionPoints.byNpc = { ...l2.actionPoints.byNpc, npc001: 4 };
        l2.clock.usedToday = 0;
        const r2 = await restore(l2, { place: '大神殿', targets: ['npc001'] }, makeRng(1), fakeBrain());
        t.deep(r2.rejected, [], `神殿净化应成功：${r2.rejected.join('；')}`);
        const t3 = await dial(r2.ledger, 2, makeRng(3), fakeBrain());
        t.eq(t3.ledger.summaries.recent.at(-1)!.text, `玩家在神殿净化了${p1.name}，${p1.name}的精神已经恢复`);
      });

      t.test('★ 同一人还有一单在办 ⇒ 不收第二单（延迟模型新增守卫）', async () => {
        const l = wounded();
        l.entities.people.find((x) => x.id === 'npc001')!.hp = 1;
        const r = await restore(l, { place: '医馆', targets: ['npc001'] }, makeRng(1), fakeBrain());
        t.deep(r.rejected, []);
        const r2 = await restore(r.ledger, { place: '医馆', targets: ['npc001'] }, makeRng(2), fakeBrain());
        t.ok(r2.rejected.some((s) => s.includes('还有一单')), `要明确拒绝：${r2.rejected.join('；')}`);
        t.eq(r2.ledger.scalars.gold, 9, '一个铜板没多扣');
      });

      t.test('已满 ⇒ 不需要治疗（收钱却不发生任何事 = 白抢钱）', async () => {
        const l = wounded();
        l.entities.people.find((x) => x.id === 'npc001')!.hp = 3;
        const r = await restore(l, { place: '医馆', targets: ['npc001'] }, makeRng(1), fakeBrain());
        t.ok(r.rejected.some((s) => s.includes('不需要治疗')), '要明确拒绝');
        t.eq(r.ledger.scalars.gold, 10, '一个铜板没动');
      });

      t.test('HP = 0（死亡 / 永久疯狂）⇒ 不可治疗，整批不落账', async () => {
        const l = wounded();
        l.entities.people.find((x) => x.id === 'npc001')!.hp = 0;
        const r = await restore(l, { place: '医馆', targets: ['npc001'] }, makeRng(1), fakeBrain());
        t.ok(r.rejected.some((s) => s.includes('不可治疗')), '要明确拒绝');
        t.eq(r.ledger.scalars.gold, 10);
        t.eq(hpOf(r.ledger, 'npc001'), 0);
      });

      t.test('金币不足 ⇒ 置灰', async () => {
        const l = wounded();
        l.scalars.gold = 0;
        l.entities.people.find((x) => x.id === 'npc001')!.hp = 1;
        const r = await restore(l, { place: '医馆', targets: ['npc001'] }, makeRng(1), fakeBrain());
        t.ok(r.rejected.some((s) => s.includes('余额')));
        t.eq(hpOf(r.ledger, 'npc001'), 1);
      });

      t.test('被治疗者当日剩余 < 所需点数 ⇒ 置灰（医馆要 3 点）', async () => {
        const l = wounded();
        l.actionPoints.byNpc['npc001'] = 2;
        l.entities.people.find((x) => x.id === 'npc001')!.hp = 1;
        const r = await restore(l, { place: '医馆', targets: ['npc001'] }, makeRng(1), fakeBrain());
        t.ok(r.rejected.some((s) => s.includes('置灰')));
      });

      t.test('★ 固定只放一个人（2026-10-07 用户裁定）', async () => {
        const l = wounded();
        l.entities.people.find((x) => x.id === 'npc001')!.hp = 1;
        l.entities.people.find((x) => x.id === 'npc002')!.hp = 1;
        const r = await restore(
          l,
          { place: '医馆', targets: ['npc001', 'npc002'] },
          makeRng(1),
          fakeBrain(),
        );
        t.ok(r.rejected.some((s) => s.includes('至多 1 人')), `要明确拒绝：${r.rejected.join('；')}`);
        t.eq(r.ledger.scalars.gold, 10);
      });

      t.test('★ 玩家本人被治疗 ⇒ 不再当场推时间（延迟模型）：拨针 3 点后才回满', async () => {
        const l = wounded();
        l.entities.people.find((x) => x.id === PLAYER_ID)!.hp = 1;
        const r = await restore(l, { place: '医馆', targets: [PLAYER_ID] }, makeRng(1), fakeBrain());
        t.deep(r.rejected, []);
        t.eq(hpOf(r.ledger, PLAYER_ID), 1, '提交还没生效');
        t.eq(r.ledger.clock.usedToday, 0, '时间**不**当场流过 —— 由玩家自己拨');
        t.eq(r.ledger.actionPoints.byNpc[PLAYER_ID], undefined, '玩家永不进 byNpc');
        const t2 = await dial(r.ledger, 3, makeRng(2), fakeBrain());
        t.eq(hpOf(t2.ledger, PLAYER_ID), 3, '拨针到点回满');
        t.eq(t2.ledger.clock.usedToday, 3, '时间真的流过了 3 点');
      });
    },
  },
];
