// 临时编号
//
// 新建实体一律填**批次内临时编号**（`@` 开头，本批唯一）→ 系统落地时分配正式 id，
// 并把本批所有对该编号的引用一并改写。**不再有「空串 = 新建」的写法**。
// 事件是唯一例外：其 id 用 `e1` / `e2`，不必加 `@`（含义相同）。

export type EntityKind = 'npc' | 'it' | 'loc';

export interface TempId {
  kind: EntityKind;
  seq: number;
  text: string;
}

/** `@p1` → 人物 · `@it1` → 物品 · `@loc1` → 地点 */
export const TEMP_ID_RE = /^@(p|it|loc)(\d+)$/;

const TEMP_PREFIX_TO_KIND: Record<string, EntityKind> = { p: 'npc', it: 'it', loc: 'loc' };
const KIND_TO_PREFIX: Record<EntityKind, string> = { npc: 'p', it: 'it', loc: 'loc' };

/** 正式 id：**一律 3 位起**（`npc001` / `it003` / `loc010`） */
export const FORMAL_ID_RE: Record<EntityKind, RegExp> = {
  npc: /^npc\d{3,}$/,
  it: /^it\d{3,}$/,
  loc: /^loc\d{3,}$/,
};

/** 事件局部编号 */
export const EVENT_TEMP_ID_RE = /^e\d+$/;

export const ROLE_WORDS = ['玩家', '参与者', '主事者'] as const;
export type RoleWord = (typeof ROLE_WORDS)[number];

export function isRoleWord(s: string): s is RoleWord {
  return (ROLE_WORDS as readonly string[]).includes(s);
}

export function parseTempId(s: string): TempId | null {
  const m = TEMP_ID_RE.exec(s);
  if (!m) return null;
  const kind = TEMP_PREFIX_TO_KIND[m[1]];
  if (!kind) return null;
  return { kind, seq: Number(m[2]), text: s };
}

export function isFormalIdOfKind(s: string, kind: EntityKind): boolean {
  return FORMAL_ID_RE[kind].test(s);
}

/** 是不是任意一种正式 id */
export function isAnyFormalId(s: string): boolean {
  return (Object.keys(FORMAL_ID_RE) as EntityKind[]).some((k) => FORMAL_ID_RE[k].test(s));
}

export function isEventTempId(s: string): boolean {
  return EVENT_TEMP_ID_RE.test(s);
}

/** `npc` + 7 → `npc007`（3 位起，超过 3 位自然变长） */
export function formatId(kind: EntityKind, n: number): string {
  return kind + String(n).padStart(3, '0');
}

/** `npc` + 7 → `@p7`（回写引用时用不到，但测试与报错信息要用） */
export function formatTempId(kind: EntityKind, n: number): string {
  return '@' + KIND_TO_PREFIX[kind] + n;
}

/** 规范化：把同一批里指向同一个临时编号的写法收敛（`@p01` 与 `@p1` 视为同一个） */
export function normalizeTempId(s: string): string {
  const t = parseTempId(s);
  return t ? formatTempId(t.kind, t.seq) : s;
}
