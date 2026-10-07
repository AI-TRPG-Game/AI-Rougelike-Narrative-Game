// `ending` 全链测试（P4-C 第四条侧链 · 终局叙事）—— 规则层 / 装配 / 落地层 / writeEnding / 28 天驱动
//
// ⚠️ 这条侧链最值得测的是**四处没人替我们兜的地方**：
//   ① **只有成功结局才调它** —— 七条失败结局是**系统预写话术、0 调用**（§6.9）。
//      写反了不会有任何症状：只会"失败结局莫名其妙多烧一次钱"，或者"成功结局没有正文"。
//   ② **全局至多 1 次**（§6.9）—— 它靠的是**账本事实**「`text !== null` 即已经发生过」，
//      不是靠第二个标记位。⇒ 必须钉住"第二次调用什么都不做"。
//   ③ **标题 ≤8 字 / 话术 150~300 字**（§6.9）—— 服务端对模型输出**完全不校验**
//      （Phase 0 §三：`minLength` / `maxLength` 一概穿透）⇒ 唯一防线在 `applyEnding`。
//   ④ **欲望命题不在 user 段** —— 它是四条带欲望命题侧链之一，按 §4.4 的统一拼法压在
//      **system 末段**。它**不许**同时出现在 user ③ 里（同一句命题两处各一份）。
//
// ⚠️ 还有一条**结构性**断言：**风味与指令是两个东西**（用户 2026-09-18 裁定）。
//    指令 = 四局共用的通用段（`INSTRUCTION_ENDING`）；风味 = 四种成功结局各一段**独立的**
//    提示词（`ENDING_FLAVOR_NOTES`），按判出来的 `flavor` **只挂中选的那一段**。
//    ⇒ 要正反两面写：`!system.includes(旧占位符)` ＋ `system.includes(ENDING_FLAVOR_NOTES.A)`
//      ＋ **另外三支一段都不在**（互斥）。"占位符替换"那套写法已废弃 —— 见 `_patch-ending` 的说明。
//
// ⚠️ 夹具的坑（2026-09-18 踩到，两条都会**静默误解**）：
//   · `t.throws(fn, `msg`)` 的第二参数是「错误消息里必须出现的**子串**」（见 `harness.ts·throws`），
//     **不是**"断言失败时的说明文字" ⇒ 写「超一字也不行」这种描述会直接红。
//   · 断言 `endsWith(命题块)` 时，哨兵必须与 `blocks.ts·endingDesireBlock` 同一口径
//     （夹具的 `proposition` 是空串 ⇒ 渲染出的是「【…】（未定）」）。
//
// ⚠️ 与 `archive` 同族的一个前提：**标准 28 天打不到它**（三种子第 28 天欲念 61/64/65，
//    全在窗口 [75,80] 之外 ⇒ 判出来的都是**失败**结局）⇒「成功结局话术被走到」这条覆盖率
//    **只在被驱动时才断言**，见 `SimOptions.driveEnding`。
import { renderStaticHead } from '../frozen/static-head.ts';
import { initialLedger } from '../ledger/initial.ts';
import type { Ledger, Placements } from '../ledger/types.ts';
import { TOTAL_DAYS } from '../rules/clock.ts';
import {
  ENDING_TEXT_MAX,
  ENDING_TEXT_MIN,
  FLAVORS,
  FLAVOR_NAMES,
  type EndingFlavor,
} from '../rules/ending.ts';
import { assembleEnding } from '../prompt/assemble.ts';
import { endingDesirePanelBlock, endingDesireBlock, renderComposeUser, endingSummariesBlock, placementsBlock, portraitBlock } from '../prompt/blocks.ts';
import { ENDING_FLAVOR_NOTES, INSTRUCTION_ENDING } from '../prompt/instructions.ts';
import { endingTool } from '../schema/ending.ts';
import { fakeBrain, makeEvent } from '../fixtures/fake.ts';
import { applyEnding, closeGame, EndingRejected, writeEnding } from '../turn/ending.ts';
import { DRIVE_ENDING_DESIRE, simulate } from '../turn/simulate.ts';
import type { Brain, RawEndingOutput } from '../turn/brain.ts';
import type { Suite } from './harness.ts';

/** 旧机制（把风味填进指令正文的占位符）留下的那个串 —— 装配结果里必须一个字都不剩 */
const OLD_FLAVOR_SLOT = '<系统按格子填法给定，四选一>';

// ── 夹具 ─────────────────────────────────────────────────────────

/** 摆到「第 28 天、欲念 = v、玩家还活着」的账本 */
function finalDayLedger(v: number): Ledger {
  const l = initialLedger();
  l.clock = { day: TOTAL_DAYS, phase: '终局', chapter: 4, usedToday: 0 };
  l.desire.value = v;
  return l;
}

/** 三格放满的成绩（⇒ 风味 A「皆如你所愿」） */
function fullPlacements(): Placements {
  return { 成果: 'it001', 手段: 'e1', 共鸣: 'npc001' };
}

/**
 * 一份**判出成功结局**的账本 —— 装配 / 落地的共同起点。
 * 三样"有据可查的东西"都摆好，好让【最后一天放的格子】与【他这一局的样子】有真名字可渲染：
 * 一件在玩家手上的物品（成果）· 一条已结算的事件（手段）· 一个给过认可的人（共鸣）。
 */
function successLedger(v = DRIVE_ENDING_DESIRE): Ledger {
  const l = finalDayLedger(v);
  l.events.live = [
    makeEvent({ id: 'e1', title: '三天的工夫', stage: '下城', status: '已结算', participants: ['npc001'] }),
  ];
  l.entities.people.find((p) => p.id === 'npc001')!.recognized = ['他懂你要什么'];
  return closeGame(l, fullPlacements());
}

/** 一份合格的 `ending` 输出（标题 5 字、话术 200 字） */
// ⚠️ 2026-10-06 用户裁定：模型**只输出一段纯文本**（标题由规则层给）
const good = (n = 200): RawEndingOutput => ({ 结局判词: '甲'.repeat(n) });

/** 判出**失败**结局的账本（第 28 天欲念 < 75 ⇒ 总表第 5 行「未竟」） */
function failureLedger(): Ledger {
  return closeGame(finalDayLedger(50), fullPlacements());
}

/** 把某个方法换掉的 brain（其余照 `fakeBrain`）—— 专测"模型/网络不听话"那几条支路 */
function brainWith(ending: Brain['ending']): Brain {
  return { ...fakeBrain(), ending };
}

/** 出现次数（用来断言"只有一份 / 一段"） */
function countOf(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

export const suites: Suite[] = [
  // ── ① 规则层：长度常量与 title 字段 ─────────────────────────────
  {
    name: '终局叙事 · 规则层（判词长度 · title 与 name 的分工）',
    register(t) {
      t.test('★ 判词长度 = 用户裁定的值（唯一拷贝 —— 别处不许再写一个数）', () => {
        // ⚠️ 2026-10-06：`ENDING_TITLE_MAX` **已删除**（标题改由规则层给两档）
        t.eq(ENDING_TEXT_MIN, 100, '★ 2026-10-06 用户裁定：判词 100 字起');
        t.eq(ENDING_TEXT_MAX, 200, '★ 同上：200 字止');
      });

      // ⚠️⚠️ 2026-10-06：标题**不再由 ending 侧链写** —— 判出成功那一刻就写定（两档）。
      t.test('★★ 判定给 `name` 与 `title`（两档，规则层写定）；只有话术等 `ending` 侧链', () => {
        const ok = successLedger();
        t.eq(ok.ending!.name, FLAVOR_NAMES.A, '`name` = 总表那一列的**分类名**');
        t.eq(ok.ending!.name, '得偿所愿', '★ 2026-10-06：两档之一（原「皆如你所愿」）');
        t.eq(ok.ending!.title, FLAVOR_NAMES.A, '★★ `title` 当场就有值 —— 不必等 ending 侧链（全屏动画靠这个先出标题）');
        t.eq(ok.ending!.text, null, '★ 只有话术是 null（系统不得自己编一段）');
      });

      t.test('★ 失败结局两个自由文本字段都是 `null`（系统播预写话术、0 调用）', () => {
        const f = failureLedger();
        t.eq(f.ending!.kind, '失败');
        t.eq(f.ending!.row, 5);
        t.eq(f.ending!.title, null, '`ending` 不参与失败结局 ⇒ 标题也是 null（成功才有两档标题）');
        t.ok(f.ending!.text !== null && f.ending!.text.length > 0, '话术由系统当场填好');
      });

      t.test('schema：两个字段都必填、无 `$def`、长度不写死（读了也拦不住 —— 别把 schema 当防线）', () => {
        const tool = endingTool() as { function: { name: string; parameters: { properties: Record<string, { description: string }>; required: string[]; additionalProperties: boolean } } };
        t.eq(tool.function.name, 'ending');
        // ⚠️ 2026-10-06：`结局标题` 字段**整个删掉**（标题由规则层给两档）
        t.deep(tool.function.parameters.required, ['结局判词']);
        t.ok(!('结局标题' in tool.function.parameters.properties), '★★ schema 里还有「结局标题」—— 模型不该再给标题');
        t.eq(tool.function.parameters.additionalProperties, false);
        const d = tool.function.parameters.properties['结局判词'].description;
        t.ok(d.includes(String(ENDING_TEXT_MIN)) && d.includes(String(ENDING_TEXT_MAX)), '话术区间来自常量');
        t.ok(!('minLength' in tool.function.parameters.properties['结局判词']), '不写 minLength/maxLength（写了也不校验，只会让人误以为有防线）');
      });
    },
  },

  // ── ② 装配（四段式 system · 风味是**独立的一段** · user ③ 三块）──
  {
    name: '终局叙事 · 装配（四段式 system · 风味独立成段 · user ③ 三块）',
    register(t) {
      t.test('★ system = [静态头]＋[结局指令]＋[风味]＋[玩家的欲望命题]，**四段依次**、命题压最末', () => {
        const l = successLedger();
        const p = assembleEnding(l);
        t.ok(p.system.startsWith(renderStaticHead(l)), '段 ① 逐字开头（缓存纪律）');
        // ⚠️ 这里的 `|| '（未定）'` 必须与 `blocks.ts·endingDesireBlock` 的哨兵**同一口径**：
        //    夹具的 `proposition` 是空串（真要等 `opening` 侧链填），裸拼会得到「【…】」，
        //    而渲染出来的是「【…】（未定）」⇒ 两边对不上。
        // ⚠️ **2026-10-05**：这一段现在是**两行**（宣言 ＋ 命题，双文本）⇒ 断言跟着改成
        //    "整块压最末"，而不是逐字拼 `（未定）`（那是改口径之前的写法）。
        t.ok(
          p.system.endsWith(endingDesireBlock(l)),
          '★ 会变的那一小段压在**最末**（§4.4 / §1377）',
        );
        t.ok(
          p.system.indexOf('【玩家的欲望命题】') > p.system.indexOf('## 这一局的风味'),
          '★ 欲望那块在风味**之后**（四段依次）',
        );
        const iIns = p.system.indexOf(INSTRUCTION_ENDING);
        const iFlavor = p.system.indexOf(ENDING_FLAVOR_NOTES.A);
        const iDesire = p.system.indexOf('【玩家的欲望命题】');
        t.ok(iIns >= 0, '指令在 system 里');
        t.ok(iIns < iFlavor, '指令在前、风味在后（**相邻的两段**）');
        t.ok(iFlavor < iDesire, '风味在命题之前 —— 命题始终压最末');
        t.eq(p.instruction, '结局');
      });

      t.test('★ **风味与指令是两个东西**：指令里一段风味都没有，旧占位符彻底绝迹', () => {
        // ① 旧机制（占位符替换）必须一个字都不剩 —— 正反两面
        t.ok(!INSTRUCTION_ENDING.includes(OLD_FLAVOR_SLOT), '指令正文里不许再有那个尖括号占位符');
        t.ok(!assembleEnding(successLedger()).system.includes(OLD_FLAVOR_SLOT), '★ 装配结果里更要绝迹');

        // ② 指令是"通用的一段"：四段风味提示词**一段都不许混进指令正文**
        for (const f of FLAVORS) {
          t.ok(!INSTRUCTION_ENDING.includes(ENDING_FLAVOR_NOTES[f]), `指令正文里混进了风味段 ${f} —— 两者必须是两个东西`);
        }
        t.ok(INSTRUCTION_ENDING.includes('结尾收在下面这个风味上'), '指令照文档**逐字**保留那句指向（风味段就在它后面）');
      });

      // ⚠️⚠️ 2026-10-06 用户裁定：四档收敛成**两档**（原 B「有手段无共鸣」与
      //    原 C「无手段有共鸣」**合并**）⇒ 这里从「四段互斥」改成「两段互斥」。
      t.test('★★ 两段**互斥**：只挂中选的那一段（A 局里 B 一段都不许出现）', () => {
        const l = successLedger(); // 手段与共鸣都不缺 ⇒ 档 A
        const p = assembleEnding(l);
        t.eq(l.ending!.flavor, 'A');
        t.eq(countOf(p.system, ENDING_FLAVOR_NOTES.A), 1, '中选那一段**恰好挂一次**');
        t.ok(!p.system.includes(ENDING_FLAVOR_NOTES.B), '★ 另外一支（B）不许挂 —— 两段互斥');
        t.eq(countOf(p.system, '## 这一局的风味：'), 1, '整段 system 里风味标题**只有一处**');
      });

      // ⚠️⚠️ 2026-10-06：四种组合 → **两档**。用户原话：「正当的手段和他者的共鸣
      //    **都不缺** ⇒ 得偿所愿；**缺任何一个（包括都缺）** ⇒ 差一步美满」⇒
      //    「有手段无共鸣」与「无手段有共鸣」**同档**（都是缺 ⇒ 差一步美满）。
      t.test('★★ 风味跟着放格子走：两档，标题里的结局名取自 `FLAVOR_NAMES`', () => {
        const kinds: Array<[Placements, EndingFlavor]> = [
          [{ 成果: 'it001', 手段: 'e1', 共鸣: 'npc001' }, 'A'],
          [{ 成果: 'it001', 手段: 'e1', 共鸣: null }, 'B'],
          [{ 成果: 'it001', 手段: null, 共鸣: 'npc001' }, 'B'],
          [{ 成果: 'it001', 手段: null, 共鸣: null }, 'B'],
        ];
        for (const [pl, flavor] of kinds) {
          const l = finalDayLedger(DRIVE_ENDING_DESIRE);
          l.events.live = [makeEvent({ id: 'e1', title: '三天的工夫', status: '已结算' })];
          l.entities.people.find((p2) => p2.id === 'npc001')!.recognized = ['他懂你要什么'];
          const done = closeGame(l, pl);
          t.eq(done.ending!.flavor, flavor, `三格 ${JSON.stringify(pl)} ⇒ 风味 ${flavor}`);

          const sys = assembleEnding(done).system;
          t.ok(sys.includes(ENDING_FLAVOR_NOTES[flavor]), `system 挂的是 ${flavor} 那一段`);
          t.ok(
            sys.includes(flavor === 'A' ? '都不缺' : '缺了'),
            '段标题里写明这一档是「都不缺」还是「缺了」',
          );
          t.ok(
            sys.includes(`## 这一局的风味：${FLAVOR_NAMES[flavor]}`),
            '★ 段标题里的结局名取自 `FLAVOR_NAMES`（唯一拷贝，不许在风味段里再抄一份）',
          );
          t.eq(countOf(sys, '## 这一局的风味：'), 1, `${flavor} 局也只挂一段`);
        }
      });

      // ⚠️⚠️ 2026-10-06：**四种放格组合 ⇒ 两档标题**，逐格钉死。
      //    原来的 B/C 两档合并后，"有手段无共鸣"与"无手段有共鸣"**必须同档**
      //    —— 这条是最容易在后续改动里被改回去的地方（它只差一个 `&&`）。
      t.test('★★ 四种放格组合 ⇒ 两档标题（原 B/C 合并成同档，只差一个 && 就错）', () => {
        const 四种: Array<[Placements, string, EndingFlavor]> = [
          [{ 成果: 'it001', 手段: 'e901', 共鸣: 'npc001' }, '得偿所愿', 'A'],
          [{ 成果: 'it001', 手段: 'e901', 共鸣: null }, '差一步美满', 'B'],
          [{ 成果: 'it001', 手段: null, 共鸣: 'npc001' }, '差一步美满', 'B'],
          [{ 成果: 'it001', 手段: null, 共鸣: null }, '差一步美满', 'B'],
        ];
        for (const [pl, 期望标题, 期望档] of 四种) {
          const l = finalDayLedger(DRIVE_ENDING_DESIRE);
          l.events.live = [makeEvent({ id: 'e901', title: '办完了的那件事', status: '已结算' })];
          l.entities.people.find((x) => x.id === 'npc001')!.recognized = ['他懂你要什么'];
          const done = closeGame(l, pl);
          t.eq(done.ending!.kind, '成功', `${JSON.stringify(pl)} ⇒ 该判成功`);
          t.eq(
            done.ending!.title, 期望标题,
            `★★ ${JSON.stringify(pl)} ⇒ 标题「${期望标题}」，实得 ${JSON.stringify(done.ending!.title)}`,
          );
          t.eq(done.ending!.flavor, 期望档, `同上 ⇒ 档 ${期望档}`);
        }
      });

      t.test('★★ 标题在**判定那一刻**就有值 —— 不必等 ending 侧链（全屏动画靠它先出标题）', () => {
        const l = successLedger();
        t.eq(l.ending!.title, FLAVOR_NAMES.A, '判出成功时 title 已经是两档之一');
        t.eq(l.ending!.text, null, '★ 只有判词还是 null（那一趟是异步的）');
      });

      // ⚠️⚠️ 2026-10-06 用户裁定：user ③ 改成**复用 `renderComposeUser`（生成新一天那套）**
      //    ＋ 追加【你的欲望】【四行卡槽】【他这一局的样子】。
      //    ⇒ 判据从"三块 ＋ 末行"改成"**生成侧那一整段 ＋ 三块追加**"。
      t.test('★★ user ③ = 生成新一天那一套（`renderComposeUser`）＋ 三块追加 ＋ 末行', () => {
        const l = successLedger();
        const p = assembleEnding(l);
        // ① 生成侧那一整段**逐字**在里面（同一份上下文，不是重写的）
        //    ⚠️ **不硬编码块名** —— 那等于把 `renderComposeUser` 的块清单抄一份，
        //    它一改这里就假红（2026-10-06 第一次写就踩了：猜了四个块名，三个是错的）。
        //    判据改成**逐字比对**：user ③ 的**开头那一整段**必须与它一字不差。
        const gen = renderComposeUser(l);
        t.ok(p.user.startsWith(gen), '★★ user ③ 开头不是 `renderComposeUser(l)` 的原文 —— 上下文不是"生成新一天那套"');
        t.ok(
          !p.user.slice(0, gen.length).includes('【最后一天放的格子】'),
          '★ 生成侧那一段里不该混进结局独有的块',
        );
        // ② 三块追加（结局独有）
        for (const b of ['【你的欲望】', '【最后一天放的格子】', '【他这一局的样子】']) {
          t.ok(p.user.includes(b), `追加块 ${b} 在 user ③ 里`);
        }
        t.ok(p.user.indexOf('【你的欲望】') < p.user.indexOf('【最后一天放的格子】'), '追加块序：欲望 → 卡槽');
        t.ok(p.user.indexOf('【最后一天放的格子】') < p.user.indexOf('【他这一局的样子】'), '卡槽 → 画像');
        t.ok(p.user.indexOf('【他这一局的样子】') < p.user.lastIndexOf('按【结局】指令'), '末行（行动提示）在最后');
        t.ok(p.user.trim().endsWith('。'), '末行是完整一句');
        // ③ 末行口径：不再要标题
        t.ok(p.user.includes('不要写标题'), '★★ 末行必须说清"不要写标题"（那个字段已从 schema 删掉）');
      });

      // ⚠️ 2026-10-06：user ③ 现在**故意**有【你的欲望】⇒ 原来那条"命题不许出现在两处"
      //    的口径**变了**：判据改成"**块名不同 ⇒ 不是同一份**"（那是 `renderCreateUser`
      //    早就用过的同一条纪律）。
      t.test('★★ 【玩家的欲望命题】只在 system；user 里的【你的欲望】是**另一块**（面板四行）', () => {
        const l = successLedger();
        const p = assembleEnding(l);
        t.ok(p.system.includes('【玩家的欲望命题】'), 'system 末段有它（判据用的三行）');
        t.eq(countOf(p.system, '【玩家的欲望命题】'), 1, '★ system 里也**只有一次**');
        t.ok(!p.user.includes('【玩家的欲望命题】'), '★ user 段不许再放**同名**那一块');
        t.ok(p.user.includes('【你的欲望】'), '★ 但 user 里有【你的欲望】—— 那是**面板四行**，块名不同');
        t.ok(p.user.includes('如一的初衷'), '★★ 面板那四行含"如一的初衷"（命题那条只有三行）');
        t.ok(!p.system.includes('【当前命题】'), '【当前命题】是 rewrite 的块名，别串');
        t.ok(!p.system.includes('【玩家欲望】'), '★【玩家欲望】是 `chapter_shift` 的块名 —— 两个块名不共用，别混');
      });

      t.test('★ 指令只收**指令本身**：块内容不混进来，但**引用**块名是允许的（同 `archive`）', () => {
        for (const block of ['【最后一天放的格子】', '【他这一局的样子】', '【玩家的欲望命题】']) {
          t.ok(!INSTRUCTION_ENDING.includes(block), `指令里混进了块 ${block}`);
        }
        t.ok(
          INSTRUCTION_ENDING.includes('【玩家的 28 天】'),
          '**引用**块名是允许的 —— 与 `archive` 正文引用【要归并的几天】同理（夹带块**内容**才不行）',
        );
      });

      t.test('装配：只认成功结局 —— 失败 / 未判定 / 还没判都当场抛（调用侧接线错误）', () => {
        t.throws(() => assembleEnding(initialLedger()), '还没有终局判定');
        t.throws(() => assembleEnding(failureLedger()), '只用于成功结局');
      });
    },
  },

  // ── ③ 三个块各自的渲染 ──────────────────────────────────────────
  {
    name: '终局叙事 · 三个块（概要全量 / 放格子 / 画像）',
    register(t) {
      t.test('★【玩家的 28 天】给**全量**：归档 ＋ 逐条都在，第三行是〔逐条〕不是〔最近一天〕', () => {
        const l = successLedger();
        l.summaries.archive = ['很久以前并出来的一段'];
        l.summaries.recent = [
          { day: 27, text: '第 27 天的事' },
          { day: 28, text: '第 28 天的事' },
        ];
        const s = endingSummariesBlock(l);
        t.ok(s.startsWith('【玩家的 28 天】'), '块标题只在自己那一行');
        t.ok(s.includes('〔归档〕很久以前并出来的一段'), '归档段在');
        t.ok(s.includes('〔逐条〕'), '第三行是「逐条」——**终局给全量**，不是主链那一天的切片');
        t.ok(s.includes('· 第 27 天 · 第 27 天的事') && s.includes('· 第 28 天 · 第 28 天的事'), '逐条全列、保序');
        t.ok(!s.includes('〔最近一天〕'), '★ 不许复用主链【已处理概要】那个标题（那是"给最近"，与终局口径相反）');
      });

      t.test('★【玩家的 28 天】空态：归档写「（暂无）」、逐条写哨兵行 —— 都不省略行', () => {
        const l = successLedger();
        l.summaries.archive = [];
        l.summaries.recent = [];
        const s = endingSummariesBlock(l);
        t.ok(s.includes('〔归档〕（暂无）'));
        t.ok(s.includes('· （暂无）'));
      });

      t.test('★【最后一天放的格子】三格各写名字；空格子写「空」（风味 B/C/D 的来源）', () => {
        const a = placementsBlock(successLedger());
        t.ok(a.includes('【最后一天放的格子】'));
        t.ok(a.includes('成果格：旧游记') || a.includes('成果格：'), '成果格要写得出那件物品的名字');
        t.ok(a.includes('手段格：「三天的工夫」'), '手段格写事件标题（不是 id）');
        t.ok(a.includes('共鸣格：'), '共鸣格');
        t.ok(!/\bit\d|\be\d|npc\d/.test(a.replace(/成果格：[^\n]*/, '')), '★ 名字不带 id —— 与 summary 同一条纪律');

        const d = placementLedgerD();
        t.ok(d.includes('手段格：空'), '★ 空格子写「空」，不是「（暂无）」、也不是 id');
        t.ok(d.includes('共鸣格：空'));
      });

      t.test('★【他这一局的样子】六维终值 ＋ 常出没的地方 ＋ 常打交道的人 ＋ 声望五格', () => {
        const l = successLedger();
        l.events.live = [
          makeEvent({ id: 'e1', title: '甲', stage: '下城', status: '已结算', participants: ['npc001'] }),
          makeEvent({ id: 'e2', title: '乙', stage: '下城', status: '已结算', participants: ['npc001'] }),
          makeEvent({ id: 'e3', title: '丙', stage: '西门码头', status: '已结算', participants: ['npc002'] }),
          makeEvent({ id: 'e4', title: '丁', stage: '金庭', status: '待处理', participants: ['npc003'] }), // 没结算 ⇒ 不算
        ];
        const s = portraitBlock(l);
        t.ok(s.startsWith('【他这一局的样子】六维 '), '块标题与排序照 §三「结局」正文');
        t.ok(s.includes('常出没的地方 下城'), '★ 众数：下城 2 次 > 西门码头 1 次（待处理的金庭不计）');
        t.ok(s.includes('常打交道的人 '), '这一项要在');
        t.ok(s.includes('声望五格 善'), '声望五格');
        t.ok(!/\bit\d|\be\d/.test(s), '不许出现 id');
      });

      t.test('★【他这一局的样子】空态写「无」（§0.2：本来就没有这类东西用 `无`）', () => {
        const l = successLedger();
        l.events.live = [];
        const s = portraitBlock(l);
        t.ok(s.includes('常出没的地方 无'));
        t.ok(s.includes('常打交道的人 无'));
      });
    },
  },

  // ── ④ 落地层（服务端不校验 ⇒ 这里是唯一防线）────────────────────
  {
    name: '终局叙事 · 落地层（标题 ≤8 / 话术 150~300 · 单写者 · 原子）',
    register(t) {
      // ⚠️ 2026-10-06：模型只给**判词**；标题是规则层写定的 ⇒ 原样带过。
      t.test('★ 合格输出 ⇒ 判词落账、标题原样保留，其余字段**一个字不动**', () => {
        const l = successLedger();
        const next = applyEnding(l, good());
        t.eq(next.ending!.title, FLAVOR_NAMES.A, '★ 标题是规则层那一档，不被模型影响');
        t.eq(next.ending!.text, '甲'.repeat(200));
        t.eq(next.ending!.name, l.ending!.name, '判定那几项来自规则层 —— 模型改不了');
        t.eq(next.ending!.row, l.ending!.row);
        t.eq(next.ending!.flavor, l.ending!.flavor);
        t.deep(next.ending!.placements, l.ending!.placements);
      });

      t.test('★ 单写者 —— 返回新账本，入参一个字节不动', () => {
        const l = successLedger();
        const before = JSON.stringify(l);
        const next = applyEnding(l, good());
        t.eq(JSON.stringify(l), before, '入参账本没被动过');
        t.ok(next !== l && next.ending !== l.ending, '不是同一个对象');
      });

      // ⚠️⚠️ 2026-10-06 用户裁定：「LLM 只需要输出结局纯文本」⇒ **标题不再由模型给**。
      //    改钉三件事：① 标题在判出成功那一刻就**写定**（两档）；
      //    ② `applyEnding` **原样保留**它；③ 模型就算硬塞一个标题也**进不了账本**。
      t.test('★★ 结局标题：**规则层写定两档**，模型给什么都不采信', () => {
        const l = successLedger();
        t.eq(l.ending!.title, FLAVOR_NAMES.A, '判出成功那一刻标题就有值（不必等 ending 侧链）');
        // 模型硬塞一个标题 ⇒ **不许覆盖**
        const withTitle = applyEnding(l, { 结局判词: '甲'.repeat(200), 结局标题: '模型自己起的名' });
        t.eq(withTitle.ending!.title, FLAVOR_NAMES.A, '★★ 模型给的标题被无视（标题是规则层的）');
        // 档 B 那一档
        const b = finalDayLedger(DRIVE_ENDING_DESIRE);
        b.events.live = [makeEvent({ id: 'e1', title: 'x', status: '已结算' })];
        const doneB = closeGame(b, { 成果: 'it001', 手段: 'e1', 共鸣: null });
        t.eq(doneB.ending!.title, FLAVOR_NAMES.B, '缺共鸣 ⇒ 差一步美满');
      });

      t.test(`★ 结局话术：<${ENDING_TEXT_MIN} 或 >${ENDING_TEXT_MAX} 字 ⇒ 拒；两个端点都放行；按**码点**计长`, () => {
        const l = successLedger();
        t.throws(() => applyEnding(l, good(ENDING_TEXT_MIN - 1)), '结局判词');
        t.throws(() => applyEnding(l, good(ENDING_TEXT_MAX + 1)), '结局判词');
        t.eq(applyEnding(l, good(ENDING_TEXT_MIN)).ending!.text!.length, ENDING_TEXT_MIN, '下端点闭');
        t.eq(applyEnding(l, good(ENDING_TEXT_MAX)).ending!.text!.length, ENDING_TEXT_MAX, '上端点闭');
        for (const bad of ['', '   ', 42, null, undefined, {}]) {
          t.throws(() => applyEnding(l, { 结局判词: bad }), '结局判词');
        }
      });

      t.test('★ 首尾空白先 trim 再计长与落账（不然模型随手加的换行会顶破上端点）', () => {
        const l = successLedger();
        const padded = applyEnding(l, { 结局判词: `  ${'甲'.repeat(200)}  ` });
        t.eq(padded.ending!.text, '甲'.repeat(200));
        t.eq(padded.ending!.title, FLAVOR_NAMES.A, '★ 标题不受影响（它是规则层写定的）');
      });

      t.test('★ 不该调的时候调 ⇒ **当场抛**（调用侧接线错误，不是数据问题）', () => {
        t.throws(() => applyEnding(initialLedger(), good()), '还没有终局判定');
        t.throws(() => applyEnding(failureLedger(), good()), '系统已播预写话术');
      });

      t.test('★ 全局至多 1 次：写过之后再写 ⇒ 当场抛（判据就是账本上「text 非空」这个事实）', () => {
        const once = applyEnding(successLedger(), good());
        t.throws(() => applyEnding(once, good('另一个标题')), '已经写过了');
      });

      t.test('异常类型是 `EndingRejected`（与"网络 / 解析失败"分开，便于决定要不要重试）', () => {
        try {
          applyEnding(successLedger(), { 结局标题: '', 结局话术: '' });
          t.ok(false, '应当抛');
        } catch (e) {
          t.ok(e instanceof EndingRejected, `实得 ${Object.prototype.toString.call(e)}`);
        }
      });

      // ⚠️ 2026-10-06：只有判词一个字段 ⇒ "标题不许单独落下"那层顾虑**已经不存在**
      //    （标题在 `finalEndingOf` 就写定了，`applyEnding` 根本碰不到它）。
      t.test('★ 原子：判词被拒之后账本一字未动', () => {
        const l = successLedger();
        const before = JSON.stringify(l);
        t.throws(() => applyEnding(l, { 结局判词: '太短' }), '结局判词');
        t.eq(JSON.stringify(l), before, '账本一字未动');
      });
    },
  },

  // ── ⑤ writeEnding（异步 · 成功才调 · 全局 ≤1 · 失败吞掉留警告）───
  {
    name: '终局叙事 · `writeEnding`（成功才调 · 全局 ≤1 · 失败不炸掉已定的结局）',
    register(t) {
      const fake = (): Brain => fakeBrain();

      t.test('★ 失败结局 ⇒ **0 调用**（`called === false`、话术原样由系统预写）', async () => {
        const l = failureLedger();
        const r = await writeEnding(l, fake());
        t.eq(r.called, false, '★ 七条失败结局是系统播预写话术、0 调用（§6.9）');
        t.eq(r.wrote, false);
        t.eq(r.ledger, l, '一个字节都没动');
        t.deep(r.log, [], '也不该留日志噪音');
      });

      t.test('还没判出终局 ⇒ 0 调用（它只负责"被叫到时把这一件事做好"）', async () => {
        const l = finalDayLedger(DRIVE_ENDING_DESIRE);
        const r = await writeEnding(l, fake());
        t.eq(r.called, false);
        t.eq(r.ledger, l);
      });

      t.test('★ 成功结局 ⇒ 调一次、判词落账，日志把标题 / 字数 / 风味都写清', async () => {
        const l = successLedger();
        const r = await writeEnding(l, fake());
        t.eq(r.called, true);
        t.eq(r.wrote, true);
        t.ok(r.ledger.ending!.title !== null, '标题落账');
        t.ok(r.ledger.ending!.text !== null, '话术落账');
        t.ok(r.log.join('\n').includes('结局判词'), '开发侧日志里要有痕迹');
        t.ok(r.log.join('\n').includes('风味 A'), '写了风味');
        t.eq(l.ending!.text, null, '入参账本没被动过（单写者）');
      });

      t.test('★ 全局至多 1 次：第二次调用什么都不做（不重复烧钱、不覆盖已落的话术）', async () => {
        const once = await writeEnding(successLedger(), fake());
        const twice = await writeEnding(once.ledger, fake());
        t.eq(twice.called, false);
        t.eq(twice.ledger, once.ledger, '原样返回 —— 账本上的事实就是"已经发生过了"');
      });

      t.test('★ 网络 / 调用炸了 ⇒ **吞掉并留 ⚠️ 日志**：已经定好的结局不受影响', async () => {
        const l = successLedger();
        const r = await writeEnding(
          l,
          brainWith(async () => {
            throw new Error('连接超时');
          }),
        );
        t.eq(r.called, true, '确实调了');
        t.eq(r.wrote, false);
        t.eq(r.ledger, l, '结局判定（name / row / flavor / placements）一个字都没丢');
        t.ok(r.log.join('\n').includes('⚠️'), '不能静默 —— 日志里要看得见');
        t.ok(r.log.join('\n').includes('连接超时'), '错因要带上');
      });

      // ⚠️ 2026-10-06：判词不合格 ⇒ 吞掉 ＋ ⚠️ 日志；**标题仍在**（规则层早写定了）。
      t.test('★ 模型输出不合格 ⇒ 同样吞掉 ＋ ⚠️ 日志，判词保持缺失（标题不受影响）', async () => {
        const l = successLedger();
        const r = await writeEnding(l, brainWith(async () => ({ 结局判词: '太短' })));
        t.eq(r.called, true);
        t.eq(r.wrote, false);
        t.eq(r.ledger, l);
        t.eq(l.ending!.text, null, '★ 判词保持缺失（不落半截）');
        t.eq(l.ending!.title, FLAVOR_NAMES.A, '★★ 标题不受影响 —— 它是规则层在判出成功时就写定的');
        t.ok(r.log.join('\n').includes('被拒'), '日志要说清是"被拒"而不是"网络错"');
      });
    },
  },

  // ── ⑥ 28 天驱动（覆盖率：**标准局打不到** ⇒ 只能明着走一遍）───────
  {
    name: '终局叙事 · 28 天驱动（基线恒 0 调用 · 驱动局必被走到）',
    register(t) {
      t.test('★ 标准 28 天：`endings` 恒为 0 —— 三种子末值全在窗口 [75,80] 之外（设计意图，不是缺口）', async () => {
        const r = await simulate(1, TOTAL_DAYS);
        t.eq(r.stats.endings, 0, '判出来的都是失败结局 ⇒ `ending` 一次都不该被调');
        t.eq(r.ledger.ending!.kind, '失败', `末值欲念 ${r.ledger.desire.value}`);
        t.ok(r.ledger.ending!.text !== null, '失败话术由系统预写');
        t.ok(
          !r.coverage.some((c) => c.name.includes('成功结局话术')),
          '覆盖率数组里**不许**无条件出现这条 —— 那会是一条永远假绿的断言',
        );
      });

      t.test('★ 驱动局（`driveEnding`）⇒ 成功结局 ＋ 话术真的被写出，且那条覆盖率点亮', async () => {
        const r = await simulate(1, TOTAL_DAYS, { driveEnding: true });
        t.eq(r.ledger.ending!.kind, '成功', `驱动把欲念塞进窗口 ⇒ 该判成功（实得 ${r.ledger.ending!.name}）`);
        t.eq(r.ledger.ending!.row, 8, '总表第 8 行');
        t.ok(r.ledger.ending!.title !== null, '★ 标题必须落账');
        t.ok(r.ledger.ending!.text !== null, '★ 话术必须落账');
        t.eq(r.stats.endings, 1, '全局至多 1 次 ⇒ 恰好调一次');
        const c = r.coverage.find((x) => x.name.includes('成功结局话术被走到'));
        t.ok(c !== undefined, '被驱动时这条覆盖率**必须**出现');
        t.ok(c?.ok === true, `必须达标：${c?.detail}`);
        t.eq(r.violations.length, 0, '这一局仍应 0 违规');
      });

      t.test('★ 驱动只改欲念、不改别的：同一个种子走满 28 天，[75,80] 之外那些判据照旧', async () => {
        const a = await simulate(1, TOTAL_DAYS);
        const b = await simulate(1, TOTAL_DAYS, { driveEnding: true });
        t.eq(a.ledger.ending!.day, b.ledger.ending!.day, '终结日不变（都是第 28 天）');
        t.eq(a.ledger.ending!.placements.成果 !== null, b.ledger.ending!.placements.成果 !== null, '放格子那一步不受驱动影响');
        t.eq(a.stats.daysEntered, b.stats.daysEntered, '日历一步不差');
      });
    },
  },
];

/** 只有成果格的一份账本 —— 用来验【最后一天放的格子】的「空」哨兵（风味 D） */
function placementLedgerD(): string {
  const l = finalDayLedger(DRIVE_ENDING_DESIRE);
  l.events.live = [];
  for (const p of l.entities.people) p.recognized = [];
  return placementsBlock(closeGame(l, { 成果: 'it001', 手段: null, 共鸣: null }));
}
