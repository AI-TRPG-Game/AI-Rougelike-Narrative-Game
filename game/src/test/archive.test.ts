// `archive` 全链测试（P4-C 第三条侧链 · 概要归并）—— 规则层 / 装配 / 落地层 / T0 接线 / 28 天驱动
//
// ⚠️ 这条侧链最值得测的是**四处没人替我们兜的地方**：
//   ① **章首谓词用 `isChapterStart`、不是 `isDivinationDay`** —— 后者含第 1 天，而
//      §6.10 明写「第 1 天无内容」。两个谓词长得像、**结论不同**（第 1 天 `!isChapterStart`
//      但 `isDivinationDay` 为真）⇒ 这里把两者**并排钉住**；
//   ② **「− 1」= 永久保留最近一整天** —— `N = min(7, 天数 − 1)`。写成 `slice(0, n)` 而 n ≤ 0
//      时若不早退，就会把"最近一整天"也并掉（那是最要紧的一天，且**没人会报错**）；
//   ③ **归档段 ≤300 字**、非空 —— 服务端对模型输出**完全不校验**（Phase 0 §三）⇒ 唯一防线在这里；
//   ④ **两半必须原子** —— 新段追加 ＋ 被并的那几天移出逐条区。只做一半 ⇒ 那几天**同时活在两处**，
//      【已处理概要】会把同一件事渲染两遍给生成侧看，而**没有任何断言会红**。
//
// ⚠️ 还有一条**结构性**断言：`archive` 是**四条侧链里唯一不带欲望命题的一条**
//    ⇒ system 必须**恰好两段**。这条只能靠"断言它**不含**
//    那些块标题"来守 —— 与"渲染值 == 常量值"抓不到字面量同一个道理，要正反两面都写。
import { readFileSync } from 'node:fs';
import { renderStaticHead } from '../frozen/static-head.ts';
import { initialLedger } from '../ledger/initial.ts';
import type { Ledger } from '../ledger/types.ts';
import {
  ARCHIVE_HARD_LIMIT,
  ARCHIVE_MAX_DAYS,
  ARCHIVE_SEGMENT_MAX,
  ARCHIVE_SOFT_LIMIT,
  charCount,
  distinctDays,
  planArchive,
  type RecentSummary,
} from '../rules/archive.ts';
import { isDivinationDay } from '../rules/chapter-shift.ts';
import { chapterOf, isChapterStart } from '../rules/clock.ts';
import { makeRng } from '../rules/rng.ts';
import { assembleArchive } from '../prompt/assemble.ts';
import { archiveSourceBlock, existingArchiveBlock } from '../prompt/blocks.ts';
import { INSTRUCTION_ARCHIVE } from '../prompt/instructions.ts';
import { fakeBrain } from '../fixtures/fake.ts';
import { applyArchive, ArchiveRejected } from '../turn/archive.ts';
import { simulate } from '../turn/simulate.ts';
import { enterDay } from '../turn/t0.ts';
import type { Suite } from './harness.ts';

// ── 夹具 ─────────────────────────────────────────────────────────

/** 造一批逐条概要：`spec` = `[[天, 字数], …]`（同一天可给多条）—— 字数按**码点**精确可控 */
function recentOf(spec: Array<[number, number]>): RecentSummary[] {
  return spec.map(([day, n]) => ({ day, text: '甲'.repeat(n) }));
}

/** 某个「第 N 天」的账本（只改时钟与概要区 —— 其余照 `initialLedger` 的序幕占位） */
function atDay(day: number, recent: RecentSummary[] = [], archive: string[] = []): Ledger {
  const l = structuredClone(initialLedger());
  l.clock.day = day;
  l.clock.chapter = chapterOf(day);
  l.clock.usedToday = 0;
  l.summaries.recent = recent.map((r) => ({ ...r }));
  l.summaries.archive = [...archive];
  return l;
}

/** 一份合格的归并输出 */
const good = (seg = '第 1~2 天：甲甲甲。') => ({ 归档段: seg });

/** 章首 + 逐条区越软顶的一份标准局面（3 天；第 3 天是"最近一整天"）*/
function overSoft(): Ledger {
  return atDay(8, recentOf([[1, 900], [2, 900], [3, 100], [3, 100], [3, 100]]));
}

export const suites: Suite[] = [
  // ── ① 阈值与触发判据 ────────────────────────────────────────────
  {
    name: '概要归并 · 阈值与触发判据（《契约.md》§5.7 / §6.10）',
    register(t) {
      t.test('★ 四个阈值 = 文档原值（唯一拷贝 —— 别处不许再写一个数）', () => {
        t.eq(ARCHIVE_SOFT_LIMIT, 2000, '逐条区软顶');
        t.eq(ARCHIVE_HARD_LIMIT, 5000, '总量硬顶');
        t.eq(ARCHIVE_MAX_DAYS, 7, '一次最多并 7 天');
        t.eq(ARCHIVE_SEGMENT_MAX, 300, '归档段 ≤300 字');
      });

      t.test('★ 章首 = 第 8 / 15 / 22 天 —— **不含第 1 天**（与占卜日 1/8/15/22 是两回事）', () => {
        for (const d of [8, 15, 22]) t.ok(isChapterStart(d), `第 ${d} 天是章首`);
        for (const d of [1, 2, 7, 9, 14, 23, 28]) t.ok(!isChapterStart(d), `第 ${d} 天不是章首`);
        // ★ 这条是"为什么不能共用谓词"的定点：第 1 天两个谓词**结论相反**
        t.ok(!isChapterStart(1), 'isChapterStart(1) === false');
        t.ok(isDivinationDay(1), 'isDivinationDay(1) === true');
        // §6.10：「第 1 天无内容」⇒ 软触发对第 1 天本就不成立
        t.ok(!planArchive(1, recentOf([[1, 3000]]), []).trigger, '第 1 天不归并（那天本来就没有可并的历史）');
      });

      t.test('★ 软触发：章首 ＋ 逐条区 > 2000 字（**恰好** 2000 不算）', () => {
        const over = planArchive(8, recentOf([[1, 1100], [2, 1100]]), []);
        t.eq(over.chars.recent, 2200, '实测逐条区字数');
        t.ok(over.trigger, '2200 > 2000 ⇒ 触发');
        t.eq(over.reason, '章首·逐条超软顶', '理由要写清是哪条判据（开发侧唯一可见性）');
        t.ok(over.chapterStart, '章首标记');

        const exact = planArchive(8, recentOf([[1, 1000], [2, 1000]]), []);
        t.eq(exact.chars.recent, ARCHIVE_SOFT_LIMIT, '恰好等于阈值');
        t.ok(!exact.trigger, '恰好等于阈值 ⇒ **不**触发（判据是 > 而不是 ≥）');
      });

      t.test('★ 非章首：同样的逐条区**不**触发（软顶只在章首看，不是天天看）', () => {
        const p = planArchive(9, recentOf([[1, 1100], [2, 1100]]), []);
        t.ok(!p.trigger, '第 9 天不是章首 ⇒ 软顶不成立');
        t.eq(p.reason, '非章首且未超硬顶');
      });

      t.test('★ 硬触发：总量（归档 ＋ 逐条）> 5000 字 ⇒ **不问章首**，当天立即', () => {
        const p = planArchive(9, recentOf([[1, 1000], [2, 1000]]), ['乙'.repeat(3500)]);
        t.eq(p.chars.total, 5500, '总量 = 逐条 2000 ＋ 归档 3500');
        t.ok(p.trigger, '越硬顶 ⇒ 触发');
        t.eq(p.reason, '总量超硬顶', '硬顶理由优先于软顶（更强的那个）');
        t.ok(!p.chapterStart, '它**不是**章首 —— 证明硬顶与章首无关');

        const exact = planArchive(9, recentOf([[1, 1000], [2, 1000]]), ['乙'.repeat(3000)]);
        t.eq(exact.chars.total, ARCHIVE_HARD_LIMIT, '恰好等于硬顶');
        t.ok(!exact.trigger, '恰好 5000 ⇒ 不触发（同一条 > 纪律）');
      });
    },
  },

  // ── ② 归并对象 ──────────────────────────────────────────────────
  {
    name: '概要归并 · 归并对象（N = min(7, 逐条天数 − 1) · 「− 1」= 永久保留最近一整天）',
    register(t) {
      t.test('★ 8 天 ⇒ 并最老 7 天、留最后 1 天', () => {
        const r = recentOf([[1, 400], [2, 400], [3, 400], [4, 400], [5, 400], [6, 400], [7, 400], [8, 400]]);
        const p = planArchive(15, r, []);
        t.ok(p.trigger, `3200 字 > 软顶`);
        t.deep(p.days, [1, 2, 3, 4, 5, 6, 7], '并最老的 7 天');
        t.deep(p.keptDays, [8], '第 8 天留下来');
        t.eq(p.items.length, 7, '条目数 = 那几天各自的条数之和');
      });

      t.test('★ 4 天 ⇒ 并最老 3 天；2 天 ⇒ 并最老 1 天', () => {
        const four = planArchive(8, recentOf([[1, 700], [2, 700], [3, 700], [4, 700]]), []);
        t.deep(four.days, [1, 2, 3]);
        t.deep(four.keptDays, [4]);
        const two = planArchive(8, recentOf([[1, 1100], [2, 1100]]), []);
        t.deep(two.days, [1]);
        t.deep(two.keptDays, [2]);
      });

      t.test('★ 只有 1 天 ⇒ **整条不触发**（不是"并 0 天"）', () => {
        const p = planArchive(8, recentOf([[1, 3000]]), []);
        t.ok(!p.trigger);
        t.eq(p.reason, '逐条不足 2 天');
        t.deep(p.days, [], '不许出现"并 0 天"这种半状态');
        t.deep(p.items, []);
        t.deep(p.keptDays, [1], '一整天原样留着');
      });

      t.test('★ 空逐条区 ⇒ 不触发（归档区里有东西也一样）', () => {
        const p = planArchive(8, [], ['乙'.repeat(100)]);
        t.ok(!p.trigger);
        t.eq(p.reason, '逐条不足 2 天');
        t.deep(p.keptDays, []);
      });

      t.test('★ 最近一天的**所有条目**一起留下 —— 同一天的多条不许被拆开', () => {
        const l = overSoft(); // 第 3 天有 3 条
        const p = planArchive(8, l.summaries.recent, l.summaries.archive);
        t.deep(p.days, [1, 2]);
        t.deep(p.keptDays, [3]);
        t.eq(p.items.filter((x) => x.day === 3).length, 0, '第 3 天的三条一条都不进 items');
        t.eq(p.items.length, 2, '待并的只有第 1 / 2 天各一条');
      });

      t.test('★ `items` 按**时间序**（= `recent` 原顺序），覆盖那几天的全部条目', () => {
        const r = recentOf([[1, 700], [1, 700], [2, 700], [3, 100], [3, 100]]);
        const p = planArchive(8, r, []);
        t.ok(p.trigger, `${charCount('甲'.repeat(700)) * 3 + 200} 字`);
        t.deep(p.days, [1, 2]);
        t.deep(p.items.map((x) => x.day), [1, 1, 2], '第 1 天的两条都在、且保序');
        t.deep(distinctDays(r), [1, 2, 3], 'distinctDays 升序去重');
      });
    },
  },

  // ── ③ 装配（唯一不带欲望命题的侧链）────────────────────────────
  {
    name: '概要归并 · 装配（两段式 system · user ③ 两块 ＋ 末行）',
    register(t) {
      t.test('★ system = [静态头] ＋ [归并指令]，**恰好两段** —— 四条侧链里唯一的例外', () => {
        const l = overSoft();
        const plan = planArchive(8, l.summaries.recent, l.summaries.archive);
        const p = assembleArchive(l, plan);
        t.ok(p.system.startsWith(renderStaticHead(l)), '段 ① 逐字开头（缓存纪律）');
        t.eq(p.system, renderStaticHead(l) + '\n\n' + INSTRUCTION_ARCHIVE, 'system 恰好两段，一字不多');
        // ★ 反面：不许偷偷多拼一段欲望命题（另外四条侧链都有，它**没有**）
        for (const bad of ['【玩家欲望】', '【当前命题】', '【他的欲望】']) {
          t.ok(!p.system.includes(bad), `system 里不许出现 ${bad}`);
        }
        t.eq(p.instruction, '归并');
      });

      t.test('★ user ③：【要归并的几天】＋【已有的归档段】＋ 末行；待并清单**只列那几天**', () => {
        const l = overSoft();
        const plan = planArchive(8, l.summaries.recent, l.summaries.archive);
        const p = assembleArchive(l, plan);
        t.ok(p.user.includes('【要归并的几天】'), '块一在');
        t.ok(p.user.includes('【已有的归档段】'), '块二在');
        t.ok(p.user.includes('· 第 1 天 · '), '第 1 天进了待并清单');
        t.ok(p.user.includes('· 第 2 天 · '), '第 2 天进了待并清单');
        t.ok(!p.user.includes('· 第 3 天 · '), '第 3 天是"最近一整天" ⇒ **不许**出现在待并清单里');
        t.ok(p.user.indexOf('【要归并的几天】') < p.user.indexOf('【已有的归档段】'), '块序：待并 → 已有');
        t.ok(
          p.user.indexOf('【已有的归档段】') < p.user.lastIndexOf('按【归并】指令'),
          '末行（行动提示）在最后',
        );
        t.ok(p.user.trim().endsWith('。'), '末行是完整一句');
        t.eq(archiveSourceBlock(plan).split('\n')[0], '【要归并的几天】', '块标题只在自己那一行');
      });

      t.test('★【已有的归档段】空态哨兵是「无」、**不是**「（暂无）」（§6.10 原文）', () => {
        const empty = atDay(8, [], []);
        t.eq(existingArchiveBlock(empty), '【已有的归档段】\n无');
        const l = overSoft();
        l.summaries.archive = ['第一段旧事', '第二段旧事'];
        t.eq(
          existingArchiveBlock(l),
          '【已有的归档段】\n第一段旧事\n第二段旧事',
          '旧段**原样全列** —— 不许摘要、不许只给最后一段',
        );
      });
    },
  },

  // ── ④ 落地层（服务端不校验 ⇒ 这里是唯一防线）────────────────────
  {
    name: '概要归并 · 落地层（服务端不校验 ⇒ 这里是唯一防线）',
    register(t) {
      t.test('★ 合格输出 ⇒ 归档区 +1、那几天从逐条区搬走（同一次落账的两半）', () => {
        const l = overSoft();
        const plan = planArchive(8, l.summaries.recent, l.summaries.archive);
        const r = applyArchive(l, good(), plan);
        t.deep(r.ledger.summaries.archive, ['第 1~2 天：甲甲甲。'], '新段进了归档区');
        t.deep(r.ledger.summaries.recent.map((x) => x.day), [3, 3, 3], '第 3 天的三条留下');
        t.deep(r.days, [1, 2]);
        t.eq(r.before.recent, 5);
        t.eq(r.after.recent, 3);
      });

      t.test('★ 单写者 —— 返回新账本，入参一个字节不动', () => {
        const l = overSoft();
        const plan = planArchive(8, l.summaries.recent, l.summaries.archive);
        const before = JSON.stringify(l);
        const r = applyArchive(l, good(), plan);
        t.eq(JSON.stringify(l), before, '入参账本没被动过');
        t.ok(r.ledger !== l, '不是同一个对象');
      });

      t.test('★ 原子：被拒之后**入参账本一字未动**（归档段不许单独落下）', () => {
        const l = overSoft();
        const plan = planArchive(8, l.summaries.recent, l.summaries.archive);
        const before = JSON.stringify(l);
        t.throws(() => applyArchive(l, { 归档段: '丙'.repeat(ARCHIVE_SEGMENT_MAX + 1) }, plan), '归档段');
        t.eq(JSON.stringify(l), before, '拒了 ⇒ 归档区与逐条区一起没动');
      });

      t.test('★ `plan.trigger === false` ⇒ 当场抛（调用侧接线错误，不是数据问题）', () => {
        const l = atDay(9, recentOf([[1, 10], [2, 10]]));
        const plan = planArchive(9, l.summaries.recent, l.summaries.archive);
        t.ok(!plan.trigger);
        t.throws(() => applyArchive(l, good(), plan), '没有要归并的');
      });

      t.test('★ 归档段为空 / 全空白 / 非字符串 ⇒ 拒', () => {
        const l = overSoft();
        const plan = planArchive(8, l.summaries.recent, l.summaries.archive);
        for (const bad of ['', '   ', '\n\t ', 42, null, undefined, {}]) {
          t.throws(() => applyArchive(l, { 归档段: bad }, plan), '归档段');
        }
        t.throws(() => applyArchive(l, null, plan), '归档段');
      });

      t.test('★ 归档段 > 300 字 ⇒ 拒；**恰好** 300 ⇒ 过；首尾空白先 trim 再计长', () => {
        const l = overSoft();
        const plan = planArchive(8, l.summaries.recent, l.summaries.archive);
        t.throws(() => applyArchive(l, good('丙'.repeat(ARCHIVE_SEGMENT_MAX + 1)), plan), '> 300');
        t.eq(charCount('丙'.repeat(ARCHIVE_SEGMENT_MAX)), ARCHIVE_SEGMENT_MAX, '按码点计长');
        const ok300 = applyArchive(l, good('丙'.repeat(ARCHIVE_SEGMENT_MAX)), plan);
        t.eq(charCount(ok300.ledger.summaries.archive[0]), ARCHIVE_SEGMENT_MAX, '恰好 300 字放行');
        const padded = applyArchive(l, good(`  短的一段  `), plan);
        t.eq(padded.ledger.summaries.archive[0], '短的一段', 'trim 之后才落账');
      });

      t.test('★ 旧归档段**原样保留** —— 新段是**追加**，不是重写全篇', () => {
        const l = overSoft();
        l.summaries.archive = ['很久以前的一段', '再往前的一段'];
        const plan = planArchive(8, l.summaries.recent, l.summaries.archive);
        const r = applyArchive(l, good('新的一段'), plan);
        t.deep(r.ledger.summaries.archive, ['很久以前的一段', '再往前的一段', '新的一段']);
      });

      t.test('★ 日志把**触发理由 / 实测字数 / 前后规模**都写清了（开发侧唯一可见性）', () => {
        const l = overSoft();
        const plan = planArchive(8, l.summaries.recent, l.summaries.archive);
        const r = applyArchive(l, good(), plan);
        const all = r.log.join('\n');
        t.ok(all.includes('概要归并'), '写了这件事');
        t.ok(all.includes('章首·逐条超软顶'), '写了理由');
        t.ok(all.includes(String(plan.chars.recent)), '写了实测字数');
        t.ok(all.includes('第 1~2 天'), '写了并了哪几天');
      });

      t.test('异常类型是 `ArchiveRejected`（与"网络 / 解析失败"分开，便于决定要不要重试）', () => {
        const l = overSoft();
        const plan = planArchive(8, l.summaries.recent, l.summaries.archive);
        try {
          applyArchive(l, { 归档段: '' }, plan);
          t.ok(false, '应当抛');
        } catch (e) {
          t.ok(e instanceof ArchiveRejected, `实得 ${Object.prototype.toString.call(e)}`);
        }
      });
    },
  },

  // ── ⑤ T0 接线 ───────────────────────────────────────────────────
  {
    name: '概要归并 · T0 接线（章首检查 · 排在章节占卜之后、生成之前）',
    register(t) {
      t.test('★ 标准局（逐条区很小）⇒ 不触发：`archived` 为 null、概要不许被动过', async () => {
        const l = atDay(8, recentOf([[1, 10], [2, 10], [3, 10]]));
        const e = await enterDay(l, makeRng(1), fakeBrain(), 1);
        t.eq(e.archived, null, '没触发 ⇒ null');
        t.eq(e.ledger.summaries.archive.length, 0, '归档区仍是空的');
        t.eq(e.ledger.summaries.recent.length, 3, '逐条区一条没少');
      });

      t.test('★ 超软顶 ＋ 章首 ⇒ `enterDay` 真的归并（两半都落）', async () => {
        const l = atDay(8, recentOf([[1, 1200], [2, 1200], [3, 100]]));
        const e = await enterDay(l, makeRng(1), fakeBrain(), 1);
        t.ok(e.archived !== null, '`archived` 非 null');
        t.deep(e.archived!.days, [1, 2], '并的是最老的两天');
        t.ok(charCount(e.archived!.segment) <= ARCHIVE_SEGMENT_MAX, '归档段 ≤300 字');
        t.eq(e.ledger.summaries.archive.length, 1, '归档区 +1');
        t.deep(e.ledger.summaries.recent.map((x) => x.day), [3], '只剩"最近一整天"');
        t.ok(e.log.some((s) => s.includes('概要归并')), '开发侧日志里要有痕迹');
      });

      t.test('★ 非章首且未越硬顶 ⇒ `enterDay` 不归并（判据不在 t0 里手写，全在 planArchive）', async () => {
        const l = atDay(9, recentOf([[1, 1200], [2, 1200], [3, 100]]));
        const e = await enterDay(l, makeRng(1), fakeBrain(), 1);
        t.eq(e.archived, null);
        t.eq(e.ledger.summaries.archive.length, 0);
      });

      t.test('★ 归并排在**章节占卜之后、生成之前**（读源码的守卫）', () => {
        const src = readFileSync(new URL('../turn/t0.ts', import.meta.url), 'utf8');
        const iDiv = src.indexOf('if (isDivinationDay(l.clock.day))');
        const iArch = src.indexOf('planArchive(l.clock.day');
        const iCompose = src.indexOf('brain.composeDay(l, rng)');
        t.ok(iDiv >= 0, '占卜那一段要在');
        t.ok(iArch >= 0, '归并那一段要在');
        t.ok(iCompose >= 0, '生成那一段要在');
        t.ok(iDiv < iArch, '占卜 → 归并（§6.7 / §5.7 的 T0 内部顺序）');
        t.ok(iArch < iCompose, '归并 → 生成（生成侧是概要的最大消费者，先并后生成）');
      });
    },
  },

  // ── ⑥ 28 天驱动（覆盖率：**阈值放宽 ⇒ 只能明着走一遍**）─────────
  {
    name: '概要归并 · 28 天驱动（标准局恒不触发 · 驱动局必被走到）',
    register(t) {
      t.test('★ 标准 28 天：`archives` 恒为 0 —— 「放宽阈值」的实测后果（设计意图，不是缺口）', async () => {
        const r = await simulate(7, 28);
        t.eq(r.stats.archives, 0, '阈值 2000/5000 在真实规模下够不到（28 天约 39 次结算）');
        t.eq(r.ledger.summaries.archive.length, 0, '归档区仍然是空的');
        t.ok(
          !r.coverage.some((c) => c.name.includes('概要归并')),
          '覆盖率数组里**不许**无条件出现这条 —— 那会是一条永远假绿的断言',
        );
      });

      t.test('★ 驱动局（`driveArchive`）⇒ 归并真的被走到，且那条覆盖率点亮', async () => {
        const r = await simulate(7, 28, { driveArchive: true });
        t.ok(r.stats.archives >= 1, `实际归并 ${r.stats.archives} 次`);
        t.ok(r.ledger.summaries.archive.length >= 1, `归档区 ${r.ledger.summaries.archive.length} 段`);
        const c = r.coverage.find((x) => x.name.includes('概要归并被走到'));
        t.ok(c !== undefined, '被驱动时这条覆盖率**必须**出现');
        t.ok(c?.ok === true, `必须达标：${c?.detail}`);
        t.eq(r.violations.length, 0, '这一局仍应 0 违规');
        for (const seg of r.ledger.summaries.archive) {
          t.ok(charCount(seg) <= ARCHIVE_SEGMENT_MAX, `归档段 ${charCount(seg)} 字 > ${ARCHIVE_SEGMENT_MAX}`);
        }
      });
    },
  },
];
