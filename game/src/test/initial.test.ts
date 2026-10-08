// 开局数据（P4-B）
//
// 为什么单独一套：
//   ① **开局数据这条链上没有任何闸门**：`race` / `identity` 只写在 schema 里当提示词，
//      服务端不校验；人数 / 地点数 / id 顺位错了也不会有任何东西报警。
//      2026-09-19 的教训正是「四个 enum 之外的取值，全链无人报警」⇒ 只能靠断言守。
//   ② 这里的期望值是**照《设定.md》重新抄一遍**的：与 `ledger/initial.ts` 出自同一份文档、
//      但**互不引用** ⇒ 任何一边抄错一格，两边就对不上。这才是"独立转录"的价值。
//      ⚠️ 改预置阵容 = 改设计文档 ⇒ 两边一起改；**不要**把某一处改成读另一处（那就白写了）。
import { attrsOf, initialLedger, PLAYER_DESC } from '../ledger/initial.ts';
import { initialWatermark } from '../ledger/ids.ts';
import { PLAYER_ID } from '../ledger/types.ts';
import { BASE_ACTION_POINTS } from '../rules/x.ts';
import { fakeBrain } from '../fixtures/fake.ts';
import { makeRng } from '../rules/rng.ts';
import { driveOpening } from '../turn/simulate.ts';
import { DEFAULT_CHOICE } from '../turn/opening.ts';
import { DESIRE_KITS } from '../rules/desire-kits.ts';
import type { Suite } from './harness.ts';

/**
 * 《设定.md·预置人物阵容》＋《六维》两表合起来的独立转录。
 * 六维元组列序 = 争斗 · 敏捷 · 智慧 · 魅力 · 社交 · 感知（与文档表列序一致）。
 */
const PRESET: ReadonlyArray<{
  name: string;
  basic: string;
  identity: string;
  in_your_eyes: string;
  openness: number;
  a: readonly [number, number, number, number, number, number];
}> = [
  { name: '奥德里克三世', basic: '国王，三王子之父', identity: '贵族', in_your_eyes: '一个总在别处的父亲', openness: 12, a: [12, 6, 13, 14, 15, 7] },
  { name: '瓦伦丁·索雷', basic: '丞相（朝中权臣）', identity: '贵族', in_your_eyes: '你每次都读不出表情的那位', openness: 5, a: [6, 8, 17, 12, 16, 4] },
  { name: '加雷恩', basic: '王储（大王子），三王子长兄', identity: '贵族', in_your_eyes: '挑不出错、也靠不近的长兄', openness: 10, a: [13, 12, 14, 15, 13, 5] },
  { name: '卢卡', basic: '二王子，三王子次兄', identity: '贵族', in_your_eyes: '忽然对你热络起来的二哥', openness: 11, a: [11, 13, 13, 12, 11, 5] },
  { name: '赫尔曼', basic: '禁卫统领', identity: '贵族', in_your_eyes: '嗓门大、酒量好，见面先拍你肩膀的那位', openness: 12, a: [18, 14, 8, 12, 13, 6] },
  { name: '伊莎尔', basic: '王后（正宫）', identity: '贵族', in_your_eyes: '待你客气得恰到好处的国母', openness: 9, a: [5, 9, 16, 13, 15, 6] },
  { name: '薇奥拉', basic: '二王妃，二王子的生母', identity: '贵族', in_your_eyes: '笑起来先看人、后开口的那位', openness: 10, a: [4, 9, 12, 16, 14, 8] },
  { name: '米蕾娅', basic: '三王妃，三王子的生母', identity: '贵族', in_your_eyes: '唯一一个见你就先笑的人', openness: 18, a: [4, 10, 11, 15, 12, 9] },
  { name: '克莱芒四世', basic: '大主教', identity: '其他', in_your_eyes: '看你时眼睛比看旁人亮的老人', openness: 12, a: [5, 7, 14, 15, 16, 16] },
  { name: '皮普', basic: '伴当骑士，自幼跟着三王子一同长大（平民出身 · 因护主受封）', identity: '贵族', in_your_eyes: '一起挨过罚、如今替你挨刀的人', openness: 17, a: [13, 13, 9, 11, 8, 6] },
];

/** 《设定.md·预置地点》（id 顺位 = 表内字序） */
const PLACES: ReadonlyArray<string> = [
  '塞兰王庭',
  '三王子寝殿',
  '大神殿',
  '贵族宅邸',
  '莎莉歌剧院',
  '金庭市集',
  '花街',
  '博德酒馆',
  '王家猎场',
];

const KEYS = ['争斗', '敏捷', '智慧', '魅力', '社交', '感知'] as const;

export const suites: Suite[] = [
  {
    name: '★ 开局数据 · 预置阵容（P4-B · 《设定.md·预置人物阵容》）',
    register(t) {
      // ⚠️⚠️ 2026-10-06 用户裁定：「现在**所有人物**都需要（形象、性格、来历的简要描述），
      //   **50-100 字**（不然人物描述太过单薄）」⇒ `Person.desc`（同一个字段、玩家那句也在内）。
      // ⚠️ **玩家那一句豁免长度**：那是用户**逐字给定**的文案
      //   （「你自己，塞兰王国的三王子。你的过往并不重要，因为你在乎的是你的现在的欲望和你的将来」），
      //   **41 字**。改它等于改用户原话 ⇒ 规矩是"预置 10 人守住 50~100"，玩家那句只钉"逐字"。
      t.test('★★ 预置 10 人的 `desc` 都在 50~100 字（形象/性格/来历）', () => {
        const people = initialLedger().entities.people;
        for (const p of people) {
          const n = [...p.desc].length;
          t.ok(n > 0, `★ ${p.name} 的 desc 是空的 —— 那是"人物描述太过单薄"的那个薄`);
          if (p.id === PLAYER_ID) continue; // 玩家那句是用户逐字给定的，见上方说明
          t.ok(
            n >= 50 && n <= 100,
            `★★ ${p.name} 的 desc ${n} 字，不在 50~100 区间（用户裁定的口径）`,
          );
        }
      });

      t.test('★★ 玩家那句 = 用户逐字给定的那一句（豁免长度，但一个字不许改）', () => {
        const me = initialLedger().entities.people.find((x) => x.id === PLAYER_ID)!;
        t.eq(me.desc, PLAYER_DESC, '玩家描述必须逐字等于用户原话（唯一拷贝在 initial.ts）');
        t.ok(
          me.desc.includes('塞兰王国的三王子') && me.desc.includes('你的将来'),
          `★★ 玩家那句被改过了：${me.desc}`,
        );
      });

      t.test('★ desc 与 `in_your_eyes` **不许互相抄**（一个是他是谁，一个是你怎么看他）', () => {
        for (const p of initialLedger().entities.people) {
          if (p.id === PLAYER_ID) continue; // 玩家那句与 in_your_eyes（空串）本就不重叠
          t.ok(
            !p.desc.includes(p.in_your_eyes),
            `★★ ${p.name}：desc 把 in_your_eyes 那句抄进去了 —— 两列分工是"他是谁"vs"你怎么看他"`,
          );
        }
      });

      t.test('★★ desc 里**不许**出现机制词与开发术语（同 `PRESET_PLACES·desc` 那条纪律）', () => {
        // ⚠️ 它真的会进 prompt（`static-head.ts:90`）⇒ 里面写"可派遣""openness"是泄底
        const 禁 = ['openness', 'affiliated', 'npc0', 'desc', 'HP', 'SAN', '可派遣', '调不动', '机制'];
        for (const p of initialLedger().entities.people) {
          for (const w of 禁) {
            t.ok(!p.desc.includes(w), `★★ ${p.name} 的 desc 里有开发术语「${w}」`);
          }
        }
      });

      t.test('★ 人数与 id 顺位：玩家 `npc000` ＋ **预置 10 人**`npc001`~`npc010`', () => {
        const people = initialLedger().entities.people;
        t.eq(people.length, 11, '玩家 ＋ 10 名预置人物');
        t.deep(
          people.map((p) => p.id),
          ['npc000', 'npc001', 'npc002', 'npc003', 'npc004', 'npc005', 'npc006', 'npc007', 'npc008', 'npc009', 'npc010'],
          '顺位错一格，后面的引用（概要 / 地界 / 生成侧）全部错位',
        );
      });

      t.test('玩家本体恒 `npc000`，且**不在**预置表里', () => {
        const people = initialLedger().entities.people;
        t.eq(people[0].id, PLAYER_ID);
        t.ok(
          PRESET.every((p) => p.name !== people[0].name),
          '预置 10 人里不许混进玩家本体',
        );
      });

      t.test('★ 人名逐字（表内字序 = id 顺位）', () => {
        const people = initialLedger().entities.people;
        t.deep(people.slice(1).map((p) => p.name), PRESET.map((p) => p.name));
      });

      t.test('`basic` / `in_your_eyes` / `openness` 逐条逐字', () => {
        const people = initialLedger().entities.people;
        for (let i = 0; i < PRESET.length; i++) {
          const p = people[i + 1];
          const want = PRESET[i];
          t.eq(p.basic, want.basic, `${want.name} 的基础信息`);
          t.eq(p.in_your_eyes, want.in_your_eyes, `${want.name} 的你眼中的ta`);
          t.eq(p.openness, want.openness, `${want.name} 的 openness`);
        }
      });

      t.test('身份：王室与受封骑士 = `贵族` · 神职 = `其他`（皮普平民出身但**已受封**）', () => {
        const people = initialLedger().entities.people;
        t.deep(people.slice(1).map((p) => p.identity), PRESET.map((p) => p.identity));
        t.eq(people.find((p) => p.name === '克莱芒四世')!.identity, '其他', '大主教走「其他」');
        t.eq(people.find((p) => p.name === '皮普')!.identity, '贵族', '受封骑士 = 贵族，不是平民');
      });

      t.test('★ 六维 60 格逐格核对（抄错一格就红）', () => {
        const people = initialLedger().entities.people;
        for (let i = 0; i < PRESET.length; i++) {
          const got = people[i + 1].attrs;
          for (let k = 0; k < 6; k++) {
            t.eq(got[KEYS[k]], PRESET[i].a[k], `${PRESET[i].name} 的 ${KEYS[k]}`);
          }
        }
      });

      t.test('★ 两处设计上的"单点突出"：赫尔曼 争斗 18 · 克莱芒四世 感知 16', () => {
        // 这两条是《设定.md·六维》六条取向里的第 2、3 条 —— 它们定义了"武力轴 / 神明轴"的独占者。
        const people = initialLedger().entities.people;
        const brawls = people.map((p) => p.attrs.争斗);
        const senses = people.map((p) => p.attrs.感知);
        t.eq(Math.max(...brawls), 18, '争斗轴只有一个人到 18');
        // ⚠️ 这里是 `t.deep` 不是 `t.eq` —— `t.eq` 走 `Object.is`，比数组**永远为假**，
        //    而且失败信息把期望/实得打成两条一模一样的字符串（人眼根本看不出问题）。
        t.deep(people.filter((p) => p.attrs.争斗 === 18).map((p) => p.name), ['赫尔曼'], '独占者是禁卫统领');
        t.eq(Math.max(...senses), 16);
        t.eq(senses.filter((v) => v === 16).length, 1, '感知 16 只有大主教一个');
      });

      t.test('★ 玩家"不成器"：预置 10 人的六维**均值**都高于序幕占位（全 5）', () => {
        // 取向 1「王储最高、玩家最低」——它是"不成器的幼子"这一开局处境的数值表达。
        const people = initialLedger().entities.people;
        const mean = (ns: number[]): number => ns.reduce((a, b) => a + b, 0) / ns.length;
        t.eq(mean(KEYS.map((k) => people[0].attrs[k])), 5, '序幕占位：六维全 5');
        for (const p of people.slice(1)) {
          t.ok(mean(KEYS.map((k) => p.attrs[k])) > 5, `${p.name} 不该比序幕占位的三王子还低`);
        }
      });
    },
  },

  {
    name: '★ 开局数据 · 地点 / 物品 / 玩家 / 数值（P4-B）',
    register(t) {
      t.test('★ 9 处地点 `loc001`~`loc009`：名字逐字、描述非空', () => {
        const places = initialLedger().entities.places;
        t.eq(places.length, 9);
        t.deep(places.map((p) => p.id), PLACES.map((_, i) => `loc00${i + 1}`));
        t.deep(places.map((p) => p.name), [...PLACES]);
        for (const p of places) t.ok(p.desc.length > 0, `${p.name} 缺一句话描述`);
      });

      t.test('★ 医馆 / 大神殿的**功能入口**不占地点 id（它们不进事件池）', () => {
        const names = initialLedger().entities.places.map((p) => p.name);
        t.ok(!names.includes('医馆'), '医馆是纯功能入口，不占 loc 号');
        t.eq(names.filter((n) => n === '大神殿').length, 1, '大神殿只占一个 id（叙事与恢复共用一个舞台）');
      });

      t.test('★ 2 件初始物品：`it001` 短匕首（有数值 · 装备）／`it002` 旧游记（无数值 · 剧情钩子）', () => {
        const items = initialLedger().entities.items;
        t.eq(items.length, 2);
        t.deep(items.map((i) => i.id), ['it001', 'it002']);
        t.deep(items.map((i) => i.name), ['短匕首', '旧游记']);

        const [dagger, book] = items;
        t.eq(dagger.kind, '装备');
        t.deep(dagger.attr_bonus, [{ attr: '争斗', bonus: 1 }], '「争斗 +1」⇒ 品级派生为粗制');
        t.eq(book.attr_bonus.length, 0, '无数值 ⇒ 品级 = 其他（纯剧情钩子）');
        t.eq(book.kind, '特殊物品');
      });

      t.test('★「两样东西」由规则层直发 ⇒ 开局**无人携带**（2026-10-08 用户裁定：默认不装备给任何人，含玩家自己）', () => {
        const l = initialLedger();
        const me = l.entities.people.find((p) => p.id === PLAYER_ID)!;
        t.deep(me.items, [], '人物卡 `items[]` 为空 —— 谁都不带（含艾德里安自己那张卡）');
        for (const i of l.entities.items) t.eq(i.holder, null, '物品卡记 `holder=null` —— 无人携带，躺在手牌区');
      });

      t.test('★ 玩家占位：名字 艾德里安 · 六维全 5 · 两个关系字段填哨兵', () => {
        const me = initialLedger().entities.people.find((p) => p.id === PLAYER_ID)!;
        t.eq(me.name, '艾德里安');
        t.eq(me.race, '人类');
        t.deep(me.attrs, attrsOf([5, 5, 5, 5, 5, 5]), '序幕占位；真实数值由 `opening` 反推（P4-C）');
        t.eq(me.in_your_eyes, '', '哨兵：自己看自己留空');
        t.eq(me.openness, 0, '哨兵：0');
      });

      t.test('★ 序幕占位数值：**金币 0** ＋ 权势 5 ＋ 其余声望 0 ＋ 欲念 30', () => {
        const l = initialLedger();
        // ⚠️ 金币写 0 才是对的：《设定.md》那句「金币 5」自带注解——「即进入第 1 天时发的那次
        //    周例钱……不是额外的一笔」⇒ 由 `turnOver` 在第 1 天发放，开局预置会让第 1 天变 10。
        t.eq(l.scalars.gold, 0, '第 1 天的周例钱才是那 5 枚（见 `payrollForDay(1)`）');
        t.eq(l.scalars.rep.权势, 5);
        t.eq(l.scalars.rep.善名 + l.scalars.rep.恶名 + l.scalars.rep.侠名 + l.scalars.rep.怪名, 0, '其余声望 0');
        t.eq(l.desire.value, 30, '欲念 30 —— 写成 0 会让档 A 点一次「偏离」就当场判「迷失」');
        t.eq(l.clock.phase, '序幕');
        t.eq(l.desire.proposition, '', '命题是 `opening` 的产物（P4-C 未建）⇒ 开局留空');
      });

      t.test('★ 下属容量：预置 10 人各满额，且**玩家不在 `byNpc` 里**（他的预算是 `clock.usedToday`）', () => {
        const l = initialLedger();
        const keys = Object.keys(l.actionPoints.byNpc).sort();
        t.eq(keys.length, 10);
        t.deep(keys, ['npc001', 'npc002', 'npc003', 'npc004', 'npc005', 'npc006', 'npc007', 'npc008', 'npc009', 'npc010']);
        for (const k of keys) t.eq(l.actionPoints.byNpc[k], BASE_ACTION_POINTS, `${k} 应满额`);
        t.eq(l.actionPoints.byNpc[PLAYER_ID], undefined, '玩家被写进 byNpc = 幽灵计数');
      });

      t.test('★ 水位与开局数据**必须一致** —— 否则第一条新生成的人物会撞上预置 id', () => {
        const l = initialLedger();
        const wm = initialWatermark();
        const maxNpc = Math.max(...l.entities.people.map((p) => Number(p.id.slice(3))));
        const maxLoc = Math.max(...l.entities.places.map((p) => Number(p.id.slice(3))));
        const maxIt = Math.max(...l.entities.items.map((i) => Number(i.id.slice(2))));
        t.eq(wm.npc, maxNpc, '人物水位 = 预置最大后缀（玩家 npc000 也算，故 10）');
        t.eq(wm.loc, maxLoc);
        t.eq(wm.it, maxIt);
      });
    },
  },

  {
    name: '★ 开局数据 · `opening` 落账（驱动与 UI 共用的唯一入口 · **玩家自己选**）',
    register(t) {
      // ⚠️ **2026-10-05 整段重写**（用户裁定）：欲望与六维不再由模型生成。
      //    现在 `driveOpening(l, brain, choice)` 多一个 `choice` 参数，
      //    六维的硬约束也从「均值 ≤ 10」改成「**总和恒 60**」。
      t.test('★ 六维**总和恒 = 60**（用户裁定"不多不少"）—— 亮点 0 / 1 / 2 都要过', async () => {
        for (const advantages of [[], ['争斗'], ['智慧', '魅力']]) {
          const r = await driveOpening(initialLedger(), fakeBrain(), { kit: 0, advantages });
          const a = r.ledger.entities.people.find((p) => p.id === PLAYER_ID)!.attrs;
          const sum = KEYS.map((k) => a[k]).reduce((x, y) => x + y, 0);
          t.eq(sum, 60, `点亮 ${advantages.length} 个：实测总和 ${sum}`);
        }
      });

      t.test('★ 六维**高于**序幕占位（全 5）—— 他分配过了，不是那个什么都没点的人', async () => {
        const r = await driveOpening(initialLedger(), fakeBrain(), DEFAULT_CHOICE);
        const a = r.ledger.entities.people.find((p) => p.id === PLAYER_ID)!.attrs;
        for (const k of KEYS) t.ok(a[k] > 5, `${k} = ${a[k]}，没高于序幕占位`);
      });

      t.test('开局补上判据 / 宣言（开局都是空的 —— 它们同属这一步的产物）', async () => {
        const l0 = initialLedger();
        t.eq(l0.desire.manifesto, '', '宣言是玩家选完才有的 ⇒ 开局留空');
        t.eq(l0.desire.proposition, '');
        // ⚠️ 2026-10-06：`desire.past` **字段已删**（序幕不再问模型）——
        //    玩家那句固定描述现在是 `Person.desc`，**开局就有**（不是开局产物）。
        t.eq(
          Object.keys(l0.desire).includes('past'),
          false,
          '★★ `desire.past` 又回来了 —— 序幕不该再问模型',
        );
        t.eq(
          l0.entities.people.find((x) => x.id === PLAYER_ID)?.desc,
          PLAYER_DESC,
          '★★ 玩家那句固定描述必须**开局就在** `Person.desc` 上（与其余人物同一字段）',
        );
        const r = await driveOpening(l0, fakeBrain(), DEFAULT_CHOICE);
        t.ok(r.ledger.desire.proposition.length > 0);
        t.ok(r.ledger.desire.manifesto.length > 0, '★ 宣言必须落账 —— 它是玩家自己写下的那句');
        t.deep(r.ledger.desire.advantages, DEFAULT_CHOICE.advantages, '★ 玩家的原始选择也要落账（UI 靠它回显）');
      });

      t.test('★ 判据与宣言 = **玩家挑的那条**（不是模型给的）', async () => {
        const r = await driveOpening(initialLedger(), fakeBrain(), { kit: 3, advantages: [] });
        t.eq(r.ledger.desire.kit, 3);
        t.eq(r.ledger.desire.manifesto, DESIRE_KITS[3].manifesto);
        t.eq(r.ledger.desire.proposition, DESIRE_KITS[3].proposition);
      });

      t.test('★ 这一步**不改**预置阵容与数值 —— 它只写该写的那几样', async () => {
        const l = initialLedger();
        const before = JSON.stringify({ p: l.entities.people.slice(1), s: l.scalars, d: l.desire.value });
        const r = await driveOpening(l, fakeBrain(), DEFAULT_CHOICE);
        t.eq(
          JSON.stringify({ p: r.ledger.entities.people.slice(1), s: r.ledger.scalars, d: r.ledger.desire.value }),
          before,
        );
      });

      t.test('★ 这一步**不就地改**入参账本（单写者 = 返回新账本）', async () => {
        const l = initialLedger();
        await driveOpening(l, fakeBrain(), DEFAULT_CHOICE);
        t.eq(l.desire.manifesto, '', '入参账本被改坏了 ⇒ 落账不是原子的');
        t.eq(l.desire.proposition, '');
      });
    },
  },
];
