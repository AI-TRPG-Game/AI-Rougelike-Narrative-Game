// A 计算 · 有效属性 · 主事者选取
import { ATTR_KEYS, type AttrBonus, type Attrs, type AttrKey } from '../contract/types.ts';
import { findPerson, type Item, type Ledger, type Person } from '../ledger/types.ts';
import { clamp, sum } from './num.ts';

/** 有效属性 = 基础属性 + Σ 携带物品加成（**不钳制** —— 溢出正是"平衡仪表"要记录的东西） */
export function effectiveAttrs(base: Attrs, bonuses: readonly AttrBonus[]): Attrs {
  const out = { ...base };
  for (const b of bonuses) out[b.attr] = (out[b.attr] ?? 0) + b.bonus;
  return out;
}

export function carriedItems(l: Ledger, person: Person): Item[] {
  return person.items
    .map((id) => l.entities.items.find((i) => i.id === id))
    .filter((i): i is Item => !!i && !i.consumed);
}

/**
 * **至多几件物品的加成生效**（2026-10-06 用户裁定：「最多生效两件物品的数值加成效果」）。
 *
 * ⚠️ 用户**修正过**这条：最初写的是「至多 2 件**带加成的**」＝ 带了就不能超过 2 件。
 *    改后的口径是「**东西都能带**（携带位仍受 `CARRY_CAP` 管），
 *    但只有其中**前 2 件**的加成算数」——
 *    区别很大：前者是**携带限制**，后者是**生效取舍**。
 *    玩家可以背 4 件、只让最强的 2 件起作用（换装即换生效的那两件）。
 * ⚠️ 取的是 `carriedItems` 的**前 N 件**（= `Person.items` 的顺序 ＝ 装填顺序），
 *    **不排序** —— 排序会让"他先拿到哪件"这件事失去意义，而那是玩家能控制的一手。
 *    ⚠️ 只数**真有加成的**那几件（`attr_bonus` 非空）：一件"旧游记"这种剧情物品
 *    不会白白占掉一个生效名额。
 */
export const BONUS_CAP = 2;

/**
 * **这件东西是不是一次性的**（2026-10-06 用户裁定：「**由 `kind` 推导**」）。
 *
 * ⚠️ **`Item.one_shot` 字段已删**（2026-10-06 用户裁定）：LLM 一直在写它，
 *   而它**全项目零读取** ⇒ 两份事实源在 prompt 里并存，模型可能写矛盾。
 *   现在判据**只有** `kind`（身份骨架 · 注入标签 ① · 永不变）这一份。
 *   连带删掉的落点：`contract/types.ts` · `contract/validate.ts` · `ledger/types.ts` ·
 *   `ledger/initial.ts` · `fixtures/fake.ts` · `ledger/project.ts` · **`schema/defs.ts`**
 *   （最后那个是真正要紧的 —— 它是**给 LLM 的 JSON schema**，留着等于还在要求模型填）。
 *
 * ⚠️ 推导口径：**`kind === '消耗品'` 才是一次性的**，另两类（装备／特殊物品）不是。
 *   理由：消耗品的定义就是"用掉就没了"；装备要跟着人走，特殊物品是剧情物
 *   （钥匙、卷轴、信物 —— 它们不是消耗品）。
 *   ⚠️ **不是"白名单"而是"只有消耗品"** ⇒ 将来 `kind` 加新值时，
 *   新类别**默认不是一次性的**（保守：宁可不消耗，也不要平白吃掉玩家的东西）。
 */
export function isOneShot(it: { kind: string }): boolean {
  return it.kind === '消耗品';
}

/** 这件东西用掉之后**会不会消失**（UI 与消耗那条路共用这一处判据） */
export function consumesOnUse(it: { kind: string }): boolean {
  return isOneShot(it);
}


export function bonusesOf(l: Ledger, person: Person): AttrBonus[] {
  const own = person.attr_bonus ?? [];
  const fromItems = effectiveItems(l, person).flatMap((i) => i.attr_bonus ?? []);
  return [...own, ...fromItems];
}

/**
 * 他身上**哪几件的加成正在生效**（`BONUS_CAP` 那 2 件）。
 *
 * ⚠️ 与 `bonusesOf` **同一条口径**（都走 `carriedItems` ＋ 同一个截断）——
 *    UI 要标"哪两件算数、哪几件白带"，若两处各算一份，玩家会看到
 *    「刀显示生效、匕首没显示，可规则层偏偏用了后者」。
 */
export function effectiveItems(l: Ledger, person: Person): Item[] {
  // ⚠️⚠️ **纯槽位顺序**（2026-10-07 用户裁定，**取代**下面那条「消耗品优先」特例）：
  //    人物详情页现在是**从左到右四个物品卡槽**，槽位顺序 = `Person.items` 的数组顺序
  //    （= 装填顺序），**生效优先级就按这个顺序**：有加成的前 2 件生效，其余不生效。
  //    ⚠️ 旧特例（有加成的消耗品无视顺序优先占名额）**已废** —— 玩家现在能直接
  //       看见槽位顺序、也能靠取下重装（或槽间拖动换位）调整它，特例反而会让
  //       "卡槽上的绿标"与真实生效集对不上。
  //    ⚠️ 代价（用户知情并接受）：排在第 3 位以后的加成消耗品**不生效、也永远不会
  //       被消耗**（消耗判据走 `effectiveItems` ＋ `freeOneShots`）—— UI 用绿槽/
  //       灰槽的视觉语言把这件事说清。
  return carriedItems(l, person)
    .filter((i) => (i.attr_bonus ?? []).length > 0)
    .slice(0, BONUS_CAP);
}

/**
 * **一个属性对某个事件的「需要 / 现在有多少」** —— 2026-10-06 用户裁定（清单第 5 条 5.4）：
 * 「事件标题左侧显示处理事件所需要的属性（**一开始是 0，会根据放上去的人物卡属性
 *   而实时变化**）」。
 *
 * ⚠️⚠️ **为什么放这里而不是 UI**：这条判据要**随槽里放的人变**，
 *    而 UI 拿不到"规则层怎么算属性"的唯一口径 ⇒ 两处各算一份必然漂
 *    （本项目反复踩的坑：同一个口径两处实现）。
 *    ⇒ **规则层算好、前端只画**；**不新增任何存储字段**（纯派生，重算一遍就是最新的）。
 *
 * ⚠️ **`have` 的口径 = `effectiveAttrs`**（基础 ＋ 生效物品加成，**不钳制**）
 *    —— 与 `gates.ts` 判属性门槛用的是**同一个函数** ⇒ 界面上那个数字
 *    与"过不过得了闸门"永远一致，不会出现"显示够了但过不去"。
 *
 * ⚠️ **`need` 只含 `hint_attr`**（事件声明要的那几项）——
 *    事件没声明属性（`hint_attr` 为空）⇒ `need` 为空数组，UI **不显示这一段**
 *    （空白比"要 0 项"诚实）。
 */
export interface AttrReading {
  /** 这件事要的那一项（`AttrKey`） */
  attr: AttrKey;
  /** 现在有多少（**由放上去的人**决定；没人时是 0 —— UI 上"一开始是 0"那句话的字面意思） */
  have: number;
}

/**
 * 读一份「需要 / 现在」对照表。
 *
 * @param l      账本
 * @param hint   事件声明的属性（`GameEvent.hint_attr`）
 * @param people **此刻放在槽里的那几个人**（空数组 ⇒ 一律读 0）
 *
 * ⚠️ **多个人的话逐项相加** —— 与 `gates.ts` 的多派判定同一条口径
 *    （这件事可以几个人一起办，加成是加起来的）。
 */
export function attrReadings(
  l: Ledger,
  hint: readonly AttrKey[],
  people: readonly string[],
): AttrReading[] {
  const ids = people.filter((id) => !!findPerson(l, id));
  const sumOf = (k: AttrKey): number => {
    let t = 0;
    for (const id of ids) {
      const p = findPerson(l, id);
      if (!p) continue;
      t += effectiveAttrs(p.attrs, bonusesOf(l, p))[k] ?? 0;
    }
    return t;
  };
  return hint.map((attr) => ({ attr, have: sumOf(attr) }));
}


/**
 * 他身上**那些不受生效名额限制**的一次性物品（2026-10-06 用户裁定）。
 *
 * ⚠️ **用户的原话**：「如果一次性物品不是属性的数值效果，而是一些特殊效果
 *   （**要允许 LLM 产出这样的一次性物品**），**不受生效的限制**，
 *   因为我们本来就只限制**对人物属性有直接加成**的物品生效效果」
 * ⇒ `BONUS_CAP` 管的是"**数值加成**"（`attr_bonus`），那些**只有叙事效果**的东西
 *   （护符、解药、钥匙、一次性卷轴）**不占名额、不受限制** ——
 *   它们本来就不进 `bonusesOf`（那儿只加 `attr_bonus`）。
 *   ⇒ 消耗时也**不看**名额：该用掉就用掉。
 * ⚠️ 这是"消耗品优先"那条的**补充**，不是替代：一条让**有加成的药**优先占名额，
 *   这条让**没有加成的药**压根不参与名额。
 */
export function freeOneShots(l: Ledger, person: Person): Item[] {
  return carriedItems(l, person).filter(
    (i) => isOneShot(i) && (i.attr_bonus ?? []).length === 0,
  );
}

export function effectiveAttrsOf(l: Ledger, person: Person): Attrs {
  return effectiveAttrs(person.attrs, bonusesOf(l, person));
}

export interface AResult {
  /** 钳在 [1, 20] 之后的目标值 A */
  a: number;
  /** 钳制前的均值（向下取整）—— 用于诊断 */
  mean: number;
  /** 溢出量（>0 说明"属性已经顶到天花板"，可当平衡仪表看） */
  overflow: number;
}

/**
 * A = 参与属性的平均值（**向下取整**，≤3 个属性），并含物品加成，然后**钳制到 [1, 20]**。
 * ⚠️ 溢出按**均值**判 —— 判据原文：「参与属性平均（含物品加成）→ 钳在 [1,20]，记录溢出」
 *    （设计判据，与本函数上面那句同一件事；原出处文档已删，故在此**内联**判据原文）。
 * 单个属性本身不设上限 —— 那正是溢出来源的可见化。
 */
export function calcA(attrs: Attrs, keys: readonly AttrKey[]): AResult {
  if (keys.length === 0) throw new Error('calcA：参与属性为空');
  if (keys.length > 3) throw new Error(`calcA：参与属性最多 3 个，实得 ${keys.length}`);
  const mean = Math.floor(sum(keys.map((k) => attrs[k])) / keys.length);
  return { a: clamp(mean, 1, 20), mean, overflow: Math.max(0, mean - 20) };
}

/** 主事者排序分（口径同 A 的钳前均值）—— 只用于比较，不入账 */
export function leaderScore(l: Ledger, person: Person, keys: readonly AttrKey[]): number {
  const eff = effectiveAttrsOf(l, person);
  return sum(keys.map((k) => eff[k])) / keys.length;
}

/**
 * 主事者 = 参与者中「本次参与属性集合上取值最高的人」（**每次判定独立取**）。
 * 平手时取 id 最小者 —— 保证确定性（可复现）。
 */
export function pickLeader(l: Ledger, candidates: readonly Person[], keys: readonly AttrKey[]): Person | null {
  let best: Person | null = null;
  let bestScore = -Infinity;
  for (const p of candidates) {
    const s = leaderScore(l, p, keys);
    if (s > bestScore || (s === bestScore && best !== null && p.id < best.id)) {
      best = p;
      bestScore = s;
    }
  }
  return best;
}

export function personById(l: Ledger, id: string): Person | undefined {
  return l.entities.people.find((p) => p.id === id);
}

/**
 * **一次性物品用掉**（2026-10-06 用户裁定：「一次性物品，只要被角色装备
 * ＋ 该角色处理了某事件（视为在该事件中使用了该物品），该物品自动消耗」）。
 *
 * @param l 账本（**就地改** —— 调用方都在克隆体上工作）
 * @param eventId 刚结算完的那件事（用它找"这次去的人"）
 * @returns 给人看的播报（一件一行）
 *
 * ⚠️⚠️ **住在 `ability.ts` 而不是 `turn/` 某一家**（2026-10-06 改）：
 *   消耗有**三条**触发路径（2026-10-06 核出来的）——
 *     ① 排布事件的揭晓　　`turn/time.ts·revealDue`
 *     ② 场景的每一轮与收尾　`turn/scene.ts:141 / 217 / 529`
 *     ③ 事件过期自动结算　`turn/t0.ts:249`
 *   它们**各自调 `applyDelta`，全都绕过 `revealDue`**
 *   ⇒ 函数放 `turn/time.ts` 就只有第 ① 条能用，② ③ 永远是漏的。
 *   ⇒ 放**规则层**，三条路都 import 同一处 ⇒ 下一个新路径也自然能用上。
 *
 * ⚠️ 三条判据（拆成可算的，因为「算术归系统」）：
 *   ① 一次性 ＝ `isOneShot(it)`（由 `kind` 推导）
 *   ② 他**带着**它（装备着）
 *   ③ **两档范围**（用户裁定）：
 *      ・`effectiveItems` 里那些**有数值加成**的（受 `BONUS_CAP` 限，白带的不会被动）
 *      ・`freeOneShots` ＝**只有叙事效果**的（护符、解药…）—— **不看名额**
 *
 * ⚠️⚠️ **直接从 `entities.items` 移除**（**不走** `batch.lost.items`）：
 *   后者是"这个世界里彻底没有了"（被毁/被抢）⇒ **会进档案**；
 *   而消耗品不该占掉结局三格的位置（用户裁定"消耗不进档案"）。
 *   ⇒ 所以这里**自己摘**：`p.items` 去掉它 ＋ `entities.items` 去掉它。
 */
export function consumeOneShots(l: Ledger, eventId: string): string[] {
  const lines: string[] = [];
  const ev = l.events.live.find((e) => e.id === eventId);
  if (!ev) return lines;
  // ⚠️ 主事者与参与者**都算**（裁定说"该角色处理了某事件"）；
  //   `Set` 去重（主事者常常也在参与者里）。
  const ids = [ev.handler, ...(Array.isArray(ev.participants) ? ev.participants : [])]
    .filter((x): x is string => !!x);
  const seen = new Set<string>();
  for (const pid of ids) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = findPerson(l, pid);
    if (!p) continue;
    const toUse = [
      ...effectiveItems(l, p).filter((it) => isOneShot(it)),
      ...freeOneShots(l, p),
    ];
    for (const it of toUse) {
      p.items = p.items.filter((x) => x !== it.id);
      l.entities.items = l.entities.items.filter((x) => x.id !== it.id);
      lines.push(`${p.name} 用掉了 ${it.name}`);
    }
  }
  return lines;
}
