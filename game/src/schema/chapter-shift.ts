// `chapter_shift` 的 tools 定义
//
// ⚠️ 它**平时不挂 `tools`** —— 只在占卜日（第 1 / 8 / 15 / 22 天）日初挂上、用完即卸
//    。
//
// ⚠️ 无 `$def` 依赖（§1.2 表里 `chapter_shift` 的 `$def` 列为「无」）—— 两个字段都内联。
// ⚠️ `minimum` / `maximum` 写在这里**只是给模型看的提示**：服务端对模型输出**完全不校验**
//    （Phase 0 §三 实测：`minimum` / `maximum` / `enum` 一概穿透）⇒ 钳制必须由
//    `rules/chapter-shift.ts·resolveDesireChange` 承担。**别把这两行当防线。**
import type { JsonSchema } from './defs.ts';
import { buildToolFunction } from './resolve.ts';

export const CHAPTER_SHIFT_DESCRIPTION =
  '章节起始日（第 1 / 8 / 15 / 22 天）的独立低频调用：根据系统抽好的 2 张塔罗（并列、含正逆位），① 判玩家欲望与本周牌面的相关性（折算欲念变化）；② 用占卜式文字写「本周王城欲望氛围」。';

const CHAPTER_SHIFT_PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    章节欲念变化: {
      type: 'integer',
      minimum: -20,
      maximum: 20,
      description:
        '玩家欲望与这两张牌（含正逆位）的相关性：越负越相悖、越正越相合、越接近 0 越无关。⚠️ 第 1 天（开局）不结算欲念 —— 必须填 0',
    },
    章节氛围: {
      type: 'string',
      description:
        '基于这两张塔罗牌的象征意义作占卜，表达一个西幻王城接下来可能发生的事、或笼罩王城的人们的欲望氛围。神秘主义风格，≤30 字；不可直接指定某个个体的行为，不出现显式人名地名。玩家可见',
    },
  },
  required: ['章节欲念变化', '章节氛围'],
  additionalProperties: false,
};

export function chapterShiftTool(): JsonSchema {
  return buildToolFunction('chapter_shift', {
    description: CHAPTER_SHIFT_DESCRIPTION,
    parameters: CHAPTER_SHIFT_PARAMETERS,
  });
}
