// P5-0 · 玩家界面的后端 —— 零依赖 `node:http` ＋ 零依赖 `node:sqlite` 存档
//
//   node game/src/ui/server.ts                     # http://127.0.0.1:5188（离线 · 假 brain）
//   node game/src/ui/server.ts --port 6000 --seed 7
//   node game/src/ui/server.ts --live               # ⚠️ **真的游戏**：接真模型、真的花钱
//   node game/src/ui/server.ts --db /tmp/t.db       # 换一个存档库（冒烟脚本用它，别污染玩家的档）
//   node game/src/ui/server.ts --dev                # 开发模式：注入"页面自己刷新"那一段（磁盘上的 index.html 一字未改）
//
// 它做四件事：① 把 `index.html` 发出去；② 把 JSON 请求转成 `Session` 上的一个动作；
// ③ **存档**（`save/` 那个 SQLite 库）；④ 每次响应都带上同一份
//    `{ok, error, notice, ended, stepLog, view, feed, log, screen, saves}` ——
//    UI 侧**不需要自己拼状态**（它只认这份信封，不认账本）。
// ⚠️ **同时只处理一个 `POST /api/*`**（撞上来的第二个回 `409`，**不排队**）—— 见 `ui/gate.ts`：
//    每个动作都跨 `await`（真模型一次几十秒）⇒ 两个并发请求会交错：**双调模型**、
//    `steps +2` 却只落 1 项（丢更新）、两条随机流被交错消耗（"同种子可复现"就没了）。
//    只读的 `GET /api/view` 不过闸 —— 读没有理由被写阻塞。
//
// ⚠️ **起服务 = 停在标题屏**（`session === null`），不再自动开一局。
//    由玩家选一个槽「开始新的一局」或「继续」。这一步既让项目"像一个正规游戏"，
//    也顺手治掉了 P4~P5 "刷新页面 = 丢一局" 的老毛病。
// ⚠️ **每个游戏动作之后自动写回当前槽**（`autoSave`）：玩家看到什么，库里就是什么。
//    ⇒「保存并退出」不必另做一套落盘逻辑（它只是"写一次 ＋ 回标题屏"）。
//    ⚠️ 但**存档动作本身不回写** —— 否则「删档」会被紧接着的自动存档立刻写回来。见 `SAVE_ROUTES`。
// ⚠️ **brain 默认仍是 `fakeBrain`**（离线 · 零成本 · 可重复）；`--live` 才换成 `llmBrain` ——
//    与 `main.ts`「**默认路径永远离线**」同一条纪律。换的只是**构造 brain 的那一处**：
//    `Session` 与 `index.html` 一行都不必改，它们只认 `Brain` 那个接口（2026-09-20 落地）。
//    ⚠️ 读档同理：`SaveStore.load(slot, brain)` 由调用方**现给** brain ⇒
//       **同一份存档，离线假 brain 与真模型都能开**（快照刻意不存 brain，见 `ui/session.ts`）。
// ⚠️ `--live` 时每次响应都会把**玩家看得见的播报**重写进
//    `game/runs/<时间戳>-play/PLAY.md` —— 那是"这一局玩家到底看到了什么"的忠实留痕
//    （截图会过期，它不会）。**它只写盘、不改界面**，游玩体验一字不动。
// ⚠️ **只监听 `127.0.0.1`**：它不该被局域网里别的东西碰到。
// ⚠️ 没有 type-check（Node 只做 type stripping）⇒ 请求体一律当**不可信输入**处理：
//    逐个字段取值 + 缺省，绝不把 `body` 整个塞进 `Session`。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeBrain } from '../fixtures/fake.ts';
import type { Placements } from '../ledger/types.ts';
import { llmBrain } from '../llm/brain-llm.ts';
import { summarizeResult } from '../llm/client.ts';
import { loadConfig, type LlmConfig } from '../llm/config.ts';
import { SnapshotWriter } from '../llm/snapshot.ts';
import type { DangerZone } from '../rules/dice.ts';
import { TOTAL_DAYS } from '../rules/clock.ts';
import type { Brain } from '../turn/brain.ts';
import { busyPayload, labelOf, SerialGate } from './gate.ts';
import { SaveStore, SLOT_COUNT } from './save-flow.ts';
import { DEFAULT_UI_SEED, PLAYER_ID, Session, type ActionResult } from './session.ts';

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(n);
const valueOf = (n: string): string | null => {
  const i = argv.indexOf(n);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const PORT = Number(valueOf('--port') ?? 5188);
/** `/api/reset`（重开同种子）与标题屏上"本机默认种子"用的值；**新开一局默认随机**（见 `pickSeed`）。 */
const SEED = Number(valueOf('--seed') ?? DEFAULT_UI_SEED);
/** ⚠️ **全文件唯一**决定"这一局要不要花钱"的开关。默认关。 */
const LIVE = flag('--live');
/** 换一个存档库文件（默认 `game/saves/game.db`）。冒烟脚本靠它跑在一个临时库上。 */
const DB_FILE = valueOf('--db');
/**
 * **开发模式**（`--dev` · 默认关）：把"改了代码 ⇒ 页面自己跟上"这条闭环补上。
 *
 * ⚠️ 它**不往 `index.html` 里写一个字** —— 注入发生在**发出去之前**（`servedPage()`），
 *    磁盘上那份文件字节不变。不带 `--dev` 时走的就是原来的 `fs.readFileSync`，与以前逐字一致。
 * ⚠️ 所以它**不碰任何探针 / 截图基线**：`render-check-all.py` / `probe-overlay.mjs` /
 *    `shot-overlay.py` 读的都是磁盘上的 `index.html` 或它的副本，**从不走 HTTP**。
 * ⚠️ "重启"不归它管 —— 那是 `serve-ui.py` 默认带上的 `node --watch`（改 `.ts` 自动重启）。
 *    它只管"页面自己刷新"：`.ts` 重启完之后 rev 变了，页面在服务回来之后自己 `location.reload()`。
 */
const DEV = flag('--dev');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, 'index.html');
/** 源码树根（`game/src`）—— `--dev` 的 rev 要在它下面找 `.ts` / `.html`（见 `devRev`） */
const SRC = path.resolve(HERE, '..');

// ── brain：默认离线，`--live` 才接真模型 ─────────────────────────
//
// ⚠️ 这条分叉**只决定"要不要花钱"**，不决定"游戏怎么跑"：无论走哪一支，`Session`、
//    规则层、`index.html` 拿到的都是同一个 `Brain` 接口 ⇒ 真模型那一局与离线试玩
//    走的是**同一条代码路径**（这才是"玩家玩到的 = 你待会玩到的"的依据）。
let modeNote = '离线 · 假 brain（零成本 · 可重复）';
let brainFor: () => Brain = () => fakeBrain();
/** `--live` 的调用证据目录（`game/runs/<时间戳>-play/`）；离线时 `null` ⇒ 一个字都不写盘 */
let playDir: string | null = null;

if (LIVE) {
  let cfg: LlmConfig;
  try {
    cfg = loadConfig();
  } catch (e) {
    // ⚠️ **宁可不启动，也不静默退回假 brain** —— 后者会造出"这一局是真的"的假象
    //    （与 `turn/t0.ts·rewrite_desire`、`turn/prologue.ts` 那条"失败即抛"同一条纪律）。
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const snap = new SnapshotWriter('play');
  playDir = snap.dir;
  const b = llmBrain({
    cfg,
    snapshot: snap,
    onCall: (t) =>
      console.log(`  ⟳ ${t.stage} · ${t.callPoint} 第 ${t.attempt} 次 —— ${summarizeResult(t.result)}`),
  });
  brainFor = () => b;
  modeNote = `⚠️ 真模型 ${cfg.model} · 调用证据落 ${snap.dir}`;
}

// ── 存档 ＋ 当前这一局 ───────────────────────────────────────────
//
// ⚠️ `session === null` **就是"停在标题屏"**：不另设一个 `screen` 变量 ——
//    两个事实源迟早会各漂各的（本项目的老坑）。
const store = new SaveStore(DB_FILE ?? undefined);
/** 这一局要写回哪个槽；`null` = 还没有归属（还没开局 / 档刚被删掉） */
let currentSlot: number | null = null;
/** ⚠️ 起手**不开局** —— 玩家在标题屏上选一个槽才开 */
let session: Session | null = null;

/**
 * **串行闸**：同时只准一个 `POST /api/*` 在跑（撞上来的第二个回 409，**不排队**）。
 *
 * ⚠️ 它是**服务端**的约束，不是客户端那颗 `setBusy` 的补充说明：两个标签页、脚本、
 *    `curl` 都不受前端约束。实测口径与三条后果写在 `ui/gate.ts` 顶上。
 */
const gate = new SerialGate();

/**
 * 把当前这一局写回它所在的槽。
 *
 * ⚠️ 没有当前槽时**什么都不做**：宁可"这一局暂时没存档"，
 *    也**不要**替玩家挑一个槽把别人的档盖掉。
 */
function autoSave(): void {
  if (session === null || currentSlot === null) return;
  store.put(currentSlot, session);
}

// ── 小工具 ────────────────────────────────────────────────────

const OK: ActionResult = { ok: true, error: '', notice: '', log: [], ended: false };

/**
 * 把**玩家看得见的播报**重写进 `<playDir>/PLAY.md`（`--live` 才写；离线 `playDir === null` ⇒ 空操作）。
 *
 * ⚠️ 刻意**每次响应整份重写**（而不是追加）：`Session.feed` 会被裁到 200 条，
 *    用"追加"就得维护水位，裁掉之后水位会失准、悄悄漏记 —— 整份重写没有这个自由度。
 * ⚠️ 它**只写盘**：不改 `view`、不改 `feed`、不碰界面。重开一局时 `feed` 清空 ⇒ 文件跟着清空。
 */
function tracePlay(): void {
  if (playDir === null || session === null) return;
  const head = [
    '# 这一局玩家看到的',
    '',
    `> 由 \`ui/server.ts --live\` 自动重写（最新一次动作后的全量快照）· 种子 ${session.seed}`,
    '> ⚠️ 这是**忠实留痕**：内容与玩家在界面上看到的播报同源（`Session.feed`），不额外加料。',
    '',
  ].join('\n');
  const body = session.feed.map((f) => `## 第 ${f.day} 天 · ${f.kind} · ${f.title}\n\n${f.text}\n`).join('\n');
  fs.writeFileSync(path.join(playDir, 'PLAY.md'), `${head}\n${body}`, 'utf8');
}

/**
 * 统一信封：动作结果 ＋ 全量视图 ＋ 播报 ＋ 日志。
 *
 * ⚠️ 两种信封由 `screen` 区分，**不让 UI 用"有没有 `view`"去猜**：
 *    · `screen: 'game'`   —— `view` / `feed` / `log` 齐全，外加 `slot`（这一局存在哪个槽）；
 *    · `screen: 'title'`  —— `view` 为 `null`，只有 `saves`（四个槽的摘要列）。
 * ⚠️ `saves` **两种信封都带**（四个槽，很小）：标题屏要它，局内「保存并退出」之后
 *    回标题屏也要它 ⇒ 一条路，不必再补一次请求。而摘要列是**只查列**、不解析 JSON 的
 *    （`SaveDb.list` 的设计意图），所以每个动作多这一次查询是廉价的。
 */
function envelope(r: ActionResult): Record<string, unknown> {
  const saves = store.list();
  const meta = { slots: SLOT_COUNT, totalDays: TOTAL_DAYS, live: LIVE, modeNote, seed: SEED, db: store.file };

  if (session === null) {
    return {
      ok: r.ok,
      error: r.error,
      notice: r.notice,
      ended: false,
      stepLog: r.log,
      log: [],
      feed: [],
      view: null,
      screen: 'title',
      slot: null,
      saves,
      meta,
    };
  }

  tracePlay();
  return {
    ok: r.ok,
    error: r.error,
    notice: r.notice,
    ended: r.ended || !!session.ledger.ending,
    stepLog: r.log,
    view: session.view(),
    feed: session.feed,
    log: session.log,
    screen: 'game',
    slot: currentSlot,
    saves,
    meta,
  };
}

function sendJson(res: http.ServerResponse, code: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8');
    });
    req.on('end', () => {
      if (raw.trim() === '') return resolve({});
      try {
        const j: unknown = JSON.parse(raw);
        resolve(typeof j === 'object' && j !== null ? (j as Record<string, unknown>) : {});
      } catch {
        // 坏 JSON 不该把服务打挂：当空体处理，让前面的字段校验去报错
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

const str = (b: Record<string, unknown>, k: string, dflt = ''): string => (typeof b[k] === 'string' ? (b[k] as string) : dflt);
const num = (b: Record<string, unknown>, k: string, dflt = 0): number => (typeof b[k] === 'number' && Number.isFinite(b[k]) ? (b[k] as number) : dflt);
const ids = (b: Record<string, unknown>, k: string): string[] =>
  Array.isArray(b[k]) ? (b[k] as unknown[]).filter((x): x is string => typeof x === 'string') : [];

/**
 * 危险区 —— **只有显式给出合法值才带**，否则返回 `undefined`，交给规则层按欲念推导（`dangerZoneOf`）。
 *
 * ⚠️ 2026-09-21 之前这里恒 `(str(body,'zone','正常') || '正常')`：UI 根本不发这个字段，
 *    于是**每一次**排布 / 场景轮都被喂了一个假的 `'正常'` ⇒ handle.ts / scene.ts 里
 *    那句 `?? dangerZoneOf(...)` 永远走不到。这是「危险区从未生效」的**上游那一半**
 *    （下游那一半见 `ui/session.ts·sceneSay`）。
 */
const ZONES: readonly DangerZone[] = ['正常', '迷失', '沉溺'];
function zoneOf(b: Record<string, unknown>): DangerZone | undefined {
  const z = str(b, 'zone');
  return (ZONES as readonly string[]).includes(z) ? (z as DangerZone) : undefined;
}

/** 放格子：只认三个已知的槽位，其余一律丢弃（`null` = 交给 `autoPlace`） */
function placementsOf(b: Record<string, unknown>): Placements | undefined {
  if (!b.placements || typeof b.placements !== 'object') return undefined;
  const p = b.placements as Record<string, unknown>;
  const pick = (k: string): string | null => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : null);
  return { 成果: pick('成果'), 手段: pick('手段'), 共鸣: pick('共鸣') };
}

/** 从请求体取槽号；非法 / 越界 ⇒ `null`（调用侧回一条能读的错） */
function slotOf(b: Record<string, unknown>): number | null {
  const n = num(b, 'slot', NaN);
  if (!Number.isInteger(n) || n < 0 || n >= SLOT_COUNT) return null;
  return n;
}

function badSlot(b: Record<string, unknown>): ActionResult {
  return {
    ok: false,
    error: `槽位号不对（收到 ${JSON.stringify(b.slot ?? null)}）—— 只有 0 ~ ${SLOT_COUNT - 1} 这四个槽`,
    notice: '',
    log: [],
    ended: false,
  };
}

/**
 * 新开一局用哪个种子。
 *
 * ⚠️ **默认随机**（而不是沿用 `--seed`）："换一局"就该真的换一局。
 *    要复现某一局时，客户端显式传 `{seed: N}`（标题屏上那个输入框就是干这个的）。
 * ⚠️ 只在**服务端**算：不拿客户端传来的随机数当种子，也不让客户端决定"随机"这件事
 *    （请求体是不可信输入）。
 */
function pickSeed(b: Record<string, unknown>): number {
  const n = Math.trunc(num(b, 'seed', NaN));
  if (Number.isFinite(n) && n !== 0) return n;
  return Math.floor(Math.random() * 2147483647);
}

// ── 路由 ──────────────────────────────────────────────────────

/** 返回 `null` = 不是一条 API（交给 404） */
async function route(pathname: string, body: Record<string, unknown>): Promise<ActionResult | null> {
  // ── 标题屏：四个存档槽 ────────────────────────────────────────
  //
  // ⚠️ 这三条（new / load / delete）**没有一条会调 LLM**：开局那一次翻牌（`opening`）
  //    确实是一次调用，但它发生在 `Session.start` 里 —— 与"新建一个槽"是同一件事，
  //    所以这里仍然只是"把开局交给会话层"。
  if (pathname === '/api/save/new') {
    const slot = slotOf(body);
    if (slot === null) return badSlot(body);
    const seed = pickSeed(body);
    // ⚠️⚠️ 2026-10-06：`requireLive: LIVE` —— `--live` 时缺 brain **当场抛**，
    //    不再静默回落成假模型（那会造出"这一局是真的"的假象；用户裁定的问题 8）。
    const s = await Session.start({ seed, brain: brainFor(), requireLive: LIVE });
    session = s;
    currentSlot = slot;
    // ⚠️ **开局就落一次盘**：此刻玩家若直接按「保存并退出」，不该留下一个空槽
    //    （而且"这一局是什么时候开局的"要当场记下来）。
    store.put(slot, s);
    return { ok: true, error: '', notice: `新的一局开始了（种子 ${seed}）—— 先从序幕读起`, log: [], ended: false };
  }

  if (pathname === '/api/save/load') {
    const slot = slotOf(body);
    if (slot === null) return badSlot(body);
    let s: Session | null;
    try {
      s = store.load(slot, brainFor());
    } catch (e) {
      // ⚠️ 坏档 / 版本不符 ⇒ **原样报给玩家**，不静默开新局：那会让"读不动"看起来像"进度没了"
      return { ok: false, error: `读档失败：${e instanceof Error ? e.message : String(e)}`, notice: '', log: [], ended: false };
    }
    if (s === null) {
      return { ok: false, error: `槽 ${slot + 1} 是空的 —— 没有档可读`, notice: '', log: [], ended: false };
    }
    session = s;
    currentSlot = slot;
    return { ok: true, error: '', notice: `读了槽 ${slot + 1}`, log: [], ended: !!s.ledger.ending };
  }

  if (pathname === '/api/save/put') {
    if (session === null || currentSlot === null) {
      return { ok: false, error: '现在没有进行中的一局（或这一局还没有归属的槽）', notice: '', log: [], ended: false };
    }
    const slot = currentSlot;
    store.put(slot, session);
    session = null;
    currentSlot = null;
    // ⚠️ 顺序：先写盘、再清会话。反过来的话这一步就没有会话可写了。
    return { ok: true, error: '', notice: `已保存 —— 这一局存在槽 ${slot + 1}`, log: [], ended: false };
  }

  if (pathname === '/api/save/delete') {
    const slot = slotOf(body);
    if (slot === null) return badSlot(body);
    const existed = store.list()[slot] !== null;
    store.remove(slot);
    // ⚠️ 删掉的正是**正在玩的那一档** ⇒ 连同会话一起放下、回标题屏。
    //    不这么做的话，紧随其后的自动存档会当场把档**写回来**，玩家会看到"删不掉"。
    if (currentSlot === slot) {
      session = null;
      currentSlot = null;
    }
    return {
      ok: true,
      error: '',
      notice: existed ? `删掉了槽 ${slot + 1}` : `槽 ${slot + 1} 本来就是空的`,
      log: [],
      ended: false,
    };
  }

  // 回标题屏 —— ⚠️ **不落盘**：每个动作之后都已经自动存过了，这里只是"放下这一局"。
  //    （要"存一份再走"请走 `/api/save/put`；两者在库里结果相同，差别只在话术。）
  if (pathname === '/api/title') {
    if (session === null) return OK;
    const slot = currentSlot;
    session = null;
    currentSlot = null;
    return { ok: true, error: '', notice: slot === null ? '' : `这一局的进度已经在槽 ${slot + 1} 里`, log: [], ended: false };
  }

  // ── 局内 ──────────────────────────────────────────────────────
  //
  // ⚠️ 每一条都过 `withSession`：没有会话时（比如前端停在一个陈旧的页面上点了按钮）
  //    回一条能读的错，而不是 `Cannot read properties of null`。
  // ⚠️ 为什么不写成"进 switch 之前先 `if (session === null) return …`"：
  //    那样**不存在的接口**在标题屏上会得到 `200 + "停在标题屏"`，而正确的答案是 **404** ——
  //    "没有这条接口"与"现在不能做这件事"是两件不同的事，不该混成同一句话。
  //    （本轮实测踩过：冒烟里 `/api/nope` 拿到了 200。）
  //    而写成包装函数就不必再维护第二份"哪些路由存在"的清单（那正是"同一口径两处实现"的老坑）。
  const withSession = (
    f: (s: Session) => ActionResult | Promise<ActionResult>,
  ): ActionResult | Promise<ActionResult> => {
    if (session === null) {
      return { ok: false, error: '现在停在标题屏 —— 先选一个存档槽（或新开一局）', notice: '', log: [], ended: false };
    }
    return f(session);
  };

  switch (pathname) {
    // ⚠️ `await` 是必须写出来的（虽然 `route` 是 async、返回值会被自动 await）：
    //    `Session.clickPopup` 从 P4-D 起是 **async** —— 序幕末条那一次要翻牌（`opening` 调用），
    //    链路上的异步必须一路直达 HTTP 响应，不能让 UI 拿到一个"还没翻牌"的视图。
    case '/api/popup':
      return await withSession((s) => s.clickPopup(str(body, 'eventId'), num(body, 'optionIndex', 0)));

    // ⚠️ **2026-10-05 用户裁定：欲望与六维都改成玩家自己选** ⇒ 新增这一个入口。
    //    它是**纯会话态**的一次动作（`Session.pickDesire` 零 LLM、零落账）——
    //    真正的落账在玩家点序幕末条那一刻（`clickPopup` → `afterPrologueCard` → `driveOpening`）。
    //    ⚠️ **刻意不叫 `/api/desire` 就完事**：它一次收两样（欲望 ＋ 优势属性），
    //    名字里带 `pick` 是为了说清"这是玩家的选择"，不是"系统在改你的存档"。
    //    ⚠️ 同步的（不 `await`）：`pickDesire` 没有任何异步；写成 async 只为与旁边同形。
    case '/api/desire/pick':
      return await withSession((s) => s.pickDesire(num(body, 'kit', -1), ids(body, 'advantages')));

    case '/api/arrange':
      return await withSession((s) =>
        s.arrange({
          eventId: str(body, 'eventId'),
          participants: ids(body, 'participants'),
          goldInput: Math.max(0, Math.trunc(num(body, 'goldInput', 0))),
          usedItemId: str(body, 'usedItemId') || null,
          note: str(body, 'note'),
          zone: zoneOf(body),
        }),
      );

    // 玩家自建（「我想做点什么」）—— 一句话换一条新的事件卡。
    // ⚠️ 原话**逐字**交给会话层（它只做 trim），不在这里截断 / 清洗：
    //    它会原样进 user ③ 的【玩家的处理方式】，改一个字都算篡改玩家输入。
    case '/api/create':
      return await withSession((s) => s.createEvent(str(body, 'approach')));

    // ⚠️ 2026-10-06：**装填通路**（用户裁定「能拖过去就能拖回来」）。
    //    判据在 `rules/gates.ts` 闸门 ⑤（`CARRY_CAP` ＋ 持有者唯一），
    //    但此前 `loadItems` 在整个 `ui/` 零引用 —— 这条路由就是那个「生产路径」。
    //    ⚠️ `to` 缺省是**收回自己**（玩家）：拖回自己那张卡 = 取回。
    case '/api/give':
      return await withSession((s) =>
        s.give(str(body, 'to') || PLAYER_ID, ids(body, 'items')));

    // ⚠️ 2026-10-07：**槽位排序**（人物详情页四个物品卡槽拖动换位）。
    //    `effectiveItems` 已改纯槽位顺序 ⇒ 左右顺序 = 生效优先级 = 账本字段，
    //    `/api/give` 只会 push 到尾、调不出"挪到最前" ⇒ 这条是那个缺失的写通路。
    case '/api/items/order':
      return withSession((s) => s.reorderItems(str(body, 'who'), ids(body, 'order')));

    case '/api/dial':
      return await withSession((s) => s.dial(Math.trunc(num(body, 'n', 0))));

    case '/api/nextday':
      return await withSession((s) => s.nextDay());

    case '/api/scene/open':
      return withSession((s) =>
        s.openScene({
          eventId: str(body, 'eventId'),
          participants: ids(body, 'participants'),
          goldInput: Math.max(0, Math.trunc(num(body, 'goldInput', 0))),
          usedItemId: str(body, 'usedItemId') || null,
        }),
      );

    case '/api/scene/say':
      // ⚠️ 2026-10-07：场景不掷骰 ⇒ `zone` 在场景这条路上没有落点（危险区只管裁定/掷骰链）。
      return await withSession((s) => s.sceneSay(str(body, 'text')));

    case '/api/scene/leave':
      return await withSession((s) => s.sceneLeave());

    case '/api/restore': {
      const place = str(body, 'place');
      if (place !== '医馆' && place !== '大神殿') {
        return { ok: false, error: `未知的恢复入口「${place}」（只有 医馆 / 大神殿）`, notice: '', log: [], ended: false };
      }
      return await withSession((s) => s.restore(place, ids(body, 'targets')));
    }

    case '/api/finish':
      return await withSession((s) => s.finish(placementsOf(body)));

    /**
     * **直接结算** —— 玩家主动结束这一局（按 `HP = 0` 判，`Session.abandon`）。
     * ⚠️ 这里是**唯一**会"一步跳到终局"的入口，而它走的仍是规则层既有的总表第 1 行 ⇒
     *    不需要 UI 或服务端自己拼一套"放弃"话术（那会造出第二套真相）。
     * ⚠️ 结算完**立刻写回槽**：这一局的终局记录要留痕（由调用侧的统一自动存档完成）。
     */
    case '/api/giveup':
      return withSession((s) => s.abandon());

    /**
     * **重开**（覆盖当前槽 · 同种子）—— ⚠️ 服务端保留它**是给冒烟脚本 / 排错用的**，
     * 页面上没有这颗按钮了（玩家要的是「保存并退出」与「直接结算」）。
     */
    case '/api/reset': {
      if (session === null) {
        return { ok: false, error: '现在停在标题屏 —— 要开新的一局请走 /api/save/new', notice: '', log: [], ended: false };
      }
      const seed = Math.trunc(num(body, 'seed', session.seed)) || SEED;
      // ⚠️ 同一处纪律（2026-10-06）：`--live` 时缺 brain 当场抛，不静默回落
      session = await Session.start({ seed, brain: brainFor(), requireLive: LIVE });
      return { ok: true, error: '', notice: `重开一局（种子 ${seed}）`, log: [], ended: false };
    }

    default:
      return null;
  }
}

/**
 * 这些路由**不回写存档** —— 它们自己就是存档操作。
 *
 * ⚠️ 不加这一条，「删掉槽 0」会被紧随其后的自动存档**立刻写回来**，玩家看到的是"删不掉"。
 *    而 `new` / `put` 已经自己写过盘了，再写一遍只是白白多一次 IO。
 */
const SAVE_ROUTES = new Set(['/api/save/new', '/api/save/load', '/api/save/put', '/api/save/delete', '/api/title']);

// ── 开发模式：把"页面自己刷新"那一段注入进去（`--dev` 才走这条路）──────
//
// ⚠️ 为什么不直接写进 `index.html`：那份文件是**玩家面**，还有一整套探针 / 截图基线挂在它上面
//    （`render-check.mjs` 按源码级断言逐块读它）。往里塞 dev 代码 = 让"开发时的样子"与
//    "玩家看到的样子"不再是同一份东西 —— 而本项目的立身之本恰恰是**两者同源**
//    （见 `server.ts` 顶栏："玩家玩到的 = 你待会玩到的"）。注入法把 dev 痕迹挡在传输层。
const DEV_SCRIPT = [
  '<script>',
  '// dev · 页面自己跟上代码 —— 由 `ui/server.ts --dev` 注入（磁盘上的 index.html 里没有这一段）',
  '(function () {',
  "  console.log('[dev] 热更新已开：index.html 或任何 .ts 一变，这个页面就自己刷新');",
  '  var seen = null;',
  '  function tick() {',
  "    fetch('/api/dev/rev', { cache: 'no-store' })",
  '      .then(function (r) { return r.json(); })',
  '      .then(function (j) {',
  "        if (typeof j.rev !== 'number') return;",
  '        if (seen === null) { seen = j.rev; return; }',   // 首轮只记基线，不刷
  '        if (j.rev !== seen) location.reload();',
  '      })',
  "      .catch(function () { /* 服务正在重启 ⇒ 下一次轮询再说，绝不因此报错刷屏 */ });",
  '  }',
  '  setInterval(tick, 700);',
  '  tick();',
  '})();',
  '</script>',
].join('\n');

/**
 * 源码树的**最新修改时间**（毫秒）—— 页面拿它当"代码变了没有"的唯一判据。
 *
 * ⚠️ 收两类文件：发出去的那一页（`index.html`）＋ `game/src` 下所有 `.ts`。
 *    两类都不收的话：只改 `.ts` 时页面不会自己刷（重启完停在旧页面上），
 *    只改 `.html` 时倒是能看到 —— 一半的活儿。
 * ⚠️ **200ms 缓存**：轮询是 700ms 一次，但同一次渲染里可能被问两次；stat 几十个文件很便宜，
 *    缓存只是不让它在极端情况下变成一场 stat 风暴。
 */
let revCache: { at: number; rev: number } | null = null;
function devRev(): number {
  const now = Date.now();
  if (revCache !== null && now - revCache.at < 200) return revCache.rev;
  let max = 0;
  const bump = (p: string): void => {
    try {
      const m = fs.statSync(p).mtimeMs;
      if (m > max) max = m;
    } catch {
      // 文件刚被删 / 改名 ⇒ 忽略这一条（下一次轮询它会以"不存在"稳定下来）
    }
  };
  bump(PAGE);
  try {
    for (const rel of fs.readdirSync(SRC, { recursive: true, encoding: 'utf8' })) {
      if (rel.endsWith('.ts') || rel.endsWith('.html')) bump(path.join(SRC, rel));
    }
  } catch {
    // 目录读不到 ⇒ 只认 PAGE 一个（退化成"只跟 index.html"，不会把服务弄挂）
  }
  revCache = { at: now, rev: max };
  return max;
}

/** 发出去的那一页 —— 不带 `--dev` 时与 `fs.readFileSync(PAGE)` **逐字相同** */
function servedPage(): string {
  const html = fs.readFileSync(PAGE, 'utf8');
  if (!DEV) return html;
  return html.includes('</body>') ? html.replace('</body>', `${DEV_SCRIPT}\n</body>`) : html + DEV_SCRIPT;
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      try {
        const html = servedPage();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
      } catch (e) {
        sendJson(res, 500, { ok: false, error: `读不到 ${PAGE}：${e instanceof Error ? e.message : String(e)}` });
      }
      return;
    }

    // ⚠️ **只在 `--dev` 下存在**：不带它就回 404（这个接口对玩家面毫无意义，
    //    而"多一个接口"本身也是一种面）。⚠️ 它是 GET ⇒ **不过串行闸**（读没有理由被写阻塞）。
    if (DEV && req.method === 'GET' && url.pathname === '/api/dev/rev') {
      sendJson(res, 200, { rev: devRev() });
      return;
    }

    // ⚠️ 只认 GET（POST 走下面的 `/api/` 分支）—— 停在标题屏时它回的是**标题屏信封**。
    if (req.method === 'GET' && url.pathname === '/api/view') {
      sendJson(res, 200, envelope(OK));
      return;
    }

    /**
     * ⚠️⚠️ **2026-10-07 用户裁定：场景对话的回应以流式呈现** ⇒ 这一条**不走通用 JSON 路径**：
     *   `text/event-stream`，流内两件事 ——
     *     · `data: {"t":"…"}`   —— narration 增量（真模型一路吐；假 brain 一条都不发）
     *     · `data: {"done":信封}` —— 收尾的**完整信封**（与通用路径同一个 `envelope()`，前端同口吃）
     *   错误也走流内（`data: {"err":"…"}`）：SSE 头一出去 HTTP 层就 200 了，错误只能塞进流里。
     * ⚠️ 串行闸**照过**（它是一次真 LLM 调用），`autoSave` 照写 —— 除了响应形状，其余与
     *   通用路径**逐字同一套纪律**。
     */
    if (req.method === 'POST' && url.pathname === '/api/scene/say') {
      const body = await readBody(req);
      const label = labelOf(url.pathname);
      if (!gate.enter(label)) {
        const running = gate.busy ?? '上一个动作';
        console.log(`  ⛔ 拒绝了一个并发请求：${url.pathname}（正在跑：${running}）`);
        sendJson(res, 409, busyPayload(running));
        return;
      }
      try {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        const r =
          session === null
            ? { ok: false, error: '现在停在标题屏 —— 先选一个存档槽（或新开一局）', notice: '', log: [], ended: false }
            : await session.sceneSay(str(body, 'text'), (t) => {
                res.write(`data: ${JSON.stringify({ t })}\n\n`);
              });
        if (!SAVE_ROUTES.has(url.pathname)) autoSave();
        res.write(`data: ${JSON.stringify({ done: envelope(r) })}\n\n`);
        res.end();
      } catch (e) {
        // 动作抛了（LLM 失败 / 规则层结构错）——存档照写（与通用路径的 catch 同一纪律），
        // 错误塞进流里交给前端横幅。
        if (!SAVE_ROUTES.has(url.pathname)) autoSave();
        try {
          res.write(`data: ${JSON.stringify({ err: e instanceof Error ? e.message : String(e) })}\n\n`);
          res.end();
        } catch {
          // 连接已经断了 —— 没有收件人可通知，放行
        }
      } finally {
        gate.leave();
      }
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const body = await readBody(req);
      // ── 串行闸：同时只准一个动作在跑 ─────────────────────────────
      //
      // ⚠️ 位置是**要害**：必须落在 `await route(...)` **之前**。
      //    挂在 `autoSave()` 那一层没有用 —— 动作本身跨 `await`（`--live` 下一次调用几秒到几十秒），
      //    那段时间里第二条请求的 `readBody` 早就完成、一路走到 `route` 里去了。
      //    ⚠️ 反过来也要知道：**这道闸离线量不到** —— 假 brain 全程是 microtask
      //    （`fixtures/fake.ts` 里没有 `setTimeout`）⇒ `route()` 不跨墙钟、两条请求天然串行。
      //    别把"离线跑不出 409"当成"闸没生效"：行为证据在 `test/server.test.ts`（真叠两条 async），
      //    离线量得到的那一道是 `session.ts·arrange` 的状态守卫（`probe-concurrent.py`）。
      // ⚠️ 只拦 POST：只读的那条是 `GET /api/view`，它没有被写阻塞的理由。
      const label = labelOf(url.pathname);
      if (!gate.enter(label)) {
        const running = gate.busy ?? '上一个动作';
        // 服务端也留一行痕迹 —— `--live` 的调用证据里该看得到"有一个请求被拒了"
        console.log(`  ⛔ 拒绝了一个并发请求：${url.pathname}（正在跑：${running}）`);
        sendJson(res, 409, busyPayload(running));
        return;
      }
      try {
        const r = await route(url.pathname, body);
        if (r === null) {
          sendJson(res, 404, { ok: false, error: `没有这条接口：${url.pathname}` });
          return;
        }
        // ⚠️ 动作成功与否都写：闸门拦下也是"这一局走到了这里"的状态
        //    （`steps` 会涨、日志会长），漏写会让读档回来少一截痕迹。
        if (!SAVE_ROUTES.has(url.pathname)) autoSave();
        sendJson(res, 200, envelope(r));
      } catch (e) {
        // 规则层抛出来的都是"结构性错误"（不该发生）——原样回给 UI，别静默吞掉
        // ⚠️ **抛错也要写回存档**（2026-09-23 补）：`route()` 里可能"改了一半再抛" ——
        //    最典型的就是档 A 已经点掉、紧随其后的翻牌被落地层拒了（`session.ts·clickPopup`）。
        //    此前这条路径**跳过 `autoSave()`** ⇒ 存档里留着"点选之前"的样子，
        //    而页面上那份信封又是旧的 ⇒ 读档回来会看见一条已经点过的事件又变回「待处理」
        //    （与库里那份对不上）。这里补上：**动作成功与否，都是"这一局走到了这里"的状态**。
        if (!SAVE_ROUTES.has(url.pathname)) autoSave();
        sendJson(res, 500, { ok: false, error: `${e instanceof Error ? e.message : String(e)}` });
      } finally {
        // ⚠️ 放闸**必须在 `finally`**：抛错与早返回（404 那条）都要放，
        //    否则这一局就永远卡在"忙"上 —— 比"并发"本身更难查（像是"点什么都没反应"）。
        gate.leave();
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: `不认识 ${req.method} ${url.pathname}` });
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`《王国三王子》· 玩家界面已就绪（${modeNote}）`);
  console.log(`  http://127.0.0.1:${PORT}`);
  console.log(`  存档库：${store.file}（${SLOT_COUNT} 个槽 · 起手停在标题屏，选一个槽才开局）`);
  if (DEV) console.log('  ⚙ 开发模式（--dev）：页面会在代码变更后**自己刷新**（改 .ts 的重启由 --watch 负责）');
  if (LIVE) {
    console.log('  ⚠️ 真模型已开启：这一局会真的发请求、真的花钱（每次调用都落证据）');
  } else {
    console.log('  （离线假 brain —— 要玩「真的游戏」请加 --live）');
  }
});
