// prompt 层与 schema 层 —— Phase 2 新增的地基，必须**离线可断言**的那些判据
//
// 这一组测的不是"LLM 会不会好好回话"（那要靠 `--live` + 快照），而是**我们发出去的东西**：
//   · `$def` 组装：引用完整、只挂被引用到的、位置在末尾（缓存友好）
//   · 静态头：段 ① 的 hash **锁死**（差一个字符就废掉两个主链的缓存）
//   · 装配：system 只放 ①＋②、user 末行为行动提示、两半的块差量正好是【判定结果】【系统已落账】
//   · 三条硬护栏：`thinking` 必须显式关闭、不传采样参数、两段式只回传 `{档位, 加成}`
import { initialLedger } from '../ledger/initial.ts';
import { STATIC_HEAD_PROSE, STATIC_HEAD_PROSE_HASH, hash, renderEntitySkeleton, renderStaticHead, staticProseOf } from '../frozen/static-head.ts';
import {
  assembleCompose,
  assembleCreate,
  assembleIgnore,
  assembleNarrate,
  assembleResolve,
  assembleWrap,
} from '../prompt/assemble.ts';
import {
  assertNoSpoiler,
  renderComposeUser,
  renderCreateUser,
  renderNarrateUser,
  renderResolveUser,
  renderWrapUser,
  sceneLandedBlock,
  sceneNowBlock,
  sceneTrailBlock,
  type HandlingRecord,
} from '../prompt/blocks.ts';
import { SCENE_END_REASONS, SCENE_ROUND_CAP } from '../rules/scene.ts';
import {
  INSTRUCTION_ARCHIVE,
  INSTRUCTION_ENDING,
  INSTRUCTION_CHECK,
  INSTRUCTION_COMPOSE,
  INSTRUCTION_CREATE,
  INSTRUCTION_DIVINATION,
  INSTRUCTION_NARRATE,
  INSTRUCTION_SETTLE,
  INSTRUCTION_WRAP,
  INSTRUCTIONS,
  narrateInstruction,
} from '../prompt/instructions.ts';
import { buildCheckRequest, buildSettleRequest, normalizeCheck, type TwoStageContinuation } from '../llm/brain-llm.ts';
import { VERDICTS } from '../contract/types.ts';
import { buildChatBody, assistantToolCall, toolMessage, systemMessage, userMessage } from '../llm/request.ts';
import type { LlmConfig } from '../llm/config.ts';
import { COMPOSE_DESCRIPTION, FREE_EVENT_CAP, composeParameters, composeTool } from '../schema/compose.ts';
import { PERSON } from '../schema/defs.ts';
import { checkRefs, resolveParameters, resolveTool } from '../schema/resolve.ts';
import { handlingBlock } from '../prompt/blocks.ts';
import { EVENT_CARD, makeEventCard } from '../fixtures/event-card.ts';
import { calcL } from '../rules/x.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { Suite } from './harness.ts';

const CFG: LlmConfig = { apiKey: 'sk-test', betaBaseUrl: 'https://example.invalid/beta', model: 'deepseek-flash' };

const HANDLING: HandlingRecord = {
  participants: ['npc002'],
  usedItemId: null,
  goldInput: 2,
  note: '先核单子上的半个印。',
};

function fixture() {
  const l = initialLedger();
  l.clock = { day: 1, phase: '正文', chapter: 1, usedToday: 0 };
  l.scalars.gold = 8;
  const ev = makeEventCard();
  l.events.live.push(ev);
  return { l, ev };
}

/** 按出现位置取块标题的下标（不存在返回 -1）——用来断言**顺序**，不只是"有没有" */
function at(text: string, needle: string): number {
  return text.indexOf(needle);
}

export const suites: Suite[] = [
  {
    name: 'schema 组装 · 《装配规范.md》§1.1 / §1.2',
    register(t) {
      t.test('★ 引用完整：`$ref` 指向的名字必须都在 `$def` 里（Node 不做类型检查，这条是唯一防线）', () => {
        t.deep(checkRefs(resolveParameters()), []);
      });

      t.test('★ 只挂被引用到的 `$def` —— 恰好这 6 条，不多不少', () => {
        t.deep(
          Object.keys(resolveParameters().$def as object),
          ['Check', 'Delta', 'Vouchers', 'Place', 'Person', 'Item'],
        );
      });

      t.test('★ `$def` 放在 `parameters` 末尾（JSON 字节前缀匹配 ⇒ 改 `$def` 不动前面字段的字节）', () => {
        const keys = Object.keys(resolveParameters());
        t.eq(keys[keys.length - 1], '$def');
        t.deep(keys, ['type', 'properties', 'required', 'additionalProperties', '$def']);
      });

      t.test('`required` 与 `properties` 一一对应（strict 模式要求全 required）', () => {
        const p = resolveParameters();
        t.deep(p.required, Object.keys(p.properties as object));
        t.eq((p.required as string[]).length, 9);
      });

      t.test('`resolve` 的 function 形状：`type=function` · `name=resolve` · `strict=true`', () => {
        const tool = resolveTool() as { type: string; function: Record<string, unknown> };
        t.eq(tool.type, 'function');
        t.eq(tool.function.name, 'resolve');
        t.eq(tool.function.strict, true);
        t.deep(Object.keys(tool.function), ['name', 'strict', 'description', 'parameters']);
      });

      t.test('`Delta.ops` 的 5 个分支：混键不保证互斥 ⇒ 规则层必须无条件拆键（Phase 0 B-b）', () => {
        const defs = resolveParameters().$def as Record<string, { properties: { ops: { items: { anyOf: unknown[] } } } }>;
        t.eq(defs.Delta.properties.ops.items.anyOf.length, 5);
      });
    },
  },
  {
    name: 'schema · `compose_day`（Phase 3 · T0 生成半）',
    register(t) {
      t.test('★ 只挂被引用到的 `$def` —— 两个私有零件 ＋ Delta 的传递闭包（Place / Person / Item）', () => {
        // `PopupEvent.options[].delta` 引整个 `Delta`，而 `Delta.entities` 又引 Place / Person / Item
        // ⇒ 这里锁的是 usedDefs() 的**传递闭包**算对了，而不只是顶层两个。
        t.deep(Object.keys(composeParameters(['npc000', 'npc003']).$def as object).sort(), [
          'CanvasEvent',
          'Delta',
          'Item',
          'Person',
          'Place',
          'PopupEvent',
        ]);
      });

      t.test('★ `$def` 放 `parameters` 末尾（与 `resolve` 同一条缓存纪律）', () => {
        const keys = Object.keys(composeParameters(['npc000', 'npc003']));
        t.eq(keys[keys.length - 1], '$def');
        t.deep(keys, ['type', 'properties', 'required', 'additionalProperties', '$def']);
      });

      t.test('`$ref` 指向的名字都挂在 `$def` 里 —— **引用了但忘了挂**这类静默错误没人会告诉你', () => {
        t.deep(checkRefs(composeParameters(['npc000', 'npc003'])), []);
      });

      t.test('`required` 与 `properties` 一一对应，且恰好是两条通道', () => {
        const p = composeParameters(['npc000', 'npc003']);
        t.deep(p.required, Object.keys(p.properties as object));
        t.deep(p.required, ['popup_events', 'canvas_events']);
      });

      t.test('function 形状：`type=function` · `name=compose_day` · `strict=true`', () => {
        const tool = composeTool(['npc000', 'npc003']) as { type: string; function: Record<string, unknown> };
        t.eq(tool.type, 'function');
        t.eq(tool.function.name, 'compose_day');
        t.eq(tool.function.strict, true);
        t.deep(Object.keys(tool.function), ['name', 'strict', 'description', 'parameters']);
      });

      t.test('★ 两条通道靠**结构**区分、不靠约定：档 A 无 `tier` 有 `options`；档 B/C 有 `tier` 无 `options`', () => {
        const defs = composeParameters(['npc000', 'npc003']).$def as Record<
          string,
          { properties: Record<string, unknown>; required: string[] }
        >;
        const popup = Object.keys(defs.PopupEvent.properties);
        const canvas = Object.keys(defs.CanvasEvent.properties);
        t.ok(!popup.includes('tier'), '档 A 恒为 A ⇒ 不写 tier（冗余字段只会给模型多一个填错的地方）');
        t.ok(popup.includes('options'), '档 A 的分支与数值全在 options 里预写（零调用结算）');
        t.ok(canvas.includes('tier'), '档 B/C 必须标档');
        t.ok(!canvas.includes('options'), '档 B/C 走 resolve，不该有 options');
        t.deep(defs.PopupEvent.required, popup, '档 A：required 与 properties 一一对应');
        t.deep(defs.CanvasEvent.required, canvas, '档 B/C：同上');
      });

      t.test('★ 选项的 `欲向` 只有三档 —— 点一下拿不到「得偿」「盛宴」', () => {
        const defs = composeParameters(['npc000', 'npc003']).$def as Record<
          string,
          { properties: { options: { items: { properties: { 欲向: { enum: string[] } } } } } }
        >;
        t.deep(defs.PopupEvent.properties.options.items.properties.欲向.enum, ['无关', '偏离', '趋近']);
      });

      t.test('★ 硬顶写进 function description —— 那是模型看得见的那一句，不是代码注释', () => {
        t.ok(
          COMPOSE_DESCRIPTION.includes(`自由事件总数 ≤${FREE_EVENT_CAP}`),
          `自由事件 ≤${FREE_EVENT_CAP} 必须出现在 description 里`,
        );
      });
    },
  },
  {
    name: '静态头 · 《开发规划.md》「必须现在就防的四件事」第 1 条',
    register(t) {
      t.test('★ 段 ① 的 hash **锁死** —— 它一变，`compose_day` 与 `resolve` 两个主链的缓存同时作废', () => {
        // 2026-10-08 用户第 5 条（难度分档）：段 ① 拆「三档共用头 ＋ 三档各自【基调】」，
        // STATIC_HEAD_PROSE = 档 1（基调比 2026-10-07 那版再倾向玩家）⇒ hash 换版。
        t.eq(STATIC_HEAD_PROSE_HASH, 'e157347e', '静态头变了就得有意为之，并同步更新这个值');
        t.eq(hash(STATIC_HEAD_PROSE), 'e157347e');
      });

      t.test('段 ① 的正文含【世界观】与【基调】两节（逐字常量，不是渲染出来的）', () => {
        t.ok(STATIC_HEAD_PROSE.startsWith('你是一个肉鸽叙事类游戏的叙事处理器'));
        t.ok(STATIC_HEAD_PROSE.includes('\n【世界观】西幻王国：'));
        t.ok(STATIC_HEAD_PROSE.includes('\n【基调】\n'));
        t.eq(STATIC_HEAD_PROSE.split('\n').length, 8);
      });

      // ⚠️ 2026-10-07 用户裁定（难度回调）：允许适当迎合 ＋ 允许荒诞；旧句"即使是荒诞也有其原因"
      //    与它直接冲突（逼着 LLM 给每处荒诞找理由），必须保持摘除状态。
      // ⚠️ 2026-10-08 用户第 5 条：档 1 基调**再倾向玩家一点** ——「可以适当迎合」升为
      //    「大胆迎合」，「允许适当的荒诞剧情」升为「也欢迎适当的荒诞剧情」。
      t.test('★ 段 ① 有【迎合与荒诞】—— 且旧冲突句「即使是荒诞也有其原因」不得回来', () => {
        t.ok(STATIC_HEAD_PROSE.includes('【迎合与荒诞】'), '要有迎合与荒诞一节');
        t.ok(STATIC_HEAD_PROSE.includes('大胆迎合玩家的欲望和他的文本输入'), '放权句要在（档 1 大胆迎合）');
        t.ok(STATIC_HEAD_PROSE.includes('也欢迎适当的荒诞剧情'), '荒诞许可要在');
        t.ok(!STATIC_HEAD_PROSE.includes('即使是荒诞也有其原因'), '旧冲突句不许回来');
      });

      // ⚠️ 2026-10-08 用户第 5 条（难度选择弹窗）：段 ① 拆为「三档共用头 ＋ 三档各自【基调】」
      //    （档 1/2 另带【迎合与荒诞】；同日晚些用户逐字修订后，档 3 的态度并入【基调】、无此块）——
      //    `STATIC_HEAD_PROSE` 仍是档 1（两段缓存的**前缀基准**），
      //    `staticProseOf(difficulty)` 按账本挑档；0 / undefined（还没选 / 旧档）落回档 1。
      t.test('★ 三档人设 —— staticProseOf 按难度挑档；0 / undefined 落回档 1', () => {
        t.eq(staticProseOf(1), STATIC_HEAD_PROSE, '档 1 就是静态头正本（缓存前缀基准）');
        t.eq(staticProseOf(0), STATIC_HEAD_PROSE, '0 = 还没选 ⇒ 按档 1 渲染');
        t.eq(staticProseOf(undefined as unknown as number), STATIC_HEAD_PROSE, '旧档缺键 ⇒ 按档 1 兜底');
        t.ok(staticProseOf(2).includes('偶尔也会适当纵容玩家的荒谬言行'), '档 2 的纵容句');
        t.ok(staticProseOf(2).includes('合适的时候，可以迎合'), '档 2 是看时机迎合（2026-10-08 修订版，不是大胆）');
        t.ok(staticProseOf(3).includes('这是一个严肃真实的西幻世界'), '档 3 的严肃句（2026-10-08 修订版，点明「西幻」）');
        t.ok(staticProseOf(3).includes('玩家只是茫茫人海中的一个普通人'), '档 3 点明世界不围着玩家转');
        t.ok(!staticProseOf(3).includes('【迎合与荒诞】'), '档 3 无独立的迎合与荒诞块（态度并入【基调】，2026-10-08 修订）');
        t.ok(!staticProseOf(3).includes('大胆迎合'), '档 3 不得出现档 1 的迎合句');
        // 三档共用头一字不差（换档只换【基调】往下的几行，缓存前缀的"头几行"不动）
        const SHARED = '你是一个肉鸽叙事类游戏的叙事处理器';
        t.ok(
          staticProseOf(1).startsWith(SHARED) && staticProseOf(2).startsWith(SHARED) && staticProseOf(3).startsWith(SHARED),
          '三档共用头一致',
        );
      });

      t.test('★ renderStaticHead 读账本 difficulty —— 三档各拼各的段 ①', () => {
        const l0 = initialLedger();
        t.eq(l0.difficulty, 0, '开局账本 difficulty = 0（还没选）');
        t.eq(renderStaticHead(l0), staticProseOf(0) + '\n\n' + renderEntitySkeleton(l0), 'difficulty=0 ⇒ 档 1');
        const l3 = initialLedger();
        l3.difficulty = 3;
        t.ok(renderStaticHead(l3).startsWith(staticProseOf(3)), 'difficulty=3 ⇒ 档 3 开头');
        t.ok(!renderStaticHead(l3).includes('大胆迎合玩家的欲望'), '档 3 静态头里没有档 1 的迎合句');
      });

      t.test('★ 段 ① 已按用户 2026-09-18 定稿**删除「西幻锚定段」** —— 这是有意为之，不是漏写', () => {
        // 背景：那段（点名"西方奇幻／欧洲中世纪"＋中式负例「督察院／户曹／更鼓」）是为修一条
        //       --live 实测缺陷临时加的（LLM 产出了中式官制词）。用户裁定精简掉，**风险自担、已知**。
        //       若 --live 再现中式词，第一个要加回来的就是那段锚定＋负例——那时把这几条改回去。
        t.ok(!STATIC_HEAD_PROSE.includes('督察院'), '锚定段已删；这条若挂，说明有人把负例加回来了——那是另一个决定');
        t.ok(!STATIC_HEAD_PROSE.includes('欧洲中世纪'));
      });

      t.test('★ 段 ② 实体表：**按 id 升序**、人物/地点/物品各就各位', () => {
        const s = renderEntitySkeleton(initialLedger());
        const i0 = at(s, 'npc000 ｜');
        const i1 = at(s, 'npc001 ｜');
        const i2 = at(s, 'npc002 ｜');
        t.ok(i0 >= 0 && i0 < i1 && i1 < i2, '人物行必须按 id 升序出现');
        for (const line of ['loc001 塞兰王庭', 'loc002 三王子寝殿', 'it001 短匕首']) {
          t.ok(s.includes(line), `实体表缺少「${line}」`);
        }
      });

      t.test('★ 物品行必须带**物品大类**（2026-09-18：它曾被判别符覆盖、全链路蒸发）', () => {
        const s = renderEntitySkeleton(initialLedger());
        t.ok(s.includes('it001 短匕首（装备）'), `物品行里要能看见大类；实得：${s.split('\n').find((x) => x.startsWith('it001'))}`);
      });

      t.test('★ 段 ② 只叫 LLM 填**临时编号** —— 不再向它报正式 id 的水位（2026-09-19 用户裁定）', () => {
        // 背景：旧文案写"此后新建人物从 npc003 起递增"，与 schema 方向相反
        //       （`PERSON.id.description` = "新角色一律填批次内临时编号 @p1"），
        //       而且那个 npc003 是从假数据最大后缀反推的、与系统实际水位（npc011）不符
        //       ⇒ 已删。这条若挂，说明有人把"正式 id 水位句"加回来了 —— 那是另一个决定。
        const s = renderEntitySkeleton(initialLedger());
        t.ok(s.includes('新建人物 / 物品 / 地点一律填批次内临时编号'), '要写明只填临时编号');
        t.ok(s.includes('@p1') && s.includes('@it1') && s.includes('@loc1'), '三种前缀都要点到');
        t.ok(!s.includes('此后新建人物从'), '不得再向 LLM 报正式 id 水位（人物）');
        t.ok(!s.includes('新物品从'), '不得再向 LLM 报正式 id 水位（物品）');
      });

      t.test('★ 地点尾注按用户 2026-09-19 手改版：**已删「新地点限金庭城内与城郊；」**', () => {
        const s = renderEntitySkeleton(initialLedger());
        t.ok(s.includes('（已在上面列出的，固定用同一个名字）'));
        t.ok(!s.includes('新地点限金庭城内与城郊'), '用户已删此半句，别在重生成时加回来');
      });

      t.test('★ 开局数据的 `race` / `identity` 必须落在 schema 的 enum 内（2026-09-19 用户裁定）', () => {
        // 教训：这两个 enum **只写在 schema 里当提示词**——服务端不校验、规则层也没有闸门
        //       ⇒ 开局数据可以是非法值而全链无人报警（这里此前真的写着
        //       `塞兰人` / `王族` / `武人` / `幕僚`，四个值全不在 enum 内）。
        // 这里**直接读 `PERSON` 的 schema 拿白名单**，不另抄一份 ⇒ 断言永远不会与 schema 漂移。
        const props = PERSON.properties as Record<string, { enum?: string[] }>;
        const races = props.race.enum ?? [];
        const identities = props.identity.enum ?? [];
        t.ok(races.length > 0 && identities.length > 0, 'schema 里必须能读到两个 enum');
        for (const p of initialLedger().entities.people) {
          t.ok(races.includes(p.race), `${p.id} 的 race「${p.race}」不在 ${races.join(' / ')}`);
          t.ok(identities.includes(p.identity), `${p.id} 的 identity「${p.identity}」不在 ${identities.join(' / ')}`);
        }
      });

      t.test('实体表**只放身份骨架**：六维 / 印象 / 携带一律不进（它们在 user ③【实体状态】）', () => {
        const s = renderEntitySkeleton(initialLedger());
        t.ok(!s.includes('争斗'), '六维属 user 段');
        t.ok(!s.includes('你眼中的ta'));
      });

      t.test('静态头 = 段 ① ＋ 空行 ＋ 段 ②', () => {
        const head = renderStaticHead(initialLedger());
        t.eq(head, STATIC_HEAD_PROSE + '\n\n' + renderEntitySkeleton(initialLedger()));
      });
    },
  },
  {
    name: 'prompt 装配 · 《装配规范.md》§0.1 / §4.2 / §4.3',
    register(t) {
      t.test('★ system = 静态头 ＋ 空行 ＋ 任务指令（① ② 都逐字稳定）', () => {
        const { l, ev } = fixture();
        const a = assembleResolve(l, ev, HANDLING, '裁定');
        t.eq(a.system, STATIC_HEAD_PROSE + '\n\n' + renderEntitySkeleton(l) + '\n\n' + INSTRUCTION_CHECK);
        t.eq(a.instruction, '裁定');
      });

      t.test('★ user ③ 块的顺序 = 越不变越靠前（欲望 → 氛围 → 概要 → 未处理·处理中 → 实体状态 → 当前状态 → 事件卡 → 处理 → 能力）', () => {
        const { l, ev } = fixture();
        const u = renderResolveUser(l, ev, HANDLING);
        const order = ['【他的欲望】', '【本周氛围】', '【已处理概要】', '【未处理 · 处理中】', '【实体状态】', '【当前状态】', '【事件卡】', '【玩家的处理】', '【处理者能力】'];
        const idx = order.map((k) => at(u, k));
        t.ok(idx.every((x) => x >= 0), '九块一个都不能少（空态也要写哨兵，不是省略行）');
        t.deep([...idx].sort((a, b) => a - b), idx, '块的出现顺序必须与《装配规范》§四 一致');
      });

      t.test('★ user 末行是**行动提示**（任务指令之后还有整段 user，得把注意力拉回来）', () => {
        const { l, ev } = fixture();
        t.ok(renderResolveUser(l, ev, HANDLING).endsWith('按【裁定】指令输出裁定结果。'));
        t.ok(
          renderResolveUser(l, ev, HANDLING, { tier: '成功', bonuses: [], landed: [] }).endsWith(
            '按【结算】指令输出结算结果。',
          ),
        );
      });

      t.test('★ 裁定半的 user **没有**【判定结果】【系统已落账】—— 这两块是结算半的增量（§4.3）', () => {
        const { l, ev } = fixture();
        const u = renderResolveUser(l, ev, HANDLING);
        t.eq(at(u, '【判定结果】'), -1);
        t.eq(at(u, '【系统已落账'), -1);
      });

      t.test('★ 结算半的 user = 裁定半全部块原样保留 ＋【判定结果】＋【系统已落账】，且两块都在**末尾**', () => {
        const { l, ev } = fixture();
        const u = renderResolveUser(l, ev, HANDLING, { tier: '困难成功', bonuses: ['半截钥匙 +2'], landed: ['文书(npc002) 本日行动力 −2'] });
        t.ok(u.includes('【判定结果】困难成功 · 加成 半截钥匙 +2'));
        t.ok(u.includes('【系统已落账】文书(npc002) 本日行动力 −2'));
        t.ok(at(u, '【判定结果】') > at(u, '【处理者能力】'));
        t.ok(at(u, '【系统已落账') > at(u, '【判定结果】'));
      });

      t.test('★【系统已落账】**不列托管投入 P** —— 它是上限不是已花的钱（写进去 ⇒ 全额退款式 bug）', () => {
        const { l, ev } = fixture();
        const u = renderResolveUser(l, ev, HANDLING, { tier: '成功', bonuses: [], landed: [] });
        t.ok(u.includes('投入金币 2'), 'P 出现在【玩家的处理】里（那是它的位置）');
        t.ok(u.includes('【系统已落账】无'), '清单本身为空 ⇒ 写哨兵「无」');
      });

      t.test('★ 2026-10-07 用户裁定：标了最低投入、玩家一枚没给 ⇒ 如实写「玩家尝试不直接支付金币」', () => {
        const { l, ev } = fixture();
        t.ok(ev.min_gold > 0, 'fixture 前提：事件标了最低投入');
        const paid = handlingBlock(l, ev, { ...HANDLING, goldInput: 2 });
        t.eq(paid.includes('玩家尝试不直接支付金币'), false, '给了钱（哪怕低于最低额）⇒ 不点破');
        const bypass = handlingBlock(l, ev, { ...HANDLING, goldInput: 0 });
        t.ok(bypass.includes('玩家尝试不直接支付金币'), '一枚没给 ⇒ 必须点破，交给 LLM 裁定对方买不买账');
        t.ok(bypass.includes(`事件最低 ${ev.min_gold}`), '并把最低额一并写明（LLM 要知道他绕的是多大一笔）');
        // min_gold = 0 的事件没给钱是常态，不是"绕" ⇒ 不写
        const free = makeEventCard({ ...EVENT_CARD, min_gold: 0 });
        t.eq(
          handlingBlock(l, free, { ...HANDLING, goldInput: 0 }).includes('玩家尝试不直接支付金币'),
          false,
          '事件本来就不要钱 ⇒ 没给不叫绕，不写',
        );
      });

      t.test('★ 防剧透：pending 的叙事出现在 user 段 ⇒ 立刻抛错（结构底线）', () => {
        const { l, ev } = fixture();
        l.pending.push({
          eventId: 'e1',
          tier: '成功',
          narration: '掌柜把那张单子推到他面前，半个印的断口很新。',
          delta: { ops: [] },
          summary: '',
          next_seeds: [],
          欲向: '无关',
        });
        const clean = renderResolveUser(l, ev, HANDLING);
        assertNoSpoiler(clean, l); // 没泄露 ⇒ 不抛
        t.throws(() => assertNoSpoiler(clean + '\n' + l.pending[0].narration, l), '防剧透底线被破');
      });

      t.test('空态纪律：【已处理概要】无归档写「（暂无）」、最近一天也写「· （暂无）」', () => {
        const { l, ev } = fixture();
        const u = renderResolveUser(l, ev, HANDLING);
        t.ok(u.includes('〔归档〕（暂无）'));
        t.ok(u.includes('· （暂无）'));
      });

      t.test('★【未处理 · 处理中】把还没出结果的事件摊开给模型看', () => {
        const { l, ev } = fixture();
        l.events.live.push({
          ...ev,
          id: 'e2',
          title: '谷仓的另一笔账',
          status: '待处理',
          handler: null,
          started_at: null,
          reveal_at: null,
        });
        l.events.live.push({
          ...ev,
          id: 'e3',
          title: '往城郊的一趟远行',
          status: '揭晓待办',
          handler: 'npc002',
          started_at: { day: 1, used: 0 },
          reveal_at: { day: 2, used: 4 },
        });
        const u = renderResolveUser(l, ev, HANDLING);
        t.ok(at(u, '【未处理 · 处理中】') > at(u, '【已处理概要】'), '排在【已处理概要】之后（§5.3：易变内容靠后）');
        t.ok(at(u, '【未处理 · 处理中】') < at(u, '【实体状态】'), '仍在静态块之前');
        t.ok(u.includes('未处理：谷仓的另一笔账'), '未处理桶要列其他待处理事件的标题');
        t.ok(u.includes('处理中：瓦伦丁·索雷 · 第 2 天回'), '处理中桶要写「谁 · 第 N 天回」');
      });

      t.test('★ 三桶的归属写清楚、且**不重复**：「已处理」的内容只在【已处理概要】里，块内不给指针行', () => {
        const { l, ev } = fixture();
        const u = renderResolveUser(l, ev, HANDLING);
        t.ok(!u.includes('已处理：'), '块内不得出现「已处理：」那行（2026-09-18 用户裁定：指针行不留）');
        t.ok(!u.includes('不要复述'), '也不许写"纪律"式提醒 —— 把归属写清楚就够了');
        t.ok(u.includes('【已处理概要】'), '「已处理」的内容仍在块外那一块里（三桶归属：两块合起来覆盖三种状态）');
      });

      t.test('★【未处理 · 处理中】**不含本事件** —— 两段式的两次调用必须字节相同（否则「结算半原样保留」这条就废了）', () => {
        const { l, ev } = fixture();
        const seg = (s: string): string => s.slice(at(s, '【未处理 · 处理中】'), at(s, '\n\n【实体状态】'));
        const before = seg(renderResolveUser(l, ev, HANDLING));
        // 模拟 `turn/handle.ts`：发结算半**之前**本事件已被翻成「揭晓待办」
        ev.status = '揭晓待办';
        ev.handler = 'npc002';
        ev.started_at = { day: 1, used: 0 };
        ev.reveal_at = { day: 2, used: 4 };
        const after = seg(renderResolveUser(l, ev, HANDLING));
        t.eq(after, before, '本事件的状态翻转不该动这一块一个字节');
        t.ok(!after.includes(ev.title), '本事件在【事件卡】里，不该再出现在桶里');
      });

      t.test('空态纪律：【三桶】两个桶都空 ⇒ 写哨兵「无」（不省略行）', () => {
        const { l, ev } = fixture();
        const u = renderResolveUser(l, ev, HANDLING);
        t.ok(u.includes('未处理：无'));
        t.ok(u.includes('处理中：无'));
      });

      t.test('★ 忽略形态（事件过期）＝ 同一段 system ＋ 只换【玩家的处理】、去掉【处理者能力】', () => {
        const { l, ev } = fixture();
        const normal = assembleResolve(l, ev, HANDLING, '结算', { tier: '成功', bonuses: [], landed: [] });
        const ig = assembleIgnore(l, ev);
        t.eq(ig.system, normal.system, '★ system **逐字相同** ⇒ 前缀缓存共享：忽略结算不是第二条路径');
        t.ok(
          ig.user.includes(
            '【玩家的处理】玩家选择忽略这件事，根据这件事的重要程度，请你直接生成相应的结算结果与概要。',
          ),
          '★ 文案逐字来自用户裁定 —— 它同时交代了处境与任务，所以 system 一个字都不用改',
        );
        t.eq(at(ig.user, '【处理者能力】'), -1, '没有参与者 ⇒ 这一块整段不存在（不是留个空标题）');
        t.ok(ig.user.endsWith('按【结算】指令输出结算结果。'));
        t.ok(ig.user.includes('【事件卡】'), '事件卡照给 —— 被忽略的是"处理"这件事，不是这件事本身');
        t.ok(at(ig.user, '【判定结果】') === -1, '忽略没有裁定、没有掷骰 ⇒ 不该出现【判定结果】');
      });
    },
  },
  {
    name: 'prompt 装配 · `compose_day` 生成半（Phase 3 · 《装配规范.md》§4.1）',
    register(t) {
      t.test('★【生成】指令只收**指令本身** —— user ③ 的块标题一个字都不许混进来（§0.1 拆法）', () => {
        for (const block of [
          '【本日调度】',
          '【当前状态】',
          '【本周氛围】',
          '【实体状态】',
          '【已处理概要】',
          '【未处理 · 处理中 · 已处理】',
        ]) {
          t.ok(!INSTRUCTION_COMPOSE.includes(block), `生成指令里混进了 user 块 ${block}`);
        }
      });

      t.test('★【硬约束】的条数铁律与 schema **共用一份常量**（不写死 5，避免两处各写一个数）', () => {
        t.ok(INSTRUCTION_COMPOSE.includes(`自由事件 ≤${FREE_EVENT_CAP} 条`));
      });

      t.test('`创建事件` 指令：只产出 1 条 `canvas_event`、且**不承认既成事实**', () => {
        t.ok(INSTRUCTION_CREATE.includes('只产出 1 条 canvas_event'));
        t.ok(INSTRUCTION_CREATE.includes('canvas_events（1 条）'));
        t.ok(INSTRUCTION_CREATE.includes('不承认既成事实'));
      });

      t.test('★ `assembleCompose` 的 system = 静态头 ＋【生成】指令（与 resolve 共享同一份段 ①）', () => {
        const { l } = fixture();
        const a = assembleCompose(l);
        t.eq(a.system, STATIC_HEAD_PROSE + '\n\n' + renderEntitySkeleton(l) + '\n\n' + INSTRUCTION_COMPOSE);
        t.eq(a.instruction, '生成');
      });

      t.test('★ 生成侧 user ③ 顺序 = §4.1 **逐字**（欲望 → 氛围 → 概要 → 实体状态 → 当前状态 → 本日调度 → 桶）', () => {
        const { l } = fixture();
        const u = renderComposeUser(l);
        const order = [
          '【他的欲望】',
          '【本周氛围】',
          '【已处理概要】',
          '【实体状态】',
          '【当前状态】',
          '【本日调度】',
          '【未处理 · 处理中 · 已处理】',
        ];
        const idx = order.map((k) => at(u, k));
        t.ok(idx.every((x) => x >= 0), '七块一个都不能少（空态写哨兵，不是省略行）');
        t.deep([...idx].sort((a, b) => a - b), idx, '块序必须与 §4.1 一致');
        t.ok(u.endsWith('按【生成】指令输出本日事件。'), '末行是行动提示（把注意力从整段 user 拉回来）');
      });

      t.test('★ 生成侧与 resolve 侧**桶的位置不同是有意的** —— 这边排在最后（§4.1 vs §4.2）', () => {
        const { l } = fixture();
        const u = renderComposeUser(l);
        t.ok(at(u, '【未处理 · 处理中 · 已处理】') > at(u, '【本日调度】'), '照抄 §4.1，别顺手统一成 resolve 的次序');
      });

      t.test('★ 生成侧的桶**带着详情**（第十五批）：未处理/处理中列《标题》＋正文；已处理列《标题》＋结算概括', () => {
        const { l, ev } = fixture();
        l.events.live.push({
          ...ev,
          id: 'e2',
          title: '谷仓的另一笔账',
          content: '谷仓的账房说账目对不上，要人去核一遍。',
          status: '待处理',
          handler: null,
          started_at: null,
          reveal_at: null,
        });
        l.events.live.push({
          ...ev,
          id: 'e3',
          title: '往城郊的一趟远行',
          content: '商队要人押车。',
          status: '揭晓待办',
          handler: 'npc002',
          started_at: { day: 1, used: 0 },
          reveal_at: { day: 2, used: 4 },
        });
        l.events.live.push({
          ...ev,
          id: 'e4',
          title: '前天了结的一桩',
          status: '已结算',
          settled_summary: '瓦伦丁·索雷把账核平了。',
        });
        l.events.live.push({
          ...ev,
          id: 'e5',
          title: '更早的一件',
          status: '已结算',
          settled_summary: '',
        });
        const u = renderComposeUser(l);
        t.ok(u.includes('《谷仓的另一笔账》谷仓的账房说账目对不上'), '未处理：标题＋LLM 当时给的详情');
        t.ok(u.includes('《往城郊的一趟远行》商队要人押车。（瓦伦丁·索雷 · 第 2 天回）'), '处理中：标题＋详情＋谁在第几天回');
        t.ok(u.includes('已处理（最近几件'), '生成侧要有「已处理」清单行');
        t.ok(u.includes('《前天了结的一桩》瓦伦丁·索雷把账核平了。'), '已处理：标题＋结算概括');
        t.ok(!u.includes('更早的一件'), '没写出概括的已处理事件不进清单（配不了对就是空话）');
      });

      t.test('★【本日调度】的 `L` 取自 `calcL()` —— 不在这里另算一份公式', () => {
        const { l } = fixture();
        const cap = calcL(l, l.clock.day).cap;
        const u = renderComposeUser(l);
        t.ok(u.includes(`行动点上限：L ≤ ${cap}`));
        t.ok(u.includes('种子：无'), '没有种子时写哨兵「无」');
      });

      t.test('★ 生成侧的桶**不带**那句括注 —— 生成侧根本没有「正在处理的这一条」', () => {
        const { l } = fixture();
        t.ok(!renderComposeUser(l).includes('正在处理的这一条不在其中'));
      });
    },
  },
  {
    name: 'prompt 装配 · `compose_day` 玩家自建（创建事件 · 《契约.md》§三）',
    register(t) {
      t.test('★【玩家的处理方式】与【他的欲望】是**两块** —— 前者是这次的原话、后者是开局塔罗定的命题', () => {
        const { l } = fixture();
        const u = renderCreateUser(l, '我想去城郊给我母亲立一块碑');
        t.ok(u.includes('【他的欲望】'), '欲望命题常驻（每份 user ③ 的首块）');
        t.ok(u.includes('【玩家的处理方式】"我想去城郊给我母亲立一块碑"'), '玩家的原话要逐字带上引号');
        t.ok(at(u, '【他的欲望】') < at(u, '【玩家的处理方式】'), '欲望在前（不变）、处理方式在后（最易变）');
      });

      t.test('★ 自建**豁免额度检测** ⇒ user ③ 里没有【本日调度】', () => {
        const { l } = fixture();
        const u = renderCreateUser(l, '随便做点什么');
        t.ok(!u.includes('【本日调度】'), '自建不占条数、不进 L ⇒ 调度块对它没有意义');
      });

      t.test('★ 自建 user ③ 的末行 = 「按【创建事件】指令输出这条事件。」', () => {
        const { l } = fixture();
        t.ok(renderCreateUser(l, 'x').endsWith('按【创建事件】指令输出这条事件。'));
      });

      t.test('★ `assembleCreate` 与生成半**同一 function、不同指令**（system ② 分岔 ⇒ 前缀在指令处隔离）', () => {
        const { l } = fixture();
        const c = assembleCreate(l, 'x');
        const g = assembleCompose(l);
        t.eq(c.instruction, '创建事件');
        t.ok(c.system.startsWith(STATIC_HEAD_PROSE), '两半共享同一份段 ①（缓存前缀）');
        t.ok(c.system.endsWith(INSTRUCTION_CREATE));
        t.ok(g.system.endsWith(INSTRUCTION_COMPOSE));
        t.ok(c.system !== g.system);
      });

      t.test('★【创建事件】指令只收**指令本身** —— user ③ 的块标题一个字都不许混进来', () => {
        for (const block of ['【玩家的处理方式】', '【当前状态】', '【本周氛围】', '【实体状态】', '【已处理概要】']) {
          t.ok(!INSTRUCTION_CREATE.includes(block), `创建事件指令里混进了 user 块 ${block}`);
        }
      });
    },
  },
  {
    name: '三条硬护栏 · 《契约.md》§3.3 + Phase 0 实测',
    register(t) {
      t.test('★ ① `thinking` 硬编码关闭 —— 不传即默认开启思考模式，而思考模式下指定 function 必 400', () => {
        const body = buildChatBody({ model: 'deepseek-flash', messages: [], tools: [], toolChoiceName: 'resolve' });
        t.deep(body.thinking, { type: 'disabled' });
      });

      t.test('★ ② 不传 `temperature` / `top_p`（统一非思考模式，采样参数无意义）', () => {
        const body = buildChatBody({ model: 'deepseek-flash', messages: [], tools: [], toolChoiceName: 'resolve' });
        t.ok(!('temperature' in body));
        t.ok(!('top_p' in body));
      });

      t.test('★ `tool_choice` 锁死到具体 function；每个调用点**只挂那一个** function', () => {
        const { l, ev } = fixture();
        const req = buildCheckRequest(CFG, l, ev, HANDLING);
        t.deep(req.body.tool_choice, { type: 'function', function: { name: 'resolve' } });
        t.eq((req.body.tools as unknown[]).length, 1);
        t.eq(req.body.model, 'deepseek-flash');
        t.ok(!('stream' in req.body) || req.body.stream === false);
      });

      t.test('★ ③ 两段式的消息序列 = `system → user → assistant(tool_calls) → tool(同 id)`', () => {
        const { l, ev } = fixture();
        const cont: TwoStageContinuation = {
          stage: 'two',
          toolCallId: 'call_abc',
          checkArgs: { intent_summary: '派文书去核账', check: normalizeCheck({ verdict: '投骰', participants: ['智慧', '社交'] }) },
        };
        const req = buildSettleRequest(CFG, l, ev, HANDLING, { tier: '困难成功', bonuses: [], landed: [] }, cont);
        const msgs = req.body.messages as Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string; content: string }>;
        t.deep(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
        t.eq(msgs[2].tool_calls?.[0].id, 'call_abc');
        t.eq(msgs[3].tool_call_id, 'call_abc', 'tool 消息必须与前面的 assistant 成对（§2.4）');
        t.eq(msgs[2].content, '', '带 tool_calls 的 assistant 消息 content 必须是空串，不是 null');
      });

      t.test('★ ③ 回填的消息里**只有** `{档位, 加成}` —— `d20` / `A` / `R` 永不外泄', () => {
        const { l, ev } = fixture();
        const cont: TwoStageContinuation = { stage: 'two', toolCallId: 'call_abc', checkArgs: {} };
        const req = buildSettleRequest(CFG, l, ev, HANDLING, { tier: '大成功', bonuses: ['短匕首 +1'], landed: [] }, cont);
        const msgs = req.body.messages as Array<{ role: string; content: string }>;
        const payload = JSON.parse(msgs[3].content) as object;
        t.deep(Object.keys(payload), ['档位', '加成']);
        t.eq((payload as { 档位: string }).档位, '大成功');
        // ⚠️ 只查**发出去的消息**：`body.tools` 里的 schema 是另一回事（那是给模型的字段说明）
        const sent = JSON.stringify(msgs);
        for (const leak of ['d20', 'adjusted', 'modifierTotal']) {
          t.ok(!sent.includes(leak), `消息里不该出现 ${leak}`);
        }
      });

      t.test('★ 二段请求的 system 用**结算**指令（与裁定那次的字节前缀不同 ⇒ 前缀隔离）', () => {
        const { l, ev } = fixture();
        const check = buildCheckRequest(CFG, l, ev, HANDLING);
        const settle = buildSettleRequest(CFG, l, ev, HANDLING, { tier: '成功', bonuses: [], landed: [] }, {
          stage: 'two',
          toolCallId: 'call_x',
          checkArgs: {},
        });
        t.ok(check.prompt.system.endsWith(INSTRUCTION_CHECK));
        t.ok(settle.prompt.system.endsWith(INSTRUCTION_SETTLE));
        t.ok(check.prompt.system.startsWith(STATIC_HEAD_PROSE), '两次都以同一份段 ① 开头（缓存前缀）');
      });

      t.test('`assistantToolCall` / `toolMessage` 的序列化：arguments 是**字符串化的对象**', () => {
        const a = assistantToolCall('id1', 'resolve', { x: 1 });
        t.deep(JSON.parse(a.tool_calls![0].function.arguments), { x: 1 });
        t.deep(JSON.parse(toolMessage('id1', { 档位: '成功', 加成: [] }).content), { 档位: '成功', 加成: [] });
      });

      t.test('消息构造器（最底层的一层，坏了后面全塌）', () => {
        t.eq(systemMessage('s').role, 'system');
        t.eq(userMessage('u').role, 'user');
      });
    },
  },
  {
    name: '输出归一化 · 服务端不校验 ⇒ 规则层是唯一防线',
    register(t) {
      t.test('★ 畸形 `verdict` 兜到「投骰」—— 档位仍由规则层投出来，不会凭空给成败', () => {
        t.eq(normalizeCheck({ verdict: '随便写的' }).verdict, '投骰');
        t.eq(normalizeCheck({}).verdict, '投骰');
        t.eq(normalizeCheck(null).verdict, '投骰');
      });

      t.test('`participants`：非法属性被剔除、至多 3 个（`calcA` 会断言上限）', () => {
        t.deep(normalizeCheck({ verdict: '投骰', participants: ['智慧', '力气', '社交', '魅力', '感知'] }).participants, [
          '智慧',
          '社交',
          '魅力',
        ]);
        t.deep(normalizeCheck({ verdict: '投骰', participants: '智慧' }).participants, []);
      });

      t.test('★ 非「投骰」时 `difficulty` 一律归零（免判定的路径不该带难度骰）', () => {
        t.eq(normalizeCheck({ verdict: '无需判定', difficulty: '惩罚2' }).difficulty, '无修正');
        t.eq(normalizeCheck({ verdict: '投骰', difficulty: '惩罚2' }).difficulty, '惩罚2');
      });

      t.test('`direct_result` 只收五档或「无」', () => {
        t.eq(normalizeCheck({ verdict: '直接成功', direct_result: '大成功' }).direct_result, '大成功');
        t.eq(normalizeCheck({ verdict: '直接成功', direct_result: '天选' }).direct_result, '无');
      });

      t.test('★ 「拒绝」不再存在：schema 枚举与归一化输出里都没有它（2026-10-07 用户裁定）', () => {
        t.ok(!VERDICTS.includes('拒绝' as never), 'VERDICTS 枚举里不许还有「拒绝」');
        t.eq(normalizeCheck({ verdict: '拒绝', reject_reason: '权限' }).verdict, '投骰', '畸形/已废 verdict 一律兜到「投骰」');
        t.eq('reject_reason' in normalizeCheck({}), false, '归一化输出不再带 reject 字段');
        const params = resolveTool().function.parameters as {
          $def: Record<string, { properties: Record<string, unknown> }>;
        };
        t.ok(!('reject_reason' in params.$def.Check.properties), 'schema 里已删 reject_reason');
        t.ok(!('reject_note' in params.$def.Check.properties), 'schema 里已删 reject_note');
      });

      t.test('`Check` 四个字段一个不缺（strict 全必填，缺了就是结构缺口）', () => {
        t.deep(Object.keys(normalizeCheck({})).sort(), [
          'difficulty',
          'direct_result',
          'participants',
          'verdict',
        ]);
      });
    },
  },
  {
    // ⚠️ 这一组是 2026-09-18 第 5 缺陷的**回归锁**：prompt 原先无条件要求"裁定半只填两个字段、
    //    其余留空"，而免判定那三条走法**根本没有第二次调用** ⇒ 拿回一个空结算。
    //    `fakeBrain` 不读 prompt（两半都填）⇒ 离线**永远**测不到 ⇒ 只能锁 prompt 文本本身。
    name: '机制一致性 · prompt 不许与机制打架（2026-09-18 用户裁定）',
    register(t) {
      t.test('★ 裁定指令必须**同时**给出两条走法：要掷骰只给判定要素、不掷骰一次填满', () => {
        t.ok(INSTRUCTION_CHECK.includes('verdict=投骰'), '要点名掷骰这条走法');
        t.ok(INSTRUCTION_CHECK.includes('只填'), '掷骰走法要说明"只填"哪几个字段');
        t.ok(INSTRUCTION_CHECK.includes('连结算半一起写满'), '免判定走法必须要求一次填满');
        t.ok(INSTRUCTION_CHECK.includes('没有第二次调用'), '要讲清免判定没有第二次机会');
      });

      t.test('★ 结算指令【本次要填】必须列全 schema 的必填字段（原先漏了 `欲向`）', () => {
        for (const k of ['narration', 'delta', 'scene_over', 'summary', 'next_seeds', 'vouchers', '欲向']) {
          t.ok(INSTRUCTION_SETTLE.includes(k), '【本次要填】漏了 ' + k);
        }
      });

      t.test('★ `scene_over` 不再硬写 `=true` —— 多轮互动的中途轮要能填 false', () => {
        t.ok(!INSTRUCTION_SETTLE.includes('scene_over=true'), '指令里不许把 scene_over 钉死成 true');
        const props = resolveParameters().properties as Record<string, { description?: string }>;
        t.ok((props.scene_over.description ?? '').includes('中途轮'), '字段说明要点名中途轮');
      });

      t.test('★ 再无「无条件留空」的字段说明 —— 它会把免判定那一半也一起留空', () => {
        const props = resolveParameters().properties as Record<string, { description?: string }>;
        for (const k of ['intent_summary', 'narration', 'scene_over', 'summary', 'next_seeds', '欲向']) {
          const d = props[k].description ?? '';
          t.ok(!d.includes('裁定半'), k + ' 的说明里还有"裁定半"式的无条件留空：' + d.slice(0, 40));
        }
      });

      t.test('★ `Delta` 的说明同样条件化（原来写"裁定半一律填 {ops:[]}"）', () => {
        const params = resolveTool().function.parameters as { $def: Record<string, { description?: string }> };
        const d = params.$def.Delta.description ?? '';
        t.ok(d.includes('要掷骰'), 'Delta 说明要按走法条件化');
        t.ok(!d.includes('一律填'), '旧的无条件措辞必须消失');
      });

      t.test('★ `Check.verdict` 的说明要点出"它决定走哪条路"', () => {
        const params = resolveTool().function.parameters as {
          $def: Record<string, { properties: Record<string, { description?: string }> }>;
        };
        const v = params.$def.Check.properties.verdict.description ?? '';
        t.ok(v.includes('这一次就把结算一起填完'), 'verdict 说明要讲清一段式要填满');
        t.ok(!v.includes('两段式的第二次调用'), '第二次调用的措辞要与别处统一');
      });

      t.test('★【系统已落账】不再出现"不要重复计入"式训话 —— 那条是误导性话语', () => {
        const { l, ev } = fixture();
        const u = renderResolveUser(l, ev, HANDLING, {
          tier: '成功',
          bonuses: [],
          landed: ['文书(npc002) 本日行动力 −2'],
        });
        t.ok(u.includes('【系统已落账】文书(npc002) 本日行动力 −2'));
        t.ok(!u.includes('不要重复计入'), '命令式警告必须绝迹');
      });

      t.test('★ 非下属的状态列写「尚未入队」—— 对外人问"空闲"没有意义', () => {
        const { l, ev } = fixture();
        const outsider = l.entities.people.find((p) => p.id === 'npc001');
        if (!outsider) throw new Error('夹具缺 npc001');
        outsider.affiliated = false;
        // ⚠️「重伤」= HP 2，要**显式摆**：预置阵容的 HP 一律满值，
        //    原稿是指望 npc002 恰好带伤 —— 那种依赖会随预置数据一起**静默**过期。
        l.entities.people.find((p) => p.id === 'npc002')!.hp = 2;
        const u = renderResolveUser(l, ev, HANDLING);
        t.ok(u.includes('npc001 奥德里克三世') && u.includes('尚未入队'), '非下属要标「尚未入队」');
        t.ok(u.includes('npc002 瓦伦丁·索雷：') && u.includes('重伤'), '在册者照旧按 HP 派生状态');
      });

      t.test('★ 玩家的荒诞 / "作弊"输入一律**合理化**，没有拒绝渠道 —— 2026-10-07 用户裁定', () => {
        t.ok(INSTRUCTION_CHECK.includes('合理化'), '裁定指令里必须有"合理化"这一条');
        t.ok(INSTRUCTION_CHECK.includes('元层越界'), '要说清它管的是元层越界');
        t.ok(INSTRUCTION_CHECK.includes('核心玩法'), '荒诞输入要被点名是核心玩法（欢迎它）');
        t.ok(!INSTRUCTION_CHECK.includes('verdict=拒绝'), '指令里不许再出现「拒绝」这条走法');
        t.ok(INSTRUCTION_CHECK.includes('没有"拒绝"这个选项'), '要明说模型手里没有拒绝');
      });

      t.test('★【他的欲望】保留「手段」与「目的」两句 —— 它们是两个维度的判据', () => {
        // ⚠️ 2026-10-06：判据从「手段牌」（塔罗，已删）换成「**手段**那一句」。
        //    这条断言的**用意没变**：两个维度的判据都必须常驻在主链的每一次 user ③ 里 ——
        //    少任何一句，对应那一维就只能靠模型自己猜。
        // ⚠️ `fixture()` 用的是 `initialLedger()`，**那上面欲望是空的**（还没开局）
        //    ⇒ 空 `means` / 空 `proposition` 时块里当然没有那两行（这是**正确**行为：
        //    `blocks.ts` 刻意跳过空行，免得写出「手段：」这种空标签）。
        //    ⇒ 这里必须**先给账本一句欲望**，否则量到的是"空账本不写空行"，不是"判据在不在"。
        const { l, ev } = fixture();
        l.desire.manifesto = '兄弟，请替我圆了这大侠梦！';
        l.desire.means = '协助一位风流的大侠在王都惩恶扬善';
        l.desire.proposition = '深刻改变朝堂的权力结构';
        const u = renderResolveUser(l, ev, HANDLING);
        t.ok(u.includes('手段'), '★ 手段那一句不许摘（摘了「正当的手段」就没判据）');
        t.ok(u.includes('协助一位风流的大侠在王都惩恶扬善'), '★ 手段的**正文**要真的在');
        t.ok(u.includes('目的'), '★ 目的那一句不许摘（摘了「欲向」就没判据）');
        t.ok(u.includes('深刻改变朝堂的权力结构'), '★ 目的的**正文**要真的在');
      });
    },
  },

  {
    // Phase 3 · 路径 ⑤（亲自 · 多轮「穿越」）的两份指令。
    // ⚠️ 多轮是全场唯一"同一个场景里反复调用"的地方 ⇒ 它的两份指令必须与 `结算` 分工清楚：
    //    **叙事** = 这一轮场景里发生了什么（中途轮 `scene_over=false`）；
    //    **收尾** = 场景到此为止（`scene_over=true` **硬写**）。
    //    两条对 `scene_over` 的取值**正好相反**，互为佐证 —— 谁被改错，另一条立刻对不上。
    name: 'prompt 装配 · 多轮「穿越」两份指令（Phase 3 · 《契约.md》§三 叙事 / 收尾）',
    register(t) {
      const cases: Array<{ who: string; text: string }> = [
        { who: '叙事', text: INSTRUCTION_NARRATE },
        { who: '收尾', text: INSTRUCTION_WRAP },
      ];

      t.test('★ 两份指令都只收**指令本身** —— user ③ 的块标题一个字都不许混进来（§0.1 拆法）', () => {
        for (const { who, text } of cases) {
          for (const block of [
            '【当前状态】',
            '【本周氛围】',
            '【此刻是】',
            '【场景背景】',
            '【本轮判定】',
            '【本场景已落账】',
            '【场景经过】',
            '【结束原因】',
          ]) {
            t.ok(!text.includes(block), `${who}指令里混进了 user 块 ${block}`);
          }
        }
      });

      t.test('★ `scene_over` 两份指令**取值相反** —— 中途轮可 false、收尾恒 true', () => {
        t.ok(!INSTRUCTION_NARRATE.includes('scene_over=true'), '叙事不许把 scene_over 钉死（中途轮要能 false）');
        t.ok(INSTRUCTION_NARRATE.includes('scene_over'), '叙事要列出 scene_over');
        t.ok(INSTRUCTION_WRAP.includes('scene_over=true'), '收尾必须硬写 scene_over=true（收尾的定义就是场景结束）');
      });

      t.test('★ 叙事是**每轮**的 —— 字段量级必须比结算窄（只到本轮的 delta）', () => {
        t.ok(INSTRUCTION_NARRATE.includes('推进场景一轮'), '任务名要写清是"一轮"');
        t.ok(INSTRUCTION_NARRATE.includes('只写这一轮新产生的'), 'delta 必须限定在"这一轮"');
        t.ok(INSTRUCTION_NARRATE.includes('前几轮写过的不要再写'), '要明说不要重复前几轮');
        t.ok(INSTRUCTION_NARRATE.includes('多数轮次应为空'), '要有"多数轮次为空"的量级提示');
        t.ok(INSTRUCTION_NARRATE.includes('没实质推进'), '要允许"没什么进展"，否则模型会硬塞进展');
      });

      // ⚠️ 2026-10-07 用户裁定：职责句**末轮分岔** ——
      //   普通轮"暗示轮到玩家行动"（轮流感）；末轮"暗示告一段落"（为"轮数用尽"收场铺垫）。
      t.test('★ 职责句末轮分岔 —— 普通轮递话给玩家、末轮递话给收场', () => {
        const mid = narrateInstruction(1);
        const last = narrateInstruction(SCENE_ROUND_CAP);
        t.ok(mid.includes('并且文字最后要暗示接下来轮到玩家行动'), '普通轮要暗示"轮到玩家行动"');
        t.ok(mid.includes('合理的文字回应'), '两轮共用"对玩家的输入给出合理的文字回应"');
        t.ok(
          last.includes('并且暗示这件事因为处理时间不够只能告一段落'),
          '末轮要暗示"处理时间不够只能告一段落"',
        );
        t.ok(!last.includes('轮到玩家行动'), '末轮不该再让玩家接着行动（要收了）');
        t.ok(!mid.includes('告一段落'), '普通轮不许提前泄收场的底');
        // 除职责句外**逐字一致** —— 分岔只在这一句上
        t.eq(
          mid.replace('并且文字最后要暗示接下来轮到玩家行动', 'X'),
          last.replace('并且暗示这件事因为处理时间不够只能告一段落', 'X'),
          '两份指令除职责句外必须逐字相同（别处漂移说明改错了地方）',
        );
      });

      t.test('★ 收尾的核心是 `summary` **覆盖逐轮记录** ⇒ 必须"能独立读"', () => {
        t.ok(INSTRUCTION_WRAP.includes('覆盖本场景的逐轮记录'), '要说清 summary 会覆盖逐轮记录');
        t.ok(INSTRUCTION_WRAP.includes('独立读'), '要要求 summary 能独立读（逐轮细节随后就被替换）');
        t.ok(INSTRUCTION_WRAP.includes('整场努力'), '欲向取整场，不是某一轮的得失');
        t.ok(INSTRUCTION_WRAP.includes('尚未落账'), 'delta 只写尚未落账的部分（中途轮写过的别重复）');
      });

      t.test('★ 金币上限 `<P>` 与【结算】同口径 —— 多轮不能绕开托管上限', () => {
        for (const { who, text } of cases) {
          t.ok(text.includes('最多花掉 <P>'), `${who}指令漏了金币上限 <P>`);
          t.ok(text.includes('意外损失'), `${who}指令要说明意外损失也算在 <P> 里`);
        }
      });

      t.test('★ `INSTRUCTIONS` 注册齐全（**9 份**），多轮两份与三条侧链的那份都在', () => {
        // ⚠️ 2026-10-05：11 → 10 ——「改写命题」那条随 `rewrite_desire` 侧链整条删掉
        //    （用户裁定：欲望命题一生只写一次，不再有第二次）。
        // ⚠️⚠️ 2026-10-06：10 → **9** ——「开局」那条随 `opening` 侧链整条删掉
        //    （用户裁定：序幕彻底不问模型，玩家那句固定描述硬编码在 `Person.desc`）。
        t.deep(
          Object.keys(INSTRUCTIONS).sort(),
          ['创建事件', '占卜', '归并', '叙事', '结局', '收尾', '生成', '结算', '裁定'].sort(),
        );
        t.eq(INSTRUCTIONS['叙事'], INSTRUCTION_NARRATE);
        t.eq(INSTRUCTIONS['收尾'], INSTRUCTION_WRAP);
        t.eq(INSTRUCTIONS['占卜'], INSTRUCTION_DIVINATION);
        t.eq(INSTRUCTIONS['归并'], INSTRUCTION_ARCHIVE);
        t.eq(INSTRUCTIONS['结局'], INSTRUCTION_ENDING);
      });

      t.test('★【此刻是】的轮次上限取自 `SCENE_ROUND_CAP` —— 不写死数字（状态机截断读同一份）', () => {
        t.eq(SCENE_ROUND_CAP, 10, '2026-10-08 用户裁定：实测 7 轮太少，改 10');
        const { ev } = fixture();
        t.ok(sceneNowBlock(ev, 3).includes(`第 3 轮（上限 ${SCENE_ROUND_CAP}）`), '上限必须来自常量，不许字面量');

        // ⚠️ 上面两条**合起来才**构成防线：单看"渲染值 == 常量值"是抓不到字面量的
        //    （两边写同一个数时照样绿）。所以再加一条**读源码**的守卫 —— 这是唯一能证明
        //    "没有第二份数字"的办法（与《规则.md》那条"两处各写一个数"的纪律对应）。
        const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'prompt', 'blocks.ts'), 'utf8');
        t.ok(!/上限\s*\d/.test(src), 'blocks.ts 里出现写死的轮次上限 —— 必须走 SCENE_ROUND_CAP');
      });

      t.test('★ 场景不掷骰（2026-10-07 用户裁定）：【本轮判定】与 `sceneRollBlock` 已整条退休', () => {
        // 读源码守卫：blocks.ts 里不许再有任何掷骰回填的痕迹 —— 谁把它加回来，这里拦住。
        const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'prompt', 'blocks.ts'), 'utf8');
        t.ok(!src.includes('sceneRollBlock'), 'blocks.ts 里还有 `sceneRollBlock` —— 掷骰回填应随两段式一起删净');
        t.ok(!src.includes('【本轮判定】'), 'blocks.ts 里还有【本轮判定】');
        // 每轮只有一次叙事调用 ⇒ user ③ 的末行**不再分岔**，恒指向【叙事】。
        const { l, ev } = fixture();
        const u = renderNarrateUser(l, ev, HANDLING, 2, ['npc002'], { landed: [] });
        t.ok(u.includes('按【叙事】指令推进这一轮。'), '末行恒指向叙事（没有"裁定"那条走法了）');
        t.ok(!u.includes('按【裁定】指令'), '不许再出现指向裁定的末行');
      });

      t.test('★【本场景已落账】空态写「无」，且**托管投入 P 不进清单**（同 `landedBlock` 那条坑）', () => {
        t.eq(sceneLandedBlock([]), '【本场景已落账】无');
        const s = sceneLandedBlock(['文书(npc002) 本日行动力 −2']);
        t.ok(s.startsWith('【本场景已落账】'));
        t.ok(!s.includes('投入金币'), 'P 是上限不是已花的钱 —— 写进去会得到"全额退款"式 bug');
      });

      t.test('★【场景经过】空态有哨兵、有轮次时逐条编号', () => {
        t.ok(sceneTrailBlock([]).includes('尚未产生'), '空态要有哨兵，不能留空标题');
        const s = sceneTrailBlock(['玩家要求核账', '玩家改口要见人']);
        t.ok(s.includes('1. 玩家要求核账') && s.includes('2. 玩家改口要见人'), '逐轮要编号');
      });

      t.test('★ 叙事 user ③ 块序：【此刻是】【场景背景】收进场景，末行恒指向【叙事】（不掷骰 ⇒ 不分岔）', () => {
        const { l, ev } = fixture();
        const u = renderNarrateUser(l, ev, HANDLING, 2, ['npc002'], { landed: ['文书(npc002) 本日行动力 −2'] });
        t.ok(at(u, '【事件卡】') < at(u, '【此刻是】'), '事件卡在前、【此刻是】在后');
        t.ok(at(u, '【此刻是】') < at(u, '【场景背景】'), '先交代第几轮、再交代取景框');
        t.ok(at(u, '【场景背景】') < at(u, '【玩家的处理】'), '取景框在处理方案之前');
        t.ok(u.includes(`第 2 轮（上限 ${SCENE_ROUND_CAP}）`));
        t.ok(u.includes('【本场景已落账】文书(npc002) 本日行动力 −2'));
        t.ok(u.includes('按【叙事】指令推进这一轮。'), '每轮只有这一次调用 ⇒ 末行恒指向叙事');
      });

      t.test('★ 收尾 user ③：**没有**【玩家的处理】【处理者能力】—— 要交代的是整场经过与结束原因', () => {
        const { l, ev } = fixture();
        const u = renderWrapUser(l, ev, '轮数用尽', {
          turns: ['玩家要求核账'],
          landed: ['文书(npc002) 本日行动力 −2'],
        });
        t.ok(!u.includes('【玩家的处理】'), '收尾不再出现处理方案块');
        t.ok(!u.includes('【处理者能力】'), '收尾没有参与者 ⇒ 该块整段不存在');
        t.ok(u.includes('【结束原因】轮数用尽'));
        t.ok(at(u, '【场景经过】') < at(u, '【结束原因】'), '先摊开经过、再给结束原因');
        t.ok(u.includes('按【收尾】指令输出收尾结算。'));
      });

      t.test('★ 结束原因是**封闭枚举**（三种）—— 状态机不许自造第四种', () => {
        t.deep([...SCENE_END_REASONS], ['玩家主动退出', '轮数用尽', '已自然收束']);
      });

      t.test('★ `assembleNarrate` / `assembleWrap`：system = 静态头 ＋ 各自指令，两份指令不许互串', () => {
        const { l, ev } = fixture();
        const n = assembleNarrate(l, ev, HANDLING, 1, ['npc002']);
        t.eq(n.system, renderStaticHead(l) + '\n\n' + INSTRUCTION_NARRATE);
        t.eq(n.instruction, '叙事');

        const w = assembleWrap(l, ev, '玩家主动退出');
        t.eq(w.system, renderStaticHead(l) + '\n\n' + INSTRUCTION_WRAP);
        t.eq(w.instruction, '收尾');

        t.ok(n.system.startsWith(renderStaticHead(l)), '两次都以完整静态头开头 ⇒ 段①共享');
        t.ok(!n.system.includes(INSTRUCTION_WRAP) && !w.system.includes(INSTRUCTION_NARRATE), '指令不许互相串');
      });

      t.test('★ 防剧透对**多轮**同样生效 —— 中途轮的 user 里不许出现 pending 的叙事', () => {
        const { l, ev } = fixture();
        l.pending.push({
          eventId: 'e1',
          tier: '成功',
          narration: '掌柜把那张单子推到他面前，半个印的断口很新。',
          delta: { ops: [] },
          summary: '',
          next_seeds: [],
          欲向: '无关',
        });
        const clean = renderNarrateUser(l, ev, HANDLING, 1, []);
        assertNoSpoiler(clean, l); // 没泄露 ⇒ 不抛
        t.throws(() => assertNoSpoiler(clean + '\n' + l.pending[0].narration, l), '防剧透底线被破');
      });
    },
  },
];
