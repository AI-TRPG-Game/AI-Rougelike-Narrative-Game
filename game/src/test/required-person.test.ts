// `required_person`（2026-09-22 落地）—— 「非他不可」这条约束**真的被执行**了吗？
//
// 为什么为它单开一个套件：它是**新增的对模型可见字段**（进了 schema 的 `required`），
// 而本项目吃过两次「schema-only 假机制」的亏 —— `dispatchable` 曾经只写在 schema 里、
// 规则层一行没读；旧 `race` / `identity` 同类。
// ⇒ **字段写进 schema ≠ 有人读它**。这里把一条链逐段钉死：
//    落地层认 → 规则层拦 → 视图给 → 卡面印 → 指令说 → 事件卡块带上。
//
// ⚠️ 语义（2026-09-20/22 用户裁定，逐字落进断言）：
//    · **必须包含他**，不是「只能是他」⇒ 允许再带帮手，与 `min_people` / `max_people` **各自独立算**；
//    · 他**不可用**时**只能等** —— 不开「破例放行」的后门（`deadline` 过期结算就是逃生通道）；
//    · 认不出的 id ⇒ 按「未指定」忽略 ＋ 留一条 ⚠️ 日志（与 `seed_id` 填错编号同款处置）。
//
// ⚠️ **本套件没覆盖到的那一格**（明说，别当成已测）：夹具 brain（`fakeComposeDay`）**不产**
//    `required_person` ⇒ 标准 28 天里这条字段恒空、**端到端那一趟没被走过**。
//    刻意没改夹具的随机池：那会让「3 种子收口 61/64/65」这条基线跟着漂。
//    ⇒ 要用真链路走一遍，照 `driveArchive` / `driveCreate` 的先例加一个 `driveRequiredPerson`（待办里记着）。
import { readFileSync } from 'node:fs';
import { makeEvent } from '../fixtures/fake.ts';
import { initialLedger } from '../ledger/initial.ts';
import { PLAYER_ID, findPerson } from '../ledger/types.ts';
import { evalGates } from '../rules/gates.ts';
import { landCompose } from '../turn/land-compose.ts';
import { Session } from '../ui/session.ts';
import { simulate } from '../turn/simulate.ts';
import { TOTAL_DAYS } from '../rules/clock.ts';
import type { Suite } from './harness.ts';

/**
 * 读"玩家页的完整源"（2026-10-08 拆分适配）。
 * index.html 主脚本已拆成 js/ 下多个文件 —— 这里把每个 script src **原位内联回来**，
 * 让对整页源码做 regex 的断言零改动（与 ui.test.ts 的 readPlayerPage 同款）。
 */
const readPlayerPage = (): string => {
  const dir = new URL('../ui/', import.meta.url);
  const html = readFileSync(new URL('index.html', dir), 'utf8');
  return html.replace(/<script src="js\/([\w.-]+\.js)"><\/script>/g, (_all, name: string) => {
    const code = readFileSync(new URL('js/' + name, dir), 'utf8');
    return `<script>\n${code}\n</script>`;
  });
};

/** 被指定的那个人 —— 只是「某个人」，换谁都不影响这几条断言 */
const HIM = 'npc002';
/** 另一个可派遣的人（用来验「只包含别人 ⇒ 拦」与「带上帮手 ⇒ 不拦」） */
const OTHER = 'npc001';

/** 一条最小的 canvas 事件 */
function canvas(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'e1',
    title: '库房那本缺页的账',
    seed_id: '',
    stage: '下城',
    content: '（正文）',
    hint_attr: ['智慧'],
    min_people: 1,
    max_people: 3,
    tier: 'B',
    cost: 2,
    min_gold: 0,
    deadline: 2,
    dispatchable: '两者皆可',
    required_person: '',
    ...over,
  };
}

function day3() {
  const l = initialLedger();
  // ⚠️ 2026-09-22（**世界数据变了**）：预置 10 人里只有**皮普**在册 ⇒ `HIM` / `OTHER`
  //    这两个「样本下属」得由夹具自己标进在册。本套件测的是 `required_person` 这条链
  //    （落地 → 闸门 ③ → 视图 → 卡面 → 指令），不是「谁是你的人」。
  for (const p of l.entities.people) p.affiliated = true;
  l.clock = { day: 3, phase: '正文', chapter: 1, usedToday: 0 };
  return l;
}

/** 落地一条 canvas 事件，把它放进事件池，返回 (账本, 事件) */
function landed(over: Record<string, unknown> = {}) {
  const l = day3();
  const r = landCompose(l, { popup_events: [], canvas_events: [canvas(over)] });
  if (r.live.length !== 1) throw new Error(`夹具没落地成功：live=${r.live.length}`);
  // ⚠️ **不要再自己 push 一遍**：`landCompose` 的第 ⑧ 段（`land-compose.ts:515`）
  //    **已经把它推进 `l.events.live` 了** —— 这里再 push 会让同一条事件在池子里出现两次，
  //    而闸门按 id `find` 取第一条 ⇒ 断言照样绿、**缺陷被掩盖**（本项目那句"绿了但没测到"）。
  return { l, ev: r.live[0], log: r.log };
}

/** 闸门 ③ 的那一条（`CANNOT_DISPATCH`） */
function gate3(l: ReturnType<typeof day3>, eventId: string, participants: string[]) {
  const g = evalGates({ ledger: l, today: l.clock.day, action: 'handle', eventId, participants });
  return g.find((x) => x.code === 'CANNOT_DISPATCH')!;
}

export const suites: Suite[] = [
  {
    name: 'required_person · 落地层（`turn/land-compose.ts`）',
    register(t) {
      t.test('实体表里有的 id ⇒ 原样落进账本', () => {
        const { ev, log } = landed({ required_person: HIM });
        t.eq(ev.required_person, HIM, '认得出就照收');
        t.ok(!log.some((s) => s.includes('required_person')), '认得出来 ⇒ 不该有那条 ⚠️ 日志');
      });

      t.test('★ 认不出的 id ⇒ 按「未指定」忽略 ＋ 留一条 ⚠️ 日志（不静默、也不当场抛）', () => {
        const { ev, log } = landed({ required_person: 'npc999' });
        t.eq(ev.required_person, '', '编出来的 id 不许进账本');
        t.ok(
          log.some((s) => s.includes('required_person') && s.includes('忽略')),
          `该有一条人话日志，实得：${JSON.stringify(log)}`,
        );
      });

      t.test('空串 ⇒ 空串，而且**不写日志**（否则每天刷一条噪声）', () => {
        const { ev, log } = landed({ required_person: '' });
        t.eq(ev.required_person, '');
        t.ok(!log.some((s) => s.includes('required_person')), '没填不是"异常"');
      });

      t.test('档 A 恒空串（它没有参与者 —— 点击即结算）', () => {
        const l = day3();
        const r = landCompose(l, {
          popup_events: [
            {
              id: 'e1',
              title: '门口的告示',
              seed_id: '',
              stage: '下城',
              content: '（正文）',
              deadline: 1,
              options: [
                {
                  label: '去看',
                  result_text: '（结果）',
                  summary: '（摘要）',
                  delta: { ops: [] },
                  trigger: '',
                  欲向: '无关',
                },
              ],
            },
          ],
          canvas_events: [],
        });
        t.eq(r.live[0].tier, 'A');
        t.eq(r.live[0].required_person, '', '档 A 不许指定人');
      });

      t.test('它与 min_people / max_people **各自独立**（允许再带帮手）', () => {
        const { ev } = landed({ required_person: HIM, min_people: 1, max_people: 3 });
        t.eq(ev.required_person, HIM);
        t.eq(ev.min_people, 1, '「必须包含他」不等于「至少两个人」');
        t.eq(ev.max_people, 3, '上限也不因为他而收窄');
      });
    },
  },

  {
    name: 'required_person · 规则层闸门 ③（复用，不新增第 10 条）',
    register(t) {
      t.test('★ 没带上他 ⇒ 拦，理由里**有名字也有 id**', () => {
        const { l, ev } = landed({ required_person: HIM });
        const g = gate3(l, ev.id, [OTHER]);
        const name = findPerson(l, HIM)!.name;
        t.eq(g.pass, false, '这次去的人里必须有他');
        t.ok(g.reason.includes(name), `理由要写出他是谁：${g.reason}`);
        t.ok(g.reason.includes(HIM), `理由要带 id（玩家要能对上号）：${g.reason}`);
      });

      t.test('只带他一个人 ⇒ 放行', () => {
        const { l, ev } = landed({ required_person: HIM });
        const g = gate3(l, ev.id, [HIM]);
        t.eq(g.pass, true, g.reason);
      });

      t.test('★ 他 ＋ 帮手 ⇒ **仍然放行** —— 「必须包含他」不是「只能是他」', () => {
        const { l, ev } = landed({ required_person: HIM });
        const g = gate3(l, ev.id, [HIM, OTHER]);
        t.eq(g.pass, true, `带上帮手不该被拦：${g.reason}`);
        t.ok(!g.reason.includes('非 '), '放行时不许出现那条理由');
      });

      t.test('★ 他不可用（HP 1）⇒ **两条路都拦** —— 「只能等」，没有破例放行的后门', () => {
        const { l, ev } = landed({ required_person: HIM });
        findPerson(l, HIM)!.hp = 1;
        const withHim = gate3(l, ev.id, [HIM, OTHER]);
        const withoutHim = gate3(l, ev.id, [OTHER]);
        t.eq(withHim.pass, false, `带他来也不行（他去了也办不了）：${withHim.reason}`);
        t.eq(withoutHim.pass, false, `不带他更不行：${withoutHim.reason}`);
        t.ok(withHim.reason.includes('不可派遣'), '带他时给出的理由是"他不可派遣"那条');
        // ⚠️ 不带他时，理由**只有**「非他不可」那一条 —— 闸门不去额外数落他的伤病：
        //    `bad` 是"对**这次提交的每个人**逐个判"（他没在提交里，就不属于那一类），
        //    "他为什么去不了"玩家点开左栏的人卡就看得到。两处都写 = 同一条信息两个事实源。
        t.ok(withoutHim.reason.includes('非 '), `不带他时给的是"非他不可"那条：${withoutHim.reason}`);
        t.ok(!withoutHim.reason.includes('不可派遣'), '他没在提交里 ⇒ 不该借 `bad` 那条数落他');
      });

      t.test('他尚未入队（`affiliated = false`）⇒ 同样两条路都拦', () => {
        const { l, ev } = landed({ required_person: HIM });
        findPerson(l, HIM)!.affiliated = false;
        t.eq(gate3(l, ev.id, [HIM]).pass, false);
        t.eq(gate3(l, ev.id, [OTHER]).pass, false);
      });

      t.test('★ 没指定谁 ⇒ 闸门 ③ 与从前**逐字相同**（不多出一条理由）', () => {
        const { l, ev } = landed({ required_person: '' });
        const g = gate3(l, ev.id, [OTHER]);
        t.eq(g.pass, true, g.reason);
        t.ok(!g.reason.includes('不可 ⇒'), `不许凭空多一条：${g.reason}`);
        t.eq(g.reason, '全部参与者可派遣', '这条文案与"从没有过这个字段"时一致');
      });

      t.test('★ 闸门仍然是**恰好 9 条**（它是复用，不是第 10 条）', () => {
        const { l, ev } = landed({ required_person: HIM });
        const all = evalGates({ ledger: l, today: l.clock.day, action: 'handle', eventId: ev.id, participants: [OTHER] });
        t.eq(all.length, 9, '加第 10 条会动《规则.md》§四 A 与封闭联合 GateCode —— 明确不做');
      });
    },
  },

  {
    name: 'required_person · 视图与卡面（会话层 → ui/index.html）',
    register(t) {
      t.test('★ `view()` 里那条事件带 `requiredPerson`（id ＋ 已解析好的名字）', async () => {
        const s = await Session.start({ seed: 20260922, skipPrologue: true });
        const ev = makeEvent({ id: 'e900', title: '库房那本缺页的账', required_person: HIM });
        s.ledger.events.live.push(ev);
        const card = s.view().todo.find((c) => c.id === 'e900');
        t.ok(card, '刚推进去的那条应当在「待办」里');
        t.deep(card!.requiredPerson, { id: HIM, name: findPerson(s.ledger, HIM)!.name }, '名字由会话层解析');
      });

      t.test('没指定 ⇒ `null`（不是空对象 —— 卡面靠它决定印不印那颗 tag）', async () => {
        const s = await Session.start({ seed: 20260922, skipPrologue: true });
        s.ledger.events.live.push(makeEvent({ id: 'e901', title: '无所谓', required_person: '' }));
        const card = s.view().todo.find((c) => c.id === 'e901');
        t.eq(card!.requiredPerson, null);
      });

      t.test('★ 卡面印「非 X 不可」＋ `warn`（与 `dispatchable` 同一组：都是"谁去做"的硬约束）', () => {
        // ⚠️ 2026-10-08 拆分适配：这颗 tag 在 js/ 文件里 —— 读"内联后的完整页"
        const html = readPlayerPage();
        t.ok(html.includes("tag('非 ' + e.requiredPerson.name + ' 不可', 'warn')"), '那颗 tag 必须存在');
        // ⚠️ 2026-10-05：判据从「`e.requiredPerson` 首次出现」改成「**那颗 tag 本身**的位置」。
        //    派遣窗口里新增了 `reqLine`（他调不动时的一行死局说明），它也读 `e.requiredPerson`
        //    且**排在 tag 之前** ⇒ 旧写法会在功能全对的情况下判红（位置断言被无关的新代码挪前了）。
        //    要钉的是「那颗 tag 归 deepTags 那组管」，那就只量那颗 tag。
        const tagAt = html.indexOf("tag('非 ' + e.requiredPerson.name + ' 不可', 'warn')");
        t.ok(tagAt > html.indexOf("group('派谁去'"),
          '它住在「派谁去」那一组里（点开才展开），不是卡面那三颗');
      });

      t.test('视图字段名与卡面用的字段名**字字一致**（防"两处各起一个名"）', () => {
        // ⚠️ 2026-10-08 拆分适配：同上 —— 读"内联后的完整页"
        const html = readPlayerPage();
        const sess = readFileSync(new URL('../ui/session.ts', import.meta.url), 'utf8');
        t.ok(sess.includes('requiredPerson:'), '会话层给的是 requiredPerson');
        t.ok(html.includes('e.requiredPerson'), 'UI 读的是同一个名字');
        t.ok(!html.includes('e.required_person'), 'UI 不许直接读账本字段名（视图层是唯一接口）');
      });
    },
  },

  {
    name: 'required_person · 给模型看的那两处（schema ＋ 指令）',
    register(t) {
      t.test('★ schema 里有它，而且进了 `required`（strict 下不填就整条不合法）', () => {
        const src = readFileSync(new URL('../schema/compose.ts', import.meta.url), 'utf8');
        const at = src.indexOf('required_person: {');
        t.ok(at > 0, '属性定义要在');
        t.ok(src.indexOf("    'required_person',") > at, 'required 列表里也要有它');
      });

      t.test('★ 字段描述只说世界的话 —— 不许出现「卡槽 / 卡牌 / 必填格」', () => {
        const src = readFileSync(new URL('../schema/compose.ts', import.meta.url), 'utf8');
        const block = src.slice(src.indexOf('required_person: {'), src.indexOf('required_person: {') + 900);
        for (const banned of ['卡槽', '卡牌', '必填格', '放上去']) {
          t.ok(!block.includes(banned), `用户明令：不需要让 LLM 知道卡牌机制 —— 不许出现「${banned}」`);
        }
        t.ok(block.includes('必须包含他'), '描述要把语义说清：必须包含他（不是只能是他）');
      });

      t.test('两条指令（生成 / 创建）都交代了它怎么填', () => {
        const src = readFileSync(new URL('../prompt/instructions.ts', import.meta.url), 'utf8');
        const n = (src.match(/required_person/g) || []).length;
        t.ok(n >= 2, `生成与创建各要有一条，实得 ${n} 处`);
      });

      t.test('★ 创建事件那条要求**填空字符串**（玩家自己出的主意，不由 LLM 指定谁非去不可）', () => {
        const src = readFileSync(new URL('../prompt/instructions.ts', import.meta.url), 'utf8');
        const i = src.indexOf('把玩家的处理方式做成一条事件');
        const j = src.indexOf('required_person', i);
        t.ok(j > i, '创建指令里也要提到它（不能只字不提 —— 它是 required 字段）');
        t.ok(src.slice(j, j + 120).includes('填空字符串'), '创建那条的口径是「填空字符串」');
      });

      t.test('【事件卡】块带上它 —— 但**只在有值时**多出那一段（空值不许污染 594 条基线）', () => {
        const src = readFileSync(new URL('../prompt/blocks.ts', import.meta.url), 'utf8');
        t.ok(src.includes("const req = ev.required_person ? ` · 非 ${ev.required_person} 不可` : '';"), '条件拼串要在');
        t.ok(src.includes('金币${req}`,'), '拼进那一行');
      });
    },
  },

  {
    name: 'required_person · 端到端驱动局（`SimOptions.driveRequiredPerson`）',
    register(t) {
      // ⚠️ 为什么要有这一组：上面三组的证据都是**单元级**的（"三个函数各自认它"）。
      //    而夹具 brain 不产这个字段 ⇒ 标准 28 天里它恒空 ⇒ **端到端那一趟从没走过**。
      //    这正是本项目吃过两次亏的形状（`dispatchable` 曾只写在 schema 里、规则层一行没读）。
      t.test('★ 驱动局：字段落账 ⇒ 不含他必拦 ⇒ 含他放行 ⇒ 真被办过（覆盖率点亮）', async () => {
        const r = await simulate(7, TOTAL_DAYS, { driveRequiredPerson: true });
        const c = r.coverage.find((x) => x.name.includes('非他不可'));
        t.ok(c, `覆盖率数组里该有这一条，实得：${r.coverage.map((x) => x.name).join(' / ')}`);
        t.eq(c!.ok, true, c!.detail);
      });

      t.test('★ 驱动局照样 0 违规（多出来的那一条事件没把别处挤坏）', async () => {
        const r = await simulate(7, TOTAL_DAYS, { driveRequiredPerson: true });
        t.eq(r.violations.length, 0, r.violations.join('；'));
      });

      t.test('★ 不驱动 ⇒ 覆盖率里**没有**那一条（不写无条件断言 ⇒ 不留一条永远假绿的断言）', async () => {
        const r = await simulate(7, TOTAL_DAYS);
        t.ok(
          !r.coverage.some((x) => x.name.includes('非他不可')),
          '没驱动就不该有这条覆盖率 —— 有的话它一定是假绿的',
        );
      });
    },
  },
];
