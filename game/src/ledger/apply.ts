// 唯一写入口 —— applyDelta + commitBatch
//
// 三条铁律（Phase 0 §三 / §五 的直接产物），**都必须发生在 applyDelta 之前**：
//   ① 拆键          —— 服务端不保证 anyOf 互斥，且不会拒
//   ② 六项校验      —— 服务端一律不拦取值 / 类型 / 枚举 / 区间 / 格式
//   ③ 临时编号解析  —— 畸形内容会一路带下去且无人报警
// 这三件事由 `validateDelta`（含 `splitMixedOps`）一次做完。
import { ATTR_KEYS, REP_KEYS, VOUCHER_RESONANCE, type AttrKey, type RepKey } from '../contract/types.ts';
import { normalizeTempId, parseTempId, isRoleWord, isAnyFormalId, type RoleWord } from '../contract/tempids.ts';
import { validateDelta, type Drop, type Fix } from '../contract/validate.ts';
import {
  CHECKPOINT_CONTENT,
  checkpointPrompt,
  checkpointTitle,
  crossedCheckpoints,
} from '../rules/checkpoint.ts';
import { clamp } from '../rules/num.ts';
import { CARRY_CAP } from '../rules/gates.ts';
import { emptyBatch, foldChange, type Batch } from './batch.ts';
import { allocatorFor, nextSeedCode } from './ids.ts';
import { PLAYER_ID, type Item, type Ledger, type Person, type Place } from './types.ts';
import { DIM_LABEL, findOpenVoucher } from './vouchers.ts';

export interface ApplyCtx {
  /** 角色词 → 具体 id */
  roleMap?: Partial<Record<RoleWord, string>>;
}

export interface ApplyOutcome {
  batch: Batch;
  fixes: Fix[];
  drops: Drop[];
  errors: string[];
  mixedCount: number;
  unknownKeys: string[];
  /** 临时编号 → 正式 id（本批） */
  tempIds: Record<string, string>;
  appliedOps: number;
}

function roleTarget(ctx: ApplyCtx, word: RoleWord): string | undefined {
  if (word === '玩家') return PLAYER_ID;
  return ctx.roleMap?.[word];
}

/** 主角色的解析：角色词 / 正式 id / 本批临时编号 → 具体人物 id */
function resolvePerson(
  ledger: Ledger,
  batch: Batch,
  who: string,
  ctx: ApplyCtx,
): { id: string } | { error: string } {
  if (isRoleWord(who)) {
    const id = roleTarget(ctx, who);
    return id ? { id } : { error: `角色词「${who}」在本次调用里没有对应的人` };
  }
  const t = parseTempId(who);
  if (t) {
    const formal = batch.tempIds[normalizeTempId(who)];
    if (!formal) return { error: `临时编号 ${who} 本批未创建（先写 entities 再引用）` };
    if (t.kind !== 'npc') return { error: `${who} 不是人物编号` };
    return { id: formal };
  }
  if (isAnyFormalId(who)) {
    const inLedger = ledger.entities.people.some((p) => p.id === who);
    const inBatch = batch.entities.people.some((p) => p.id === who);
    if (!inLedger && !inBatch) return { error: `正式 id ${who} 在账本中不存在` };
    return { id: who };
  }
  return { error: `无法解析的人物引用：${JSON.stringify(who)}` };
}

export function applyDelta(ledger: Ledger, raw: unknown, ctx: ApplyCtx = {}, batchIn?: Batch): ApplyOutcome {
  const batch = batchIn ?? emptyBatch(ledger);
  const v = validateDelta(raw);
  const errors: string[] = [];
  const alloc = allocatorFor(batch.idWatermark);

  // ── 第一遍：`entities` 先落地（后面的 change / lost 可能引用本批新建的实体）──
  for (const op of v.delta.ops) {
    if (!('entities' in op)) continue;
    for (const p of op.entities.places ?? []) {
      const key = normalizeTempId(p.id);
      if (batch.tempIds[key]) {
        batch.notes.push(`临时编号 ${key} 在同批里重复出现，按同一实体只落地一次`);
        continue;
      }
      const formal = alloc.next('loc');
      batch.tempIds[key] = formal;
      batch.entities.places.push({ ...p, id: formal } as unknown as Place);
    }
    for (const p of op.entities.people ?? []) {
      const key = normalizeTempId(p.id);
      if (batch.tempIds[key]) {
        batch.notes.push(`临时编号 ${key} 在同批里重复出现，按同一实体只落地一次`);
        continue;
      }
      const formal = alloc.next('npc');
      batch.tempIds[key] = formal;
      // ⚠️ `affiliated` 在 Delta 里是**中文枚举**（'入队' / '不入队'），账本里是 **boolean** ——
      //    必须在这一步翻译。直接 spread 会把字符串塞进 `Person.affiliated`，
      //    而 `isAvailable` 第一行 `if (!p.affiliated) return false` 只认布尔 ⇒ 非空字符串永真。
      //    缺失 / 非法 ⇒ `不入队`（与升级前的实际行为一致）。
      const affiliated = p.affiliated === '入队';
      batch.entities.people.push({ ...p, id: formal, affiliated } as unknown as Person);
    }
    for (const p of op.entities.items ?? []) {
      const key = normalizeTempId(p.id);
      if (batch.tempIds[key]) {
        batch.notes.push(`临时编号 ${key} 在同批里重复出现，按同一实体只落地一次`);
        continue;
      }
      const formal = alloc.next('it');
      batch.tempIds[key] = formal;
      // ⚠️ holder 在这里只做「形状归一」：契约层空串 = 无人携带 ⇒ 账本层的 null。
      //    （此前落成 `''` ⇒ 下游 `holder === null` 的严格比较全不认它：手牌区看不见、
      //      成果池不收 —— 2026-10-08 实测复现。）
      //    临时编号 → 正式 id 的改写见第一遍结束后的统一段（那里才收得齐 tempIds）。
      const holderRaw = typeof p.holder === 'string' ? p.holder.trim() : '';
      batch.entities.items.push({ ...p, id: formal, holder: holderRaw || null } as unknown as Item);
    }
  }

  // ── 引用改写：第一遍收齐 tempIds 后统一做 ─────────────────────────
  //    ⚠️ 必须在第一遍**之后**：items op 与 people op 谁先谁后不该影响结果
  //      （此前在逐 op 循环内解析，items 排在 people 前面时 `@p1` 查不到 ⇒ holder 悬空
  //        —— 2026-10-08 实测复现⑤）。
  for (const it of batch.entities.items) {
    const h = it.holder;
    if (typeof h !== 'string' || !h) continue;
    const t = parseTempId(h);
    if (!t) continue;
    // 解析不到的保留原值：commitBatch 那层会把「持有者不存在」降级回手牌区并记一笔
    it.holder = batch.tempIds[normalizeTempId(h)] ?? h;
  }
  // 新人物的 items：物品临时编号 → 正式 id。
  // ⚠️ schema 对 id 的承诺是「本批所有对该编号的引用一并改写为正式 id」——
  //    人物 items 这一引用此前从来没被改写过（落账后 `["@it1"]` 悬空 ⇒ 装备全不生效）。
  for (const pe of batch.entities.people) {
    const ids = pe.items;
    if (!Array.isArray(ids)) continue;
    pe.items = ids.map((id) => {
      if (typeof id !== 'string' || !id) return id;
      const t = parseTempId(id);
      if (!t || t.kind !== 'it') return id;
      return batch.tempIds[normalizeTempId(id)] ?? id;
    });
  }

  // ── 第二遍：gold / rep / change / lost ──
  let applied = 0;
  for (const op of v.delta.ops) {
    if ('gold' in op) {
      batch.gold += op.gold;
      batch.notes.push(`金币 ${op.gold >= 0 ? '+' : ''}${op.gold}`);
      applied++;
      continue;
    }
    if ('rep' in op) {
      for (const [k, val] of Object.entries(op.rep)) {
        if (!(REP_KEYS as readonly string[]).includes(k)) continue;
        batch.rep[k as RepKey] += val as number;
      }
      applied++;
      continue;
    }
    if ('change' in op) {
      for (const c of op.change) {
        const r = resolvePerson(ledger, batch, c.who, ctx);
        if ('error' in r) {
          errors.push(`change：${r.error}`);
          continue;
        }
        foldChange(batch, r.id, c);
      }
      applied++;
      continue;
    }
    if ('lost' in op) {
      for (const id of op.lost.people ?? []) {
        const known =
          ledger.entities.people.some((p) => p.id === id) || batch.entities.people.some((p) => p.id === id);
        if (!known) errors.push(`lost：人物 ${id} 在账本中不存在`);
        else batch.lost.people.push(id);
      }
      for (const id of op.lost.items ?? []) {
        const known = ledger.entities.items.some((i) => i.id === id) || batch.entities.items.some((i) => i.id === id);
        if (!known) errors.push(`lost：物品 ${id} 在账本中不存在`);
        else batch.lost.items.push(id);
      }
      applied++;
      continue;
    }
  }

  return {
    batch,
    fixes: v.fixes,
    drops: v.drops,
    errors,
    mixedCount: v.mixedCount,
    unknownKeys: v.unknownKeys,
    tempIds: { ...batch.tempIds },
    appliedOps: applied,
  };
}

export interface CommitReport {
  ledger: Ledger;
  report: string[];
  /**
   * 本批新出的**硬种子 checkpoint**（`<声望名>达到 <N>`，如 `善名达到 10`）。
   * ⚠️ 它是给覆盖率 / 调试用的**结构读数** —— 不要去 `report` 里 grep 那句人话
   *    （文案一改就静默失配）。「标记已记」与「种子已出」在这个数组里是同一件事的两面。
   */
  checkpoints: string[];
}

/** 批末：**统一钳一次**，然后落账。返回**新账本**（不改旧的）。
 *  ⚠️ 它同时是**硬种子 checkpoint 的唯一生产点**（声望批末判「首次达标」，见下面那一段）——
 *     `applyDelta` 只写批，`commitBatch` 才知道 `before` / `after` 两个读数。 */
export function commitBatch(ledger: Ledger, batch: Batch): CommitReport {
  const l: Ledger = structuredClone(ledger);
  const report: string[] = [];
  const checkpoints: string[] = [];

  // 金币：先累加、最后钳一次
  if (batch.gold !== 0) {
    const before = l.scalars.gold;
    l.scalars.gold = Math.max(0, before + batch.gold);
    report.push(`金币 ${before} ${batch.gold >= 0 ? '+' : ''}${batch.gold} → ${l.scalars.gold}`);
    if (l.scalars.gold !== before + batch.gold) report.push('（触到 gold ≥ 0 的全局落账纪律，已钳制）');
  }

  // 声望 —— ⚠️ 出 checkpoint 硬种子要读 `before`，所以两件事放在**同一个循环**里，
  //    一次遍历同时拿到「跨档判定」与「落账后的值」。分成两个循环迟早漂（改了钳制忘了同步）。
  for (const k of REP_KEYS) {
    const d = batch.rep[k];
    if (!d) continue;
    const before = l.scalars.rep[k];
    l.scalars.rep[k] = clamp(before + d, -20, 20);
    report.push(`声望·${k} ${before} → ${l.scalars.rep[k]}`);
    // ── 硬种子 checkpoint—— **批末**判「首次达标」──────
    //    「五格声望任一**首次**达到 10 / 15 / 20 ⇒ **必出** 1 条 checkpoint」，
    //    **不占条数上限、不占行动点**（额外叠加在自由事件之上 —— P1 价值序）。
    //
    //    ⚠️ 为什么在这里（而不是 T0）：`commitBatch` 是**唯一**知道 `before` / `after`
    //       两个读数的地方 —— 「首次跨过」的判据只在批末成立。而它天然满足
    //       「T0 之前种子已在池里」：本批落完账 → 种子进 `l.seeds` → 下一个 T0 的
    //       `composeDay` 一定读得到它（`turn/t0.ts` ⑤ 是**唯一**的出种消费者）。
    //    ⚠️ 标记与出种**原子**：写在同一个 `for (step of …)` 里，中间没有 await、
    //       没有 return 的岔路 ⇒ 不存在"记了标记却没出种子"（那会让这条 checkpoint
    //       **永远不再触发**，而没有任何断言会红）。
    //    ⚠️ 种子编号走 `nextSeedCode(l.seeds)`（**不是** `length + 1`）—— 硬种子跨天
    //       留存 ⇒ 池子会"带洞"，`length + 1` 会与留着的那条撞号。见 `ids.ts`。
    //    ⚠️ **不在这里替 LLM 挑档位 / 写内容**：提示语只有语义（`rules/checkpoint.ts`），
    //       事件内容 / 档位 / `cost` 全由 `compose_day` 现定。
    for (const step of crossedCheckpoints(before, l.scalars.rep[k], l.repMarks[k])) {
      l.repMarks[k].push(step);
      l.seeds.push({
        code: nextSeedCode(l.seeds),
        title: checkpointTitle(k, step),
        content: CHECKPOINT_CONTENT[step],
        source: '硬种子',
      });
      checkpoints.push(checkpointTitle(k, step));
      report.push(
        `硬种子 checkpoint：${k} 首次达到 ${step} ⇒ 「${checkpointPrompt(k, step)}」` +
          `（不占条数、不占行动点；下一个 compose_day 必须承接）`,
      );
    }
  }

  // 人物状态
  const touch = (id: string): Person | undefined => {
    const p = l.entities.people.find((x) => x.id === id);
    if (!p) report.push(`⚠️ change 指向不存在的人物 ${id}，已跳过`);
    return p;
  };
  for (const [id, d] of Object.entries(batch.hp)) {
    const p = touch(id);
    if (!p) continue;
    const before = p.hp;
    p.hp = clamp(before + d, 0, 3);
    report.push(`${p.name} HP ${before} → ${p.hp}`);
  }
  for (const [id, d] of Object.entries(batch.san)) {
    const p = touch(id);
    if (!p) continue;
    const before = p.san;
    p.san = clamp(before + d, 0, 3);
    report.push(`${p.name} SAN ${before} → ${p.san}`);
  }
  for (const [id, row] of Object.entries(batch.attrs)) {
    const p = touch(id);
    if (!p) continue;
    for (const k of ATTR_KEYS) {
      const d = row[k];
      if (!d) continue;
      const before = p.attrs[k];
      p.attrs[k] = clamp(before + d, 1, 20);
      report.push(`${p.name} ${k} ${before} → ${p.attrs[k]}`);
    }
  }
  for (const [id, d] of Object.entries(batch.openness)) {
    const p = touch(id);
    if (!p) continue;
    const before = p.openness;
    p.openness = clamp(before + d, 0, 20);
    report.push(`${p.name} openness ${before} → ${p.openness}`);
  }
  // 覆盖型：批内已收敛为"最后一条"
  for (const [id, text] of Object.entries(batch.inYourEyes)) {
    const p = touch(id);
    if (!p) continue;
    p.in_your_eyes = text;
  }
  // 归属（2026-09-22 新增）—— **覆盖型**，批内已收敛为"最后一条"
  // ⚠️ 它是 X 的输入端：`rules/x.ts·subordinatePoints` 对每个 `isAvailable` 为真的人加一份
  //    行动点 ⇒ 这一格一动，当天的 X 就变。这也是「开局只有皮普 ⇒ X=8」的出口。
  for (const [id, v] of Object.entries(batch.affiliated)) {
    const p = touch(id);
    if (!p) continue;
    if (p.affiliated === v) continue;
    p.affiliated = v;
    report.push(`${p.name} ${v ? '入队' : '离队'}`);
  }

  // 新实体（追加，永不覆盖合并）
  for (const pl of batch.entities.places) l.entities.places.push(pl as unknown as Place);
  for (const pe of batch.entities.people) l.entities.people.push(pe as unknown as Person);
  for (const it of batch.entities.items) l.entities.items.push(it as unknown as Item);
  if (batch.entities.people.length + batch.entities.items.length + batch.entities.places.length > 0) {
    report.push(
      `新建实体 ${batch.entities.people.length} 人 / ${batch.entities.items.length} 物 / ${batch.entities.places.length} 地`,
    );
  }

  // ── 持有不变式（2026-10-08）：「物品在某人身上」= holder 指向他 ＋ 他的 items 含它 ──
  //    ⚠️ LLM 只写一边是常态（只给物品写 holder、或只给人物写 items）⇒ 批末双向对齐。
  //    **以物品的 holder 为准**：物品位置是主事实，人物 items 是派生索引 ——
  //    「他宣称带着但东西不在他身上」按东西的实际位置算，绝不给一处悬空引用。
  for (const it of batch.entities.items) {
    const h = it.holder;
    if (!h) continue;
    const who = l.entities.people.find((x) => x.id === h);
    if (!who) {
      it.holder = null;
      report.push(`⚠️ ${it.name}(${it.id}) 的持有者 ${h} 不存在 ⇒ 先放回手牌区`);
      continue;
    }
    if (!who.items.includes(it.id)) {
      if (who.items.length >= CARRY_CAP) {
        it.holder = null;
        report.push(`⚠️ ${who.name} 携带位已满（${CARRY_CAP}）⇒ ${it.name}(${it.id}) 先放回手牌区`);
        continue;
      }
      who.items.push(it.id);
    }
  }
  // 新人物的 items：对齐到物品实际位置（悬空引用 / 别人的物品一律清掉，不静默）。
  //    ⚠️ 只清本批新建的人物 —— 既有人物的 items 由系统单写者（Session.give）维护，
  //      轮不到 LLM 批次来对账（那会把闸门⑤不变式检查误报成"账本坏掉"）。
  for (const pe of batch.entities.people) {
    const keep: string[] = [];
    for (const id of pe.items ?? []) {
      const it = l.entities.items.find((x) => x.id === id);
      if (!it) {
        report.push(`⚠️ ${pe.name}(${pe.id}) 声称携带 ${id}，但它不存在 ⇒ 已移除`);
        continue;
      }
      if (it.holder !== pe.id) {
        report.push(`⚠️ ${pe.name}(${pe.id}) 声称携带 ${it.name}(${id})，但它不在他身上 ⇒ 已移除`);
        continue;
      }
      keep.push(id);
    }
    if (keep.length > CARRY_CAP) {
      // 兜 LLM 直接给新人物塞一长串 items：超出的物品若 holder 指向他，一并放手牌区，
      // 否则闸门⑤的不变式检查（items 超 4）会把后续所有动作整批拦死。
      for (const id of keep.slice(CARRY_CAP)) {
        const it = l.entities.items.find((x) => x.id === id);
        if (it && it.holder === pe.id) it.holder = null;
      }
      report.push(`⚠️ ${pe.name}(${pe.id}) 声称携带 ${keep.length} 件，超出 ${CARRY_CAP} 位 ⇒ 只留前 ${CARRY_CAP} 件`);
      keep.length = CARRY_CAP;
    }
    pe.items = keep;
  }

  // lost：移出账本（人物离队/死亡 ⇒ 其随身物品回到"未携带"）
  for (const id of batch.lost.people) {
    const p = l.entities.people.find((x) => x.id === id);
    if (p) {
      for (const itemId of p.items) {
        const it = l.entities.items.find((x) => x.id === itemId);
        if (it) it.holder = null;
      }
      p.items = [];
    }
    l.entities.people = l.entities.people.filter((x) => x.id !== id);
    report.push(`人手离队/死亡：${id}`);
  }
  for (const id of batch.lost.items) {
    const it = l.entities.items.find((x) => x.id === id);
    if (it) it.holder = null;
    l.entities.items = l.entities.items.filter((x) => x.id !== id);
    report.push(`失去物品：${id}`);
  }

  // ── 凭证（第 8 组）—— 产出追加、收回标记，并**重算受影响人物的 `recognized`** ──
  //    ⚠️ 位置在 `lost` **之后**：成果凭证的收回要连同那件物品一起移出账本，
  //       而"移出账本"正是上面 `lost` 那一段干的（同一件事不写第二遍）。
  //    ⚠️ `Person.recognized` 是**派生**（它的类型注释原文：「共鸣凭证的派生去重」）⇒
  //       这里**从凭证表重算**，不做第二份记账。否则"凭证已经收回了、认可还挂在脸上"
  //       这类双事实源 bug 迟早发生 —— 而它只在结算概率凑巧时现身。
  if (batch.vouchers.length > 0 || batch.vouchersRecalled.length > 0) {
    const touched = new Set<string>();
    for (const v of batch.vouchers) {
      l.vouchers.push(v);
      if (v.dim === VOUCHER_RESONANCE && v.person !== '') touched.add(v.person);
      report.push(`凭证产出（${DIM_LABEL[v.dim]}）：${v.desc || '（无描述）'}`);
    }
    for (const r of batch.vouchersRecalled) {
      const open = findOpenVoucher(l.vouchers, r);
      if (!open) {
        report.push(`⚠️ 凭证收回找不到对应条目（${DIM_LABEL[r.dim]} · ${r.item || r.person}），已跳过`);
        continue;
      }
      open.recalled_day = l.clock.day;
      if (open.dim === VOUCHER_RESONANCE && open.person !== '') touched.add(open.person);
      report.push(`凭证收回（${DIM_LABEL[open.dim]}）：${open.desc || '（无描述）'}`);
    }
    for (const id of touched) {
      const p = l.entities.people.find((x) => x.id === id);
      if (!p) continue;
      const seen: string[] = [];
      for (const v of l.vouchers) {
        if (v.dim !== VOUCHER_RESONANCE || v.person !== id || v.recalled_day !== null) continue;
        if (v.desc !== '' && !seen.includes(v.desc)) seen.push(v.desc);
      }
      p.recognized = seen;
      report.push(`${p.name} 的认可清单 → ${seen.length} 条`);
    }
  }

  // 欲念（系统独写）
  //
  // ⚠️ 这里**曾经**还记一个 `reached60_day`（首次跨 60 的日子），供次日 T0 的
  //    `rewrite_desire` 侧链当触发标记。2026-10-05 用户裁定：**欲望命题一生只写一次**
  //    （`opening` 里一次成型、此后永不重写）⇒ 60 这个阈值与那个字段一并删除。
  //    欲念现在**没有任何"到某个数就发生什么"的档位** —— 它只是一条被 `欲向` 推动、
  //    被危险区漂移与章节占卜扰动的连续数值，唯一的分段读法只剩终局那个窗口（75~80）。
  if (batch.desire !== 0) {
    const before = l.desire.value;
    l.desire.value = clamp(before + batch.desire, 0, 100);
    report.push(`欲念 ${before} → ${l.desire.value}`);
  }

  // 下属容量预算（系统独写）
  // ⚠️ 玩家的**时间**预算不在这里 —— 它是 `clock.usedToday`，只由时间流逝层推进。
  for (const [id, d] of Object.entries(batch.actionPoints.byNpc)) {
    l.actionPoints.byNpc[id] = Math.max(0, (l.actionPoints.byNpc[id] ?? 4) + d);
  }

  // 消耗物品
  for (const id of batch.consumeItems) {
    const it = l.entities.items.find((x) => x.id === id);
    if (it) it.consumed = true;
  }

  // id 水位回写（单调递增、永不复用）
  l.idWatermark = { ...batch.idWatermark };

  return { ledger: l, report, checkpoints };
}

export function newBatch(ledger: Ledger): Batch {
  return emptyBatch(ledger);
}
