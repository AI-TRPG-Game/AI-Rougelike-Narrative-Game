// 手写假事件 + 假 brain —— Phase 1 的测试燃料
//
// 这一层要顶替两样东西：① `compose_day` 生成的事件；② `settle` 的结算输出。
// 形状刻意与真实契约对齐 ⇒ 换个 brain，调用方一行不改。
//
// ⚠️ 三条**刻意写进夹具的假设**（都不是规则层行为，而是"真实 LLM 大概会这么产"的替身）：
//   ① 会产出 **档 A 弹窗** —— 否则闸门 ④ 与"点选即落账"这条路径**永远走不到**；
//   ② 伤害**不把人打到 0** —— 夹具不制造"永久减员"（那是编排层的事：新人物 / 医馆）；
//   ③ 会产出 **`trigger`（隐藏事件）** —— 否则"父指子、点选才现身"那条支路永远走不到。
//      （与"过期结算""档 C 亲自"同属一类覆盖率缺口：**断言存在 ≠ 路径被走到**。）
//
// ⚠️ ④（2026-09-19 · Phase 4 覆盖率驱动 · **2026-10-05 已作废**）：这一条原本靠
//    "欲念未破 60 时结算欲向恒「得偿」"把欲念推上去，好让「首次达 60 → 次日重写命题」那条
//    **一生一次**的路必被走到。`rewrite_desire` 侧链整条删掉之后**它失去了对象**，但
//    **驱动本身留下**（`FAKE_DESIRE_SATISFIED_MAX` 那个 60 与「得偿」偏好一字未改）
//    —— 因为它同时是「欲向落账生效」这条链路的燃料，而那条链路还在。
//    与 `simulate.ts` 的 `forceSelf` 同族：明着走一遍，不靠运气。
//
// ⚠️ ⑤（2026-09-21 · 凭证链路）：**会产出凭证**（三个维度各一条 ＋ 偶尔收回一条成果）。
//    不加这一段，`resolve.vouchers` → 账本第 8 组 → `Person.recognized` 这条链路
//    **在离线路径上一次都跑不到**：三个基线种子跑满 28 天，终局那一格永远是「共鸣=空」，
//    而所有断言照样全绿。与假设 ①③④ 同族：**夹具不产出，路径就永远走不到**。
//    ⚠️ 它的判定一律走 `roll()`（**稳定散列**，刻意不动 rng 流）—— 见该函数顶上的理由。
//
// ⚠️ 2026-09-19：`composeDay` 的返回值**改成 `compose_day` 的原始形状**
//    （`{popup_events, canvas_events}` ＋ 本地编号 ＋ `label` / `result_text` 字段名）。
//    理由是"规则层是唯一防线"这条纪律：夹具若直接吐 `GameEvent[]`，就等于**跳过落地层**
//    （`turn/land-compose.ts`）⇒ 编号改写、枚举收口、条数硬顶、种子核销这些
//    **在离线路径上一次都跑不到**（28 天驱动号称全绿，实际只测了规则层的一半）。
//    形状对齐之后，无头驱动跑的才是**真链路**。
//
// ⚠️ 2026-09-18 时钟模型改造后的夹具口径：
//    · `duration` 已删除 —— 事件处理时长统一由 **`cost`（行动点）** 表达；
//    · `cost > 4` 即**跨天事件**，挡位 = **`4` 的倍数**（`8` / `12` …）—— **不存在 `6`**
//      （要么当天做完 ≤ 4，要么整天地跨）；用来把 `depart_cost` / 归队日路径跑热；
//    · `deadline` 的单位是**天**（挡位 `1 / 2 / 4`、**最短 1 天**，2026-09-18 起）——
//      旧口径的 `4 点 = 1 天`。
//      ⚠️ 事件卡里的 `cost` 仍是**行动点**：一个事件的"做多久"与"几天内做"是两个单位，别混。
//
// ⚠️ **恢复不再由夹具顶替**：真实系统里恢复走「医馆 / 大神殿」两个**纯功能入口**
//    （`turn/restore.ts`：1~2 金币把人的 HP / SAN 回满、占**被治疗者** 2 点容量、提交即落账、
//    不进事件池、不经 `settle`）。此前那条"休养类事件"替身**已于 2026-09-18 删除** ——
//    它掩盖了"两个入口没实现"这个缺口，正是「绿了但没测到」的又一例。
import type { AttrKey, Check, DesireTier, Difficulty, Tier, Verdict } from '../contract/types.ts';
import { POPUP_DESIRE_TIERS } from '../contract/types.ts';
import { PLAYER_ID, type GameEvent, type Ledger } from '../ledger/types.ts';
import { makeRng, type Rng } from '../rules/rng.ts';
import type { ArchivePlan } from '../rules/archive.ts';
import { ENDING_TEXT_MAX, ENDING_TEXT_MIN } from '../rules/ending.ts';
import type {
  Adjudication,
  Brain,
  RawEndingOutput,
  RawArchiveOutput,
  RawChapterShiftOutput,
  RawComposeOutput,
  RawResolution,
  SceneStep,
} from '../turn/brain.ts';

let seq = 0;

export function makeEvent(p: Partial<GameEvent> & { title: string }): GameEvent {
  seq += 1;
  return {
    id: p.id ?? `e${seq}`,
    title: p.title,
    content: p.content ?? '（假事件）',
    // ⚠️ `stage` = **显示用地点名**（LLM 写下的那个字符串），`location` = 解析到的地点 **id**。
    //    两者不是一回事：前者进 user ③ 的【事件卡】给人看，后者进账本参与判重与查找。
    stage: p.stage ?? '（未定）',
    location: p.location ?? 'loc001',
    tier: p.tier ?? 'B',
    dispatchable: p.dispatchable ?? '两者皆可',
    required_person: p.required_person ?? '',
    cost: p.cost ?? 2,
    min_gold: p.min_gold ?? 0,
    min_people: p.min_people ?? 1,
    max_people: p.max_people ?? 3,
    deadline: p.deadline ?? 2,
    options: p.options ?? [],
    delta: p.delta ?? null,
    hint_attr: p.hint_attr ?? (['智慧'] as AttrKey[]),
    difficulty: p.difficulty ?? '无修正',
    status: p.status ?? '待处理',
    created_day: p.created_day ?? 0,
    started_at: p.started_at ?? null,
    reveal_at: p.reveal_at ?? null,
    handler: p.handler ?? null,
    participants: p.participants ?? [],
    gold_locked: p.gold_locked ?? 0,
    depart_cost: p.depart_cost ?? null,
  };
}

// ── 事件池 ───────────────────────────────────────────────────

/** 档 B：派遣型（缺省） */
const TITLES: Array<[string, AttrKey[], Difficulty]> = [
  ['城门口的一张无名告示', ['智慧'], '无修正'],
  ['账房送来一封缺页的信', ['智慧', '社交'], '惩罚1'],
  ['下城有人在夜里敲门', ['争斗', '敏捷'], '无修正'],
  ['花街的旧识托你带句话', ['社交', '魅力'], '奖励1'],
  ['猎场里的一头瘸腿鹿', ['敏捷', '感知'], '惩罚2'],
];

/** 档 A 弹窗（夹具假设 ①）：不耗行动点、不需要人、当天必须清掉 */
const POPUP_TITLES = [
  '一只乌鸦落在窗台上，嘴里衔着东西',
  '集市上有人当街喊出了你的名字',
  '一封没有署名的请柬压在门缝下',
];

const POPUP_TEXTS = ['接过来看看', '装作没看见', '把东西退回去'];

/**
 * 地点**名**（显示用的那个字符串，不是 id）—— 由落地层解析成 `location`。
 * ⚠️ `西门码头` **刻意不在** `initialLedger()` 的两处预置地点里 ⇒ 它会把
 *    「`stage` 写了个没注册过的地名 ⇒ 规则层当场补登记、发 `loc` 号」这条路**真的走一遍**。
 */
const PLACE_NAMES = ['金庭', '下城', '西门码头'];

/**
 * 处理时长分布（行动点）。
 * `8` 是**跨天事件**（`cost > 4`）—— 挡位必须是 `4` 的倍数（`6` 这种"一天半"不存在）。
 * 让跨天路径占到约 1/6：少了测不到，多了会把两个下属长期钉在途中、把吞吐拖垮。
 */
const COST_TABLE = [1, 2, 2, 4, 4, 8];

/**
 * 过期窗口的**挡位**（天）—— 生成侧硬约束（写进 `compose_day` 的 schema description）
 * 在代码里的**唯一权威拷贝**：`deadline` 只会是 `1 / 2 / 4`。
 * ⚠️ 三个挡位都**必须真被产出过**：只产 `1` 的话，"过期结算"那条路就只能覆盖最短窗口，
 *    `2 / 4` 天窗口下的过期时刻（尤其跨天事件走到一半过期）测不到 —— 又一个「绿了但没测到」。
 */
export const DEADLINE_STEPS: readonly number[] = [1, 2, 4];

/** `cost ≤ 2`：当天能完事 ⇒ 窗口偏紧 */
const DEADLINE_SHORT = [DEADLINE_STEPS[0], DEADLINE_STEPS[1]];
/** `cost > 2`（跨天）：得给得起"走了再回来"的时间 */
const DEADLINE_LONG = [DEADLINE_STEPS[1], DEADLINE_STEPS[2]];

function popupOps(rng: Rng): unknown[] {
  const pick = rng.int(4);
  if (pick === 1) return [{ gold: -1 }];
  if (pick === 2) return [{ rep: { 侠名: 1 } }];
  if (pick === 3) return [{ rep: { 怪名: 1 } }];
  return [
    {
      change: [
        { who: '玩家', hp: 0, san: 1, attrs: [], in_your_eyes: '你答应了一件很小的事', openness: 2 },
      ],
    },
  ];
}

/**
 * 档 A 的选项（**原始形状**：`label` / `result_text` / `trigger`）。
 * ⚠️ 字段名必须与 `schema/compose.ts` 的 `$def/PopupEvent.options[]` **逐字一致** ——
 *    落地层是按 **schema 的名字**读的，不是按账本的名字（那正是它要做的翻译）。
 * ⚠️ 档 A 的欲向**只允许** 无关 / 偏离 / 趋近。
 */
function popupOptions(rng: Rng, childLocal: string | null): unknown[] {
  const n = 2 + (rng.int(2) - 1); // 2~3 个选项
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      label: POPUP_TEXTS[i % POPUP_TEXTS.length],
      result_text: `（假弹窗结果文案：选了「${POPUP_TEXTS[i % POPUP_TEXTS.length]}」）`,
      summary: `（假弹窗落地：选项 ${i + 1}）`,
      delta: { ops: popupOps(rng) },
      // ⚠️ **只给第一个选项挂 `trigger`**（契约：至多 1 个）—— 而笨策略恰好总点第一个
      //    ⇒ 这条支路**必被走到**，不靠运气。
      trigger: i === 0 && childLocal !== null ? childLocal : '',
      欲向: POPUP_DESIRE_TIERS[rng.int(POPUP_DESIRE_TIERS.length) - 1] as DesireTier,
    });
  }
  return out;
}

/** 一条档 B/C 的**原始形状**（本地编号 ＋ `CanvasEvent` 的字段名） */
function canvasRaw(rng: Rng, id: string): Record<string, unknown> {
  const [title, attrs, diff] = TITLES[rng.int(TITLES.length) - 1];
  const cost = COST_TABLE[rng.int(COST_TABLE.length) - 1];
  // 过期窗口（**天**，挡位 `1 / 2 / 4`）—— 让「没人处理 ⇒ 过期结算」这条路真的跑热
  const pool = cost <= 2 ? DEADLINE_SHORT : DEADLINE_LONG;
  return {
    id,
    title,
    seed_id: '',
    stage: PLACE_NAMES[rng.int(PLACE_NAMES.length) - 1],
    content: '（假事件文案）',
    hint_attr: [...attrs],
    min_people: 1,
    max_people: cost > 4 ? 1 : 3,
    tier: 'B',
    cost,
    min_gold: rng.int(3) === 1 ? 2 : 0,
    deadline: pool[rng.int(pool.length) - 1],
    // 「仅派遣」= 远征 / 潜伏这类玩家去不了的长离岗事；「仅亲自」= 他必须自己露面。
    // 让限制**真的出现在牌面上**，落地层的枚举收口与闸门 ③ 才有东西可测。
    dispatchable: rng.int(4) === 1 ? (rng.int(2) === 1 ? '仅亲自' : '仅派遣') : '两者皆可',
  };
}

/**
 * 假 `compose_day`：按水位发 1~2 条自由事件，**输出 `compose_day` 的原始形状**。
 *
 * 两种形态：档 A 弹窗 / 常规派遣（**恢复已不在这里** —— 它是 `turn/restore.ts` 的直连动作）。
 * ⚠️ 档 A 那一条：只要同批还有第二条，就把它做成**被第一个选项 `trigger` 唤醒的隐藏事件**
 *    （夹具假设 ③）—— 这样"藏起 → 点选 → 现身"整条支路每天都有约一半概率被走到。
 */
export function fakeComposeDay(l: Ledger, rng: Rng): RawComposeOutput {
  void l; // ⚠️ 编号与 `created_day` 现在都由**落地层**负责（夹具不再自己写账本字段）
  const n = 1 + (rng.int(2) - 1); // 1~2 条
  const popup_events: unknown[] = [];
  const canvas_events: unknown[] = [];
  let local = 0;
  const nextLocal = (): string => `e${++local}`;

  if (rng.int(6) === 1) {
    // ── 档 A：弹窗（不消耗行动点 / 不需要人 / `deadline` 恒 1 且**永不过期**）──
    const parent = nextLocal();
    const child = n === 2 ? nextLocal() : null;
    popup_events.push({
      id: parent,
      title: POPUP_TITLES[rng.int(POPUP_TITLES.length) - 1],
      seed_id: '',
      stage: PLACE_NAMES[rng.int(PLACE_NAMES.length) - 1],
      content: '（假弹窗文案）',
      deadline: 1,
      options: popupOptions(rng, child),
    });
    // `child` 走的是**它自己的通道**（canvas）—— 父子关系只由父的 `trigger` 表达，**子不回填父**。
    if (child) canvas_events.push(canvasRaw(rng, child));
  } else {
    for (let i = 0; i < n; i++) canvas_events.push(canvasRaw(rng, nextLocal()));
  }
  return { popup_events, canvas_events };
}

// ── 玩家自建（`compose_day` 单条版 · 《契约.md》§三「创建事件」）────

/**
 * 假**玩家自建** —— 输出形状与 `fakeComposeDay` **逐字相同**（同一个 function），
 * 差别只有两条，与落地层的 `mode: 'create'` 一一对应：
 *   ① 只产 `canvas_events` **1 条**、`popup_events` 恒空数组；
 *   ② 内容**由玩家的原话决定**（同一句话 ⇒ 同一条事件）。
 *
 * ⚠️ 它**不摇 `rng`**（也不接受 `rng` 参数）：自建是玩家主动的，与"正文那条随机流"无关 ——
 *    真伸进 `rng` 里摇一次，整局轨迹会跟着玩家的**每一次输入**漂走
 *    （与 `vouchersFor` / `chapterShift` / `archive` / `ending` 同一条纪律）。
 *    需要"换个原话就换个样子"的地方一律走 `hashText()`：确定性、且与 rng 无关。
 * ⚠️ 标题取原话的**前 12 字**（指令里"标题 ≤12 字"的同一口径）——
 *    夹具不做摘要，把原话截短就够；正文里带上**完整原话**，
 *    好让测试能断言"这一条确实是那句话变成的"（那正是 P5-C 要验的东西）。
 * ⚠️ `cost` / `min_people` / `deadline` 一律取**挡位内的合法值**：落地层会钳，
 *    但夹具若本来就不合法，测出来的是"夹具坏了"——而那看起来非常像"代码坏了"
 *    （`archive` / `ending` 那两条注释里记过同一次教训）。
 */
export function fakeCreateEvent(approach: string): RawComposeOutput {
  const t = approach.trim();
  const h = hashText(t);
  const [fallbackTitle, attrs] = TITLES[h % TITLES.length];
  const short = [...t].slice(0, 12).join('');
  return {
    popup_events: [],
    canvas_events: [
      {
        id: 'e1',
        // ⚠️ 用原话开头，而不是从 `TITLES` 里挑一个 —— 否则测试没法证明"是这句话做的"
        title: short || fallbackTitle,
        seed_id: '',
        stage: PLACE_NAMES[h % PLACE_NAMES.length],
        content: `（假自建文案）他打算：${t}`,
        hint_attr: [...attrs],
        min_people: 1,
        max_people: 2,
        tier: 'B',
        cost: 2,
        min_gold: 0,
        deadline: 2,
        dispatchable: '两者皆可',
      },
    ],
  };
}

// ── 结算输出 ─────────────────────────────────────────────────

const DESIRE_POOL: DesireTier[] = ['无关', '无关', '无关', '偏离', '趋近'];

/**
 * **夹具自己的**欲念漂移参数：结算时欲念低于它 ⇒ `欲向` 恒「得偿」（否则回随机池）。
 *
 * ⚠️ **它曾经是 `rules/desire.ts·REWRITE_THRESHOLD`（值同为 60）**，2026-10-05 随
 *    `rewrite_desire` 侧链一起删掉了 —— 那个常量的**全部**职责就是"欲念首破 60 ⇒ 次日
 *    重写命题"，而用户已裁定**命题一生只写一次** ⇒ 60 在规则层失去了一切语义。
 *    剩下这半个用途（"夹具怎么造漂移"）与规则层无关 ⇒ 就地落在夹具里。
 * ⚠️ **数值一字未改**，夹具输出与此前逐字相同（那三个基线种子 28 天的轨迹不受影响）。
 *    它**不是**规则层的口径，谁也不许拿它去回答玩家面的任何问题。
 */
const FAKE_DESIRE_SATISFIED_MAX = 60;

/**
 * 稳定散列 —— **刻意不用 `rng`**。
 *
 * ⚠️ 夹具的 rng 流本身就是"整局轨迹"的一部分：在这里多摇一次，三个基线种子 28 天的
 *    每一步都会整体挪位 ⇒ 那些精心调过的覆盖率与预期结局（「失败·未竟」）会一起漂走。
 *    用 `(事件 id, 标题, 盐)` 的稳定散列做决策，"这次产不产凭证"就**可重复、且与 rng 无关**。
 */
function roll(ev: GameEvent, salt: number, mod: number): number {
  let h = (2166136261 ^ Math.imul(salt, 2654435761)) >>> 0;
  for (const ch of `${ev.id}|${ev.title}|${salt}`) {
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  }
  return h % mod;
}

/** 同一套散列，只是入参换成**一句话** —— 章节占卜没有事件 id 可用（`roll` 的顶栏理由照样成立） */
function hashText(s: string): number {
  let h = 2166136261 >>> 0;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/**
 * 夹具假设 ⑤（2026-09-21）：**会产出凭证**。
 *
 * 分布刻意覆盖三个维度各一条 ＋ 一次收回（否则"三维里总有一维永远没被走过"）：
 *   · 成功的结算 ⇒ 约 1/4 产成果、1/3 产手段、1/4 产共鸣（可能同时命中，也可能一条不产）；
 *   · 大失败     ⇒ 约 1/3 收回一条还挂着的**成果**凭证（连带把那件物品移出账本）。
 * 判定一律走 `roll()`，所以整局可重复；`tier === null`（忽略结算）不产任何凭证。
 */
function vouchersFor(ev: GameEvent, tier: Tier | null, l: Ledger): unknown[] {
  const out: unknown[] = [];
  const ok = tier === '大成功' || tier === '困难成功' || tier === '成功';

  if (ok && roll(ev, 1, 4) === 0) {
    const mine = l.entities.items.filter((i) => !i.consumed && (i.holder === PLAYER_ID || i.holder === null));
    if (mine.length > 0) {
      const it = mine[roll(ev, 2, mine.length)];
      out.push({
        dim: 'the_great_achievement',
        action: 'produce',
        item: it.id,
        person: '',
        desc: `「${ev.title}」办成之后留下的凭据`,
      });
    }
  }
  if (ok && roll(ev, 3, 3) === 0) {
    out.push({
      dim: 'the_proper_way',
      action: 'produce',
      item: '',
      person: '',
      desc: `走「${ev.title}」这条路走对了`,
    });
  }
  if (ok && roll(ev, 4, 4) === 0) {
    const them = ev.participants.find((x) => x !== PLAYER_ID);
    const npc = them ? l.entities.people.find((p) => p.id === them) : undefined;
    if (npc) {
      out.push({
        dim: 'the_resonance_of_the_other',
        action: 'produce',
        item: '',
        person: npc.id,
        desc: `${npc.name} 说：这件事我记着`,
      });
    }
  }
  if (tier === '大失败' && roll(ev, 5, 3) === 0) {
    const open = l.vouchers.find((v) => v.dim === 'the_great_achievement' && v.recalled_day === null);
    if (open) {
      out.push({
        dim: 'the_great_achievement',
        action: 'recall',
        item: open.item,
        person: '',
        desc: '那件东西后来没能留住',
      });
    }
  }
  return out;
}

function deltaFor(ev: GameEvent, tier: Tier | null, l: Ledger, rng: Rng): RawResolution {
  const ops: unknown[] = [];
  const who = ev.handler ?? 'npc001';
  const me = l.entities.people.find((p) => p.id === who);

  const hpNow = me?.hp ?? 3;
  const sanNow = me?.san ?? 3;

  // 投入金币的实际消耗（≤ 托管上限 P ⇒ 结算时按 `settleEscrow` 退差额）
  if (ev.min_gold > 0 && tier !== '大失败') {
    const cost = rng.int(ev.min_gold);
    if (cost > 0) ops.push({ gold: -cost });
  }

  if (tier === '大失败') {
    ops.push({
      change: {
        who,
        hp: hpNow > 1 ? -1 : 0,
        san: sanNow > 1 ? -1 : 0,
        attrs: [],
        in_your_eyes: '他第一次让你失望',
        openness: -2,
      },
    });
  } else if (tier === '大成功') {
    ops.push({ rep: { 侠名: 1 } });
    ops.push({
      change: {
        who,
        hp: hpNow < 3 ? 1 : 0,
        san: sanNow < 3 ? 1 : 0,
        attrs: [{ attr: ev.hint_attr[0] ?? '智慧', delta: 1 }],
        in_your_eyes: '你让他心服',
        openness: 3,
      },
    });
    // 大成功时偶尔冒出一件新东西 —— 顺带压 id 分配与临时编号改写
    if (rng.int(2) === 1) {
      ops.push({
        entities: {
          items: [
            { id: '@it1', kind: '特殊物品', name: '半截钥匙', desc: '断口很新', attr_bonus: [], holder: '' },
          ],
        },
      });
    }
  } else if (tier === '困难成功' || tier === '成功') {
    ops.push({ gold: 1 });
  } else {
    ops.push({
      change: { who, hp: 0, san: sanNow > 1 ? -1 : 0, attrs: [], in_your_eyes: '他记住了这次难堪', openness: -1 },
    });
  }

  // 约 1/5 故意给一个**混键 op**（`anyOf` 不保证互斥，Phase 0 实测 7 次中 2 次）
  // —— 用来证明规则层的拆键在整条主循环里真的兜住了。
  if (rng.int(5) === 1) {
    ops.push({ gold: 1, rep: { 怪名: 1 } });
  }

  return {
    narration: '（假叙事）',
    delta: { ops } as RawResolution['delta'],
    summary: `${who} 在 ${ev.title} 上${tier ?? '了结'}`,
    next_seeds: rng.int(3) === 1 ? [`${ev.title} 的后续`] : [],
    // ⑤ 覆盖率驱动：**夹具假设 ⑤** —— 凭证（见 `vouchersFor` 顶栏）
    vouchers: vouchersFor(ev, tier, l),
    // ⑤ 覆盖率驱动：**未破 60 恒「得偿」**（+4/次 ⇒ 从 0 起约 15 次结算内必破 60）；
    //    破了 60 回随机池（期望略负 ⇒ 欲念自然回落，不会一路顶进欲念窗口）。判断读的是
    //    **结算前**的账本值 —— 与规则层「先有欲念、再落欲向」的顺序一致。
    // ⚠️ 2026-10-05：这里原先引 `rules/desire.ts·REWRITE_THRESHOLD`，而那个常量**已随
    //    `rewrite_desire` 侧链一起删掉**（用户裁定：欲望命题一生只写一次）⇒ 整个模块
    //    加载即抛 `does not provide an export named 'REWRITE_THRESHOLD'`，**整个项目跑不起来**。
    //    ⇒ 阈值**下沉成夹具自己的常量**：它从来不是规则层的口径，只是"夹具怎么造欲念漂移"
    //    这一个夹具的内部参数。**数值一字未改（60），夹具行为与此前逐字相同。**
    欲向: l.desire.value < FAKE_DESIRE_SATISFIED_MAX ? '得偿' : DESIRE_POOL[rng.int(DESIRE_POOL.length) - 1],
  };
}

export function fakeBrain(
  /** 结算用的随机源。**假 brain 自己拿一个** —— 真实 LLM 的 `settle` 没有 rng 参数（它不需要） */
  settleRng: Rng = makeRng(20260918),
  /** 强制裁定结果（默认「投骰」= Phase 1 的行为）。测试一段式路径时用得上。 */
  forcedVerdict?: Verdict,
): Brain & { stats: { mixed: number } } {
  const stats = { mixed: 0 };
  return {
    stats,

    /**
     * 假裁定半：默认「投骰」，参与属性取事件卡的 `hint_attr`
     * （= 《契约.md》§6.5「`participants` 默认取事件卡的 `hint_attr`」，也是 Phase 1 的行为）。
     */
    async adjudicate(ev): Promise<Adjudication> {
      const verdict: Verdict = forcedVerdict ?? '投骰';
      const check: Check = {
        verdict,
        participants: verdict === '投骰' ? (ev.hint_attr.length > 0 ? [...ev.hint_attr] : ['智慧']) : [],
        difficulty: ev.difficulty,
        direct_result: '无',
      };
      return { intent_summary: `（假裁定）${ev.title}`, check, continuation: null };
    },

    async settle(ev, l, _h, _adj, input) {
      return deltaFor(ev, input.tier, l, settleRng);
    },

    /**
     * 假**忽略结算** —— 事件没人处理、等到过期时那一次（2026-09-18）。
     * ⚠️ 刻意**不给档位**（忽略没有成败可言）⇒ `deltaFor(ev, null, …)` 走它的 `else` 分支：
     *    一条"不好看的后果"（在场者 SAN −1 / 印象变差）。这就是"忽略是要付代价的"的夹具替身 ——
     *    真实 LLM 那侧由 prompt 里的"根据这件事的重要程度"承担。
     */
    async ignore(ev, l) {
      const r = deltaFor(ev, null, l, settleRng);
      r.summary = `无人处理「${ev.title}」，事情自己过去了`;
      return r;
    },

    async composeDay(l, rng): Promise<RawComposeOutput> {
      return fakeComposeDay(l, rng);
    },

    /**
     * 假**玩家自建**（`compose_day` **单条版** · 时间线 T2-d）—— 见 `fakeCreateEvent`。
     * ⚠️ 它**不收 `rng`**：自建不该消费正文那条随机流（理由写在那条函数顶上）。
     */
    async createEvent(_l, approach): Promise<RawComposeOutput> {
      return fakeCreateEvent(approach);
    },

    /**
     * 假**章节占卜**（`chapter_shift` 侧链 · 每章一次）—— 与 `opening` 同一条纪律：
     * **输入决定输出**（同样的牌 ⇒ 同样的结果），可复现、且真的走 `applyChapterShift` 的校验。
     *
     * ⚠️ 它**故意不自己判「命中原卡」** —— 那条规则在 `rules/chapter-shift.ts`。
     *    夹具若自己算一遍，`resolveDesireChange` 的双轨就**永远不会**被离线路径走到
     *    （又一个"绿了但没测到"）。这里只做模型该做的事：**读牌 + 判相关性 + 写文案**。
     * ⚠️ 相关性的量级刻意压在 **−5 ~ +5**：真模型绝大多数也该落在"无关"附近。
     *    这样"命中 ⇒ 查表 ±10"那条支路才是欲念轨迹里真正起作用的那个变量 ——
     *    若夹具动辄给 ±20，28 天基线会被它顶得四处乱跑，那测的就不是这条链本身了。
     * ⚠️ 判定走 `hashText()`（**不用 rng**）—— 与 `vouchersFor` 同一条纪律。
     * ⚠️ 文案长度**必须 ≤30 字**（`AMBIENCE_MAX`）：超了会被落地层拒、这一章的占卜就白跑。
     *    当前模板最坏情况（两个四字牌名）＝ 24 字。
     */
    async chapterShift(_l, cards): Promise<RawChapterShiftOutput> {
      const label = (i: 0 | 1) => `${cards[i].name}${cards[i].reversed ? '逆' : '正'}`;
      const salt = `${label(0)}|${label(1)}`;
      return {
        章节欲念变化: (hashText(salt) % 11) - 5,
        章节氛围: `「${cards[0].name}」与「${cards[1].name}」交错，王城气数正挪。`,
      };
    },

    /**
     * 假**概要归并**（`archive` 侧链 · 全局约 2~3 次）—— 把待归并的几天拼成一段。
     *
     * ⚠️ 必须**确定性**（不用 `rng`）—— 与 `vouchersFor` 的判定同一条纪律：
     *    往正文那条 `rng` 里插随机数会把三个基线种子的 28 天轨迹整体挪走。
     * ⚠️ 产物**真的必须 ≤300 字**：夹具若吐超长段，落地层会拒 ⇒ 覆盖率驱动红成"夹具坏了"，
     *    而那看起来非常像"代码坏了"。⇒ 这里自己先按码点截断。
     */
    async archive(_l, plan): Promise<RawArchiveOutput> {
      const head = `〔归档〕第 ${plan.days[0]}~${plan.days[plan.days.length - 1]} 天：`;
      const body = plan.items.map((r) => r.text).join('');
      return { 归档段: [...(head + body)].slice(0, 300).join('') };
    },

    /**
     * 假**终局叙事**（`ending` 侧链 · 全局至多 1 次）—— 只在成功结局被叫到。
     *
     * ⚠️ 必须**确定性**（不用 `rng`）—— 与 `vouchersFor` / `archive` 的判定同一条纪律：
     *    往正文那条 `rng` 里插随机数会把三个基线种子的 28 天轨迹整体挪走。
     * ⚠️ 产物**真的必须落在区间里**：判词 100~200 字。
     *    夹具若吐不合规的量，落地层会拒 ⇒ 覆盖率驱动红成"夹具坏了"，
     *    而那看起来非常像"代码坏了"。⇒ 这里自己先按码点截断到保险的 180 字
     *    （**留出余量**，别正好卡在 200 那个端点上）。
     *
     * ⚠️⚠️ **2026-10-06 用户裁定：模型只输出一段纯文本。**
     *   · `结局标题` **不再返回** —— 标题由**规则层**在 `finalEndingOf` 里写定
     *     （`FLAVOR_NAMES` 两档：得偿所愿 / 差一步美满），模型碰不到。
     *   · `结局话术` 改名 **`结局判词`**。
     *   ⇒ 以前那句"标题刻意**不等于**分类名"的前提**已不存在**（标题就是分类名那一档），
     *     注释一并退休。
     */
    async ending(l): Promise<RawEndingOutput> {
      const e = l.ending!;
      const base = `（假结局）这一局的成果落进了格子，${l.desire.proposition || '他想要的那件事'}算是有了回音。`;
      let text = '';
      while ([...text].length < ENDING_TEXT_MIN) text += base;
      text = [...text].slice(0, Math.min(ENDING_TEXT_MAX, 180)).join('');
      return { 结局判词: text };
    },

    // ── 多轮「穿越」（2026-10-07 起**每轮一次调用**，不掷骰）────────────
    //
    // ⚠️ 夹具在这里**刻意只做一件事**：让"末轮自行收束 ⇒ 省掉收尾那次调用"这条支路
    //    默认就被走到（第 3 轮 `scene_over=true`，早于 `SCENE_ROUND_CAP = 7`）。
    //    "轮数用尽才收尾"那条支路**不在这里演示** —— 它由 `scene.test.ts`
    //    用一个专用 brain 定点验证；混进通用夹具只会让每次跑到的轮数变成运气。

    /**
     * 假**场景一轮** —— 纯叙事、无裁定半。
     * 第 `SCENE_OVER_AT` 轮让场景自然收束，并**一并填好** `summary` / `next_seeds`
     * （那是"省掉收尾调用"的**唯一依据**，缺一个就省不掉）。
     */
    async sceneTurn(ev, l, _h, view, conv): Promise<SceneStep<RawResolution>> {
      const SCENE_OVER_AT = 3;
      const r = deltaFor({ ...ev, handler: PLAYER_ID }, '成功', l, settleRng);
      r.narration = `（假场景叙事 · 第 ${view.round} 轮）`;
      r.scene_over = view.round >= SCENE_OVER_AT;
      if (r.scene_over) {
        r.summary = `（假场景小结）${ev.title} 在第 ${view.round} 轮收束`;
        r.next_seeds = [`${ev.title} 的余波`];
      }
      // ⚠️ §2.4：第一轮之前 `conv` 是 `null` ⇒ 夹具要把它**换成一个真对象**（真 brain 也是
      //    这么做的 —— 每轮都往里存 `user → assistant → tool` 三元组），不能原样透传 null。
      return { value: r, conv: { 轮: view.round, 前情: conv } };
    },

    /** 假**收尾** —— 走到这里说明末轮没能自行收束（退出 / 轮尽）。 */
    async sceneWrap(ev, l, reason, _view, conv): Promise<SceneStep<RawResolution>> {
      const r = deltaFor({ ...ev, handler: PLAYER_ID }, '成功', l, settleRng);
      r.narration = `（假收尾 · ${reason}）`;
      r.scene_over = true;
      r.summary = `（假收尾小结 · ${reason}）${ev.title}`;
      return { value: r, conv };
    },
  };
}
