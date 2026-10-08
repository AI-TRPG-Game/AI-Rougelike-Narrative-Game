// 多轮「穿越」状态机
//
// ⚠️ 这一族的断言**刻意不用通用夹具 `fakeBrain()`**（它只负责把"末轮自行收束"这条最省钱的
//    支路默认走到）。场景的两条边界分支 —— **轮数用尽**与**末轮自行收束** —— 是"运气测不到"
//    的典型：夹具行为一改，它们要么永远走不到、要么把每次跑到的轮数变成掷骰子。
//    ⇒ 这里自带一个**可控的场景 brain**（`sceneBrain`），把每一条分支**明着走一遍**。
//
// ⚠️⚠️ 2026-10-07 用户裁定：**场景内不做投掷判定** ⇒ 每轮只有一次 `sceneTurn` 调用，
//    没有裁定半、没有档位 —— 原来的"下界 n / 上界 2n"调用算术随之作废（一轮恒 1 次）。
import fs from 'node:fs';
import path from 'node:path';

import { makeEvent } from '../fixtures/fake.ts';
import { initialLedger } from '../ledger/initial.ts';
import type { GameEvent, Ledger } from '../ledger/types.ts';
import { makeRng } from '../rules/rng.ts';
import { SCENE_ROUND_CAP } from '../rules/scene.ts';
import type { Brain, RawEndingOutput, RawArchiveOutput, RawChapterShiftOutput, RawComposeOutput, RawResolution } from '../turn/brain.ts';
import { openScene, sceneLeave, sceneStep } from '../turn/scene.ts';
import type { Suite } from './harness.ts';

function sceneLedger(cost = 3, extra: Partial<GameEvent> = {}): Ledger {
  const l = initialLedger();
  l.clock = { day: 1, phase: '正文', chapter: 1, usedToday: 0 };
  l.events.live.push(
    makeEvent({
      id: 'e1',
      title: '测试事件',
      tier: 'C',
      cost,
      min_people: 1,
      max_people: 3,
      min_gold: 0,
      deadline: 4,
      created_day: 1,
      ...extra,
    }),
  );
  return l;
}

interface SceneBrainOpts {
  /** 第几轮起 `scene_over=true`（并一并填好 `summary`）；`null` = **永不**自行收束 */
  sceneOverAt: number | null;
  /** 每轮回调里报告的**金币花销**（正数；0 = 不花钱） */
  spendPerRound?: number;
}

/**
 * 可控的场景 brain —— 每个方法都把**调用点**记进 `calls`，断言直接查它。
 *
 * ⚠️ 判据用"调用了哪几次"而不是"拿到了什么值"：值可以巧合相等（我在 `prompt.test.ts`
 *    吃过一次假绿），而"少一次 / 多一次调用"是**成本**上的硬事实 —— 多轮正是全场
 *    调用最密集的一处，这里才是它真正的验收面。
 */
function sceneBrain(o: SceneBrainOpts): Brain & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,

    // 单轮那条链一次都不该被走到 —— 走到这里说明状态机接错了入口
    async adjudicate() {
      throw new Error('多轮用例不该调单轮 `adjudicate`');
    },
    async settle() {
      throw new Error('多轮用例不该调单轮 `settle`');
    },
    // 收尾之后会 `pushTime(cost)` ⇒ 跨天时 T0 会问一次；给个**良性**空结果，
    // 而不是抛错（抛错会把"跨天"这条断言炸掉，而它要验的根本不是 T0）
    async ignore() {
      return { narration: '', delta: { ops: [] }, summary: '', next_seeds: [], 欲向: '无关' as const };
    },
    async composeDay(): Promise<RawComposeOutput> {
      return { popup_events: [], canvas_events: [] };
    },
    async createEvent(): Promise<RawComposeOutput> {
      return { popup_events: [], canvas_events: [] };
    },
    async chapterShift(): Promise<RawChapterShiftOutput> {
      return { 章节欲念变化: 0, 章节氛围: '（假氛围）' };
    },
    async archive(): Promise<RawArchiveOutput> {
      return { 归档段: '（假归档段）' };
    },
    async ending(): Promise<RawEndingOutput> {
      return { 结局判词: '（假判词）' };
    },

    async sceneTurn(_ev, _l, h, view, conv) {
      calls.push(`叙事:${view.round}`);
      const spend = o.spendPerRound ?? 0;
      const over = o.sceneOverAt !== null && view.round >= o.sceneOverAt;
      const value: RawResolution = {
        narration: `他说：「${h.note}」→ 第 ${view.round} 轮回应`,
        delta: { ops: spend > 0 ? [{ gold: -spend }] : [] },
        scene_over: over,
        summary: over ? `第 ${view.round} 轮收束的小结` : '',
        next_seeds: over ? ['余波'] : [],
        欲向: '无关' as const,
      };
      // ⚠️ §2.4：首轮之前 `conv` 是 null ⇒ 换成真对象（真 brain 每轮都往里存对话三元组）。
      return { value, conv: { 轮: view.round, 前情: conv } };
    },

    async sceneWrap(_ev, _l, reason, view, conv) {
      calls.push(`收尾:${reason}`);
      return {
        value: {
          narration: '收尾叙事',
          delta: { ops: [] },
          scene_over: true,
          summary: `整场小结（${reason}）· 走了 ${view.turns.length} 轮`,
          next_seeds: ['收尾钩子'],
          欲向: '趋近' as const,
        },
        conv,
      };
    },
  };
}

export const suites: Suite[] = [
  {
    name: '★ 多轮「穿越」状态机（Phase 3 · 路径⑤）',
    register(t) {
      // ── 开场景 ────────────────────────────────────────────────
      t.test('★ 开场景：锁 P（提交即扣）但**不推进时钟**', () => {
        const l = sceneLedger(3);
        l.events.live[0].min_gold = 2;
        l.scalars.gold = 10;
        const o = openScene(l, { eventId: 'e1', goldInput: 2 });
        t.eq(o.blockedBy.length, 0, '不该被闸门拦下');
        t.eq(o.ledger.clock.usedToday, 0, '★ 开场景不动时钟 —— 处理完才自动扣');
        t.eq(o.ledger.scalars.gold, 8, '托管 P 提交那一刻即扣');
        t.eq(o.ledger.events.live[0].gold_locked, 2);
        t.eq(o.ledger.scene?.eventId, 'e1');
        t.eq(o.ledger.scene?.round, 0, '开完场是第 0 轮 —— 玩家还没开口');
        t.eq(o.ledger.scene?.conv, null, '第一条 question 之前没有任何对话历史');
        t.eq(l.scene, null, '旧账本一个字节没动');
      });

      t.test('★ 闸门 ③：`仅派遣` 的事件**开不了场景**（玩家去不了）', () => {
        const l = sceneLedger(2, { dispatchable: '仅派遣' });
        const o = openScene(l, { eventId: 'e1' });
        t.ok(
          o.blockedBy.some((g) => g.code === 'CANNOT_DISPATCH'),
          '闸门 ③ 必须认 `dispatchable`（它是那次"纸上机制"修正的下游）',
        );
        t.eq(o.ledger, l, '被拦下时账本原样返回');
      });

      t.test('★ 同时只允许一个场景：第二次开场景直接抛', () => {
        const l = openScene(sceneLedger(2), { eventId: 'e1' }).ledger;
        t.throws(() => openScene(l, { eventId: 'e1' }), '已有进行中的场景');
      });

      t.test('★ 场景外调 `sceneStep` / `sceneLeave` ⇒ 直接抛（没有"半个场景"这种状态）', () => {
        const l = sceneLedger(2);
        t.rejects(
          async () => await sceneStep(l, '喂', makeRng(1), sceneBrain({ sceneOverAt: null })),
          '没有进行中的场景',
        );
        t.rejects(
          async () => await sceneLeave(l, makeRng(1), sceneBrain({ sceneOverAt: null })),
          '没有进行中的场景',
        );
      });

      // ── 每一轮 ────────────────────────────────────────────────
      // ⚠️⚠️ 2025-10-06 清单第 4A.1 条（用户裁定第 12 条）：**中途轮不再落账**（资源冻结）。
      t.test('★★ 一轮：轮次 +1 · **中途 delta 一律不落**（冻结）· 对话凭据落进账本', async () => {
        const l = openScene(sceneLedger(3), { eventId: 'e1' }).ledger;
        const b = sceneBrain({ sceneOverAt: null, spendPerRound: 1 });
        const r = await sceneStep(l, '我先敲门', makeRng(7), b);
        t.eq(r.ended, null, '没到收尾条件就不许收场');
        t.eq(r.round, 1);
        t.eq(r.calls, 1, '★ 场景不掷骰 ⇒ 一轮恰好 1 次调用（两段式已退休）');
        t.eq(b.calls.length, 1, 'brain 侧也只被叫了这一次');
        t.eq(r.ledger.scene?.round, 1);
        t.eq(r.ledger.scene?.turns.length, 1, '每一轮都在【场景经过】里留一行');
        // ⚠️ 2025-10-06：**中途轮的 `ledgered` 恒空** —— 资源在**收尾时一次性**落
        //   （用户原话：「场景内相当于资源系统进入冻结状态…最后一轮时…一次性更新资源系统」）。
        //   ⇒ 模型在整场里能看见的"前几轮记过什么"是 `turns`（对话逐轮）＋ `conv`，
        //     **不是**账目碎片。这条断言现在钉的是"**没有**中途落账"这个事实。
        t.eq(
          r.ledger.scene?.ledgered.length ?? 0, 0,
          '★★ 中途轮落了账 —— 资源冻结被破坏了（用户裁定：中途不落，收尾一次落）',
        );
        t.ok((r.ledger.scene?.turns.length ?? 0) > 0, '★ 中途轮要在【场景经过】里留一行（模型靠它读上下文）');
        t.ok(r.ledger.scene?.conv !== null, '★ 《契约.md》§2.4：同场景内要保留 assistant 历史');
        t.eq(r.ledger.pending.length, 0, '还没收场 ⇒ 什么都不该进 pending');
      });

      // ── 收场：两条路 ──────────────────────────────────────────
      t.test('★ 末轮 `scene_over=true` ⇒ **跳过**收尾那一次调用（全场最贵处的最后一次往返）', async () => {
        let l = openScene(sceneLedger(2), { eventId: 'e1' }).ledger;
        const b = sceneBrain({ sceneOverAt: 2 });
        l = (await sceneStep(l, '第一句', makeRng(3), b)).ledger;
        t.eq(l.scene?.round, 1, '第一轮还没到收束点');
        const r = await sceneStep(l, '第二句', makeRng(3), b);
        t.eq(r.ended, '已自然收束');
        t.eq(r.close?.calls, 0, '★ 收尾那一次调用被省掉了');
        t.eq(b.calls.filter((c) => c.startsWith('收尾:')).length, 0, '★ brain 侧一次收尾都没被调到');
        t.eq(r.ledger.scene, null, '收场后场景状态必须清空');
        t.ok(
          r.ledger.summaries.recent.some((s) => s.text.includes('第 2 轮收束的小结')),
          '★ 末轮一并填的 summary 就是整场 summary（省调用不等于省记录）',
        );
      });

      // ⚠️⚠️ 2026-10-08 用户裁定：轮数用尽**不再自动跳结算**（原话「后者只能在玩家手动点击了
      //    结束对话按键后才能触发，轮数用尽仅仅只会禁止玩家继续在对话框输入文本」）。
      //    ⇒ 这一条重写为：末轮回应照常返回（不被吞）、场景留在原地、超限被拒、手动收尾照发。
      t.test('★ 轮数用尽 ⇒ **不自动收尾**：末轮回应不吞、场景仍在，收尾只能玩家手动触发', async () => {
        let l = openScene(sceneLedger(1), { eventId: 'e1' }).ledger;
        const b = sceneBrain({ sceneOverAt: null }); // 永不自行收束
        let last = await sceneStep(l, '第 1 句', makeRng(9), b);
        l = last.ledger;
        for (let n = 2; n <= SCENE_ROUND_CAP; n++) {
          last = await sceneStep(l, `第 ${n} 句`, makeRng(9), b);
          l = last.ledger;
        }
        t.eq(last.round, SCENE_ROUND_CAP, `上限就是 ${SCENE_ROUND_CAP} 轮`);
        t.eq(last.ended, null, '★ 轮尽不自动跳结算 —— 场景还在，等玩家点「结束对话」');
        t.ok(last.narration.trim().length > 0, '★ 末轮的回应必须照常返回（不能被吞）');
        t.ok(last.ledger.scene !== null, '场景状态保留 —— 收尾只能手动触发');
        t.eq(b.calls.filter((c) => c.startsWith('收尾:')).length, 0, '一次收尾都没发过');
        t.eq(b.calls.filter((c) => c.startsWith('叙事:')).length, SCENE_ROUND_CAP, `每轮恰好一次，共 ${SCENE_ROUND_CAP} 次`);
        // 超限的那次被规则层拒（前端禁输入之外的第二道闸）
        let threw = '';
        try {
          await sceneStep(l, '还想多说一句', makeRng(9), b);
        } catch (e) {
          threw = e instanceof Error ? e.message : String(e);
        }
        t.ok(threw.includes('轮次上限'), '超限的那次必须被抛掉（不许再进一轮）');
        // 玩家点「结束对话」⇒ 手动收尾照发（reason = 玩家主动退出）
        const r = await sceneLeave(l, makeRng(9), b);
        t.eq(r.reason, '玩家主动退出', '轮尽后的手动收尾按"主动退出"落');
        t.eq(r.calls, 1, '手动收尾要发那一次收尾调用');
        t.eq(r.ledger.scene, null);
      });

      t.test('★ 玩家主动退出：仍要走**一次收尾**（这一场的 delta 已经逐轮落过账了）', async () => {
        let l = openScene(sceneLedger(2), { eventId: 'e1' }).ledger;
        const b = sceneBrain({ sceneOverAt: null });
        l = (await sceneStep(l, '一句话', makeRng(3), b)).ledger;
        const r = await sceneLeave(l, makeRng(3), b);
        t.eq(r.reason, '玩家主动退出');
        t.eq(r.calls, 1, '退出要发收尾那一次');
        t.eq(b.calls.filter((c) => c.startsWith('收尾:')).length, 1);
        t.eq(r.ledger.scene, null);
        t.eq(r.ledger.events.live.find((e) => e.id === 'e1')!.status, '已结算');
      });

      // ── 收场后的落账 ──────────────────────────────────────────
      t.test('★ 收场走「算 / 揭分离」的同一条通道：扣 `cost` 即当场揭晓', async () => {
        const l = openScene(sceneLedger(3), { eventId: 'e1' }).ledger;
        const b = sceneBrain({ sceneOverAt: 1 });
        const r = await sceneStep(l, '说完就走', makeRng(6), b);
        t.eq(r.ledger.clock.usedToday, 3, '★ 处理完自动扣 3 点');
        t.eq(r.close?.revealed.length, 1, '扣完当场揭晓');
        t.eq(r.ledger.pending.length, 0, '揭晓即兑现 ⇒ pending 清空');
        const ev = r.ledger.events.live.find((e) => e.id === 'e1')!;
        t.eq(ev.status, '已结算');
        t.eq(ev.gold_locked, 0, '托管必须在推 pending **之前**结清（否则揭晓会再退一次）');
      });

      t.test('★ 跨天事件：收尾后一路扣到第 2 天末尾，中途自动翻日', async () => {
        const l = openScene(sceneLedger(8), { eventId: 'e1' }).ledger;
        const b = sceneBrain({ sceneOverAt: 1 });
        const r = await sceneStep(l, '出发', makeRng(6), b);
        t.eq(r.close?.daysPassed, 1, '跨了 1 个日界');
        t.eq(r.ledger.clock.day, 2);
        t.eq(r.ledger.clock.usedToday, 4, '第 1 天 4 点 ＋ 第 2 天 4 点 = 8 点处理时长');
        t.eq(r.ledger.events.live.find((e) => e.id === 'e1')!.status, '已结算');
      });

      // ⚠️ 2025-10-06：中途轮**不再记 `spent`** ⇒ 收尾那次 `landSceneDelta` 算出的
      //   `spent` 是**整场唯一一份** ⇒ 净额 = P − min(整场共 3, P=5) = 5 − 0 …… 实得 10。
      //   ⚠️ 这条现在钉的是"**中途一分没扣**"，收尾那次才结清。
      t.test('★★ 金币：中途**一分不扣** · 收尾那一次结清（冻结口径）', async () => {
        const l0 = sceneLedger(1);
        l0.events.live[0].min_gold = 5;
        l0.scalars.gold = 10;
        let l = openScene(l0, { eventId: 'e1', goldInput: 5 }).ledger;
        t.eq(l.scalars.gold, 5, '提交即扣 P = 5');
        const b = sceneBrain({ sceneOverAt: 3, spendPerRound: 1 });
        for (let n = 1; n <= 3; n++) l = (await sceneStep(l, `第 ${n} 句`, makeRng(4), b)).ledger;
        t.eq(l.scene, null);
        // ⚠️ 冻结口径：中途三轮的 `spendPerRound` **完全不进账** ⇒ 收尾时 `spent = 0`
        //   ⇒ 托管结清把 P **全退** ⇒ 余额回到**开场景之前**的 10（提交扣了 5，退回 5）。
        //   （旧口径"中途轮只记账"会停在 7 —— 那是逐轮记账的结果，本轮已改掉。
        //     ⚠️ 顺带暴露一件事：冻结之后**场景里花不掉钱了**（钱只在收尾那次动），
        //     而第 14 条用户裁定正好说"场景内不实施任何资源变化" ⇒ 这是**照裁定做的**。）
        t.eq(l.scalars.gold, 10, '★★ 冻结口径：中途不扣 ＋ 收尾退满 P ⇒ 回到开场景前的 10');
        t.eq(l.events.live.find((e) => e.id === 'e1')!.gold_locked, 0);
      });

      // ⚠️ 2025-10-06：中途轮**连"记一笔"都不做了**（那是逐轮记账的残留）⇒
      //   `ledgered` 恒空、`spent` 恒 0。模型在整场里靠 `turns` 读上下文。
      t.test('★★ 中途轮**完全不记账**（`ledgered` 空 ＋ `spent` 0）—— 冻结口径', async () => {
        const l0 = sceneLedger(1);
        l0.events.live[0].min_gold = 1;
        l0.scalars.gold = 10;
        const l = openScene(l0, { eventId: 'e1', goldInput: 1 }).ledger;
        const b = sceneBrain({ sceneOverAt: null, spendPerRound: 1 });
        const r = await sceneStep(l, '花钱', makeRng(4), b);
        t.eq(r.ledger.scalars.gold, 9, '中途轮余额不动（P 已在开场景时扣过，再扣就是双记）');
        t.eq(
          r.ledger.scene!.ledgered.length, 0,
          '★★ 中途轮还在记账 —— 冻结口径下这里必须是空的（收尾才落一次）',
        );
        t.eq(r.ledger.scene!.spent, 0, '★★ 中途轮还在记 `spent` —— 同上');
      });

      // ── 口径守卫 ──────────────────────────────────────────────
      t.test('★ 轮次上限只有 `SCENE_ROUND_CAP` 一份 —— 状态机里不许另写一个字面量 7', () => {
        // ⚠️ 这是**防"假绿"**的那一条：断言"上限 = 7"在"两边都写 7"时照样是绿的。
        //    要防的是**两份事实源**，所以只能读源码。
        const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'turn', 'scene.ts'), 'utf8');
        t.ok(src.includes('SCENE_ROUND_CAP'), '状态机必须读那个常量');
        t.ok(!/round\s*>=\s*\d/.test(src), '★ `turn/scene.ts` 里出现了字面量轮次上限');
      });
    },
  },
];
