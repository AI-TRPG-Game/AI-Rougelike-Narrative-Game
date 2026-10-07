// 六项校验 —— Phase 0 §三 的直接产物
//
// 实测结论：服务端**只校验 schema 定义本身是否合法**（定义写错才 400），**对模型的输出完全不校验**：
// `pattern` / `minimum`·`maximum` / `enum` / `integer` 类型 / 嵌套 object 类型 **一概原样放行**。
// ⇒ **规则层是唯一防线**，必须自覆盖六项：类型 / 区间 / 枚举 / 格式 / 键数 / required。
//
// 处置口径：**能钳就钳，不整条作废**（demo 容错优先）。
// 只有"结构上无法修补"的才丢弃该条。
import {
  AFFILIATION_MOVES,
  ATTR_KEYS,
  NEW_PERSON_AFFILIATIONS,
  OP_KEYS,
  REP_KEYS,
  VOUCHER_DIMS,
  type AffiliationMove,
  type AttrBonus,
  type AttrKey,
  type ChangeEntry,
  type Delta,
  type DeltaOp,
  type NewItem,
  type NewPerson,
  type NewPersonAffiliation,
  type NewPlace,
  type Rep5,
  type RepKey,
} from './types.ts';
import { splitMixedOps } from './split.ts';
import { isAnyFormalId, isRoleWord, parseTempId } from './tempids.ts';

/** 全部区间的**唯一事实源** */
export const LIMITS = {
  gold: { min: -9999, max: 9999 },
  hp: { min: -5, max: 5 },
  san: { min: -5, max: 5 },
  attrDelta: { min: -5, max: 5 },
  rep: { min: -20, max: 20 },
  openness: { min: -20, max: 20 },
  attrValue: { min: 1, max: 20 },
  opennessValue: { min: 0, max: 20 },
} as const;

/** `attr_bonus.bonus` 的白名单（README 待实测第 5 条的原始设计意图） */
export const ATTR_BONUS_WHITELIST: readonly number[] = [1, 2, 3, 5];

/** `Item.kind`（**物品大类**）的白名单 */
export const ITEM_KINDS: readonly string[] = ['装备', '消耗品', '特殊物品'];
/** 兜底：大类缺失 / 不在白名单时落到它 —— schema 的 enum **没有哨兵值**，只能挑一个最宽的筐 */
export const ITEM_KIND_FALLBACK = '特殊物品';

export interface Fix {
  path: string;
  kind: 'clamped' | 'filled';
  detail: string;
}

export interface Drop {
  path: string;
  reason: string;
}

export interface ValidatedDelta {
  delta: Delta;
  fixes: Fix[];
  drops: Drop[];
  /** 混键计数（可打点，观察混键率是否随 prompt 调整而变化） */
  mixedCount: number;
  unknownKeys: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v);
}

class Ctx {
  fixes: Fix[] = [];
  drops: Drop[] = [];
  fix(path: string, kind: Fix['kind'], detail: string): void {
    this.fixes.push({ path, kind, detail });
  }
  drop(path: string, reason: string): void {
    this.drops.push({ path, reason });
  }
}

/** 区间钳制（第 2 项）：能钳就钳，记录一笔 fix */
function clampInt(v: unknown, min: number, max: number, path: string, ctx: Ctx): number | null {
  if (!isInt(v)) {
    ctx.drop(path, `类型错：期望 integer，实得 ${JSON.stringify(v)}`);
    return null;
  }
  if (v < min) {
    ctx.fix(path, 'clamped', `${v} → ${min}（越下界）`);
    return min;
  }
  if (v > max) {
    ctx.fix(path, 'clamped', `${v} → ${max}（越上界）`);
    return max;
  }
  return v;
}

function requireKeys(obj: Record<string, unknown>, keys: string[], path: string, ctx: Ctx): boolean {
  let ok = true;
  for (const k of keys) {
    if (!(k in obj)) {
      ctx.drop(`${path}.${k}`, `缺必填字段 ${k}（第 6 项 required）`);
      ok = false;
    }
  }
  return ok;
}

// ── 各分支的校验 ────────────────────────────────────────────

function vGold(v: unknown, ctx: Ctx): DeltaOp | null {
  if (!isPlainObject(v)) {
    ctx.drop('ops[].gold', 'gold 分支不是对象');
    return null;
  }
  const n = clampInt(v.gold, LIMITS.gold.min, LIMITS.gold.max, 'ops[].gold', ctx);
  if (n === null) return null;
  return { gold: n };
}

function vRep(v: unknown, ctx: Ctx): DeltaOp | null {
  if (!isPlainObject(v)) {
    ctx.drop('ops[].rep', 'rep 分支不是对象');
    return null;
  }
  if (!isPlainObject(v.rep)) {
    ctx.drop('ops[].rep', 'rep 字段不是对象');
    return null;
  }
  const rep: Partial<Rep5> = {};
  for (const [k, raw] of Object.entries(v.rep)) {
    if (!(REP_KEYS as readonly string[]).includes(k)) {
      ctx.drop(`ops[].rep.${k}`, `枚举非法：${k} 不在五种名声内（第 3 项 enum）`);
      continue;
    }
    const n = clampInt(raw, LIMITS.rep.min, LIMITS.rep.max, `ops[].rep.${k}`, ctx);
    if (n === null) continue;
    rep[k as RepKey] = n;
  }
  if (Object.keys(rep).length === 0) {
    ctx.drop('ops[].rep', '没有任何合法的名声键');
    return null;
  }
  return { rep };
}

function vAttrBonusArray(v: unknown, path: string, ctx: Ctx): AttrBonus[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    ctx.drop(path, 'attr_bonus 不是数组');
    return [];
  }
  const out: AttrBonus[] = [];
  for (let i = 0; i < v.length; i++) {
    const e = v[i];
    if (!isPlainObject(e)) {
      ctx.drop(`${path}[${i}]`, 'attr_bonus 项不是对象');
      continue;
    }
    if (!(ATTR_KEYS as readonly string[]).includes(e.attr as string)) {
      ctx.drop(`${path}[${i}].attr`, `枚举非法：${String(e.attr)}（第 3 项 enum）`);
      continue;
    }
    if (!isInt(e.bonus) || !ATTR_BONUS_WHITELIST.includes(e.bonus)) {
      ctx.drop(`${path}[${i}].bonus`, `枚举非法：bonus=${JSON.stringify(e.bonus)}，白名单 ${ATTR_BONUS_WHITELIST.join('/')}`);
      continue;
    }
    out.push({ attr: e.attr as AttrKey, bonus: e.bonus });
  }
  return out;
}

function vAttrsValue(v: unknown, path: string, ctx: Ctx): Record<AttrKey, number> | null {
  if (!isPlainObject(v)) {
    ctx.drop(path, 'attrs 不是对象');
    return null;
  }
  const out = {} as Record<AttrKey, number>;
  for (const k of ATTR_KEYS) {
    const n = clampInt(v[k], LIMITS.attrValue.min, LIMITS.attrValue.max, `${path}.${k}`, ctx);
    if (n === null) return null;
    out[k] = n;
  }
  return out;
}

/**
 * 物品大类（`Item.kind`）—— 白名单外 / 缺失一律兜底，**不整条丢弃**（demo 容错优先）。
 * ⚠️ 这里曾经硬写 `kind: 'item'`（把 `kind` 当成**实体判别符**在用）⇒ 模型填的「特殊物品」被静默覆盖，
 *    而账本里**又没有第二个字段**装它 ⇒ 物品大类**全链路蒸发**（2026-09-18 `--live` 实测）。
 *    现在：判别符归 `etype`，`kind` 专管物品大类。
 */
function vItemKind(v: unknown, path: string, ctx: Ctx): string {
  if (typeof v === 'string' && ITEM_KINDS.includes(v)) return v;
  ctx.fix(
    `${path}.kind`,
    'filled',
    `${JSON.stringify(v)} → ${ITEM_KIND_FALLBACK}（不在白名单 ${ITEM_KINDS.join(' / ')}）`,
  );
  return ITEM_KIND_FALLBACK;
}

function vEntities(v: unknown, ctx: Ctx): DeltaOp | null {
  if (!isPlainObject(v) || !isPlainObject(v.entities)) {
    ctx.drop('ops[].entities', 'entities 分支不是对象');
    return null;
  }
  const src = v.entities;
  const out: { places: NewPlace[]; people: NewPerson[]; items: NewItem[] } = { places: [], people: [], items: [] };

  for (const [arrName, kind] of [['places', 'loc'], ['people', 'npc'], ['items', 'it']] as const) {
    const arr = src[arrName];
    if (arr === undefined) continue;
    if (!Array.isArray(arr)) {
      ctx.drop(`ops[].entities.${arrName}`, '不是数组');
      continue;
    }
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i];
      const p = `ops[].entities.${arrName}[${i}]`;
      if (!isPlainObject(e)) {
        ctx.drop(p, '不是对象');
        continue;
      }
      // 第 4 项 格式：只能是**本批临时编号**（既有实体不经 entities）
      if (typeof e.id !== 'string') {
        ctx.drop(`${p}.id`, 'id 不是字符串');
        continue;
      }
      const t = parseTempId(e.id);
      if (!t) {
        ctx.drop(
          `${p}.id`,
          isAnyFormalId(e.id)
            ? `格式错：entities 只收新建 ⇒ id 必须是本批临时编号（@p1/@it1/@loc1），收到正式 id ${e.id}`
            : `格式错：${e.id} 不是合法临时编号（第 4 项 format）`,
        );
        continue;
      }
      if (t.kind !== kind) {
        ctx.drop(`${p}.id`, `格式错：${e.id} 是 ${t.kind} 编号，却出现在 ${arrName} 里`);
        continue;
      }
      if (!requireKeys(e, ['name', 'desc'], p, ctx)) continue;
      if (kind === 'loc') {
        out.places.push({ id: e.id, etype: 'place', name: String(e.name), desc: String(e.desc) });
        continue;
      }
      if (kind === 'it') {
        const holder = typeof e.holder === 'string' ? e.holder : '';
        out.items.push({
          id: e.id,
          etype: 'item',
          kind: vItemKind(e.kind, p, ctx),
          name: String(e.name),
          desc: String(e.desc),
          attr_bonus: vAttrBonusArray(e.attr_bonus, `${p}.attr_bonus`, ctx),
          holder,
        });
        continue;
      }
      // person
      const attrs = vAttrsValue(e.attrs, `${p}.attrs`, ctx);
      if (attrs === null) continue;
      if (!requireKeys(e, ['race', 'basic', 'identity', 'in_your_eyes', 'openness'], p, ctx)) continue;
      const openness = clampInt(
        e.openness,
        LIMITS.opennessValue.min,
        LIMITS.opennessValue.max,
        `${p}.openness`,
        ctx,
      );
      if (openness === null) continue;
      out.people.push({
        id: e.id,
        etype: 'person',
        name: String(e.name),
        desc: String(e.desc),
        race: String(e.race),
        basic: String(e.basic),
        identity: String(e.identity),
        attrs,
        attr_bonus: vAttrBonusArray(e.attr_bonus, `${p}.attr_bonus`, ctx),
        in_your_eyes: String(e.in_your_eyes),
        openness,
        items: Array.isArray(e.items) ? e.items.filter((x): x is string => typeof x === 'string') : [],
        affiliated: vNewPersonAffiliation(e.affiliated, p, ctx),
      });
    }
  }

  if (out.places.length === 0 && out.people.length === 0 && out.items.length === 0) {
    ctx.drop('ops[].entities', '没有任何合法的新实体');
    return null;
  }
  return { entities: out };
}

/**
 * `NewPerson.affiliated`（2026-09-22 新增）。
 * ⚠️ **刻意不进 `requireKeys`**：老夹具 / 老快照里的人物不带这一格，一旦列进必填，
 *    那一整条 person 会被 `ctx.drop` 掉（等于用一次协议升级把历史数据作废）。
 *    缺失 ⇒ `不入队`，恰好就是升级前的实际行为。
 */
function vNewPersonAffiliation(v: unknown, path: string, ctx: Ctx): NewPersonAffiliation {
  if (v === undefined) return '不入队';
  if (typeof v === 'string' && (NEW_PERSON_AFFILIATIONS as readonly string[]).includes(v)) {
    return v as NewPersonAffiliation;
  }
  ctx.fix(`${path}.affiliated`, 'filled', `${JSON.stringify(v)} → 不入队（不在白名单 ${NEW_PERSON_AFFILIATIONS.join(' / ')}）`);
  return '不入队';
}

/**
 * `ChangeEntry.affiliated`（2026-09-22 新增）。
 * ⚠️ 同样**不进 `requireKeys`**，理由同上；缺失 ⇒ `保持`（语义上正合适：这次不提这一格）。
 * ⚠️ 非法值也落 `保持`，但**记一笔 fix**（沿用「不静默吞掉」的纪律）。
 */
function vAffiliationMove(v: unknown, path: string, ctx: Ctx): AffiliationMove {
  if (v === undefined) return '保持';
  if (typeof v === 'string' && (AFFILIATION_MOVES as readonly string[]).includes(v)) {
    return v as AffiliationMove;
  }
  ctx.fix(`${path}.affiliated`, 'filled', `${JSON.stringify(v)} → 保持（不在白名单 ${AFFILIATION_MOVES.join(' / ')}）`);
  return '保持';
}

function vChange(v: unknown, ctx: Ctx): DeltaOp | null {
  if (!isPlainObject(v)) {
    ctx.drop('ops[].change', 'change 分支不是对象');
    return null;
  }
  // ⚠️ 《契约.md》§6.1（第 126~155 行）：`change` 是**单个对象**
  //    `{who, hp, san, attrs[], in_your_eyes, openness}`；表里那句「逐人增量（**唯一允许重复**）」
  //    说的是**同一个 `change` 键可以在 `ops` 里出现多次**（一人一个 op），**不是**说它的值是数组。
  // ⚠️ 这里曾经误写成"必须是数组" ⇒ 模型**照 schema** 输出的合规单对象被整条丢光
  //    （2026-09-18 `--live` 实测：npc002 的 san / in_your_eyes / openness 全部蒸发）。
  //    ⇒ 单对象是**正典形态**；数组形态一并收下（schema 只是提示、服务端不拦 ⇒ 模型偶发包一层数组时不该整条作废）。
  const asArray = Array.isArray(v.change);
  const rawList: unknown[] = asArray ? (v.change as unknown[]) : [v.change];
  const out: ChangeEntry[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const e = rawList[i];
    const p = asArray ? `ops[].change[${i}]` : 'ops[].change';
    if (!isPlainObject(e)) {
      ctx.drop(p, '不是对象');
      continue;
    }
    if (typeof e.who !== 'string' || (!isRoleWord(e.who) && !isAnyFormalId(e.who) && !parseTempId(e.who))) {
      ctx.drop(`${p}.who`, `引用非法：${JSON.stringify(e.who)}（第 4 项 format）`);
      continue;
    }
    if (!requireKeys(e, ['hp', 'san', 'attrs', 'in_your_eyes', 'openness'], p, ctx)) continue;
    const hp = clampInt(e.hp, LIMITS.hp.min, LIMITS.hp.max, `${p}.hp`, ctx);
    const san = clampInt(e.san, LIMITS.san.min, LIMITS.san.max, `${p}.san`, ctx);
    const openness = clampInt(e.openness, LIMITS.openness.min, LIMITS.openness.max, `${p}.openness`, ctx);
    if (hp === null || san === null || openness === null) continue;
    if (!Array.isArray(e.attrs)) {
      ctx.drop(`${p}.attrs`, 'attrs 不是数组');
      continue;
    }
    const attrs: Array<{ attr: AttrKey; delta: number }> = [];
    for (let j = 0; j < e.attrs.length; j++) {
      const a = e.attrs[j];
      if (!isPlainObject(a) || !(ATTR_KEYS as readonly string[]).includes(a.attr as string)) {
        ctx.drop(`${p}.attrs[${j}].attr`, `枚举非法：${JSON.stringify(a && (a as Record<string, unknown>).attr)}`);
        continue;
      }
      const d = clampInt(a.delta, LIMITS.attrDelta.min, LIMITS.attrDelta.max, `${p}.attrs[${j}].delta`, ctx);
      if (d === null) continue;
      attrs.push({ attr: a.attr as AttrKey, delta: d });
    }
    out.push({
      who: e.who,
      hp,
      san,
      attrs,
      in_your_eyes: typeof e.in_your_eyes === 'string' ? e.in_your_eyes : '',
      openness,
      affiliated: vAffiliationMove(e.affiliated, p, ctx),
    });
  }
  if (out.length === 0) {
    ctx.drop('ops[].change', '没有任何合法的 change 条目');
    return null;
  }
  return { change: out };
}

function vLost(v: unknown, ctx: Ctx): DeltaOp | null {
  if (!isPlainObject(v) || !isPlainObject(v.lost)) {
    ctx.drop('ops[].lost', 'lost 分支不是对象');
    return null;
  }
  const lost: { people: string[]; items: string[] } = { people: [], items: [] };
  for (const [field, kind] of [['people', 'npc'], ['items', 'it']] as const) {
    const arr = (v.lost as Record<string, unknown>)[field];
    if (arr === undefined) continue;
    if (!Array.isArray(arr)) {
      ctx.drop(`ops[].lost.${field}`, '不是数组');
      continue;
    }
    for (const id of arr) {
      if (typeof id !== 'string' || !isAnyFormalId(id)) {
        ctx.drop(`ops[].lost.${field}`, `引用非法：${JSON.stringify(id)}（必须是**正式 id**）`);
        continue;
      }
      lost[field].push(id);
    }
  }
  if (lost.people.length === 0 && lost.items.length === 0) {
    ctx.drop('ops[].lost', '没有任何合法的 lost 引用');
    return null;
  }
  return { lost };
}

// ── 总入口：拆键 + 六项校验 ─────────────────────────────────

export function validateDelta(raw: unknown): ValidatedDelta {
  const split = splitMixedOps(raw);
  const ctx = new Ctx();
  const ops: DeltaOp[] = [];
  for (let i = 0; i < split.ops.length; i++) {
    const op = split.ops[i];
    const key = Object.keys(op)[0] as string;
    // ⚠️ 拆键后的 op 形如 `{ gold: 5 }` —— 分支校验函数各自去读 `v.gold` / `v.rep` / …，
    //    所以这里要传**整个 op**，不能传 `op[key]` 里的那个内层值（传内层值 ⇒ 每个分支都判定
    //    "不是对象" ⇒ **所有 delta 被静默丢光**，而单测里 87 条会集体红）。
    let fixed: DeltaOp | null = null;
    switch (key) {
      case 'gold':
        fixed = vGold(op, ctx);
        break;
      case 'rep':
        fixed = vRep(op, ctx);
        break;
      case 'entities':
        fixed = vEntities(op, ctx);
        break;
      case 'change':
        fixed = vChange(op, ctx);
        break;
      case 'lost':
        fixed = vLost(op, ctx);
        break;
      default:
        ctx.drop(`ops[${i}]`, `键名非法：${key}（第 5 项 键数 / 白名单）`);
    }
    if (fixed) ops.push(fixed);
  }
  // 第 5 项「键数」：拆键保证每个 op 恰好一个键 —— 这里再断言一次
  for (const op of ops) {
    const n = Object.keys(op).filter((k) => (OP_KEYS as readonly string[]).includes(k)).length;
    if (n !== 1) ctx.drop('ops[]', `内部错误：拆键后仍有 ${n} 个键`);
  }
  return { delta: { ops }, fixes: ctx.fixes, drops: ctx.drops, mixedCount: split.mixedCount, unknownKeys: split.unknownKeys };
}

export { VOUCHER_DIMS };
