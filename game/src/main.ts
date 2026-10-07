// Phase 2 验收入口
//
//   node game/src/main.ts                 # 单测 + 3 个种子的 28 天（**离线**，假 brain）
//   node game/src/main.ts --tests         # 只跑单测
//   node game/src/main.ts --seed 42       # 只跑某个种子（28 天驱动）
//   node game/src/main.ts --dry           # 组装真实请求体并打印 —— **一字符不发网络**
//   node game/src/main.ts --live          # 真调一条：裁定 → 投骰 → 结算 → 落账，快照落盘
//   node game/src/main.ts --live-sim --seed 7  # ⚠️ 真调**一整局 28 天**（数十次调用、真的花钱）
//                                        #    —— P6-A 标定 / Phase 6 联调用的仪器；快照落 game/runs/
//   node game/src/main.ts --replay <dir>  # 用快照重跑，**逐字比对**落账载荷
//   node game/src/main.ts --rebaseline <dir>  # ⚠️ 有意改过夹具 / 开局数据后，重推该 run 的 PAYLOAD.json（"答案纸"）
//
// ⚠️ **默认路径永远离线**。真实调用必须显式 `--live` —— 这是 Phase 1 那条
//    "不花钱、可重复"的基线的延续。
//
// Node 22 直接吃 `.ts`（type stripping），无需 `npm install` / `tsc`。
//
// ⚠️ 结构纪律：**所有 `const` 都必须在分派之前执行**（`runSim` 读 `WIDTHS` 等模块级常量）
//    ⇒ 分派块（`await runAll(...)` 与各模式）刻意放在**文件末尾**，不在顶部。
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_HANDLING, sliceLedger } from './fixtures/event-card.ts';
import { hash, renderStaticHead } from './frozen/static-head.ts';
import { buildArchiveRequest, buildCheckRequest, buildChapterShiftRequest, buildComposeRequest, buildCreateRequest, buildEndingRequest, buildIgnoreRequest, buildSettleRequest, llmBrain, type CallTrace } from './llm/brain-llm.ts';
import { summarizeResult } from './llm/client.ts';
import { loadConfig, type LlmConfig } from './llm/config.ts';
import { replayBrain } from './llm/replay.ts';
import { SnapshotWriter } from './llm/snapshot.ts';
import { IGNORE_NOTE, type HandlingRecord } from './prompt/blocks.ts';
import { TOTAL_DAYS } from './rules/clock.ts';
import { makeRng } from './rules/rng.ts';
import { planArchive } from './rules/archive.ts';
import { drawDivinationCards } from './rules/tarot.ts';
import { runAll, type Suite } from './test/harness.ts';
import { suites as archiveSuites } from './test/archive.test.ts';
import { suites as chapterShiftSuites } from './test/chapter-shift.test.ts';
import { suites as checkpointSuites } from './test/checkpoint.test.ts';
import { suites as contractSuites } from './test/contract.test.ts';
import { suites as createSuites } from './test/create.test.ts';
import { suites as enlistSuites } from './test/enlist.test.ts';
import { suites as endingLlmSuites } from './test/ending-llm.test.ts';
import { suites as endingSuites } from './test/ending.test.ts';
import { suites as initialSuites } from './test/initial.test.ts';
import { suites as ledgerSuites } from './test/ledger.test.ts';
import { suites as openingSuites } from './test/opening.test.ts';
import { suites as promptSuites } from './test/prompt.test.ts';
import { suites as prologueSuites } from './test/prologue.test.ts';
import { suites as requiredPersonSuites } from './test/required-person.test.ts';
// ⚠️ 2026-10-05：`rewrite.test.ts` 已随 `rewrite_desire` 侧链一起删除（命题一生只写一次），
//    但这两行引用还留着 ⇒ `--tests` 直接 `ERR_MODULE_NOT_FOUND` 起不来。一并撤掉。
import { suites as rulesSuites } from './test/rules.test.ts';
import { suites as saveSuites } from './test/save.test.ts';
import { suites as sceneSuites } from './test/scene.test.ts';
import { suites as serverSuites } from './test/server.test.ts';
import { suites as uiSuites } from './test/ui.test.ts';
import { autoPlace, simulate, type DaySnapshot } from './turn/simulate.ts';
import type { Brain } from './turn/brain.ts';
import { closeGame } from './turn/ending.ts';
import { ENDING_FLAVOR_NOTES } from './prompt/instructions.ts';
import { runSlice, type Reading, type SliceReport } from './turn/slice.ts';

// ── 参数 ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(n);
const valueOf = (n: string): string | null => {
  const i = argv.indexOf(n);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};

const onlyTests = flag('--tests');
const dry = flag('--dry');
const live = flag('--live');
// ⚠️ `--live-sim` 与 `--live` 是**两件事**：前者跑满 28 天（数十次调用），后者只跑一条事件。
const liveSim = flag('--live-sim');
const replayDir = valueOf('--replay');
const rebaselineDir = valueOf('--rebaseline');
const seedArg = argv.indexOf('--seed');
const seeds = seedArg >= 0 ? [Number(argv[seedArg + 1])] : [1, 7, 42];
const oneSeed = seedArg >= 0 ? Number(argv[seedArg + 1]) : 1;

type Mode = 'sim' | 'dry' | 'live' | 'live-sim' | 'replay' | 'rebaseline';
const mode: Mode = rebaselineDir
  ? 'rebaseline'
  : replayDir
    ? 'replay'
    : liveSim
      ? 'live-sim'
      : live
        ? 'live'
        : dry
          ? 'dry'
          : 'sim';

// ── 表头工具（`runSim` 用；模块级常量，分派前必须已执行）──────────────
const WIDTHS = [4, 4, 6, 6, 4, 5, 4, 6, 6, 6, 6, 6, 6, 5];
const HEADS = ['day', '章', '金币', '欲念', 'HP', 'SAN', 'X', '排布', '弹窗', '拨时', '待揭', '待办', '藏起', '池'];
const RULE = '─'.repeat(WIDTHS.reduce((a, b) => a + b, 0) - 5);

function pad(s: string | number, w: number): string {
  const str = String(s);
  const width = [...str].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return str + ' '.repeat(Math.max(0, w - width));
}

function head(): string {
  return HEADS.map((h, i) => pad(h, WIDTHS[i])).join('');
}

function row(s: DaySnapshot): string {
  const vals: Array<string | number> = [
    s.day,
    s.chapter,
    s.gold,
    s.desire,
    s.hp,
    s.san,
    s.x,
    s.arrangedToday,
    s.popupsToday,
    s.dialedToday,
    s.awaiting,
    s.todo,
    s.hidden,
    s.live,
  ];
  return vals.map((v, i) => pad(v, WIDTHS[i])).join('');
}

// ── ① 28 天无头驱动（默认路径）───────────────────────────────────────

async function runSim(brain?: Brain, seedList: number[] = seeds): Promise<void> {
  console.log('\n══════════ 28 天无头驱动 ══════════');
  if (brain) {
    console.log('⚠️ 这一次接的是**真模型**（`llmBrain`）—— 会真的发请求、真的花钱；快照落在 game/runs/');
  }

  let totalViolations = 0;

  for (const seed of seedList) {
    const r = await simulate(seed, TOTAL_DAYS, {}, brain);
    totalViolations += r.violations.length;

    console.log(`\n▸ seed = ${seed}`);
    if (seedList.length === 1) {
      console.log(head());
      console.log(RULE);
      for (const s of r.snapshots) console.log(row(s));
    } else {
      // 多种子只印首/中/末三天，避免刷屏
      console.log(head());
      console.log(RULE);
      const marks = [0, Math.floor(r.snapshots.length / 2), r.snapshots.length - 1];
      for (const i of marks) console.log(row(r.snapshots[i]));
    }

    const st = r.stats;
    console.log(
      `  汇总：排布 ${st.arranged} 次 · 弹窗 ${st.popups} 个 · 新生成 ${st.created} 个 · ` +
        `揭晓 ${st.revealed} 个 · 过期 ${st.expired} 个 · 恢复 ${st.restored} 人次 · 章节占卜 ${st.divinations} 次 · ` +
        `概要归并 ${st.archives} 次 · 结局话术 ${st.endings} 次 · ` +
        `拨时针 ${st.dials} 次/${st.dialedPoints} 点 · ` +
        `事件池 ${r.ledger.events.live.length} 条（其中待揭晓 ${r.ledger.pending.length} 条）`,
    );
    console.log(
      `  收口：金币 ${r.ledger.scalars.gold} · 欲念 ${r.ledger.desire.value}` +
        ` · 已建档人物 ${r.ledger.entities.people.length} 人 / 物品 ${r.ledger.entities.items.length} 件 / 地点 ${r.ledger.entities.places.length} 处`,
    );

    // ── **结局**（Phase 4 的出口）──────────────────────────────
    // ⚠️ 提前终结（总表 1~4）必须一眼看得见：这类局一变多，就是欲念 / HP·SAN 的节奏出了问题。
    const en = r.ledger.ending;
    if (en === null) {
      console.log('  结局：⚠️（无）—— 走完 28 天却没有结局，出口没接上');
    } else {
      const p = en.placements;
      console.log(
        `  结局：${en.kind}·${en.name}${en.flavor !== null ? `（风味 ${en.flavor}）` : ''}` +
          // ⚠️ 不另印「第 N 天」：⑤⑥⑦ 的 `reason` 本来就写着「第 28 天 · …」（原文如此）。
          ` · 总表第 ${en.row} 行 · ${en.reason}` +
          ` · 放格子 成果=${p.成果 ?? '空'}／手段=${p.手段 ?? '空'}／共鸣=${p.共鸣 ?? '空'}` +
          `${en.day < 28 ? `　⚠️ 提前终结于第 ${en.day} 天（总表 1~4）` : ''}`,
      );
    }

    console.log('  覆盖率：');
    for (const c of r.coverage) console.log(`     ${c.ok ? '✓' : '✗'} ${c.name} —— ${c.detail}`);

    if (r.violations.length === 0) {
      console.log('  ✅ 不变式 0 违规 · 覆盖率全部达标');
    } else {
      console.log(`  ❌ ${r.violations.length} 条违规（不变式 + 覆盖率）：`);
      for (const v of r.violations.slice(0, 10)) console.log('     · ' + v);
      if (r.violations.length > 10) console.log(`     …（其余 ${r.violations.length - 10} 条略）`);
    }
  }

  console.log('\n══════════════════════════════════');
  if (totalViolations === 0 && !process.exitCode) {
    console.log('✅ 通过：单测全绿 + 28 天无违规（全程离线）');
  } else {
    console.log(`❌ 未通过（单测失败码 ${process.exitCode ?? 0} · 不变式违规 ${totalViolations} 条）`);
    process.exitCode = 1;
  }
}

// ── ② `--dry`：只组装请求体并打印 ────────────────────────────────────

interface Requestish {
  callPoint: string;
  prompt: { system: string; user: string; instruction: string };
  body: Record<string, unknown>;
}

function showBody(title: string, req: Requestish): void {
  console.log(`\n────────── ${title} ──────────`);
  console.log(
    `调用点 ${req.callPoint}　｜　指令「${req.prompt.instruction}」　｜　system ${req.prompt.system.length} 字　｜　user ${req.prompt.user.length} 字　｜　请求体 ${JSON.stringify(req.body).length} 字节`,
  );
  console.log(`\n〔段 ① 静态头 hash〕${hash(renderStaticHead(sliceLedger()))}（它一变，两个主链的缓存同时作废）`);
  console.log('\n〔user ③ 每日易变区〕');
  console.log(req.prompt.user);
  console.log(
    '\n〔messages 的角色序列〕' + (req.body.messages as Array<{ role: string }>).map((m) => m.role).join(' → '),
  );
  console.log('\n〔tools〕');
  console.log(JSON.stringify(req.body.tools, null, 2));
  console.log('\n〔完整请求体〕');
  console.log(JSON.stringify(req.body, null, 2));
}

function runDry(): void {
  let cfg: LlmConfig;
  let cfgNote = '';
  try {
    cfg = loadConfig();
  } catch {
    // 干跑**不该**要求密钥 —— 它只组装、不发送
    cfg = { apiKey: '（干跑占位，不发送）', betaBaseUrl: 'https://api.deepseek.com/beta', model: 'deepseek-flash' };
    cfgNote = '（没读到 game/.env ⇒ 用占位配置；本次不发网络，不影响结果）';
  }

  const l = sliceLedger();
  const ev = l.events.live[0];
  const h: HandlingRecord = {
    participants: [...DEFAULT_HANDLING.participants],
    usedItemId: null,
    goldInput: DEFAULT_HANDLING.goldInput,
    note: DEFAULT_HANDLING.note,
  };

  console.log('\n══════════ --dry · 只组装请求体 ══════════');
  console.log(`模型 ${cfg.model} · base ${cfg.betaBaseUrl} ${cfgNote}`);
  console.log('⚠️ 本模式**一字符不发网络**：下面两次调用都只到 JSON 为止。');

  showBody('第一段 · 裁定半', buildCheckRequest(cfg, l, ev, h));

  // 第二次：结算半（干跑时裁定半是编的，只为把「tool 成对回填」的消息序列摆出来）
  const settle = buildSettleRequest(
    cfg,
    l,
    ev,
    h,
    { tier: '困难成功', bonuses: ['旧铜牌 +1'], landed: ['文书(npc002) 本日行动力 −2'] },
    {
      stage: 'two',
      toolCallId: 'call_dry',
      checkArgs: { intent_summary: '（干跑占位）', check: { verdict: '投骰' } },
    },
  );
  showBody('第二段 · 结算半（裁定半为干跑占位）', settle);

  // 第三次：**忽略形态**（事件过期、没人处理）—— 它**不是两段式**，消息序列只有 `system → user`
  const ignore = buildIgnoreRequest(cfg, l, ev);
  showBody('第三段 · 忽略形态（过期事件的一次了结）', ignore);

  // 第四次：**生成半**（T0 换日）—— 全场**输出量最大**的调用（`max_tokens` 8192），
  // 也正是最该"先看请求、再花钱"的那一个：一次换日就是一次 8k 上限的输出。
  // ⚠️ 它挂的是 `compose_day` 那个 function（不是 `resolve`）—— `tool_choice` 指的名字必须在 `tools` 里。
  const compose = buildComposeRequest(cfg, l);
  showBody('第四段 · 生成半（compose_day）', compose);

  // 第四段之二：**玩家自建**（`create_event` · P5-C）—— 它与「生成半」**共用同一个 function**
  // （`compose_day`），差的是**指令**与 **user ③**。干跑是"先看请求、再花钱"的唯一仪器
  // ⇒ 最新的调用点不进来看一眼，就等于闭着眼睛花钱。
  const createWord = '我想去城郊替我母亲立一块碑';
  const create = buildCreateRequest(cfg, l, createWord);
  showBody('第四段之二 · 玩家自建（create_event · compose_day 单条版）', create);

  // 第五次：**章节占卜**（`chapter_shift` 侧链 · 每章一次）—— P4-C 第二条落地的侧链。
  // ⚠️ 它的 system 是**三段式**（① 静态头 ＋ ② 占卜指令 ＋ ③【玩家欲望】），且**段 ② 每章都变**
  //    （两张牌填在指令正文里）⇒ 与主链的「逐字稳定」只共享**段 ①**。
  //    这一段值不值钱，看的就是段 ① 有多长。
  // ⚠️ 牌由**调用侧**抽（`drawDivinationCards`）—— 请求组装不许自己抽牌，否则
  //    「喂给模型的牌」与「判命中原卡的牌」会变成两副（`applyChapterShift` 顶栏那个坑）。
  const divCards = drawDivinationCards(makeRng(oneSeed));
  const div = buildChapterShiftRequest(cfg, l, divCards);
  showBody('第五段 · 章节占卜（chapter_shift 侧链）', div);

  // 第六次：**概要归并**（`archive` 侧链 · 全局约 2~3 次）—— P4-C 第三条落地的侧链。
  // ⚠️ 它是**四条侧链里唯一不带欲望命题的一条** ⇒ system 只有 [静态头] ＋ [归并指令] 两段 ——
  //    这一段恰好可以核对"例外"没有偷偷多拼一段（下面 `archTwo` 那条自检）。
  // ⚠️ 标准 28 天里它**一次都不会触发**（用户 2026-09-22「放宽标准」）⇒ 干跑必须**自己造一份
  //    超限的逐条区**，否则这一段根本没有请求体可看（`planArchive` 照样是**真算**的）。
  const archL = structuredClone(l);
  archL.clock.day = 8; // 章首（`isChapterStart(8) === true`）
  archL.summaries.recent = [1, 2, 3, 4].map((d) => ({
    day: d,
    text: `第 ${d} 天的一段占位概要，用于把逐条区撑过软顶。`.repeat(30),
  }));
  const archPlan = planArchive(archL.clock.day, archL.summaries.recent, archL.summaries.archive);
  const arch = buildArchiveRequest(cfg, archL, archPlan);
  showBody(
    `第六段 · 概要归并（archive 侧链）${archPlan.trigger ? `— 触发：${archPlan.reason}` : '⚠️ 未触发（干跑夹具坏了）'}`,
    arch,
  );

  // 第七次：**终局叙事**（`ending` 侧链 · 成功结局才调 · 全局至多 1 次）—— P4-C 第四条侧链。
  // ⚠️ 它**只在成功结局**上存在（失败 = 系统播预写话术、0 调用）⇒ 干跑必须**自己造一局成功**：
  //    把时钟搬到第 28 天 ＋ 把欲念塞进判定窗口 [75,80]，再走**真的** `closeGame` ＋ `autoPlace`
  //    （不是硬写一个 `ending` 对象 —— 那样这一段就只是"渲染器"，测不到判定那一步）。
  const endL = structuredClone(l);
  endL.clock = { day: TOTAL_DAYS, phase: '终局', chapter: 4, usedToday: 0 };
  endL.desire.value = 77; // 判定窗口 [75, 80] 的中点
  endL.ending = null;
  const endPl = autoPlace(endL);
  // 干跑这一局手上不一定留着物品 ⇒ 补一件（**只补这一段的夹具**；判定本身照走，改的是输入不是判据）
  if (endPl.成果 === null) endPl.成果 = endL.entities.items[0]?.id ?? 'it001';
  const endClosed = closeGame(endL, endPl);
  const endReq = buildEndingRequest(cfg, endClosed);
  showBody(
    `第七段 · 终局叙事（ending 侧链 · ${endClosed.ending?.kind ?? '（未判定）'}·${endClosed.ending?.name ?? '（无）'} · 风味 ${endClosed.ending?.flavor ?? '（无）'}）`,
    endReq,
  );

  // ── ★ 前缀缓存核对：两个调用点的 `system` 必须**逐字相同** ──
  //    这是「过期结算不额外烧钱」的全部依据：静态头 ＋ 结算指令都落在缓存命中区，
  //    差异只在 user 段（它本来就不构成缓存前缀）。这条一旦红，说明有人动了静态头或指令文案。
  const sysSame = settle.prompt.system === ignore.prompt.system;
  const sysBytes = Buffer.byteLength(settle.prompt.system, 'utf8');
  const rolesOf = (r: Requestish): string =>
    (r.body.messages as Array<{ role: string }>).map((m) => m.role).join(' → ');
  const ignoreHasAbility = ignore.prompt.user.includes('【处理者能力】');

  console.log('\n────────── 前缀缓存核对 ──────────');
  console.log(
    `结算半 system ≡ 忽略形态 system：${sysSame ? '✅ 逐字相同' : '❌ 不同'}（各 ${sysBytes} 字节 · hash ${hash(settle.prompt.system)}）`,
  );
  console.log(`消息角色序列：结算半「${rolesOf(settle)}」　｜　忽略形态「${rolesOf(ignore)}」`);
  console.log(`忽略形态 user 含【处理者能力】：${ignoreHasAbility ? '❌ 有（应无 —— 这件事没有处理者）' : '✅ 无'}`);
  console.log(`忽略形态【玩家的处理】用的是忽略原话：${ignore.prompt.user.includes(IGNORE_NOTE) ? '✅' : '❌'}`);
  console.log(`结算半 user 仍带【处理者能力】：${settle.prompt.user.includes('【处理者能力】') ? '✅' : '❌'}`);

  const divFilled = !div.prompt.system.includes('{第一张}') && !div.prompt.system.includes('{第二张}');
  console.log(
    `章节占卜 system 仍以静态头开头：${div.prompt.system.startsWith(renderStaticHead(l)) ? '✅' : '❌'}　｜　` +
      `两张牌的占位符已填：${divFilled ? '✅' : '❌ 还有漏填的'}`,
  );


  const archTwo = !arch.prompt.system.includes('【玩家欲望】') && !arch.prompt.system.includes('【当前命题】');
  const archUser = arch.prompt.user.includes('【要归并的几天】') && arch.prompt.user.includes('【已有的归档段】');
  console.log(
    `概要归并 system 只有两段（**不带欲望命题** —— 四条侧链里唯一的例外）：${archTwo ? '✅' : '❌ 多拼了一段'}　｜　` +
      `user ③ 两块到位：${archUser ? '✅' : '❌'}`,
  );

  // 终局那一段的四条核对：命题压 system 最末 · **风味是独立的一段**（四段互斥、只挂中选那一段）
  // · user ③ 三块到位 · user 段没有重复的命题块。
  const endSys = endReq.prompt.system;
  const endFlavor = endClosed.ending?.flavor ?? '（无）';
  const endThree = endSys.endsWith('【玩家的欲望命题】' + (endClosed.desire.proposition || '（未定）'));
  const endFlavorOn = endSys.includes(ENDING_FLAVOR_NOTES[endFlavor as 'A'] ?? '\u0000');
  const endFlavorOne = endSys.split('## 这一局的风味：').length === 2; // 风味段**恰好挂一段**
  const endFlavorOk = !endSys.includes('<系统按格子填法给定，四选一>') && endFlavorOn && endFlavorOne;
  const endBlocks = ['【玩家的 28 天】', '【最后一天放的格子】', '【他这一局的样子】'].every((b) =>
    endReq.prompt.user.includes(b),
  );
  const endNoDup = !endReq.prompt.user.includes('【玩家的欲望命题】');
  console.log(
    `终局叙事 system 以【玩家的欲望命题】收尾（会变的那段压最末）：${endThree ? '✅' : '❌'}　｜　` +
      `风味段只挂中选那一段（四段互斥）：${endFlavorOk ? '✅' : `❌ ${endFlavor} / 段数 ${endSys.split('## 这一局的风味：').length - 1}`}　｜　` +
      `user ③ 三块到位：${endBlocks ? '✅' : '❌'}　｜　` +
      `user 段没有重复的命题块：${endNoDup ? '✅' : '❌ 同一句命题在两处'}`,
  );

  // 玩家自建那一段的三条核对：① 指令必须与「生成半」**不同**（同一个 function、两份指令）；
  // ② 玩家原话必须**逐字**出现在 user ③ 里（改一个字都算篡改玩家输入 —— P5-C 的落地口径）；
  // ③ `tool_choice` 指的仍得是 `compose_day`（function 名没变）。
  const createInstrDiff = create.prompt.instruction !== compose.prompt.instruction;
  const createKeepsWords = create.prompt.user.includes(createWord);
  const createSameFn = JSON.stringify(create.body.tool_choice).includes('compose_day');
  console.log(
    `玩家自建：指令与生成半不同 ${createInstrDiff ? '✅' : '❌'}　｜　` +
      `原话逐字进 user ③：${createKeepsWords ? '✅' : '❌'}　｜　` +
      `仍挂同一个 function（compose_day）：${createSameFn ? '✅' : '❌'}`,
  );

  const dryOk =
    sysSame &&
    createInstrDiff &&
    createKeepsWords &&
    createSameFn &&
    !ignoreHasAbility &&
    ignore.prompt.user.includes(IGNORE_NOTE) &&
    divFilled &&
    archTwo &&
    archUser &&
    endThree &&
    endFlavorOk &&
    endBlocks &&
    endNoDup;  if (!dryOk) process.exitCode = 1;

  console.log('\n══════════════════════════════════');
  console.log(`✅ --dry 完成：八份请求体已组装（**未发送任何请求**）${dryOk ? '' : '　⚠️ 上面核对有 ✗'}`);
  console.log('   ⇒ 要真跑一条：node game/src/main.ts --live');
}

// ── ③ `--live` / `--replay`：竖切 ────────────────────────────────────

function diffReading(a: Reading, b: Reading): string[] {
  const out: string[] = [];
  if (a.gold !== b.gold) out.push(`金币 ${a.gold} → ${b.gold}`);
  if (a.desire !== b.desire) out.push(`欲念 ${a.desire} → ${b.desire}`);
  for (const k of Object.keys(a.rep)) {
    if (a.rep[k] !== b.rep[k]) out.push(`声望·${k} ${a.rep[k]} → ${b.rep[k]}`);
  }
  for (const bp of b.people) {
    const ap = a.people.find((p) => p.id === bp.id);
    if (!ap) {
      out.push(`新增人物 ${bp.id} ${bp.name}`);
      continue;
    }
    if (ap.hp !== bp.hp) out.push(`${bp.name} HP ${ap.hp} → ${bp.hp}`);
    if (ap.san !== bp.san) out.push(`${bp.name} SAN ${ap.san} → ${bp.san}`);
    for (const k of Object.keys(bp.attrs)) {
      if (ap.attrs[k] !== bp.attrs[k]) out.push(`${bp.name} ${k} ${ap.attrs[k]} → ${bp.attrs[k]}`);
    }
  }
  for (const bi of b.items) {
    const ai = a.items.find((i) => i.id === bi.id);
    if (!ai) {
      out.push(`新增物品 ${bi.id} ${bi.name}`);
      continue;
    }
    if (ai.holder !== bi.holder) out.push(`${bi.name} 携带 ${ai.holder ?? '未携带'} → ${bi.holder ?? '未携带'}`);
    if (ai.consumed !== bi.consumed) out.push(`${bi.name} 消耗 ${ai.consumed} → ${bi.consumed}`);
  }
  if (a.seedCount !== b.seedCount) out.push(`种子 ${a.seedCount} → ${b.seedCount}`);
  if (a.summaryCount !== b.summaryCount) out.push(`概要 ${a.summaryCount} → ${b.summaryCount}`);
  if (a.pendingCount !== b.pendingCount) out.push(`待揭晓 ${a.pendingCount} → ${b.pendingCount}`);
  return out;
}

function printReport(r: SliceReport): void {
  console.log(
    `\n事件卡：${r.card.title}　（地点 ${r.card.location} · 档 ${r.card.tier} · 时长 ${r.card.cost} · 最低投入 ${r.card.min_gold}）`,
  );
  console.log(`  ${r.card.content}`);

  if (!r.ok) {
    console.log(`\n✗ 链路中断：${r.stopped}`);
    return;
  }

  console.log(`\n① 裁定　${r.intentSummary}`);
  console.log(
    `   verdict=${r.check?.verdict} · participants=${r.check?.participants.join('/') || '（空）'} · difficulty=${r.check?.difficulty}`,
  );
  console.log(`② 判定　${r.rollLine}`);
  console.log(`   加成：${r.bonuses.join('、') || '无'}`);

  console.log('\n③ 结算 · 叙事（模型原文）');
  console.log(`   ${r.narration}`);

  console.log('\n③′ 结算 · delta');
  console.log(`   模型原文：${JSON.stringify(r.deltaRaw)}`);
  console.log('   经六项校验之后：');
  if (r.deltaOps.length === 0) console.log('     （空 —— 本次没有任何变化）');
  for (const op of r.deltaOps) console.log('     · ' + JSON.stringify(op));
  for (const f of r.fixes) console.log(`     ~ 钳制 ${f.path}：${f.detail}`);
  for (const d of r.drops) console.log(`     ✗ 拦下 ${d.path}：${d.reason}`);
  if (r.fixes.length === 0 && r.drops.length === 0) console.log('     （无钳制、无拦下）');
  console.log(`   混键拆解：${r.mixedCount} 处`);
  console.log(`   summary：${r.summary || '（空）'}`);
  console.log(`   next_seeds：${r.nextSeeds.join('；') || '无'}`);
  console.log(`   欲向：${r.欲向}`);

  console.log('\n④ 落账');
  for (const line of r.ledgerLog) console.log('   ' + line);

  console.log(`\n⑤ 揭晓　${r.revealed.join('、') || '（未揭晓）'}`);
  const changes = diffReading(r.before, r.after);
  console.log('   落账前后：');
  if (changes.length === 0) console.log('     （无变化）');
  for (const c of changes) console.log('     · ' + c);

  console.log(`\ndigest ${r.digest}`);
}

function printTraces(traces: CallTrace[]): void {
  console.log('\n调用观测：');
  if (traces.length === 0) console.log('  （一次都没有 —— 一段式不会发第二次网络）');
  for (const t of traces) {
    console.log(`  · ${t.stage}第 ${t.attempt} 次 —— ${summarizeResult(t.result)}`);
  }
}

async function runLive(): Promise<void> {
  console.log('\n══════════ --live · 一条事件走完全程 ══════════');

  let cfg: LlmConfig;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`模型 ${cfg.model} · base ${cfg.betaBaseUrl} · 种子 ${oneSeed}`);

  const snap = new SnapshotWriter('slice');
  const traces: CallTrace[] = [];
  const brain = llmBrain({
    cfg,
    snapshot: snap,
    onCall: (t) => {
      traces.push(t);
      console.log(`  ⟳ ${t.stage}第 ${t.attempt} 次 · ${summarizeResult(t.result)}`);
    },
  });

  const report = await runSlice(oneSeed, brain);
  printReport(report);
  printTraces(traces);

  fs.writeFileSync(
    path.join(snap.dir, 'RESULT.json'),
    JSON.stringify(
      { seed: oneSeed, ok: report.ok, stopped: report.stopped, tier: report.tier, bonuses: report.bonuses, digest: report.digest },
      null,
      2,
    ),
    'utf8',
  );
  fs.writeFileSync(path.join(snap.dir, 'PAYLOAD.json'), report.payload, 'utf8');

  console.log(`\n快照 / 结果：${snap.dir}`);
  console.log('\n══════════════════════════════════');
  console.log(report.ok ? '✅ --live 完成：快照已落盘，可用 --replay 复现' : '⚠️ 链路中断（上面已写明原因）');
  if (!report.ok) process.exitCode = 1;
}

function firstDiff(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return `第 ${i} 个字符起不同：\n     期望 …${a.slice(Math.max(0, i - 40), i + 60)}…\n     实得 …${b.slice(Math.max(0, i - 40), i + 60)}…`;
    }
  }
  return `前 ${n} 个字符相同，长度不同：期望 ${a.length}，实得 ${b.length}`;
}

async function runReplay(dir: string): Promise<void> {
  console.log('\n══════════ --replay · 用快照重跑 ══════════');
  console.log(`快照目录 ${dir}`);

  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'RESULT.json'), 'utf8')) as { seed: number; digest: string };
  const expected = fs.readFileSync(path.join(dir, 'PAYLOAD.json'), 'utf8');
  console.log(`原次种子 ${meta.seed} · digest ${meta.digest} —— 本次**不发任何网络**`);

  const brain = replayBrain(dir);
  const report = await runSlice(meta.seed, brain);
  printReport(report);

  console.log(`\n证据消费：${brain.consumed.join(' → ') || '（无）'}`);
  if (brain.remaining() > 0) {
    console.log(`⚠️ 还剩 ${brain.remaining()} 条快照没被消费 —— 实跑与回放的调用次数对不上`);
  }

  console.log('\n══════════════════════════════════');
  if (report.payload === expected) {
    console.log(`✅ --replay 通过：落账载荷**逐字相同**（${expected.length} 字节，digest ${report.digest}）`);
  } else {
    console.log('❌ --replay 不一致：');
    console.log('   ' + firstDiff(expected, report.payload));
    process.exitCode = 1;
  }
}

/**
 * ⚠️ **重推"答案纸"** —— 只有"有意改过夹具 / 开局数据"之后才该用。
 *
 * `--live` 会把跑完的**整份账本**存成 `PAYLOAD.json` 当"标准答案"（`turn/slice.ts` 的 `payload`
 * 里含 `ledger: adv.ledger`）⇒ 任何动到夹具文字或开局数据的改动都会让这份答案纸**过期**，
 * 于是 `--replay` 永远红 —— 那样这个闸门就废了（分不出"又过期"还是"真坏了"）。
 *
 * 本模式用**同一批模型响应快照**重算答案纸并写回。**响应证据（`*.request.json` / `*.response.json`）
 * 一个字节都不碰** —— 那不是"重录"，只是把标准答案重新算对。
 *
 * 三条纪律：
 *   ① 它把"当前行为"直接接受为基线 ⇒ 只在确认差异来自**有意改动**时才用；
 *   ② `ok === false`（链路没跑完）时**拒绝写**，免得把一条坏运行固化成基线；
 *   ③ 写前把旧 / 新 digest 与**首处不同**都打出来，便于复核。
 */
async function runRebaseline(dir: string): Promise<void> {
  console.log('\n══════════ --rebaseline · 重推答案纸 ══════════');
  console.log(`快照目录 ${dir}`);
  console.log('⚠️ 本模式会把**当前重放结果**写进 PAYLOAD.json —— 只在差异来自有意改动时用。');

  const metaPath = path.join(dir, 'RESULT.json');
  const payloadPath = path.join(dir, 'PAYLOAD.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { seed: number; digest: string };
  const old = fs.readFileSync(payloadPath, 'utf8');

  const brain = replayBrain(dir);
  const report = await runSlice(meta.seed, brain);

  console.log(`原次种子 ${meta.seed} · 旧 digest ${meta.digest}（${old.length} 字节）`);
  console.log(`本次重建 digest ${report.digest}（${report.payload.length} 字节）`);
  console.log(`证据消费：${brain.consumed.join(' → ') || '（无）'}`);
  if (brain.remaining() > 0) console.log(`⚠️ 还剩 ${brain.remaining()} 条快照没被消费 —— 实跑与回放的调用次数对不上`);

  if (!report.ok) {
    console.log('\n❌ 本次重放**没跑完**（ok=false）⇒ 拒绝写答案纸。');
    console.log(`   原因：${report.stopped}`);
    process.exitCode = 1;
    return;
  }
  if (report.payload === old) {
    console.log('\n✅ 答案纸本来就是最新的 —— 无需重推。');
    return;
  }

  let at = Math.min(old.length, report.payload.length);
  for (let i = 0; i < at; i++) {
    if (old[i] !== report.payload[i]) {
      at = i;
      break;
    }
  }

  fs.writeFileSync(payloadPath, report.payload, 'utf8');
  fs.writeFileSync(metaPath, JSON.stringify({ ...meta, digest: report.digest }, null, 2), 'utf8');

  console.log(`\n⚠️ 答案纸已改写（首处不同在第 ${at} 个字符）：`);
  console.log('   ' + firstDiff(old, report.payload));
  console.log(`\n✅ 已写回 ${payloadPath}`);
  console.log(`✅ 已同步 ${metaPath} 的 digest：${meta.digest} → ${report.digest}`);
  console.log('   （响应证据未动；下次 `--replay` 应为逐字相同）');
}

// ── ④ `--live-sim`：**真模型跑满 28 天**（P6-A 标定 / Phase 6 联调用的仪器）────────
//
// 为什么要单独一个模式：`--live` 只跑**一条事件**（`runSlice`），而 P6-A 要看的是
// **整局 28 天的欲念曲线**；`simulate()` 过去**硬写 `fakeBrain()`** ⇒ 真模型根本接不进来。
//
// ⚠️ **它真的花钱**：一局 ≈ 序幕 1 次 ＋ 每天 ~1.5 次（裁定/结算/生成）＋ 侧链（占卜 4 次、
//    重写 1 次、成功结局 1 次），量级**数十次调用**。⇒ 刻意只认**单种子**，
//    不许一次刷三个（那是一次三倍的钱）。
// ⚠️ 每次调用的请求/响应快照都落 `game/runs/<时间戳>-fullsim-<种子>/` —— 那正是 Phase 6
//    修 `--replay` 要的原始证据（`game/runs/` 现为空，见 MEMORY「不可忘的第二条」）。
// ⚠️ 欲念曲线怎么看：下面那张表有**每天的 `欲念` 列**；`收口` 行给出终局值 ——
//    它落在 [75,80] 才是「自然对局可达窗口」的第一个证据。
async function runLiveSim(): Promise<void> {
  console.log('\n══════════ --live-sim · 真模型跑满 28 天 ══════════');

  let cfg: LlmConfig;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }

  const snap = new SnapshotWriter('fullsim');
  const traces: CallTrace[] = [];
  const brain = llmBrain({
    cfg,
    snapshot: snap,
    onCall: (t) => {
      traces.push(t);
      console.log(`  ⟳ ${t.stage}第 ${t.attempt} 次 · ${summarizeResult(t.result)}`);
    },
  });

  console.log(`模型 ${cfg.model} · base ${cfg.betaBaseUrl} · 种子 ${oneSeed}`);
  console.log(`⚠️ 这一局会真的发请求、真的花钱；每次调用的请求/响应快照落 ${snap.dir}`);
  console.log('   （只想跑一条事件：`--live`；想不要钱地跑 28 天：不带参数）');

  await runSim(brain, [oneSeed]);

  fs.writeFileSync(
    path.join(snap.dir, 'CALLS.json'),
    JSON.stringify({ seed: oneSeed, calls: traces.length, traces }, null, 2),
    'utf8',
  );
  console.log(`\n调用观测：共 ${traces.length} 次 —— 明细已落 ${path.join(snap.dir, 'CALLS.json')}`);
}

// ── 分派（**放文件末尾**：上面所有模块级常量都已就位）────────────────────
const all: Suite[] = [
  ...archiveSuites,
  ...chapterShiftSuites,
  ...checkpointSuites,
  ...contractSuites,
  ...createSuites,
  ...enlistSuites,
  ...endingLlmSuites,
  ...endingSuites,
  ...initialSuites,
  ...rulesSuites,
  ...saveSuites,
  ...ledgerSuites,
  ...openingSuites,
  ...promptSuites,
  ...prologueSuites,
  ...requiredPersonSuites,
  ...sceneSuites,
  ...serverSuites,
  ...uiSuites,
];
await runAll(all);

if (onlyTests) {
  console.log('\n（--tests：跳过其余所有阶段）');
} else if (mode === 'dry') {
  runDry();
} else if (mode === 'live') {
  await runLive();
} else if (mode === 'live-sim') {
  await runLiveSim();
} else if (mode === 'replay') {
  await runReplay(replayDir!);
} else if (mode === 'rebaseline') {
  await runRebaseline(rebaselineDir!);
} else {
  await runSim();
}
