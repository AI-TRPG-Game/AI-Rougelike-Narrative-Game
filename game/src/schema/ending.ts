// `ending` 的 tools 定义
//
// ⚠️ 它**平时不挂 `tools`** —— 只在第 28 天放完格子、判出**成功结局**的那一刻挂上、
//    用完即卸。
//
// ⚠️ 无 `$def` 依赖（§1.2 表里 `ending` 的 `$def` 列为「无」）—— 字段内联。
// ⚠️ `minLength` / `maxLength` **不写**：写了也**只是给模型看的提示**，服务端对模型输出
//    **完全不校验**（Phase 0 §三：`minimum` / `maximum` / `enum` 一律穿透）
//    ⇒「话术 100~200 字」由 `turn/ending.ts·applyEnding` 承担。**别把 schema 当防线。**
// ⚠️ 长度**不写死**：来自 `rules/ending.ts`（唯一拷贝）—— 与 `archive` 的 `归档段 ≤300 字`
//    同一条纪律（同一个数两处各写一个，这个项目已经栽过：`deadline` 挡位 / `FREE_EVENT_CAP`）。
//
// ⚠️⚠️ **2026-10-06 用户裁定：只剩一个字段。**
//   `结局标题` **整个删掉** —— 标题改由**规则层**给（`rules/ending.ts·FLAVOR_NAMES`
//   的**两档**：得偿所愿 / 差一步美满），模型**碰不到**。
//   ⇒ 用户原话：「**LLM 只需要输出结局纯文本（100-200 字）**」。
//   ⚠️ 字段名从 `结局话术` 改成 **`结局判词`**（与用户的说法一致，也与 `FailureLine`
//     那套"判词"的叫法统一）；旧存档/旧回放里那个键**不再读**（那一路本来就不重跑）。
import type { JsonSchema } from './defs.ts';
import { buildToolFunction } from './resolve.ts';
import { ENDING_TEXT_MAX, ENDING_TEXT_MIN } from '../rules/ending.ts';

export const ENDING_DESCRIPTION =
  '终局叙事：回顾玩家的一局，为玩家写一段详尽的故事结尾与结局判词。' +
  '评价的核心标准是【你的欲望】块全文（含卡槽里那些凭证的描述）。只在【成功结局】时调用。';

const ENDING_PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    结局判词: {
      type: 'string',
      description:
        `回望式旁白，${ENDING_TEXT_MIN}~${ENDING_TEXT_MAX} 字。全知视点、站在 28 天之外回望；` +
        `只用输入里真实出现过的人与事，不写任何数值、不写日期与年龄。` +
        `**标题由系统给定，你不要写标题。**`,
    },
  },
  required: ['结局判词'],
  additionalProperties: false,
};

export function endingTool(): JsonSchema {
  return buildToolFunction('ending', {
    description: ENDING_DESCRIPTION,
    parameters: ENDING_PARAMETERS,
  });
}
