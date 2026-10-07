// 28 天无头驱动 —— Phase 1 的验收装置
//
// 「玩家策略」故意写得很笨（能排就排、档 A 就点第一个选项、奇数日把时间拨光）：
// 这一阶段要验的是**规则层不崩、管线在动**，不是"策略好不好"。
//
// ⚠️ **首轮冒烟暴露的方法论坑（必须留住）**：
//   v1 夹具只产档 B、无恢复通道 ⇒ 唯一被派的 npc001 连吃两个失败后 `SAN ≤ 1` 永久不可派遣，
//   于是"40 条事件只处理了 6~9 条、档 A 弹窗 0 个、`X` 从第 6 天钉死在 4"。
//   **但不变式全过、单测全绿。** 这就是 Phase 0 那句「没测到 ⇒ 被测成 测到了」。
//   ⇒ 光有"不变式"（不越界）不够，必须再加一组**覆盖率断言**（管线真的在动）。
//
// ⚠️ 2026-09-18 时钟模型改造后的循环形状：
//   每天 = **恢复**（医馆 / 大神殿：占被治疗者 2 点容量）→ **排布**（不推进时间）
//        → **拨时针**（B，消耗当天剩余时间）→ **进下一天**（C）。
//   揭晓**不是一轮"阶段"**，而是时间推进的副作用 —— 所以循环里看不到"揭晓"这一步，
//   只能看到 `dial` / `nextDay` 的返回值里带出的 `revealed`。
//
// ⚠️ 2026-09-18（Phase 2）全线 async：排布路径要 await 两次 LLM 调用。
//    `simulate` 因此返回 Promise；默认仍走**假 brain**，离线、不花钱。
//
// ⚠️ 2026-09-19：生成半接上了**落地层**（`turn/land-compose.ts`）——夹具吐原始形状、
//    `enterDay` 负责落地 ⇒ 本驱动跑的已经是**真链路**（编号改写 / 枚举收口 / 条数硬顶 / 种子核销）。
//    新增两处覆盖率的落点：**档 A 的 `trigger` 唤醒隐藏事件**、以及 `events.hidden` 的进出。
//
// ⚠️ 2026-09-19（P4-A 出口）：本驱动第一次**有出口** ——
//    · **每一次结算之后**都过一遍逐次检查（总表 1~4）：命中即"中途暴毙"，**当场停手**；
//    · **第 28 天**放格子 → 判定（总表 5~7 ＋ 成功），结局写进 `ledger.ending`。
//    在此之前它跑到第 28 天只会打印表格就停 —— 而 Phase 4 的验收标准是"触达全部 11 种结局"。
import { initialLedger } from '../ledger/initial.ts';
import { applyDelta, commitBatch } from '../ledger/apply.ts';
import { emptyBatch } from '../ledger/batch.ts';
import { PLAYER_ID, isAvailable, type GameEvent, type Ledger, type Person, type Placements } from '../ledger/types.ts';
import { REP_KEYS } from '../contract/types.ts';
import { effectiveAttrsOf } from '../rules/ability.ts';
import { remainingToday, TOTAL_DAYS } from '../rules/clock.ts';
import { instantEndingOf, isFinalDay } from '../rules/ending.ts';
import { evalGates } from '../rules/gates.ts';
import { makeRng, type Rng } from '../rules/rng.ts';
import { PROLOGUE_TOTAL, prologueSummaryLines } from '../rules/prologue.ts';
import { BASE_ACTION_POINTS, calcX } from '../rules/x.ts';
import { fakeBrain } from '../fixtures/fake.ts';
import type { Brain } from './brain.ts';
import { createEvent } from './create.ts';
import { closeGame, terminateIfOver, writeEnding } from './ending.ts';
import { handleEvent } from './handle.ts';
import { landCompose } from './land-compose.ts';
import { choosePopup } from './popup.ts';
import {
  afterPrologueCard,
  driveOpening,
  isPrologueEventId,
  prologuePending,
  prologueRng,
  startPrologue,
} from './prologue.ts';
import { enterDay, turnOver } from './t0.ts';
import { DEFAULT_CHOICE, type OpeningChoice } from './opening.ts';
import { restore, RESTORE_MAX_PEOPLE, RESTORE_SPEC, type RestorePlace } from './restore.ts';
import { dial, nextDay } from './time.ts';

export interface DaySnapshot {
  day: number;
  chapter: number;
  gold: number;
  desire: number;
  hp: number;
  san: number;
  x: number;
  /** 当天排布了几条 */
  arrangedToday: number;
  popupsToday: number;
  /** 当天拨了几点时间 */
  dialedToday: number;
  /** 排布完、等时间走到点的条数 */
  awaiting: number;
  /** 当天新生成、还没排布的条数 */
  todo: number;
  /** **藏在 `events.hidden` 里、等 `trigger` 唤醒的条数**（落地层放进去的） */
  hidden: number;
  live: number;
}

export interface CoverageCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SimResult {
  ledger: Ledger;
  snapshots: DaySnapshot[];
  /** 硬不变式（越界即违规） */
  violations: string[];
  /** 覆盖率断言（**管线必须真的在动** —— 失败同样计入违规） */
  coverage: CoverageCheck[];
  stats: {
    /**
     * 序幕点掉了几条档 A（**走满序幕应为 10**；`SimOptions.skipPrologue` ⇒ 0）。
     * ⚠️ 它与正文的 `popups` **分开计**：序幕那 10 条是"展示期的固定文案"，
     *    把它们算进正文吞吐会让「管线吞吐 ≥ 28」这条覆盖率**白送 10 次**。
     */
    prologuePopups: number;
    arranged: number;
    popups: number;
    created: number;
    /**
     * **玩家自建**（「创建事件」）产出的条数。
     * ⚠️ 它与 `created`（T0 生成半）**分开计**：两者走的是**同一个 function**
     *    （`compose_day`）、同一个落地层，但一个是系统按日程编排的、一个是玩家自己敲的 ——
     *    混在一起之后，"这一局的吞吐到底是谁贡献的"就彻底看不出来了。
     */
    createdByPlayer: number;
    revealed: number;
    expired: number;
    /** 医馆 / 大神殿一共治了多少人次 */
    restored: number;
    dials: number;
    dialedPoints: number;
    daysEntered: number;
    /** 档 A 的 `trigger` 唤醒过几次隐藏事件（= 子事件从 `hidden` 搬进 `live`） */
    triggered: number;
    /** `chapter_shift` 落账过几次（占卜日第 1 / 8 / 15 / 22 天 · 走满 28 天应为 4） */
    divinations: number;
    /**
     * `archive` 落账过几次（章首超软顶 / 越硬顶）。
     * ⚠️ **标准 28 天恒为 0** —— 阈值放宽是用户 2026-09-22 的裁定（压缩会减损信息量）；
     *    这条链路要靠 `SimOptions.driveArchive` 明着走一遍，见那里的说明。
     */
    archives: number;
    /**
     * `ending` 被调过几次（**成功结局**才调 · 全局至多 1 次）。
     * ⚠️ **基线种子恒为 0** —— 三种子第 28 天的欲念（61 / 64 / 65）全在判定窗口 [75, 80]
     *    之外 ⇒ 判出来的都是**失败**结局（七条预写话术、**0 调用**）。
     *    这条链路要靠 `SimOptions.driveEnding` 明着走一遍，见那里的说明。
     */
    endings: number;
    idleDays: number[];
  };
}

function countStatus(l: Ledger, status: string): number {
  return l.events.live.filter((e) => e.status === status).length;
}

/**
 * 笨策略的档 A 动作：**恒点第 0 个选项**（`options[0]`）。
 *
 * ⚠️ **2026-09-21 起只是 `turn/popup.ts·choosePopup` 的一个薄壳** —— 规则侧不再有第二份实现。
 *    此前这里自己写了一遍"落 `delta` / 记 `summary` / 唤醒 `trigger`"，
 *    而 UI 要的是"**玩家自己挑**"（`choosePopup(…, optionIndex)`）：
 *    两处各维护一遍 ⇒ 迟早漂移（金币口径、触发血统、欲向落账）。
 *    `deadline` 那个坑（同一件事两处实现、一处忘了改）在这个项目里已经出过不止一次。
 * ⚠️ 为什么驱动恒点第 0 个：夹具把 `trigger` **只挂在第一个选项上**（`fixtures/fake.ts`），
 *    于是"父指子、点选才现身"这条支路**每天都有约一半概率被走到**，不靠运气。
 * ⚠️ **这里的 `log` 被丢掉**（笨策略只数条数，不看文案；要看文案的是 UI 侧）。
 *    调用点拿的是刚筛出来的**待处理档 A** ⇒ `rejected` 那条分支在这里不可达；
 *    真有结构性错误时 `choosePopup` 照样会**收口落账**，只是这一层不念它。
 */
function clickPopup(l: Ledger, eventId: string): { ledger: Ledger; triggered: string[] } {
  const r = choosePopup(l, eventId, 0);
  return { ledger: r.ledger, triggered: r.triggered };
}

function scoreOf(l: Ledger, p: Person, keys: readonly string[]): number {
  const eff = effectiveAttrsOf(l, p);
  let s = 0;
  for (const k of keys) s += eff[k as keyof typeof eff] ?? 0;
  return s;
}

/**
 * 笨策略的"这条派谁去做"：
 *   ① 有可用下属、且**容量够**（单日：剩余 ≥ 时长；跨天：至少还能启程）⇒ 挑最相关属性最高的；
 *   ② 否则退**档 C 玩家亲自**（不占下属容量，但要玩家今天还有时间读数）；
 *   ③ 都不行 ⇒ 这条今天放弃。
 *
 * ⚠️ **`dispatchable` 是玩家看得见的牌面**（UI 直接渲染这个字段）⇒ 笨策略也照牌办事：
 *    「仅亲自」不给人派、「仅派遣」玩家去不了。**不照牌办事会让闸门 ③ 天天拦人、制造空转日**——
 *    那是把"策略蠢"错算成"系统坏"。闸门本身对不对，由 `ledger.test.ts`「闸门 9 条」的定点用例负责。
 *
 * `forceSelf` = **覆盖率驱动**：跳过 ① 直接走 ②。笨策略只在"下属全被占满"时才亲自上，
 * 那是运气 —— 实测 seed=7 全程没轮到，`handler === npc000` 这条覆盖率**假绿**。
 * 与其放宽断言，不如把这条路径明着走一遍（见主循环 ⓪.6）。
 */
function pickArrangeable(
  l: Ledger,
  cands: GameEvent[],
  selfToday: number,
  forceSelf = false,
): { ev: GameEvent; parts: string[] } | null {
  const singleDayOf = (ev: GameEvent): boolean => ev.cost <= BASE_ACTION_POINTS;
  for (const ev of cands) {
    const need = Math.max(ev.min_people, 1);
    const canDispatch = ev.dispatchable !== '仅亲自';
    const canSelf = ev.dispatchable !== '仅派遣';
    // `forceSelf` 只对"能亲自"的事件生效 —— 否则「仅派遣」这条会被跳过分派、又亲自不了，
    // 直接落进 `return null`，把一天白扔掉。
    if (canDispatch && (!forceSelf || !canSelf)) {
      const okSubs = l.entities.people
        .filter((p) => p.id !== PLAYER_ID && isAvailable(p, l, l.clock.day))
        .filter((p) => {
          const left = l.actionPoints.byNpc[p.id] ?? BASE_ACTION_POINTS;
          return singleDayOf(ev) ? left >= ev.cost : left > 0;
        });
      if (okSubs.length >= need) {
        const keys: readonly string[] = ev.hint_attr.length > 0 ? ev.hint_attr : ['智慧'];
        const ranked = okSubs
          .map((p) => ({ p, score: scoreOf(l, p, keys) }))
          .sort((a, b) => b.score - a.score || (a.p.id < b.p.id ? -1 : 1));
        return { ev, parts: ranked.slice(0, need).map((x) => x.p.id) };
      }
    }
    // 档 C「亲自」：闸门 ③ 对玩家不检查"可派遣"；但闸门 ① 要求今天还有时间读数。
    // ⚠️ 每天最多亲自排 2 条：不设上限的话，笨策略会把所有事件都推给玩家自己，
    //    于是"派遣"这条路径反而测不到（又是一个"绿了但没测到"）。
    if (canSelf && selfToday < 2 && remainingToday(l) > 0 && ev.min_people <= 1) {
      return { ev, parts: [PLAYER_ID] };
    }
  }
  return null;
}

/**
 * 恢复：把「今日**无法活动**」（HP = 1 / SAN = 1）的下属送去医馆 / 大神殿。
 *
 * 《规则.md》§二 地点：这两个是**纯功能入口** —— 不进事件池、不经 `settle`、**提交即落账**；
 * 点数与诊金照 `RESTORE_SPEC`（2026-10-07 新口径：医馆 1 金 3 点 · 神殿 3 金 2 点 · 每次 1 人）。
 * 笨策略只做一件事：谁掉到 1（= 不可派遣）就掏钱拉回来。
 * ⚠️ 它顶替了夹具里那条已被删除的"休养类事件"替身 —— 真实系统里恢复**不是事件**。
 */
async function tendWounded(l: Ledger, rng: Rng, brain: Brain): Promise<{ ledger: Ledger; treated: number }> {
  let cur = l;
  let treated = 0;
  for (const place of ['医馆', '大神殿'] as RestorePlace[]) {
    const spec = RESTORE_SPEC[place];
    const cands = cur.entities.people.filter(
      (p) =>
        p.affiliated &&
        p.id !== PLAYER_ID &&
        p[spec.field] === 1 && // = 0 是死亡 / 永久疯狂，治不了
        (cur.actionPoints.byNpc[p.id] ?? BASE_ACTION_POINTS) >= spec.points,
    );
    for (let i = 0; i < cands.length; i += RESTORE_MAX_PEOPLE) {
      const group = cands.slice(i, i + RESTORE_MAX_PEOPLE);
      const afford = Math.floor(cur.scalars.gold / spec.goldPerPerson);
      const take = group.slice(0, Math.max(0, Math.min(group.length, afford)));
      if (take.length === 0) break;
      const r = await restore(cur, { place, targets: take.map((p) => p.id) }, rng, brain);
      if (r.rejected.length > 0) break;
      cur = r.ledger;
      treated += take.length;
    }
  }
  return { ledger: cur, treated };
}

/**
 * **每一次结算之后**的逐次检查（总表 1~4）—— 命中即"中途暴毙"。
 *
 * 命中 ⇒ 返回**带 `ending` 的账本**；未命中 ⇒ **原样返回**
 * （`terminateIfOver` 未命中时零克隆、零分配 ⇒ 挂到每一次结算之后也不心疼）。
 */
function afterSettle(cur: Ledger): Ledger {
  return terminateIfOver(cur) ?? cur;
}

export interface PlacementPools {
  成果: string[];
  手段: string[];
  共鸣: string[];
}

/**
 * 放格子的**三个候选池**：
 *   成果 = 自己的物品 · 手段 = 已记的事件 · 共鸣 = 给过认可的人
 *
 * ⚠️ **这是全项目唯一一处口径** —— `autoPlace`（无头驱动）与 UI 的候选池都读它。
 *    2026-09-21 之前 UI 侧自己写了一份：成果 = **全部**物品（连佩在身上的短匕首都能放上格）、
 *    共鸣 = **全部**人物。同一个"候选池"两处实现、两处口径 —— 本项目反复踩过的坑。
 *
 * ⚠️「自己的物品」取**宽口径**：`holder === 玩家` **或** `holder === null`
 *    （后者 = 还没交到谁手上、仍留在账本里 —— 账本本来就是他的）。
 *    判据设计文档没写死 ⇒ 仍是**待裁定项**；判定本身（`成果格空 ⇒ 空手`）与这条口径无关。
 */
export function placementPools(l: Ledger): PlacementPools {
  return {
    成果: l.entities.items
      .filter((i) => !i.consumed && (i.holder === PLAYER_ID || i.holder === null))
      .map((i) => i.id),
    手段: l.events.live.filter((e) => e.status === '已结算').map((e) => e.id),
    共鸣: l.entities.people.filter((p) => p.id !== PLAYER_ID && p.recognized.length > 0).map((p) => p.id),
  };
}

/**
 * 笨策略的"**放格子**"（第 28 天）：三格各从**候选池**里挑一件，挑不到就留空。
 *
 * ⚠️ 三格**各自独立**：手段 / 共鸣 挑不到就留空 —— 它们只决定成功结局的风味，**不参与通关**。
 * ⚠️ **导出仅为单测**（三格候选池的取舍是判据，不是实现细节）。
 */
export function autoPlace(l: Ledger): Placements {
  const pool = placementPools(l);
  return {
    成果: pool.成果[0] ?? null,
    // 手段取**最后一条**已结算 —— "他最后走的那条路"，与 UI 的默认选中一致
    手段: pool.手段.length > 0 ? pool.手段[pool.手段.length - 1] : null,
    共鸣: pool.共鸣[0] ?? null,
  };
}

// ── 序幕的两件东西（随机流 ＋ 翻牌）搬去了 `turn/prologue.ts`（2026-09-19 序幕落地时）──
//
// ⚠️ 为什么搬：序幕不是"驱动的一个动作"，它已经是**一整套流程**（铺一条 → 玩家点 → 再铺一条 →
//    末条翻牌 → 进第 1 天）。`driveOpening` 与它的专用随机流留在驱动文件里，
//    就等于让 `ui/session.ts` 从"无头驱动"里 import 业务逻辑 —— 而序幕引擎的归属地是
//    `turn/prologue.ts`（写入侧）。
// ⚠️ **这里保留 re-export**：`test/initial.test.ts` 一直从本文件拿 `driveOpening`，
//    改 import 路径是纯粹的搬运噪音。谱系上它现在只有一处实现（`turn/prologue.ts`）。
export { driveOpening, prologueRng } from './prologue.ts';

/**
 * 驱动开关 —— **默认全关**：基线种子（1 / 7 / 42）跑的必须是"没被额外推一把"的局。
 */
export interface SimOptions {
  /**
   * **跳过序幕**（`day 0` 的 10 条档 A）—— 默认**不跳过**。
   *
   * ⚠️ 默认跑序幕，与 UI **同构**：序幕是真实开局的一部分，跳过它跑出来的就是
   *    "从没翻过牌的三王子"（六维全 5 / 命题为空 / 无原卡）—— 那正是 P4-C 之前的样子。
   * ⚠️ 序幕**不碰正文那条 `rng`**（翻牌走 `prologueRng`）⇒ 跑不跑它，28 天的轨迹一模一样；
   *    差别只在账本里多 10 条 `已结算` 的档 A 与 9 条 `day = 0` 的固定概要。
   *    ⚠️ **事件号不算差异**：`e1`~`e10` 由 `initialLedger()` 在开局就订走了
   *      （`ledger/ids.ts·initialWatermark`）⇒ 两条路的正文第一条生成事件都是 `e11`。
   * ⚠️ 用它来"隔离变量"的场合：只想验正文、或想拿一份与 P4-D 之前**逐字可比**的账本。
   */
  skipPrologue?: boolean;

  /**
   * **玩家的两项选择**（欲望原型下标 ＋ 点亮的优势属性）—— **无头驱动专用**。
   *
   * ⚠️ **2026-10-05 用户裁定：欲望与六维都改成玩家自己挑**（`rules/desire-kits.ts`）。
   *    UI 侧真让玩家点，模拟器没人点 ⇒ 走 `DEFAULT_CHOICE`。
   *    ⚠️ **它必须是 `const` 的一条确定值，不能从 `rng` 抽** —— 一条"由 seed 派生"的
   *    欲望会让"换种子换一局"与"换种子只换事件流"两件事纠缠在一起，
   *    基线种子就再也对比不出差异了。⚠️ 想要不同基线跑不同欲望，走 `choice` 显式传参。
   */
  choice?: OpeningChoice;

  /**
   * **中途暴毙驱动**（总表 1~4 · 覆盖率专用）。
   *
   * ⚠️ 夹具**造不出**这个局面：顶栏假设 ② 明写"伤害不把人打到 0 —— 夹具不制造永久减员"，
   *    而实测三个基线种子**都不提前终结** ⇒ 若把「逐次终结被走到」无条件写成覆盖率断言，
   *    它就是一条**永远假绿**的断言（**断言存在 ≠ 路径被走到**）。
   *    ⇒ 与 `forceSelf` / `neglected` 同族：**明着走一遍**。
   * ⚠️ 代价：这一局会**提前结束**，"28 天级"的那几条覆盖率由 `endedEarly` 放行 ——
   *    所以它**只该在专用用例里打开**，绝不加进基线种子。（变异测试 M3 已实测：基线三种子上
   *    关掉逐次检查，一条都不会红 —— 那正是"没测到"。）
   * ⚠️ **这一行属性声明此前**只有注释、没有它**（2026-09-19 补）：`opts.driveInstantEnding`
   *    在下面照常用、`ending.test.ts` 照常传 —— **靠 Node 只做 type stripping 才没报错**。
   *    这正是本仓记录过的风险（"strip-only 不做类型检查"）；同样的漏法落到 `keyof Ledger`
   *    上就会**静默少一条**。
   */
  driveInstantEnding?: boolean;

  /**
   * **概要归并驱动**（`archive` 侧链 · 覆盖率专用）。
   *
   * ⚠️ 夹具与真实规模**都**造不出这个局面：用户 2026-09-22 裁定「放宽标准」（压缩会减损信息量）
   *    ⇒ `archive` 的两个阈值保持文档原值（软 2000 / 硬 5000 字），而 28 天约 39 次结算
   *    ⇒ 章首时逐条区只有**数百字** ⇒ **一次都不会触发**。
   *    若把「概要归并被走到」无条件写成覆盖率断言，它就是一条**永远假绿**的断言
   *    （**断言存在 ≠ 路径被走到** —— 这个项目已经栽过三次）。
   *    ⇒ 与 `driveInstantEnding` / `forceSelf` / `neglected` 同族：**明着走一遍**。
   * ⚠️ 它**只撑长一条概要**（不新增天、不伪造归档段）—— 触发判据仍由
   *    `rules/archive.ts·planArchive` 自己算 ⇒ 测的是**真链路**。
   */
  driveArchive?: boolean;

  /**
   * **成功结局驱动**（`ending` 侧链 · 覆盖率专用）。
   *
   * ⚠️ 夹具与真实规模**都**造不出这个局面：三个基线种子第 28 天的欲念是 61 / 64 / 65，
   *    **全在判定窗口 [75, 80] 之外** ⇒ 判出来的都是失败结局（`ending` **0 调用**）。
   *    若把「成功结局话术被走到」无条件写成覆盖率断言，它就是一条**永远假绿**的断言
   *    （**断言存在 ≠ 路径被走到** —— 这个项目已经栽过三次）。
   *    ⇒ 与 `driveInstantEnding` / `driveArchive` / `forceSelf` 同族：**明着走一遍**。
   * ⚠️ 它**只把欲念塞进窗口**（第 28 天、放格子之前），其余一步不动 ——
   *    判据仍由 `rules/ending.ts·finalEndingOf` 自己算（成果格那一把钥匙照旧要看
   *    `autoPlace` 挑出来的实物）⇒ 测的是**真链路**，不是"绕过判定硬写一个成功"。
   */
  driveEnding?: boolean;

  /**
   * **硬种子 checkpoint 驱动**（覆盖率专用）。
   *
   * ⚠️ 夹具与真实规模**都**造不出这个局面：实测三个基线种子第 28 天的声望终值是
   *    `善0 恶0 侠5 怪5 权5` / `善0 恶0 侠3 怪8 权5` / `善0 恶0 侠5 怪7 权5`
   *    —— **峰值 8，一个门槛（10 / 15 / 20）都没碰到**。夹具的 `rep` 变化只有
   *    「大成功 侠名 +1」与「混键 op 怪名 +1」，28 天根本攒不到 10。
   *    若把「硬种子 checkpoint 被走到」无条件写成覆盖率断言，它就是一条**永远假绿**的
   *    断言（**断言存在 ≠ 路径被走到** —— 这个项目已经栽过三次）。
   *    ⇒ 与 `driveInstantEnding` / `driveArchive` / `driveEnding` / `forceSelf` 同族：**明着走一遍**。
   * ⚠️ 它**不伪造种子**：只把 `善名` 预置到 9（差 1 分到门槛），再走**真实的一次声望 batch**
   *    （`applyDelta` → `commitBatch`）把它推过 10 ⇒ 判据仍由 `rules/checkpoint.ts·
   *    crossedCheckpoints` 自己算、种子仍由 `commitBatch` 正式出。
   *    这与 `driveEnding` 把欲念预置成 77 是同一个套路（"预置输入，让真判据自己命中"）。
   * ⚠️ 它**不改轨迹**：`rep` 不参与判定（欲念窗口 / 成果格 / HP·SAN），
   *    也不消耗 `rng` ⇒ 其余覆盖率与结局一个都不动。
   */
  driveCheckpoint?: boolean;

  /**
   * **玩家自建驱动**（「创建事件」· 覆盖率专用）。
   *
   * ⚠️ 夹具**不会自己去敲那句话** —— 笨策略是一个"看到待办就派人"的循环，
   *    而自建恰恰是"玩家主动开口"的那条路，模拟器里没有"意志"这个东西。
   *    ⇒ 若把「玩家自建被走到」无条件写成覆盖率断言，它就是一条**永远假绿**的断言
   *    （**断言存在 ≠ 路径被走到** —— 这个项目已经栽过三次）。
   *    ⇒ 与 `driveInstantEnding` / `driveArchive` / `driveEnding` / `driveCheckpoint` 同族：**明着走一遍**。
   * ⚠️ 它插在当天**排布之前**（第 4 天），所以那一条当天就会被挑去办 ⇒
   *    「一句话 ⇒ 1 条 `canvas_event` ⇒ 进池 ⇒ 被排布」整条链路**一次走完**，
   *    而不是"造出来了但没人碰过"。
   * ⚠️ 它**不消耗时间**（自建不扣 `usedToday`，见 `turn/create.ts`）⇒
   *    对后续拨时针 / 换日没有挤压；但它会**多出一条待办**（吞吐 +1），
   *    所以只该在专用用例里打开。
   */
  driveCreate?: boolean;

  /**
   * **「非他不可」驱动**（`required_person` · 覆盖率专用）。
   *
   * ⚠️ 夹具 brain（`fakeComposeDay`）**不产**这个字段 —— 这是**刻意的**：改夹具的随机池会让
   *    「3 种子收口 61 / 64 / 65」这条基线跟着漂。代价是**标准 28 天里该字段恒空**，
   *    那个字段**端到端一次都没被走过**（单测只证明了"三个函数各自认它"）。
   *    这正是本项目吃过两次亏的形状：`dispatchable` 曾经只写在 schema 里、规则层一行没读
   *    ——**字段写进 schema ≠ 有人读它**。⇒ 与 `driveArchive` / `driveCreate` 同族：**明着走一遍**。
   *
   * ⚠️ 三处都走**真函数**，没有一处"绕过判据硬写结果"：
   *    ① `landCompose`（真落地层：编号改写 / 归一化 / 认实体表 / 入池）；
   *    ② `evalGates`（真闸门 ③：先证明"不含他 ⇒ 拦"，再证明"含他 ⇒ 放行"）；
   *    ③ `handleEvent`（真结算链路：真的办过一次）。
   * ⚠️ 它**只多出一条事件**（第 `DRIVE_REQUIRED_DAY` 天）⇒ 只该在专用用例里打开。
   */
  driveRequiredPerson?: boolean;
}

/** 暴毙驱动日 —— 与另两条驱动日错开，互不遮蔽 */
export const DRIVE_BREAK_DAY = 12;

/** 概要归并驱动日 —— 章首（第 8 天）的前夜；撑完这一天，第 8 天 T0 自然触发归并 */
export const DRIVE_ARCHIVE_DAY = 7;
/** 撑长用的填充重复次数 —— 目标是让逐条区 **> `ARCHIVE_SOFT_LIMIT`（2000 字）**。
 *  ⚠️ 实测口径：到第 7 天，逐条区本来只有数百字（28 天约 39 次结算）⇒ 填 2500 才稳稳越顶。 */
export const DRIVE_ARCHIVE_PAD = 2500;

/**
 * 成功结局驱动：第 28 天、放格子**之前**把欲念放进判定窗口 —— 取窗口中点，
 * 两端各留 2 点余量（`DESIRE_WINDOW_MIN = 75` / `MAX = 80`）。
 * ⚠️ 写 77 而不是 75 / 80：那两个端点是**边界用例**，由 `ending.test.ts` 定点钉住；
 *    这里要的是"稳稳判成成功"，别把两种目的混在一处。
 */
export const DRIVE_ENDING_DESIRE = 77;

/** 硬种子 checkpoint 驱动：第几天动手（与暴毙 12 / 归并 7 错开；留足后续 T0 去承接它） */
export const DRIVE_CHECKPOINT_DAY = 5;

/**
 * 玩家自建驱动：第几天动手。
 * ⚠️ 与 checkpoint(5) / 归并(7) / 暴毙(12) 全部错开 —— 四个驱动的读数互不遮蔽。
 *    选第 4 天是因为它**足够早**（当天还有人力办这条新事件，链路才走得完），
 *    又**足够晚**（第 3 天起 `forceSelf` 才会强制走玩家亲自那一路，别在同一挤在一起）。
 */
export const DRIVE_CREATE_DAY = 4;

/**
 * 玩家自建驱动用的那句话 —— **故意写成"打算怎么做"**（而不是"我已经做到了"）：
 * 那句【边界】（「若他写成'我做到了 XX'，按'他要去争取 XX'来写」）要有一个
 * 不踩它的基线样例。真 LLM 怎么处理越界写法由 prompt 承担，夹具只走合法那一路。
 */
export const DRIVE_CREATE_WORD = '我想去城郊替我母亲立一块碑';
/** 驱动时把 `善名` 预置到这个值 —— **差 1 分**到门槛 10（端点上的 `>=` 就是靠这个测的） */
export const DRIVE_CHECKPOINT_BEFORE = 9;
/** 驱动施加的那一次声望变化 */
export const DRIVE_CHECKPOINT_DELTA = 1;

/**
 * 「非他不可」驱动：第几天动手。
 * ⚠️ 与其它四个驱动全部错开（自建 4 / checkpoint 5 / 归并 7 / 暴毙 12）。
 *    选第 10 天：足够晚（已入队的人多、可选面大），又留足后续天数去承接它。
 */
export const DRIVE_REQUIRED_DAY = 10;

export async function simulate(
  seed: number,
  days = TOTAL_DAYS,
  opts: SimOptions = {},
  /**
   * ⚠️ **2026-09-20 起可注入**（此前这里硬写 `fakeBrain()`）——
   * 于是「真模型跑满 28 天」这件事**根本没有入口**：`--live` 只跑一条事件（`runSlice`），
   * 而 P6-A 标定要看的恰恰是**整局的欲念曲线**。
   * 默认仍是 `fakeBrain()` ⇒ 老调用点一行不改，离线基线照旧零成本、可重复。
   */
  brainIn?: Brain,
): Promise<SimResult> {
  const rng: Rng = makeRng(seed);
  const brain: Brain = brainIn ?? fakeBrain();
  let l = initialLedger();

  const snapshots: DaySnapshot[] = [];
  const violations: string[] = [];
  const stats: SimResult['stats'] = {
    prologuePopups: 0,
    arranged: 0,
    popups: 0,
    created: 0,
    createdByPlayer: 0,
    revealed: 0,
    expired: 0,
    restored: 0,
    dials: 0,
    dialedPoints: 0,
    daysEntered: 0,
    triggered: 0,
    divinations: 0,
    archives: 0,
    endings: 0,
    idleDays: [],
  };

  /** 故意"撒手"的事件 id（见下面 ⓪.5）—— 它会一直留在「待处理」，直到过期结算把它收走 */
  const neglected = new Set<string>();

  /**
   * 覆盖率驱动：**档 C（玩家亲自）**有没有真的走过。
   *
   * ⚠️ 笨策略的 ② 分支只在"有事件、但下属一个都派不动"时才轮到玩家 —— 这是**运气**，不是设计。
   *    实测 seed=7 全程没轮到，而 `handler === npc000` 这条覆盖率**照样是绿的**（它查的是终局账本，
   *    而 seed=1 / 42 恰好自己走到了）。**这就是"绿了但没测到"的第二次现身**：断言存在 ≠ 路径被走到。
   *    ⇒ 与其放宽断言，不如把这条路**明着走一遍**：第 3 天起，第一次排布强制走玩家亲自。
   */
  let selfDone = false;

  /**
   * 硬种子 checkpoint 驱动（`SimOptions.driveCheckpoint`）**实际出过**的门槛读数。
   * ⚠️ 取 `commitBatch` 的**结构返回值**（`CommitReport.checkpoints`），不去 `report` 里
   *    grep 那句人话 —— 文案一改就会静默失配。
   */
  const drivenCheckpoints: string[] = [];

  /**
   * 玩家自建驱动（`SimOptions.driveCreate`）**实际落进事件池**的那几条 id。
   * ⚠️ 覆盖率判据要用它证明"这条**真的被办过**"（`handler` / `started_at` 有值）——
   *    只证明"落进了池子"太弱：落地成功但当天没人派它，玩家实际上还是什么都没得到，
   *    而那看起来和"链路通了"一模一样。
   */
  const drivenCreateIds: string[] = [];

  /**
   * 「非他不可」驱动（`SimOptions.driveRequiredPerson`）的**实际读数**。
   * ⚠️ 覆盖率要**逐段**证明这条链 —— 任何一段缺失，都可能是"只写进 schema、没人读"那种假机制：
   *    字段落进账本 → 闸门 ③ 对"不含他"拦下 → 对"含他"放行 → 事件**真的被办过**。
   */
  const drivenRequired = {
    him: '',
    landedId: '',
    landedField: '',
    notIncludedPass: null as boolean | null,
    includedPass: null as boolean | null,
    notIncludedReason: '',
  };

  // ── 序幕：day 0（显示「Day 0」）· 10 条档 A 逐条点掉──
  //    ⚠️ 与 UI **走同一条路**（`startPrologue` → 逐条 `clickPopup` → `afterPrologueCard`）：
  //       两处若不同构，"试验台试出来的手感"与"标定用的 28 天"就不是同一局了。
  //    ⚠️ 牌走 `prologueRng(seed)`（序幕专用流）—— 伸进正文那条 `rng` 会把 28 天基线整体挪位。
  //    ⚠️ 一幕**一次只有一条待处理**（`advancePrologue` 的结构保证）⇒ 下面挑出来的就是
  //       "当前该读的那一条"；笨策略照旧恒点第 0 个选项（覆盖率的需要，不是玩法）。
  //    ⚠️ **序幕不推进时钟**：它停在 `day 0`，十条点完才 `turnOver` 进第 1 天。
  //       若让序幕也走 A/B/C，`toAbs(t) = day*4 + used` 会当场把整局跳到第 1 天。
  const pRng = prologueRng(seed);
  // ⚠️ **玩家的选择**：UI 让玩家点，模拟器走这一条确定的默认值（理由见 `SimOptions.choice`）
  const choice = opts.choice ?? DEFAULT_CHOICE;
  if (opts.skipPrologue) {
    // ⚠️ 跳过序幕 ⇒ 退回 P4-D 之前的行为：明着开一次局，否则跑的是"从没定下欲望的三王子"
    l = (await driveOpening(l, brain, choice)).ledger;
  } else {
    l = startPrologue(l).ledger;
    while (prologuePending(l) > 0) {
      const card = l.events.live.find((e) => isPrologueEventId(e.id) && e.status === '待处理')!;
      const r = clickPopup(l, card.id);
      l = afterSettle(r.ledger);
      stats.prologuePopups += 1;
      // 点完一条 ⇒ 铺下一条；末条 ⇒ 开局（**唯一**编排入口，见 `turn/prologue.ts`）
      const nxt = await afterPrologueCard(l, card.id, brain, choice);
      l = afterSettle(nxt.ledger);
      if (l.ending) break;
    }
  }

  // ── 开场：序幕 → 第 1 天，并生成第一天的事件（走 `enterDay` ⇒ 含落地层）──
  l = structuredClone(l);
  turnOver(l);
  {
    // ⚠️ `seed` **必须**传进去：`enterDay` 用它派生**占卜那条独立随机流**
    //    （`divinationRng(seed, day)`）—— 不传就一律走默认 0 ⇒ 三个基线种子
    //    会抽到**同一副**占卜牌，「换种子换一局」当场失效。
    const e = await enterDay(l, rng, brain, seed);
    l = afterSettle(e.ledger);
    stats.created += e.created.length;
    if (e.divination) stats.divinations += 1;
    if (e.archived) stats.archives += 1;
    stats.daysEntered += 1;
  }

  for (let d = 1; d <= days; d++) {
    // ⚠️ 上一轮结算之后已经终结 ⇒ **立刻停手**：不再拨时间、不再进下一天。
    //    这正是《规则.md·终局》「中途暴毙不等第 28 天」的落地点。
    if (l.ending) break;
    const dayAtStart = l.clock.day;
    let arrangedToday = 0;
    let popupsToday = 0;
    let dialedToday = 0;

    // ── ⓪.5 撒手 ── **故意**挑一条不处理，让它自然过期 ──
    //    ⚠️ 这是覆盖率的硬需要，不是奇观：夹具的笨策略只要还有人可派、当天就会把事件池清空
    //    ⇒「过期结算」这条路**永远走不到**（本轮实测：`过期 0 / 新生成 47`，一路绿到底 ——
    //      又一个"绿了但没测到"）。记进跨天的 `neglected` ⇒ 它会被一直放着，直到真的过期。
    //    ⚠️ **只撒手档 B/C，绝不撒手档 A**：档 A 是强制弹窗，不清掉就别想处理别的事（闸门 ④）——
    //      实测漏了这条会把吞吐从 47 打到 11、并造出一串空转日。
    //    一次只挂一条：太多会把"略过率 < 50%"那条覆盖率顶穿。
    for (const id of [...neglected]) {
      const still = l.events.live.find((x) => x.id === id);
      if (!still || still.status !== '待处理') neglected.delete(id);
    }
    //    ⚠️ **至少留 2 条才撒手**：撒手是"把这一条从今天的待办里摘掉"，若它恰好是当天唯一可做的，
    //      这一天就会**空转**（实测 seed=7 的 12/18/24、seed=42 的 24）——
    //      覆盖率驱动自己把另一条覆盖率顶穿，这是本末倒置。
    if (d % 3 === 0 && neglected.size === 0) {
      const todoNow = l.events.live.filter((e) => e.status === '待处理' && e.tier !== 'A');
      if (todoNow.length >= 2) neglected.add(todoNow[todoNow.length - 1].id);
    }

    // ── ⓪ 恢复──
    //    ⚠️ 放在排布**之前**：HP / SAN = 1 的人**连派遣都不行**，先拉回来他才接得到活。
    const tended = await tendWounded(l, rng, brain);
    l = tended.ledger;
    stats.restored += tended.treated;

    // ── ⓪.6 玩家自建驱动（**仅专用用例打开** · 见 `SimOptions.driveCreate`）──
    //    插在 ① **之前**：自建那条当天就会被笨策略挑去办 ⇒
    //    「一句话 ⇒ 条 `canvas_event` ⇒ 进池 ⇒ 被排布」整条链路一次走完。
    //    ⚠️ 它**不消耗时间**（设计口径：提名目不花时间，办它才花）⇒ 不挤压后续拨时针。
    if (opts.driveCreate && d === DRIVE_CREATE_DAY) {
      const r = await createEvent(l, DRIVE_CREATE_WORD, brain);
      l = afterSettle(r.ledger);
      stats.createdByPlayer += r.created.length;
      for (const e of r.created) drivenCreateIds.push(e.id);
    }

    // ── ⓪.7 「非他不可」驱动（**仅专用用例打开** · 见 `SimOptions.driveRequiredPerson`）──
    //    照 `driveCreate` 的「明着走一遍」：落地层 / 闸门 / 结算**三处都走真函数**。
    if (opts.driveRequiredPerson && d === DRIVE_REQUIRED_DAY) {
      // 挑两个**当下真的可派遣、今天还有容量**的人（闸门 ② 会据此判容量）
      // ⚠️ **排除玩家自己**（`PLAYER_ID`）：这个字段的真实用法是"只有他（某个 NPC）会开那把锁"，
      //    而闸门 ③ 对玩家本来就不走 `bad` 那条（`parts.filter(p => p.id !== PLAYER_ID)`）
      //    ⇒ 拿玩家当 `him` 会把这条断言测成一句空话。
      const avail = l.entities.people.filter(
        (p) =>
          p.id !== PLAYER_ID &&
          isAvailable(p, l, d) &&
          (l.actionPoints.byNpc[p.id] ?? BASE_ACTION_POINTS) >= 1,
      );
      const him = avail[0];
      const other = avail[1];
      if (him && other) {
        // ① 真落地层：一份**照《契约.md》§6.4 手写**的输出形状（不经 LLM，与夹具同族）
        const landed = landCompose(l, {
          popup_events: [],
          canvas_events: [
            {
              id: 'e1', // 落地层照旧改写成全局 id（与真链路同一条改写规则）
              title: '库房那本缺页的账',
              seed_id: '',
              stage: '下城',
              content: '（驱动用的事件 —— 只为把「非他不可」这条链走一遍）',
              hint_attr: ['智慧'],
              min_people: 1,
              max_people: 3,
              tier: 'B',
              cost: 1,
              min_gold: 0,
              deadline: 2,
              dispatchable: '两者皆可',
              required_person: him.id,
            },
          ],
        });
        const ev = landed.live[0];
        if (ev) {
          drivenRequired.him = him.id;
          drivenRequired.landedId = ev.id;
          drivenRequired.landedField = ev.required_person;
          // ② 真闸门：先看「不含他」那一格
          const bad = evalGates({
            ledger: l,
            today: d,
            action: 'handle',
            eventId: ev.id,
            participants: [other.id],
          }).find((x) => x.code === 'CANNOT_DISPATCH')!;
          drivenRequired.notIncludedPass = bad.pass;
          drivenRequired.notIncludedReason = bad.reason;
          // ③ 再看「含他」那一格 —— 并**真的办一次**（结算链路照走）
          const good = evalGates({
            ledger: l,
            today: d,
            action: 'handle',
            eventId: ev.id,
            participants: [him.id],
          }).find((x) => x.code === 'CANNOT_DISPATCH')!;
          drivenRequired.includedPass = good.pass;
          const r = await handleEvent(l, { eventId: ev.id, participants: [him.id], goldInput: 0 }, rng, brain);
          l = afterSettle(r.ledger);
          stats.arranged += 1;
        }
      }
    }

    // ── ① 排布（**不推进时间**：只扣下属容量，玩家时钟纹丝不动）──
    const skip = new Set<string>();
    let selfToday = 0;
    // 「撒手救场」：跨天的 `neglected` 有一个小概率副作用 —— 它恰好挡住某天**唯一可办**的事
    // （2026-10-07 实测 seed 7 day 16：day 15 撒手了 e34，day 16 池里只剩 e34（被挡）＋ e35（仅派遣、
    // 无可用下属）⇒ 整天空转，「没有一天空转」这条覆盖率顶穿）。⇒ 兜底：今天**一条都没办成**、
    // 且被撒手的事件里还有活人能办的 ⇒ 把撒手撤回，优先保住"每天都有动作"。
    // ⚠️ 只是**当天**撤回（`allowNeglected` 是循环局部变量）—— 正常日子里撒手段照旧跨天生效，
    //    「过期结算」那条覆盖率的日常供给不受影响（它要的是聚合值 `expired ≥ 1`，不认某一条）。
    let allowNeglected = false;
    const canRescue = () =>
      !allowNeglected &&
      arrangedToday + popupsToday === 0 &&
      l.events.live.some((e) => e.status === '待处理' && neglected.has(e.id) && !skip.has(e.id));
    for (;;) {
      const todo = l.events.live.filter(
        (e) => e.status === '待处理' && !skip.has(e.id) && (!neglected.has(e.id) || allowNeglected),
      );
      if (todo.length === 0) {
        if (canRescue()) {
          allowNeglected = true;
          continue;
        }
        break;
      }

      // 档 A 优先（闸门 ④：不处理就别想过日子）
      const popup = todo.find((e) => e.tier === 'A');
      if (popup) {
        const r = clickPopup(l, popup.id);
        l = afterSettle(r.ledger);
        stats.popups++;
        popupsToday++;
        stats.triggered += r.triggered.length;
        if (l.ending) break;
        continue;
      }

      const pick = pickArrangeable(l, todo, selfToday, !selfDone && d >= 3);
      if (!pick) {
        // 池子里还有"待处理"却一条都派不动（如仅剩「仅派遣」而无可用下属）——
        // 同样先问一句救场：被撒手的那条也许恰恰是今天唯一办得了的。
        if (canRescue()) {
          allowNeglected = true;
          continue;
        }
        break;
      }
      if (pick.parts[0] === PLAYER_ID) selfToday++;

      const pay = l.scalars.gold >= pick.ev.min_gold ? pick.ev.min_gold : 0;
      const r = await handleEvent(l, { eventId: pick.ev.id, participants: pick.parts, goldInput: pay }, rng, brain);
      // 闸门拦下 ⇒ 这一条今天放弃（**不消耗任何东西**）
      if (r.blockedBy.length > 0) {
        skip.add(pick.ev.id);
        continue;
      }
      l = afterSettle(r.ledger);
      if (pick.parts[0] === PLAYER_ID) selfDone = true; // 档 C 真的落账了，覆盖率驱动收工
      stats.arranged++;
      arrangedToday++;
      stats.revealed += r.revealedNow.length;
      if (l.ending) break;
    }

    // ── ② 拨时针（奇数日：把当天剩余时间一点一点拨光）──
    //    偶数日故意**不拨**，直接进下一天 —— 那条路径会让"剩余时间自然流完"，两条都测到。
    if (!l.ending && d % 2 === 1) {
      while (remainingToday(l) > 0) {
        const r = await dial(l, 1, rng, brain);
        l = afterSettle(r.ledger);
        stats.dials++;
        dialedToday++;
        stats.dialedPoints += 1;
        stats.revealed += r.revealed.length;
        stats.expired += r.expired.length;
        stats.created += r.created;
        if (l.ending) break;
      }
    }

    // ── ③ 快照 ──
    const p = l.entities.people.find((x) => x.id === PLAYER_ID)!;
    snapshots.push({
      day: l.clock.day,
      chapter: l.clock.chapter,
      gold: l.scalars.gold,
      desire: l.desire.value,
      hp: p.hp,
      san: p.san,
      x: calcX(l, l.clock.day).x,
      arrangedToday,
      popupsToday,
      dialedToday,
      awaiting: countStatus(l, '揭晓待办'),
      todo: countStatus(l, '待处理'),
      hidden: l.events.hidden.length,
      live: l.events.live.length,
    });
    if (arrangedToday + popupsToday + dialedToday === 0) stats.idleDays.push(d);

    // ── ④ 不变式（每一条都是"游戏不崩"的硬下限）──
    if (dayAtStart !== d) violations.push(`第 ${d} 天：进入当天时时钟是 ${dayAtStart}`);
    if (l.clock.usedToday < 0 || l.clock.usedToday > BASE_ACTION_POINTS) {
      violations.push(`第 ${d} 天：时间读数越界 ${l.clock.usedToday}/${BASE_ACTION_POINTS}`);
    }
    if (l.scalars.gold < 0) violations.push(`第 ${d} 天：金币为负 ${l.scalars.gold}`);
    if (l.desire.value < 0 || l.desire.value > 100) violations.push(`第 ${d} 天：欲念越界 ${l.desire.value}`);
    for (const per of l.entities.people) {
      if (per.hp < 0 || per.hp > 3) violations.push(`第 ${d} 天：${per.name} HP 越界 ${per.hp}`);
      if (per.san < 0 || per.san > 3) violations.push(`第 ${d} 天：${per.name} SAN 越界 ${per.san}`);
      for (const [k, v] of Object.entries(per.attrs)) {
        if (v < 1 || v > 20) violations.push(`第 ${d} 天：${per.name} 属性 ${k} 越界 ${v}`);
      }
      if (per.items.length > 4) violations.push(`第 ${d} 天：${per.name} 携带 ${per.items.length} 件，超过 4 位`);
      if (l.actionPoints.byNpc[PLAYER_ID] !== undefined) {
        violations.push(`第 ${d} 天：玩家被写进了 byNpc（幽灵计数）`);
      }
    }
    for (const [k, v] of Object.entries(l.scalars.rep)) {
      if (v < -20 || v > 20) violations.push(`第 ${d} 天：声望 ${k} 越界 ${v}`);
    }
    // `live` 与 `hidden` 必须**互斥** —— 落地层把每条事件只放进一个桶；
    // 同一个 id 同时在两边 = 玩家会看到两张一样的牌（且 `trigger` 会搬出个空壳）。
    const bothBuckets = l.events.hidden.filter((h) => l.events.live.some((e) => e.id === h.id));
    if (bothBuckets.length > 0) {
      violations.push(`第 ${d} 天：${bothBuckets.map((e) => e.id).join('、')} 同时在 live 与 hidden`);
    }
    // 「揭晓待办」与 `pending` 必须**一一对应** —— 这是"算 / 揭分离"的结构底线：
    // 少了 pending ⇒ 揭晓时无从兑现；多了 pending ⇒ 有结果永远不会被兑现（静默丢结算）。
    for (const e of l.events.live) {
      const has = l.pending.some((x) => x.eventId === e.id);
      if (e.status === '揭晓待办' && (!has || e.reveal_at === null || e.started_at === null)) {
        violations.push(`事件 ${e.id} 处于「揭晓待办」却没有完整的 started_at / reveal_at / pending`);
      }
      if (e.status !== '揭晓待办' && has) {
        violations.push(`事件 ${e.id} 状态是 ${e.status}，却还留着 pending 结果`);
      }
    }
    const ids = l.entities.people
      .map((x) => x.id)
      .concat(
        l.entities.items.map((x) => x.id),
        l.entities.places.map((x) => x.id),
      );
    if (new Set(ids).size !== ids.length) violations.push(`第 ${d} 天：出现重复 id`);
    // **逐次检查的结构底线**：命中终结条件就必须**已经**终结。
    // 这正是 2026-09-19 之前漏掉的那一步 —— 当时 seed 7 第 1 天欲念就归零，
    // 模拟器却跑满 28 天，而**所有断言照样全绿**（"绿了但没测到"的又一例）。
    if (!l.ending && instantEndingOf(l) !== null) {
      violations.push(`第 ${d} 天：命中终结条件却没有终结（逐次检查漏挂）`);
    }

    // ── ⓪.7 中途暴毙驱动（**仅专用用例打开** · 见 `SimOptions.driveInstantEnding`）──
    //    放在 ④ 之后、⑤ 之前：当天该做的都做完了，让逐次检查在**这一天**当场收走它
    //    ⇒ `ending.day === DRIVE_BREAK_DAY`（而不是拖到第二天才发现）。
    if (opts.driveInstantEnding && d === DRIVE_BREAK_DAY) {
      l = structuredClone(l);
      l.entities.people.find((x) => x.id === PLAYER_ID)!.hp = 0;
      l = afterSettle(l);
    }

    // ── ⓪.75 概要归并驱动（**仅专用用例打开** · 见 `SimOptions.driveArchive`）──
    //    把**最老那条**概要撑过软顶 ⇒ 明天（第 8 天 = 章首）的 T0 会**自然触发**归并
    //    （不是绕过 `planArchive` 硬塞一段归档 —— 那样测的就只是落地层）。
    //    ⚠️ 与暴毙驱动同族：**标准 28 天打不到**（阈值放宽是用户 2026-09-22 的裁定），
    //       所以这条覆盖率只在被驱动时才断言，绝不无条件写进基线。
    if (opts.driveArchive && d === DRIVE_ARCHIVE_DAY) {
      l = structuredClone(l);
      const oldest = l.summaries.recent.find((r) => r.day === Math.min(...l.summaries.recent.map((x) => x.day)));
      if (oldest) oldest.text = oldest.text + '。'.repeat(DRIVE_ARCHIVE_PAD);
      l = afterSettle(l);
    }

    // ── ⓪.8 硬种子 checkpoint 驱动（**仅专用用例打开** · 见 `SimOptions.driveCheckpoint`）──
    //    把 `善名` 预置到 9，再走**真实的一批**声望变化（`applyDelta` → `commitBatch`）
    //    把它推过 10 ⇒ 「首次达标 ⇒ 必出 1 条硬种子」由**真判据**自己命中。
    //    ⚠️ 与暴毙 / 归并 / 成功结局三个驱动同族：**标准 28 天打不到**（三种子声望峰值 8），
    //       所以这条覆盖率只在被驱动时才断言，绝不无条件写进基线。
    //    ⚠️ 走 `applyDelta` + `commitBatch`（**不是**直接改 `l.seeds`）：要测的正是
    //       "批末判「首次跨档」并出种"这段真链路 —— 手写一条种子等于把被测对象绕开。
    if (opts.driveCheckpoint && d === DRIVE_CHECKPOINT_DAY) {
      l = structuredClone(l);
      l.scalars.rep.善名 = DRIVE_CHECKPOINT_BEFORE;
      const batch = emptyBatch(l);
      applyDelta(l, { ops: [{ rep: { 善名: DRIVE_CHECKPOINT_DELTA } }] } as never, {}, batch);
      const cr = commitBatch(l, batch);
      l = cr.ledger;
      drivenCheckpoints.push(...cr.checkpoints);
    }

    // ── ⑤ 进下一天（C）──
    if (d < days && !l.ending) {
      const r = await nextDay(l, rng, brain, seed);
      l = afterSettle(r.ledger);
      stats.revealed += r.revealed.length;
      stats.expired += r.expired.length;
      stats.created += r.created;
      if (r.divination) stats.divinations += 1;
      if (r.archived) stats.archives += 1;
      stats.daysEntered += r.daysPassed;
    }
  }

  // ── 终局：第 28 天 **放格子 → 判定** ────────────────────────
  //    ⚠️ 中途暴毙（总表 1~4）**没有这一步** —— 那时 `ending` 早已写定，三格全空。
  //    ⚠️ 判据是 `isFinalDay(l)` 而不是循环变量 `d`：只有**真的走满 28 天**才放格子。
  if (!l.ending && isFinalDay(l)) {
    // ⚠️ 成功结局驱动（**仅专用用例打开** · 见 `SimOptions.driveEnding`）：把欲念塞进判定窗口
    //    ⇒ 这一局才会判成**成功**，才会走到 `ending` 那次调用。与暴毙 / 归并两个驱动同族。
    if (opts.driveEnding) {
      l = structuredClone(l);
      l.desire.value = DRIVE_ENDING_DESIRE;
    }
    l = closeGame(l, autoPlace(l));
  }

  // ── 终局话术：**成功结局才调 `ending`**（失败 = 系统预写、0 调用）──────────
  //    ⚠️ 排在放格子**之后**（它要读 `placements`）、覆盖率断言**之前**。
  //    ⚠️ `writeEnding` 自己吞掉失败并留 ⚠️ 日志 —— 这里不 try/catch（它已经是最后一步）。
  let endingCalled = false;
  let endingWrote = false;
  if (l.ending !== null && l.ending.kind === '成功') {
    const w = await writeEnding(l, brain);
    l = w.ledger;
    endingCalled = w.called;
    endingWrote = w.wrote;
    if (w.called) stats.endings += 1;
  }

  // ── 覆盖率断言：**管线真的在动**（不然"0 违规"毫无意义）──────
  const throughput = stats.arranged + stats.popups;
  const crossDayRevealed = l.events.live.filter(
    (e) => e.status === '已结算' && e.started_at !== null && e.reveal_at !== null && e.reveal_at.day > e.started_at.day,
  ).length;
  /**
   * **提前终结**（总表 1~4 命中）—— 它让"28 天级"的覆盖率断言失去前提
   * ⇒ 那几条改为「**若走满 28 天**，则必须成立」。
   *
   * ⚠️ 这不是放宽，是**把前提写明**：一场按设计早就该结束的局，本来就不该再要求它走满 28 天。
   *    反向的防线由 `main.ts` 承担 —— 它会把"提前终结"直接打在汇总行上：
   *    这类局一变多，就是**欲念 / HP·SAN 节奏标定**出了问题，必须看得见。
   * ⚠️ 2026-09-20：`过期结算走通` 也归入这一族 —— 它要的是一整个"期限走完"的**日历**，
   *    而被截断的局够不到（seed 1 要等到第 26 天才有第一条过期，见该条注释里的实测）。
   */
  const endedEarly = l.ending !== null && l.ending.day < days;

  /**
   * 序幕留下的两份读数 —— 只统计 `day = 0` 的那些（正文概要一律是 `day ≥ 1`）。
   * ⚠️ 序幕固定概要是 `choosePopup` 按 `options[].summary` 推进去的，`day` 取当天的
   *    `clock.day`（序幕恒 0）⇒ 用 `day === 0` 筛就是"序幕那几句"，**不会**把正文的混进来。
   */
  const prologueSummaryCount = l.summaries.recent.filter((r) => r.day === 0).length;
  /** 第 1 张原卡有没有真的翻出来（`opening` 是序幕末条唯一的产物） */
  const openingLanded = l.desire.manifesto !== '' && l.desire.proposition !== '';

  const coverCoverage: CoverageCheck[] = [
    {
      name: `★ 序幕走完（${PROLOGUE_TOTAL} 条档 A 逐条点掉 · day 0 两天巡礼）`,
      // ⚠️ 与"28 天级"那几条**不同族**：序幕与 `rng` 无关、也不吃 `endedEarly`
      //    —— 序幕期欲念恒 30、HP/SAN 恒 3 ⇒ 逐次检查在序幕里不可能命中，
      //    任何一局只要没明着跳过，就一定走满 10 条。
      //    ⇒ 这里**不挂 `endedEarly`**：挂了就等于把"提前终结"当成了序幕没走完的借口。
      ok: opts.skipPrologue ? true : stats.prologuePopups === PROLOGUE_TOTAL,
      detail: opts.skipPrologue
        ? '（本次驱动明着跳过序幕）'
        : `点选 ${stats.prologuePopups} / ${PROLOGUE_TOTAL} 条` +
          `　·　末条翻牌：${openingLanded ? '已落账' : '⚠️ 六维/命题是空的'}`,
    },
    {
      name: '★ 序幕固定概要已并入「已处理概要」（9 条 · day 0 ·「原初欲望的觉醒」不计入）',
      // ⚠️ 判据是 `day === 0` 的条数**恰好等于** `prologueSummaryLines().length`：
      //    · 多 = 末条那句"欲望的开端"漏进了公共概要；
      //    · 少 = 某条文案的 `summary` 被清空了（展示期的开局记忆丢了）。
      //    两个方向都是**内容缺口**，不是"少一条无所谓"。
      ok: opts.skipPrologue ? true : prologueSummaryCount === prologueSummaryLines().length,
      detail: opts.skipPrologue
        ? '（本次驱动明着跳过序幕）'
        : `day 0 概要 ${prologueSummaryCount} 条（应 ${prologueSummaryLines().length}）`,
    },
    { name: '档 A 弹窗被点选过（闸门 ④ + 点选即落账）', ok: stats.popups >= 1, detail: `点选 ${stats.popups} 次` },
    {
      name: '揭晓走通（揭晓待办 → 已结算）',
      ok: stats.revealed >= 1,
      detail: `揭晓 ${stats.revealed} 条`,
    },
    {
      name: '没有一天空转',
      ok: stats.idleDays.length === 0,
      detail: stats.idleDays.length === 0 ? '每天都有动作' : `空转日 ${stats.idleDays.join(',')}`,
    },
    {
      name: '管线吞吐 ≥ 28 次（均摊每天 ≥ 1）',
      ok: endedEarly || throughput >= 28,
      detail: `实际 ${throughput} 次（排布 ${stats.arranged} + 弹窗 ${stats.popups}）`,
    },
    { name: '略过率 < 50%（事件不是靠"过期"收场的）', ok: stats.expired < stats.created / 2, detail: `过期 ${stats.expired} / 新生成 ${stats.created}` },
    {
      name: '★ 过期结算走通（没人处理 ⇒ 按「忽略」结账 ＋ 留一条概要）',
      // ⚠️ 这条**也吃 `endedEarly`**：它要的不是"28 天"这个数字，而是**一整个"期限走完"的日历**。
      //    2026-09-20 实测（探针 `.workbuddy/probe-expire.mjs`）三个基线种子的**首次过期日**：
      //      seed 42 → 第 8 天 · seed 7 → 第 12 天 · **seed 1 → 第 26 天**。
      //    ⇒ 把「中途暴毙驱动日」往后挪治不好这件事：seed 1 要等到第 26 天，那已经是终局前一天。
      //      被截断的局本来就够不到这条日历 ⇒ 与"28 天级"那几条同族，按同一把尺子放行。
      //    反向防线：`ending.test.ts` 钉住"**同一个种子走满 28 天时这条照样必须达标**"——
      //      放行只对截断的局生效，不会退化成一条永远假绿的断言。
      ok: endedEarly || stats.expired >= 1,
      detail:
        `过期结算 ${stats.expired} 条` +
        (endedEarly ? `　⚠️ 提前终结于第 ${l.ending!.day} 天，够不到这条日历` : ''),
    },
    { name: '欲向落账生效（欲念动过）', ok: l.desire.value !== 0 || snapshots.some((s) => s.desire !== 0), detail: `末值 ${l.desire.value}` },
    { name: '档 C 亲自被走到（无下属可用时玩家自己上）', ok: l.events.live.some((e) => e.handler === PLAYER_ID), detail: '账本里出现过 handler=npc000 的事件' },
    {
      name: '★ 拨时针（B）被走到 —— 时间只能由玩家主动消费',
      ok: endedEarly || stats.dials >= 1,
      detail: `拨了 ${stats.dials} 次、共 ${stats.dialedPoints} 点`,
    },
    {
      name: '★ 进入下一天（C）被走到 —— 天数完整推进',
      ok: endedEarly || stats.daysEntered >= days,
      detail: `进入 ${stats.daysEntered} 次（应 ≥ ${days}）`,
    },
    {
      name: '★ 跨天揭晓被走到（处理时长 > 单日预算）',
      ok: endedEarly || crossDayRevealed >= 1,
      detail: `跨天落账 ${crossDayRevealed} 条`,
    },
    {
      name: '★ 隐藏事件被 `trigger` 唤醒过（父指子：子从 hidden 搬进 live）',
      ok: endedEarly || stats.triggered >= 1,
      detail: `唤醒 ${stats.triggered} 条 · 终局仍藏在 hidden 里没被唤醒的有 ${l.events.hidden.length} 条`,
    },
    {
      name: '★ 章节占卜被走到（第 1 / 8 / 15 / 22 天各一次 · 走满 28 天应为 4）',
      // ⚠️ 与其它「28 天级」的断言同族：它要的是**四个占卜日**，被截断的局够不到。
      //    但**不能只看计数** —— 计的是「调了几次」，还得看氛围**真的落了账**：
      //    那是这一次产出里唯一玩家看得见的那一半（`ledger.divination`）。
      //    ⚠️ 两样必须一起看：`enterDay` 里的占卜是 **try/catch** 的，失败只记一条
      //    警告、T0 照常往下走 ⇒ 只数 `stats` 会漏掉「四次全失败」这种局面。
      ok: endedEarly || (stats.divinations >= 4 && l.divination !== null && l.divination.ambition !== ''),
      detail:
        `占卜 ${stats.divinations} 次 · 终局氛围「${l.divination?.ambition ?? '（无）'}」` +
        (endedEarly ? `　⚠️ 提前终结于第 ${l.ending!.day} 天，够不到这条日历` : ''),
    },
    {
      name: '★ 凭证链路被走到（`resolve.vouchers` → 账本第 8 组 → 人物 `recognized`）',
      // ⚠️ 判据用 `l.vouchers.length` —— 凭证表**只追加**（收回是把已挂着的那条标 `recalled_day`、
      //    不另写记录、也不删）⇒ 它就是"整局一共产出过几条"的**单调读数**，
      //    不会被"全被收回光了"骗成假绿。
      ok: endedEarly || l.vouchers.length > 0,
      detail:
        `凭证 ${l.vouchers.length} 条（其中收回 ${l.vouchers.filter((v) => v.recalled_day !== null).length} 条）· ` +
        `给过认可的人 ${l.entities.people.filter((p) => p.recognized.length > 0).length} 个`,
    },
    {
      name: '★ 终局已判定（第 28 天放格子 → 判定，或中途暴毙）',
      ok: l.ending !== null,
      detail: l.ending === null
        ? '走完 28 天却没有结局 —— 出口没接上'
        : `${l.ending.kind}·${l.ending.name}（总表第 ${l.ending.row} 行 · ${l.ending.reason}）` + (endedEarly ? `　⚠️ 提前终结于第 ${l.ending.day} 天` : ''),
    },
    {
      name: '★ 放格子被走到（三格各自独立挑候选池）',
      ok: endedEarly || (l.ending !== null && l.ending.placements.成果 !== null),
      detail: l.ending === null
        ? '（未判定）'
        : `成果=${l.ending.placements.成果 ?? '空'} · 手段=${l.ending.placements.手段 ?? '空'} · 共鸣=${l.ending.placements.共鸣 ?? '空'}`,
    },
    {
      // ⚠️ P4-C 第四条侧链（`ending`）接线之前，这一条问的是"成功才允许为空（它等 `ending` 写）"；
      //    接线之后**两边都必须非空**：失败 = 系统预写话术、成功 = `ending` 侧链写。
      name: '★ 终局话术已就位（失败 = 系统预写 0 调用 · 成功 = `ending` 侧链写）',
      ok: l.ending !== null && l.ending.text !== null,
      detail:
        l.ending === null
          ? '（未判定）'
          : `${l.ending.kind}·${l.ending.name}` +
            `${l.ending.title === null ? '' : `『${l.ending.title}』`} · ` +
            `${l.ending.text === null ? '无话术' : `${[...l.ending.text].length} 字`}`,
    },
    {
      name: '★ 结局名取自总表（1~7 失败 ＋ 8 成功）',
      ok: l.ending !== null && l.ending.row >= 1 && l.ending.row <= 8,
      detail: l.ending === null ? '（未判定）' : `第 ${l.ending.row} 行`,
    },
  ];

  // ⚠️「逐次终结被走到」这条覆盖率**只在被驱动时才断言**：
  //    基线种子里夹具杀不死玩家（假设 ②），无条件写上去就是一条永远假绿的断言。
  //    驱动打开时它**必须**真的走到 —— 这条成对关系由 `ending.test.ts` 的专用用例钉住。
  if (opts.driveInstantEnding) {
    coverCoverage.push({
      name: '★ 逐次终结被走到（HP·SAN 归零 / 欲念 0·100 ⇒ 立即终结，不等第 28 天）',
      ok: endedEarly && (l.ending?.row ?? 0) >= 1 && (l.ending?.row ?? 0) <= 4,
      detail: l.ending === null ? '（未判定）' : `${l.ending.name}（第 ${l.ending.day} 天 · 总表第 ${l.ending.row} 行）`,
    });
  }

  // ⚠️「概要归并被走到」这条覆盖率**只在被驱动时才断言** —— 理由见 `SimOptions.driveArchive`：
  //    标准 28 天里 `planArchive` 恒 `trigger=false`（阈值放宽是用户 2026-09-22 的裁定），
  //    无条件写上去就是一条**永远假绿**的断言。
  if (opts.driveArchive) {
    coverCoverage.push({
      name: '★ 概要归并被走到（章首超软顶 / 越硬顶 ⇒ 最老 N 天并成一段 · 追加进归档区）',
      ok: stats.archives >= 1 && l.summaries.archive.length >= 1,
      detail: `归并 ${stats.archives} 次 · 归档区 ${l.summaries.archive.length} 段 · 逐条区剩 ${l.summaries.recent.length} 条`,
    });
  }

  // ⚠️「成功结局话术被走到」这条覆盖率**只在被驱动时才断言** —— 理由见 `SimOptions.driveEnding`：
  //    三种子第 28 天欲念 61/64/65 全在 [75,80] 之外 ⇒ 判出来的都是失败结局（0 调用），
  //    无条件写上去就是一条**永远假绿**的断言。
  if (opts.driveEnding) {
    coverCoverage.push({
      name: '★ 成功结局话术被走到（`ending` 侧链 · 全局 ≤1 次 · 失败结局 0 调用）',
      ok: endingCalled && endingWrote && l.ending?.kind === '成功' && l.ending.title !== null,
      detail:
        l.ending === null
          ? '（未判定）'
          : `${l.ending.kind}·${l.ending.name} · 调用 ${endingCalled ? '1 次' : '0 次'} · ` +
            `话术 ${l.ending.text === null ? '缺失' : `${[...l.ending.text].length} 字`}`,
    });
  }

  // ⚠️「硬种子 checkpoint 被走到」这条覆盖率**只在被驱动时才断言** —— 理由见
  //    `SimOptions.driveCheckpoint`：三个基线种子的声望峰值是 8，**一个门槛都碰不到**
  //    ⇒ 无条件写上去就是一条**永远假绿**的断言（本项目已经栽过三次）。
  //    ⚠️ 两样一起看：`drivenCheckpoints`（那批**真的出了种**，来自 `commitBatch` 的结构返回值）
  //       ＋ `repMarks`（**标记真的记下**了）。少了任何一样，都可能是"记了标记没出种"
  //       或"出了种没记标记"—— 后者会让这条 checkpoint **永远不再触发**，而没有任何断言会红。
  if (opts.driveCheckpoint) {
    const marks = REP_KEYS.flatMap((k) => l.repMarks[k].map((step) => `${k}达到 ${step}`));
    const hardInPool = l.seeds.filter((s) => s.source === '硬种子').length;
    coverCoverage.push({
      name: '★ 硬种子 checkpoint 被走到（声望**首次**达 10 / 15 / 20 ⇒ **必出** 1 条 `硬种子`）',
      ok: drivenCheckpoints.length >= 1 && marks.length >= 1,
      detail:
        `本批出种 ${drivenCheckpoints.join('、') || '（无）'}` +
        `　·　账本标记 ${marks.join('、') || '（无）'}` +
        `　·　终局种子池 ${l.seeds.length} 条（其中硬种子 ${hardInPool} 条）`,
    });
  }

  // ⚠️「玩家自建被走到」这条覆盖率**只在被驱动时才断言** —— 理由同上一族：
  //    笨策略不会自己开口（自建是"玩家主动"的路，模拟器里没有"意志"这个东西）
  //    ⇒ 无条件写上去就是一条**永远假绿**的断言（断言存在 ≠ 路径被走到）。
  //    ⚠️ 判据**两段都要**：① 那条事件真的落进了池子；② 它**真的被办过**
  //       （`handler` 或 `started_at` 有值）—— 只证明"落进池子"太弱：
  //       造出来了但当天没人碰，玩家实际上还是什么都没得到。
  if (opts.driveCreate) {
    const mine = l.events.live.filter((e) => drivenCreateIds.includes(e.id));
    const worked = mine.filter((e) => e.handler !== null || e.started_at !== null);
    coverCoverage.push({
      name: '★ 玩家自建被走到（「创建事件」：一句话 ⇒ 1 条 canvas_event ⇒ 进池 ⇒ 被排布）',
      ok: drivenCreateIds.length >= 1 && worked.length >= 1,
      detail:
        `自建 ${drivenCreateIds.length} 条（${drivenCreateIds.join('、') || '（无）'}）` +
        `　·　其中已排布 ${worked.length} 条`,
    });
  }

  // ⚠️「非他不可」（`required_person`）这条覆盖率**只在被驱动时才断言** —— 理由见
  //    `SimOptions.driveRequiredPerson`：夹具不产这个字段 ⇒ 标准 28 天里它恒空，
  //    无条件写上去就是一条**永远假绿**的断言（断言存在 ≠ 路径被走到）。
  //    ⚠️ 判据**四段都要**：① 字段真的落进账本；② 不含他 ⇒ 拦下；③ 含他 ⇒ 放行；
  //       ④ 这条**真的被办过**（`handler` / `started_at` 有值）—— 只证明"落进池子"太弱。
  if (opts.driveRequiredPerson) {
    const ev = l.events.live.find((e) => e.id === drivenRequired.landedId);
    const worked = !!ev && (ev.handler !== null || ev.started_at !== null);
    coverCoverage.push({
      name: '★ 「非他不可」被走到（`required_person`：字段落账 ⇒ 不含他必拦 ⇒ 含他放行 ⇒ 真被办过）',
      ok:
        drivenRequired.him !== '' &&
        drivenRequired.landedField === drivenRequired.him &&
        drivenRequired.notIncludedPass === false &&
        drivenRequired.includedPass === true &&
        worked,
      detail:
        `他 ${drivenRequired.him || '（无）'}` +
        `　·　账本字段 ${drivenRequired.landedField || '（空）'}` +
        `　·　不含他 ⇒ ${drivenRequired.notIncludedPass === false ? '拦下' : String(drivenRequired.notIncludedPass)}` +
        `（${drivenRequired.notIncludedReason}）` +
        `　·　含他 ⇒ ${drivenRequired.includedPass === true ? '放行' : String(drivenRequired.includedPass)}` +
        `　·　事件 ${worked ? '真的被办过' : '没被办过'}`,
    });
  }

  for (const c of coverCoverage) {
    if (!c.ok) violations.push(`覆盖率不达标：${c.name}（${c.detail}）`);
  }

  return { ledger: l, snapshots, violations, coverage: coverCoverage, stats };
}

export type { GameEvent };
