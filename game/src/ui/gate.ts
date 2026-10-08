// 服务端的**串行闸** —— 同一时刻只处理一个"会动东西的"请求。
//
// ⚠️ 为什么需要它：`ui/session.ts` 上每个动作都**跨 `await`**（`--live` 下一次 LLM 调用
//    几秒到几十秒）。那段时间里第二条请求的 `readBody` 会完成、一路走到 `route()` 里 ⇒
//    同一件事被做两遍：**两次模型调用（真钱）**，而且后一次的 `pending` 会把前一次的结果**覆盖**掉。
//    离线实测（`.workbuddy/probe-concurrent.py`）：两个并发的 `/api/arrange` **都返回 `ok`**，
//    两条 `notice` 的掷骰结果不同、`steps +2`，而账本里只落 **1** 条。
//    `ui/index.html` 里那颗 `setBusy`／`inflight`（单飞）**只是客户端礼仪** ——
//    两个标签页、脚本、`curl` 全绕得过去 ⇒ 约束必须落在服务端。
//
// ⚠️ **别照着错的解释改代码**（2026-09-20 当天订正过一次）：那道实测的病根**不是"交错"** ——
//    闸门那 9 条**没有一条**问过"这条事件现在还能不能排"（`rules/gates.ts` 只问时间 / 人 /
//    人数 / 金币 / 档 A…）⇒ **单发两次也会复现**（第二个标签页里那张陈旧卡片点一下就够了），
//    与并发无关。那一半由 `ui/session.ts·arrange` 的**状态守卫**兜住；
//    这道闸兜的是**另一个窗口**：第一条**还在跑**的时候。
//
// ⚠️ **这道闸离线量不到**：假 brain 全程是 microtask（`fixtures/fake.ts` 里没有 `setTimeout`）
//    ⇒ `route()` 不跨墙钟 ⇒ 两条并发的 HTTP 请求其实是**串行**执行的。
//    别把"离线跑不出 409"当成"闸没生效"—— 行为证据在 `test/server.test.ts`（真叠两条 async）。
//
// ⚠️ 选择「**拒绝**」而不是「排队」，三条理由：
//    · 排队仍会把第二次送到模型 ⇒ **白花钱**（而 `--live` 是真花钱）；
//    · 排队后第二次执行时账本已经变了 ⇒ 它带着**过期的假设**（例如"这个人还闲着"），
//      换回来的是一句玩家看不懂的闸门报错 —— 比直接说"上一个动作还没结束"更糟；
//    · 客户端本来就是单飞（第二个请求直接丢掉）⇒ **正常游玩下这道闸永远不会触发**，
//      它存在的全部意义就是"异常路径下不做错事"。
//
// ⚠️ 闸门挂在「**是不是 `POST /api/*`**」上，**不在"路由清单"上**：
//    POST 的每一条都会动会话 / 存档 / 当前槽，没有一条是只读的（只读那条是 `GET /api/view`）
//    ⇒ 不需要第二份清单，也就不会漂。将来新增一条路由，自动被拦，忘了登记只是话术难看。
//
// ⚠️ 本模块**零依赖、不碰 HTTP**：这样它能在单测里被真的跑一遍（`test/server.test.ts`）。

/** 玩家看得见的那句话要用**动词**，不是路径名 —— 两个标签页同时点的时候，那不是给开发者看的 */
const LABELS: Record<string, string> = {
  '/api/arrange': '排布',
  '/api/popup': '点选',
  // ⚠️ 2026-10-05 新增（用户裁定：欲望与六维都改成玩家自己选）——
  //    动词是「**定下他要什么**」而不是「选欲望」：它定的不是这一手，是**整局**。
  '/api/desire/pick': '定下他要什么',
  // ⚠️ 2026-10-08 新增（用户第 5 条）：觉醒后、第 1 天铺开前的难度选择 ——
  //    动词与前端话术（「正在记下你挑的世界…」）同一口径。
  '/api/difficulty': '挑世界',
  '/api/create': '自拟一件事',
  // ⚠️ 2026-10-06 新增：装填通路（`Session.give`，交出／收回一件东西）。
  //    动词用「**交给他**」—— 它就是"把东西放到某人身上"这一个动作，
  //    收回与转移都走它（服务端按 `to` 判是给谁还是收回自己）。
  '/api/give': '交给他',
  // ⚠️ 2026-10-07 新增：槽位排序（人物详情页四个物品卡槽拖动换位）——
  //    `effectiveItems` 已改纯槽位顺序，左右顺序就是生效优先级。
  '/api/items/order': '调整携带顺序',
  '/api/dial': '拨时针',
  '/api/nextday': '进下一天',
  // ⚠️ 2026-10-08 新增：序幕「直接正式开始游戏」（掐掉未读的、铺出末条「原初欲望的觉醒」）。
  '/api/prologue/skip': '直接正式开始游戏',
  '/api/scene/open': '进场景',
  '/api/scene/say': '场景里说话',
  // ⚠️ 2026-10-08：按钮文案改为「结束对话（收尾结算）」—— 操作名跟着改（同一件事）。
  '/api/scene/leave': '结束对话',
  '/api/restore': '医馆 / 大神殿',
  '/api/finish': '放格子',
  '/api/giveup': '直接结算',
  '/api/save/new': '开新的一局',
  '/api/save/load': '读档',
  '/api/save/put': '保存并退出',
  '/api/save/delete': '删档',
  '/api/title': '回标题屏',
  '/api/reset': '重开一局',
};

/** 表里没有的路由退回一句通用话术 —— **拦不拦看的是"是不是 POST /api"，不是这张表** */
export function labelOf(pathname: string): string {
  return LABELS[pathname] ?? '上一个动作';
}

/**
 * 一条请求的**占位**：`enter` 成功才准开工，干完必须 `leave`。
 *
 * ⚠️ `leave()` **必须写在 `finally` 里** —— 抛错时若不放闸，这一局就永远卡在"忙"上
 *    （比"并发"本身更难查：玩家看到的是"点什么都没反应"）。
 */
export class SerialGate {
  private working: string | null = null;

  /** 试着开工；已经有活在跑 ⇒ `false`（**不排队**，由调用侧回一句 409） */
  enter(label: string): boolean {
    if (this.working !== null) return false;
    this.working = label;
    return true;
  }

  /** 收工 */
  leave(): void {
    this.working = null;
  }

  /** 现在在跑什么（`null` = 空闲）—— 只给话术与排错用 */
  get busy(): string | null {
    return this.working;
  }
}

/**
 * 409 的响应体。
 *
 * ⚠️ 带一个 `busy: true` 标记，**且刻意不带 `screen`**：一份信封的必要字段是 `screen`
 *    （`ui/index.html` 的启动逻辑就靠它判断"拿到的到底是不是信封"）⇒ 少了它，
 *    任何"把它当信封用"的写法都会当场露馅，而不是把视图刷成空白。
 */
export function busyPayload(what: string): { ok: false; busy: true; error: string } {
  return {
    ok: false,
    busy: true,
    error: `上一个动作还没有结束（${what}）—— 等它出结果再操作：同时只允许一个动作`,
  };
}
