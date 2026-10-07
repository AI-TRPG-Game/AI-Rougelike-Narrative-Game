// `opening` 全链测试 —— **2026-10-06 整段重写**（用户裁定：序幕彻底不问模型）
//
// ⚠️ **这一条 suite 的形状又变了一次**（第三次）：
//   2026-09 版：欲望 ＋ 六维 ＋ 人物描述**全是模型生成** ⇒ 测"模型的东西有没有被守住"；
//   2026-10-05 版：欲望 ＋ 六维改成**玩家自己挑** ⇒ 只剩 `人物描述` 一项问模型；
//   **本版**：玩家那句固定描述**硬编码在 `ledger/initial.ts·PLAYER_DESC`**（即 `Person.desc`）
//   ⇒ **模型一件产出都没有了** ⇒ 整条 LLM 侧链删除（`applyOpening` / `Brain.opening` /
//   `buildOpeningRequest` / `assembleOpening` / `renderOpeningUser` / `schema/opening.ts`）。
//
// ⇒ 本 suite 现在只测**规则层**：① 玩家两项选择直接变成账本上的欲望与六维；
//   ② **六维总和恒 60**（用户裁定"不多不少"）；③ 玩家那句固定描述**在 `Person.desc` 上**。
// ⇒ **"零 LLM"这件事本身要被钉住**（`brain.opening` 必须不存在）——
//   否则"删了调用"和"只是改了名字"这两件事在测试里长得一模一样。
import { initialLedger } from '../ledger/initial.ts';
import { PLAYER_ID } from '../ledger/types.ts';
import { renderStaticHead } from '../frozen/static-head.ts';
// ⚠️ 2026-10-05：牌已从这一侧链彻底撤出（用户裁定：欲望与塔罗无关）⇒ 这里**不再 import 任何牌**。
import {
  ATTR_ADV_MAX,
  ATTR_BASE,
  ATTR_DUO,
  ATTR_SOLO,
  ATTR_TOTAL,
  DESIRE_KITS,
  distributeAttrs,
  kitOf,
  sumOfAttrs,
} from '../rules/desire-kits.ts';
import { desireBlock, endingDesireBlock, playerDesireBlock } from '../prompt/blocks.ts';
import { applyPlayerChoice, DEFAULT_CHOICE, OpeningRejected, type OpeningChoice } from '../turn/opening.ts';
import { PLAYER_DESC } from '../ledger/initial.ts';
import { fakeBrain } from '../fixtures/fake.ts';
import type { Suite } from './harness.ts';

/** 命中的两条（都是那 5 条原型里真实存在的一对） */
/** 玩家挑「侠」＋ 点亮争斗（= `DEFAULT_CHOICE`，与无头驱动同一条） */
const CHOICE: OpeningChoice = { kit: 2, advantages: ['争斗'] };

/** 便捷入口：玩家选完欲望 ＋ 优势 ⇒ 落账（**这一步就是全部**，没有第二步） */
function full(choice: OpeningChoice = CHOICE) {
  const step1 = applyPlayerChoice(initialLedger(), choice);
  return { step1, step2: { ledger: step1.ledger, log: [] as string[] } };
}

/** 两串的共同前缀长度 */
function commonPrefix(x: string, y: string): number {
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

export const suites: Suite[] = [
  {
    name: '欲望原型表（玩家挑的那 5 条 · 唯一事实源）',
    register(t) {
      t.test('★ 恰好 5 条（用户裁定：开局从这 5 条里选其一）', () => {
        t.eq(DESIRE_KITS.length, 4, '用户 2026-10-06 裁定的 4 条');
      });

      t.test('★ 每条**两句都在、且都非空** —— 宣言 ＋ 命题缺一句就有一个读者没内容', () => {
        for (const k of DESIRE_KITS) {
          t.ok(k.manifesto.trim().length > 0, `【${k.label}】的宣言是空的`);
          t.ok(k.proposition.trim().length > 0, `【${k.label}】的命题是空的`);
          t.ok(k.label.trim().length > 0, `【${k.label}】的短标签是空的`);
        }
      });

      t.test('★ 宣言逐字 = 用户写下的那五条（它们是玩家自己说的话，不是模型文案）', () => {
        t.deep(
          DESIRE_KITS.map((k) => k.manifesto),
          [
            '全金庭的男男女女啊，沉醉地拜倒在我的石榴裙下吧！',
            '兄弟，请替我圆了这大侠梦！',
            '经济基础决定上层建筑，消灭一切阻碍生产力发展的旧事物！',
            '人生的意义是什么？被社会所建构的价值是否值得追寻？世界的本质与真理又为何？',
          ],
        );
      });

      t.test('★ 宣言**互不重复**（重名会让"他选了哪条"分不清）', () => {
        t.eq(new Set(DESIRE_KITS.map((k) => k.manifesto)).size, DESIRE_KITS.length);
      });

      t.test('★ 命题 ≤30 字（它进每一次判「更近了没有」的判定，必须短）', () => {
        for (const k of DESIRE_KITS) {
          t.ok([...k.proposition].length <= 30, `【${k.label}】命题 ${[...k.proposition].length} 字 > 30：「${k.proposition}」`);
        }
      });

      t.test('★★ 每条**手段 / 目的 都在、且不是同一句**（2026-10-06：它们各判一个维度）', () => {
        for (const k of DESIRE_KITS) {
          t.ok(k.means.trim().length > 0, `【${k.label}】缺手段 —— 「正当的手段」就没判据了`);
          t.ok(k.proposition.trim().length > 0, `【${k.label}】缺目的 —— 「欲向」就没判据了`);
          t.ok(k.means !== k.proposition, `【${k.label}】手段与目的一字不差 ⇒ 两个维度糊成一个`);
        }
      });

      t.test('★ 原型的字段就是**四个**（加一个就是又挂了别的东西）', () => {
        for (const k of DESIRE_KITS) {
          t.deep(
            Object.keys(k).sort(),
            ['label', 'manifesto', 'means', 'proposition'],
            `★ 【${k.label}】字段清单变了`,
          );
        }
      });

      t.test('★ 命题与宣言**不是同一句话**（两个读者；同句就只剩一个了）', () => {
        for (const k of DESIRE_KITS) {
          t.ok(
            k.manifesto !== k.proposition,
            `【${k.label}】两句一字不差 ⇒ 双文本没成立`,
          );
        }
      });

      // ⚠️ 这里原来有一条「每条原型的牌名都在 22 张之内」—— **原型已经没有牌了**
      //    （2026-10-05 用户裁定：欲望与塔罗无关）⇒ 那条测试的前提消失，整条删除。
      //    它换成下面这条**反向断言**：牌不许再挂回原型上（这比测"牌名拼对了"更该守）。
      t.test('★★ 原型里**一张牌都没有**（牌不许再挂回欲望上）', () => {
        for (const k of DESIRE_KITS) {
          t.eq('cards' in k, false, `★ 【${k.label}】又长出 cards 字段了`);
        }
      });

      t.test('kitOf 越界即 null（**不抛**：调用侧要的是"重挑一个"）', () => {
        t.eq(kitOf(0)?.label, DESIRE_KITS[0].label);
        t.eq(kitOf(3)?.label, DESIRE_KITS[3].label);
        t.eq(kitOf(4), null, '第 5 条已删 ⇒ 下标 4 越界');
        t.eq(kitOf(-1), null);
        t.eq(kitOf(1.5), null);
        t.eq(kitOf(Number.NaN), null);
      });
    },
  },

  {
    name: '六维分配（**总和恒 60** · 玩家点亮 0~2 个优势）',
    register(t) {
      t.test('★ 点亮 0 个 ⇒ 六个 10（总和 60）', () => {
        const a = distributeAttrs([]);
        t.deep(a, { 争斗: 10, 敏捷: 10, 智慧: 10, 魅力: 10, 社交: 10, 感知: 10 });
        t.eq(sumOfAttrs(a), ATTR_TOTAL);
      });

      t.test('★ 点亮 1 个 ⇒ 15 ＋ 五个 9（15 + 45 = 60）', () => {
        const a = distributeAttrs(['智慧']);
        t.eq(a.智慧, ATTR_SOLO);
        t.eq(a.魅力, 9, '没点亮的必须降到 9 —— 专精的代价就是平庸');
        t.eq(sumOfAttrs(a), ATTR_TOTAL);
      });

      t.test('★ 点亮 2 个 ⇒ 两个 12 ＋ 四个 9（24 + 36 = 60）', () => {
        const a = distributeAttrs(['魅力', '社交']);
        t.eq(a.魅力, ATTR_DUO);
        t.eq(a.社交, ATTR_DUO);
        t.eq(a.智慧, 9);
        t.eq(sumOfAttrs(a), ATTR_TOTAL);
      });

      t.test('★ **总和恒 = 60**，三种分配都验一遍（用户裁定"不多不少"）', () => {
        for (const adv of [[], ['争斗'], ['敏捷'], ['智慧'], ['魅力'], ['社交'], ['感知'], ['争斗', '敏捷'], ['智慧', '魅力'], ['社交', '感知']]) {
          t.eq(sumOfAttrs(distributeAttrs(adv)), ATTR_TOTAL, `点亮 ${adv.length} 个：${adv.join('、')}`);
        }
        t.eq(ATTR_TOTAL, 60, '★ 硬数字 60（用户原话）');
      });

      t.test('重复点亮同一项按**一次**算（不该靠重复刷高）', () => {
        const a = distributeAttrs(['魅力', '魅力', '魅力']);
        t.eq(a.魅力, ATTR_SOLO, '去重后只剩 1 个 ⇒ 走 15 那一档，不走 12');
        t.eq(sumOfAttrs(a), ATTR_TOTAL, '总和仍是 60');
      });

      t.test('不在六维里的键**被忽略**（纯算术层不抛；校验在 `applyPlayerChoice`）', () => {
        const a = distributeAttrs(['魅力', ' charisma' as never]);
        t.eq(a.魅力, ATTR_SOLO, '只认得的那个照常分配');
        t.eq(sumOfAttrs(a), ATTR_TOTAL);
      });

      t.test(`亮点上限常量 = ${ATTR_ADV_MAX}（用户裁定 0~2）`, () => {
        t.eq(ATTR_ADV_MAX, 2);
        t.eq(ATTR_BASE, 10);
      });
    },
  },

  {
    name: '第一步 · `applyPlayerChoice`（**规则层 · 零 LLM**）',
    register(t) {
      t.test('★ 玩家的选择**不经过模型**就落成了账本上的欲望 ＋ 宣言 ＋ 六维', () => {
        const r = applyPlayerChoice(initialLedger(), { kit: 1, advantages: ['魅力'] });
        t.eq(r.ledger.desire.kit, 1);
        t.eq(r.ledger.desire.manifesto, DESIRE_KITS[1].manifesto);
        t.eq(r.ledger.desire.proposition, DESIRE_KITS[1].proposition);
        t.deep(r.ledger.desire.advantages, ['魅力']);
        t.eq(r.ledger.entities.people.find((p) => p.id === PLAYER_ID)!.attrs.魅力, ATTR_SOLO);
        t.eq(sumOfAttrs(r.ledger.entities.people.find((p) => p.id === PLAYER_ID)!.attrs), ATTR_TOTAL);
      });

      t.test('★ 单写者 = "返回新账本"，**不是就地改旧的**', () => {
        const l = initialLedger();
        const before = JSON.stringify(l.desire);
        applyPlayerChoice(l, CHOICE);
        t.eq(JSON.stringify(l.desire), before, '入参账本被改坏了 ⇒ 落账不是原子的');
      });

      t.test('欲望下标越界 ⇒ 抛（`OpeningRejected`，给调用侧分辨"该不该重试"）', () => {
        t.throws(() => applyPlayerChoice(initialLedger(), { kit: 9, advantages: [] }), '欲望原型下标');
        t.throws(() => applyPlayerChoice(initialLedger(), { kit: -1, advantages: [] }), '欲望原型下标');
      });

      t.test(`★ 点亮超过 ${ATTR_ADV_MAX} 个 ⇒ 抛；亮点不合法的名字 ⇒ 抛`, () => {
        t.throws(
          () => applyPlayerChoice(initialLedger(), { kit: 0, advantages: ['争斗', '敏捷', '智慧'] }),
          '最多 2 个',
        );
        t.throws(() => applyPlayerChoice(initialLedger(), { kit: 0, advantages: ['魅力值'] }), '不在六维里');
        t.throws(() => applyPlayerChoice(initialLedger(), { kit: 0, advantages: [7 as never] }), '不在六维里');
      });

      t.test('账本里没有玩家 ⇒ 抛（结构性错误）', () => {
        const l = initialLedger();
        l.entities.people = l.entities.people.filter((p) => p.id !== PLAYER_ID);
        t.throws(() => applyPlayerChoice(l, CHOICE), '账本里没有玩家');
      });

      t.test('日志写清了"选了什么 ＋ 判据是什么 ＋ 六维怎么分"（排错不用回头翻账本）', () => {
        const r = applyPlayerChoice(initialLedger(), { kit: 3, advantages: ['智慧', '感知'] });
        const text = r.log.join('\n');
        for (const needle of ['哲', '人生的意义', '目的', '手段', '总和 60', '智慧', '感知']) {
          t.ok(text.includes(needle), `日志里少了「${needle}」`);
        }
      });
    },
  },

  {
    name: '无头驱动的默认选择（`DEFAULT_CHOICE`）',
    register(t) {
      t.test('★ 是一条**确定值**、且合法（不能从 rng 抽 —— 否则"换 seed"会连欲望一起换）', () => {
        t.ok(kitOf(DEFAULT_CHOICE.kit) !== null, '默认选择指向了不存在的原型');
        t.ok(
          DEFAULT_CHOICE.advantages.length <= ATTR_ADV_MAX,
          `默认选择点了 ${DEFAULT_CHOICE.advantages.length} 个优势，超过上限`,
        );
      });

      t.test('默认选择照样跑得出合法六维（总和 60）', () => {
        const r = applyPlayerChoice(initialLedger(), DEFAULT_CHOICE);
        t.eq(sumOfAttrs(r.ledger.entities.people.find((p) => p.id === PLAYER_ID)!.attrs), ATTR_TOTAL);
      });

      t.test('两遍调用返回**同一条**（可重放性）', () => {
        t.deep(DEFAULT_CHOICE, { ...DEFAULT_CHOICE });
        t.deep(applyPlayerChoice(initialLedger(), DEFAULT_CHOICE).ledger.desire, applyPlayerChoice(initialLedger(), DEFAULT_CHOICE).ledger.desire);
      });
    },
  },
];
