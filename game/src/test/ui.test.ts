// P5-0 · 最小可交互 UI 的单测 —— **会话层**（`ui/session.ts`）＋ 档 A 点选（`turn/popup.ts`）
//
// ⚠️ 这里刻意**不测 HTTP**（起服务、发请求是下一层的事，测它只会把用例变脆）：
//    `ui/session.ts` 是 UI 的**全部后端语义**，`ui/server.ts` 只是一条 `switch`。
//    ⇒ 把断言放在会话层，"能点出一个结果"这件事才算真的被证明过。
//
// 三条最要紧的断言（都是"绿了但没测到"的高危区）：
//   ① **防剧透**：`view()` 里不许出现 `pending` 的任何内容 —— 且必须**先证明真的有东西在等**，
//      否则"没有剧透"只是因为"没有等待中的事件"（假绿）。
//   ② **档 A 只落被点的那一条**：未点选的选项一个字节都不许生效（两处实现漂移过的高危点）。
//   ③ **揭晓那句叙事真的能播报出来**：`revealDue` 兑现完就把 `pending.narration` 删了，
//      UI 若不在那一刻截住，它就**永远不再出现** —— 这是做 P5-0 才暴露的缺口，
//      所以必须要有一条断言钉住"那句话能到玩家眼前"。
import type { EventOption, GameEvent, Ledger } from '../ledger/types.ts';
import { readFileSync } from 'node:fs';
import { evalGates } from '../rules/gates.ts';
import { makeRng } from '../rules/rng.ts';
import { BASE_ACTION_POINTS } from '../rules/x.ts';
import { daypartOf } from '../rules/clock.ts';
import { currentStateBlock } from '../prompt/blocks.ts';
import { PLAYER_ID } from '../ledger/types.ts';
import { fakeBrain, makeEvent } from '../fixtures/fake.ts';
import { initialLedger } from '../ledger/initial.ts';
import { choosePopup } from '../turn/popup.ts';
import { placementPools } from '../turn/simulate.ts';
import { Session } from '../ui/session.ts';
import type { Suite, T } from './harness.ts';

/**
 * 读"玩家页的完整源"（2026-10-08 拆分适配）。
 * index.html 的主脚本已拆成多个经典 script src（js/ 目录）。本文件的静态纪律
 * 断言全是对**整页源码**做 regex —— 这里把每个 src 引用**原位内联回来**，
 * 拼成与拆分前内容等价的单页 ⇒ 既有断言零改动。
 */
const readPlayerPage = (): string => {
  const dir = new URL('../ui/', import.meta.url);
  const html = readFileSync(new URL('index.html', dir), 'utf8');
  return html.replace(/<script src="js\/([\w.-]+\.js)"><\/script>/g, (_all, name: string) => {
    const code = readFileSync(new URL('js/' + name, dir), 'utf8');
    return `<script>\n${code}\n</script>`;
  });
};

/** 造 `currentStateBlock` 要的那点账本（它只需要时钟与几个标量 —— 纯派生，不碰别的） */
const REP0 = { 善名: 0, 恶名: 0, 侠名: 0, 怪名: 0, 权势: 0 };

// ── 小工具 ────────────────────────────────────────────────────

const opt = (text: string, over: Partial<EventOption> = {}): EventOption => ({
  text,
  result_text: `（${text} 的结果文案）`,
  summary: `选了「${text}」`,
  欲向: '无关',
  delta: { ops: [] },
  trigger: null,
  ...over,
});

/** 一条**合成**事件（不依赖夹具随机产出）—— 用例要的是"这一条必定在池里" */
function add(l: Ledger, e: Partial<GameEvent> & { title: string }): GameEvent {
  const ev = makeEvent(e);
  l.events.live.push(ev);
  return ev;
}

/**
 * 开一局**正文** —— 跳过序幕（`day 0` 的 10 条档 A）。
 *
 * ⚠️ 本文件验的是**正文那 28 天**（派遣 / 时间 / 场景 / 终局），不是"两天巡礼"：
 *    序幕一跑，会话就停在 `day 0`，下面每一条用例的前提都得先重写一遍。
 *    序幕自己的用例在 `test/prologue.test.ts`（那里**故意不跳过**）。
 * ⚠️ 与无头驱动的 `SimOptions.skipPrologue` 是同一件事 ⇒ 这里拿到的账本与 P4-D 之前**逐字相同**。
 */
const startDay1 = (seed: number) => Session.start({ seed, skipPrologue: true });

function fails(l: Ledger): string[] {
  return evalGates({ ledger: l, today: l.clock.day, action: 'handle' })
    .filter((g) => !g.pass)
    .map((g) => g.code);
}

// ── 套件 ──────────────────────────────────────────────────────

const 开局与视图: Suite = {
  name: 'P5-0 · 会话层（开局 / 视图）',
  register(t: T) {
    // ⚠️⚠️ 2026-10-06（用户裁定的问题 8「我明明用 live 打开，却还会有不该出现的假事件」）：
    //   判据 —— **`--live` 缺 brain 必须当场抛**，不许静默回落成假模型。
    //   ⚠️ 离线路径（`requireLive` 默认 false）行为一个字不变 ⇒ 下面第 ③ 条钉住这一点。
    t.test('★★ `requireLive` 缺 brain ⇒ **当场抛**（不许静默回落成假模型）', async () => {
      let msg = '';
      try {
        await Session.start({ seed: 1, skipPrologue: true, requireLive: true });
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      t.ok(msg !== '', '★★ requireLive 缺 brain 居然没抛 —— 又会静默换成假 brain 了');
      t.ok(msg.includes('requireLive') || msg.includes('brain'), `★ 错因要说清是"缺 brain"：${msg}`);
      // ② live 且传了 brain ⇒ 正常开（别把真游戏也堵了）
      const ok = await Session.start({ seed: 1, skipPrologue: true, requireLive: true, brain: fakeBrain() });
      t.ok(ok.view().day >= 1, '★ 传了 brain 还抛 ⇒ 把真游戏也堵死了');
      // ③ ⚠️ **离线路径不受影响**（少了这条，上面两条可能靠"全都抛"来过）
      const off = await startDay1(1);
      t.ok(off.view().day >= 1, '★★ 离线路径被 requireLive 波及了（默认必须是 false）');
    });

    t.test('开局 · 与驱动同构：day 1 / 周例钱 20 / 11 人 / 9 地 / 2 物 / 欲念 30', async () => {
      const s = await startDay1(20260921);
      const v = s.view();
      t.eq(v.day, 1, '开场动作 = `day 0 → day 1` 再 `enterDay`（与 turn/simulate.ts 逐字同构）');
      t.eq(v.chapter, 1, '《规则.md》§一：第 1 天在第 1 章');
      t.eq(v.gold, 20, '《设定.md》序幕占位 = 进入第 1 天发的那次周例钱（不是额外的一笔；2026-10-08 由 5 提到 20）');
      t.eq(s.ledger.entities.people.length, 11, 'npc000 玩家 ＋ npc001~010 预置');
      t.eq(v.people.length, 10, '视图里的"人手"不含玩家自己（他有单独一格）');
      // ⚠️ 地点**只多不少**：生成侧若写了个没注册过的地名（夹具的「西门码头」就是这么写的），
      //    落地层会当场补登记、发一个 `loc` 号 ⇒ 进入第 1 天之后再数，"9 处预置"已经不一定等于现值。
      //    真正该守的不变式是下面那条：**每条事件的地点都在账本里**（预置 9 处是 `initial.test.ts` 的事）。
      t.ok(
        s.ledger.entities.places.length >= 9,
        `地点只会多不会少（实得 ${s.ledger.entities.places.length}）`,
      );
      for (const e of s.ledger.events.live) {
        t.ok(
          e.location === null || s.ledger.entities.places.some((p) => p.id === e.location),
          `事件 ${e.id} 的地点 ${String(e.location)} 必须在账本里（落地层的补登记不许漏）`,
        );
      }
      t.eq(s.ledger.entities.items.length, 2, '两样东西（短匕首 / 旧游记）开局就在手上');
      t.eq(v.desire.value, 30, '《设定.md》：开局欲念 30');
      const avg = Object.values(v.me.attrs).reduce((a, b) => a + b, 0) / 6;
      t.ok(avg <= 10, `序幕替身的六维均值必须 ≤ 10（他是"不成器的三王子"），实得 ${avg}`);
      t.ok(v.desire.proposition !== '', '开局要补上目的 —— 否则整局没有"欲望"可言');
      t.ok(v.desire.means !== '', '★ 开局要补上**手段** —— 否则「正当的手段」失去判据');
    });

    t.test('同一种子两局逐字相同（离线可重复 —— 否则"试验台"没有意义）', async () => {
      const a = await startDay1(7);
      const b = await startDay1(7);
      t.eq(JSON.stringify(a.view()), JSON.stringify(b.view()), '同种子两次开局必须一模一样');
      const c = await startDay1(8);
      t.ok(JSON.stringify(c.view()) !== JSON.stringify(a.view()), '换种子应当换出一局不一样的（否则种子没接上）');
    });

    t.test('★ 防剧透：view() 里不许出现 pending 的任何内容（先证明真的有东西在等）', async () => {
      const s = await startDay1(20260921);
      add(s.ledger, { id: 'eX', title: '账房送来一封缺页的信', tier: 'B', cost: 2 });
      const r = await s.arrange({ eventId: 'eX', participants: ['npc000'] });
      t.ok(r.ok, `先得排布成功，否则这条用例是空跑：${r.error}`);
      t.eq(s.view().waiting.length, 1, '★ 前提：此刻**确实**有一条事件在等揭晓（不然"没剧透"是假绿）');

      // 手工在"未来"里塞一句独一无二的话 —— 它就是玩家此刻还不该看到的东西
      const leak = 'ZZ剧透串ZZ：他其实会当场被认出来';
      s.ledger.pending[0].narration = leak;
      const json = JSON.stringify(s.view());
      t.ok(!json.includes(leak), '★ 揭晓之前，pending.narration 一个字都不许进 view()');
      t.ok(!json.includes('ZZ剧透串ZZ'), '★ 同上（用子串再钉一次，防止转义把断言骗过去）');

      // 走够时间 ⇒ 立即可见（证明上面那条不是因为"那句话永远不会出现"）
      const d = await s.dial(2);
      t.ok(d.ok, `拨时针 2 点：${d.error}`);
      const feed = s.feed.map((f) => f.text).join('\n');
      t.ok(feed.includes('ZZ剧透串ZZ'), '★ 揭晓之后必须立刻播报出来 —— 否则那句话就永远丢了');
      t.eq(s.view().waiting.length, 0, '揭晓之后它离开「揭晓待办」');
    });

    t.test('档 A：点选之前 UI 只拿得到选项文字，拿不到 result_text', async () => {
      const l = initialLedger();
      add(l, { id: 'eA', title: '一封没有署名的请柬', tier: 'A', options: [opt('接过来'), opt('退回去')] });
      const s = new Session(1, makeRng(1), fakeBrain(), l);
      const json = JSON.stringify(s.view());
      t.eq(s.view().popups.length, 1, '前提：这条档 A 在弹窗列表里');
      t.deep(Object.keys(s.view().popups[0].options[0]), ['text'], '★ 选项只给文字 —— result_text 是"选了才知道"的');
      t.ok(!json.includes('接过来 的结果文案'), '★ result_text 不许提前出现在 view() 里');
      t.ok(!json.includes('result_text'), '★ 连字段名都不该出现（防止把整份 option 原样推给 UI）');
    });
  },
};

const 档A点选: Suite = {
  name: 'P5-0 · 档 A 点选（turn/popup.ts）',
  register(t: T) {
    t.test('只落被点中的那一个选项（未点选的一个字节都不生效）', () => {
      const l = initialLedger();
      add(l, {
        id: 'eA',
        title: '集市上有人当街喊出了你的名字',
        tier: 'A',
        options: [
          opt('装作没听见', { delta: { ops: [{ gold: 5 }] } }),
          opt('回头应一声', { delta: { ops: [{ gold: 1 }, { rep: { 怪名: 5 } }] } }),
        ],
      });
      const gold0 = l.scalars.gold;
      const r = choosePopup(l, 'eA', 1);
      t.eq(r.rejected, null, '合法点选不该被拒');
      t.eq(r.ledger.scalars.gold, gold0 + 1, '★ 落的是第 2 个选项（+1），不是第 1 个（+5）');
      t.eq(r.ledger.scalars.rep.怪名, 5, '★ 混键 op 也在同一次里落账（`gold` ＋ `rep` 拆键）');
      t.eq(r.ledger.events.live.find((e) => e.id === 'eA')!.status, '已结算', '点选即收口');
      t.eq(r.resultText, '（回头应一声 的结果文案）', 'result_text 是档 A 结果**唯一**的载体（不调 LLM）');
      t.eq(r.ledger.summaries.recent.length, 1, '档 A 在历史上留下的唯一痕迹 = 一句概要');
    });

    t.test('点选唤醒隐藏事件 —— 血统单向（子事件绝不回填父 id）', () => {
      const l = initialLedger();
      l.events.hidden.push(makeEvent({ id: 'eChild', title: '那件东西其实认得你', tier: 'B' }));
      add(l, {
        id: 'eA',
        title: '一只乌鸦落在窗台上',
        tier: 'A',
        options: [opt('接过来看看', { trigger: 'eChild' }), opt('把东西退回去')],
      });
      const r = choosePopup(l, 'eA', 0);
      t.deep(r.triggered, ['eChild'], 'trigger 唤醒的是全局 id');
      t.eq(r.ledger.events.hidden.length, 0, '它从 hidden 里搬走了');
      const child = r.ledger.events.live.find((e) => e.id === 'eChild')!;
      t.ok(!!child, '★ 它当场进了 live（藏的是**可见性**，不是内容）');
      t.ok(!JSON.stringify(child).includes('eA'), '★ 子事件不许回填父 id（双向写会互相漂移）');
    });

    t.test('★ 点一个不带 trigger 的选项 ⇒ 隐藏事件一条都不许冒出来', () => {
      const l = initialLedger();
      l.events.hidden.push(makeEvent({ id: 'eChild', title: '不该现在出现', tier: 'B' }));
      add(l, {
        id: 'eA',
        title: '一封没有署名的请柬',
        tier: 'A',
        options: [opt('接过来', { trigger: 'eChild' }), opt('退回去')],
      });
      const r = choosePopup(l, 'eA', 1);
      t.deep(r.triggered, [], '第 2 个选项没有 trigger');
      t.eq(r.ledger.events.hidden.length, 1, '★ 隐藏事件仍藏在 hidden 里（防止"顺手全放出来"）');
      t.eq(r.ledger.events.live.filter((e) => e.id === 'eChild').length, 0, '★ 它绝不该进 live');
    });

    t.test('拒绝的三条前置：不在池里 / 不是待处理的档 A / 下标越界 —— 账本一个字节没动', () => {
      const l = initialLedger();
      add(l, { id: 'eB', title: '城门口的一张无名告示', tier: 'B' });
      add(l, { id: 'eA', title: '请柬', tier: 'A', options: [opt('接过来')] });

      const miss = choosePopup(l, 'eNope', 0);
      t.ok(miss.rejected !== null && miss.rejected.includes('不在事件池里'), '不存在的 id');
      const wrongTier = choosePopup(l, 'eB', 0);
      t.ok(wrongTier.rejected !== null && wrongTier.rejected.includes('档 B'), '档 B 要走派遣 / 穿越');
      const oob = choosePopup(l, 'eA', 3);
      t.ok(oob.rejected !== null && oob.rejected.includes('越界'), '下标越界');
      for (const r of [miss, wrongTier, oob]) {
        t.ok(r.ledger === l, '★ 被拒时返回**同一个账本对象**（引用相等 ⇒ 没克隆 ⇒ 没动过）');
      }
      const done = choosePopup(l, 'eA', 0);
      t.eq(done.rejected, null, '先把它点掉');
      const again = choosePopup(done.ledger, 'eA', 0);
      t.ok(again.rejected !== null && again.rejected.includes('已结算'), '★ 已经清掉的不许再点一次（防重复落账）');
    });

    t.test('没有选项的档 A ⇒ 当场收口（不许留一个清不掉的死锁）', () => {
      const l = initialLedger();
      add(l, { id: 'eA', title: '结构坏掉的弹窗', tier: 'A', options: [] });
      const r = choosePopup(l, 'eA', 0);
      t.eq(r.rejected, null, '这不是"被拒"，是收口');
      t.eq(r.ledger.events.live.find((e) => e.id === 'eA')!.status, '已结算', '★ 否则闸门 ④ 会把这一局钉死');
      t.ok(r.log.some((x) => x.includes('⚠️')), '★ 结构性错误必须刺眼地写出来，不能静默抹平');
    });

    t.test('点掉档 A ⇒ 闸门 ④ 从"拦"变"放"（这条把它与主循环接上）', () => {
      const l = initialLedger();
      add(l, { id: 'eA', title: '请柬', tier: 'A', options: [opt('接过来')] });
      // ⚠️ 2026-10-07 用户裁定「档 A 与常规事件同级」：闸门 ④ 不再拦 `handle`，
      //    只拦 `advanceDay` ⇒ 这里改用换日那一路验证"拦 → 放"。
      t.ok(
        evalGates({ ledger: l, today: l.clock.day, action: 'advanceDay' }).some((g) => !g.pass && g.code === 'POPUP_PENDING'),
        '★ 前提：档 A 未清时闸门 ④ 确实在拦换日（否则下面的断言无意义）',
      );
      const r = choosePopup(l, 'eA', 0);
      t.deep(fails(r.ledger), [], '★ 清掉之后一条都不该剩');
    });
  },
};

const 会话动作: Suite = {
  name: 'P5-0 · 会话动作（派遣 / 时间 / 场景 / 终局）',
  register(t: T) {
    t.test('★ 排布 → 走够时间 → 那句叙事真的播报出来了', async () => {
      const s = await startDay1(20260921);
      add(s.ledger, { id: 'eX', title: '账房送来一封缺页的信', tier: 'B', cost: 2, hint_attr: ['智慧'] });
      const r = await s.arrange({ eventId: 'eX', participants: ['npc000'] });
      t.ok(r.ok, `排布应当成立：${r.error}`);
      t.ok(r.notice.includes('投骰') || r.notice.length > 0, 'UI 要拿到一句"已经排布"的话');
      t.eq(s.feed.filter((f) => f.kind === '揭晓').length, 0, '还没到点 —— 此刻一个字都不该播');

      const d = await s.dial(2);
      t.ok(d.ok, `拨时针 2 点：${d.error}`);
      const revealed = s.feed.filter((f) => f.kind === '揭晓');
      t.eq(revealed.length, 1, '★ 到点了必须播（`revealDue` 兑现后 narration 就被删了，错过就永远没了）');
      t.eq(revealed[0].text, '（假叙事）', '播的就是结算那一次写的那句话');
      t.eq(revealed[0].title, '账房送来一封缺页的信', '播报要认得出是哪一条');
      t.eq(revealed[0].eventId, 'eX', '★ 播报要挂回**它那条**事 —— 右栏按事件分区，全靠这个字段（标题会重复，猜不得）');
      t.eq(s.view().settled.length, 1, '它同时进入"已了结"');
    });

    t.test('闸门拦下的排布 ⇒ ok:false 且把原因原样交回 UI（不许静默什么都不做）', async () => {
      const s = await startDay1(20260921);
      add(s.ledger, { id: 'eOnly', title: '去北境送一封信', tier: 'B', dispatchable: '仅派遣', cost: 2 });
      const r = await s.arrange({ eventId: 'eOnly', participants: ['npc000'] });
      t.eq(r.ok, false, '「仅派遣」的事玩家本人去不了（闸门 ③）');
      t.ok(r.error.includes('仅派遣') || r.error.includes('派遣'), `原因要说清是哪条闸门：${r.error}`);
      t.eq(s.view().waiting.length, 0, '被拦下 ⇒ 什么都没排布（不会留下一条幽灵的「揭晓待办」）');
    });

    t.test('拨时针越界被拒；进下一天 = day+1 且第 8 天发周例钱', async () => {
      const s = await startDay1(20260921);
      const bad = await s.dial(99);
      t.eq(bad.ok, false, '拨不出超过当天剩余的点数');
      t.ok(bad.error.includes('只剩'), `错因要带上剩余点数：${bad.error}`);

      const d1 = await s.nextDay();
      t.ok(d1.ok, `进下一天：${d1.error}`);
      t.eq(s.view().day, 2, '翻日了');
      t.eq(s.view().usedToday, 0, '时间读数归零');
    });

    t.test('★ 多轮穿越：进场景 → 说三轮 → 自行收束 → 事件转「揭晓待办」再揭晓', async () => {
      const s = await startDay1(20260921);
      add(s.ledger, { id: 'eS', title: '下城有人在夜里敲门', tier: 'C', cost: 2, dispatchable: '仅亲自' });
      const o = s.openScene({ eventId: 'eS', participants: ['npc000'] });
      t.ok(o.ok, `开场景：${o.error}`);
      t.ok(s.view().scene !== null, '视图里出现场景面板（否则 UI 根本不知道自己在场景里）');
      t.eq(s.view().scene!.round, 0, '开完场是第 0 轮（玩家还没开口）');

      const r1 = await s.sceneSay('我先不吭声，听着门外的动静');
      t.ok(r1.ok, `第 1 轮：${r1.error}`);
      t.eq(s.view().scene!.round, 1, '轮次推进了');
      const r2 = await s.sceneSay('开门');
      t.ok(r2.ok, `第 2 轮：${r2.error}`);
      const r3 = await s.sceneSay('把刀收进袖子里，先问他是谁');
      t.ok(r3.ok, `第 3 轮：${r3.error}`);
      t.eq(s.view().scene, null, '★ 末轮自行收束 ⇒ 场景结束（这条支路省掉收尾那一次调用）');
      t.ok(s.feed.some((f) => f.kind === '场景'), '★ 每一轮的叙事都进了播报');
      t.ok(s.feed.some((f) => f.kind === '收场'), '★ 收场也要有一条（概要 / 收尾原因）');
      // ⚠️ `收场` 那一轮结束后 `ledger.scene` 就被清掉了 ⇒ 场景 id 必须在 `adopt` **之前**抓下来。
      //    抓晚了这两类播报的 `eventId` 会**静默变成空串** —— 而码面上完全看不出差别。
      const sc = s.feed.filter((f) => f.kind === '场景' || f.kind === '收场');
      t.eq(sc.filter((f) => f.eventId !== 'eS').length, 0,
        `★ 场景 / 收场**每一条**都挂回那条事（实得 ${sc.map((f) => JSON.stringify(f.eventId)).join(', ')}）`);

      // 收场会把 `cost` 走完 ⇒ 到点即揭晓
      const eS = s.view().settled.find((e) => e.id === 'eS');
      t.ok(!!eS, '★ 场景事件已落账（走的是"算 / 揭分离"的同一条通道，不是第二条路径）');
      t.eq(s.view().scene, null, '场景状态置回 null —— "在不在场景里"只有这一个判据');
    });

    t.test('★★ 每条播报都带得回它那条事件 —— 这是右栏"按事件分区"的总前提', async () => {
      // 判据：除**世界级**消息（章节占卜 / 终局 —— 它们不属于任何一条事件）之外，
      //      任何一条播报的 `eventId` 都**不许是空串**。
      // ⚠️ 为什么值得单列一条：空了的后果不是"报错"，而是右栏**认不出它属于哪件事** ——
      //    那段正文会变成没人认领的孤儿（要么消失、要么被挂到别的事上，而且看起来完全正常）。
      const a = await startDay1(20260921);
      add(a.ledger, { id: 'eG', title: '账房送来一封缺页的信', tier: 'B', cost: 2 });
      const ra = await a.arrange({ eventId: 'eG', participants: ['npc000'] });
      t.ok(ra.ok, `前提：排布要成立：${ra.error}`);
      const da = await a.dial(2);
      t.ok(da.ok, `前提：拨时针要成立：${da.error}`);
      // 世界级那条：占卜
      a.announceDivination({ ambience: 'ZZ城里的风ZZ' });

      const b = await startDay1(20260921);
      add(b.ledger, { id: 'eC', title: '下城有人在夜里敲门', tier: 'C', cost: 2, dispatchable: '仅亲自' });
      t.ok(b.openScene({ eventId: 'eC', participants: ['npc000'] }).ok, '前提：开场景要成立');
      await b.sceneSay('我先不吭声，听着门外的动静');
      await b.sceneSay('开门');
      await b.sceneSay('把刀收进袖子里，先问他是谁');

      const all = [...a.feed, ...b.feed];
      // ⚠️ 别按 `kind === '占卜'` 数 —— **开局本来就会播一条**（`Session.start` 就占了第 1 章），
      //    按 kind 数会得到"两局各一条 ＋ 我刚播的一条"＝ 3，而断言写的是 1 ⇒ 假红。
      //    ⇒ 认**我亲手掌的那一条**（拿那句话当指纹）。
      const div = all.filter((f) => f.kind === '占卜' && f.text === 'ZZ城里的风ZZ');
      t.eq(div.length, 1, `前提：刚播的那条占卜在（实得 ${div.length}）`);
      t.eq(div[0].eventId, '', '★ 占卜是**世界级**消息 ⇒ `eventId` 恒空（右栏把它放进「大事」）');

      const orphan = all.filter((f) => f.kind !== '占卜' && f.kind !== '终局' && f.eventId === '');
      t.ok(orphan.length === 0,
        `★ 除世界级消息外，一条都不许空（孤儿 ${orphan.length} 条：${orphan.map((f) => f.kind + '/' + f.title).join(' | ')}）`);
      t.ok(all.length >= 6, `前提：这几类播报确实都产生了（实得 ${all.length} 条 —— 太少说明上面某一步是空跑）`);
    });

    t.test('场景里空话不进裁定（前置拦下，不浪费一次调用）', async () => {
      const s = await startDay1(20260921);
      add(s.ledger, { id: 'eS', title: '下城有人在夜里敲门', tier: 'C', cost: 2, dispatchable: '仅亲自' });
      s.openScene({ eventId: 'eS', participants: ['npc000'] });
      const r = await s.sceneSay('   ');
      t.eq(r.ok, false, '空话连裁定都过不了');
      t.eq(s.view().scene!.round, 0, '没收轮次');
    });

    t.test('档 A 不许开场景（点击即结算的东西没有场景可穿越）', async () => {
      const s = await startDay1(20260921);
      add(s.ledger, { id: 'eA', title: '请柬', tier: 'A', options: [opt('接过来')] });
      const r = s.openScene({ eventId: 'eA', participants: ['npc000'] });
      t.eq(r.ok, false, '档 A 没有场景');
      t.ok(r.error.includes('档 A'), `原因要写清：${r.error}`);
    });

    t.test('★ 第 28 天：不许再"进下一天"，只能放格子；放完就终结且后续动作全被拦', async () => {
      const s = await startDay1(20260921);
      add(s.ledger, { id: 'eX', title: '一件小事', tier: 'B', cost: 1 });
      const r = await s.arrange({ eventId: 'eX', participants: ['npc000'] });
      t.ok(r.ok, '先得有点东西可以放格子（手段格才不会空）');

      s.ledger.clock.day = 28; // 把时钟直接搬到终局（这里要的是"终局那几步"，不是 28 天的过程）
      s.ledger.clock.chapter = 4;
      s.ledger.clock.phase = '终局';
      t.eq(s.view().isFinalDay, true, '第 28 天');
      const nd = await s.nextDay();
      t.eq(nd.ok, false, '★ 第 28 天不许再翻页');
      t.ok(nd.error.includes('放格子'), `错因要指向下一步该做的事：${nd.error}`);
      // ⚠️⚠️ 2026-10-06 清单第 4B 条（用户裁定第 16 条）：**`autoPlace` 兜底已删**
      //   —— "系统替玩家填三格"与"这一局是他自己走出来的"直接冲突。
      //   ⇒ 现在**必须显式提交三格**；不传 ＝ 当场拒（这一条钉的就是那个拒）。
      const noPl = await s.finish();
      t.eq(noPl.ok, false, '★★ 不带 placements 时不许判终局（autoPlace 兜底已删）');
      t.ok(noPl.error.includes('autoPlace'), `拒因要点名那条被删的兜底：${noPl.error}`);
      t.eq(s.view().isOver, false, '★ 被拒之后这一局还没结束（没有偷偷判）');

      // 玩家自己放的那一份 —— **显式**构造，与界面点「确定」时提交的形状一致
      const sug = { 成果: 'it_dagger', 手段: 'eX', 共鸣: null } as const;
      const f = await s.finish({ 成果: sug.成果, 手段: sug.手段, 共鸣: sug.共鸣 });
      t.ok(f.ok, `放格子判定：${f.error}`);
      t.eq(s.view().isOver, true, '★ 这一局结束了');
      t.eq(s.view().ending!.day, 28, '终局的行按第 28 天判（不是循环变量）');
      t.eq(s.view().ending!.row, 5, '欲念 ≈38 < 75 ⇒ 总表第 5 行「未竟」；5 优先于 6、6 优先于 7');
      t.deep(s.view().ending!.placements, sug, '★ 落账的三格就是 UI 给的那一份（不是另一份"看起来差不多"的）');

      const after = await s.arrange({ eventId: 'eX', participants: ['npc000'] });
      t.eq(after.ok, false, '★ 结束之后一切动作都被拦下（账本是单写者：终局一经写定就不再变）');
      t.ok(after.error.includes('已经结束'), `错因要说清是"这一局结束了"：${after.error}`);
    });

    t.test('★★ 一条已经排上的事件**不许再排一次**（闸门那 9 条没问过这件事）', async () => {
      // 病是探针逼出来的（`.workbuddy/probe-concurrent.py`）：并发发两次 `arrange`，
      // **两条都生效** —— 各掷一次骰、各调两次 LLM，而后一次的 `pending` 把前一次的结果
      // **覆盖**掉（`steps +2`、账本里只有 1 条）。⚠️ 它与并发无关：单发也复现 ——
      // 第二个标签页里那个陈旧页面（卡上还写着「待处理」）点一下就够了。
      const s = await startDay1(20260921);
      add(s.ledger, { id: 'eDup', title: '重复提交的靶子', tier: 'C', cost: 2, dispatchable: '仅亲自' });
      const first = await s.arrange({ eventId: 'eDup', participants: ['npc000'] });
      t.ok(first.ok, `第一次排布该成功：${first.error}`);
      t.eq(s.view().todo.some((x) => x.id === 'eDup'), false, '它已经离开「待处理」');
      t.ok(s.view().waiting.some((x) => x.id === 'eDup'), '搬进了「揭晓待办」');

      const steps = s.steps;
      const again = await s.arrange({ eventId: 'eDup', participants: ['npc000'] });
      t.eq(again.ok, false, '★ 第二次要被拒 —— 否则会再掷一次骰、再调两次 LLM，并覆盖上一次的结果');
      t.ok(again.error.includes('揭晓待办'), `错因要说清它现在是什么状态：${again.error}`);
      t.eq(s.steps, steps, '★ 被拒的那次**一步都没走**（steps 不涨 ＝ 没有 adopt）');
    });

    t.test('★ 认不出来的 id / 派不出人 ⇒ 可读的拒绝，**不许变成一个 500**', async () => {
      // 用户裁定（2026-09-20）：「出现这种问题需要报错」。病根是**请求体属于不可信输入**：
      // 陈旧页面（第二个标签页 / 浏览器后退）发来的那条早已了结的事件 id，会一路走到
      // `turn/handle.ts:157` 的 `throw`，被 `server.ts` 的兜底 catch 变成 HTTP 500 ——
      // 玩家看到的是一句"服务器内部错误"，分不清"我点错了"还是"游戏坏了"。
      const s = await startDay1(20260921);
      add(s.ledger, { id: 'eOk', title: '正常的靶子', tier: 'B', cost: 2 });

      const steps = s.steps;
      const ghost = await s.arrange({ eventId: 'ghost-9999', participants: ['npc000'] });
      t.eq(ghost.ok, false, '★ 认不出来的 id ⇒ ok:false 交回 UI（**不是**抛出去换一个 500）');
      t.ok(ghost.error.includes('刷新'), `话术要指向"页面是旧的、刷新再试"：${ghost.error}`);
      t.eq(s.steps, steps, '★ 一步都没走（没有 adopt）');

      // 派不出人 —— `server.ts·ids()` 对缺失 / 非数组的 `participants` 一律返回 `[]` ⇒ **可达**
      const nobody = await s.arrange({ eventId: 'eOk', participants: [] });
      t.eq(nobody.ok, false, '★ 派不出人 ⇒ ok:false（`handle.ts:160` 那条 throw 的前置拦截）');
      t.ok(nobody.error.includes('人'), `话术要说清"得挑一个派得出去的人"：${nobody.error}`);
      t.eq(s.steps, steps, '★ 同样一步都没走');

      // 反面：同一条事件、派得出的人 ⇒ 照常成功（守卫不许误伤正常路径）
      const fine = await s.arrange({ eventId: 'eOk', participants: ['npc000'] });
      t.ok(fine.ok, `★ 正常路径不许被误伤：${fine.error}`);
    });

    t.test('医馆疗伤 / 神殿净化：提交＝排布（扣金、占点、长出「处理中」卡）；拨针到点才回满；HP = 0 不可治', async () => {
      const s = await startDay1(20260921);
      const p0 = s.ledger.entities.people.find((x) => x.id === 'npc001')!;
      p0.affiliated = true;
      p0.hp = 1;
      const gold0 = s.view().gold;

      const ok = await s.restore('医馆', ['npc001']);
      t.ok(ok.ok, `医馆 1 金：${ok.error}`);
      // ⚠️ 2026-10-07 用户裁定（第十五批）：恢复延迟生效 —— 提交只排布
      t.eq(s.ledger.entities.people.find((x) => x.id === 'npc001')!.hp, 1, '提交那一刻还没回满');
      t.eq(s.view().gold, gold0 - 1, '诊金 1 金币（提交即落账）');
      t.eq(s.ledger.actionPoints.byNpc['npc001'], 4, '★ 2026-10-08：医治不即时扣 byNpc（时间流速口径，拨时间才扣）');
      const waiting = s.view().waiting;
      t.eq(waiting.length, 1, '画布上长出一张「处理中」的功能事件卡');
      t.eq(waiting[0].title, '医馆 · 疗伤');
      // 拨针 3 点 ⇒ 到点揭晓 ⇒ 回满
      const d = await s.dial(3);
      t.ok(d.ok, `拨针 3 点：${d.error}`);
      t.eq(s.ledger.entities.people.find((x) => x.id === 'npc001')!.hp, 3, '到点回满到 3');
      t.ok(
        s.feed.some((f) => f.kind === '揭晓' && f.text.includes('郎中')),
        '揭晓播报里给出机械叙事（零 LLM 的那一句）',
      );

      // 神殿净化：3 金 2 点 ⇒ SAN 回满（先把他 SAN 打下来 + 容量补回来；
      // 医馆那针拨掉了 3 点 ⇒ 把当天读数拨回早上，不然只剩 1 点拨不出神殿那 2 点）
      const p1 = s.ledger.entities.people.find((x) => x.id === 'npc001')!;
      p1.san = 1;
      s.ledger.actionPoints.byNpc['npc001'] = 4;
      s.ledger.clock.usedToday = 0;
      const gold1 = s.view().gold;
      const ok2 = await s.restore('大神殿', ['npc001']);
      t.ok(ok2.ok, `神殿 3 金：${ok2.error}`);
      t.eq(s.ledger.entities.people.find((x) => x.id === 'npc001')!.san, 1, '提交还没生效');
      t.eq(s.view().gold, gold1 - 3, '诊金 3 金币');
      const d2 = await s.dial(2);
      t.ok(d2.ok, `拨针 2 点：${d2.error}`);
      t.eq(s.ledger.entities.people.find((x) => x.id === 'npc001')!.san, 3, '到点回满到 3');

      s.ledger.entities.people.find((x) => x.id === 'npc001')!.hp = 0;
      const r = await s.restore('医馆', ['npc001']);
      t.eq(r.ok, false, '★ HP = 0（死亡）不可治 —— 直接进结局');
      t.ok(r.error.includes('不可治'), `原因要说清是"不可治"：${r.error}`);
    });

    t.test('★ /api/items/order：槽位排序只许同集重排（2026-10-07 · 生效优先级 = 槽位顺序）', async () => {
      const s = await startDay1(20260921);
      // ⚠️ 2026-10-08（无人携带）：初始物品 `holder=null` ⇒ 先装备到玩家身上再排
      const g1 = await s.give('npc000', ['it001', 'it002']);
      t.ok(g1.ok, `装备到玩家身上：${g1.error}`);
      const me = s.ledger.entities.people.find((x) => x.id === 'npc000')!;
      t.ok(me.items.length >= 2, '装备后玩家身上有两样东西（短匕首 / 旧游记）');
      const [a, b] = me.items;
      const bad = await s.reorderItems('npc000', [a, b, 'it_ghost']);
      t.eq(bad.ok, false, '多一件不收');
      const ok = await s.reorderItems('npc000', [b, a]);
      t.ok(ok.ok, `同集重排放行：${ok.error}`);
      t.eq(me.items[0], a, '旧账本一个字节没动');
      t.eq(s.ledger.entities.people.find((x) => x.id === 'npc000')!.items[0], b, '新账本顺序已换');
    });
  },
};

const 视图接线: Suite = {
  name: 'P5-0 · 视图接线（危险区 / 放格子候选池）',
  register(t: T) {
    t.test('★ view().zone：危险区由欲念推导 —— UI 侧第一次看得见它', async () => {
      const s = await startDay1(20260921);
      t.eq(s.view().zone, '正常', '开局欲念 30 ⇒ 正常区');
      s.ledger.desire.value = 81;
      t.eq(s.view().zone, '沉溺', '81 ⇒ 沉溺区');
      s.ledger.desire.value = 24;
      t.eq(s.view().zone, '迷失', '24 ⇒ 迷失区');
      s.ledger.desire.value = 25;
      t.eq(s.view().zone, '正常', '25 ⇒ 回到正常区');
    });

    t.test('★ view().placementPools：与 autoPlace 同源，且比"全部"窄', async () => {
      const s = await startDay1(20260921);
      const l = s.ledger;
      t.deep(
        s.view().placementPools,
        placementPools(l),
        '★ 视图里的候选池 = turn/simulate.ts 的**唯一口径**（UI 不许自算一份）',
      );

      // 成果池：只认「自己手上的 / 无主的」
      const held = l.entities.items.find((i) => i.id === 'it001')!;
      held.holder = 'npc001';
      const v2 = s.view();
      t.ok(!v2.placementPools.成果.includes('it001'), '★ 交到别人手上的东西**不进**成果池');
      t.ok(v2.items.some((i) => i.id === 'it001'), '（它照样在"身外之物"全表里 —— 两处口径不同是有意的）');

      // 共鸣池：只认「给过认可的人」
      t.deep(v2.placementPools.共鸣, [], '★ 开局没人 recognized ⇒ 共鸣池为空（此前 UI 会把全部 10 人都列出来）');
      l.entities.people.find((p) => p.id === 'npc002')!.recognized = ['他在雨里替我说过一句话'];
      t.deep(s.view().placementPools.共鸣, ['npc002'], '★ 只有 recognized 非空的人才进共鸣池');
    });

    t.test('★ 场景不掷骰（2026-10-07 用户裁定）：沉溺区也**不**在场景里留下判定痕迹', async () => {
      const s = await startDay1(20260921);
      add(s.ledger, { id: 'eZ', title: '下城有人在夜里敲门', tier: 'C', cost: 2, dispatchable: '仅亲自' });
      s.ledger.desire.value = 81; // 沉溺
      const o = s.openScene({ eventId: 'eZ', participants: ['npc000'] });
      t.ok(o.ok, `开场景：${o.error}`);
      const r = await s.sceneSay('我开门');
      t.ok(
        !r.log.some((x) => x.includes('危险区') || x.includes('投骰')),
        `★ 场景路径不许再有危险区 / 掷骰（裁定已退休）：\n${r.log.join('\n')}`,
      );
      t.ok(r.log.some((x) => x.includes('不掷骰')), '★ 每轮的日志要点名"不掷骰"（防两段式悄悄回归）');
    });
  },
};

/**
 * P5-B（2026-09-22）· **玩家界面** —— 视图侧 ＋ `ui/index.html` 的静态纪律。
 *
 * ⚠️ 为什么连 HTML 一起钉：`ui/index.html` 是**唯一一处没有类型保护的地方**（它不 import TS、
 *    Node 也不看它）。P5-B 的四处改动里有三处是"**删掉某一行**"（欲念数值 / 危险区 / 下拉框），
 *    而删掉之后**没有任何断言会红** —— 谁把它加回来，只有这里能拦住。
 *    ⇒ 取渲染函数的函数体做文本断言（与 `prompt.test.ts` 读 `blocks.ts` 是同一手法）。
 * ⚠️ 2026-09-22 用户裁定**推翻了其中一处**：欲念**数值**回到玩家面（区间名 ＋ 数值一起印）
 *    ⇒ 下面那条断言已**翻面**（见「顶栏印区间名 ＋ 数值」那一条）；危险区**仍在**上帝视角。
 */
const 玩家界面: Suite = {
  name: 'P5-B · 玩家界面（视图 ＋ ui/index.html 静态纪律）',
  register(t) {
    // ⚠️ 2026-10-08 拆分适配：主脚本已拆成 js/ 下多个文件 —— 走模块级
    //    readPlayerPage()（src 原位内联回来）⇒ 本套件全部 regex 断言零改动。
    const readHtml = readPlayerPage;
    /**
     * 取一个顶层渲染函数的函数体（截到下一个顶层 `function ` 为止），**并剥掉注释**。
     * ⚠️ 必须剥注释：本仓的注释里会**引用**它正在解释的那段代码（例如上帝视角那段注释写着
     *    `v.gates[i].lane`）⇒ 不剥的话，"renderRight 里不许出现 v.gates" 会被**注释**判红，
     *    而真正的代码其实没问题（2026-09-22 实测踩过）。
     */
    const bodyOf = (fn: string): string => {
      const HTML = readHtml();
      const i = HTML.indexOf('function ' + fn + '(');
      if (i < 0) throw new Error(`ui/index.html 里找不到 ${fn}() —— 这条断言无从谈起`);
      const rest = HTML.slice(i);
      const j = rest.indexOf('\nfunction ');
      const body = j > 0 ? rest.slice(0, j) : rest;
      return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    };

    t.test('★ 视图：band（4 段）＋ value 都给玩家面；危险区（3 值）仍退在上帝视角', async () => {
      const s = await startDay1(20260921);
      t.eq(s.view().desire.band, '常态', '开局欲念 30 ⇒ 常态');
      t.eq(s.view().desire.bandNote, '无漂移 · 无税 · 判定正常', '悬停读数照《设定.md》表的漂移/修正两列');
      t.eq(s.view().desire.value, 30, '★ **数值也给** —— 2026-09-22 用户裁定：区间名 ＋ 欲念值一起印');

      s.ledger.desire.value = 76;
      t.eq(s.view().desire.band, '窗口', '★ 76 在区间上是「窗口」');
      t.eq(s.view().zone, '正常', '★ 而同一点上危险区只有「正常」—— 两个读者两份口径，不许合并');
      s.ledger.desire.value = 10;
      t.eq(s.view().desire.band, '迷失');
      s.ledger.desire.value = 90;
      t.eq(s.view().desire.band, '沉溺');
    });

    t.test('★ 视图：gates 9 条各带 lane；statusLine 单独一格（面板首尾不会同名）', async () => {
      const s = await startDay1(20260921);
      const v = s.view();
      t.eq(v.gates.length, 9, '视图里只有 9 条真闸门（快照行不算闸门）');
      t.ok(
        v.gates.every((g) => g.lane === '动作拦截' || g.lane === '控件置灰'),
        '每条都带栏位 —— 分类来自 rules/gates.ts，UI 不许自编一份',
      );
      t.ok(!v.gates.some((g) => g.reason === v.statusLine.reason), '★ 快照行不许同时出现在 gates 里（否则面板会把它列两遍）');
      t.ok(v.statusLine.reason.includes('HP'), `statusLine 是读数行：${v.statusLine.reason}`);
      t.eq(v.gates.filter((g) => g.lane === '动作拦截').length, 3, '拦截栏 3 条');
      t.eq(v.gates.filter((g) => g.lane === '控件置灰').length, 6, '置灰栏 6 条');
    });

    t.test('★ 视图：seeds 连 source 一起给 —— 硬种子与软钩子在上帝视角里能分辨', async () => {
      const s = await startDay1(20260921);
      s.ledger.seeds.push({ code: 's1', title: '善名达到 10', content: '（提示语）', source: '硬种子' });
      t.eq(s.view().seeds[0].source, '硬种子');
    });

    t.test('★★ 顶栏印「区间名 ＋ 数值」；危险区仍不上玩家面', () => {
      const top = bodyOf('renderTop');
      t.ok(top.includes('v.desire.value'), '★ 顶栏**要**出现 v.desire.value（2026-09-22 用户裁定：直接写出来区间名＋欲念值）');
      t.ok(top.includes('v.desire.band'), '顶栏给的是**区间名**');
      t.ok(!top.includes('危险区'), '★ 顶栏仍不许出现危险区 —— 那个 3 值口径会把「窗口」和「常态」压成同一个词');
    });

    t.test('★★ 第 28 天那三格不再报欲念数值；闸门只住上帝视角（画布轮：右栏整个撤掉）', () => {
      t.ok(!bodyOf('renderMid').includes('v.desire.value'), '★ 放格子那块此前写着「欲念窗口目前是 <b>X</b>」');
      const HTML = readHtml();
      // 2026-09-22 用户裁定：「事件处理后也不需要保留这么多历史……文本消息也只需要在点开事件后
      // 就可以看到就行，不需要单独保存出来」⇒ 装历史的「记事」没有内容可装，撤栏时**连函数一起撤**。
      // 断言查的是**整个文件**：留一个没人调的 `renderRight` 在这里，等于给下次"顺手复活右栏"留了门。
      t.ok(!HTML.includes('renderRight'), '★ 右栏渲染函数已删（不留死代码）');
      t.ok(!HTML.includes('colRight'), '★ DOM / CSS 里也不该再留一个空的右栏');
      t.ok(bodyOf('renderGod').includes('v.gates'), '闸门住进上帝视角');
      t.ok(HTML.includes('id="godpanel" class="hidden"'), '★ 上帝视角**默认收起**');
    });

    t.test('★★ 最终任务清单**全周常驻** —— 不挂在第 28 天下面', () => {
      // ⚠️ 2026-10-06 判据跟着布局改（**意图一字未动**：清单必须**常驻**、
      //   且**不许跟终局绑**）。位置从 `renderLeft` 变成 `leftHtml`
      //   —— 用户裁定「最终任务区域…应该是**地图区**内的方格」⇒ 左栏整个取消。
      //   ⚠️ 同时钉住**它被 `renderMid` 真的画出来了**（只改函数名的话，
      //   它可能变成一个没人调用的孤儿函数 ⇒ 清单就真丢了）。
      // ⚠️ 2026-10-06 **第二次**改判据（**意图一字未动**：清单必须**常驻**、
      //   且**不许跟终局绑**）。用户裁定「**欲望块和任务清单块应该是合并的**」
      //   ⇒ 「最终任务清单」这个标题**不再单独出现** —— 它并进了 `missionBlock`
      //   （那一块的标题是「这一局 · 第 N 天」，下半就是三格）。
      //   ⇒ 判据从"有那两个字"改成"**三格在** `missionBlock` 里 ＋ 那个块被真的画出来"。
      const left = bodyOf('leftHtml');
      const mb = bodyOf('missionBlock');
      t.ok(mb.includes("['成果', '手段', '共鸣']") || mb.includes('成果'),
        '★ 三格在 `missionBlock` 里（清单与欲望已合并成同一块）');
      t.ok(left.includes('missionBlock(v)'), '★ 那块被 `leftHtml` 真的画出来（否则是孤儿函数）');
      // ⚠️ 2026-06 订正：调用点**从 `renderMid` 挪进了 `canvasHtml`** ——
      //   用户裁定「任务清单/尚未入队**像事件块一样放在地图区的左上角**」
      //   ⇒ 它必须与事件块**同一坐标系**（都在 `.canvas-pan` 里）
      //   ⇒ `renderMid` 现在只 `parts.push(canvasHtml(v))`。
      t.ok(bodyOf('canvasHtml').includes('leftHtml(v)'),
        '★ 且地图区真的调它 —— 否则它只是个没人用的函数（清单会丢）');
      t.ok(bodyOf('renderMid').includes('canvasHtml(v)'),
        '★ 中栏画的是地图区（链条完整：renderMid → canvasHtml → leftHtml）');
      t.ok(!left.includes('isFinalDay'), '★ 它不许跟终局绑在一起：玩家要在整局里看着清单长');
    });

    t.test('★★ 候选池只有一份口径：UI 不许自己再筛一遍（`placementPools` 是唯一入口）', () => {
      t.ok(readHtml().includes('v.placementPools'), '取的是视图给的候选池');
      // ⚠️ 2026-10-05（第五轮）收窄了判据的**范围**，没改它的**意图**。
      //    原来判的是 `!readHtml().includes('.consumed')` —— **全文件**字面量。
      //    那一版把整个 `ui/index.html` 划成禁区，理由是"UI 不许自己判消耗过没有"。
      //    第五轮给**手牌带**加了正当用法（卡带要滤掉 `consumed` 的物品：
      //    消耗掉的东西该从卡带走 —— 用户裁定「直接消失」），
      //    于是这条判据把**两个毫不相干的地方**用一根全局子串绑在了一起：
      //      · 该禁的：三格候选池（`placementPools` 是唯一入口，见 `turn/simulate.ts`）
      //      · 不该禁的：手牌带画哪些卡
      //    ⇒ 改成**只看那三格相关的渲染函数**。意图一字未动，范围回到正确的位置。
      //    （取 `sheetQuest` —— 三格的全量名单在它那里；`canvasSlots` 顺带看一眼，
      //      那是画布上"该先看的排最前"的摆位，与候选池同源。）
      const poolUi = bodyOf('sheetQuest') + bodyOf('canvasSlots');
      t.ok(!poolUi.includes('.consumed'),
        '★ 三格候选池不自己判"消耗过没有"（成果池口径由 `placementPools` 独管）');
      // ⚠️ 另一半仍然**故意保持全局**：共鸣那条判据没有同类误伤，保持原样最省事。
      t.ok(!readHtml().includes('recognized.length > 0'), '★ UI 不再自己判"给过认可没有"（共鸣池的口径）');
    });

    // ⚠️⚠️ 2026-10-08 用户裁定（「2/1/0 哪来的」）：「你的欲望」卡上那三颗计数徽标
    //    **从候选池改成凭证计数** —— 候选池（成果=手上的物品、手段=已了结的事、共鸣=
    //    给过认可的人）是"终局三格还能放哪些"的内部口径，玩家读成"框里有 N 张卡"，
    //    而终局三格里一张没有 ⇒ 数字与所见对不上。数 `v.vouchers` 才与手牌区可见的
    //    凭证卡一一对应。这条断言防它退回候选池口径。
    t.test('★★ 「你的欲望」徽标数的是凭证（v.vouchers），不是候选池', () => {
      const mb = bodyOf('missionBlock');
      t.ok(
        mb.includes('vs.filter((x) => x.dim === VDIM[k])'),
        '★★ 徽标没数 v.vouchers（玩家看到的数字必须与手牌区的凭证卡对得上）',
      );
      t.ok(!mb.includes('pv.pools'), '★ 徽标又回去数候选池了（那是终局三格的内部口径）');
    });

    // ⚠️⚠️ 2026-10-08 同批第 4/5 条：难度弹窗改版 ＋ 底栏两颗按钮换位。
    t.test('★★ 难度弹窗：新标题 / 无小字批注 / A·B·C 前缀 / 点一颗锁全部', () => {
      const HTML = readHtml();
      const ov = bodyOf('renderOverlay');
      t.ok(ov.includes('<h2>你想要一个什么样的故事？</h2>'), '★★ 标题没换成「你想要一个什么样的故事？」');
      t.ok(!ov.includes('挑一个叙事风味'), '★ 那句小字批注（挑一个叙事风味…）该删了');
      t.ok(
        ov.includes("[1, 'A. ") && ov.includes("[2, 'B. ") && ov.includes("[3, 'C. "),
        '★★ 三个难度选项前没加 A/B/C',
      );
      t.ok(!HTML.includes('运动的的'), '★ 「运动的的」双"的"笔误还在（用户裁定去掉一个）');
      t.ok(
        ov.includes("(difficultyPicked ? ' disabled' : '')") &&
        ov.includes("difficultyPicked === x[0] ? ';opacity:.45'"),
        '★★ 没做「点完一颗 ⇒ 它变暗、其余不可再点」（difficultyPicked 锁 UI）',
      );
      t.ok(
        HTML.includes('difficultyPicked = level;') && HTML.includes('difficultyPicked = 0;'),
        '★★ 点击侧没接锁定/解锁（先锁再请求，失败归 0 解锁）',
      );
    });

    t.test('★★ 底栏：waiting 提示常驻 ＋ 拨钟变大变深 ＋「进下一天」变小', () => {
      const ft = bodyOf('renderFooter');
      t.ok(
        !ft.includes('waitingN > 0') && ft.includes("waitingHint = '<span class=\"fhint\">'"),
        '★★ 「N 件事在外面办着」还挂着"有 waiting 才显示"的条件（用户裁定：常驻）',
      );
      t.ok(
        ft.includes('class="primary big" data-act="dial"'),
        '★★ 拨钟按钮没升级成大号深底（primary big）',
      );
      t.ok(
        ft.includes('<button class="primary" data-act="nextday"') &&
        !ft.includes('primary big" data-act="nextday"'),
        '★★ 「进下一天」还占着大号样式（用户裁定：拨钟大、翻日小一号）',
      );
    });

    // ⚠️⚠️ 2026-10-08（同批第 2 条）：图2 那颗「进入下午」（拨钟）的字要**白**。
    //   排障时发现的真凶：旧 CSS `footer button[data-act="dial"]{font-size:13px;…
    //   color:var(--ink-soft)}` 与 `footer button.big` **同特异性且写在后面** ⇒
    //   上一批的"变大"被它顶掉一半（字号回 13px）、字还被染成灰 —— 图2 实拍正是这副样子。
    //   ⇒ 旧小钟样式整条退役 ＋ 白字显式盖（夜间主题 `--on-accent` 是深墨）。
    t.test('★★ 底栏·拨钟白字：旧小钟样式退役，big 的字显式白', () => {
      const HTML = readHtml();
      t.ok(
        !HTML.includes('footer button[data-act="dial"]{font-size:13px'),
        '★★ 旧「拨钟压小一号」样式还在 —— 它同特异性且写在 big 之后，正把字号顶回 13px、字染灰',
      );
      t.ok(
        HTML.includes('footer button.big, footer button.big:hover:not(:disabled){color:#fff}'),
        '★★ 拨钟（footer 唯一的 big）的字没有显式白（夜间主题 on-accent 是深墨）',
      );
    });

    // ⚠️⚠️ 2026-10-08（同批第 1 条）：点 ✔ 简略处理 ⇒ 这件事**立马**显示「处理中」，
    //    不等 LLM 回包；等待话术换成「已发送请求，可以继续处理其他事」。
    //    实现＝乐观挪池（todo→waiting ＋ status 改「揭晓待办」，只动页面这份 view，
    //    下一次回包用真实信封整体覆盖 ⇒ 成功零收尾；`r===null` ⇔ 没带回包 ⇒ 手动还原）。
    t.test('★★ 点 ✔ 简略处理：乐观挪池立马「处理中」＋ 话术换「已发送请求」', () => {
      const HTML = readHtml();
      t.ok(
        !HTML.includes('正在裁定这件事'),
        '★ 旧等待话术（"正在裁定…"）还在 —— 用户裁定换成「已发送请求，可以继续处理其他事」',
      );
      t.ok(
        (HTML.match(/'已发送请求，可以继续处理其他事'/g) || []).length >= 2,
        '★★ 新话术没接上（commit·简略处理路 ＋ arrange/self 直通路都该是它）',
      );
      t.ok(
        HTML.includes("evObj.status = '揭晓待办'") &&
        HTML.includes('S.view.todo.splice(evIdx, 1)') &&
        HTML.includes('S.view.waiting.push(evObj)'),
        '★★ 没做乐观挪池（todo→waiting）—— 事件不会立马显示「处理中」',
      );
      t.ok(
        HTML.includes('r === null && evObj') &&
        HTML.includes("evObj.status = '待处理'"),
        '★★ 失败路径没还原乐观挪池（r===null ⇔ 视图没被回包换过，必须搬回 todo 让玩家重点）',
      );
      t.ok(
        HTML.includes('处理中：正在裁定…'),
        '★★ statusMark 没给无 reveal_at 的乐观事件兜底（会显示误导性的「还需 0 点」）',
      );
    });

    // ⚠️⚠️ 2026-10-07（真机探针 `probe/verify-desire-panel.mjs` 抓到的）：
    //   **view 上没有 `desireValue` 这个字段** —— 欲念值在 `view.desire.value`。
    //   单测只查源码字符串查不出这一类（`v.desireValue` 在源码里"看起来"完全合法，
    //   而它在浏览器里读到的是 `undefined`，第四行的数字显示成空白）。
    //   ⇒ 这条钉的是**那个真实的字段名**，谁改回去会被抓住。
    t.test('★★ 第四行那个欲念读数读的是 view 上真实存在的字段', () => {
      const HTML = readHtml();
      t.ok(
        !HTML.includes('v.desireValue') && !HTML.includes('desireValue'),
        '★★ 又在读那个不存在的 view 字段（真机探针 2026-07 实测：界面上是空白）',
      );
      // ⚠️ 判据只认**读的那个表达式**（那一行的完整 HTML 含太多引号，写进判据自己都对不上）。
      t.ok(
        HTML.includes('esc(v.desire.value)'),
        '★★ 第四行的欲念读数没接 view.desire.value（那是 view 上真有的那个字段）',
      );
    });

    // ⚠️⚠️⚠️ 2026-10-07 09:09：**用户发来一张整页裸奔的截图** —— 卡片没边框、按钮全是原生样式、
    //   菱形槽没画出来 ⇒ 整个 `<style>` 块**从某一行起全部失效**。
    //   真因：我插入 `.cvzone` 时把锚点那行 `.canvas-pan{…}` **复制了一遍**，
    //   于是多出一个未闭合的 `{`，把后面 1585 行 CSS 全吞了。
    //   ⇒ 这条断言**只看大括号配平**，不看具体内容 —— 它是"样式整块崩掉"的唯一防线。
    t.test('★★★ `<style>` 块的大括号配平（整页样式崩掉的唯一防线）', () => {
      const HTML = readHtml();
      const a = HTML.indexOf('<style>');
      const b = HTML.indexOf('</style>', a);
      t.ok(a > 0 && b > a, '找得到 style 块');
      let d = 0;
      let badAt = -1;
      // ⚠️⚠️ **必须跳过 CSS 注释**（`/* … */`）—— 2026-10-07 实测：
      //   注释里写着 `calc(50% - 1.4px)` 这种带花括号的说明，不跳过就会**误判成未闭合**。
      //   我为此先后用三种算法算，得到 0 / -1 / 0 三个不同答案 ⇒ 判据本身不可靠。
      //   ⇒ 这一条是**逐字符**走一遍（顺带跳过注释），是三种里唯一正确的。
      let inC = 0;
      for (let i = a + 7; i < b; i++) {
        const c = HTML[i];
        if (inC) { if (c === '*' && HTML[i + 1] === '/') { inC = 0; i++; } continue; }
        if (c === '/' && HTML[i + 1] === '*') { inC = 1; i++; continue; }
        if (c === '{') d++;
        else if (c === '}') { d--; if (d < 0 && badAt < 0) badAt = i; }
      }
      t.eq(d, 0, '★★ CSS 块里有多余的 `{`（或缺 `}`）⇒ 从那一行起后面全部样式失效，整页裸奔');
      t.eq(badAt, -1, '★★ CSS 里出现了提前闭合的 `}`（同样会让后面全部失效）');

      // ⚠️⚠️⚠️ **CSS 注释配平**（2026-10-07 09:09 这次事故的真凶）：
      //   我早先删 `.canvas` 那段样式时，**把两处注释的 `*/` 一起删掉了**
      //   ⇒ 从 `.canvas{` 那一行起、**后面 1585 行 CSS 全被浏览器当成注释**
      //   ⇒ 整页裸奔（卡片没边框、按钮原生、菱形槽消失）。用户发截图才发现。
      //   ⚠️ **只查大括号抓不到它**：那些"裸露"的 CSS 里 `{`/`}` 恰好配平（d = 0）。
      //   ⇒ 必须**单独查注释开合**（`/*` 与 `*/` 的累计差）。
      let cmt = 0;
      let cmtAt = -1;
      for (let i = a + 7; i < b; i++) {
        if (HTML[i] === '/' && HTML[i + 1] === '*') { cmt++; i++; }
        else if (HTML[i] === '*' && HTML[i + 1] === '/') { cmt--; if (cmt < 0 && cmtAt < 0) cmtAt = i; i++; }
      }
      t.eq(cmt, 0, '★★★ CSS 注释没配平（有 `/*` 没有对应的 `*/`）⇒ 后面整段被浏览器当注释吃掉，整页裸奔');
      t.eq(cmtAt, -1, '★★ CSS 里出现了多余的 `*/`（会提前结束注释，把注释里的字面当 CSS 解析）');
      // 顺手钉住那条被我复制过的锚点行 —— 它是这次的真凶
      t.ok(
        HTML.split('.canvas-pan{position:absolute;inset:0;transform-origin:50% 50%;').length - 1 === 1,
        '★★ `.canvas-pan` 那条规则出现了不止一次（2026-10-07 就是这么把整页 CSS 弄崩的）',
      );
    });

    // ⚠️⚠️⚠️ 2026-10-07 清单第 4 条（**口径更新**）：小钟图标退役 ——
    //   用户原话：「把这里莫名其妙的『正在处理』图像去掉，改成在**每个事件头上**显示
    //   『未处理：还有x天过期』或者『处理中：还需要y点行动力』」。
    //   ⇒ 状态是一行**文字**（`.cvstat`），钉住新口径防退回。
    t.test('★★ 第 4 条：每个事件块头上有一行**状态文字**（未处理／处理中）＋ 属性图标', () => {
      const HTML = readHtml();
      // ① 状态行本体（两种措辞都在，且长在事件块头上）
      t.ok(HTML.includes('function statusMark(e, live)'), '★★ 没有状态行函数（statusMark）');
      t.ok(HTML.includes('处理中：还需 '), '★★ 「处理中：还需 y 点行动力」那档没写');
      t.ok(HTML.includes('未处理：'), '★★ 「未处理：还有 x 天过期」那档没写');
      // ② 处理中那一档要有**独立的暖色样式**（它在计时，要一眼看出）
      t.ok(
        HTML.includes('class="cvstat on"') && HTML.includes('.cvchip .cvstat.on{'),
        '★★ 「处理中」状态行没有独立样式（要一眼看出它在计时）',
      );
      // ③ 今天到期 ⇒ 染红
      t.ok(HTML.includes('.cvchip .cvstat.hot{'), '★★ 「今天过期」没有染红样式');
      // ④ **左侧是属性图标，只要图标不要文字**（这条沿用第 5 条的旧裁定）
      t.ok(HTML.includes('function attrMarks(e)'), '★★ 地图上没有那条属性图标');
      t.ok(/attrMarks[\s\S]{0,300}attrSigil/.test(HTML), '★★ 属性那几格没用现成的 `attrSigil`（会有两套符号）');
      // ⑤ **没有 deadline 就只写「未处理」**（不硬编一个 0 出来）
      t.ok(HTML.includes("return '<span class=\"cvstat\">未处理</span>'"), '★ 缺 deadline 的事件没写「未处理」');
      // ⑥ 第 8 条：「必须先处理」的事件**也上地图**，标红 ＋ 写上非他不可
      t.ok(HTML.includes('const must = !!e.requiredPerson;'), '★★ 事件块不认「必须先处理」那一类（第 8 条要求它们也显示到地图上）');
      t.ok(HTML.includes('.cvchip.must{border-left:3px solid var(--danger)}'), '★★「必须先处理」的块没有红边');
      // ⑦ **显眼度**：底色从 sunken 提到 raise（用户原话「现在事件有点不显眼」）
      t.ok(/\.cvchip\{background:var\(--raise\)/.test(HTML), '★★ 事件块底色还是 sunken（用户原话：有点不显眼）');
      // ⑧ 旧的小钟标记**不许回来**（清单第 4 条已撤）
      t.ok(!HTML.includes('class="cvclock'), '★★ 旧的小钟标记又回来了（清单第 4 条已换成状态文字）');
    });

    t.test('★★ 摆位限制在一个**不画边框的长方格**内（用户 08:54 原话）', () => {
      const HTML = readHtml();
      // ① 算法按**像素**排，不再按百分比（百分比是相对整块台面的，限制不住）
      t.ok(
        /' style="left:' \+ sl\.x\.toFixed\(1\) \+ 'px;top:'/.test(HTML),
        '★★ 事件块还在用百分比定位 ⇒ 限制在长方格内这件事被抵消了',
      );
      // ② **让开左上角那两块常驻卡**（用户截图里的那个问题）
      t.ok(HTML.includes('var CORNER_W = 304;'), '★★ 没有给左上角那两块留宽度');
      t.ok(HTML.includes('padL + CORNER_W + 10'), '★★ 上半身那几行没有右移（会压在「最终任务清单」上面）');
      // ③ 槽位模型：**先算每行几格，再一行行填**（不是在算完之后修）
      t.ok(HTML.includes('逐行铺卡'), '★★ 摆位还是"算完再修"那一套（那个坑踩了三次）');
      t.ok(HTML.includes('var perRow = Math.max(1, Math.floor((right - x0) / (CHIP_W + 26)));'),
        '★★ 没有"每行放得下几格"这个量');
      // ④ **长方格的边框不显示**（用户明说）
      t.ok(
        !/\.cvzone\{[^}]*border/.test(HTML) && HTML.includes('.cvzone{position:absolute;inset:0;pointer-events:none}'),
        '★ 那个长方格要么画了边框、要么根本不是那个 `.cvzone`',
      );
      // ⑤ 台面宽度从 `colMid.clientWidth` 读（换窗口大小不会排错）
      t.ok(HTML.includes('midEl.clientWidth'), '★★ 台面宽度不是读真实列宽（换窗口大小就会排错）');
      t.ok(HTML.includes('const H = Math.max(240, slots.needH ||'), '★★ 台面高度不再由摆位结果反推');
    });

    // ⚠️⚠️⚠️ 2026-10-07（用户 08:41 指出四处漏做）：这一组是**补做用户原文档里已经写明的东西**。
    //   它们此前一轮没做，所以这里把判据钉死，别再退回。
    t.test('★★ 第 4 条：事件台与「你的欲望」**不遮挡手牌区**（手牌区要能拖拽）', () => {
      const HTML = readHtml();
      // ① 这一类浮层有专门的 `.top` 变体：**只占上 2/3**
      t.ok(HTML.includes('#overlay.top{'), '★★ 没有 `#overlay.top`（事件台仍在全屏遮罩里 ⇒ 手牌区拖不动）');
      t.ok(
        /#overlay\.top\{[^}]*inset:0 0 var\(--ovbottom/.test(HTML) && HTML.includes('syncOverlayBounds'),
        '★★ 浮层底边没让开页脚＋手牌区（2026-10-07 改为 render() 实量 `--ovbottom`：页脚＋手牌区高，任何屏高都不遮）',
      );
      t.ok(
        /#overlay\.top\{[^}]*backdrop-filter:none/.test(HTML),
        '★★ 它还在模糊 ⇒ 底下的凭证卡看不清，玩家不知道能拖',
      );
      // ② 两个该走 `.top` 的地方都走了（事件台 ＋ 详情层/欲望面板）
      const 加 = (HTML.match(/ov\.classList\.add\('top'\)/g) || []).length;
      t.ok(加 >= 2, `★★ 只有 ${加} 处走了 \`.top\`（事件台与「你的欲望」都要走）`);
      // ③ ⚠️ **其余弹窗必须明确摘掉** —— 否则关掉一个 `.top` 之后，
      //    下一个弹窗会**继承**它 ⇒ 一个确认框只占上 2/3。
      const 摘 = (HTML.match(/classList\.remove\('top'\)/g) || []).length;
      t.ok(摘 >= 5, `★★ 只有 ${摘} 处摘掉 \`top\`（档 A / 结算 / 确认 / compose / handled 都要摘）`);
    });

    t.test('★★ 第 10 条：「你的欲望」那几行只留名字＋卡位，小字写在框边', () => {
      const HTML = readHtml();
      t.ok(
        !HTML.includes('这一路上攒下的'),
        '★★ 那段候选池清单还在（用户原话：「这里的小字都可以删掉」）',
      );
      // 三行各自一句「这里需要放置 XX 类凭证」（用户 2026-07-07 原话）
      t.ok(/这里需要放置/.test(HTML), '★★ 卡位旁边没有那句引导');
      t.ok(HTML.includes("'成果类凭证')"), '★★ 成果行没写"成果类凭证"（已由"物品类凭证"更名）');
      t.ok(!HTML.includes('物品类凭证'), '★★ 旧名"物品类凭证"还有残留 —— 应已全部更名为"成果类凭证"');
      t.ok(HTML.includes("'事件类凭证')"), '★★ 手段行没写"事件类凭证"');
      t.ok(HTML.includes("'人物情感类凭证')"), '★★ 共鸣行没写"人物情感类凭证"');
      // 那句小字是**提示性小字**（淡黄斜体，第 23 条同款）
      t.ok(
        /\.vhint\{[^}]*font-style:italic/.test(HTML) && /\.vhint\{[^}]*color:var\(--gold\)/.test(HTML),
        '★★ `.vhint` 不是淡黄斜体（提示语要与第 23 条那句同一套样式）',
      );
    });

    t.test('★★ 第 22 条：凭证卡面＝标题＋类型，描述点开才看', () => {
      const HTML = readHtml();
      t.ok(!HTML.includes('<span class="vd">'), '★★ 卡面上还有描述那一行（用户原话：点开才能看到具体描述）');
      t.ok(!HTML.includes('.voucher .vd{'), '★ `.voucher .vd` 样式也该一起删');
      t.ok(HTML.includes('function sheetVoucher(v, id)'), '★★ 没有凭证详情页（点开凭证没反应）');
      t.ok(
        HTML.includes("d.kind === 'voucher' ? sheetVoucher(v, d.id)"),
        '★★ 详情层分派不认 voucher（点开凭证看不到描述）',
      );
      // 卡面的头两行：类型 ＋ 标题（2026-10-08 用户第 6 条后又添「性质 ＋ 稀有度」两行小字）
      t.ok(
        /<span class="vh">' \+ esc\(vc\.dimLabel\)/.test(HTML) &&
        /<span class="vt">' \+ esc\(vc\.title\)/.test(HTML),
        '★★ 卡面开头不是「类型 ＋ 标题」两行',
      );
      // ⚠️ 2026-10-08 用户第 2 条：三类凭证的详情主段统一为「凭证上的话」（LLM 写的 30~75
      //    字描述，`vouchersOf` 以 `v.desc` 为先）—— 旧的「事件概要」标题已废。
      t.ok(HTML.includes('凭证上的话'), '★★ 凭证详情页没有「凭证上的话」主段标题');
      // ⚠️⚠️ 2026-10-08 用户第 6 条：凭证加【稀有度】（普通/罕见/珍稀/传说）——
      //    卡面与详情页都要显示。卡面那行带 `data-r`（CSS 按档配色），详情页是一节。
      t.ok(
        /<span class="vr" data-r="' \+ esc\(vc\.rarity \|\| '普通'\)/.test(HTML),
        '★★ 凭证卡面没有稀有度那一行（用户裁定：卡牌上也要有这个字段）',
      );
      t.ok(
        HTML.includes('稀有度</div><div class="prose">'),
        '★★ 凭证详情页没有「稀有度」一节',
      );
      t.ok(/\.voucher \.vr\[data-r="传说"\]\{[^}]*accent/.test(HTML), '★ 稀有度四档配色没落进 CSS（传说＝金）');
    });

    t.test('★★ 第 23 条：那句邀请在**地图最上面居中**，淡黄斜体小字', () => {
      const HTML = readHtml();
      t.ok(!HTML.includes('.cvhead{'), '★★ 旧的 `.cvhead`（台面里绝对定位）还在 ⇒ 位置不对');
      t.ok(HTML.includes('class="cvtop"'), '★★ 没有 `.cvtop` 那个块');
      // ⚠️ **它必须由 `renderMid` 在中栏最顶画** —— 画在 `.canvas` 里就还是"台面里"，
      //   而台面里浮着「最终任务清单」「尚未入队」两块 ⇒ 视觉上偏。
      t.ok(
        /parts\.push\('<div class="cvtop">/.test(HTML),
        '★★ 那句话不是中栏的第一个元素（`renderMid` 里画一次，且不进 `.canvas`）',
      );
      // ⚠️ **占真实布局高度**（不是绝对定位）—— 绝对定位那句会被下面的块挤偏。
      t.ok(
        /\.cvtop\{[^}]*text-align:center/.test(HTML) &&
        /\.cvtop\{[^}]*font-style:italic/.test(HTML) &&
        /\.cvtop\{[^}]*11\.5px/.test(HTML),
        '★★ 样式不对（要居中 ＋ 斜体 ＋ 11.5px 的淡黄小字）',
      );
      t.ok(
        !/\.cvtop\{[^}]*position:absolute/.test(HTML),
        '★★ `.cvtop` 还是绝对定位（那样它不是"最上面"，只是"台面里的最上面"）',
      );
    });

    // ⚠️⚠️ 2026-10-06 清单第 4B.4 条：**凭证是新的一种卡牌，放在手牌区、只在「你的欲望」里可用**
    t.test('★★ 凭证卡牌：在手牌区 ＋ **只在「你的欲望」那一屏可拖** ＋ 带描述', () => {
      const HTML = readHtml();
      // ① 它在手牌区里（不是地图区、不是折叠组）
      // ⚠️ 2026-10-07：循环加了 `.slice().reverse()`（同类之内由新到旧，用户裁定）⇒ 判据跟着放宽
      t.ok(/for \(const vc of arr\(v\.vouchers\)[^\{]*\{/.test(HTML), '★★ 凭证卡没进手牌区');
      t.ok(HTML.includes('class="hcard voucher'), '★★ 凭证卡不是一张 `.hcard`（拖拽系统只认这个类）');
      // ② ⚠️ **默认不给 `data-kind`** —— "只能在『你的欲望』事件中使用"这条**由机制保证**
      t.ok(
        !/class="hcard voucher[^"]*"[^>]*\n?[^>]*data-kind="voucher"/.test(HTML)
          || !HTML.includes('data-vid="' + esc(vc.id) + '"\' +\n      \' data-act="detail" data-vdim='),
        '★★ 凭证卡**默认**就带 data-kind ⇒ 别的事件里也能拖（第 22 条明说只能在欲望那屏用）',
      );
      t.ok(HTML.includes('function enableVoucherDrag(on){'), '★★ 没有那个"只开一屏"的开关');
      t.ok(
        HTML.includes("if (on) c.setAttribute('data-kind', 'voucher');") &&
        HTML.includes("else c.removeAttribute('data-kind');"),
        '★★ 开关是单向的（关掉那一屏后属性还留着 ⇒ 在事件台里也能拖凭证）',
      );
      // ⚠️ 那三行在 **`ui/session.ts·vouchersOf`**（不在 index.html）⇒ 判据要读那个文件。
      // ⚠️ 2026-10-08 用户第 2 条：三类 detail 统一以**凭证自己的 `desc`** 为先（LLM 的
      //    30~75 字说明），空才回退旧来源（事件概要 / 物品 desc）—— 旧档兼容。
      const SESS = readFileSync(new URL('../ui/session.ts', import.meta.url), 'utf8');
      t.ok(
        SESS.includes('detail = v.desc || e.summary;'),
        '★★ 事件类凭证的 desc 优先级反了（应 v.desc 为先、summary 兜底）',
      );
      t.ok(
        SESS.includes('detail = v.desc || it.desc;'),
        '★ 成果类凭证的 desc 优先级反了（应 v.desc 为先、物品 desc 兜底）',
      );
      // ⚠️ 2026-10-08 用户第 2 条·根因修复的纪律钉：凭证卡**不带** `data-kind`（上面 ② 已钉）
      //    ⇒ 点击识别必须按 class —— 谁改回 `el.dataset.kind`，谁就让凭证又点不开
      //    （读出 undefined 落到 sheetItem 分支）。
      t.ok(
        HTML.includes("el.classList.contains('voucher') ? 'voucher' : el.dataset.kind"),
        '★★ 凭证卡点击识别退回了 dataset.kind（它根本不带 data-kind ⇒ 凭证又点不开了）',
      );
      // ④ 已放进槽的那张不再可拖（同一张不许占两处）
      t.ok(HTML.includes("if (c.classList.contains('placed'))"), '★★ 放进槽的凭证还能再拖一张到别的槽');
    });

    // ⚠️⚠️ 2026-10-06 清单第 4B 条：**「你的欲望」面板整块重做**，这一条随之改判。
    //   旧版是"地图区一张卡 ＋ 三个下拉 ＋ 一颗『按建议值』"；现在（用户裁定第 22 / 16 条）：
    //   · 唯一入口是**「你的欲望」那一屏**，四行卡槽 3/3/3/1（第 4 行是欲念值读数，不收凭证）；
    //   · 卡位放的是**凭证**（从手牌区拖进去），不是下拉选实体 id；
    //   · **`autoPlace` 与那颗『按建议值』按钮都删了**。
    t.test('★★「你的欲望」：四行卡槽 3/3/3/1 ＋ 凭证拖放 ＋ 只有最后一天能确定', () => {
      const HTML = readHtml();
      t.ok(!HTML.includes('id="pl成果"'), '★ 旧的三个下拉框已拆掉');
      // ① 四行，每行三个位（第四行是「如一的初衷」＝ 欲念读数，不收凭证）
      t.ok(HTML.includes('VSLOTS = { the_great_achievement: 3, the_proper_way: 3, the_resonance_of_the_other: 3 }'),
        '★★ 四行卡槽的槽数不对（用户原话：前三个 3 个，第四个只有 1 个且只显示欲念值）');
      // ⚠️ 判据**不写那一整行 HTML**（转义层数太多，写出来自己都对不上）⇒ 判那两个唯一的零件。
      t.ok(HTML.includes('vslot init'), '★★ 第四行「如一的初衷」不见了（它只有一个实时欲念读数，不收凭证）');
      t.ok(
        /如一的初衷/.test(HTML) && /欲念值只由规则层判/.test(HTML),
        '★★ 第四行没写清它是「由规则层判」的（玩家会以为能自己改）',
      );
      t.ok(HTML.includes('class="vnum"'), '★★ 第四行没有那个欲念值读数');
      // ② 卡位收的是**凭证**（`data-drop="voucher"` ＋ 维度），不是实体下拉
      t.ok(HTML.includes("data-drop=\"voucher\" data-vdim="), '★★ 卡位不是凭证槽（拖不进去）');
      t.ok(HTML.includes("if (d === 'voucher')"), '★★ `canDropOn` 不认凭证这一支');
      t.ok(HTML.includes("src.dim !== slot.dataset.vdim"), '★★ 凭证能跨行拖（成果的卡能进手段那行）');
      t.ok(HTML.includes("data-act=\"unplaceVoucher\""), '★★ 卡位上没有取回（×）');
      // ③ 「确定」只能最后一天
      t.ok(HTML.includes("const canConfirm = !!v.isFinalDay"), '★★「确定」没有"只有最后一天"这道闸');
      // ⚠️ 判据只认**两个词**（那一行的完整 HTML 含太多引号，写进判据自己都对不上）。
      t.ok(
        /确定（第 /.test(HTML) && /才能点/.test(HTML),
        '★★ 按钮的文案没写清为什么点不了（应写「第 N 天才能点」）',
      );
      // ④ **autoPlace 全删**（第 16 条）—— 连服务端那一处兜底也不许留
      t.ok(!HTML.includes('finishAuto'), '★★「按建议值」那颗按钮还在（第 16 条明说删掉）');
      t.ok(!HTML.includes('suggestedPlacements'), '★★ view 还带着"自动放格子"的建议值');
      t.ok(!HTML.includes('data-act="slotpick"'), '★ 旧的下拉候选通路还在');
    });

    // ── 第三轮（2026-09-20 · 信息排布）────────────────────────────
    //
    // 病是用**探针量的**（`.workbuddy/_probe-layout.py`）：第 28 天中栏 4450px 里，
    // 「已了结（50）」1517 ＋「回望（49）」1510 ＝ 3027px（68%）是**历史**，而右栏只用掉 699px、
    // 底下空着约 1100px。⇒ ① 三段历史都折叠；② 「已了结 / 回望」搬去右栏（右栏＝记事）。
    // 改完：中栏 1927 → 1431，右栏 699 → 1160，左栏 1254 → 1195（三栏落差 1228px → 271px）。
    t.test('★★ 画布只摆「今天出现、未处理、处理中的」—— 历史一律不留痕（2026-09-22 用户裁定）', () => {
      const cv = bodyOf('canvasHtml');
      t.ok(cv.includes('v.todo') && cv.includes('v.waiting'), '★ 只收这两池：待处理 ＋ 处理中');
      t.ok(!cv.includes('v.settled') && !cv.includes('v.recentSummaries') && !cv.includes('v.feed'),
        '★ 已结算 / 概要 / 播报都不上画布 —— 结算正文由那一次弹窗给过，不另存一份');
      t.ok(cv.includes('e.title') && !cv.includes('e.content'),
        '★ 卡面上**只有标题**（用户原话「地图上只需要出现事件的 title 就可以，点开后才看到详情」）');
      t.ok(cv.includes('data-act="detail"') && cv.includes('data-kind="event"'),
        '★ 点一下才展开 —— 走的是与左栏同一套 `detail` 浮层，不是另开一条路');

      const slots = bodyOf('canvasSlots');
      t.ok(slots.includes('hashOf'), '★ 摆位是 id 的**确定性**散列 ⇒ 重画（勾人 / 展开 / 读档）不跳位');
      t.ok(!slots.includes('location') && !slots.includes('stage'),
        '★ **不按地点分区**（用户裁定）—— 所以也不读 location / stage，《设定.md》:619「不搭地图系统」原样成立');

      // 弹窗抬头按「档 A（强制）」还是「结算」分流 —— 两句话不能混。
      // ⚠️⚠️ 2026-10-06 **修正一条过时断言**：这里原本写的是
      //    `t.ok(bodyOf('renderOverlay').includes('sheetEvent'), '画布点开走的是 sheetEvent')`。
      //    它**与 2026-10-05 的成文裁定矛盾** —— 那天的裁定是「**事件的详情不进浮层**」
      //    （用户实测：浮层盖着遮罩，底部手牌带拖不动；而 `canDropOn` 早就写好了，
      //      那条路事实上一直是断的）。⇒ 事件详情改**中栏同屏**（`renderMid` 里的 `evdesk`），
      //    `renderOverlay` 对事件**显式早退**、**故意不调** `sheetEvent`。
      //    ⚠️ 所以这条断言量的是"改回去之前的样子"，**不是**当前设计 ⇒ 改成量当前设计：
      //      · 事件 ⇒ `renderMid` 同屏（可拖）；
      //      · 结算正文 ⇒ 仍走 `popupResults` 那个弹窗队列。
      const mid = bodyOf('renderMid');
      // ⚠️⚠️ 2026-06 用户裁定（**推翻** 2026-10-05 那条「同屏处理台」）：
      //   「点开后应该是在**画面中间有一个额外的弹窗区，在地图层上方**，
      //     而不是显示在地图层上面」
      //   ⇒ 事件详情改**回浮层**（`renderOverlay` 里那一支），
      //     中栏**不再**画它 —— 地图完整、事件块不被挤。
      //   ⚠️ 10-05 关掉浮层的理由是「手牌带要保持可见可拖」，
      //     那条目标改由**浮层里自带迷你卡带**达成（见 `renderOverlay` 的注释）。
      t.ok(!mid.includes('evdesk'), '★ 事件详情**不再内嵌进中栏**（用户裁定：它该是地图上方的浮层）');
      const ovl = bodyOf('renderOverlay');
      t.ok(ovl.includes("kind === 'event'") && ovl.includes('evdesk'),
        '★ 它走 `renderOverlay` 那一支（画面中央的浮层）');
      // ⚠️⚠️ 2026-10-07 用户复验第 5 条：**浮层里那块「迷你卡带」整块撤掉了**。
      //   用户原话（带截图）：「人物卡拖拽后会出现这样莫名其妙的画面」。
      //   实测三个坏处：① 同一批卡在屏幕上出现两次；② 卡片竖着堆成一列
      //   （它给手牌串传的是**裸串**，外面那层横向轨道没套上）；
      //   ③ 白吃 122px —— 而矮屏上正缺这 122px（下 1/4 的「亲自去且仔细处理」被裁掉）。
      //   ⇒ 判据从「浮层里有手牌串」改成「**全屏幕只有一条轨道**」：
      //     手牌区那条（renderHand）是唯一一份，浮层不再自己画卡带。
      t.ok(!ovl.includes('handRailInner'),
        '★★ 浮层又自己画了一条迷你卡带（第 5 条：同一批卡不许在屏幕上出现两次）');
      const ov = bodyOf('renderOverlay');
      t.ok(ov.includes('popupResults'), '★ 结算正文走的是那一个弹窗队列（用户裁定「结算时弹一次」）');
      t.ok(
        ov.includes("detailOpen.kind === 'event'") && ov.includes('ov.classList.add(\'hidden\')'),
        '★ `renderOverlay` 对事件**显式让位**（早退 ＋ 收浮层）—— 那正是"同屏可拖"的落点',
      );
    });

    t.test('★ 折叠的契约：`folded` 只取**前 N 条** ⇒ 「该先看的排最前」是调用方的责任', () => {
      t.ok(bodyOf('folded').includes('slice(0, n)'), '折叠取的是**前 N 条** —— 配合"新在前"才是"最近 N 条"');
      // ⚠️ 画布轮之后，用折叠的只剩「人手」两栏，顺序是**名册序**（`v.people` 原样）——
      //    "最近"在名册上没有意义。那条契约因此**没有被删掉，只是不再有在用的时间序调用方**：
      //    它逐字写在 `folded` 顶栏（JSDoc 会被 `bodyOf` 剥掉，所以查原文）。
      t.ok(readHtml().includes('调用方必须先把'), '★ 契约仍写在 `folded` 顶栏：谁再拿它折时间序列表，就得先排好');
      // ⚠️ 2026-06：`folded('peopleOut', …)` 的调用点**又搬了一次**
      //    （`renderHand` → `leftHtml`，因为「手牌区也不需要尚未入队区」）⇒ 断言改指新位置。
      //    ⚠️ **`people` 那个键已随「人手」卡一起撤掉**（卡带里人手**横排不折叠**，
      //    只有「尚未入队」那组收在折叠钮后面 —— 11 张卡横铺本来就要滚动，
      //    再按"前 N 条"折一遍就等于把派人的对象藏起来了，那是另一种坏）。
      //    ⚠️ 折叠**只用于阅读那一组**；**已入队的人在卡带上永远横排不折叠**
      //    （那是派人的对象，藏起来就是另一种坏）—— 这条判据一个字没动。
      const where = bodyOf('leftHtml');
      // ⚠️⚠️ 2026-10-07 用户第 3 条（补核）：**「尚未入队」不再在地图上折叠/铺名单**，
      //   改成**一个入口卡**（点开进独立弹窗：左竖列概览 ＋ 右人物详情）。
      //   用户原话：「点开后进入独立弹窗，屏幕左侧是竖列的人物概览（**而不是和地图同级**）」。
      //   ⇒ 判据从"地图里含 `peopleOut`"改成两条：
      //     ① 地图里**有那个入口**（`kind="outsiders"`）；
      //     ② 地图里**不再铺名单**（`foldPeople('peopleOut'` 那个调用已撤）。
      //   ⚠️ 判据串**不写 `peopleOut` 裸词** —— 上面那段说明里就有它，会自己撞自己。
      t.ok(where.includes('data-kind="outsiders"'),
        '★★「尚未入队」那块不是独立弹窗的入口（用户第 3 条）');
      t.ok(!where.includes("foldPeople('peopleOut'"),
        '★★ 未入队名单还铺在地图上（用户第 3 条要的是独立弹窗）');
      t.ok(!readHtml().includes("folded('past'"), '★ 旧的三个历史折叠键（big / past / recall）已随右栏一起绝迹');
      t.ok(!readHtml().includes("folded('people'"), '★ 「已入队」那组**不再折叠** —— 卡带要能一眼扫完派人的对象');
    });

    // ⚠️⚠️ 2026-10-06 用户裁定：序幕不再问模型 ⇒ 人物描述改硬编码 ＋ 人物卡显示它
    t.test("★★ 人物卡显示形象描述（desc 字段）；旧欲望面板那条人物词条彻底绝迹", () => {
      const html = readHtml();
      const PAST_KEY = "v.desire." + "past";
      // ① 那个词条**必须消失**（它是欲望面板的旧物，字段已删）
      t.ok(!html.includes('他是怎样的人'), "★★ 旧欲望面板那条人物词条还在（对应字段 2026-10-06 已删）");
      t.ok(!html.includes(PAST_KEY), "★★ UI 还在读 desire.past（该字段 2026-10-06 已删）");
      // ② 人物卡**必须显示** desc（此前它只进 prompt，界面上一个字都不显示）
      t.ok(html.includes('他是个什么样的人'), '★ 人物卡没有形象描述那一段');
      const sp = html.indexOf('function sheetPerson');
      t.ok(sp > 0, '找得到 sheetPerson');
      const seg = html.slice(sp, sp + 3000);
      t.ok(seg.includes('p.desc'), '★★ sheetPerson 里没有渲染 p.desc —— 描述进不了界面');
      // ③ 标题与措辞（2026-10-06 同批裁定）
      t.ok(html.includes("sheetHead('你的欲望'"), '★「这一局」还没改成「你的欲望」');
      // ⚠️⚠️ 2026-10-06 清单第 4B 条：**「你的欲望」面板整块重做**（四行卡槽 ＋ 全平铺右栏），
      //   ⇒ 标题那两段现在走 `.evd-title`（右 1/3 那栏）而不是旧的 `.h`（第 10 条：**零折叠**）。
      t.ok(
        html.includes("<span class=\"nm\">你的手段</span>"),
        '★★「你的手段」不见了（欲望面板右栏 4 段之一，第 4B 条要全平铺）',
      );
      t.ok(
        html.includes("<span class=\"nm\">你的目的</span>"),
        '★★「你的目的」不见了（同上）',
      );
      t.ok(!html.includes('只看这一句'), '★ 局外 OOC 语言（只看这一句）还在');
    });

    // ⚠️⚠️ 2026-10-06 用户裁定：「为结局做**专门的全屏动画**，而不是简单的弹窗」
    t.test('★★ 结局有**独立全屏层**（不是复用 `#overlay` 那个弹窗）', () => {
      const html = readHtml();
      // ① 独立 DOM ＋ 独立 CSS ＋ 静止时 hidden
      t.ok(html.includes('id="endingscreen"'), '★★ 没有 #endingscreen —— 结局还在用弹窗');
      t.ok(html.includes('#endingscreen{position:fixed'), '★ 结局层没有全屏定位');
      t.ok(
        /id="endingscreen" class="hidden"/.test(html),
        '★ #endingscreen 静止时**必须**是 hidden（否则读档/标题屏会误播）',
      );
      // ② 层级高于弹窗（结局期间任何弹窗都压不过它）
      const z = html.indexOf('#endingscreen{');
      t.ok(z > 0, '找得到 #endingscreen 的样式块');
      const block = html.slice(z, z + 400);
      t.ok(block.includes('z-index:90'), '★★ 结局层 z-index 必须高于 #overlay 的 50');
      // ③ 两套主题各一份变量（照抄暗底那套会让纸面发脏）
      t.ok(html.includes('--ending-glow:#241a10'), '★ 暗底那套变量不见了');
      t.ok(html.includes('--ending-glow:#fdf7ec'), '★★ 亮底那套变量不见了');
      t.eq(
        html.split('--ending-glow:').length - 1, 4,
        '★ 两套主题 × 显式/@media 共 4 处（少一处 ⇒ 某个主题下结局层是黑的）',
      );
    });

    t.test('★★ 结局演出：标题先出 → 判词后到（两段式）＋ 可跳过 ＋ 只播一次', () => {
      const html = readHtml();
      const f = html.indexOf('function playEnding(');
      const g = html.indexOf('function endingSecondHalf(');
      t.ok(f > 0, '找得到 playEnding');
      t.ok(g > 0, '★★ 找得到 endingSecondHalf —— 成功结局的判词是异步的，没有第二段就只会播一段占位');
      // ① render() 里的触发点：两路（成功/失败 alike）
      t.ok(html.includes('if (v.isOver && v.ending) {'), '★ render() 里没有结局触发点');
      t.ok(
        html.includes('endingSecondHalf(e);'),
        '★★ 判词后到时没有补第二段（标题会一直配着占位字）',
      );
      // ② 只播一次的守卫（render 每次动作都会跑）
      const pf = html.slice(f, g);
      t.ok(pf.includes('if (endingPlayed || endingBusy) return;'), '★★ 少了"只播一次"守卫 ⇒ 每次动作都重播');
      t.ok(pf.includes('endingPlayed = true;'), '★ 播了之后没记账');
      // ③ 换局必须归零（不归零 ⇒ 第二局的结局永远播不出来，且**静默**）
      t.ok(
        /function resetLocalViewState\(\)\{[\s\S]{0,400}endingPlayed = false;/.test(html),
        '★★ resetLocalViewState 里没把 endingPlayed 归零 —— 开第二局时结局播不出来',
      );
      // ④ 可跳过：点一下 + 键盘（长文本不能只能靠鼠标）
      t.ok(pf.includes('el.onclick'), '★ 点一下不能跳过');
      t.ok(html.includes("document.addEventListener('keydown', onKey, true)"), '★★ 键盘不能跳过（无障碍）');
      t.ok(pf.includes('clearInterval(endingTyping)'), '★ 跳过后定时器没停');
      // ⑤ 逐字浮现
      t.ok(pf.includes('es-typing'), '★ 没有逐字浮现');
      t.ok(pf.includes('endingTyping = setInterval('), '★ 逐字浮现没有定时器');
      // ⑥ 系统词不进这一屏
      t.ok(!/es-sub[^]*风味/.test(pf), '★★ 结局屏里出现了"风味"这种系统词');
      t.ok(pf.includes('esc(e.name)'), '★ 结局名没进这一屏');
    });

    t.test('★ 结局屏支持 `prefers-reduced-motion`（动画晕的人也得看得见）', () => {
      const html = readHtml();
      t.ok(html.includes('@media (prefers-reduced-motion:reduce)'), '★ 没有 reduced-motion 兜底');
      // ⚠️ 判据**只认这一条**（`:important` 的那条）—— 别去数 animation-duration：
      //   reduced-motion 下动画时长归 1ms，但**逐字浮现的 span 是 JS 逐个加 class 的**，
      //   `animation` 归零**不会**让它们变可见 ⇒ 必须显式 `opacity:1!important`。
      //   少了这一行，开了"减弱动效"的人**永远看不到判词**（而且没有任何报错）。
      t.ok(
        html.includes('#endingscreen .es-text.es-typing > span{opacity:1!important}'),
        '★★ reduced-motion 下逐字浮现的 span 仍是隐藏的 ⇒ 判词看不见',
      );
    });

    // ⚠️⚠️ 2026-10-06 清单阶段三：四时段 ＋ 队列可见化（第 25 / 15 条）
    // ⚠️⚠️ 2026-10-07（用户裁定**改五段**）：「把上方的时间轴改成
    //   『现在是：早上/正午/下午/傍晚/深夜』——深夜不需要出现两次」
    //   ⇒ 0~4 五个读数各对一个时段；旧口径 3~4 点都读"深夜"作废。
    t.test('★★ 五时段（早上/正午/下午/傍晚/深夜）是**纯派生** ＋ 顶栏显示 ＋ 注入 LLM', () => {
      const html = readHtml();
      // ① 规则层有 `daypartOf`，且**只五个值**
      t.ok(html.includes('daypartOf'), '★★ 没有 daypartOf（五时段的派生函数）');
      // ⚠️ 五个值住在**规则层**（`rules/clock.ts·daypartOf`）⇒ 那儿才是判据的地方，
      //   界面只渲染 `v.daypart`。
      t.ok(daypartOf(0) === '早上', '★★ 0 点（刚开始）不是「早上」');
      t.ok(daypartOf(1) === '正午', '★★ 用掉 1 点不是「正午」（2026-10-07 五段口径）');
      t.ok(daypartOf(2) === '下午', '★★ 用掉 2 点不是「下午」');
      t.ok(daypartOf(3) === '傍晚', '★★ 用掉 3 点不是「傍晚」');
      t.ok(daypartOf(4) === '深夜', '★ 4 点用完**落在深夜**（五段口径：每个读数各有一名，深夜不再出现两次）');
      // ② 顶栏那句（用户原话：「把『第一章-正文』改成『现在是：早上/下午/傍晚/深夜』」）
      t.ok(
        html.includes("现在是：<b>' + esc(v.daypart"),
        '★★ 顶栏还没换成「现在是：…」',
      );
      // ③ 注入 LLM（用户原话：「这个时间也要在 LLM 结算事件时注入给它」）
      // ⚠️ 那句话在 **`prompt/blocks.ts`**（不在 index.html）⇒ 这里直接验它的输出。
      t.ok(
        currentStateBlock({
          clock: { day: 3, usedToday: 3 },
          scalars: { gold: 5, rep: REP0 },
          entities: { people: [{ id: PLAYER_ID, hp: 3, san: 3 }] },
        } as never).includes('现在是 傍晚'),
        '★★ 结算那路没注入时段（currentStateBlock 应当写出「现在是 傍晚」）',
      );
      // ④ **不是新存储字段** —— 判据是从"今天已用几点"算的
      t.ok(
        !html.includes('daypart: string;') && !html.includes('daypartDay'),
        '★ daypart 变成了存储字段（应当是纯派生）',
      );
    });

    // ⚠️⚠️ 2026-10-07 清单第 4 条（**口径更新**）：角落那枚「N 正在处理」徽标**撤掉** ——
    //   用户原话：「把这里莫名其妙的『正在处理』图像去掉」。状态由**每个事件块自己**
    //   在头上的 `.cvstat` 状态行说（见上一组测试），角落不再集中报数。
    t.test('★★ 队列可见化：状态长在**每个事件块**头上，角落徽标与弹窗都不做（第 4 / 15 条）', () => {
      const html = readHtml();
      // ① 旧徽标**不许回来**（清单第 4 条明说去掉）
      t.ok(!html.includes('class="cvqueue"'), '★★ 角落的「正在处理」徽标又回来了（清单第 4 条已撤）');
      // ② 每个事件块头上的状态行**在**（它是队列可见化的唯一呈现）
      t.ok(html.includes('function statusMark(e, live)'), '★★ 事件块头上的状态行没了（处理中／未处理）');
      t.ok(html.includes('处理中：还需 '), '★★ 「处理中：还需 y 点行动力」那档没写');
      // ⚠️ **明确不许有弹窗**（用户第 15 条：「不需要『已提交待揭晓 N 条』这个弹窗」）
      // ⚠️ 判据**不写那个被禁的整串**（写上去就自己撞自己）⇒ 拆成两段拼。
      // ⚠️ 判据只在 **index.html** 里找（`html` 就是它）⇒ 用**拼出来的**串，避开自撞。
      const 禁 = '已提交待揭晓' + ' N 条';
      t.ok(!html.includes(禁), '★★ 又把队列做成弹窗了（第 15 条明说不做）');
      t.ok(!html.includes('queueModal'), '★ 队列另有弹窗容器');
    });

    // ⚠️⚠️ 2026-10-06 清单第 5 条（**本轮最大的一块**）：事件处理台横向一屏
    t.test('★★ 事件处理台：横向一屏 ＋ 菱形槽 ＋ ×/✔ ＋ 处理方式互斥（12 个零件）', () => {
      const html = readHtml();
      const 检: Array<[string, string]> = [
        ['横向骨架 2fr 1fr（左 2/3 卡槽 ＋ 右 1/3 长方格）', '.evdesk{display:grid;grid-template-columns:2fr 1fr'],
        ['菱形复合槽本体', '.dia{position:relative'],
        // ⚠️⚠️ 2026-10-07 用户裁定：「卡槽格不可以和文字重合，菱形**拉宽**一点」。
        //   ⇒ 菱形弃掉 rotate(45deg)（旋转方案对角线只能等长，"拉宽"做不出来），
        //     改为 **SVG 宽菱形**（380×280 容器，横对角线 300／纵对角线 200），
        //     槽钉在四个尖端上、**天生是正的**（不再需要 rotate(-45) 转回来）。
        //   尖端坐标：(190,40)(40,140)(190,240)(340,140)，槽（80×80）中心对准 ⇒ left/top = 尖端 − 40。
        ['逆时针 ① 在菱形的「上」尖端 (190,40)',
          '.pslot[data-si="0"]{top:0;left:150px}'],
        ['逆时针 ② 在菱形的「左」尖端 (40,140)',
          '.pslot[data-si="1"]{top:100px;left:0}'],
        ['逆时针 ③ 在菱形的「下」尖端 (190,240)',
          '.pslot[data-si="2"]{top:200px;left:150px}'],
        ['逆时针 ④ 在菱形的「右」尖端 (340,140)',
          '.pslot[data-si="3"]{top:100px;left:300px}'],
        ['红必放槽中间写他的名字（5.5）', 'class="reqname"'],
        // ⚠️ 前缀只写 `.goldreq`（不带 `.dia `）—— CSS 里是 `.dia > .goldreq`，
        //   断言串若带 `.dia ` 就命中不了（多一个 `>`）⇒ 假红。
        ['钱槽在菱形**中心**（5.5）', '.goldreq{position:absolute'],
        ['属性实时读数（5.4）', 'class="evd-attrs"'],
        ['下框「×」（退出当前事件）', 'data-act="closeDetail"'],
        ['下框「✔」（确定以当前方式处理）', 'data-act="commit"'],
        ['两个处理方式按钮（5.6 互斥）', 'data-act="how"'],
      ];
      for (const [名, 串] of 检) {
        t.ok(html.includes(串), '★★ 事件处理台缺件：' + 名);
      }
      // ① 折叠**去掉了**（5.1：不需要再点开一次）—— 根节点上就是 `evdesk`，没有 `evhead` 折叠按钮
      // ⚠️ 2026-10-07（用户第 1 条）：连 `.card` 包装也去掉了（"去掉外面那层"）——
      //    `#modal.evdeskmodal` 自己是唯一那层框。
      t.ok(
        html.includes("return '<div class=\"evdesk\">'"),
        '★ 处理台根节点不是裸 `evdesk`（双层框没去掉？）',
      );
      // ② 处理方式**互斥**且**可取消**（再点一次回到"还没选"）
      t.ok(
        html.includes("p.handling === el.dataset.how ? ''"),
        '★★ 两个处理方式按钮不是互斥的（或不可取消）',
      );
      // ③ ✔ 的置灰与服务端同一个判据
      t.ok(html.includes('const okAll ='), '★ ✔ 的置灰判据不见了');
      //    ⚠️ 2026-10-07 晚间用户裁定（改）：**金币出闸** —— 「去掉没有放足量金币就不能
      //    点✔的约束……玩家可以尝试通过自然语言绕过原本要花的钱」。⇒ 闸里只剩
      //    「必放人物 / 处理方式 / canGo」，且 `goldOk` 不得以判据身份回来。
      t.ok(
        /needOk[\s\S]{0,200}howOk[\s\S]{0,120}canGo/.test(html),
        '★★ ✔ 的置灰判据里少了「必放人物 / 处理方式」中的一项',
      );
      t.ok(
        !html.includes('goldOk'),
        '★★ 金币仍在 ✔ 的置灰判据里（用户已裁定：不给钱也能点✔，交给 LLM 裁定）',
      );
      // ④ 「进多轮」要槽里有玩家自己（第 21 条）
      t.ok(
        html.includes('chosen.has(meId)'),
        '★★「亲自去且仔细处理」没要求槽里有玩家自己（第 21 条）',
      );
      // ④-b ⚠️ 2026-10-07（用户裁定·改）：note **只在「简略处理」那路必填** ——
      //    「亲自去」进场后自由对话，提交框那句用不上 ⇒ 点✔不该被它拦。
      t.ok(
        html.includes("const noteOk = how !== 'brief' || !!String(sel.note || '').trim();"),
        '★★ noteOk 没按"仅简略处理必填"的口径判（点「亲自去」后✔会被空 note 拦住）',
      );
      t.ok(
        html.includes('placeholder="选择简略处理时需要填写"') && html.includes("(how === 'brief' ? '' : ' disabled')"),
        '★★ 处理方式输入框没有按"选中简略处理才可输入"处理（占位文案 / disabled 缺一不可）',
      );
      // ④-c ⚠️ 2026-10-07（用户裁定）：「直接结算」**任何时候都可以点** ——
      //    不许再出现按 `isOver` 置灰的那种写法。
      t.ok(
        !/data-act="giveup"[^>]*disabled/.test(html),
        '★★「直接结算」带着 disabled 条件（用户裁定：任何时候都可以点）',
      );
      t.ok(
        html.includes('data-act="diceRoll"') && html.includes('data-act="diceGo"')
          && html.includes('点击画面进行投掷') && html.includes('查看结算结果'),
        '★★ 骰子动画弹窗缺了关键件（投掷区 / 查看结算结果 / 提示行）',
      );
      t.ok(
        html.includes('roll: f.roll || null') && html.includes('if (r.roll)'),
        '★★ 骰子弹窗没接上揭晓播报里的骰（collectResults / renderOverlay 两处都要认它）',
      );
      // ⑤ 属性数字**不是前端算的** —— 逐人的有效属性来自 view
      t.ok(
        html.includes('p.effectiveAttrs || p.attrs || {}'),
        '★★ 前端在重算属性（会与 gates.ts 漂）—— 应当读 view 上的 effectiveAttrs',
      );
      // ── 2026-10-07 第十四批 ─────────────────────────────────────
      // ⑥ 「处理中」的事件点开＝只读回看（ro 必须真的被传进去）
      t.ok(
        html.includes("cardHtml(busy, busy.status !== '待处理')"),
        '★★ 事件详情没接通只读回看（处理中的事件不该再出现 ✔ / 可编辑槽）',
      );
      // ⑦ 档 A 与常规事件同级：事件详情分支不再要求档 A 已清
      t.ok(
        /if \(detailOpen && detailOpen\.kind === 'event' && v && !popupResults\.length\) \{/.test(html),
        '★★ 事件详情仍被档 A 堵着（用户裁定：同级，档 A 不该挡点开常规事件）',
      );
      // ⑧ 属性实时读数 = 参与者最高值（不是相加），且带小字提示
      t.ok(
        html.includes('Math.max(v, (p.effectiveAttrs || p.attrs || {})[k] || 0)')
          && html.includes('属性取参与者对应属性的最高值'),
        '★★ 属性实时读数没改成「取参与者最高值」或缺小字提示',
      );
      // ⑨ 跨天揭晓的状态行要说真话（不再报「还需 0 点行动力」）
      t.ok(
        html.includes('处理中：第 ') && html.includes('天揭晓'),
        '★★ 跨天揭晓的事件状态行没有报「第 x 天揭晓」',
      );
      // ── 2026-10-07 第十五批 ─────────────────────────────────────
      // ⑩ 红色提醒只停 3 秒（档 A 未清那类 err 横幅自动退场）
      t.ok(
        html.includes("bannerTimer = setTimeout") && html.includes("}, 3000)"),
        '★★ err 横幅没有 3 秒自动退场（用户裁定：红色提醒只有 3 秒持续时间）',
      );
      // ⑪ 地图区底部的「招募人手 → 多线并行」出路提示
      t.ok(
        html.includes('cvrecruit') && html.includes('不妨试试招募人手'),
        '★★ 地图区缺「招募人手、多线并行」那条常驻提示',
      );
      // ⑫ 「N 件事在外面办着」大字号＋动效
      t.ok(
        /footer \.fhint\{[^}]*font-size:14px/.test(html) && html.includes('fhintPulse'),
        '★★ 「在外面办着」那行没加大字号 / 没带动效',
      );
      // ⑬ 恢复延迟生效：已有同名「处理中」单子 ⇒ 功能卡整张隐藏（防双卡同屏）
      t.ok(
        html.includes('arr(v.waiting).some((e) => e.title === sp.title)') && html.includes('到点 HP 回满'),
        '★★ 功能卡没有按「已有处理中单子」隐藏 / 文案没改成「到点生效」',
      );
      // ⑭ 功能单不被档 A 堵（与常规事件同级）
      t.ok(
        /if \(detailOpen && detailOpen\.kind === 'fix' && v && !popupResults\.length\) \{/.test(html),
        '★★ 功能单（医馆/神殿）仍被档 A 堵着',
      );
      // ── 2026-10-07 第十六批 ─────────────────────────────────────
      // ⑮ 钱槽不许再转 -45°（"× 变 ＋"的病根）：SVG 菱形方案里容器天生是正的
      t.ok(
        !/\.dia > \.goldreq\{[^}]*rotate\(-45/.test(html),
        '★★ 钱槽还带着 rotate(-45deg) —— 槽里的 × 被转成 ＋（用户实测）',
      );
      // ⑯ 点槽位取回必须走在 data-act 闸门**之前**（槽位不带 data-act，走闸门 = 死分支）
      t.ok(
        html.includes("ev.target.closest('.pslot.filled')"),
        '★★ 「点槽位取回」没有挂在 data-act 闸门之前（金币/人物撤不回来的病根）',
      );
      // ⑰ 金币串行：手牌卡与顶栏都读净额，`goldDropAmount` 也用 `haveGold()`
      t.ok(
        html.includes('function placedGold()') &&
        html.includes('rail.push(goldCard(haveGold()') &&
        html.includes('(v.gold || 0) - placedGold()') &&
        /const have = haveGold\(\);/.test(html),
        '★★ 金币没有串行化（placedGold / 手牌净额 / 顶栏净额 / 拖放净额 四处缺一）',
      );
      // ⑱ 「非他不可」红槽旁写「xx必须要去」
      t.ok(
        html.includes("必须要去</span>") && html.includes('.reqtag{'),
        '★★ 红槽旁缺「xx必须要去」的明确提示',
      );
      // ── 2026-10-07 第十七批（场景对话流式）─────────────────────
      // ⑲ LLM 气泡淡黄（比消息背景深一些）—— 用 --gold 混 --panel，不写死色值
      t.ok(
        /\.bub\.llm\{[^}]*color-mix\(in srgb, var\(--gold\)[^}]*var\(--panel\)/.test(html),
        '★★ LLM 气泡没有改成淡黄（.bub.llm 的 background 要用 --gold 混 --panel）',
      );
      // ⑳ 「说这一句」走 sayStream：玩家话立显 ＋ SSE 流式打字 ＋ done 信封收官
      t.ok(
        html.includes('await sayStream(text)') &&
        html.includes('async function sayStream(text)') &&
        /me\.className = 'bub me';[\s\S]{0,120}cb\.appendChild\(me\)/.test(html) &&
        /res\.body\.getReader\(\)/.test(html) &&
        html.includes('adoptPayload(doneEnv)'),
        '★★ 场景对话没有接流式（sayStream 缺玩家立显 / SSE 读流 / done 收官 之一）',
      );

      // ㉑ 2026-10-07 用户 bug：「每次进入存档都重刷序幕假事件的结算结果」——
      //    读档那一次必须**只对齐游标不重播**（skip 标记挂在 loadGame 调用点上，
      //    且 resetLocalViewState 要清它，防读档失败后误吞下一局的序幕结果）。
      t.ok(
        html.includes('let feedCursorSkipOnce = false;') &&
        /feedCursorSkipOnce = false; feedShown = arr\(S\.feed\)\.length;/.test(html) &&
        /act === 'loadGame'[\s\S]{0,600}feedCursorSkipOnce = true;/.test(html) &&
        /resetLocalViewState\(\)\{[\s\S]{0,1400}feedCursorSkipOnce = false;/.test(html),
        '★★ 读档历史重播未修（skip 标记 / adopt 分支 / loadGame 置真 / 回标题清零 之一缺失）',
      );

      // ㉒ 2026-10-07 用户 bug：「人还没结算就回来 / 换开别的事件手牌跟着变」——
      //    deskUsedIds 必须是**全局口径**（不看 detailOpen）：
      //    ① 扫全部 picks / fixPicks（页面态：放着还没交的）；
      //    ② 扫 v.waiting 的 handler ＋ participants（账面态：已提交未揭晓，
      //       点 ✔ 后 picks 已清，靠这半边知道"他还在外面"）。
      // ⚠️ 2026-10-08 口径升级（用户报告「结算后要刷新才看到人回来」）：
      //    ①页面态只收**活着的事件**——commit 成功后 picks[evId] 刻意保留（回看），
      //    事件已揭晓、离开 todo/waiting/popups 三池的不得再收 ⇒ picks 循环须以
      //    alive 集合过滤（alive 从三池构建）。距离上限从 900/1300/1600/1800 放宽
      //    到 3000/4000：函数头的历史注释（两轮 bug 修复说明）已超千字符。
      t.ok(
        /function deskUsedIds\(\)\{[\s\S]{0,3000}for \(const e of arr\(v\.todo\)\) alive\.add\(e\.id\)/.test(html) &&
        /function deskUsedIds\(\)\{[\s\S]{0,3000}for \(const e of arr\(v\.waiting\)\) alive\.add\(e\.id\)/.test(html) &&
        /function deskUsedIds\(\)\{[\s\S]{0,3000}for \(const e of arr\(v\.popups\)\) alive\.add\(e\.id\)/.test(html) &&
        /function deskUsedIds\(\)\{[\s\S]{0,3000}for \(const id in picks\)[\s\S]{0,200}alive\.has\(id\)/.test(html) &&
        /function deskUsedIds\(\)\{[\s\S]{0,4000}for \(const fp in fixPicks\)/.test(html) &&
        /function deskUsedIds\(\)\{[\s\S]{0,4000}e\.handler/.test(html),
        '★★ deskUsedIds 退回了旧口径：页面态未按 alive 三池过滤（结算后人不回来）或缺全局扫描（人提前回来 / 换卡手牌变化复发）',
      );
      t.ok(
        !/function deskUsedIds\(\)\{[\s\S]{0,200}detailOpen && detailOpen\.kind === 'fix'/.test(html),
        '★★ deskUsedIds 里还有 detailOpen 依赖（换开别的事件手牌会变）',
      );

      // ㉓ 2026-10-07 用户 bug：「方框符号旁边有莫名其妙的空格」——
      //    LLM 散文里的半角空格/被甩到行首的后引号原样渲染。
      //    净化器 tidyProse 必须存在，且 segline（结算正文）与 escProse（各散文口）都接上。
      t.ok(
        html.includes('function tidyProse(s)') &&
        /const escProse = \(s\) => esc\(tidyProse\(s\)\);/.test(html) &&
        /function segmentHtml\(text, cls\)\{[\s\S]{0,120}tidyProse\(text\)/.test(html) &&
        (html.match(/escProse\(/g) || []).length >= 5,
        '★★ 散文净化器没接上（tidyProse / escProse / segmentHtml 之一缺失）',
      );

      // ㉔ 2026-10-08 用户裁定（**装备统一口径**，取代上一版"两半拆分"）：
      //    物品卡从一个人身上拖下来，**无论落到哪（包括另一个人身上）都只能回手牌区**
      //    （收回）；"给出去"只能从**手牌区的物品卡**发起（拖到手牌区人物卡 / 展开人物卡）。
      //    ⇒ 卡级候选只认「我自己的东西」；别人的东西落到任何卡上都落穿到带子 ＝ 收回。
      t.ok(
        /const cardHit = under && under\.closest\('\.hcard\[data-to-whom\],\.pcard\[data-to-whom\],\.icard\[data-to-whom\]'\);/.test(html) &&
        /dragSrc\.kind === 'item' && !dragSrc\.holder && cardHit/.test(html) &&
        !/cardHit\.dataset\.toWhom === myId/.test(html),
        '★★ 物卡落点仍会被卡级 data-to-whom 半路截走（从人身上拖下的东西没有一律回手牌区）',
      );
      // ㉕ 2026-10-08（**无人携带**）：拖回手牌区＝摘下，没有携带位上限，
      //    拒绝只剩一种 —— 它本来就没在任何人身上。旧话术（"已经在你手上了"）
      //    是"玩家=艾德里安、卡带=他的物品栏"旧模型的产物，整句废除。
      t.ok(
        html.includes('这件没有装备在任何人身上 —— 它就在手牌区') &&
        !html.includes('这件已经在你手上了'),
        '★★ 拖回手牌区的拒绝话术还是旧口径（应只有"已在手牌区"一种拒法）',
      );
      // ㉖ 2026-10-08 用户裁定（**装备统一口径**＋**无人携带**）：装备只有一条路 ——
      //    **手牌区物卡（holder=null）→ 人物卡**（手牌区人物卡 / 展开人物卡）。
      //    canDropOn 的槽级（.islot 换位）/卡级分支必须认 `!holder`；事件人位不再接物卡；
      //    拒绝提示要指路"先摘回手牌区"。
      t.ok(
        /if \(src\.holder === slot\.dataset\.slotwho\) return true;/.test(html) &&
        /!src\.holder && canGiveTo\(src\.id, slot\.dataset\.slotwho\)/.test(html) &&
        /!src\.holder && canGiveTo\(src\.id, slot\.dataset\.toWhom\)/.test(html) &&
        html.includes('先拖回手牌区，再从手牌区的物品卡拖给要给的人') &&
        !/data-to-whom="' \+ carryTo/.test(html),
        '★★ 装备统一口径没落地（槽级/卡级落点没有"无人携带"闸 ／ 人位还挂着死的 data-to-whom ／ 拒绝提示没指路）',
      );
      // ㉗ 2026-10-08 用户第 2 条：事件台**没点 ✔ 就退场 ⇒ 台面全清**
      //    （×／点遮罩／直接点开别的卡／去自建／去下一天，人物卡与金币全回手牌区；
      //    点 ✔ 的两条路不在此列 —— 要么已扣账、要么刻意留作回看）。
      t.ok(
        /function discardDeskPicks\(\)\{/.test(html) &&
        /if \(act === 'closeDetail'\) \{[\s\S]{0,200}discardDeskPicks\(\)/.test(html) &&
        /id === 'overlay'\) \{ discardDeskPicks\(\)/.test(html) &&
        /act === 'detail'\) \{[\s\S]{0,200}discardDeskPicks\(\)/.test(html),
        '★★ 事件台退出没有统一清台面（没点 ✔ 的摆卡不该被记住）',
      );
      // ㉘ 2026-10-08 用户裁定：卡带物卡 ＝ **无人携带**（holder=null）的东西；
      //    谁身上的（含玩家自己那张卡）只在人物卡 @n 与详情页卡槽里看。
      t.ok(
        /const handItems = arr\(v\.items\)\.filter\(\(it\) => !it\.consumed && !it\.holder\)/.test(html) &&
        /data-holder=""' \+/.test(html) &&
        !/data-to-whom="npc000"' \+/.test(html),
        '★★ 卡带物卡还挂在"玩家物品栏"旧模型上（应渲染无人携带的东西）',
      );
    });

    // ⚠️⚠️ 2026-10-07（用户报告四条：物品乱 / 放不上人 / 吞金币 / 空态顶掉欲望）
    t.test('★★ 物品一致性 ＋ 放置原因 ＋ 金币净额 ＋ 空态台面（五处接线）', () => {
      const html = readHtml();
      // ① 金币净额：placedGold 只数「待处理」的台面 —— 已提交的钱服务端已扣，不得重复减
      t.ok(
        /function placedGold\(\)\{[\s\S]{0,700}ev\.status !== '待处理'[\s\S]{0,200}continue;/.test(html),
        '★★ placedGold 没按事件状态过滤（提交后的钱被双扣 ⇒ 吞金币）',
      );
      // ② 空态也要完整台面：leftHtml（欲望/最终任务 ＋ 未入队）住在 .canvas-pan 里
      t.ok(
        /leftHtml\(v\)[\s\S]{0,400}这会儿没有摆在你面前的事。/.test(html),
        '★★ 空态没挂 leftHtml（欲望与未入队被顶掉）',
      );
      // ③ 拖放拒绝要说人话：dropBlockReason 存在且接在松手失败分支上
      t.ok(
        html.includes('function dropBlockReason(slot, src)') &&
        /} else if \(dropHit\) \{[\s\S]{0,300}dropBlockReason\(dropHit, src\)/.test(html),
        '★★ 拖放被拒时不给原因（玩家只能一遍遍试）',
      );
      // ④ 必放位只收那位本人：required_person 未进场时 ① 号位拒收别人
      //    ⚠️ 2026-10-08 订正：canDropOn 里变量叫 `ev`，旧断言锚住的 `e.requiredPerson`
      //    是个**不存在的变量** ⇒ 每次拖人卡进事件槽都 ReferenceError（被 try/finally
      //    吞掉）⇒ 所有事件槽放不进任何人。守卫连同负向检查一起钉死 `ev.`。
      t.ok(
        /ev\.requiredPerson && slot\.dataset\.sloti === '0' &&[\s\S]{0,200}src\.id !== ev\.requiredPerson\.id/.test(html) &&
        !/[^v]e\.requiredPerson && slot\.dataset\.sloti/.test(html),
        '★★ ① 号位"非他不可"的拖拽判据缺失或又写回不存在的 `e`（拖人卡必抛错 ⇒ 全部放不上）',
      );
      // ⑤ 2026-10-08（用户裁定「在身上时会有对应的词条效果」）：我的卡也画物品词条。
      //    旧口径"我带的东西以物卡身份排在卡带上"已随「无人携带」改动失效 ——
      //    手牌区只画 holder 为空的物品 ⇒ 我带着的不再出现在卡带上，
      //    词条成了卡面上唯一可见的携带痕迹（负向检查同时钉死旧口径别回来）。
      t.ok(
        html.includes('const itemTags = (!gone ? arr(p.items).map(function (it) {') &&
        !html.includes('const itemTags = (!gone && !isMe ?'),
        '★★ 我的卡没有物品词条（无人携带后我带的东西不在卡带上，词条是唯一可见痕迹）',
      );
    });

    // ⚠️⚠️ 2026-10-06（用户裁定问题 8：「事件在地图上的显示很奇怪，**部分事件的图层会重叠**」）
    t.test('★★ 地图摆位：高度**由摆位反推**（不再按条数均分）—— 不重叠的根因已除', () => {
      const html = readHtml();
      const a = html.indexOf('function canvasSlots(');
      t.ok(a > 0, '找得到 canvasSlots');
      // ⚠️⚠️⚠️ **不要用固定长度的窗口**（2026-10-07 踩了两次）：
      //   `slice(a, a + 2600)` 那种写法在算法重写后立刻变成**假红**
      //   （判据在"算法还没写到那儿"的位置上判）⇒ 我为此两次以为"代码没生效"。
      //   ⇒ 改成**按大括号配对抽整个函数体**，长度变化不再影响任何一条判据。
      const seg = (() => {
        const open = html.indexOf('{', a);
        let d = 0, inS = '', i = open;
        for (; i < html.length; i++) {
          const c = html[i];
          if (inS) { if (c === inS && html[i - 1] !== '\\') inS = ''; continue; }
          if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
          if (c === '/' && html[i + 1] === '/') { while (i < html.length && html[i] !== '\n') i++; continue; }
          if (c === '{') d++;
          else if (c === '}') { d--; if (d === 0) return html.slice(a, i + 1); }
        }
        return html.slice(a, a + 6000);
      })();
      // ① 旧算法那句（按条数均分每行高度）**必须不在了** —— 它就是不重叠的根因
      t.ok(
        !seg.includes('100 / rows'),
        '★★ `canvasSlots` 里还有 `100 / rows`（按条数均分）⇒ 那是重叠的根因，没除掉',
      );
      t.ok(
        !seg.includes('chh = 100 / rows'),
        '★★ 还有 `chh = 100 / rows` 那一行',
      );
      // ② 新算法：按**标题字数**估卡高
      t.ok(seg.includes('function cardH(id)'), '★ 没有按标题估卡高的 cardH');
      t.ok(seg.includes('tallest'), '★ 没取这一批里最高的卡（用平均值会在一长一短时算矮）');
      t.ok(seg.includes('rowMid'), '★★ 没有「该行中心」这个量 ⇒ 同行高矮不一的卡会错开');
      // ③ 画布高度与摆位**同源**（同一个 slotH × rows）
      // ⚠️ 2026-10-07：高度改成读算法报的 **`needH`**（「至少要这么高才装得下」）——
      //   事件多到一屏放不下时它会大于台面，调用处拿它当高度、页面出滚动条，
      //   而**不是**把所有卡挤进现有高度里叠着。
      t.ok(
        html.includes('const H = Math.max(240, slots.needH ||'),
        '★★ 画布高度不再由摆位算法的结果反推 ⇒ 它与摆位又变成两份各算的',
      );
      t.ok(
        seg.includes('needH: padT + padB + realRows * slotH'),
        '★★ 算法没有报 needH（"至少这么高才装得下"）⇒ 事件一多就会叠在一起',
      );
      t.ok(!html.includes('slots.rows * 150'), '★ 旧那句 `rows * 150` 还在（那是重叠的第二个来源）');
      // ④ 调用处要把 titles 传进去（不传就全按最短估）
      // ⚠️ 2026-10-07：调用签名多了**台面宽高**两个参数（位置要限制在长方格内），
      //   判据因此从"三个实参"改成"**四五个都传了**，且宽高来自 `colMid.clientWidth`"。
      //   ⚠️ 2026-10-07 晚：第五个实参（`opts`，档 A 大牌的尺寸档／`topOffset`）
      //     加入 —— 正则按这条注释**本来的意思**放宽成「第四参之后可选跟一个对象字面量」。
      t.ok(
        /canvasSlots\(items\.map\(function \(e\) \{ return e\.id; \}\), titleOf, CANVAS_W, \w+(, \{[^}]*\})?\)/.test(html),
        '★★ 调用处没把 titles ＋ 台面宽高都传进去 —— 长标题那几张照样会叠、也照样会贴边',
      );
      t.ok(
        html.includes("const CANVAS_W = Math.max(360, CW - 28);"),
        '★★ 台面宽度不是从 `colMid.clientWidth` 读的 ⇒ 换窗口大小就会排错',
      );
    });

    t.test('★ 折叠状态是**页面上的临时状态** —— 回标题屏 / 读档必须清掉', () => {
      // ⚠️ 这条断言**踩过一次「判据自己写死了清单」**（2026-09-20）：原来逐字匹配整段
      //    `histMore = { settled: 0, recall: 0, feed: 0, people: 0 }`。本轮给左栏
      //    「人手」补了一栏折叠（加键 `peopleOut`）⇒ 命中数当场 2 → 0，
      //    **而它报出来的是"漏了清空"** —— 一句跟真凶完全无关的话，会把人往错的方向带。
      //    ⇒ 现在不许把键清单写死：**数份数 ＋ 比两处字面量 ＋ 拿 `HIST_BASE` 对键集**。
      //    加键不再误伤；漏同步（只改一处）／加了折叠栏忘加键，照样抓得住。
      const HTML = readHtml();
      const segs = HTML.split('histMore = {');
      t.eq(segs.length - 1, 2, '一处声明 ＋ 一处清空（少了清空 ⇒ 读另一局回来还带着上一局展开的清单）');
      const lits = segs.slice(1).map((s) => s.slice(0, s.indexOf('}')));
      t.eq(lits[1], lits[0], '★ 两处字面量**逐字一致** —— 只改一处，漏掉的那个键会让那一栏的「展开」按钮点不动');
      // 键集必须与 `HIST_BASE`（默认条数表）一致 —— 它俩是同一批折叠栏的两份登记，
      // 分头长出来就会得到"能展开但基准是 undefined"的半死状态。
      const keysOf = (s) => (s.match(/[A-Za-z_][A-Za-z0-9_]*\s*:/g) || []).map((k) => k.replace(/\s*:$/, ''));
      const hbSeg = HTML.split('HIST_BASE = {')[1] || '';
      const hb = keysOf(hbSeg.slice(0, hbSeg.indexOf('}'))).sort().join(',');
      t.eq(keysOf(lits[0]).sort().join(','), hb, '★ 键集与 `HIST_BASE` 对齐 —— 加了折叠栏却忘了加键，那栏的基准值就是 undefined');
      t.ok(HTML.includes('data-act="moreHist"'), '折叠栏点得动（走 document 上的那个委托）');
      t.ok(HTML.includes('histMore[k] = '), '那一下会改状态并重画');
    });

    t.test('★ 人手折叠的是「尚未入队」那组 —— 它是**阅读用**的，派谁去时每条待办自己会列全', () => {
      // ⚠️ 2026-10-05 布局重构：人手沉到**底部手牌带**（`renderHand`），
      //    「已入队」那组横排不折叠（卡带要能一眼扫完派人的对象），
      //    只有「尚未入队」那组收在折叠钮后面。
      // ⚠️⚠️ 2026-10-06 **第三次**搬（**意图一字未动**：「尚未入队」那组是**阅读用**的、
      //   折叠状态要与别处**共用同一份**）。用户裁定「手牌区也不需要尚未入队区」
      //   ⇒ 折叠点从 `renderHand`（卡带右端那颗钮）搬到了 **`leftHtml`**（地图区那块）。
      //   ⇒ 判据跟着改**查哪个函数**；**契约本身（`folded` 取前 N 条、共用 `histMore.peopleOut`）一字未动**。
      // ⚠️⚠️ 2026-10-07 用户第 3 条：这一组**改成独立弹窗**之后，地图上**不再有**它的折叠点。
      //   ⇒ 断言换成"**弹窗入口在、旧折叠点不在**"。
      //   ⚠️ `moreHist` 那颗钮由**其余**折叠栏继续用 ⇒ 它在整页里仍然存在，
      //      **不该**断言它消失（那是另一件事）。
      const where = bodyOf('leftHtml');
      t.ok(where.includes('data-kind="outsiders"'),
        '★★「尚未入队」不是独立弹窗的入口（用户第 3 条：独立弹窗、左竖列概览）');
      t.ok(!where.includes("foldPeople('peopleOut'"),
        '★★ 未入队名单还铺在地图上（用户第 3 条要的是独立弹窗）');
      t.ok(readHtml().includes('data-act="moreHist"'), '折叠钮走 document 上那个共用委托（不另开一条路）');
      // ⚠️ 2026-06 订正上一版（我把它查错了地方）：`histMore.peopleOut` 这个键
      //   **不在 `leftHtml` 里** —— 折叠状态由 `folded()` **自己**去读
      //   （调用方只给键名与条目）⇒ 该查 `folded`。
      t.ok(bodyOf('folded').includes('histMore'),
        '★ 展开状态由 `folded()` 自己读 `histMore` —— 同一份状态不许分两处记');
      // ⚠️ 2026-06：rail 的组装已抽进 `handRailInner`（浮层要画同一份）⇒ 查那处。
      t.ok(!bodyOf('handRailInner').includes('peopleOut'),
        '★ 手牌区**不再有**未入队区（用户裁定）—— 卡带里只剩牌');
    });

    // ── 布局重构（2026-10-05）· 底部手牌带 ───────────────────────────
    //
    // 用户裁定（截图实测后的三条要求）：
    //   ① 「**主角也应当可以拖拽，待遇其实和其余下属差不多**」
    //   ② 「左栏是没有文字的」—— 学《苏丹的游戏》：手牌沉底，地图当主体
    //   ③ 「金币物品等也是卡片（有的隐藏了，可以再展开）」
    //
    // ⚠️ 这三条**全是呈现层的**，所以断言必须钉住"它们还在"，而不是钉住某个 DOM 形状
    //   （钉形状的话下一次微调就假红）。下面每条都指向**语义**而不是 class 名。
    t.test('★★ 主角与下属**同一种卡、同样可拖** —— 待遇一样，只有两处标记不同', () => {
      // ⚠️ 2026-06：rail 的组装已抽进 `handRailInner`（事件详情改浮层，浮层里那块
      //   **迷你卡带**要画**同一份**）⇒ 判据跟着改查那处，**意图一字未动**。
      const hand = bodyOf('handRailInner');
      // ① 主角走的是**同一个函数** `handCard(me, true)`，不是另一条渲染路径
      t.ok(hand.includes('handCard(me, true'), '★ 主角用的是 `handCard` —— 与下属同一个函数');
      // ⚠️ 2026-10-05（第五轮）这里改过一次：原来逐字匹配
      //    `for (const p of joined) rail.push(handCard(p, false`
      //    ⇒ 第五轮给这一行**加了 `if (!isGone(p))` 过滤**（死亡/疯狂的人排到卡带末尾），
      //    字面量对不上就红了。
      //    ⇒ 判据改成两件事分开问：**同一个函数** ＋ **过滤只针对"没了的人"**。
      //      （这比原来的逐字匹配更强：它同时钉住了"过滤存在"与"过滤的判据是 isGone"。）
      t.ok(hand.includes('for (const p of joined)') && hand.includes('handCard(p, false'),
        '下属也是同一个 `handCard`（只是第二个参数不同）');
      //   ⚠️ 2026-10-07：这一行又加了一个过滤条件（**已经放进处理台的人也收起**，
      //      用户第 5 条：「人物卡使用后，并没有在手牌区消失」）⇒ 不再逐字匹配整行，
      //      改成钉住**语义**：那个循环还在、isGone 那道过滤还在、下面还是同一个 handCard。
      t.ok(hand.includes('for (const p of joined) if (!isGone(p)') && hand.includes('handCard(p, false'),
        '★ 那一行过滤的是**死亡/疯狂的人** —— 他们排到卡带末尾，不与"我的人"混排');
      // ② 拖拽源**包含手牌卡**（`.hcard`），而 `.hcard.me` 同样带 `data-kind`
      t.ok(readHtml().includes(".hcard[data-kind],.pcard[data-kind],.icard[data-kind]"),
        '★ 拖拽源认手牌卡；主角那张也带 `data-kind` ⇒ 一样能拖');
      // ③ 差别只有"标记"（金边 ＋ 「我」角标），**不是形状/尺寸/可否拖**
      t.ok(readHtml().includes('.hcard.me{border-color:'), '主角多的只是那圈金边');
      t.ok(readHtml().includes(".hcard.me::after{content:'我'"), '★ 另有一个「我」角标 —— 防止玩家误把自己派出去');
      // ④ 两条路的落点判据**仍是同一个** `canDropOn`（不许给主角开特例）
      const drop = bodyOf('canDropOn');
      t.ok(!drop.includes('PLAYER') && !drop.includes("id === 'npc000'"),
        '★ `canDropOn` 里没有"主角特例" —— 他与别人走同一条判据');
    });

    t.test('★★ 手牌是**横向卡带**，不是换行铺开（11 个人横铺会占三屏）', () => {
      const HTML = readHtml();
      t.ok(HTML.includes('.hand-rail{'), '卡带有自己的容器');
      t.ok(HTML.includes('overflow-x:auto'), '★ 横向滚动（不换行）—— 换行会把地图挤到看不见');
      // 主角那张**不带**特殊尺寸类：`.hcard` 只有一个宽度，`.hcard.item` 才是窄的
      const css = HTML.slice(HTML.indexOf('.hcard{'), HTML.indexOf('.hcard.item{'));
      t.ok(!/\.hcard\.me\{[^}]*width/.test(css), '★ 主角那张**不比别人宽**（宽窄只由"是不是物"决定）');
    });

    t.test('★ 左栏瘦身：只留需要竖排阅读的，撤掉的三张卡去了手牌带', () => {
      // ⚠️ 2026-10-06：`renderLeft` → `leftHtml`（左栏元素已 `display:none`，
      //   内容搬进中栏；见「最终任务清单全周常驻」那条断言的说明）。
      const left = bodyOf('leftHtml');
      // ⚠️ 2026-10-06：清单已并进 `missionBlock`（见上面那条断言的说明）⇒ 这里只验"在场"。
      t.ok(left.includes('missionBlock(v)'),
        '★ 清单仍在场（与欲望合并成同一块）—— 玩家要在整局里看着它长');
      t.ok(!left.includes('isFinalDay'), '它仍不许跟终局绑在一起');
      // 撤掉的三张：都不许再在左栏出现（它们已经沉到底部）
      t.ok(!left.includes('手外之物') && !left.includes('身外之物'), '★ 「身外之物」已沉到手牌带');
      t.ok(!left.includes('<h3>人手'), '★ 「人手」那一栏已沉到手牌带');
      t.ok(!left.includes('<h3>三王子'), '★ 「三王子」那张卡已沉到手牌带（主角现在在手牌第一张）');
      // 而它们**确实**在手牌带里 —— 不是"删掉了信息"
      // ⚠️⚠️ 2026-10-06 **第二次**改判据（**意图一字未动，位置又走了一次**）：
      //    第一版钉的是「`renderHand` 里有 `handItemCard` ＋ `arr(me.items)`」；
      //    第二版改成「物贴在人卡下（`.carryrow`）」（用户当时要"缩小插入到人物卡上"）。
      //    **用户随后又改了裁定**：「不需要在人物未展开的状态下出现，
      //    人物卡展开后再显示携带的物品就行」—— 而那条改动的**真实原因**是
      //    它**盖住人卡 ⇒ `closest('[data-act]')` 先命中小卡 ⇒ 人卡点不开**；
      //    并且未入队者的卡不带 `data-kind` ⇒ **他身上的东西连拖都拖不动**，
      //    而「交给别人」**只能靠拖**（`/api/give`）。
      //    ⇒ 最终形态：**物卡是卡带上的独立卡**（`handItemCard`，带 `data-kind="item"`
      //    与 `data-to-whom`），**不再**贴在人卡下；「他带了什么」在**详情浮层**
      //    （`sheetPerson` 的「携带」一节，列全 名字/加成/是否生效）里看。
      //    ⇒ 判据第三次跟着改。**这条断言跟着实现改了三次，本身是个信号**：
      //    它说明"物品该放哪"这件事**三易其位**仍未真正定死
      //    （下轮若再改，这里要再改一次 —— 那就该停下来想清楚，而不是再改判据）。
      const item = bodyOf('handItemCard');
      // ⚠️ 2026-06：rail 的组装抽成了 `handRailInner`（事件详情改浮层后，
      //   浮层里那块**迷你卡带**要画**同一份** rail ⇒ 一处组装、两处呈现）。
      //   ⇒ 判据从「`renderHand` 里有」改成「`handRailInner` 里有」，
      //   并**额外钉住它被真的调用**（否则它可能变成没人用的孤儿函数 ⇒ 卡带空白）。
      const railFn = bodyOf('handRailInner');
      t.ok(railFn.includes('handItemCard'), '★ 物是**卡带上的独立卡**（不是人卡的附属小片）');
      t.ok(bodyOf('renderHand').includes('handRailInner(v)'),
        '★ 且 `renderHand` 真的调它（底部卡带不是空的）');
      // ⚠️ 2026-10-08（无人携带）：卡带物卡取的是**全表里没人拿着的**（`!it.holder`）
      //    —— 不再是 `me.items`（"卡带=玩家物品栏"的旧模型已废，见守卫 ㉘）。
      t.ok(railFn.includes('arr(v.items).filter((it) => !it.consumed && !it.holder)'),
        '主角手上的东西取的是 `v.items` 里**无人携带**的（不是某个人 `p.items`）');
      t.ok(item.includes('data-kind="item"'), '★ 它是**可拖的源**（带 `data-kind="item"`）—— 否则交不了给任何人');
      t.ok(item.includes('data-holder'), '带 `data-holder=""`（无人携带：拖拽源要知道它没在任何人身上）');
      t.ok(!bodyOf('handCard').includes('miniItems') || !bodyOf('handCard').includes('carryrow"'),
        '★ 人卡上**不再画**携带物（那是"点不开"的成因）；它在浮层里看');
    });

    // ── 第四轮（2026-09-20 · 并发）────────────────────────────────
    //
    // 服务端加了**串行闸**（`ui/gate.ts`：同时只准一个动作，撞上来的回 `409`）
    // ⇒ 客户端必须**认得出非 200**。此前不判 `r.ok` 就直接 `S = payload`：
    //    那一份错误体里**没有 `screen`**（信封的必要字段之一）⇒ `render()` 拿着一个
    //    "不是信封的对象"去画，页面上什么都刷不出来 —— 玩家看到的是"点了没反应"，
    //    而不是"服务器说它忙"。
    t.test('★★ 非 200 只贴话术、**不动视图**：判 `r.ok` 的半边不许碰 `S = payload`（2026-10-07 队列化后发送/接收分家）', () => {
      const api = bodyOf('api');
      const adopt = bodyOf('adoptPayload');
      t.ok(api.includes('r.ok'), '★ 认出非 200（撞闸是 409）');
      t.ok(adopt.includes('S = payload'), '★ 接信封住在 `adoptPayload`（口径只有这一份）');
      t.ok(!api.includes('S = payload'), '★ `api` 发送半边不许直接碰视图 —— 错误体绝不能当信封用');
      t.ok(api.includes('r.status'), '话术里带上状态码：连不上后端 / 被服务器拒绝，该分得清是哪一种');
    });

    // ── 第五轮（2026-10-05 · 派遣窗口的人选）──────────────────────
    //
    // 病灶（用户实测）：`cardHtml` 的「人」槽把 `S.view.people` **全员平铺** ——
    // 开局只有皮普 1 人在册，却与另外 9 个未入队的人并排站在同一个列表里，
    // 只靠 `opacity:.5` 区分，而且**对未入队者也报了「容量 N」**
    // （那是 `byNpc` 里一个他根本用不上的数字）。
    // 另有两处同源的问题：拖拽落点不判"派不派得动"；「非 X 不可」而 X 调不动时看不出是死局。
    t.test('★★ 派遣窗口分两组：可派遣的给复选框，调不动的**只给一句话**', () => {
      const body = bodyOf('cardHtml');
      t.ok(body.includes('canDispatchTo'), '★ 分组判据是共用那份 `canDispatchTo`（不是自己再编一个 `available`）');
      t.ok(body.includes('const crew = all.filter'), '可派遣的那一组');
      t.ok(body.includes('const blocked ='), '调不动的那一组');
      // ⚠️ 关键的一条：**未入队的人不许出现在复选框那一段**。
      //   他只在 `blockedLine`（一句说明）里出现 ⇒ 那个 `rows` 循环必须只遍历 `crew`。
      const rowLoop = body.slice(body.indexOf('for (const p of crew)'));
      t.ok(rowLoop.length > 0, '复选框那段在');
      t.ok(!rowLoop.slice(0, rowLoop.indexOf('}')).includes('for (const p of all)'),
        '★ 复选框只遍历 `crew` —— 遍历 `all` 就是把 9 个派不动的人也塞回列表里');
      t.ok(body.includes('blockedLine'), '调不动的那组给的是一句话说明');
      t.ok(!body.includes('p.available && canDispatch'), '★ 旧的平铺判据不许复活（那正是把两类人混在一列的那行）');
      // ⚠️ `blocked` 的判据是 `!p.available`（**他这个人**），**不是** `!canDispatchTo`：
      //    `仅亲自` 事件里皮普是 `available = true`，用后者会把他也算成"调不动"，
      //    给他安一句"今天调不动"—— 那是在骗人（探针实测，2026-10-05）。
      t.ok(body.includes('canDispatch ? all.filter'), '★「仅亲自」时压根不列人（那件事一个属下都不派）');
    });

    t.test('★★ 对调不动的人**不报「容量 N」** —— 那是一个他用不上的数字', () => {
      const body = bodyOf('cardHtml');
      // ⚠️ 判据要落在**两段各自的内部**，不能靠"整段里有没有某个词"——
      //    `crew` 那一段本来就该有「容量」，用它当全局特征会把两段一起染上，判不出东西。
      //    所以逐段切：`crew` 循环体 vs `blockedLine` 那一行。
      const crewAt = body.indexOf('for (const p of crew)');
      const blkAt = body.indexOf('const blockedLine');
      t.ok(crewAt > 0 && blkAt > crewAt, '两段都在，且「可派遣」在前');
      const crewSeg = body.slice(crewAt, blkAt);
      const blkSeg = body.slice(blkAt, blkAt + 500);
      t.ok(crewSeg.includes('容量 ' + 'p.ap') || crewSeg.includes('p.ap'),
        '★ 「容量」只出现在**可派遣**那一段 —— 它报的是这个人今天还剩多少空闲');
      t.ok(!blkSeg.includes('p.ap'), '★ 「调不动」那一段不碰 `p.ap`（那数字对未入队的人毫无意义）');
      t.ok(blkSeg.includes('blockedReason'), '它报的是**为什么派不动**（未入队 / 重伤 / 在途 …）');
      t.ok(blkSeg.includes('blocked.length'), '还报出**有几个人**调不动 —— 玩家得知道漏了谁');
    });

    t.test('★★ 拖拽落点与点选**共用** `canDispatchTo` —— 两条路不许各判各的', () => {
      const body = bodyOf('canDropOn');
      t.ok(body.includes('canDispatchTo'), '★ `who` 那一支走共用判据');
      t.ok(!/if \(d === 'who'\) return src\.kind === 'person';/.test(body),
        '★ 旧写法（只判类型、不判人）已删 —— 那条路会把未入队的人拖进 `participants`');
      // 玩家本人**不**走 `affiliated` 那一刀（他不是下属，但「我亲自」合法）
      t.ok(body.includes('S.view.me.id'), '玩家本人单独放行（他左栏那张卡也带 `data-kind="person"`）');
      t.ok(body.includes("'仅派遣'"), '他能不能亲自上仍由 `dispatchable` 那一支管');
      // ⚠️ 事件散在两池（todo / waiting），只查一池 ⇒ 拖东西进「在办」那张卡会静默失灵
      t.ok(bodyOf('eventOf').includes('waiting'), '★ 查表要覆盖 `waiting`（处理中）那一池');
    });

    t.test('★★「非他不可」而他调不动 ⇒ 人槽里**明说这是死局**', () => {
      const body = bodyOf('cardHtml');
      t.ok(body.includes('reqLine'), '窗口里有那一行');
      t.ok(body.includes('reqUnavailable'), '判据是"**他这个人**此刻调不调得动"');
      t.ok(!body.includes('reqBlocked'), '★ 不许用 `!canDispatchTo` 判（那把「仅亲自」也算进来，会误报死局）');
      t.ok(body.includes('这件事今天办不成'), '★ 用**玩家的话**说清后果，不能只留一个点不动的名字');
      t.ok(body.includes('reqLine +'), '它真的被拼进人槽（不是算了个变量就扔掉）');
      // ⚠️ 补的建议**跟着原因走**："他养好了再说"对一个尚未入队的人是假话（他没伤要养）
      t.ok(body.includes('reqAdvice'), '建议句随原因变');
      t.ok(body.includes('得先让他站到你这边'), '未入队 ⇒ 那是"拉他入伙"，不是"养伤"');
    });
  },
};

// ══════════════════════════════════════════════════════════════
// P5-C · 会话动作：玩家自建（「我想做点什么」）
// ══════════════════════════════════════════════════════════════

/**
 * P5-C（2026-09-22）· **玩家自建** 的会话层 —— 「一句话 ⇒ 一件可以去做的事」。
 *
 * ⚠️ 三层里**这一层最容易被漏测**：落地层与编排层的用例（`test/create.test.ts`）都直接调函数，
 *    而"玩家到底能不能用"这件事，只有走 `Session.createEvent` 才被证明过。
 *
 * ⚠️ 闸门的判据只有一份（`rules/gates.ts`）—— **拦在这里**，UI 那颗按钮的置灰只是同一个判据的展示。
 *    所以下面专门注入一个"会计数的 brain"来证明：被拦下时**一次调用都不发**。
 */
const 玩家自建动作: Suite = {
  name: 'P5-C · 会话动作（玩家自建 · 闸门在调用侧）',
  register(t: T) {
    /** 用例里反复用的那句话（与 `simulate.ts·DRIVE_CREATE_WORD` 语义一致：写"打算怎么做"） */
    const WORD = '我想去城郊替我母亲立一块碑';

    /** 一个会计数的 brain：`createEvent` 被调几次，`box.calls` 就是几 */
    function counting() {
      const base = fakeBrain();
      const box = { calls: 0 };
      const brain = {
        ...base,
        async createEvent(l: Ledger, approach: string) {
          box.calls += 1;
          return base.createEvent(l, approach);
        },
      };
      return { brain, box };
    }

    t.test('★★ 一句话 ⇒ 落进「今天可做的」，而且**真的排得出去**（走的是同一条通道）', async () => {
      const s = await startDay1(20260921);
      const before = new Set(s.view().todo.map((e) => e.id));
      const used0 = s.view().usedToday;

      const r = await s.createEvent(WORD);
      t.ok(r.ok, `自建应当成立：${r.error}`);
      t.ok(r.notice.includes('你提出了一件事'), `UI 要拿到一句能读给玩家听的话：${r.notice}`);
      t.ok(r.notice.includes(WORD.slice(0, 6)), `那句话得认得出是哪一条：${r.notice}`);
      t.eq(s.view().usedToday, used0, '★ 提名目不花时间 —— 扣时间的是"去办它"那一步');
      t.eq(s.view().day, 1, '自建不翻日');

      const fresh = s.view().todo.find((e) => !before.has(e.id));
      t.ok(!!fresh, '★ 新事件出现在「今天可做的」里（玩家马上就能去办它）');
      t.eq(fresh!.tier, 'B', '自建产出走 canvas 通道 ⇒ 档 B');
      t.eq(fresh!.status, '待处理', '它是一件**待办**，不是已经发生的事');

      const a = await s.arrange({ eventId: fresh!.id, participants: ['npc000'] });
      t.ok(a.ok, `★ 自建的那一条**排得出去**（不是"进了池子却谁也办不了"）：${a.error}`);
    });

    t.test('★ 空原话 / 全空白 ⇒ ok:false，且**一次模型调用都不发**', async () => {
      const { brain, box } = counting();
      const s = await Session.start({ seed: 20260921, skipPrologue: true, brain });
      const n0 = s.view().todo.length;

      const r1 = await s.createEvent('');
      const r2 = await s.createEvent('   \n  ');
      t.eq(r1.ok, false, '空题目连模型都没法做');
      t.eq(r2.ok, false, '全是空白也一样');
      t.ok(r1.error.includes('打算怎么做'), `原因要说清"得写一句打算怎么做"：${r1.error}`);
      t.eq(box.calls, 0, '★ 前置拦下 ⇒ 不浪费一次调用（与"场景里空话不进裁定"同一条纪律）');
      t.eq(s.view().todo.length, n0, '账本里没有凭空多出来的东西');
    });

    t.test('★ 闸门在**调用侧**：当天时间用尽 ⇒ ok:false、原因原样交回、仍**一次都不发**', async () => {
      const { brain, box } = counting();
      const s = await Session.start({ seed: 20260921, skipPrologue: true, brain });
      s.ledger.clock.usedToday = BASE_ACTION_POINTS;
      t.ok(fails(s.ledger).includes('ACTION_POINTS'), '前提：闸门 ① 此刻真的是红的（否则这条用例是空跑）');

      const r = await s.createEvent(WORD);
      t.eq(r.ok, false, '时间用尽 ⇒ 不能新开一件事');
      t.ok(r.error.includes('用尽'), `原因要指向"时间用尽"：${r.error}`);
      t.eq(box.calls, 0, '★ 拦在调用之前 —— UI 的置灰只是展示，真正的拦截在这里');
    });

    t.test('★ 结局已定 ⇒ `guard()` 先拦（与所有动作一致）', async () => {
      const s = await startDay1(20260921);
      s.ledger.ending = {
        name: '未竟',
        title: null,
        kind: '失败',
        flavor: null,
        row: 5,
        day: 28,
        reason: '（用例造的一条终局，只为把闸门立起来）',
        text: null,
        placements: { 成果: null, 手段: null, 共鸣: null },
      };
      const r = await s.createEvent(WORD);
      t.eq(r.ok, false, '一局结束了就不能再自建');
      t.ok(r.error.includes('已经结束'), `错因要说清是"这一局结束了"：${r.error}`);
      t.eq(r.ended, true, '`ended` 要立起来（UI 据此弹终局面板）');
    });

    t.test('★ 入口的文案是**玩家语言** —— 不写"不占条数 / 不吃 L 预算"这类系统口径', () => {
      // ⚠️ 2026-10-08 拆分适配：这些字符串在 js/ 文件里 —— 读"内联后的完整页"
      const HTML = readPlayerPage();
      t.ok(HTML.includes('data-act="create"'), '中栏有那个「就做这件事」的按钮');
      t.ok(HTML.includes('id="createText"'), '有写那句话的输入框');
      t.ok(HTML.includes('我想做点什么'), '卡片的标题是玩家的口吻');
      t.ok(HTML.includes('提名目不用花时间'), '★ 用大白话说清"提名目不花时间，去办它才要"');
      t.ok(HTML.includes('别写「你已经做到了什么」'), '★ 提醒玩家写"打算怎么做"，而不是"已经做到了什么"');
      t.ok(HTML.includes('v.remaining <= 0'), '时间用尽时那颗按钮置灰（展示层 —— 拦截在会话层）');
    });
  },
};

/**
 * P5-D（2026-10-07）· **前端结构守卫** —— 把这两天真正咬人的三类 bug 变成常驻判据。
 *
 * ⚠️ 为什么单开一套：`ui/index.html` 是 7600 行的**单文件**（骨架 ＋ CSS ＋ JS 全在里面），
 *    没有类型、没有构建 ⇒ 拼错一个变量名、同一选择器写两遍、函数重名，
 *    **一个错都不报**，只会"看着不太对"。本轮实测抓出：
 *      · `--gold` / `--warn` / `--t-fast` 三个名字**只有人用、没人定义**
 *        ⇒ `var()` 取不到值 ⇒ **那一整条声明作废**（12 处样式静默失效，控制台一个字不报）；
 *      · `.hcard.item{width:88px}` 被后一处 `104px` 覆盖 ⇒ **注释写 88、实际生效 104**；
 *      · 同一行 `.cvchip .cvw` 被逐字抄了两遍（纯死代码）。
 *    ⇒ 这三条判据与任何具体需求无关：**谁改这块，它都该一直是绿的。**
 * ⚠️ 判据一律取**真源码**，不看注释里怎么写（本仓注释常写着"已做"，代码未必）。
 * ⚠️ 大括号 / 注释配平已由 P5-B 那条 ★★★ 钉着，这里**不重复**。
 */
const 前端结构守卫: Suite = {
  name: 'P5-D · 前端结构守卫（未定义变量 / 选择器冲突 / 函数重名）',
  register(t) {
    // ⚠️ 2026-10-08 拆分适配：主脚本已拆成 js/ 下多个文件 —— 走模块级
    //    readPlayerPage()（src 原位内联回来）⇒ 本套件全部 regex 断言零改动。
    const readHtml = readPlayerPage;
    const cssOf = (H: string): string => H.slice(H.indexOf('<style>') + 7, H.indexOf('</style>'));
    // ⚠️ 2026-10-08 拆分适配：旧实现 lastIndexOf 取"最后一个 script 块"（单文件时代的
    //    主脚本）。拆分后那是 12 个块 —— 取全部块拼接才是完整 JS 源（顺序 = 加载顺序）。
    const jsOf = (H: string): string =>
      [...H.matchAll(/^[ \t]*<script>[ \t]*$([\s\S]*?)^[ \t]*<\/script>[ \t]*$/gm)]
        .map((m) => m[1])
        .join('\n');

    /**
     * 取一个顶层函数的函数体 —— **按大括号配对**，并跳过字符串 / 模板串 / 注释。
     * ⚠️ 为什么本套件不直接用 P5-B 那个 `bodyOf`：
     *   ① 它是 **P5-B 套件内的局部 helper**，这个套件里根本没有（2026-10-07 实测
     *      `bodyOf is not defined`）；
     *   ② 它的截断办法是"截到下一行以 `function ` 开头处"—— 一旦要抽的函数里
     *      **嵌了单行**的小函数，就会**截在半个函数上**，而我照着半个函数的输出去改源码
     *      会一直"没效果"（本项目 2026-10-06 为此浪费三轮）。
     *    ⇒ 本套件自带一个**按大括号配对**的版本，两处各留一份，互不牵连。
     * ⚠️ 抽不到就**抛**（不许静默返回空串 —— 空串会让下面所有 `!includes(...)` 判据**假绿**）。
     */
    const bodyOf = (fn: string): string => {
      const js = jsOf(readHtml());
      const m = new RegExp('(?:^|\\n)[ \\t]*function\\s+' + fn + '\\s*\\(').exec(js);
      if (!m) throw new Error(`ui/index.html 里找不到 function ${fn}() —— 这条断言无从谈起`);
      const open = js.indexOf('{', m.index + m[0].length);
      if (open < 0) throw new Error(`function ${fn}() 后面没有 { —— 抽取失败`);
      let i = open + 1;
      let depth = 1;
      while (i < js.length && depth > 0) {
        const c = js[i];
        const next = js[i + 1];
        if (c === '/' && next === '/') { const e = js.indexOf('\n', i); i = e < 0 ? js.length : e + 1; continue; }
        if (c === '/' && next === '*') { const e = js.indexOf('*/', i + 2); i = e < 0 ? js.length : e + 2; continue; }
        if (c === "'" || c === '"' || c === '`') {
          i++;
          while (i < js.length) {
            if (js[i] === '\\') { i += 2; continue; }
            if (js[i] === c) break;
            i++;
          }
          i++;
          continue;
        }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
      }
      return js.slice(open + 1, i - 1);
    };

    t.test('★★ 没有「用了但没定义」的 CSS 变量（JS 运行时注入的除外）', () => {
      const H = readHtml();
      const css = cssOf(H);
      const js = jsOf(H);

      const defined = new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
      // JS 运行时注入的（拖拽幽灵的位移 `--dx`/`--dy`、错开动画的序号 `--i`）——
      // ⚠️ **从 JS 源码自动认出来**，不另维护一份手写白名单（那份东西本身就会漂）。
      const injected = new Set<string>();
      for (const m of js.matchAll(/setProperty\(\s*'(--[a-zA-Z0-9-]+)'/g)) injected.add(m[1]);
      for (const m of js.matchAll(/style="[^"]*?(--[a-zA-Z0-9-]+)\s*:/g)) injected.add(m[1]);

      const used = [...new Set([...css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => m[1]))];
      const missing = used.filter((n) => !defined.has(n) && !injected.has(n));
      t.ok(used.length >= 30, `变量引用数量下限（防"切片失败 ⇒ 两边都空 ⇒ 假绿"）—— 实测 ${used.length} 个`);
      t.eq(
        missing.length,
        0,
        `★ 这些变量被 var() 引用了却没人定义 ⇒ 用到它们的**整条声明作废**（静默失效）：${missing.join(' / ')}`,
      );
    });

    t.test('★★ 同一个顶层选择器不许两处定义、同名属性还给不同值（后者会悄悄覆盖前者）', () => {
      const css = cssOf(readHtml());
      // 逐字符走一遍，只收 **depth 0** 的块 —— `@media` 里的不算（那本来就是"按条件覆盖"）。
      const blocks: { sel: string; body: string }[] = [];
      let depth = 0;
      let pre = 0;
      for (let i = 0; i < css.length; i++) {
        const c = css[i];
        if (c === '{') {
          if (depth === 0) {
            const sel = css.slice(pre, i).replace(/\/\*[\s\S]*?\*\//g, '').trim();
            if (sel && sel[0] !== '@') {
              let d2 = 1;
              let j = i + 1;
              while (j < css.length && d2 > 0) {
                if (css[j] === '{') d2++;
                else if (css[j] === '}') d2--;
                j++;
              }
              blocks.push({ sel: sel.replace(/\s+/g, ' '), body: css.slice(i + 1, j - 1) });
              i = j - 1;
              pre = j;
              continue;
            }
          }
          depth++;
          pre = i + 1;
        } else if (c === '}') {
          if (depth > 0) depth--;
          pre = i + 1;
        }
      }

      // ⚠️⚠️ **每个块只留"生效值"**（同名属性在**块内**后写的赢）——
      //    块内重复是**渐进增强的兜底写法**（`max-height:88vh;max-height:88dvh`，老的用 vh、
      //    新的用 dvh），**不是** bug。2026-10-07 第一版守卫没区分这一点，把它误判成冲突。
      //    ⇒ 真正的病灶只有一种：**同一个选择器、散在好几个块里**，后者悄悄改掉前者的值。
      const bySel = new Map<string, Map<string, string>[]>();
      for (const b of blocks) {
        const eff = new Map<string, string>();
        for (const part of b.body.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
          const k = part.indexOf(':');
          if (k < 0) continue;
          const prop = part.slice(0, k).trim();
          const val = part.slice(k + 1).trim().replace(/\s+/g, ' ');
          if (!prop || prop.startsWith('--')) continue;   // 自定义属性不算（变量本来就允许多处回退）
          eff.set(prop, val);
        }
        const list = bySel.get(b.sel) ?? [];
        list.push(eff);
        bySel.set(b.sel, list);
      }

      const bad: string[] = [];
      for (const [sel, list] of bySel) {
        if (list.length < 2) continue;   // 只有**一个**块 ⇒ 谈不上"后者覆盖前者"，块内兜底也不该管
        const seen = new Map<string, Set<string>>();
        for (const eff of list) {
          for (const [prop, val] of eff) {
            const s = seen.get(prop) ?? new Set<string>();
            s.add(val);
            seen.set(prop, s);
          }
        }
        for (const [prop, vals] of seen) if (vals.size > 1) bad.push(`${sel} { ${prop} } → ${[...vals].join('   ✕   ')}`);
      }
      t.ok(blocks.length >= 300, `顶层 CSS 块数量下限（防假绿）—— 实测 ${blocks.length} 个`);
      t.eq(
        bad.length,
        0,
        `★ 同一选择器两处定义、同名属性值不同（后者静默覆盖前者，而注释往往还写着旧值）：\n    ${bad.join('\n    ')}`,
      );
    });

    t.test('★★ JS 顶层函数不许重名（后一个会静默覆盖前一个）', () => {
      const js = jsOf(readHtml());
      const names = [...js.matchAll(/^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
      const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
      t.ok(names.length >= 100, `顶层函数数量下限（防假绿）—— 实测 ${names.length} 个`);
      t.eq(
        dup.length,
        0,
        `★ 重名的函数（后声明的赢，调用方会莫名其妙走进另一份实现）：${dup.join(' / ')}`,
      );
    });

    // ⚠️⚠️ 2026-10-07（用户复验第 5 条）—— 这一条守的是**三个实测出来的病灶**，
    //   三个都是"人工看截图才发现"的类型，所以必须变成常驻判据。
    t.test('★★ 事件台：物格遗骸不许回来 ＋ 放了的人从手牌区收起 ＋ 矮屏按钮不许被裁', () => {
      const html = readHtml();
      const card = bodyOf('cardHtml');
      // ① **「物」那一格是残骸，不许回来。**
      //    用户原话：「是不是之前的物品槽逻辑的残余？现在根本不需要物品槽，
      //    物品都是直接放在人物身上的」。
      //    ⚠️ 为什么它必须是常驻判据而不是"清一次就好"：那段残骸**不渲染**，
      //    所以任何"看截图 / 看 DOM"的验证都看不见它；而它是 const，
      //    **每轮渲染都照样求值** —— 判据一写错就当场抛异常、整张卡停在半渲染态。
      //    （node --check 与 659 条单测都没抓到，用户是拿截图报上来的。）
      t.ok(!card.includes('usedItemId'),
        '★★ 「物」那一格的残骸又回到 cardHtml 里了（不渲染、但每轮求值 ⇒ 会静默炸渲染）');
      t.ok(!html.includes('willUseItem'),
        '★★ 同上：取"这次用的那件"那行又回来了');
      t.ok(!html.includes('data-drop="item"'),
        '★★ 又冒出一个收物卡的格子（第 5 条：事件台只有 4 个人物槽 ＋ 1 个金币槽）');
      // ② **已经放进处理台的人要从卡带上收起**（用户原话：
      //    「人物卡使用后，并没有在手牌区消失」）。
      t.ok(html.includes('function deskUsedIds('),
        '★★ 没有"处理台里已经放上去的人"这份判据');
      const hand = bodyOf('handRailInner');
      t.ok(hand.includes('deskUsedIds()') && hand.includes('isUsed(p.id)'),
        '★★ 放了的人没有从卡带上收起（第 5 条：同一张卡不许在原地留着）');
      // ③ **矮屏上那两颗处理方式按钮不许被裁。**
      //    实测（1080x700）：浮层底 461，而「亲自去且仔细处理」的底边在 529 ⇒ 两颗都在浮层外。
      t.ok(html.includes('.ops.modes button[disabled]{'),
        '★★ 未满足条件的处理方式按钮没有可辨认的样式（深底上只剩一行 0.4 透明度的灰字）');
      t.ok(html.includes('@media (max-height:700px){ .dia{transform:scale('),
        '★★ 菱形没有"按屏高缩放"的档位（矮屏上「亲自去且仔细处理」会被 overflow 裁掉）');
      t.ok(html.includes('min-height:0;display:grid;place-items:center'),
        '★ 左栏又被钉了固定 min-height（那正是"矮屏溢出"的来源）');
      // ④ 窄屏副本：整株等比缩（2026-10-07 起菱形是 SVG 宽菱形，缩放即可，不再另写一套槽位坐标）
      t.ok(html.includes('@media (max-width:560px){\n    .dia{transform:scale(.78)}\n  }'),
        '★★ 窄屏上菱形没有等比缩档（会横向撑破左栏）');
      // ⑤ **「实心金」这一格只许留给"我选的那个"处理方式**（第 5.6 条）。
      //    实测（1080x700）刚打开、`handling` 还是空时：「简略处理」无条件带 `button.primary`
      //    ⇒ 它是**最抢眼的实心金**，而 `✔` 同时是灰的（`howOk` 为假）—— 两块自相矛盾；
      //    真选了「亲自去」时，**未选中**的「简略处理」反倒比选中的那颗更亮（读反了）。
      //    ⇒ 判据两半：① 那颗**不许**再无条件带 primary；② `.on` 自己就是实心金。
      t.ok(!html.includes('\'<button class="primary\' + (how === \'brief\''),
        '★★ 「简略处理」又无条件带上 primary 了（未选中却最亮 ⇒ 玩家以为它已经选中，而 ✔ 还灰着）');
      t.ok(html.includes('.ops.modes button.on:not([disabled]){'),
        '★★ 处理方式的"选中"没有自己的实心样式（`.on` 只剩一层淡色 ⇒ 选中态比未选中还弱）');
      t.ok(html.includes("'<button class=\"' + (how === 'brief' ? 'on' : '')"),
        '★★ 「简略处理」的选中标记没了（两个按钮必须有且只有一个 `.on`，第 5.6 条）');
    });
  },
};

export const suites: Suite[] = [开局与视图, 档A点选, 会话动作, 视图接线, 玩家界面, 玩家自建动作, 前端结构守卫];
