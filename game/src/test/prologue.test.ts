// P4-D · 序幕引擎的单测 —— 内容表（`rules/prologue.ts`）＋ 写入侧（`turn/prologue.ts`）＋ 会话层接线
//
// ⚠️ 为什么要单独一个文件（而不是塞进 `ui.test.ts` / `initial.test.ts`）：
//    序幕**横跨三层** —— 内容是"规则层写死的文案"，铺牌是"账本写入"，而末条翻牌是
//    "一次 LLM 调用"。三层的失败模式完全不同（文案漏一条 / 顺序乱掉 / 翻牌没接上），
//    混在一起写，报错信息就指不回判据了。
//
// 三条最要紧的断言（都是"绿了但没测到"的高危区）：
//   ① **一次全铺（除末条）**：`startPrologue` 之后牌池里**恰好 8 条**（平铺 · 自由点选，
//      2026-10-08 用户裁定）。末条「原初欲望的觉醒」**不许混进来** —— 其余事件全结算 /
//      点「直接正式开始游戏」之后才出现。这条一旦退化，"末条条件出现"就没人守了。
//   ② **闸门 ④ 真的拦住了「进下一天」**：序幕读到一半按「进下一天」必须被拒。
//      这条判据在 `rules/gates.ts` 里**本来就写着 `advanceDay`**，但直到本次落地之前
//      **没有任何调用侧问过它** —— 那个分支只活在单测里（`ledger.test.ts:43`）。
//   ③ **序幕不动正文那条 `rng`**：翻牌走 `prologueRng`（独立流）。
//      实测（2026-09-18）直接伸进去会让 seed 7 的「隐藏事件被 `trigger` 唤醒」由 ✓ 变 ✗。
//      ⇒ 必须有一条断言钉住"走完整个序幕之后，正文流的骰子数还是 0"。
import type { Ledger } from '../ledger/types.ts';
import { PLAYER_ID } from '../ledger/types.ts';
import { initialLedger } from '../ledger/initial.ts';
import { formatEventId } from '../ledger/ids.ts';
import { fakeBrain } from '../fixtures/fake.ts';
import { makeRng } from '../rules/rng.ts';
import {
  PROLOGUE_CARDS,
  PROLOGUE_DAY1_COUNT,
  PROLOGUE_DESIRE_TIER,
  PROLOGUE_OPENING_ID,
  PROLOGUE_TOTAL,
  isPrologueEventId,
  prologueCardOf,
  prologueEventId,
  prologueSeqOf,
  prologueSummaryLines,
} from '../rules/prologue.ts';
import { choosePopup } from '../turn/popup.ts';
import { simulate } from '../turn/simulate.ts';
import { DEFAULT_CHOICE, OpeningRejected } from '../turn/opening.ts';
import { ATTR_KEYS } from '../contract/types.ts';
import { PLAYER_DESC } from '../ledger/initial.ts';
import type { Brain } from '../turn/brain.ts';
import {
  advancePrologue,
  afterPrologueCard,
  currentPrologueCard,
  driveOpening,
  inPrologue,
  isOpeningCardId,
  prologueFinished,
  prologuePending,
  prologueRng,
  skipToOpening,
  startPrologue,
} from '../turn/prologue.ts';
import { Session } from '../ui/session.ts';
import type { Suite, T } from './harness.ts';

// ── 小工具 ────────────────────────────────────────────────────

/** 一路铺 + 点，直到第 `seq` 条被点掉（`seq = 10` ⇒ 连翻牌也走完） */
async function playTo(l: Ledger, seq: number, brain = fakeBrain()): Promise<Ledger> {
  const p = prologueRng(1);
  let cur = startPrologue(l).ledger;
  for (;;) {
    const card = cur.events.live.find((e) => isPrologueEventId(e.id) && e.status === '待处理');
    if (!card) break;
    const n = prologueSeqOf(card.id)!;
    if (n > seq) break;
    cur = choosePopup(cur, card.id, 0).ledger;
    cur = (await afterPrologueCard(cur, card.id, brain, DEFAULT_CHOICE)).ledger;
  }
  return cur;
}

/** 玩家的六维（`opening` 之后应当不再是占位全 5） */
function playerAttrs(l: Ledger): number[] {
  return Object.values(l.entities.people.find((p) => p.id === PLAYER_ID)!.attrs);
}

function popupCards(l: Ledger) {
  return l.events.live.filter((e) => isPrologueEventId(e.id));
}

// ── 套件 ──────────────────────────────────────────────────────

const 内容表: Suite = {
  name: 'P4-D · 序幕内容表（rules/prologue.ts ·《设定.md》§序幕事件文案）',
  register(t: T) {
    t.test('9 条 / 第 1 天 4 条 / 第 2 天 5 条 / seq 保号（原第 5 条已删）—— 顺序即 seq', () => {
      // ⚠️ 2026-10-07 用户裁定：原第 5 条「两样东西」整条删除（物品由规则层直发，不掉东西）。
      //    其余各条**保留原 seq** —— seq 就是事件 id，重排会让第 2 天五条整体改名，
      //    假 brain 的稳定散列（吃 `ev.id`）会把 28 天基线轨迹整体挪位 ⇒ `e5` 是空号。
      t.eq(PROLOGUE_TOTAL, 9, '序幕 9 条档 A（原第 5 条「两样东西」已删）');
      t.eq(PROLOGUE_CARDS.length, 9, '表里就是那 9 条');
      t.eq(PROLOGUE_DAY1_COUNT, 4, '第 1 天 4 条（王宫 → 城中心）');
      t.eq(PROLOGUE_CARDS.filter((c) => c.day === 1).length, 4, '第 1 天真的只有 4 条');
      t.eq(PROLOGUE_CARDS.filter((c) => c.day === 2).length, 5, '第 2 天 5 条（出宫 · 市集 → 下城 → 城郊）');
      t.deep(
        PROLOGUE_CARDS.map((c) => c.seq),
        [1, 2, 3, 4, 6, 7, 8, 9, 10],
        '★ seq 保号不连续 —— 呈现顺序照旧，事件 id（e1~e10）一个都不改',
      );
      t.ok(!PROLOGUE_CARDS.some((c) => c.title === '两样东西'), '「两样东西」不在表里');
      t.eq(PROLOGUE_CARDS[0].title, '朝会', '《规则.md》§四：开局第一条 = 朝会（塞兰王庭）');
      t.eq(PROLOGUE_CARDS[4].title, '金庭市集', '第 2 天第一条 = 出宫去市集');
    });

    t.test('★ 末条「原初欲望的觉醒」= 翻牌那一条：单价 1 选项 · 不计入概要', () => {
      const last = PROLOGUE_CARDS[PROLOGUE_CARDS.length - 1];
      t.eq(last.title, '原初欲望的觉醒', '《规则.md》§四：末条追加「原初欲望的觉醒」');
      t.eq(last.seq, 10, '它是第 10 条');
      t.eq(last.opening, true, '★ `opening: true` 是"点下它即翻牌"的唯一标记');
      t.eq(last.options.length, 1, '形态 = 档 A（1 个选项「迎接你『真实的自我』」）');
      t.ok(last.options[0].text.includes('真实的自我'), `选项文字要是那一句，实得「${last.options[0].text}」`);
      t.eq(
        last.summary,
        '',
        '★ **不计入概要**：它是欲望的开端，写进公共概要就等于把玩家的欲望漏给生成侧',
      );
      t.eq(PROLOGUE_OPENING_ID, 'e10', '它的 id 就是末条的 id');
      t.eq(isOpeningCardId('e10'), true, '判据同源');
      t.eq(isOpeningCardId('e1'), false, '别的都不是');
    });

    t.test('固定概要 = 8 句（其余 8 条各一句，且都与分支无关）', () => {
      const lines = prologueSummaryLines();
      t.eq(lines.length, 8, '★ 9 条文案里 8 条各附一句「并入概要」——末条那条是空的');
      for (const c of PROLOGUE_CARDS) {
        if (c.seq === 10) continue;
        t.ok(c.summary.trim() !== '', `第 ${c.seq} 条「${c.title}」必须带一句概要（后续生成只看得到概要）`);
        t.ok(
          !['也许', '可能', '如果'].some((w) => c.summary.includes(w)),
          `第 ${c.seq} 条的概要要写成**客观记录**，不能随玩家选哪个分支而变：${c.summary}`,
        );
      }
    });

    t.test('每条至少有 1 个选项，且文字 / 结果文案都不为空（档 A 的 `result_text` 是结果唯一载体）', () => {
      for (const c of PROLOGUE_CARDS) {
        t.ok(c.options.length >= 1, `第 ${c.seq} 条「${c.title}」一个选项都没有 ⇒ 闸门 ④ 会把这一局钉死`);
        t.ok(c.scene.trim() !== '', `第 ${c.seq} 条要有场面正文（它是档 A 的「content」）`);
        for (const o of c.options) {
          t.ok(o.text.trim() !== '', `第 ${c.seq} 条的选项文字为空`);
          t.ok(o.resultText.trim() !== '', `第 ${c.seq} 条「${o.text}」的结果文案为空 —— 档 A 不调 LLM，结果只有它`);
        }
      }
    });

    t.test('★ 10 处地点全部能按名解析到账本里的 `loc`（写错地名会造出一个没有舞台的事件）', () => {
      const l = startPrologue(initialLedger()).ledger;
      const names = l.entities.places.map((p) => p.name);
      for (const c of PROLOGUE_CARDS) {
        t.ok(names.includes(c.place), `第 ${c.seq} 条的地点「${c.place}」不在预置 9 处地点里`);
      }
      // 真正该守的不变式：**每条铺出来的事件的 `location` 都有值**
      // （`turn/prologue.ts·cardToEvent` 解析不到时会刺眼地记一条警告，但事件照样落下来
      //  —— 所以这里必须正面断言"解析得到"，而不是"没记警告"）
      const ten = advancePrologue(l).ledger;
      const pushed = ten.events.live.filter((e) => isPrologueEventId(e.id));
      t.eq(pushed.length, 8, '前提：开局一次铺 8 条（除末条）');
      for (const e of pushed) {
        t.ok(e.location !== null, `${e.id}「${e.title}」的地点没解析到 ⇒ 玩家会看见一个没有舞台的事件`);
        t.ok(ten.entities.places.some((p) => p.id === e.location), `${e.id} 的 location 必须在账本里`);
      }
    });

    t.test('id 顺位：`e1`~`e10`；`e11` 不是序幕 —— `prologueSeqOf` 与 `isPrologueEventId` 同源', () => {
      t.eq(prologueEventId(1), 'e1', '顺位从 1 起，不是 0');
      t.eq(prologueEventId(10), 'e10', '★ `e10` 两位 —— 用正则判 id 会在 `e1` / `e10` 上糊掉');
      t.eq(isPrologueEventId('e10'), true, '★ `e10` 是序幕的（正则 `^e1` 会把它漏掉或误判）');
      t.eq(isPrologueEventId('e11'), false, '★ 正文第一条生成事件是 `e11`，**不是**序幕的');
      t.eq(isPrologueEventId('e1'), true, '`e1` 是');
      for (const c of PROLOGUE_CARDS) {
        t.eq(prologueSeqOf(prologueEventId(c.seq)), c.seq, `第 ${c.seq} 条的 id 往返`);
      }
      t.eq(prologueSeqOf('e11'), null, '不是序幕 ⇒ null（不能返回 11）');
      t.eq(prologueCardOf(11), null, '越界 ⇒ null');
      t.eq(prologueCardOf(1)!.title, '朝会', '第 1 条');
    });
  },
};

const 写入侧: Suite = {
  name: 'P4-D · 序幕写入侧（turn/prologue.ts）',
  register(t: T) {
    t.test('★ `startPrologue` 除末条外一次全铺（8 条），末条不铺；水位一次上到 10', () => {
      const r = startPrologue(initialLedger());
      const laid = popupCards(r.ledger);
      t.eq(laid.length, 8, '★ 除末条外全铺（平铺 · 自由点选，2026-10-08 用户裁定）');
      t.deep(laid.map((e) => e.id), ['e1', 'e2', 'e3', 'e4', 'e6', 'e7', 'e8', 'e9'], '铺的顺序即表序（`e5` 是空号）');
      t.ok(!laid.some((e) => e.id === 'e10'), '★ 末条「原初欲望的觉醒」不铺 —— 其余事件点完 / 按钮直通后才出现');
      t.ok(laid.every((e) => e.status === '待处理'), '铺下即待处理（8 条都在等玩家点）');
      t.eq(r.ledger.idWatermark.event, 10, '★ `e1`~`e10` 是开局订走的（`initialLedger`）⇒ 正文第一条生成事件从 `e11` 起');
      t.eq(formatEventId(r.ledger.idWatermark.event + 1), 'e11', '★ 正文第一条生成事件的号是 `e11`，不是 `e1`');
      t.eq(
        isPrologueEventId(formatEventId(r.ledger.idWatermark.event + 1)),
        false,
        '★ 下一条号**不是**序幕的（撞上就会被当成序幕第 1 条）',
      );
      t.eq(inPrologue(r.ledger), true, '还停在 day 0');
      t.eq(r.ledger.clock.day, 0, '序幕不推进时钟');
    });

    t.test('`startPrologue` 幂等：连调两次仍是那 8 条（判据是"有没有序幕 id"，不是"第 1 条还在不在"）', () => {
      const a = startPrologue(initialLedger()).ledger;
      const b = startPrologue(a).ledger;
      t.eq(popupCards(b).length, 8, '★ 第二次调用一条都不许多');
      t.ok(b.events.live.filter((e) => e.id === 'e1').length === 1, '`e1` 只有一条（重复会让玩家读两遍朝会）');
      // 点掉之后**再**调一次 —— 这才是真正会暴露"判据取错"的那一次
      const c = startPrologue(choosePopup(b, 'e1', 0).ledger).ledger;
      t.eq(popupCards(c).length, 8, '★ `e1` 已结算 —— 但序幕**已经开始了**，不许重来');
      t.eq(c.events.live.filter((e) => e.id === 'e1').length, 1, '不允许出现第二条 `e1`');
    });

    t.test('★ `advancePrologue`：全铺过 ⇒ 空转（同一引用）；非末条全结算 ⇒ 铺末条；末条已铺 ⇒ 再空转', () => {
      let l = startPrologue(initialLedger()).ledger;
      // ① 已全铺、还有没点的 ⇒ 空转（不再"铺下一条"）
      const noop = advancePrologue(l);
      t.eq(noop.ledger, l, '★ 空转时返回**同一个账本对象**（引用相等 ⇒ 没克隆 ⇒ 没动过）');
      // ② 逐条点掉非末条 —— 中途每一步都空转；点完最后一条 ⇒ 末条出现
      const rest = PROLOGUE_CARDS.filter((c) => c.opening !== true).map((c) => prologueEventId(c.seq));
      for (let i = 0; i < rest.length; i++) {
        l = choosePopup(l, rest[i], 0).ledger;
        l = advancePrologue(l).ledger;
        const isLast = i === rest.length - 1;
        t.eq(popupCards(l).length, isLast ? 9 : 8,
          `点掉第 ${i + 1} 条后 live 里 ${isLast ? '9 条（末条出现了）' : '仍 8 条（末条不出现）'}`);
        if (!isLast) t.eq(advancePrologue(l).ledger, l, `点掉第 ${i + 1} 条后：仍空转（同一引用）`);
      }
      // ③ 末条铺出 ⇒ 再推进也空转
      const again = advancePrologue(l);
      t.eq(again.ledger, l, '★ 末条已铺 ⇒ 空转（同一个账本对象）');
      t.ok(popupCards(l).some((e) => e.id === 'e10' && e.status === '待处理'), '末条「原初欲望的觉醒」待处理');
      t.ok(popupCards(l).filter((e) => e.id !== 'e10').every((e) => e.status === '已结算'), '其余 8 条全已结算');
    });

    t.test('★ `advancePrologue` 旧档迁移：只铺过前几条的旧账本 ⇒ 一次补齐缺失的非末条', () => {
      // 手造"旧模型"账本：那个时代一次只铺一条 —— 读回来的档只有 e1
      const l0 = startPrologue(initialLedger()).ledger;
      const old = structuredClone(l0);
      old.events.live = old.events.live.filter((e) => e.id === 'e1');
      const r = advancePrologue(old);
      const laid = popupCards(r.ledger);
      t.eq(laid.length, 8, '★ 一次补齐缺失的 7 条非末条（旧档玩家也进"平铺"体验）');
      t.deep(laid.map((e) => e.id).sort(), ['e1', 'e2', 'e3', 'e4', 'e6', 'e7', 'e8', 'e9'], '补齐的口径与新开一局一致');
      t.ok(!laid.some((e) => e.id === 'e10'), '补齐不许把末条也带出来');
    });

    t.test('`advancePrologue` 在非序幕账本上零副作用（返回同一引用）', () => {
      const l = initialLedger(); // 还没 `startPrologue`
      const r = advancePrologue(l);
      t.eq(r.ledger, l, '★ 序幕没开始 ⇒ 它**不替序幕开始**');
      t.eq(popupCards(l).length, 0, '一条都没多');
    });

    t.test('铺出来的每一条都是"档 A 的骨架"：0 行动点 · 0 调用 · delta 留空 · 欲向 无关', () => {
      const l = advancePrologue(startPrologue(initialLedger()).ledger).ledger;
      for (const e of popupCards(l)) {
        t.eq(e.tier, 'A', `${e.id} 是档 A`);
        t.eq(e.cost, 0, `${e.id} 不花时间（序幕 0 行动点）`);
        t.eq(e.created_day, 0, `${e.id} 记在第 0 天`);
        t.eq(e.delta, null, `${e.id} 的 delta 留空 —— 序幕不动账（占位数值开局就写好了）`);
        t.deep(e.hint_attr, [], `${e.id} 不带属性提示（生成侧那套对它无意义）`);
        t.eq(e.difficulty, '无修正', `${e.id} 不判难度`);
        t.eq(e.status, '待处理', `${e.id} 铺下即待处理`);
        t.eq(e.dispatchable, '两者皆可', '档 A 没有参与者 —— 点击即结算');
        for (const o of e.options) {
          t.eq(o.欲向, PROLOGUE_DESIRE_TIER, `★ ${e.id} 的欲向必须是「无关」`);
          t.eq(PROLOGUE_DESIRE_TIER, '无关', '理由：序幕期欲念是**固定占位 30**（不走 T0、无漂移）');
          t.deep(o.delta, { ops: [] }, `${e.id} 的选项 delta 也留空`);
          t.eq(o.trigger, null, `${e.id} 的选项不带 trigger（血统只在生成侧）`);
        }
      }
    });

    t.test('★ 点完 9 条（不含末条）：一幕下来账本**一个数都没动**，只多了 9 句概要', async () => {
      const l0 = initialLedger();
      const g0 = l0.scalars.gold;
      const rep0 = JSON.stringify(l0.scalars.rep);
      const attrs0 = JSON.stringify(playerAttrs(l0));
      const hp0 = l0.entities.people.map((p) => `${p.hp}/${p.san}`).join(',');
      const items0 = l0.entities.items.map((i) => `${i.id}:${i.holder ?? '-'}`).join(',');

      const l = await playTo(l0, 9);

      t.eq(l.scalars.gold, g0, '★ 金币没动（序幕无支出、也无收入 —— 「金币 5」是第 1 天的周例钱）');
      t.eq(JSON.stringify(l.scalars.rep), rep0, '★ 声望没动（档 A 的 delta 全是空的）');
      t.eq(JSON.stringify(playerAttrs(l)), attrs0, '★ 六维还是占位全 5（真实值由末条的 `opening` 产出）');
      t.eq(l.entities.people.map((p) => `${p.hp}/${p.san}`).join(','), hp0, '★ HP / SAN 没动');
      t.eq(l.entities.items.map((i) => `${i.id}:${i.holder ?? '-'}`).join(','), items0, '★ 两件初始物品开局就在手上，序幕不发东西');
      t.eq(l.desire.value, 30, '★ 欲念仍是 30（欲向 = 无关 ⇒ Δ 0）');
      t.eq(l.desire.proposition, '', '命题还空着（那是末条的事）');
      t.eq(l.desire.manifesto, '', '欲望还空着（还没开局）');
      t.eq(
        l.summaries.recent.filter((x) => x.day === 0).length,
        8,
        '★ 8 条固定概要在点选时就落进了 `recent`（day = 0）—— 末条那条不计入',
      );
      t.eq(l.pending.length, 0, '档 A 不走「算 / 揭分离」⇒ 一个待揭都不该有');
      t.eq(l.events.hidden.length, 0, '序幕不产隐藏事件');
      t.eq(l.clock.usedToday, 0, '★ 序幕 0 行动点 —— 时间读数纹丝不动');
      t.eq(prologueFinished(l), false, '第 10 条还没点 ⇒ 序幕没走完');
    });

    t.test('`prologuePending` / `currentPrologueCard`：8 条铺开 ⇒ 剩余数递减；"当前"恒指 live 里最靠前的待处理', () => {
      let l = startPrologue(initialLedger()).ledger;
      t.eq(prologuePending(l), 8, '开局一次铺 8 条 ⇒ 8 条待处理');
      t.eq(currentPrologueCard(l)!.seq, 1, '当前（live 里最靠前的待处理）是第 1 条');
      l = advancePrologue(choosePopup(l, 'e1', 0).ledger).ledger;
      t.eq(prologuePending(l), 7, '点掉一条 ⇒ 7 条（不再"铺下一条"）');
      t.eq(currentPrologueCard(l)!.seq, 2, '当前换成了第 2 条');
      // 自由点选：跳着点 ⇒ "当前"跟着跳，remaining 与之同步
      l = advancePrologue(choosePopup(l, 'e6', 0).ledger).ledger;
      t.eq(prologuePending(l), 6, '跳着点掉第 6 条 ⇒ 剩 6');
      t.eq(currentPrologueCard(l)!.seq, 2, '当前仍是第 2 条（它还待处理）');
      t.eq(currentPrologueCard(l)!.day, 1, '第 2 条还在序幕第 1 天');
      t.eq(prologueCardOf(6)!.day, 2, '第 6 条进序幕第 2 天');
    });

    t.test('★ `skipToOpening`（「直接正式开始游戏」）：掐掉未读的 · 保留已结算的 · 铺末条；幂等', () => {
      let l = startPrologue(initialLedger()).ledger;
      // 先点掉 2 条 —— 它们是这一局的开局记忆，跳过之后必须保留
      l = choosePopup(l, 'e1', 0).ledger;
      l = choosePopup(l, 'e2', 0).ledger;
      const r = skipToOpening(l);
      const laid = popupCards(r.ledger);
      t.eq(laid.length, 3, 'live 里 = 2 条已结算 + 末条');
      t.ok(laid.filter((e) => e.status === '待处理').every((e) => e.id === 'e10'),
        '★ 待处理的只剩末条（其余 6 条没读的全被掐掉 —— 闸门 ④ 从此放行）');
      t.ok(laid.some((e) => e.id === 'e1' && e.status === '已结算'), '★ 已结算的保留（`prologueFinished` 靠它们成立）');
      t.ok(r.log.some((x) => x.includes('跳过 6 条')), `日志要报跳过几条：\n${r.log.join('\n')}`);
      t.ok(r.log.some((x) => x.includes('原初欲望的觉醒')), '日志要说末条出现了');
      // 幂等：末条已在 ⇒ 不重复铺
      const again = skipToOpening(r.ledger);
      t.eq(again.ledger.events.live.filter((e) => e.id === 'e10').length, 1, '末条不重复铺');
      // 非序幕账本 ⇒ 一个字不动（同一引用）
      const bare = initialLedger();
      t.eq(skipToOpening(bare).ledger, bare, '不是序幕 ⇒ 原样返回（不替它开始）');
    });
  },
};

const 编排与翻牌: Suite = {
  name: 'P4-D · 序幕编排与开局（afterPrologueCard / driveOpening · **玩家自己选**）',
  register(t: T) {
    t.test('非序幕 id ⇒ 原样返回（同一个账本引用、零日志、`opening:false`）', async () => {
      const l = initialLedger();
      const r = await afterPrologueCard(l, 'e99', fakeBrain(), DEFAULT_CHOICE);
      t.eq(r.ledger, l, '★ 正文的档 A 走到这里什么都不该发生（连克隆都不许有）');
      t.deep(r.log, [], '不记日志');
      t.eq(r.opening, false, '没开局');
    });

    t.test('非末条 ⇒ 铺下一条；末条 ⇒ 开局（两条路的 `opening` 标记必须分得开）', async () => {
      const p = prologueRng(1);
      const a = await afterPrologueCard(startPrologue(initialLedger()).ledger, 'e1', fakeBrain(), DEFAULT_CHOICE);
      t.eq(a.opening, false, '`e1` 不是末条');
      t.eq(popupCards(a.ledger).length, 8, '点掉 `e1` 后仍 8 条（全铺过 ⇒ 空转，末条不出现）');
      t.eq(a.ledger.desire.manifesto, '', '还没开局');

      const nine = await playTo(initialLedger(), 9);
      t.eq(popupCards(nine).length, 9, '点完 8 条非末条 ⇒ 末条铺出 ⇒ live 里 9 条（8 已结算 + 1 待处理）');
      const b = await afterPrologueCard(nine, 'e10', fakeBrain(), DEFAULT_CHOICE);
      t.eq(b.opening, true, '★ `e10` 是末条 ⇒ 开局');
      t.ok(b.ledger.desire.manifesto !== '', '★ 宣言落账（玩家挑的那一句）');
      t.ok(b.ledger.desire.proposition !== '', '★ 判据非空 —— 没有它整局就没有「欲望」可言');
      t.ok(b.ledger.desire.manifesto !== '', '★ 宣言非空（玩家自己写下的那句）');
      t.ok(b.ledger.desire.past !== '', '人物描述非空（只看这一次）');
      const attrs = playerAttrs(b.ledger);
      t.ok(attrs.some((v) => v !== 5), `★ 六维不再停在占位全 5（实得 ${attrs.join('/')}）`);
      // ⚠️ **2026-10-05**：硬约束从「均值 ≤ 10」改成「**总和恒 60**」（用户裁定「不多不少」）
      t.eq(attrs.reduce((s, v) => s + v, 0), 60, '★ 六维总和必须是 60');
      t.eq(b.ledger.desire.value, 30, '★ 开局**不动欲念** —— 它只写欲望 / 宣言 / 六维 / 人物描述 / 原卡');
    });

    // ── ★★ 2026-10-06：序幕**彻底不问模型** ⇒ 那四条"落地被拒 ⇒ 再要一次"的测试
    //    连同它们要验的机制**一起退休**（重试通道是给"模型这次不行"准备的，
    //    而模型已不参与开局）。下面这条替代它，钉住**真正要保证的东西**。
    t.test('★★ 序幕**零 LLM**：欲望 ＋ 六维当场落账，且 `brain.opening` 不存在', async () => {
      const base = fakeBrain();
      // ★ 判据一：`brain` 上**根本没有** `opening` 这个方法了 ——
      //   它要是还在，就说明"序幕零 LLM"只是改了个名字，模型照样会被叫一次。
      t.eq(
        typeof (base as unknown as Record<string, unknown>)['opening'],
        'undefined',
        '★★ `brain.opening` 还在 —— 序幕没有真正做到零 LLM',
      );
      // ★ 判据二：账本**当场**就是完整的（六维不是占位全 5、欲望已落）。
      //   旧版这里要等一次网络往返才补齐，现在一步到位。
      const s0 = await Session.start({ seed: 20260921, skipPrologue: true, choice: DEFAULT_CHOICE });
      const me = s0.ledger.entities.people.find((x) => x.id === PLAYER_ID);
      t.ok(!!me, "账本里有玩家");
      const sum = ATTR_KEYS.reduce((acc, k) => acc + (me!.attrs[k] ?? 0), 0);
      t.eq(sum, 60, '★ 六维总和恒 60（规则层一步算完，不经模型）');
      t.ok(s0.ledger.desire.manifesto !== '', '★ 欲望宣言当场落账');
      // ★ 判据三：玩家那句固定描述**开局就在** `Person.desc` 上（不是模型产的）。
      t.eq(me!.desc, PLAYER_DESC, "★★ 玩家描述必须是那句固定文本");
    });
    t.test('★ `prologueRng` 与正文那条 `rng` 是两条流（同种子也不同值）', () => {
      const p = prologueRng(7);
      const b = makeRng(7);
      const pv = [p.int(1000), p.int(1000), p.int(1000)];
      const bv = [b.int(1000), b.int(1000), b.int(1000)];
      t.ok(
        pv.join(',') !== bv.join(','),
        `★ 开局翻牌若伸进正文那条流，28 天基线会整体挪位（实测过：seed 7 的「trigger」唤醒由 ✓ 变 ✗）` +
          `　序幕 ${pv.join(',')} vs 正文 ${bv.join(',')}`,
      );
    });

    t.test('★ 走完整个序幕之后，正文那条 `rng` 一个骰子都没摇过', async () => {
      const s = await Session.start({ seed: 7 });
      t.eq(s.rng.log.length, 0, '★ 序幕期（点牌 / 翻牌）零掷骰 —— 轨迹隔离是**结构保证**，不是运气');
      for (let i = 0; i < 10; i++) {
        const card = s.view().prologue;
        if (!card) break;
        await s.clickPopup(`e${card.seq}`, 0);
      }
      t.eq(s.rng.log.length, 0, '★ 10 条点完 ＋ 末条翻牌之后，正文流仍然是 0 个骰子');
    });
  },
};

const 会话层接线: Suite = {
  name: 'P4-D · 序幕的会话层接线（ui/session.ts）',
  register(t: T) {
    t.test('★ `Session.start` 默认停在序幕 day 0：一次铺 8 条 · 视图报 1/9 · 末条未现', async () => {
      const s = await Session.start({ seed: 20260921 });
      const v = s.view();
      t.eq(v.day, 0, '★ 序幕不是"第 0 天"意义上的第 0 天，但 `clock.day` 就是 0（显示「Day 0」）');
      t.eq(v.phase, '序幕', '阶段是序幕');
      t.eq(v.popups.length, 8, '★ 一次全铺 8 条 ⇒ 弹窗 8 个（平铺 · 自由点选，顺序不再靠结构）');
      t.deep(v.prologue, { seq: 1, total: 9, day: 1, remaining: 8, openingLaid: false },
        '★ 视图要能告诉玩家"在读第几条、末条出现了没"（按钮随 `openingLaid` 消失）');
      t.eq(v.popups[0].title, '朝会', '第 1 条是朝会');
      t.eq(v.gold, 0, '序幕不发钱 —— 「金币 5」是进入第 1 天那次周例钱');
      t.eq(v.desire.value, 30, '序幕占位欲念 30');
      t.eq(v.desire.manifesto, '', '还没开局');
      t.eq(v.todo.length, 0, '序幕没有待办（全档 A）');
      t.eq(v.isFinalDay, false, '离终局还远');
    });

    t.test('★ 闸门 ④ 真的拦住了「进下一天」—— 序幕没读完就过不去', async () => {
      const s = await Session.start({ seed: 20260921 });
      const nd = await s.nextDay();
      t.eq(nd.ok, false, '★ 这条判据在 `rules/gates.ts` 里本来就写着 `advanceDay`，但此前**没有调用侧问过它**');
      t.ok(nd.error.includes('档 A'), `错因要说清是档 A 未清：${nd.error}`);
      t.eq(s.view().day, 0, '★ 被拦下 ⇒ 时钟纹丝不动（不许"拦了但还是翻页了"）');

      // 点掉一条（还剩 7 条）—— 照样拦
      await s.clickPopup('e1', 0);
      t.eq((await s.nextDay()).ok, false, '★ 清了 1 条还剩 7 条，仍然拦');
      t.eq(s.view().popups.length, 7, '剩下 7 条还在等玩家点（不再"铺下一条"）');
    });

    // ── ★★ 2026-10-05：末条**必须先选欲望**，否则那条会被点掉 = 弹窗卡死 ──
    t.test('★★ 没选欲望就点末条 ⇒ **被拒，且那一条不许被点掉**', async () => {
      // ⚠️ 这是本轮实测抓到的**真 bug**：预检若放在 `choosePopup` 之后，
      //    `applyPlayerChoice` 抛出来时那一条**已经 已结算** ⇒ 玩家再点只会得到
      //    「这条已经结算过了」⇒ 表现为卡死（2026-09-23 修过一次的同一类症状）。
      //    ⇒ 判据分三样：拒 / **还站着** / 欲望还是空的。
      const s = await Session.start({ seed: 20260921 });
      for (let i = 1; i <= 9; i++) await s.clickPopup(`e${i}`, 0);
      t.eq(s.view().prologue!.seq, 10, '站在末条上');

      const r = await s.clickPopup('e10', 0);
      t.eq(r.ok, false, '★ 没选就该被拒');
      t.ok(r.error.includes('挑一句'), `错因要说清是"还没选"：${r.error}`);
      t.eq(
        s.ledger.events.live.find((e) => e.id === 'e10')?.status,
        '待处理',
        '★★ 那一条**必须还在「待处理」** —— 被点掉就再也点不到了（这才是"卡死"的机制）',
      );
      t.eq(s.view().prologue!.seq, 10, '★ 仍站在末条上');
      t.eq(s.ledger.desire.manifesto, '', '★ 欲望一个字都没落（不是"落了一半"）');
      t.eq(s.ledger.desire.proposition, '');

      // 选完就能过 —— 证明它拦的是"没选"，不是"这条有问题"
      t.ok(s.pickDesire(1, ['魅力']).ok, '选一条欲望');
      const r2 = await s.clickPopup('e10', 0);
      t.ok(r2.ok, `选完就该过：${r2.error}`);
      t.eq(s.ledger.desire.manifesto !== '', true, '★ 这次真的落账了');
    });

    t.test('★ 逐条点完 9 条（原第 5 条已删）⇒ 斗篷落下：末条定下欲望 · 判据出现 · 再点「进下一天」进第 1 天', async () => {
      const s = await Session.start({ seed: 20260921 });
      for (let i = 1; i <= 9; i++) {
        const seq = s.view().prologue!.seq;
        // ⚠️ 2026-10-07：seq 保号（1,2,3,4,6,7,8,9,10）—— 第 5 次点击时读的是 seq 6。
        t.eq(seq, [1, 2, 3, 4, 6, 7, 8, 9, 10][i - 1], `第 ${i} 次点击时该读的是第 ${seq} 条`);
        // ⚠️ **2026-10-05**：末条之前必须**先选好欲望**（`clickPopup` 会在点掉之前预检，
        //    没选就点 ⇒ 那一条会被点掉、玩家再也点不到 = 弹窗卡死）。
        //    ⇒ 这条测试现在**照真实玩法走**：第 8 条点完、站在末条上时先 `pickDesire`。
        if (seq === 10) {
          const need = s.view().desirePick.needsChoice;
          t.eq(need, true, '★ 站在末条上 ⇒ 视图说"该选了"');
          const p = s.pickDesire(3, ['智慧']);
          t.ok(p.ok, `选欲望：${p.error}`);
          t.eq(s.view().desirePick.needsChoice, true, '选完仍在末条上（还没点那条 ⇒ 还没落账）');
        }
        const r = await s.clickPopup(`e${seq}`, 0);
        t.ok(r.ok, `点第 ${seq} 条：${r.error}`);
      }
      t.eq(s.view().prologue, null, '★ 9 条读完 ⇒ 视图不再报"在读第几条"');
      t.eq(s.view().popups.length, 0, '弹窗清空');
      t.ok(s.view().desire.manifesto !== '', '★ 末条点下**即定下欲望**（"点下按钮即出牌"）');
      t.ok(s.view().desire.proposition !== '', `命题已产出：「${s.view().desire.proposition}」`);
      t.eq(s.view().day, 0, '★ 翻牌 ≠ 进第 1 天：玩家还要自己按「进下一天」');

      const nd = await s.nextDay();
      t.ok(nd.ok, `进下一天：${nd.error}`);
      const v = s.view();
      t.eq(v.day, 1, '★ 序幕 → 第 1 天走的是同一个「进下一天」口子（**不走 A/B/C 那条时间通道**）');
      t.eq(v.phase, '正文', '阶段切到正文');
      t.eq(v.chapter, 1, '第 1 天在第 1 章');
      t.eq(v.gold, 5, '《设定.md》：金币 5 = 进入第 1 天发的那次周例钱');
      t.eq(v.usedToday, 0, '时间读数归零');
      t.eq(v.ambience !== null, true, '★ 第 1 天本身就是占卜日 ⇒ 当场该有"本周氛围"');
      t.eq(
        s.ledger.summaries.recent.filter((r) => r.day === 0).length,
        8,
        '★ 8 条序幕固定概要**还在** —— 它自然就并进了【已处理概要】（生成侧唯一的"开局记忆"）',
      );
      t.eq(s.ledger.idWatermark.event >= 10, true, '★ 水位没被正文顶掉（正文第一条生成事件从 `e11` 起）');
      t.ok(!s.ledger.events.live.some((e) => e.id === 'e1' && e.status === '待处理'), '序幕事件都已结算');
    });

    t.test('`skipPrologue` ⇒ 与 P4-D 之前逐字同构（day 1 / 金币 5 / 欲念 30 / 命题非空）', async () => {
      const s = await Session.start({ seed: 20260921, skipPrologue: true });
      const v = s.view();
      t.eq(v.day, 1, '直接开在第 1 天');
      t.eq(v.prologue, null, '视图不报序幕');
      t.eq(v.gold, 5, '周例钱已发');
      t.eq(v.desire.value, 30, '欲念 30');
      t.ok(v.desire.proposition !== '', '明着翻过一次牌');
      t.eq(v.popups.length, 0, '一条序幕弹窗都没有');
      t.eq(s.ledger.summaries.recent.filter((r) => r.day === 0).length, 0, '没有序幕固定概要');
      t.eq(
        s.ledger.events.live.filter((e) => isPrologueEventId(e.id)).length,
        0,
        '★ 跳过序幕 ⇒ 账本里一条序幕事件都没有',
      );
      t.ok(
        s.ledger.idWatermark.event >= PROLOGUE_TOTAL,
        `★ 水位在开局就是 10 ⇒ 正文生成从 \`e11\` 起（实得 ${s.ledger.idWatermark.event}）`,
      );
      t.ok(
        !s.ledger.events.live.some((e) => e.id === 'e1'),
        '★ 正文**绝不许**生成出一条叫 `e1` 的事件（那会被当成序幕第 1 条 —— 实测踩过）',
      );
    });

    t.test('★ 两条路只差"序幕那一段"：同种子 ⇒ 欲念 / 金币 / 六维 / 命题逐字相同', async () => {
      const a = await Session.start({ seed: 7, skipPrologue: true });
      const b = await Session.start({ seed: 7 });
      // ⚠️⚠️ **这里原来写的是 `while (b.view().prologue) await b.clickPopup(...)`** ——
      //    它假设"点一次就一定往前走一步"。2026-10-05 加的**末条预检**
      //    （没选欲望就拒）打破了这个假设：`e10` 点不动 ⇒ 账本不前进 ⇒ `prologue` 恒为真
      //    ⇒ **死循环**（实测把整个 `prologue.test.ts` 拖到 60 秒以上还不结束）。
      //    ⇒ 两条补救，**都要有**：
      //      ① 站在末条上时**先选欲望**（照真实玩法走）；
      //      ② 循环加**硬上界** —— 将来再有类似的"某一步点不动"，这里**当场炸**，
      //         而不是把整轮测试挂死（挂死的代价是"看不出哪一条坏了"）。
      for (let step = 0; step < 40; step++) {
        const p = b.view().prologue;
        if (!p) break;
        // ⚠️ 必须用**与 `skipPrologue` 那条路完全同一个选择**（`DEFAULT_CHOICE`），
        //    否则两条路的六维天然不同 —— 下面那条「六维相同」当场红（实测踩过）。
        if (p.seq === 10) b.pickDesire(DEFAULT_CHOICE.kit, [...DEFAULT_CHOICE.advantages]);
        const r = await b.clickPopup(`e${p.seq}`, 0);
        t.ok(r.ok, `第 ${p.seq} 条必须点得动（点不动就会死循环）：${r.error}`);
      }
      t.eq(b.view().prologue, null, '★ 10 条都点完了（没点完说明上面那个循环被上界截断了）');
      await b.nextDay();

      t.eq(b.view().day, 1, '两条路都落在第 1 天');
      t.eq(b.view().desire.value, a.view().desire.value, '★ 欲念相同（序幕一条都不动它）');
      t.eq(b.view().gold, a.view().gold, '★ 金币相同');
      t.deep(b.view().me.attrs, a.view().me.attrs, '★ 六维相同 —— 同一条 `prologueRng`、同一个种子 ⇒ 同一副牌');
      t.eq(b.view().desire.proposition, a.view().desire.proposition, '★ 命题相同');
      t.eq(b.view().ambience, a.view().ambience, '★ 第 1 天的章节占卜相同（那条流也没被序幕碰过）');
      // 唯一该有的差异：那 9 条事件 ＋ 8 条纲要 ＋ 水位
      t.eq(
        b.ledger.events.live.length - a.ledger.events.live.length,
        9,
        '★ 账本差异**恰好**是序幕那 9 条（多一条都是别的地方漏了账）',
      );
      t.eq(
        b.ledger.idWatermark.event,
        a.ledger.idWatermark.event,
        '★ 事件水位**相同** —— 序幕那十个号两条路都是开局订走的（正文命名空间一致）',
      );
      t.deep(
        b.ledger.events.live.filter((e) => !isPrologueEventId(e.id)).map((e) => e.id).sort(),
        a.ledger.events.live.map((e) => e.id).sort(),
        '★ 正文事件的 id **逐字相同** —— 序幕没有顶掉任何一个号',
      );
    });
  },
};

const 驱动接线: Suite = {
  name: 'P4-D · 序幕的驱动接线（turn/simulate.ts）',
  register(t: T) {
    t.test('★ 无头驱动默认跑序幕：`prologuePopups === 9`，且 0 违规', async () => {
      const r = await simulate(7);
      t.eq(r.stats.prologuePopups, 9, '★ 驱动与 UI 走同一条路 —— 不跑序幕就是"驱动少跑了一段"');
      t.eq(r.violations.length, 0, `0 违规：\n${r.violations.join('\n')}`);
      t.eq(r.coverage.every((c) => c.ok), true, '覆盖率全部达标');
      const prog = r.coverage.find((c) => c.name.includes('序幕走完'));
      t.ok(!!prog && prog.ok, `★ 「序幕走完」这条覆盖率必须存在且为真（防"断言没写"）：${prog?.detail ?? '（没有这条）'}`);
      const summ = r.coverage.find((c) => c.name.includes('序幕固定概要已并入'));
      t.ok(!!summ && summ.ok, `★ 「序幕固定概要已并入」也必须存在：${summ?.detail ?? '（没有这条）'}`);
      // ⚠️ 2026-10-07 从 64 改 66：排布循环加了「撒手救场」（day 16 池里只剩被撒手的 e34 ＋
      //    一条仅派遣 ⇒ 整天空转），救场当天真的把 e34 办掉了 ⇒ 欲念轨迹 +2。
      //    这条钉的是"序幕不动轨迹"（上下两个对照局仍逐字相同），绝对值只是金丝雀。
      t.eq(r.ledger.desire.value, 66, '★ 收口欲念金丝雀（2026-10-07 起为 66 —— 救场把 e34 真的办掉了）');
    });

    t.test('★ 跑不跑序幕，正文 28 天的轨迹**逐字相同**（随机流隔离的端到端证明）', async () => {
      const with_ = await simulate(7);
      const without = await simulate(7, 28, { skipPrologue: true });
      t.eq(with_.ledger.desire.value, without.ledger.desire.value, '★ 欲念相同');
      t.eq(with_.ledger.scalars.gold, without.ledger.scalars.gold, '★ 金币相同');
      t.eq(with_.stats.arranged, without.stats.arranged, '★ 排布数相同');
      t.eq(with_.stats.popups, without.stats.popups, '★ 正文弹窗数相同（序幕那 9 条**单独计**，不掺进来）');
      t.eq(with_.stats.revealed, without.stats.revealed, '★ 揭晓数相同');
      t.eq(with_.stats.expired, without.stats.expired, '★ 过期数相同');
      t.eq(with_.stats.rewrites, without.stats.rewrites, '★ 重写命题次数相同');
      t.eq(with_.stats.daysEntered, without.stats.daysEntered, '★ 进入天数相同');
      t.eq(with_.stats.prologuePopups, 9, '跑了的这边序幕 9 条');
      t.eq(without.stats.prologuePopups, 0, '跳过的那边是 0（不许"跳过还照算"）');
      t.eq(with_.ledger.ending!.row, without.ledger.ending!.row, '★ 结局同一行');
      t.eq(
        with_.ledger.events.live.length - without.ledger.events.live.length,
        9,
        '★ 全部差异就是序幕那 9 条事件（多一条都说明串味了）',
      );
      // 跳过的那条路要照旧翻牌：否则跑的是"从没翻过牌的三王子"
      t.ok(without.ledger.desire.manifesto !== '', '★ `skipPrologue` 也要明着开一次局（与 P4-D 之前同构）');
      t.ok(without.ledger.desire.proposition !== '', '命题非空');
    });
  },
};

export const suites: Suite[] = [内容表, 写入侧, 编排与翻牌, 会话层接线, 驱动接线];
