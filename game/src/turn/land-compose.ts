// **落地层**：`compose_day` 的**原始输出** → 账本里的 `GameEvent`
//
// 为什么这一层不能省（三条，每条都是实测换来的）：
//   ① **服务端不校验模型输出**：`enum` / `minimum` / `integer` / 嵌套 object 类型一律原样放行
//      （Phase 0 §三 实测）⇒ 规则层是**唯一防线** ⇒ `Delta` 必须过 `validateDelta`、
//      枚举必须 `oneOf` 收口、区间必须钳制。**"description 写清楚了"不算防线。**
//   ② **id 的所有权全在系统**：模型只写本地编号 `e1 / e2`；全局 id 由这里发，
//      并且**同批内所有对本地编号的引用**（`options[].trigger`）必须在同一次落地里一并改写。
//   ③ **两个通道按结构分**：档 A **不带 `tier`**、带 `options`；档 B/C 反之。
//      ⇒ 判别符是"有没有 `tier`"，**不靠模型自报**（它报错也没人拦）。见 `schema/compose.ts`。
//
// 三条落地纪律：
//   · **能钳就钳，不整条作废**（与 `validateDelta` 同口径，demo 容错优先）；
//     只有"结构上无法修补"的（本地编号非法 / 档 A 一个选项都没有）才丢弃该条。
//   · **`events.hidden` 是 `trigger` 的归宿**：被别的选项引用为 `trigger` 的事件**不进 `live`** ——
//     它在玩家点选那一刻才现身（见 `turn/simulate.ts·clickPopup`）。
//     血统**单向**（父指子）：被触发的子事件**绝不回填父 id**，双向写会互相漂移。
//   · **种子是"声明式消费"**：`seed_id` 匹配上才算承接；**软种子当天没人承接即丢弃**，
//     **硬种子**（checkpoint）没被承接要**报进 `problems`** —— "必出"不是靠自觉。
//     ⚠️ 「必出」还有另一半在 ①：**承接硬种子的事件不占 `FREE_EVENT_CAP`**
//        ——
//        少了那半，"必出"会被条数兜底静默吃掉。
//
// ⚠️ 本模块**会就地改传入的账本**（`events` / `seeds` / `entities.places` / `idWatermark`），
//    与 `ledger/apply.ts·applyDelta` 同风格。调用点**恰好两个**（由 `LandComposeOptions.mode` 分）：
//      · `'day'`    = `turn/t0.ts·enterDay` —— 换日生成，每天一次；
//      · `'create'` = `turn/create.ts·createEvent` —— 玩家自建，一天可能多次。
//    后者走的是**同一个函数**（它的输出形状与生成半逐字相同，只是 `popup_events` 恒为空数组），
//    两条路的分岔**只有两处、都写在下面的注释里**（① 收口径 / ⑦ 种子收口）——
//    没有任何理由开第二个落地函数。
import {
  ATTR_KEYS,
  DIFFICULTIES,
  DISPATCHABLES,
  POPUP_DESIRE_TIERS,
  type AttrKey,
  type DesireTier,
  type Difficulty,
  type Dispatchable,
} from '../contract/types.ts';
import { isEventTempId } from '../contract/tempids.ts';
import { validateDelta } from '../contract/validate.ts';
import { allocatorFor } from '../ledger/ids.ts';
import type { EventOption, GameEvent, Ledger } from '../ledger/types.ts';
import { FREE_EVENT_CAP, MULTIROUND_CAP } from '../schema/compose.ts';
import type { RawComposeOutput } from './brain.ts';

export interface ComposeLanded {
  /** 落地后**直接进事件池**的（玩家立刻看得见） */
  live: GameEvent[];
  /** 被某条选项的 `trigger` 引用过 ⇒ 先藏在 `events.hidden`，点选那一刻才现身 */
  hidden: GameEvent[];
  /** 落地报告（编号改写 / 钳制 / 丢弃 / 种子核销），逐条人话 —— 直接进 T0 的 log */
  log: string[];
  /** **硬问题** —— 不该发生、发生了要有人看见（如硬种子没人承接） */
  problems: string[];
}

/**
 * 落地模式 —— **两个调用点唯一的分岔**。
 *
 * ⚠️ 它不是"严格程度"的开关（两边**一样严**："能钳就钳、不整条作废"，`Delta` 都过
 *    `validateDelta`、枚举都 `oneOf` 收口）—— 分的是**额度**与**种子池收口**这两件事：
 *      · `'day'`    = T0 换日生成：受 `FREE_EVENT_CAP` 条数硬顶；**做种子池收口**
 *                     （软种子未承接即丢 / 硬种子未承接要报 `problems`）；
 *      · `'create'` = 玩家自建：**豁免条数检测**
 *                     ⇒ 根本不进那个循环；种子**只核销、不收口**（收口是 T0 那一次的事）。
 * ⚠️ 默认 `'day'`：老调用点一行都不用改，而"忘了传"的后果是回到 T0 那套
 *    —— 两边里更严的一半（条数硬顶照样生效），不会静默放水。
 */
export type LandComposeMode = 'day' | 'create';

export interface LandComposeOptions {
  mode?: LandComposeMode;
}

// ── 小工具（与 `contract/validate.ts` 同口径：能钳就钳）──────────

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function oneOf<T extends string>(v: unknown, pool: readonly T[], fallback: T): T {
  return typeof v === 'string' && (pool as readonly string[]).includes(v) ? (v as T) : fallback;
}

const CANVAS_TIERS = ['B', 'C'] as const;

/** `cost` 的挡位：**只有 `0 / 1 / 2 / 4` 与 4 的倍数**—— 没有"一天半" */
const COST_STEPS: readonly number[] = [0, 1, 2, 4, 8, 12, 16, 20];
/** `deadline` 的挡位：`1 / 2 / 4` **天** —— **没有 3 天**（这是"过期只落在日界上"的前提） */
const DEADLINE_STEPS: readonly number[] = [1, 2, 4];

function normalizeCost(v: unknown): number {
  const n = clampInt(v, 0, 20, 2);
  if (COST_STEPS.includes(n)) return n;
  if (n > 4) return Math.min(20, Math.floor(n / 4) * 4); // 5~7 → 4；9~11 → 8
  return n <= 1 ? 1 : n <= 2 ? 2 : 4; // 3 → 4
}

function normalizeDeadline(v: unknown): number {
  const n = clampInt(v, 1, 4, 2);
  if (DEADLINE_STEPS.includes(n)) return n;
  return n <= 1 ? 1 : n <= 2 ? 2 : 4; // 3 → 4
}

/** 一条已被接受（形状合法、编号已发）的待落地事件 */
interface Accepted {
  kind: 'popup' | 'canvas';
  o: Record<string, unknown>;
  local: string;
  gid: string;
}

// ── 落地 ──────────────────────────────────────────────────────

export function landCompose(
  l: Ledger,
  raw: RawComposeOutput,
  o: LandComposeOptions = {},
): ComposeLanded {
  const mode: LandComposeMode = o.mode ?? 'day';
  const log: string[] = [];
  const problems: string[] = [];

  // ⚠️ 水位自愈：账本里若已经有 `e<n>`（手写夹具 / 旧存档），先把水位抬到它之上 ——
  //    `formatEventId` 是单调的，撞号 = 两个事件共用一个 id（那会静默串掉 pending 与 trigger）。
  for (const e of [...l.events.live, ...l.events.hidden]) {
    const m = /^e(\d+)$/.exec(e.id);
    if (m) l.idWatermark.event = Math.max(l.idWatermark.event, Number(m[1]));
  }
  const alloc = allocatorFor(l.idWatermark); // 与 `l.idWatermark` **共享同一个对象** ⇒ 就地推进水位

  const popupsRaw = raw?.popup_events;
  const canvasesRaw = raw?.canvas_events;
  if (!Array.isArray(popupsRaw) || !Array.isArray(canvasesRaw)) {
    log.push('落地：`popup_events` / `canvas_events` 不是数组 ⇒ 缺的那个按空数组处理');
  }

  // ── ① 收口径：形状过滤 + **条数硬顶** ─────────────────────────
  //    ⚠️ 硬顶要在源头就设，但**规则层还得再兜一次** ——
  //       模型超产时以"先来的"为准：自由事件 ≤5、档 C ≤1 条/天。
  //
  //    ⚠️ **硬种子豁免条数上限**（2026-09-19 · P4-E）
  //       「硬种子（checkpoint）**不占条数上限、不占行动点预算**，额外叠加在自由事件之上」。
  //       判据 = 这条事件声明的 `seed_id` 落在**硬种子**池里 —— 与 ⑤ 的 `claimSeed` 是
  //       **同一条键**（不另开一个"猜哪条是硬种子"的口径）。
  //       ⚠️ 不豁免的话，"必出"会被这条兜底**静默吃掉**：模型产满 5 条自由事件
  //          ＋ 1 条承接硬种子的事件 ⇒ 第 6 条被丢 ⇒ 硬种子没人承接 ⇒ 只留下一条
  //          「硬种子没人承接」的警告，而真实原因（配额）没人看得见。
  const cands: Array<{ kind: 'popup' | 'canvas'; o: Record<string, unknown> }> = [];
  if (mode === 'create') {
    // ⚠️ **玩家自建 = 只认 1 条 `canvas_event`**
    //    · `popup_events` 一律填空数组」）。规则层是**唯一防线**（服务端对输出完全不校验，
    //    Phase 0 §三）⇒ 不能指望模型听话：多产的档 A 全丢、canvas 多产的只认第 1 条。
    //    ⚠️ 自建的档 A 为什么不能收：档 A 是"强制弹窗"（闸门 ④ 会拦下当天的一切）——
    //       玩家敲一句话就凭空冒出一个弹窗，等于把闸门 ④ 交给玩家自己按。
    const popupN = asArr(popupsRaw).length;
    const canvasObjs = asArr(canvasesRaw).filter(isObj);
    if (popupN > 0) log.push(`落地：玩家自建只产 canvas_events（收到 ${popupN} 条档 A）⇒ 全部忽略`);
    if (canvasObjs.length > 1) {
      log.push(`落地：玩家自建只填 1 条 canvas_event（收到 ${canvasObjs.length} 条）⇒ 只认第 1 条`);
    }
    if (canvasObjs.length === 0) log.push('落地：玩家自建一条 canvas_event 都没有 ⇒ 这次自建没有产出事件');
    if (canvasObjs.length > 0) cands.push({ kind: 'canvas', o: canvasObjs[0] });
  } else {
    for (const e of asArr(popupsRaw)) if (isObj(e)) cands.push({ kind: 'popup', o: e });
    for (const e of asArr(canvasesRaw)) if (isObj(e)) cands.push({ kind: 'canvas', o: e });
    const shapeDropped =
      (Array.isArray(popupsRaw) ? popupsRaw.length : 0) +
      (Array.isArray(canvasesRaw) ? canvasesRaw.length : 0) -
      cands.length;
    if (shapeDropped > 0) log.push(`落地：丢弃 ${shapeDropped} 条非对象事件（形状错）`);
  }

  const kept: typeof cands = [];
  if (mode === 'create') {
    // ⚠️ **玩家自建豁免条数检测**（《规则.md》:100 / 《契约.md》:1120：「不占自由事件条数
    //    （`N ≤ 5`）、不进行动点预算（`L`）的核算」）⇒ **整段跳过**下面那个 `FREE_EVENT_CAP` 循环。
    //    正确做法是"根本不进那个循环"，而不是"进去再豁免" —— 后者会顺手把 `freeKept` 的读数
    //    搅成"今天已经用掉几个名额"，而那个数**没有任何人读**（`dispatchBlock` 读的是 `calcL`）。
    //    此时 `cands` 已经被上面收成"至多 1 条 canvas"。
    //    （档 C ≤1/天的 `MULTIROUND_CAP` 同样不适用于自建：那是生成侧"一天别塞两个大场面"
    //      的编排纪律，玩家自己点的那一个不该被它顶掉。）
    kept.push(...cands);
  } else {
    /** 本日池子里的硬种子编号 —— 只有它们能豁免 `FREE_EVENT_CAP` */
    const hardCodes = new Set(l.seeds.filter((s) => s.source === '硬种子').map((s) => s.code));
    let freeKept = 0;
    let overCap = 0;
    let overMulti = 0;
    let multiSeen = 0;
    let hardKept = 0;
    for (const c of cands) {
      if (hardCodes.has(asStr(c.o.seed_id).trim())) {
        hardKept += 1; // 硬种子：**不占** `FREE_EVENT_CAP`（额外叠加）
      } else {
        if (freeKept >= FREE_EVENT_CAP) {
          overCap += 1;
          continue;
        }
        freeKept += 1;
      }
      if (c.kind === 'canvas' && oneOf(c.o.tier, CANVAS_TIERS, 'B') === 'C') {
        multiSeen += 1;
        if (multiSeen > MULTIROUND_CAP) {
          overMulti += 1;
          continue;
        }
      }
      kept.push(c);
    }
    if (overCap > 0) log.push(`落地：丢弃 ${overCap} 条超出「自由事件 ≤${FREE_EVENT_CAP}」的事件`);
    if (overMulti > 0) log.push(`落地：丢弃 ${overMulti} 条超出「档 C ≤${MULTIROUND_CAP}/天」的事件`);
    if (hardKept > 0) {
      log.push(`落地：其中 ${hardKept} 条承接硬种子 ⇒ **不占**「自由事件 ≤${FREE_EVENT_CAP}」的额度（额外叠加）`);
    }
  }

  // ── ② 本地编号 → 全局 id（**同批引用必须在这一次里一并改写**）──
  const idMap = new Map<string, string>();
  const accepted: Accepted[] = [];
  for (const c of kept) {
    const local = asStr(c.o.id).trim();
    if (!isEventTempId(local)) {
      log.push(`落地：丢弃一条事件 —— 本地编号 ${JSON.stringify(c.o.id)} 不是「e + 数字」（第 4 项 格式）`);
      continue;
    }
    if (idMap.has(local)) {
      log.push(`落地：丢弃一条事件 —— 本地编号 ${local} 与同批另一条重复（只认先来的那条）`);
      continue;
    }
    const gid = alloc.nextEvent();
    idMap.set(local, gid);
    accepted.push({ kind: c.kind, o: c.o, local, gid });
  }

  // ── ③ 谁被 `trigger` 引用 ⇒ 谁进 `hidden` ─────────────────────
  //    ⚠️ 先**整批扫完再转** —— "进 live 还是 hidden"是个**批级**决定，不能边转边定
  //       （子事件可能排在父事件前面，边转边定会漏）。
  const referenced = new Set<string>();
  for (const a of accepted) {
    if (a.kind !== 'popup') continue;
    // ⚠️ **至多 1 个**（契约封住触发爆炸）⇒ 只看**第一个非空**的那个，而且必须与 ⑥ 的转换
    //    用**同一条判据**：否则被忽略的第二个 `trigger` 会把它的目标也锁进 `hidden`，
    //    而那条事件**永远没人唤醒** —— 成了黑洞（玩家既看不见、也点不出来）。
    for (const ro of asArr(a.o.options)) {
      if (!isObj(ro)) continue;
      const t = asStr(ro.trigger).trim();
      if (t === '') continue;
      if (idMap.has(t)) referenced.add(t);
      break;
    }
  }
  for (const t of referenced) {
    if (!idMap.has(t)) {
      log.push(`落地：某个 trigger 指向的本地编号 ${t} 不在本批（或已被丢弃）⇒ 按「不触发」处理`);
    }
  }

  // ── ④ 地点名 → 地点 id（**顺手补登记**）──────────────────────
  //    ⚠️ `compose_day` 的事件**本体**没有 `entities` 字段（它只在选项 `delta` 里）⇒
  //       stage 的新地点没有直接落点。2026-10-09 起 schema 的 stage 说明已改为
  //       「直接写新名字即可，系统自动登记；不要塞进选项 delta 的 entities.places」，
  //       与这里的代劳机制对齐：名字没注册过就发一个 `loc` 号建上。
  //       不做的话，`stage` 里会出现一个**查无此地的名字**，而 `location` 只能填 null。
  const placeCache = new Map<string, string>();
  function resolvePlace(name: string): string | null {
    const trimmed = name.trim();
    if (trimmed === '') return null;
    const cached = placeCache.get(trimmed);
    if (cached) return cached;
    const hit = l.entities.places.find((p) => p.name === trimmed);
    if (hit) {
      placeCache.set(trimmed, hit.id);
      return hit.id;
    }
    const id = alloc.next('loc');
    l.entities.places.push({ id, etype: 'place', name: trimmed, desc: '' });
    placeCache.set(trimmed, id);
    log.push(`落地：新地点「${trimmed}」→ ${id}（事件本体没有 entities 字段 ⇒ 登记由规则层代劳）`);
    return id;
  }

  // ── ⑤ 种子核销（声明式消费：《契约.md》§6.4「设计说明」）────────
  const claimed = new Set<string>();
  function claimSeed(rawSeedId: unknown, label: string): void {
    const code = asStr(rawSeedId).trim();
    if (code === '') return;
    const hit = l.seeds.find((s) => s.code === code);
    if (!hit) {
      // ⚠️ 填了 `e*` 或列表外的编号 ⇒ 按「未承接」忽略，**不报错**（契约明写允许留空 / 乱填）
      log.push(`落地：${label} 声明的 seed_id = ${code} 不在本次种子列表 ⇒ 按「未承接」处理`);
      return;
    }
    if (!claimed.has(code)) log.push(`落地：种子 ${code}「${hit.title}」被 ${label} 承接`);
    claimed.add(code);
  }

  // ── ⑥ 逐条转换 ──────────────────────────────────────────────
  function toPopupEvent(a: Accepted): GameEvent | null {
    const o = a.o;
    const title = asStr(o.title);
    const label = `档 A「${title || a.local}」(${a.local})`;
    const rawOpts = asArr(o.options);
    if (rawOpts.length === 0) {
      log.push(`落地：丢弃 ${label} —— 一个选项都没有（没有可点的地方，它进不了 UI）`);
      return null;
    }
    if (rawOpts.length > 3) log.push(`落地：${label} 有 ${rawOpts.length} 个选项 ⇒ 只留前 3 个（输出量硬顶）`);

    let triggerUsed = false;
    const options: EventOption[] = [];
    for (let i = 0; i < Math.min(rawOpts.length, 3); i++) {
      const ro = rawOpts[i];
      if (!isObj(ro)) {
        log.push(`落地：丢弃 ${label} 的第 ${i + 1} 个选项（不是对象）`);
        continue;
      }
      const t = asStr(ro.trigger).trim();
      let trigger: string | null = null;
      if (t !== '') {
        if (triggerUsed) {
          log.push(`落地：${label} 第 ${i + 1} 个选项也带 trigger=${t} ⇒ 忽略（同一条**至多 1 个**，封住触发爆炸）`);
        } else {
          // ⚠️ 名额**先占后用**：无论能不能映射上，第一个非空 `trigger` 都把这个名额用掉 ——
          //    否则"第一个映射不上、第二个却生效"会让 ③ 的 `referenced` 与这里判据不一致，
          //    结果是：子事件留在 `live` 里没人藏，而某个选项的 `trigger` 指着它却什么都不会发生。
          triggerUsed = true;
          const gid = idMap.get(t);
          if (gid) trigger = gid;
          else log.push(`落地：${label} 第 ${i + 1} 个选项的 trigger=${t} 不在本批 ⇒ 按「不触发」处理`);
        }
      }
      const v = validateDelta(ro.delta);
      for (const f of v.fixes) log.push(`落地：钳制 ${label} 第 ${i + 1} 个选项的 delta —— ${f.path} ${f.detail}`);
      for (const d of v.drops) log.push(`落地：拦下 ${label} 第 ${i + 1} 个选项的 delta —— ${d.path} ${d.reason}`);
      options.push({
        // schema 的 `label` → 账本的 `text`：两处名字各自贴合自己的读者
        // （前者给模型看"按钮"，后者给 UI 看"选项文字"）
        text: asStr(ro.label),
        result_text: asStr(ro.result_text),
        summary: asStr(ro.summary),
        欲向: oneOf<DesireTier>(ro.欲向, POPUP_DESIRE_TIERS, '无关'),
        delta: v.delta,
        trigger,
      });
    }
    if (options.length === 0) {
      log.push(`落地：丢弃 ${label} —— 3 个选项里没有一个能解析成对象`);
      return null;
    }
    claimSeed(o.seed_id, label);
    const stageName = asStr(o.stage);

    return {
      id: a.gid,
      title: title || '（无题）',
      content: asStr(o.content),
      stage: stageName,
      location: resolvePlace(stageName),
      tier: 'A',
      // 档 A 没有参与者（点击即结算）⇒ 处理方式限制对它无意义，恒「两者皆可」
      dispatchable: '两者皆可',
      // 档 A 没有参与者（点击即结算）⇒ 无人可指定
      required_person: '',
      cost: 0,
      min_gold: 0,
      min_people: 0,
      max_people: 0,
      // 档 A **恒 1 且永不过期**（它只受"当天必须清"约束 ⇒ 根本走不到过期）
      deadline: 1,
      options,
      delta: null,
      hint_attr: [],
      difficulty: '无修正',
      status: '待处理',
      created_day: l.clock.day,
      started_at: null,
      reveal_at: null,
      handler: null,
      participants: [],
      gold_locked: 0,
      depart_cost: null,
    };
  }

  function toCanvasEvent(a: Accepted): GameEvent {
    const o = a.o;
    const title = asStr(o.title);
    const tier = oneOf(o.tier, CANVAS_TIERS, 'B');
    const label = `档 ${tier}「${title || a.local}」(${a.local})`;
    if (o.tier !== 'B' && o.tier !== 'C') {
      log.push(`落地：${label} 的 tier = ${JSON.stringify(o.tier)} 不是 B / C ⇒ 按 B 处理`);
    }

    const hints = asArr(o.hint_attr).filter(
      (x): x is AttrKey => typeof x === 'string' && (ATTR_KEYS as readonly string[]).includes(x),
    );
    if (hints.length === 0) {
      // ⚠️ 这里**不编一个默认属性** —— 兜底只有一处（`turn/handle.ts`：`hint_attr` 空则按「智慧」）。
      //    在这儿再兜一次 = 同一个默认值有两个事实源。
      log.push(`落地：${label} 没给出可用的 hint_attr ⇒ 留空（判定时按「智慧」兜底，见 turn/handle.ts）`);
    }
    if (hints.length > 3) log.push(`落地：${label} 给了 ${hints.length} 个 hint_attr ⇒ 只留前 3 个（calcA 上限）`);

    const minPeople = clampInt(o.min_people, 1, 5, 1);
    let maxPeople = clampInt(o.max_people, 1, 5, Math.max(minPeople, 3));
    if (maxPeople < minPeople) {
      log.push(`落地：${label} 的 max_people(${maxPeople}) < min_people(${minPeople}) ⇒ 抬到 ${minPeople}`);
      maxPeople = minPeople;
    }
    const cost = normalizeCost(o.cost);
    if (cost !== o.cost) {
      log.push(`落地：${label} 的 cost = ${JSON.stringify(o.cost)} → ${cost}（挡位只有 0/1/2/4 与 4 的倍数）`);
    }
    const deadline = normalizeDeadline(o.deadline);
    if (deadline !== o.deadline) {
      log.push(`落地：${label} 的 deadline = ${JSON.stringify(o.deadline)} → ${deadline}（按天的挡位只有 1/2/4）`);
    }
    const dispatchable = oneOf<Dispatchable>(o.dispatchable, DISPATCHABLES, '两者皆可');
    if (o.dispatchable !== undefined && dispatchable !== o.dispatchable) {
      log.push(`落地：${label} 的 dispatchable = ${JSON.stringify(o.dispatchable)} 不在枚举内 ⇒ 按「两者皆可」处理`);
    }
    // ⑤ **非他不可**（2026-09-22 落地）：LLM 只填人物编号；**认不出来就按「未指定」忽略** ——
    //    与 `seed_id` 填错编号同款处置（不静默、也不当场抛）。
    //    ⚠️ 语义是「必须包含他」，不是「只能是他」；拦不拦由闸门 ③ 按**当下的参与者**判。
    //    ⚠️ 2026-10-07 用户报「感觉这个逻辑还没做好」的第二条根因：模型**常把名字填进来**
    //       （"皮普"而不是 "npc003"）⇒ 此前一律按「未指定」静默丢弃 —— 闸门永远不拦、
    //       卡面那颗「非 X 不可」永远不出现。⇒ 编号认不出时**再按名字精确匹配一次**，
    //       认得出就解析成编号（留一条日志说明做了这个替换，可追溯）。
    const rawRequired = asStr(o.required_person);
    let requiredPerson = '';
    if (rawRequired) {
      const byId = l.entities.people.find((x) => x.id === rawRequired);
      const byName = byId ? null : l.entities.people.find((x) => x.name === rawRequired);
      if (byId) requiredPerson = byId.id;
      else if (byName) {
        requiredPerson = byName.id;
        log.push(`落地：${label} 的 required_person 填的是名字「${rawRequired}」⇒ 已解析为 ${byName.id}`);
      } else log.push(`落地：${label} 的 required_person = ${JSON.stringify(rawRequired)} 不在实体表里 ⇒ 按「未指定」忽略`);
    }
    claimSeed(o.seed_id, label);
    const stageName = asStr(o.stage);

    return {
      id: a.gid,
      title: title || '（无题）',
      content: asStr(o.content),
      stage: stageName,
      location: resolvePlace(stageName),
      tier,
      dispatchable,
      required_person: requiredPerson,
      cost,
      min_gold: clampInt(o.min_gold, 0, 200, 0),
      min_people: minPeople,
      max_people: maxPeople,
      deadline,
      options: [],
      delta: null,
      hint_attr: hints.slice(0, 3),
      difficulty: oneOf<Difficulty>(o.difficulty, DIFFICULTIES, '无修正'),
      status: '待处理',
      created_day: l.clock.day,
      started_at: null,
      reveal_at: null,
      handler: null,
      participants: [],
      gold_locked: 0,
      depart_cost: null,
    };
  }

  const live: GameEvent[] = [];
  const hidden: GameEvent[] = [];
  for (const a of accepted) {
    const ev = a.kind === 'popup' ? toPopupEvent(a) : toCanvasEvent(a);
    if (!ev) continue;
    (referenced.has(a.local) ? hidden : live).push(ev);
  }

  // ── ⑦ 种子池收口（**每天一次，就在落地这一刻**）────────────────
  //    · 软种子（`LLM`）：被承接 ⇒ 核销；没被承接 ⇒ **当天丢弃**（不跨天，否则池子只涨不消）；
  //    · 硬种子（`硬种子`）：被承接 ⇒ 核销；**没被承接 ⇒ 留着**（它是 checkpoint，明天还得托底）
  //      并**报进 `problems`** —— "必出"不能靠自觉，得有人看见。
  // ⚠️ **玩家自建只「核销」、不「收口」**（`mode: 'create'`）。同一个 `l.seeds = …` 里
  //    其实混着两件事，这里把它拆开：
  //      · 核销 = 把被承接的种子从池里划掉 —— 自建**也允许承接种子**（声明式消费，同 `'day'`）；
  //      · 收口 = 「软种子当天没人承接即丢弃」＋「硬种子没人承接要报 `problems`」——
  //        那是 **T0 落地那一次**的事（一天一次，`'day'` 的语义）。
  //    自建发生在**白天**，再收一次会出两个错：
  //      ① 把当天还没被承接的软种子**提前丢掉** —— "当天作废"指的是"到本日 T0 为止"，
  //         白天丢掉等于把 T0 刚生成的钩子作废（`next_seeds` 那条因果续接当场断掉）；
  //      ② 把同一条「硬种子没人承接」**重复报一遍**（T0 已经报过，`problems` 会翻倍）。
  //    ⇒ 自建只留"核销"那半边。
  const keptSeeds = l.seeds.filter((s) => !claimed.has(s.code));
  if (claimed.size > 0) log.push(`落地：本日承接种子 ${[...claimed].join('、')}`);
  if (mode === 'create') {
    l.seeds = keptSeeds;
  } else {
    const unclaimedHard = keptSeeds.filter((s) => s.source === '硬种子');
    const softDropped = keptSeeds.filter((s) => s.source !== '硬种子').length;
    if (softDropped > 0) log.push(`落地：${softDropped} 条软种子今天没人承接 ⇒ 丢弃（软种子不跨天）`);
    for (const s of unclaimedHard) {
      problems.push(`硬种子「${s.code} ${s.title}」今天没有任何事件承接 —— 硬种子是「必出」，要有人管`);
    }
    l.seeds = unclaimedHard;
  }

  // ── ⑧ 进账本 ────────────────────────────────────────────────
  l.events.live.push(...live);
  l.events.hidden.push(...hidden);
  if (mode === 'create') {
    // 自建的产物一律进 `live`：`canvas_events` 没有 `options` ⇒ 不会被任何 `trigger` 引用
    //（`referenced` 只扫档 A 的 options）⇒ 不可能落进 `hidden`。
    for (const e of live) {
      log.push(
        `落地：玩家自建「${e.title}」进事件池（${e.id} · 档 ${e.tier} · 时长 ${e.cost} 点 · 期限 ${e.deadline} 天）`,
      );
    }
    if (live.length === 0) log.push('落地：这次自建没有事件进池 —— 玩家敲了那句话，但什么也没发生');
  } else if (live.length + hidden.length > 0) {
    log.push(`落地：第 ${l.clock.day} 天 ${live.length} 条进事件池、${hidden.length} 条藏起（等 trigger 唤醒）`);
  }

  return { live, hidden, log, problems };
}
