// `chapter_shift` 全链测试（P4-C 第二条侧链）—— 规则层 / 落地层 / 装配 / T0 接线
//
// ⚠️ 这条侧链最值得测的是**四处没人替我们兜的地方**：
//   ① **占卜日不含第 1 天的那个坑**：`clock.ts·isChapterStart` 是 `day > 1 && (day-1) % 7 === 0`
//      ⇒ 它在第 1 天返回 **false**，而占卜日**含第 1 天**（《设定.md》§三：第 1 章的氛围
//      由第 1 天的占卜定）。两处若共用一份判据，第 1 章就永远没有氛围，而且**没人会报错**；
//   ② **第 1 天不落账 ＋ 钳 −20~+20** —— 服务端对模型输出**完全不校验**
//      （Phase 0 §三：`minimum`/`maximum` 一概穿透）⇒ 这两条只能在规则层兜；
//   ③ ⚠️⚠️ **「命中原卡」双轨已整条删除**（2026-10-05 用户裁定：「玩家的欲望就根本
//      不需要塔罗牌的参与」）—— 欲望不再有原卡，比对基准不存在，那条轨无法存在。
//      下面 ② 这一节**只钉剩下的那一条轨**（模型相关性），
//      并用一条断言**把"别把它改回来"钉死**（那正是用户划掉的东西）；
//   ④ 氛围与欲念变化是**同一次占卜的两半** ⇒ 必须**原子**（拒了就连氛围一起不落，
//      否则"氛围写了但欲念没写"会让这一章的事件生成与欲念节奏对不上，且没人看得出）。
import { readFileSync } from 'node:fs';
import { renderStaticHead } from '../frozen/static-head.ts';
import { initialLedger } from '../ledger/initial.ts';
import type { Ledger } from '../ledger/types.ts';
import {
  AMBIENCE_MAX,
  CORRELATION_MAX,
  CORRELATION_MIN,
  DIVINATION_DAYS,
  isDivinationDay,
  resolveDesireChange,
} from '../rules/chapter-shift.ts';
import { chapterOf, isChapterStart } from '../rules/clock.ts';
import { DESIRE_MAX, DESIRE_MIN } from '../rules/desire.ts';
import { makeRng } from '../rules/rng.ts';
import { drawDivinationCards, cardLabel, type DivinationCards } from '../rules/tarot.ts';
import { assembleDivination } from '../prompt/assemble.ts';
import { ambienceBlock, playerDesireBlock } from '../prompt/blocks.ts';
import { INSTRUCTION_DIVINATION } from '../prompt/instructions.ts';
import { fakeBrain } from '../fixtures/fake.ts';
import { applyChapterShift, ChapterShiftRejected, divinationRng } from '../turn/chapter-shift.ts';
import { driveOpening } from '../turn/prologue.ts';
import * as chapterShiftModule from '../rules/chapter-shift.ts';
import { enterDay } from '../turn/t0.ts';
import type { Suite } from './harness.ts';

// ── 夹具 ─────────────────────────────────────────────────────────

/** 两张牌（占卜**仍然抽牌** —— 那是**世界层**的氛围读数，与玩家的欲望无关） */
const CARDS: DivinationCards = [
  { name: '月亮', reversed: false },
  { name: '星星', reversed: true },
];
/**
 * **另一副**牌 —— 只为"换副牌 ⇒ system 真的不同"那一条。
 * ⚠️ 2026-10-06：这一份是**补回来的** —— 我早先把两个不同的牌组夹具
 *    （`HIT_2_UP` / `MISS`）统一 replace 成了 `CARDS` ⇒ 那条"换一副牌"的断言
 *    变成了"同一副牌比两次"，当场假红。**批量替换夹具名时要把"用作对照的那一份"留出来。**
 */
const CARDS2: DivinationCards = [
  { name: '太阳', reversed: true },
  { name: '战车', reversed: false },
];

/** 某个「第 N 天」的账本（只改时钟与欲念 —— 其余照 `initialLedger` 的序幕占位） */
function atDay(day: number, o: { desire?: number } = {}): Ledger {
  const l = structuredClone(initialLedger());
  l.clock.day = day;
  l.clock.chapter = chapterOf(day);
  l.clock.usedToday = 0;
  if (o.desire !== undefined) l.desire.value = o.desire;
  return l;
}

/** 一份合格的占卜输出（氛围 18 字 < 30） */
function good(change: number, ambience = '铁与盐的味道先到，王城在等一个许可。'): Record<string, unknown> {
  return { 章节欲念变化: change, 章节氛围: ambience };
}

export const suites: Suite[] = [
  // ── ① 占卜日谓词 ────────────────────────────────────────────────
  {
    name: '章节占卜 · 占卜日谓词',
    register(t) {
      t.test('★ 占卜日 = 第 1 / 8 / 15 / 22 天', () => {
        t.deep([...DIVINATION_DAYS], [1, 8, 15, 22], '四个占卜日');
        for (const d of DIVINATION_DAYS) t.ok(isDivinationDay(d), `第 ${d} 天应当是占卜日`);
        for (const d of [2, 3, 7, 9, 14, 16, 21, 23, 28]) {
          t.ok(!isDivinationDay(d), `第 ${d} 天不该是占卜日`);
        }
      });

      t.test('★★ `isChapterStart` 在第 1 天返回 false，而占卜日**含**第 1 天 —— 就是那个坑', () => {
        // 这一条是**定点**：它把一个"两个集合长得像、其实不是一个"的错误钉死在这里。
        // `{8,15,22}` vs `{1,8,15,22}` —— 差的就是第 1 天。
        t.eq(isChapterStart(1), false, '`isChapterStart` 回答的是"切换到新一章"，第 1 天不是切换');
        t.eq(isDivinationDay(1), true, '第 1 章的氛围只能由**第 1 天**的占卜定 ⇒ 它必须是占卜日');
        for (const d of [8, 15, 22]) {
          t.eq(isChapterStart(d), true, `第 ${d} 天是章节切换点`);
          t.eq(isDivinationDay(d), true, `第 ${d} 天也是占卜日`);
        }
      });
    },
  },

  // ── ② 「命中原卡」已整条删除（2026-10-05 用户裁定）────────────────
  //
  // ⚠️ **这一节是"反向断言"**：它不测功能，测的是**那条轨不许回来**。
  //    原来这里是：同名即命中（判据只是牌名）→ 系统查表 ±10 → 忽略模型给的那个数。
  //    用户裁定「玩家的欲望就根本不需要塔罗牌的参与」⇒ 欲望不再有原卡，
  //    比对基准不存在，那条轨无法存在 ⇒ 整条删掉。
  {
    name: '章节占卜 · ★ 牌与欲望已彻底解耦（「命中原卡」那条轨不许回来）',
    register(t) {
      t.test('★★ 规则层**不再导出**任何"命中/查表"的东西', () => {
        // 这条是**结构断言**：它量的是"导出面"本身。
        // ⚠️ 为什么要有它：删掉一条机制很容易，**半年后有人顺手加回来**很难拦 ——
        //    而那正是用户明确划掉的（「不要画蛇添足」）。
        //    断言写法刻意用"这些名字**不该**能被 import"—— 真加回来了，import 就在、
        //    这条测试**连编译都过不了**（比运行时红更早暴露）。
        const mod = chapterShiftModule as Record<string, unknown>;
        for (const gone of ['HIT_VALUE', 'hitDelta', 'hitOriginalCards']) {
          t.eq(mod[gone], undefined, `★ \`${gone}\` 又出现了 —— 「命中原卡」那条轨被加回来了？`);
        }
        // `resolveDesireChange` 的返回值里也不该再有 `hits` / `noOriginal`
        const ch = resolveDesireChange(8, CARDS, 5) as unknown as Record<string, unknown>;
        t.eq(ch['hits'], undefined, '★ `DesireChange.hits` 又出现了（那是原卡的命中列表）');
        t.eq(ch['noOriginal'], undefined, '★ `DesireChange.noOriginal` 又出现了（那是"有没有原卡"）');
      });

      t.test('★★ 账本上**不再有 `desire.cards`** —— 欲望与牌之间没有任何字段', () => {
        const l = initialLedger();
        t.eq(
          Object.keys(l.desire).includes('cards'),
          false,
          '★ `desire.cards` 又回来了 —— 欲望重新和塔罗挂上了',
        );
        t.deep(
          Object.keys(l.desire).sort(),
          ['advantages', 'kit', 'manifesto', 'means', 'proposition', 'value'],
          '★ `desire` 的字段清单就是这六个（多一个就是又挂上了什么；' +
            '2026-10-06 起 `past` 已删 —— 序幕不再问模型）',
        );
      });

      t.test('★★ 序幕**彻底不问模型**（2026-10-06 用户裁定）—— 欲望 ＋ 六维都是规则层的事', () => {
        // 判据用**导入面**：`driveOpening.length` = 必填参数个数 = (l, brain, choice) = 3。
        // ⚠️ `brain` 是**遗留参数**（保留是为了不让调用侧改），它**不再被使用**。
        t.eq(driveOpening.length, 3, '★ `driveOpening` 的参数个数变了');
        // ★ 真正的判据：`brain.opening` 这个方法**必须不存在**了 ——
        //   它要是还在，就说明"序幕零 LLM"只是改了个名字。
        t.eq(
          typeof (fakeBrain() as unknown as Record<string, unknown>)['opening'],
          'undefined',
          '★★ `brain.opening` 还在 —— 序幕没有真正做到零 LLM（buildOpeningRequest / assembleOpening / schema 那一路都该一起消失）',
        );
      });

      t.test('★ 占卜**仍然抽牌** —— 但那张牌只作世界层氛围，与欲念数值无关', () => {
        // ⚠️ 区分两件事：**牌没有从游戏里消失**（占卜要读世界氛围），
        //    消失的是**牌与欲望之间的那条线**。这条断言把界线钉在这里。
        const c = drawDivinationCards(divinationRng(7, 8));
        t.eq(c.length, 2, '占卜仍抽两张');
        // 无论抽到什么，欲念变化都只由模型给的那个数决定
        t.eq(resolveDesireChange(8, c, 7).delta, 7, '牌换了，delta 仍是模型给的那个数');
      });
    },
  },
  {
    name: '章节占卜 · 欲念变化（第 1 天不落账 · 钳 −20~+20 · 唯一那条轨）',
    register(t) {
      t.test('★★ 第 1 天：氛围照写，但**欲念一个字都不动**', () => {
        const ch = resolveDesireChange(1, CARDS, -20);
        t.eq(ch.track, '不结算');
        t.eq(ch.delta, 0, '《契约.md》§6.6：第 1 天不结算');
        // ⚠️ 牌照样记在结果里（供日志看"这一章抽到了什么"），但**它不参与 delta**。
        t.eq(ch.drawn.length, 2, '抽到的两张仍如实记下，供开发侧日志用');
      });

      t.test('★★ 唯一那条轨：delta = 模型给的相关性（牌**不参与**）', () => {
        // ⚠️ 同一副牌配不同的模型值 ⇒ delta 跟着**模型值**走，不是跟着牌走。
        //    这条是"牌与欲望无关"的正面表述。
        t.eq(resolveDesireChange(8, CARDS, 7).delta, 7);
        t.eq(resolveDesireChange(8, CARDS, -7).delta, -7);
        t.eq(resolveDesireChange(8, CARDS, 7).track, '模型');
      });

      t.test(`★ 模型值先钳 [${CORRELATION_MIN}, ${CORRELATION_MAX}]（服务端不校验 ⇒ 只能这里钳）`, () => {
        t.eq(resolveDesireChange(8, CARDS, 999).delta, CORRELATION_MAX);
        t.eq(resolveDesireChange(8, CARDS, -999).delta, CORRELATION_MIN);
        t.eq(resolveDesireChange(8, CARDS, 20).delta, 20, '边界原样通过（"≤"不是"<"）');
        t.eq(resolveDesireChange(8, CARDS, -20).delta, -20);
        t.eq(resolveDesireChange(8, CARDS, 21).delta, 20);
      });

      t.test('★ 非数字 / 缺键 / 小数 ⇒ 当 0 用（**不抛**：氛围还等着落账）', () => {
        t.eq(resolveDesireChange(8, CARDS, '很多').delta, 0);
        t.eq(resolveDesireChange(8, CARDS, undefined).delta, 0);
        t.eq(resolveDesireChange(8, CARDS, null).delta, 0);
        t.eq(resolveDesireChange(8, CARDS, NaN).delta, 0);
        t.eq(resolveDesireChange(8, CARDS, 7.9).delta, 7, '小数截断，不是四舍五入');
      });
    },
  },

  // ── ④ 抽牌与随机流 ──────────────────────────────────────────────
  {
    name: '章节占卜 · 抽牌与那条**独立**随机流',
    register(t) {
      t.test('同 (种子, 天) ⇒ 同一副牌（可重放）', () => {
        t.deep(drawDivinationCards(divinationRng(7, 8)), drawDivinationCards(divinationRng(7, 8)));
        t.deep(drawDivinationCards(divinationRng(42, 22)), drawDivinationCards(divinationRng(42, 22)));
      });

      t.test('两张**不重复**（一副牌阵里翻出两张同名的牌不合牌理）', () => {
        for (const day of DIVINATION_DAYS) {
          for (let s = 1; s <= 30; s++) {
            const c = drawDivinationCards(divinationRng(s, day));
            t.ok(c[0].name !== c[1].name, `seed ${s} 第 ${day} 天抽出了两张「${c[0].name}」`);
          }
        }
      });

      t.test('换种子 / 换天 ⇒ 真的会抽到不同的牌（种子与天都接上了）', () => {
        const bySeed = new Set<string>();
        for (let s = 1; s <= 8; s++) bySeed.add(drawDivinationCards(divinationRng(s, 8)).map(cardLabel).join('|'));
        t.ok(bySeed.size > 1, '8 个种子抽出来一模一样的牌 ⇒ 种子没接上');

        const byDay = new Set<string>();
        for (const d of DIVINATION_DAYS) byDay.add(drawDivinationCards(divinationRng(7, d)).map(cardLabel).join('|'));
        t.ok(byDay.size > 1, '四个占卜日抽出来一模一样的牌 ⇒ 天没接上');
      });

      t.test('★★ 占卜**不伸进正文那条 `rng`** —— 这是"不挪 28 天基线"的结构保证', () => {
        // 判据：把占卜种子换掉（占卜牌因此不同），`enterDay` 跑完之后**主 rng 的下一个读数
        // 必须一模一样**。若占卜偷偷从主 rng 里摇 4 个 `int`，这里当场红。
        // （与 `turn/simulate.ts·prologueRng` 是**同一条先例**：与轨迹无关的随机决策不要伸进那条流。）
        const ra = makeRng(99);
        const rb = makeRng(99);
        const probe = (rng: ReturnType<typeof makeRng>, seed: number): Promise<number> =>
          enterDay(atDay(8, {}), rng, fakeBrain(), seed).then(() => rng.int(1_000_000));
        return Promise.all([probe(ra, 111), probe(rb, 222)]).then(([a, b]) => {
          t.eq(a, b, '主 rng 的下一个读数随占卜种子变了 ⇒ 占卜伸进了正文那条流');
        });
      });
    },
  },

  // ── ⑥ 落地层（服务端不校验 ⇒ 这里是唯一防线）────────────────────
  {
    name: '章节占卜 · 落地层（服务端不校验 ⇒ 这里是唯一防线）',
    register(t) {
      t.test('★ 合格输出 ⇒ 氛围与欲念变化**两半一起落账**', () => {
        const r = applyChapterShift(atDay(8, { desire: 50 }), good(3), CARDS);
        t.eq(r.ledger.divination!.ambition, '铁与盐的味道先到，王城在等一个许可。');
        t.eq(r.ledger.desire.value, 53, '50 + 3（未命中 ⇒ 用模型值）');
        t.eq(r.before, 50);
        t.eq(r.after, 53);
        t.eq(r.change.track, '模型');
      });

      t.test('★ 单写者 —— 返回新账本，**不是就地改旧的**', () => {
        const l = atDay(8, { desire: 50 });
        const before = JSON.stringify(l);
        applyChapterShift(l, good(20), CARDS);
        t.eq(JSON.stringify(l), before, '入参账本被改坏了 ⇒ 落账不是原子的');
        t.eq(l.divination, null, '没跑过占卜时 `divination` 必须是 null');
        t.eq(l.desire.value, 50, '入参的欲念也不许被动');
      });

      t.test('★★ 原子：被拒之后**入参账本一字未动**（氛围不许单独落下）', () => {
        const l = atDay(8, { desire: 50 });
        const before = JSON.stringify(l);
        t.throws(
          () => applyChapterShift(l, { 章节欲念变化: 20, 章节氛围: '一'.repeat(AMBIENCE_MAX + 1) }, CARDS),
          `> ${AMBIENCE_MAX} 字`,
        );
        t.eq(JSON.stringify(l), before, '"氛围没写成但欲念动了"这类半落账不许存在');
      });

      t.test('★ 非占卜日调用 ⇒ **当场抛**（那是调用侧的接线错误，不是数据问题）', () => {
        for (const day of [2, 7, 14, 28]) {
          t.throws(
            () => applyChapterShift(atDay(day, {}), good(3), CARDS),
            '不是占卜日',
          );
        }
      });

      t.test('★ 氛围为空 / 全空白 / 非字符串 ⇒ 拒', () => {
        const l = () => atDay(8, { desire: 50 });
        t.throws(() => applyChapterShift(l(), good(3, ''), CARDS), '章节氛围为空');
        t.throws(() => applyChapterShift(l(), good(3, '   '), CARDS), '章节氛围为空');
        t.throws(() => applyChapterShift(l(), { 章节欲念变化: 3, 章节氛围: 42 }, CARDS), '章节氛围为空');
        t.throws(() => applyChapterShift(l(), { 章节欲念变化: 3 }, CARDS), '章节氛围为空');
      });

      t.test(`★ 氛围超过 ${AMBIENCE_MAX} 字 ⇒ 拒；**恰好** ${AMBIENCE_MAX} 字 ⇒ 过`, () => {
        t.throws(
          () => applyChapterShift(atDay(8, { desire: 50 }), good(3, '一'.repeat(AMBIENCE_MAX + 1)), CARDS),
          `> ${AMBIENCE_MAX} 字`,
        );
        const ok = applyChapterShift(
          atDay(8, { desire: 50 }),
          good(3, '一'.repeat(AMBIENCE_MAX)),
          CARDS,
        );
        t.eq([...ok.ledger.divination!.ambition].length, AMBIENCE_MAX);
      });

      t.test('★ 首尾空白先 trim 再计长（不然"带空格的一句话"会被误判超长）', () => {
        const r = applyChapterShift(atDay(8, { desire: 50 }), good(3, `  ${'一'.repeat(AMBIENCE_MAX)}  `), CARDS);
        t.eq(r.ledger.divination!.ambition, '一'.repeat(AMBIENCE_MAX));
      });

      t.test(`★ 欲念仍钳在 [${DESIRE_MIN}, ${DESIRE_MAX}]（同一道算术，别为侧链另开一条）`, () => {
        const lo = applyChapterShift(atDay(8, { desire: 5 }), good(CORRELATION_MIN), CARDS);
        t.eq(lo.ledger.desire.value, DESIRE_MIN, '5 − 20 ⇒ 封到 0');
        const hi = applyChapterShift(atDay(8, { desire: 95 }), good(CORRELATION_MAX), CARDS);
        t.eq(hi.ledger.desire.value, DESIRE_MAX, '95 + 20 ⇒ 封到 100');
      });

      // ⚠️ **2026-10-05 重写**：「命中原卡」那条轨整条删了（原卡不复存在）
      //    ⇒ 原来那几条「命中要写明走的是查表 / 忽略模型给的数」**前提消失**。
      //    现在只剩一条轨，要写清的变成：**唯一的那个数（钳制前后）＋ 第 1 天不结算**。
      t.test('★ 日志把**那唯一的数**与**第 1 天不结算**都写清了（开发侧唯一的可见性）', () => {
        const r = applyChapterShift(atDay(8, { desire: 50 }), good(3), CARDS);
        t.eq(r.change.llmClamped, 3, '钳制后的值要能被读到（不靠翻日志猜）');
        t.ok(r.log.join('\n').includes('采用模型判的相关性 3'), '要写明这次用的是模型那个数');
        t.ok(r.log.join('\n').includes('欲念 50 +3 → 53'), '欲念的前后要能一眼对账');

        // 钳制要留痕 —— 不然"模型给了个大数"这件事谁也看不见
        const clamped = applyChapterShift(atDay(8, { desire: 50 }), good(999), CARDS);
        t.eq(clamped.change.llmClamped, CORRELATION_MAX);
        t.ok(clamped.log.join('\n').includes('钳'), '钳制要留痕');
        t.ok(clamped.log.join('\n').includes(String(CORRELATION_MAX)), '日志里要写出钳到哪儿');

        const d1 = applyChapterShift(atDay(1, { desire: 30 }), good(-20), CARDS);
        t.ok(d1.log.join('\n').includes('不结算'), '第 1 天要写明它不落账');
        t.eq(d1.ledger.desire.value, 30, '第 1 天的欲念纹丝不动');
        t.ok(d1.ledger.divination!.ambition !== '', '但氛围照样落 —— 第 1 章的氛围就靠它');

        // ⚠️ 牌仍在日志里（它读的是**世界氛围**，与欲望无关）—— 这一行别删
        t.ok(d1.log.join('\n').includes(cardLabel(CARDS[0])), '抽到的两张牌面仍要进日志（世界层读数）');
        // ⚠️ 反向：日志里**不该**再提「原卡 / 查表」—— 那条轨不许回来
        for (const gone of ['原卡', '查表', '命中']) {
          t.ok(!r.log.join('\n').includes(gone), `★ 日志里又出现了「${gone}」—— 「命中原卡」那条轨回来了？`);
        }
      });

      t.test('异常类型是 `ChapterShiftRejected`（与"网络/解析失败"分开，便于决定要不要重试）', () => {
        let caught: unknown = null;
        try {
          applyChapterShift(atDay(8, {}), good(3, ''), CARDS);
        } catch (e) {
          caught = e;
        }
        t.ok(caught instanceof ChapterShiftRejected, '拒绝要走专用异常类');
      });
    },
  },

  // ── ⑦ 装配 ──────────────────────────────────────────────────────
  {
    name: '章节占卜 · 装配（三段式 system · 牌在段 ② · user ③ 只有氛围）',
    register(t) {
      t.test('★ system 以**静态头逐字开头** —— 段 ① 的缓存纪律（§1.3）', () => {
        const l = atDay(8, {});
        t.ok(assembleDivination(l, CARDS).system.startsWith(renderStaticHead(l)), 'system 不是以静态头开头的');
      });

      t.test('★ 换一副牌，差异必须落在静态头**之后**（牌面不许渗进段 ①）', () => {
        const l = atDay(8, {});
        const a = assembleDivination(l, CARDS);
        const b = assembleDivination(l, CARDS2);
        const common = (x: string, y: string): number => {
          let i = 0;
          while (i < x.length && i < y.length && x[i] === y[i]) i++;
          return i;
        };
        t.ok(common(a.system, b.system) >= renderStaticHead(l).length, '两张不同的牌让静态头就不一样了 ⇒ 段 ① 被牌面污染');
        t.ok(a.system !== b.system, '换了牌，system 必须真的不同（否则模型读的还是上一章的牌）');
      });

      t.test('★ 两张牌的占位符**真的被填**，且一个都不许剩', () => {
        const p = assembleDivination(atDay(8, {}), CARDS);
        t.ok(p.system.includes(cardLabel(CARDS[0])), '第一张的牌面没进 system');
        t.ok(p.system.includes(cardLabel(CARDS[1])), '第二张的牌面没进 system');
        t.ok(!p.system.includes('{第一张}') && !p.system.includes('{第二张}'), '占位符没被替换');
      });

      t.test('★ 三段式：system **以【玩家欲望】收尾**（会变的那一段压在最后）', () => {
        const l = atDay(8, {});
        const p = assembleDivination(l, CARDS);
        t.ok(p.system.endsWith(playerDesireBlock(l)), 'system 末段不是【玩家欲望】⇒ 三段式的次序错了');
        // ⚠️ 不能拿 `INSTRUCTION_DIVINATION` **整串**去比 —— 装配把两个占位符换掉了。
        //    取它到第一个占位符为止的那一段：那才是"必须逐字进 system"的部分。
        const head = INSTRUCTION_DIVINATION.slice(0, INSTRUCTION_DIVINATION.indexOf('{第一张}'));
        t.ok(p.system.includes(head), 'system 里没有逐字带上占卜指令（段 ② 的正文）');
      });

      t.test('★ user ③ 就是【本周氛围】那一块 ＋ 末行 —— **不另立【既有氛围】块**', () => {
        // 用户 2026-09-22 裁定：氛围全局只有这一个概念。占卜时它显示的是**上一章**的那一版
        // （第 1 天是哨兵 —— 还没有过）。⇒ 这一条把那个口径钉在这里。
        const l = atDay(8, { desire: 50 });
        const p = assembleDivination(l, CARDS);
        t.ok(p.user.startsWith(ambienceBlock(l)), 'user ③ 的首块不是【本周氛围】');
        t.ok(!p.user.includes('【既有氛围】'), '多出了一个文档里不存在的块名');
        t.ok(!p.user.includes('【他的欲望】'), '主链的首块不该出现在侧链的 user 里（命题在 system 末段）');
        t.ok(p.user.trim().length > 0, 'user 空串会让请求本身失效');
        t.eq(p.instruction, '占卜', '调用点名字要能在证据里认出来');
      });

      t.test('★ 段 ② 里**不许出现牌面** —— 占位符是牌面进 prompt 的唯一入口', () => {
        t.ok(!INSTRUCTION_DIVINATION.includes('· 正位') && !INSTRUCTION_DIVINATION.includes('· 逆位'));
        t.ok(INSTRUCTION_DIVINATION.includes('{第一张}') && INSTRUCTION_DIVINATION.includes('{第二张}'));
        t.ok(INSTRUCTION_DIVINATION.includes('并列'), '要点明这两张是并列、无顺序');
      });
    },
  },

  // ── ⑧ T0 接线 ───────────────────────────────────────────────────
  {
    name: '章节占卜 · T0 接线（第 1 / 8 / 15 / 22 天日初 · 生成之前）',
    register(t) {
      t.test('★ 占卜日 `enterDay` 真的落氛围（返回值与账本两边一致）', async () => {
        const r = await enterDay(atDay(8, {}), makeRng(7), fakeBrain(), 7);
        t.ok(r.divination !== null, '第 8 天是占卜日 ⇒ 必须有氛围');
        t.ok(r.divination!.ambience.trim() !== '', '氛围不许是空串');
        t.eq(r.ledger.divination!.ambition, r.divination!.ambience, '返回值与账本里的必须是同一句');
        t.ok(r.log.join('\n').includes('章占卜') || r.log.join('\n').includes('占卜'), '日志里要看得到这一次占卜');
      });

      t.test('★ 非占卜日：不占卜，且**不许把上一章的氛势抹掉**', async () => {
        const d8 = await enterDay(atDay(8, {}), makeRng(7), fakeBrain(), 7);
        const l9 = structuredClone(d8.ledger);
        l9.clock.day = 9;
        l9.clock.chapter = chapterOf(9);
        l9.clock.usedToday = 0;
        const d9 = await enterDay(l9, makeRng(8), fakeBrain(), 8);
        t.eq(d9.divination, null, '第 9 天不是占卜日');
        t.eq(
          d9.ledger.divination!.ambition,
          d8.ledger.divination!.ambition,
          '非占卜日把上周氛围弄丢了 ⇒ 这一章的事件生成会失去灵感来源',
        );
      });

      t.test('★★ 第 1 天：氛围落账，但欲念**一个数都不动**', async () => {
        const l1 = atDay(1, { desire: 30 });
        const r = await enterDay(l1, makeRng(3), fakeBrain(), 3);
        t.ok(r.divination !== null, '第 1 天照样有氛围 —— 第 1 章的氛围只能靠它');
        t.eq(r.ledger.desire.value, 30, '第 1 天不落欲念（哪怕模型填了个大数、哪怕真命中）');
      });

      t.test('★ 种子真的接上了：同种子同天同副牌，换种子换副牌', async () => {
        const amb = async (seed: number): Promise<string> => {
          const r = await enterDay(atDay(8, {}), makeRng(seed), fakeBrain(), seed);
          return r.ledger.divination!.ambition;
        };
        const a1 = await amb(7);
        const a2 = await amb(7);
        t.eq(a1, a2, '同种子两次必须一模一样（否则"同一局跑两遍一样"作废）');

        const many = new Set<string>();
        for (const s of [1, 7, 42, 99, 123, 2026, 555, 8080]) many.add(await amb(s));
        t.ok(many.size > 1, '8 个种子抽出一模一样的占卜结果 ⇒ 种子没接上（`enterDay` 的 seed 大概没传）');
      });

      t.test('★ T0 内部次序：过期结算 → 章节占卜 → 概要归并 → 生成', () => {
        // 结构断言：这些段都是"日初、生成之前"的动作，谁先谁后**只由源码次序决定**，
        // 所以这里**读源码**把次序钉住（改了次序这条立刻红）。
        // ⚠️ 2026-10-05：原断言是三段（重写命题 → 章节占卜 → 生成）。`rewrite_desire` 整条删掉后
        //    剩两段，占卜**前面**那个"排在重写命题之后"的约束**随它一起没了** ——
        //    命题在 `opening` 之后终身不变，占卜读到的永远是那一版。
        const src = readFileSync(new URL('../turn/t0.ts', import.meta.url), 'utf8');
        const expireAt = src.indexOf('settleExpired(l, nowOf(l), brain)');
        const divinationAt = src.indexOf('brain.chapterShift(l, cards)');
        const archiveAt = src.indexOf('brain.archive(l, plan)');
        const composeAt = src.indexOf('brain.composeDay(l, rng)');
        t.ok(expireAt > 0 && divinationAt > 0 && archiveAt > 0 && composeAt > 0, '四段都该在 t0.ts 里');
        t.ok(expireAt < divinationAt, '过期结算排在占卜之前');
        t.ok(divinationAt < archiveAt, '章节占卜排在概要归并之前');
        t.ok(
          divinationAt < composeAt,
          '章节占卜排在了生成之后 ⇒ 本周氛围赶不上当天的事件生成',
        );
        // ⚠️ 反向钉死：那条侧链不许悄悄回来（命题一生只写一次）。
        t.ok(!src.includes('rewriteDesire'), '`turn/t0.ts` 里不该再有 rewriteDesire 调用');
      });
    },
  },
];
