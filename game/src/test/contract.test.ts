// 契约层：拆键 · 临时编号 · 六项校验
import { splitMixedOps } from '../contract/split.ts';
import {
  formatId,
  formatTempId,
  isAnyFormalId,
  isEventTempId,
  normalizeTempId,
  parseTempId,
} from '../contract/tempids.ts';
import { LIMITS, validateDelta } from '../contract/validate.ts';
import { fakeComposeDay } from '../fixtures/fake.ts';
import { initialLedger } from '../ledger/initial.ts';
import { landCompose } from '../turn/land-compose.ts';
import type { Suite } from './harness.ts';

export const suites: Suite[] = [
  {
    name: '拆键 · Phase 0 §五（anyOf 不保证互斥）',
    register(t) {
      t.test('判据：混键会被拆成 N 个单键 op，语义等价', () => {
        const r = splitMixedOps([{ gold: 5, rep: { 善名: 1 } }]);
        t.eq(r.ops.length, 2, '应拆成 2 个 op');
        t.eq(r.mixedCount, 1, '混键计数应为 1');
        t.deep(r.ops, [{ gold: 5 }, { rep: { 善名: 1 } }]);
      });

      t.test('判据：三键同样拆开', () => {
        const r = splitMixedOps([{ gold: 1, entities: { items: [] }, lost: { items: [] } }]);
        t.eq(r.ops.length, 3);
        t.eq(r.mixedCount, 1);
      });

      t.test('判据：非法键被记录并丢弃，合法键照常拆出', () => {
        const r = splitMixedOps([{ gold: 1, 未知键: 9 }]);
        t.eq(r.ops.length, 1);
        t.deep(r.unknownKeys, ['未知键']);
      });

      t.test('判据：一个合法键都没有的 op 被整条丢弃', () => {
        const r = splitMixedOps([{ foo: 1 }, 'not-an-object', { gold: 2 }]);
        t.eq(r.ops.length, 1);
        t.eq(r.droppedOps, 2);
      });

      t.test('判据：接受 {ops:[...]} 与裸数组两种形态', () => {
        t.eq(splitMixedOps({ ops: [{ gold: 1 }] }).ops.length, 1);
        t.eq(splitMixedOps([{ gold: 1 }]).ops.length, 1);
        t.eq(splitMixedOps('随便什么').ops.length, 0);
      });
    },
  },
  {
    name: '临时编号 · 《规则.md》§四「实体 id 管理」',
    register(t) {
      t.test('判据：@p/@it/@loc 映射到 npc/it/loc', () => {
        t.deep(parseTempId('@p1'), { kind: 'npc', seq: 1, text: '@p1' });
        t.eq(parseTempId('@it3')?.kind, 'it');
        t.eq(parseTempId('@loc10')?.kind, 'loc');
        t.eq(parseTempId('npc001'), null, '正式 id 不是临时编号');
        t.eq(parseTempId('@x1'), null, '未知前缀');
      });

      t.test('判据：正式 id 一律 3 位起', () => {
        t.ok(isAnyFormalId('npc001'));
        t.ok(isAnyFormalId('it003'));
        t.ok(isAnyFormalId('loc010'));
        t.ok(!isAnyFormalId('npc01'), '2 位不合法');
        t.ok(isAnyFormalId('npc1234'), '超过 3 位合法');
      });

      t.test('判据：事件编号用 e1 且不加 @', () => {
        t.ok(isEventTempId('e1'));
        t.ok(isEventTempId('e12'));
        t.ok(!isEventTempId('@e1'));
      });

      t.test('判据：formatId 补零到 3 位', () => {
        t.eq(formatId('npc', 7), 'npc007');
        t.eq(formatId('it', 1234), 'it1234');
        t.eq(formatTempId('npc', 7), '@p7');
      });

      t.test('判据：@p01 与 @p1 视为同一个（本批唯一）', () => {
        t.eq(normalizeTempId('@p01'), '@p1');
        t.eq(normalizeTempId('@p1'), '@p1');
      });
    },
  },
  {
    name: '六项校验 · Phase 0 §三（服务端一项都不拦）',
    register(t) {
      t.test('第 2 项 区间：gold 999999 必须被规则层钳下（服务端会原样放行）', () => {
        const r = validateDelta({ ops: [{ gold: 999999 }] });
        t.eq(r.delta.ops.length, 1);
        t.deep(r.delta.ops[0], { gold: LIMITS.gold.max });
        t.eq(r.fixes.length, 1, '应记录一笔钳制');
        t.eq(r.fixes[0].kind, 'clamped');
      });

      t.test('第 1 项 类型：gold="很多" ⇒ 该条作废（无法钳制）', () => {
        const r = validateDelta({ ops: [{ gold: '很多' }] });
        t.eq(r.delta.ops.length, 0);
        t.eq(r.drops.length, 1);
        t.ok(r.drops[0].reason.includes('integer'));
      });

      t.test('第 3 项 枚举：声望键不在五种内 ⇒ 丢弃该键', () => {
        const r = validateDelta({ ops: [{ rep: { 善名: 1, 大名: 2 } }] });
        t.eq(r.delta.ops.length, 1);
        t.deep(r.delta.ops[0], { rep: { 善名: 1 } });
        t.ok(r.drops.some((d) => d.reason.includes('不在五种名声内')));
      });

      t.test('第 3 项 枚举：attr_bonus.bonus 只认白名单 1/2/3/5', () => {
        const r = validateDelta({
          ops: [
            {
              entities: {
                items: [
                  { id: '@it1', name: '刀', desc: 'x', attr_bonus: [{ attr: '争斗', bonus: 4 }], holder: '' },
                ],
              },
            },
          ],
        });
        const item = (r.delta.ops[0] as { entities: { items: Array<{ attr_bonus: unknown[] }> } }).entities.items[0];
        t.eq(item.attr_bonus.length, 0, 'bonus=4 不在白名单，应被丢弃');
        t.ok(r.drops.some((d) => d.reason.includes('白名单')));
      });

      t.test('★ 回归（2026-09-18 live）：`Item.kind`（物品大类）必须**留存**，不能被判别符覆盖', () => {
        const r = validateDelta({
          ops: [{ entities: { items: [{ id: '@it1', kind: '特殊物品', name: '粮账抄件', desc: 'x', attr_bonus: [], holder: '' }] } }],
        });
        const item = (r.delta.ops[0] as { entities: { items: Array<{ etype: string; kind: string }> } }).entities.items[0];
        t.eq(item.kind, '特殊物品', '模型填的大类要原样留住');
        t.eq(item.etype, 'item', '判别符走 etype（系统内部字段）');
        t.eq(r.fixes.length, 0);
      });

      t.test('`Item.kind` 不在白名单 ⇒ 兜底到「特殊物品」并记一笔 fix（不整条丢弃）', () => {
        const r = validateDelta({
          ops: [{ entities: { items: [{ id: '@it1', kind: '军火', name: '刀', desc: 'x', attr_bonus: [], holder: '' }] } }],
        });
        const item = (r.delta.ops[0] as { entities: { items: Array<{ kind: string }> } }).entities.items[0];
        t.eq(item.kind, '特殊物品');
        t.ok(r.fixes.some((f) => f.path === 'ops[].entities.items[0].kind'));
      });

      t.test('第 4 项 格式：entities 里给正式 id ⇒ 丢弃（既有实体不经 entities）', () => {
        const r = validateDelta({ ops: [{ entities: { items: [{ id: 'it001', name: 'x', desc: 'y' }] } }] });
        t.eq(r.delta.ops.length, 0, '没有任何合法新实体 ⇒ 整条 op 丢掉');
        t.ok(r.drops.some((d) => d.reason.includes('只收新建')));
      });

      t.test('第 4 项 格式：change.who 是垃圾 ⇒ 丢弃该条', () => {
        const r = validateDelta({
          ops: [{ change: [{ who: '某个不存在的人', hp: 1, san: 0, attrs: [], in_your_eyes: '', openness: 0 }] }],
        });
        t.eq(r.delta.ops.length, 0);
        t.ok(r.drops.some((d) => d.reason.includes('引用非法')));
      });

      t.test('第 6 项 required：change 缺 openness ⇒ 丢弃该条', () => {
        const r = validateDelta({
          ops: [{ change: [{ who: '玩家', hp: 1, san: 0, attrs: [], in_your_eyes: '' }] }],
        });
        t.eq(r.delta.ops.length, 0);
        t.ok(r.drops.some((d) => d.reason.includes('required')));
      });

      t.test('第 5 项 键数：校验后每个 op 恰好一个键', () => {
        const r = validateDelta({ ops: [{ gold: 1, rep: { 善名: 1 } }, { gold: 2 }] });
        for (const op of r.delta.ops) t.eq(Object.keys(op).length, 1);
        t.eq(r.mixedCount, 1);
      });

      t.test('★ `change` 的**正典形态是单对象**（契约 §6.1：「逐人增量 · 唯一允许重复」= 一人一 op）', () => {
        const r = validateDelta({
          ops: [
            { change: { who: 'npc001', hp: -1, san: 0, attrs: [], in_your_eyes: '刮目相看', openness: 2 } },
            { change: { who: 'npc002', hp: 0, san: -1, attrs: [], in_your_eyes: '', openness: 0 } },
          ],
        });
        t.eq(r.delta.ops.length, 2, '两个 change op 各自留住');
        t.eq(r.drops.length, 0);
        const first = r.delta.ops[0] as { change: { who: string; hp: number }[] };
        t.eq(first.change[0].who, 'npc001');
      });

      t.test('★ 回归（2026-09-18 live）：模型照 schema 产出的单对象**曾被整条丢弃**', () => {
        const r = validateDelta({
          ops: [
            { gold: -2 },
            {
              change: { who: 'npc002', hp: 0, san: -1, attrs: [], in_your_eyes: '办得动事，却不爱把话说完', openness: 0 },
            },
          ],
        });
        t.eq(r.delta.ops.length, 2, 'gold 与 change 都要留下');
        t.ok(!r.drops.some((d) => d.path.startsWith('ops[].change')), `change 不该被丢：${JSON.stringify(r.drops)}`);
      });

      t.test('容错：`change` 写成数组（schema 说对象，但服务端不拦）⇒ 一并收下，不整条作废', () => {
        const r = validateDelta({
          ops: [{ change: [{ who: 'npc001', hp: 1, san: 0, attrs: [], in_your_eyes: '', openness: 0 }] }],
        });
        t.eq(r.delta.ops.length, 1);
        t.eq(r.drops.length, 0);
      });

      t.test('合法输入应零 fix 零 drop', () => {
        const r = validateDelta({
          ops: [
            { gold: -3 },
            { rep: { 权势: 2 } },
            { change: { who: 'npc001', hp: -1, san: 0, attrs: [{ attr: '争斗', delta: 1 }], in_your_eyes: '刮目相看', openness: 2 } },
            { lost: { items: ['it001'] } },
            { entities: { places: [{ id: '@loc1', name: '某处', desc: 'x' }] } },
          ],
        });
        t.eq(r.delta.ops.length, 5);
        t.eq(r.fixes.length, 0);
        t.eq(r.drops.length, 0);
      });
    },
  },

  {
    name: '落地层 · `compose_day` 原始输出 → 账本',
    register(t) {
      /** 第 3 天、带 **9 处预置地点**的空账本*/
      function day3() {
        const l = initialLedger();
        l.clock = { day: 3, phase: '正文', chapter: 1, usedToday: 0 };
        return l;
      }
      const opt = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
        label: '拆开',
        result_text: '（结果）',
        summary: '（摘要）',
        delta: { ops: [] },
        trigger: '',
        欲向: '无关',
        ...over,
      });
      const popup = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
        id: 'e1',
        title: '一封没有署名的请柬',
        seed_id: '',
        stage: '塞兰王庭',
        content: '（请柬压在门缝下）',
        deadline: 1,
        options: [opt()],
        ...over,
      });
      const canvas = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
        id: 'e2',
        title: '城门口的一张无名告示',
        seed_id: '',
        stage: '下城',
        content: '（告示）',
        hint_attr: ['智慧'],
        min_people: 1,
        max_people: 3,
        tier: 'B',
        cost: 2,
        min_gold: 0,
        deadline: 2,
        dispatchable: '两者皆可',
        ...over,
      });

      t.test('★ 本地编号 → 全局 id（`trigger` 一并改写）；被引用者进 `hidden`', () => {
        const l = day3();
        // 把水位抬高，好让"本地 e1/e2 与全局 id 不是一回事"这件事**看得出来**
        l.idWatermark.event = 40;
        const r = landCompose(l, {
          popup_events: [popup({ options: [opt({ trigger: 'e2' })] })],
          canvas_events: [canvas({ id: 'e2' })],
        });
        t.eq(r.live.length, 1, '弹窗直接进事件池');
        t.eq(r.hidden.length, 1, '被 trigger 引用的那条进 hidden');
        t.eq(r.live[0].id, 'e41', '全局 id 由系统发，与本地编号无关');
        t.eq(r.hidden[0].id, 'e42');
        t.eq(r.live[0].options[0].trigger, 'e42', 'trigger 必须被改写成**全局 id**');
        t.eq(l.events.live.length, 1);
        t.eq(l.events.hidden.length, 1);
      });

      t.test('★ 档 A 落地：`label`→`text`、`tier` 恒 A、`cost`/`min_gold` 归零、`deadline` 恒 1', () => {
        const l = day3();
        const r = landCompose(l, { popup_events: [popup({ deadline: 5 })], canvas_events: [] });
        const ev = r.live[0];
        t.eq(ev.tier, 'A');
        t.eq(ev.cost, 0);
        t.eq(ev.min_gold, 0);
        t.eq(ev.min_people, 0);
        t.eq(ev.max_people, 0);
        t.eq(ev.deadline, 1, '档 A 恒 1（它永不过期，只受"当天必须清"约束）');
        t.eq(ev.dispatchable, '两者皆可', '档 A 没有参与者 ⇒ 处理方式限制对它无意义');
        t.eq(ev.options[0].text, '拆开', 'schema 的 label → 账本的 text');
        t.eq(ev.options[0].result_text, '（结果）');
        t.eq(ev.options[0].trigger, null, '空串 ⇒ null');
      });

      t.test('★ 地点：名字命中已注册地点 ⇒ 复用 id；没注册过 ⇒ **补登记**一个 loc 号', () => {
        const l = day3();
        const r = landCompose(l, {
          popup_events: [popup({ stage: '塞兰王庭' })],
          canvas_events: [canvas({ stage: '西门码头' })],
        });
        t.eq(r.live[0].stage, '塞兰王庭', 'stage 存的是**显示名**（LLM 写的那个字符串）');
        t.eq(r.live[0].location, 'loc001', '命中已注册地点 ⇒ 复用 loc001，不新建');
        t.eq(l.entities.places.length, 10, '预置 9 处 ＋ 补登记的「西门码头」');
        t.eq(l.entities.places[9].name, '西门码头');
        t.eq(r.live[1].location, l.entities.places[9].id, 'location 指向刚登记的那个 id');
      });

      t.test('★ 条数硬顶：自由事件 ≤ 5（规则层再兜一次，不靠模型自觉）', () => {
        const l = day3();
        const r = landCompose(l, {
          popup_events: [],
          canvas_events: [1, 2, 3, 4, 5, 6, 7].map((i) => canvas({ id: `e${i}` })),
        });
        t.eq(r.live.length, 5);
        t.eq(r.hidden.length, 0);
        t.ok(r.log.some((s) => s.includes('自由事件 ≤5')), '要留一条丢弃日志（不静默裁剪）');
      });

      t.test('★ 档 C ≤ 1 条/天（多出来的丢弃，档 B 不受影响）', () => {
        const l = day3();
        const r = landCompose(l, {
          canvas_events: [canvas({ id: 'e1', tier: 'C' }), canvas({ id: 'e2', tier: 'C' }), canvas({ id: 'e3', tier: 'B' })],
        });
        t.eq(r.live.filter((e) => e.tier === 'C').length, 1);
        t.eq(r.live.length, 2);
      });

      t.test('★ 挡位归一：`cost` 只认 0/1/2/4 与 4 的倍数；`deadline` 只认 1/2/4', () => {
        const l = day3();
        const r = landCompose(l, {
          canvas_events: [
            canvas({ id: 'e1', cost: 3, deadline: 3 }),
            canvas({ id: 'e2', cost: 6, deadline: 3 }),
            canvas({ id: 'e3', cost: 9, deadline: 4 }),
          ],
        });
        t.deep(r.live.map((e) => e.cost), [4, 4, 8], '3→4 · 6→4 · 9→8（宁可快一点，也不造出"一天半"）');
        t.deep(r.live.map((e) => e.deadline), [4, 4, 4], '没有 3 天这一挡 ⇒ 抬到 4');
        t.ok(r.log.some((s) => s.includes('cost')), '归一要留日志');
      });

      t.test('★ 本地编号非法 / 同批重复 ⇒ 丢弃该条（结构无法修补）', () => {
        const l = day3();
        const r = landCompose(l, {
          canvas_events: [canvas({ id: 'zzz' }), canvas({ id: 'e1' }), canvas({ id: 'e1' })],
        });
        t.eq(r.live.length, 1, '只留下第一条：合法且不重复');
        t.eq(r.log.filter((s) => s.includes('丢弃一条事件')).length, 2);
      });

      t.test('★ `seed_id` 是声明式消费：软种子被承接即核销、没承接当天丢弃；硬种子没承接要报出来', () => {
        const l = day3();
        l.seeds = [
          { code: 's1', title: '软种子甲', content: '甲', source: 'LLM' },
          { code: 's2', title: '软种子乙', content: '乙', source: 'LLM' },
          { code: 's3', title: '硬种子丙', content: '丙', source: '硬种子' },
        ];
        const r = landCompose(l, { canvas_events: [canvas({ seed_id: 's1' })] });
        t.eq(l.seeds.length, 1, 's1 核销 · s2 当天丢弃 · s3 留着（硬种子不丢）');
        t.eq(l.seeds[0].code, 's3');
        t.eq(r.problems.length, 1, '硬种子的「必出」没做到 ⇒ 必须报出来，不能靠自觉');
        t.ok(r.problems[0].includes('s3'));
      });

      t.test('`seed_id` 填了列表外的编号 ⇒ 按「未承接」，不报错（契约允许乱填）', () => {
        const l = day3();
        const r = landCompose(l, { canvas_events: [canvas({ seed_id: 'e9' })] });
        t.eq(r.live.length, 1, '事件照常落地');
        t.ok(r.log.some((s) => s.includes('未承接')));
      });

      t.test('★ `Delta` 过六项校验：越界被钳、混键被拆（档 A 的 delta 不受限，但**必须合法**）', () => {
        const l = day3();
        const r = landCompose(l, {
          popup_events: [popup({ options: [opt({ delta: { ops: [{ gold: 99999, rep: { 善名: 1 } }] } })] })],
          canvas_events: [],
        });
        const ops = r.live[0].options[0].delta.ops;
        t.eq(ops.length, 2, '混键被拆成两条单键 op');
        t.ok(ops.some((o) => 'gold' in o && (o as { gold: number }).gold === 9999), '越界钳到 9999');
        t.ok(r.log.some((s) => s.includes('钳制')), '钳制要留日志');
      });

      t.test('★ 档 A 一个选项都没有 ⇒ 整条丢弃（没有可点的地方，它进不了 UI）', () => {
        const l = day3();
        const r = landCompose(l, { popup_events: [popup({ options: [] })], canvas_events: [canvas()] });
        t.eq(r.live.length, 1);
        t.eq(r.live[0].tier, 'B', '只剩那条 canvas');
        t.ok(r.log.some((s) => s.includes('一个选项都没有')));
      });

      t.test('★ 至多 1 个选项带 `trigger`（封住"触发爆炸"）', () => {
        const l = day3();
        l.idWatermark.event = 40;
        const r = landCompose(l, {
          popup_events: [popup({ options: [opt({ trigger: 'e9' }), opt({ trigger: 'e8' })] })],
          canvas_events: [canvas({ id: 'e8' }), canvas({ id: 'e9' })],
        });
        t.eq(r.live[0].options[0].trigger, 'e43', '第一个选项的 trigger 生效（本地 e9 → 全局 e43）');
        t.eq(r.live[0].options[1].trigger, null, '第二个被忽略');
        t.eq(r.hidden.length, 1);
        t.eq(r.hidden[0].id, 'e43');
        t.eq(r.live.filter((e) => e.tier === 'B').length, 1, 'e8 留在事件池里 —— 它**没有**被误锁进 hidden');
        t.ok(r.log.some((s) => s.includes('至多 1 个')));
      });

      t.test('容错：`tier` / `dispatchable` 枚举非法 ⇒ 收口到最保守的默认值，不整条作废', () => {
        const l = day3();
        const r = landCompose(l, {
          canvas_events: [canvas({ tier: 'Z', dispatchable: '随便', max_people: 0, min_people: 3 })],
        });
        t.eq(r.live[0].tier, 'B');
        t.eq(r.live[0].dispatchable, '两者皆可');
        t.eq(r.live[0].min_people, 3);
        t.eq(r.live[0].max_people, 3, 'max < min ⇒ 抬到 min（契约硬约束 1 ≤ min ≤ max）');
      });

      t.test('★ 两个通道按**结构**分：不带 `tier` 的走弹窗，带 `tier` 的走 canvas（不靠模型自报）', () => {
        const l = day3();
        // 故意把 `tier` 塞进 popup（模型多写字段）—— 它**不该**因此被当成 canvas
        const r = landCompose(l, { popup_events: [popup({ tier: 'C' })], canvas_events: [canvas({ cost: 0 })] });
        t.eq(r.live[0].tier, 'A', 'popup 通道恒 A —— 哪怕模型多塞了一个 tier 进来');
        t.eq(r.live[1].tier, 'B');
        t.eq(r.live[1].cost, 0, 'cost = 0 是合法挡位（不花时间的通知类）');
      });
    },
  },
];
