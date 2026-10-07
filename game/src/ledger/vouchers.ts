// 凭证链路
//
// ⚠️ **凭证不进 `Delta`**⇒ 它有自己的一条落地路：
//    `resolve` 的独立字段 `vouchers` → 与 `delta` **同一批、同一个时刻**落账。
//    本模块只负责「把原始声明翻译成批里的写操作」；真正的合并 / 记账在
//    `apply.ts·commitBatch` 的批末那一段（与 `delta` 同族：批内只写、批末统一落）。
//
// ⚠️ **2026-09-21 之前这条链路整段不存在**：`resolve.vouchers` 从 schema 到 prompt 一路俱在，
//    但**落地层直接丢弃**（`handle.ts` 取 `delta` / `summary` / `next_seeds` / `欲向`，独独漏了它，
//    `pending` 里也没有它的位置）⇒ 账本第 8 组恒 `[]`、`Person.recognized` 永远为空。
//    现场证据：三个基线种子跑满 28 天，终局那一格永远是「**共鸣=空**」—— 而所有断言照样全绿。
//    ⇒ 「他者的共鸣」这一维在终局三格里**永远挑不出人**，成功结局的风味 C（有人陪你走到这里）
//      在离线路径上不可达。这是本项目「绿了但没测到」的又一例，也是本模块存在的唯一理由。
//
// 三维与各自的绑定：
//   · `the_great_achievement` 伟大的成果 —— 绑一件**物品**（`item`）；**可收回**（收回时系统把该物品一并移出账本）
//   · `the_proper_way`        正当的手段 —— 绑**事件**（`event`，**由系统自动填本次结算的事件 id**，LLM 不给）；**永不可收回**
//   · `the_resonance_of_the_other` 他者的共鸣 —— 绑一个**人物**（`person`）；**可收回**
//
// 三条硬规则（全部在规则层钳制，**绝不指望 LLM 自律**）：
//   ① **每次结算最多收回 1 条**—— 多写的丢弃并记一条 problem；
//   ② `the_proper_way` **永不 recall**（事件既成）—— 写了也丢；
//   ③ 同一批里**同维同绑定同描述**的重复产出直接丢弃 —— 否则多轮场景会把同一条凭证刷成 5 份。
import { VOUCHER_ACHIEVEMENT, VOUCHER_DIMS, VOUCHER_RESONANCE, VOUCHER_WAY, type VoucherDim } from '../contract/types.ts';
import { normalizeTempId, parseTempId } from '../contract/tempids.ts';
import type { Batch } from './batch.ts';
import type { Ledger, RecallRequest, VoucherRecord } from './types.ts';

/** 《规则.md》§三「上限」：**每次结算最多 1 条**（这一条说的是**收回**） */
export const RECALL_MAX_PER_SETTLE = 1;

/** 三个维度的中文名 —— UI 与日志**共用这一处**，不让任何一层自己译枚举 */
export const DIM_LABEL: Record<VoucherDim, string> = {
  [VOUCHER_ACHIEVEMENT]: '伟大的成果',
  [VOUCHER_WAY]: '正当的手段',
  [VOUCHER_RESONANCE]: '他者的共鸣',
};

export interface VoucherCtx {
  /** 落账发生在第几天（收回时记进 `recalled_day`） */
  day: number;
  /** 本次结算的事件 id —— `the_proper_way` 的手段凭证**由系统绑定** */
  eventId: string;
}

export interface VoucherOutcome {
  /** 人话记录（进账本报告 / 日志） */
  report: string[];
  /** 被钳制 / 丢弃的条目 —— **不静默吞掉**（与 `applyDelta` 的 `errors` 同一条纪律） */
  problems: string[];
  produced: number;
  recalled: number;
}

/** 从凭证表里找"还挂着"的那一条（`recalled_day === null`）—— 收回时的唯一判据 */
export function findOpenVoucher(
  vouchers: readonly VoucherRecord[],
  r: RecallRequest,
): VoucherRecord | undefined {
  return vouchers.find(
    (v) =>
      v.dim === r.dim &&
      v.recalled_day === null &&
      (r.item === '' || v.item === r.item) &&
      (r.person === '' || v.person === r.person),
  );
}

interface RawVoucher {
  dim: VoucherDim | '';
  action: 'produce' | 'recall' | '';
  item: string;
  person: string;
  desc: string;
}

/** 模型给的是**未校验的任意形状** ⇒ 逐字段自取、缺省为空，任一字段不合法就在上层丢弃 */
function readOne(x: unknown): RawVoucher | null {
  if (typeof x !== 'object' || x === null) return null;
  const o = x as Record<string, unknown>;
  const s = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
  const dim = s('dim');
  const action = s('action');
  return {
    dim: (VOUCHER_DIMS as readonly string[]).includes(dim) ? (dim as VoucherDim) : '',
    action: action === 'produce' || action === 'recall' ? action : '',
    item: s('item'),
    person: s('person'),
    desc: s('desc'),
  };
}

/**
 * 引用解析：本批临时编号 → 正式 id；已是正式 id 就核对它**真的在账本 / 本批里**。
 * ⚠️ 与 `applyDelta` 的 `resolvePerson` 同一条纪律：**解析不到就丢弃并记一笔**，
 *    绝不"猜一个人出来"—— 凭证绑错人比没有凭证坏得多。
 */
function resolveRef(
  ref: string,
  kind: 'it' | 'npc',
  ledger: Ledger,
  batch: Batch,
): { id: string } | { error: string } {
  const t = parseTempId(ref);
  if (t) {
    if (t.kind !== kind) return { error: `${ref} 不是${kind === 'it' ? '物品' : '人物'}编号` };
    const formal = batch.tempIds[normalizeTempId(ref)];
    if (!formal) return { error: `临时编号 ${ref} 本批未创建（先写 entities 再引用）` };
    return { id: formal };
  }
  const known =
    kind === 'it'
      ? ledger.entities.items.some((i) => i.id === ref) || batch.entities.items.some((i) => i.id === ref)
      : ledger.entities.people.some((p) => p.id === ref) || batch.entities.people.some((p) => p.id === ref);
  if (!known) return { error: `${kind === 'it' ? '物品' : '人物'} ${ref} 在账本中不存在` };
  return { id: ref };
}

/** 同维同绑定同描述、且还挂着 ⇒ 视为重复（多轮场景最容易把同一条凭证刷成好几份） */
function isDuplicate(ledger: Ledger, batch: Batch, rec: VoucherRecord): boolean {
  const same = (v: VoucherRecord): boolean =>
    v.dim === rec.dim &&
    v.item === rec.item &&
    v.person === rec.person &&
    v.event === rec.event &&
    v.desc === rec.desc &&
    v.recalled_day === null;
  return ledger.vouchers.some(same) || batch.vouchers.some(same);
}

/**
 * 把一次结算产出的 `vouchers` 声明落进批里。
 *
 * ⚠️ **必须在同一次结算的 `applyDelta` 之后调用** —— 本批新建的物品 / 人物此刻才在
 *    `batch.tempIds` 里有正式 id，`@it1` / `@p1` 这类引用才解析得出来。
 * ⚠️ 它**只写批**（`batch.vouchers` / `batch.vouchersRecalled` / `batch.lost.items`），
 *    不碰账本 —— 落账是 `commitBatch` 的事（批末统一落，与 `delta` 完全同构）。
 */
export function applyVouchers(ledger: Ledger, raw: unknown, batch: Batch, ctx: VoucherCtx): VoucherOutcome {
  const report: string[] = [];
  const problems: string[] = [];
  const out: VoucherOutcome = { report, problems, produced: 0, recalled: 0 };

  // 「没有凭证」是绝大多数结算的常态（空数组 / 字段缺失）⇒ 安静地过
  if (raw === undefined || raw === null) return out;
  if (Array.isArray(raw) && raw.length === 0) return out;
  if (!Array.isArray(raw)) {
    problems.push(`vouchers 不是数组（收到 ${typeof raw}）⇒ 本次一个凭证都不落账`);
    return out;
  }

  for (const x of raw) {
    const v = readOne(x);
    if (!v) {
      problems.push('vouchers 里有一条不是对象 ⇒ 丢弃');
      continue;
    }
    if (v.dim === '' || v.action === '') {
      problems.push(
        `凭证的 dim / action 不合法（dim=${v.dim || '空'} · action=${v.action || '空'}）⇒ 丢弃`,
      );
      continue;
    }

    // ── 产出 ──────────────────────────────────────────────────
    if (v.action === 'produce') {
      const rec: VoucherRecord = {
        dim: v.dim,
        desc: v.desc,
        item: '',
        person: '',
        event: '',
        recalled_day: null,
      };
      if (v.dim === VOUCHER_ACHIEVEMENT) {
        if (v.item === '') {
          problems.push('成果凭证没给 item ⇒ 丢弃（它必须绑定一件实物）');
          continue;
        }
        const r = resolveRef(v.item, 'it', ledger, batch);
        if ('error' in r) {
          problems.push(`成果凭证绑定失败：${r.error} ⇒ 丢弃`);
          continue;
        }
        rec.item = r.id;
      } else if (v.dim === VOUCHER_RESONANCE) {
        if (v.person === '') {
          problems.push('共鸣凭证没给 person ⇒ 丢弃（它必须绑定一个人）');
          continue;
        }
        const r = resolveRef(v.person, 'npc', ledger, batch);
        if ('error' in r) {
          problems.push(`共鸣凭证绑定失败：${r.error} ⇒ 丢弃`);
          continue;
        }
        rec.person = r.id;
      } else {
        // `the_proper_way` —— 手段 = 事件既成，事件 id **由系统绑定**（LLM 不给，给了也不采信）
        rec.event = ctx.eventId;
        if (v.item !== '' || v.person !== '') {
          problems.push('手段凭证不接受 item / person（事件由系统绑定）⇒ 那两项已忽略');
        }
      }
      if (isDuplicate(ledger, batch, rec)) {
        problems.push(`凭证重复（${DIM_LABEL[rec.dim]} · ${rec.desc || '（无描述）'}）⇒ 丢弃`);
        continue;
      }
      batch.vouchers.push(rec);
      out.produced += 1;
      report.push(`凭证产出（${DIM_LABEL[rec.dim]}）：${rec.desc || '（无描述）'}`);
      continue;
    }

    // ── 收回────────────────────────────────
    if (v.dim === VOUCHER_WAY) {
      problems.push('手段凭证**永不收回**（事件既成）⇒ 这条 recall 被丢弃');
      continue;
    }
    if (out.recalled >= RECALL_MAX_PER_SETTLE) {
      problems.push(`每次结算最多收回 ${RECALL_MAX_PER_SETTLE} 条凭证 ⇒ 这一条 recall 被丢弃`);
      continue;
    }
    const req: RecallRequest = { dim: v.dim, item: '', person: '' };
    if (v.dim === VOUCHER_ACHIEVEMENT) {
      if (v.item === '') {
        problems.push('成果收回没给 item（必须是那件既有物品的正式 id）⇒ 丢弃');
        continue;
      }
      req.item = v.item;
      // ⚠️ 成果收回 = 「这件东西没能留住」⇒ 系统把它**一并移出账本**。
      //    删除本身复用 `lost` 那条通道（`commitBatch` 会清 holder、再从账本里摘掉），
      //    不另写一遍删除逻辑 —— 同一件事两处实现正是本项目反复踩过的坑。
      batch.lost.items.push(v.item);
    } else {
      if (v.person === '') {
        problems.push('共鸣收回没给 person ⇒ 丢弃');
        continue;
      }
      req.person = v.person;
    }
    batch.vouchersRecalled.push(req);
    out.recalled += 1;
    report.push(`凭证收回（${DIM_LABEL[req.dim]}）：${v.desc || '（未给原因）'}`);
  }

  return out;
}
