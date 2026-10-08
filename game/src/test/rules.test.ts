// 规则层：难度骰 · 投骰档位 · A/主事者 · x · 欲向 · 时钟
import type { Attrs } from '../contract/types.ts';
import { initialLedger, makePerson } from '../ledger/initial.ts';
import { PLAYER_ID, type GameEvent } from '../ledger/types.ts';
import { calcA, effectiveAttrs, pickLeader } from '../rules/ability.ts';
import { outcomeForNonRoll, resolveRoll, tierFrom } from '../rules/check.ts';
import { normalizeCheck } from '../llm/brain-llm.ts';
import {
  addPoints,
  chapterOf,
  compareTime,
  dialRange,
  pendingCosts,
  expiresAt,
  isChapterStart,
  isExpired,
  payrollForDay,
  phaseOf,
  remainingToday,
  toAbs,
} from '../rules/clock.ts';
import {
  applyDesire,
  dangerZoneOf,
  DESIRE_BAND_NOTE,
  DESIRE_BANDS,
  desireBandOf,
  driftOf,
  isPopupTierLegal,
  TIER_VALUE,
  WINDOW_MAX,
  WINDOW_MIN,
} from '../rules/desire.ts';
import { composeDice, difficultyDice, peopleDice, zoneDice } from '../rules/dice.ts';
import { evalGates, GATE_LANE, gateSnapshotOf, gatesOf } from '../rules/gates.ts';
import { makeRng, scriptedRng } from '../rules/rng.ts';
import { calcX, subordinatePoints } from '../rules/x.ts';
import { DEADLINE_STEPS, fakeComposeDay, makeEvent } from '../fixtures/fake.ts';
import { landCompose } from '../turn/land-compose.ts';
import { turnOver } from '../turn/t0.ts';
import type { Suite } from './harness.ts';

const A10: Attrs = { 争斗: 10, 敏捷: 10, 智慧: 10, 魅力: 10, 社交: 10, 感知: 10 };

export const suites: Suite[] = [
  {
    name: '难度骰 · 《规则.md》§一（三源合计钳在 ±2d4）',
    register(t) {
      t.test('来源一：事件难度 → 有符号 d4 个数', () => {
        t.eq(difficultyDice('无修正'), 0);
        t.eq(difficultyDice('惩罚1'), 1);
        t.eq(difficultyDice('惩罚2'), 2);
        t.eq(difficultyDice('奖励1'), -1);
        t.eq(difficultyDice('奖励2'), -2);
      });

      t.test('来源二：人数修正（正达门槛无、多 1 人 −1d4、多 ≥2 人 −2d4）', () => {
        t.eq(peopleDice(1, 1, 3), 0, '正好最低');
        t.eq(peopleDice(2, 1, 3), -1, '多 1 人');
        t.eq(peopleDice(3, 1, 3), -2, '多 2 人');
        t.eq(peopleDice(5, 1, 3), 0, '越上限由闸门拦，这里不叠加');
      });

      t.test('来源三：危险区恒定（迷失 +1d4 / 沉溺 −1d4）', () => {
        t.eq(zoneDice('正常'), 0);
        t.eq(zoneDice('迷失'), 1);
        t.eq(zoneDice('沉溺'), -1);
      });

      t.test('★ 判据：三源合计一律钳在 ±2d4（来源三自己也吃封顶）', () => {
        t.eq(composeDice(2, -2, 1), 1);
        t.eq(composeDice(2, 2, -1), 2, '+3 应被钳到 +2');
        t.eq(composeDice(-2, -2, 1), -2, '−3 应被钳到 −2');
      });
    },
  },
  {
    name: '投骰档位 · 《规则.md》§一（五档 + 5 条边界规则）',
    register(t) {
      t.test('五档阈值表（A=10 ⇒ 大成功 ≤2 / 困难 ≤5 / 成功 ≤10 / 失败 >10）', () => {
        t.eq(tierFrom(2, 10), '大成功');
        t.eq(tierFrom(5, 10), '困难成功');
        t.eq(tierFrom(6, 10), '成功');
        t.eq(tierFrom(10, 10), '成功');
        t.eq(tierFrom(11, 10), '失败');
      });

      t.test('★ 边界 2：天然 20 ⇒ 恒定大失败，且**不被 A 影响**', () => {
        const rng = scriptedRng([20]);
        const r = resolveRoll(
          { a: 20, overflow: 0, leaderId: PLAYER_ID, eventDifficulty: '奖励2', participants: 1, minPeople: 1, maxPeople: 3, zone: '沉溺' },
          rng,
        );
        t.eq(r.tier, '大失败');
        t.eq(r.endpoint, '大失败');
        t.eq(rng.log.length, 1, '★ 端点不掷难度骰 —— 一个 −d4 会把自然 20 救成 16');
      });

      t.test('★ 边界 2：天然 1 ⇒ 恒定大成功', () => {
        const rng = scriptedRng([1]);
        const r = resolveRoll(
          { a: 1, overflow: 0, leaderId: PLAYER_ID, eventDifficulty: '惩罚2', participants: 3, minPeople: 1, maxPeople: 3, zone: '迷失' },
          rng,
        );
        t.eq(r.tier, '大成功');
        t.eq(r.endpoint, '大成功');
        t.eq(rng.log.length, 1);
      });

      t.test('★ 边界 5：不存在「绝对成功」—— A 封顶 20 仍保留 5% 大失败', () => {
        let fumble = 0;
        for (let raw = 1; raw <= 20; raw++) {
          const r = resolveRoll(
            { a: 20, overflow: 5, leaderId: PLAYER_ID, eventDifficulty: '无修正', participants: 1, minPeople: 1, maxPeople: 1, zone: '正常' },
            scriptedRng(raw === 20 ? [20] : [raw, 1]),
          );
          if (r.tier === '大失败') fumble++;
        }
        t.eq(fumble, 1, '20 面里恰好 1 面恒定大失败');
      });

      t.test('边界 4：难度骰只动 R，加值只动 A —— R = d20 ± 难度骰', () => {
        const r = resolveRoll(
          { a: 10, overflow: 0, leaderId: PLAYER_ID, eventDifficulty: '惩罚1', participants: 1, minPeople: 1, maxPeople: 3, zone: '正常' },
          scriptedRng([8, 3]),
        );
        t.eq(r.raw, 8);
        t.eq(r.modifierTotal, 3);
        t.eq(r.adjusted, 11);
        t.eq(r.tier, '失败', '11 > A=10');
      });

      t.test('边界 3：有利减 —— 奖励使 R 变小', () => {
        const r = resolveRoll(
          { a: 10, overflow: 0, leaderId: PLAYER_ID, eventDifficulty: '奖励1', participants: 1, minPeople: 1, maxPeople: 3, zone: '正常' },
          scriptedRng([12, 4]),
        );
        t.eq(r.modifierTotal, -4);
        t.eq(r.adjusted, 8);
        t.eq(r.tier, '成功');
      });

      t.test('边界 1：A=1 且无修正 ⇒ 除天然 1 外必失败', () => {
        const r = resolveRoll(
          { a: 1, overflow: 0, leaderId: PLAYER_ID, eventDifficulty: '无修正', participants: 1, minPeople: 1, maxPeople: 3, zone: '正常' },
          scriptedRng([2]),
        );
        t.eq(r.tier, '失败');
      });

      t.test('★ 「拒绝」已随整条机制摘除（2026-10-07）：走法只剩三种，字面量不再是合法 verdict', () => {
        t.ok(!(['本次不裁定', '无需判定', '直接成功', '直接失败', '投骰'] as const).includes('拒绝' as never));
        // 防御性兜底仍在：畸形 verdict 一律兜到「投骰」—— 结果仍由规则层掷出
        t.eq(normalizeCheck({ verdict: '拒绝' }).verdict, '投骰');
      });

      t.test('无需掷骰的裁定：直接成功 / 直接失败 用 direct_result', () => {
        t.eq(outcomeForNonRoll({ verdict: '直接成功', participants: [], difficulty: '无修正', direct_result: '大成功' }).tier, '大成功');
        t.eq(outcomeForNonRoll({ verdict: '直接失败', participants: [], difficulty: '无修正', direct_result: '大失败' }).tier, '大失败');
      });

      t.test('⚠️ 契约空缺的默认：无需判定 且 direct_result=无 ⇒ 取「成功」', () => {
        t.eq(outcomeForNonRoll({ verdict: '无需判定', participants: [], difficulty: '无修正', direct_result: '无' }).tier, '成功');
      });
    },
  },
  {
    name: 'A / 有效属性 / 主事者 · 《规则.md》§一',
    register(t) {
      t.test('有效属性 = 基础 + Σ 物品加成', () => {
        const e = effectiveAttrs(A10, [{ attr: '争斗', bonus: 2 }, { attr: '争斗', bonus: 3 }, { attr: '智慧', bonus: 1 }]);
        t.eq(e.争斗, 15);
        t.eq(e.智慧, 11);
      });

      t.test('A = 均值向下取整', () => {
        t.eq(calcA({ ...A10, 争斗: 9, 智慧: 10 }, ['争斗', '智慧']).a, 9);
      });

      t.test('★ 边界 1：A 钳在 [1,20] 并记录溢出', () => {
        const hi = calcA({ ...A10, 争斗: 30, 智慧: 30 }, ['争斗', '智慧']);
        t.eq(hi.a, 20);
        t.eq(hi.overflow, 10, '溢出量可当平衡仪表');
        const lo = calcA({ ...A10, 争斗: 0, 智慧: 0 }, ['争斗', '智慧']);
        t.eq(lo.a, 1);
      });

      t.test('参与属性最多 3 个', () => {
        t.throws(() => calcA(A10, ['争斗', '敏捷', '智慧', '魅力']), '最多 3 个');
      });

      // ⚠️ 下面两条**显式构造**出场人物，不吃预置阵容的数值。
      //    2026-09-20 预置阵容落成《设定.md》的真实数据后，「npc001 争斗 15 / npc002 争斗 4」
      //    当场就与设定不符（真实是 12 / 6）—— 凡「拿预置人物当数值夹具」的写法都会这么过期。
      t.test('主事者 = 参与属性上取值最高者（含物品加成）', () => {
        const l = initialLedger();
        const brawler = makePerson({ id: 'npc901', name: '力大的', attrs: { ...A10, 争斗: 15, 智慧: 4 } });
        const scholar = makePerson({ id: 'npc902', name: '会算的', attrs: { ...A10, 争斗: 6, 智慧: 17 } });
        l.entities.people.push(brawler, scholar);
        t.eq(pickLeader(l, [brawler, scholar], ['争斗'])!.id, 'npc901');
        t.eq(pickLeader(l, [brawler, scholar], ['智慧'])!.id, 'npc902', '换个属性面 ⇒ 换主事者');
      });

      t.test('平手时取 id 最小者（保证可复现）', () => {
        const l = initialLedger();
        const first = makePerson({ id: 'npc901', name: '先来的', attrs: { ...A10, 争斗: 15 } });
        const later = makePerson({ id: 'npc902', name: '后来的', attrs: { ...A10, 争斗: 15 } });
        l.entities.people.push(first, later);
        t.eq(pickLeader(l, [later, first], ['争斗'])!.id, 'npc901', '两者争斗同为 15 ⇒ 取 id 小者');
      });
    },
  },
  {
    name: 'x 与 L · 《规则.md》§一「总量与时钟」',
    register(t) {
      // ⚠️ 2026-09-22（**世界数据变了**）：`ledger/initial.ts` 现在只有**皮普**在册
      //    （用户裁定「当然只有皮普可以派遣」）。本套件拿 `npc001` 当「一个可用下属」的
      //    样本 ⇒ 由夹具把世界摆成「预置 10 人都在册」—— 那正是本套件一直在描述的那个
      //    算术（`x` 的公式才是被测对象）。真实开局的 `x = 4 ＋ 4 = 8`，另记一笔账。
      const fresh = () => {
        const l = initialLedger();
        for (const p of l.entities.people) p.affiliated = true;
        return l;
      };
      t.test('可用者每人 4 点；玩家不在下属预算里', () => {
        const l = fresh();
        const p1 = l.entities.people.find((p) => p.id === 'npc001')!;
        t.eq(subordinatePoints(l, p1, 1), 4);
        t.eq(subordinatePoints(l, l.entities.people[0], 1), 0, '玩家不是下属');
      });

      t.test('HP ≤ 1 或 SAN ≤ 1 ⇒ 0 点', () => {
        const l = fresh();
        const p1 = l.entities.people.find((p) => p.id === 'npc001')!;
        p1.hp = 1;
        t.eq(subordinatePoints(l, p1, 1), 0);
      });

      t.test('★ 在途 0 点 · 归队日只回升 d 点', () => {
        const l = fresh();
        const p1 = l.entities.people.find((p) => p.id === 'npc001')!;
        const ev: GameEvent = makeEvent({
          title: '远行',
          tier: 'B',
          cost: 8, // 跨天（> 单日预算 4）
          status: '揭晓待办',
          handler: 'npc001',
          started_at: { day: 1, used: 0 },
          reveal_at: { day: 4, used: 0 },
          depart_cost: 2,
          created_day: 1,
        });
        l.events.live.push(ev);
        t.eq(subordinatePoints(l, p1, 2), 0, '在途');
        t.eq(subordinatePoints(l, p1, 3), 0, '在途');
        t.eq(subordinatePoints(l, p1, 4), 2, '归队日只回升 d=2');
        t.eq(subordinatePoints(l, p1, 5), 4, '归队后恢复满额');
      });

      t.test('x = 4（玩家）+ Σ 下属可用点数', () => {
        const l = fresh();
        // 玩家 4 ＋ 预置 10 人各 4（玩家 `npc000` **不在** `byNpc` 里，他的预算是 `clock.usedToday`）
        t.eq(calcX(l, 1).x, 44, '玩家 4 + 10 名下属各 4');
      });
    },
  },
  {
    name: '欲向五档 · 《规则.md》§三（数值由规则层查表）',
    register(t) {
      t.test('五档表值：0 / −3 / +2 / +4 / +8', () => {
        t.eq(TIER_VALUE.无关, 0);
        t.eq(TIER_VALUE.偏离, -3);
        t.eq(TIER_VALUE.趋近, 2);
        t.eq(TIER_VALUE.得偿, 4);
        t.eq(TIER_VALUE.盛宴, 8);
      });

      t.test('系统只做一道算术：clamp(欲念 + 表值, 0, 100)', () => {
        t.eq(applyDesire(5, '偏离'), 2);
        t.eq(applyDesire(5, '偏离'), 2);
        t.eq(applyDesire(2, '偏离'), 0, '下界钳');
        t.eq(applyDesire(58, '盛宴'), 66);
        t.eq(applyDesire(97, '盛宴'), 100, '上界钳');
      });

      t.test('档 A 的欲向不含「得偿 / 盛宴」', () => {
        t.ok(isPopupTierLegal('无关') && isPopupTierLegal('偏离') && isPopupTierLegal('趋近'));
        t.ok(!isPopupTierLegal('得偿'));
        t.ok(!isPopupTierLegal('盛宴'));
      });

      // ⚠️ 2026-10-05：这里原来有一条「首次跨过 60 ⇒ 次日 T0 触发 rewrite_desire」
      //    （断言 `crossedRewriteThreshold`）。它随 `rewrite_desire` 侧链与 `REWRITE_THRESHOLD`
      //    一起删掉了 —— 现在**欲念上不存在任何"到某个数就发生什么"的档位**，
      //    只剩终局那个窗口（75~80，而它不是触发器：第 28 天无条件判"此刻落在窗口里没有"）。
      //    ⇒ 那条断言现在**没有对象可测**，不是"漏测"。
    },
  },
  {
    name: '危险区 · 推导与每日漂移 · 《设定.md》§二（涨跌三源 ②）',
    register(t) {
      t.test('dangerZoneOf：1~24 迷失 · 25~80 常态（含窗口）· 81~99 沉溺', () => {
        t.eq(dangerZoneOf(1), '迷失');
        t.eq(dangerZoneOf(24), '迷失', '24 是迷失区上界');
        t.eq(dangerZoneOf(25), '正常', '25 起是常态');
        t.eq(dangerZoneOf(74), '正常');
        t.eq(dangerZoneOf(75), '正常', '75 是窗口，仍无税');
        t.eq(dangerZoneOf(80), '正常', '80 仍是窗口');
        t.eq(dangerZoneOf(81), '沉溺', '81 起是沉溺');
        t.eq(dangerZoneOf(99), '沉溺');
      });

      t.test('★ 0 / 100 是立即终结值，zone 只作兜底 —— 归到极值侧，**不写「正常」**', () => {
        t.eq(dangerZoneOf(0), '迷失');
        t.eq(dangerZoneOf(100), '沉溺');
      });

      t.test('每日漂移表：迷失 −2 / 沉溺 +2 / 常态与窗口 0', () => {
        t.eq(driftOf('迷失'), -2);
        t.eq(driftOf('沉溺'), 2);
        t.eq(driftOf('正常'), 0);
      });

      t.test('★ 落账点 = turnOver（跨日瞬间）：与周例钱同批，判据取昨夜欲念', () => {
        const l = initialLedger();
        l.desire.value = 24; // 迷失区
        turnOver(l);
        t.eq(l.desire.value, 22, '迷失区每天 −2');

        const m = initialLedger();
        m.desire.value = 81; // 沉溺区
        turnOver(m);
        t.eq(m.desire.value, 83, '沉溺区每天 +2');
      });

      t.test('★ 常态 / 窗口区**无税** —— 什么都不做就停在原地（「什么都没发生」的手感全靠它）', () => {
        for (const v of [25, 40, 60, 74, 75, 80]) {
          const l = initialLedger();
          l.desire.value = v;
          turnOver(l);
          t.eq(l.desire.value, v, `欲念 ${v}（正常/窗口）翻日不变`);
        }
      });

      t.test('★ clamp：漂移把欲念推到 0 / 100 即封顶（下一手由 terminateIfOver 收走）', () => {
        const lo = initialLedger();
        lo.desire.value = 1; // 迷失
        turnOver(lo);
        t.eq(lo.desire.value, 0, '−2 被下界钳到 0');

        const hi = initialLedger();
        hi.desire.value = 99; // 沉溺
        turnOver(hi);
        t.eq(hi.desire.value, 100, '+2 被上界钳到 100');
      });

      t.test('★ 不设缓冲日（2026-09-21 用户裁定）：跨入危险区**当天**就漂（与《设定.md》§二不一致，以代码为准）', () => {
        const l = initialLedger();
        l.desire.value = 23;
        turnOver(l);
        t.eq(l.desire.value, 21, '第一夜就收税，没有「隔一天」');
      });
    },
  },
  {
    name: 'P5-B · 欲念区间（玩家看得到的那一层）· 《设定.md》§二区间列',
    register(t) {
      /**
       * ⚠️ 这一段守的是**两个读者、两份口径**：
       *    · `dangerZoneOf`（3 值）= 规则层自己用 —— 常态与窗口在它眼里都是「正常」（都不收税、都不修正）；
       *    · `desireBandOf`（4 值）= **给玩家的**那一个。
       *    ⇒ 断点必须逐字照《设定.md》的区间列，**且两者不许合并**（下面有一对断言专门钉它）。
       */
      t.test('desireBandOf：四段断点逐字照《设定.md》区间列（1~24 / 25~74 / 75~80 / 81~99）', () => {
        t.deep([...DESIRE_BANDS], ['迷失', '常态', '窗口', '沉溺'], '区间名与顺序照表');
        t.eq(WINDOW_MIN, 75, '窗口下界');
        t.eq(WINDOW_MAX, 80, '窗口上界');
        t.eq(desireBandOf(1), '迷失');
        t.eq(desireBandOf(24), '迷失', '24 是迷失段上界');
        t.eq(desireBandOf(25), '常态', '25 起常态');
        t.eq(desireBandOf(74), '常态', '74 是常态段上界');
        t.eq(desireBandOf(75), '窗口', '75 起是窗口 —— 全表唯一的好结局区间');
        t.eq(desireBandOf(80), '窗口', '80 是窗口段上界');
        t.eq(desireBandOf(81), '沉溺', '81 起沉溺');
        t.eq(desireBandOf(99), '沉溺');
      });

      t.test('★ 0 / 100（立即终结值）归到极值侧 —— 与 dangerZoneOf 的兜底口径一致，都**不写「常态」**', () => {
        t.eq(desireBandOf(0), '迷失');
        t.eq(desireBandOf(100), '沉溺');
        t.eq(dangerZoneOf(0), '迷失', '两个函数在 0 上必须同侧');
        t.eq(dangerZoneOf(100), '沉溺', '在 100 上必须同侧');
      });

      t.test('★★ 区间（4 值）与危险区（3 值）**不是同一个东西** —— 75~80 这一段正是它们分岔的地方', () => {
        for (const v of [75, 76, 80]) {
          t.eq(dangerZoneOf(v), '正常', `危险区在 ${v} 只有「正常」（规则层对窗口与常态一视同仁）`);
          t.eq(desireBandOf(v), '窗口', `区间在 ${v} 必须是「窗口」—— 玩家看得到的那一层不能丢这一段`);
        }
        // 反向：两者在迷失 / 沉溺两段上又必须一致（否则漂移与提示会对不上）
        for (const v of [10, 24, 81, 90]) {
          t.eq(desireBandOf(v), dangerZoneOf(v), `危险区与区间在 ${v} 上应当同名`);
        }
      });

      t.test('区间读数的四条 —— **逐格取自《设定.md》表的「每天漂移 / 判定修正」两列**，不是新写的文案', () => {
        t.eq(DESIRE_BAND_NOTE.迷失, '每天 −2 · 判定恒定 +1d4 不利');
        t.eq(DESIRE_BAND_NOTE.常态, '无漂移 · 无税 · 判定正常');
        t.eq(DESIRE_BAND_NOTE.窗口, '无漂移 · 判定正常');
        t.eq(DESIRE_BAND_NOTE.沉溺, '每天 +2 · 判定恒定 −1d4 有利');
        for (const b of DESIRE_BANDS) t.ok(DESIRE_BAND_NOTE[b].length > 0, `${b} 必须有读数`);
      });
    },
  },
  {
    name: 'P5-B · 闸门分栏（动作拦截 / 控件置灰）· 《规则.md》§四 A',
    register(t) {
      const nine = () =>
        evalGates({ ledger: initialLedger(), today: 1, action: 'handle' }).map((g) => g.code);

      t.test('gatesOf 恒 10 条 = 9 条真闸门 ＋ 末条「当前状态」快照行（没被"顺手改成 9 条"）', () => {
        const l = initialLedger();
        const all = gatesOf(l, l.clock.day);
        t.eq(all.length, 10, '9 ＋ 1 —— 任何写死"9 条"的面板标题都是错的');
        t.eq(nine().length, 9, '真闸门恒 9 条（`evalGates` 只产这 9 条）');
        t.deep(all[all.length - 1], gateSnapshotOf(l), '末条恒是快照行');
        t.deep(all.slice(0, 9).map((g) => g.code), nine(), '前 9 条就是 `evalGates` 那 9 条，顺序不动');
      });

      t.test('★ 快照行与闸门 ① **同名不同物** —— 面板首尾同名，这正是要分栏去噪的那处', () => {
        const l = initialLedger();
        const all = gatesOf(l, l.clock.day);
        const head = all[0];
        const tail = all[all.length - 1];
        t.eq(head.code, 'ACTION_POINTS', '闸门 ① 的码');
        t.eq(tail.code, 'ACTION_POINTS', '快照行的码与闸门 ① **同名** —— 所以不能按 code 认它');
        t.ok(tail.reason.includes('HP'), `快照行答的是"现在的读数"（时间 ＋ HP ＋ SAN）：${tail.reason}`);
        t.ok(!head.reason.includes('HP'), `闸门 ① 答的是"还能不能新开排布"，不该谈 HP/SAN：${head.reason}`);
      });

      t.test('GATE_LANE 覆盖全部 9 个码 · 3 / 6 分布不重不漏', () => {
        const codes = nine();
        for (const c of codes) {
          t.ok(
            GATE_LANE[c] === '动作拦截' || GATE_LANE[c] === '控件置灰',
            `${c} 必须恰好属于一栏（实得 ${String(GATE_LANE[c])}）`,
          );
        }
        t.deep(
          codes.filter((c) => GATE_LANE[c] === '动作拦截'),
          ['ACTION_POINTS', 'POPUP_PENDING', 'NOT_REVEALED'],
          '拦截栏 = 时间用尽 / 档 A 未清 / 还没到揭晓点（与具体哪条事件无关）',
        );
        t.eq(codes.filter((c) => GATE_LANE[c] === '控件置灰').length, 6, '其余 6 条进置灰栏');
      });

      t.test('★ 还没有任何动作时，置灰栏 6 条**全是"本次动作不涉及…"式空话** —— 这就是分栏的理由', () => {
        const l = initialLedger();
        const grey = evalGates({ ledger: l, today: l.clock.day, action: 'handle' }).filter(
          (g) => GATE_LANE[g.code] === '控件置灰',
        );
        t.eq(grey.length, 6, '前提：置灰栏 6 条');
        t.eq(
          grey.filter((g) => g.reason.startsWith('本次动作')).length,
          6,
          '★ 一栏平铺时，这 6 行空话会把前三条真正的拦截淹掉（P5-B 要修的正是这里）',
        );
      });
    },
  },
  {
    name: '时间轴与时钟 · 《规则.md》§一（精度 = 行动点）· §四',
    register(t) {
      t.test('周例钱：第 1 / 8 / 15 / 22 天各 20（全场共 4 次 = 80；2026-10-08 用户裁定 5→20）', () => {
        t.eq(payrollForDay(1), 20);
        t.eq(payrollForDay(7), 0);
        t.eq(payrollForDay(8), 20);
        t.eq(payrollForDay(15), 20);
        t.eq(payrollForDay(22), 20);
        t.eq(payrollForDay(28), 0);
        let total = 0;
        for (let d = 1; d <= 28; d++) total += payrollForDay(d);
        t.eq(total, 80);
      });

      t.test('时间点算术：绝对点数 = day × 4 + used，两种写法等价', () => {
        t.eq(toAbs({ day: 1, used: 4 }), 8);
        t.eq(toAbs({ day: 2, used: 0 }), 8, '当天末尾 = 次日开头');
        t.eq(compareTime({ day: 1, used: 4 }, { day: 2, used: 0 }), 0);
        t.eq(compareTime({ day: 2, used: 0 }, { day: 1, used: 3 }), 1);
      });

      t.test('★ 时间点 + n 点：恰好用满当天时**保留** used=4，超出才进位', () => {
        t.deep(addPoints({ day: 1, used: 0 }, 0), { day: 1, used: 0 });
        t.deep(addPoints({ day: 1, used: 0 }, 2), { day: 1, used: 2 });
        t.deep(addPoints({ day: 1, used: 0 }, 4), { day: 1, used: 4 }, '用满当天，不进位');
        t.deep(addPoints({ day: 1, used: 2 }, 2), { day: 1, used: 4 });
        t.deep(addPoints({ day: 1, used: 2 }, 3), { day: 2, used: 1 }, '超出才进位');
        t.deep(addPoints({ day: 1, used: 0 }, 6), { day: 2, used: 2 });
        t.deep(addPoints({ day: 1, used: 0 }, 9), { day: 3, used: 1 }, '跨多天');
      });

      t.test('★ 判据：揭晓时刻 = 排布时刻 + 处理时长（**揭晓 ≡ 处理完成**）', () => {
        // 单日事件：当天排布、当天揭晓
        t.deep(addPoints({ day: 3, used: 1 }, 3), { day: 3, used: 4 });
        // 跨天事件：要等的时间就是它的处理时长，因此跨到第 4 天
        t.deep(addPoints({ day: 3, used: 1 }, 7), { day: 4, used: 4 });
      });

      t.test('★ 拨时针粒度 = [1, 当天剩余]；剩余为 0 ⇒ 空区间（只能进下一天）', () => {
        const l = initialLedger();
        l.clock.usedToday = 0;
        t.deep(dialRange(l), { min: 1, max: 4 });
        l.clock.usedToday = 3;
        t.eq(remainingToday(l), 1);
        t.deep(dialRange(l), { min: 1, max: 1 });
        l.clock.usedToday = 4;
        t.eq(remainingToday(l), 0);
        t.deep(dialRange(l), { min: 1, max: 0 }, 'min > max ⇒ 空区间');
      });

      // ⚠️⚠️ 2026-10-06 清单第 9.1 条（用户裁定第 24 条）：拨时针区间**受"正在处理的事件"约束**。
      t.test('★★ 拨时针上限 = min(当天剩余, 正在处理的事件里**最小**的那笔)', () => {
        const l = initialLedger();
        l.clock.day = 3;
        l.clock.usedToday = 0;
        // 造两条"已提交待揭晓"：还剩 2 点 / 还剩 3 点
        const mk = (id, revealUsed) => {
          const e = makeEvent({ id, title: '在办的事', status: '揭晓待办' });
          e.reveal_at = { day: 3, used: revealUsed };
          return e;
        };
        l.events.live = [mk('evA', 2), mk('evB', 3)];
        t.deep(dialRange(l), { min: 1, max: 2 }, '★ 取**最小**那笔（2），不是最大也不是和');
        t.eq(pendingCosts(l).length, 2, '两笔都在表里');
        // 只剩一条 ⇒ 上限跟着它走
        l.events.live = [mk('evA', 1)];
        t.deep(dialRange(l), { min: 1, max: 1 });
        // ⚠️ **剩下 0 点的那笔不进表**（序幕档 A `cost = 0` 就是它）
        //   —— 否则上限 0 ⇒ 全天拨不动时针（2026-10-06 实测把 28 天驱动全带红）
        l.events.live = [mk('evA', 0), mk('evB', 3)];
        t.deep(pendingCosts(l), [3], '★★ 剩 0 点的那笔被跳过了');
        t.deep(dialRange(l), { min: 1, max: 3 }, '★ 上限只看剩 ≥1 点的那些');
        // 与"当天剩余"取小
        l.events.live = [mk('evA', 4)];
        l.clock.usedToday = 3;   // 当天只剩 1
        t.deep(dialRange(l), { min: 1, max: 1 }, '★ 与当天剩余取小');
        // 一条都没有 ⇒ 回到老行为
        l.events.live = [];
        t.deep(dialRange(l), { min: 1, max: 1 });
        // 跨天的那笔（reveal_at 在下一天）⇒ 剩下 0 ⇒ 不进表
        l.events.live = [mk('evX', 9)];
        l.events.live[0].reveal_at = { day: 4, used: 1 };
        t.deep(pendingCosts(l), [], '★ 跨天的那笔不算"今天还剩几点"');
      });

      t.test('★ 过期：档 A **永不过期**；其余 = 「生成日 + deadline **天**」的日界', () => {
        const popup = makeEvent({ title: '弹窗', tier: 'A', created_day: 3, deadline: 1 });
        t.eq(expiresAt(popup), null);
        t.ok(!isExpired(popup, { day: 28, used: 4 }), '档 A 到第 28 天末尾也不过期');

        const normal = makeEvent({ title: '常规', tier: 'B', created_day: 3, deadline: 1 });
        t.deep(expiresAt(normal), { day: 4, used: 0 }, '1 天窗口 = 当天末尾到期（= {day:4, used:0}）');
        t.ok(!isExpired(normal, { day: 3, used: 3 }), '还差 1 点');
        t.ok(isExpired(normal, { day: 3, used: 4 }), '★ 当天用满即过期 —— 与 {day:4, used:0} 是同一时刻');
        t.ok(isExpired(normal, { day: 4, used: 0 }), '次日开头（≡ 当天末尾）同样算过期');

        const three = makeEvent({ title: '宽限', tier: 'B', created_day: 3, deadline: 3 });
        t.deep(expiresAt(three), { day: 6, used: 0 }, '3 天窗口');
        t.ok(!isExpired(three, { day: 5, used: 3 }), '第 5 天还剩 1 点 ⇒ 还没到');
        t.ok(isExpired(three, { day: 5, used: 4 }), '第 5 天用满 ≡ 第 6 天开头 ⇒ 到点');
        t.ok(isExpired(three, { day: 6, used: 0 }), '第 6 天开头到点');
        // ⚠️ deadline 的单位是**天**（2026-09-18）⇒ 过期时刻**永远落在日界**（used = 0）
        for (const d of [1, 2, 3, 5]) {
          t.eq(expiresAt(makeEvent({ title: 'x', tier: 'B', created_day: 2, deadline: d }))!.used, 0);
        }
      });

      t.test('★ `deadline` 的**挡位**：夹具只产 1 / 2 / 4 天（绝不会出现 3）', () => {
        // 挡位是**生成侧的硬约束**（写进 `compose_day` 的 schema description）—— 代码里没有运行期校验，
        // 所以只能靠"唯一在库的产出方（夹具）不许越界"来兜住它，否则文档与实现会悄悄漂开。
        const seen = new Set<number>();
        for (let seed = 1; seed <= 30; seed++) {
          const l = initialLedger();
          l.clock.day = 5;
          // ⚠️ 2026-09-19：夹具现在吐的是 **`compose_day` 的原始形状** ⇒ 必须过落地层才拿得到 `GameEvent`。
          //    这比"直接读夹具的字段"更强：它顺带证明了落地层的 `deadline` 归一**没把挡位改坏**。
          const landed = landCompose(l, fakeComposeDay(l, makeRng(seed)));
          for (const ev of [...landed.live, ...landed.hidden]) {
            seen.add(ev.deadline);
            t.ok(ev.deadline >= 1, `${ev.title}：deadline ≥ 1 天`);
            t.ok(DEADLINE_STEPS.includes(ev.deadline), `${ev.title}：deadline 落在挡位内（实得 ${ev.deadline}）`);
          }
        }
        t.deep(
          [...seen].sort((a, b) => a - b),
          [...DEADLINE_STEPS],
          '★ 三个挡位都必须被真产出过 —— 只产 1 天的话，"过期"只覆盖最短窗口',
        );
      });

      t.test('章号：4 章 × 7 天', () => {
        t.eq(chapterOf(1), 1);
        t.eq(chapterOf(7), 1);
        t.eq(chapterOf(8), 2);
        t.eq(chapterOf(28), 4);
      });

      t.test('阶段：序幕 / 正文 / 终局', () => {
        t.eq(phaseOf(0), '序幕');
        t.eq(phaseOf(1), '正文');
        t.eq(phaseOf(27), '正文');
        t.eq(phaseOf(28), '终局');
      });

      t.test('章节切换点：第 8 / 15 / 22 天', () => {
        t.ok(isChapterStart(8) && isChapterStart(15) && isChapterStart(22));
        t.ok(!isChapterStart(1), '第 1 天是开幕不是"切换"');
        t.ok(!isChapterStart(9));
      });
    },
  },
];
