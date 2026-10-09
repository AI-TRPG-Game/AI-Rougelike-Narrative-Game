import { configFromEnv, parseEnv } from '../llm/config.ts';
import { buildChatBody } from '../llm/request.ts';
import { buildComposeRequest, buildEndingRequest } from '../llm/brain-llm.ts';
import { callTool, callToolStream } from '../llm/client.ts';
import { initialLedger } from '../ledger/initial.ts';
import { resolveTool, sceneTool } from '../schema/resolve.ts';
import type { Suite } from './harness.ts';

const cfg = configFromEnv({ LLM_PROVIDER: 'soclaas', SOCLAAS_API_KEY: 'test-key' });
const body = () => buildChatBody({ provider: cfg.provider, model: cfg.model,
  messages: [], tools: [sceneTool()], toolChoiceName: 'scene' });

export const suites: Suite[] = [{
  name: 'LLM provider configuration and transport',
  register(t) {
    t.test('legacy DeepSeek config retains endpoint and model; inline comments are stripped', () => {
      const legacy = configFromEnv(parseEnv('DEEPSEEK_API_KEY=test-key\nDEEPSEEK_MODEL=deepseek-flash # comment'));
      t.eq(legacy.provider, 'deepseek');
      t.eq(legacy.betaBaseUrl, 'https://api.deepseek.com/beta');
      t.eq(legacy.model, 'deepseek-flash');
      t.deep(buildChatBody({ model: legacy.model, messages: [], tools: [], toolChoiceName: 'resolve' }).thinking,
        { type: 'disabled' });
    });
    t.test('SoCLaaS defaults and overrides; explicit provider keeps credentials separate', () => {
      t.eq(cfg.model, 'x-test-1');
      t.eq(cfg.betaBaseUrl, 'https://soclaas-api.comp.nus.edu.sg/v1');
      const custom = configFromEnv({ SOCLAAS_API_KEY: 'soc-key', DEEPSEEK_API_KEY: 'ds-key',
        SOCLAAS_MODEL: 'custom-id', SOCLAAS_BASE_URL: 'https://example.invalid/v1', SOCLAAS_REASONING_EFFORT: 'none' });
      t.eq(custom.apiKey, 'soc-key');
      t.eq(custom.model, 'custom-id');
      t.eq(custom.betaBaseUrl, 'https://example.invalid/v1');
      t.eq(configFromEnv({ LLM_PROVIDER: 'deepseek', SOCLAAS_API_KEY: 'soc-key', DEEPSEEK_API_KEY: 'ds-key' }).apiKey, 'ds-key');
      t.throws(() => configFromEnv({ LLM_PROVIDER: 'soclaas', DEEPSEEK_API_KEY: 'ds-key' }), 'SOCLAAS_API_KEY');
      t.throws(() => configFromEnv({ LLM_PROVIDER: 'invalid' }), 'LLM_PROVIDER');
      t.throws(() => configFromEnv({ SOCLAAS_API_KEY: 'your-soclaas-api-key' }), 'SOCLAAS_API_KEY');
      t.throws(() => configFromEnv({ SOCLAAS_API_KEY: 'test-key', SOCLAAS_REASONING_EFFORT: 'invalid' }), 'SOCLAAS_REASONING_EFFORT');
    });
    t.test('SoCLaaS schema uses standard refs, omits strict and thinking, and preserves source schemas', () => {
      const source = resolveTool();
      const original = JSON.stringify(source);
      const request = buildChatBody({ provider: 'soclaas', model: cfg.model, messages: [],
        tools: [source], toolChoiceName: 'resolve', reasoningEffort: 'none' });
      const tool = (request.tools as any[])[0].function;
      t.eq('strict' in tool, false);
      t.eq('thinking' in request, false);
      t.eq(request.reasoning_effort, 'none');
      t.eq('reasoning_effort' in body(), false);
      t.ok('$defs' in tool.parameters);
      t.eq('$def' in tool.parameters, false);
      t.eq(JSON.stringify(tool).includes('#/$def/'), false);
      t.ok(JSON.stringify(tool).includes('#/$defs/'));
      t.eq(JSON.stringify(source), original);
      t.deep(request.tool_choice, { type: 'function', function: { name: 'resolve' } });
    });
    t.test('game request builders carry provider through generation and ending', () => {
      const endingLedger = initialLedger();
      endingLedger.ending = { name: '皆如你所愿', title: null, kind: '成功', flavor: 'A',
        row: 8, day: 28, reason: '', text: null, placements: { 成果: null, 手段: null, 共鸣: null } };
      for (const request of [buildComposeRequest(cfg, initialLedger()), buildEndingRequest(cfg, endingLedger)]) {
        t.eq(request.body.model, cfg.model);
        t.eq('thinking' in request.body, false);
        t.eq('strict' in (request.body.tools as any[])[0].function, false);
      }
    });
    t.test('normal and streamed tool calls reach SoCLaaS with bearer auth and parsed output', async () => {
      const originalFetch = globalThis.fetch;
      const requests: Array<{ url: string; body: any; authorization: string }> = [];
      const args = { narration: '欢迎来到王国。', scene_over: false };
      globalThis.fetch = async (url, options) => {
        const sent = JSON.parse(options!.body as string);
        requests.push({ url: String(url), body: sent,
          authorization: (options!.headers as Record<string, string>).Authorization });
        if (!sent.stream) return new Response(JSON.stringify({ choices: [{
          message: { tool_calls: [{ id: 'call_test', type: 'function',
            function: { name: 'scene', arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls',
        }] }), { status: 200 });
        const serialized = JSON.stringify(args);
        const chunks = [
          { choices: [{ delta: { tool_calls: [{ id: 'call_test', function: { name: 'scene', arguments: serialized.slice(0, 20) } }] } }] },
          { choices: [{ delta: { tool_calls: [{ function: { arguments: serialized.slice(20) } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ];
        return new Response(chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      };
      try {
        const result = await callTool(cfg, body());
        let narration = '';
        const streamed = await callToolStream(cfg, body(), { onNarrDelta: (delta, reset) => {
          if (reset) narration = ''; else narration += delta;
        } });
        for (const output of [result, streamed]) {
          t.eq(output.ok, true);
          t.eq(output.attempts, 1);
          t.eq(output.toolName, 'scene');
          t.deep(output.args, args);
        }
        t.eq(narration, args.narration);
        t.eq(requests.length, 2);
        for (const sent of requests) {
          t.eq(sent.url, 'https://soclaas-api.comp.nus.edu.sg/v1/chat/completions');
          t.eq(sent.authorization, 'Bearer test-key');
          t.eq('thinking' in sent.body, false);
          t.eq('strict' in sent.body.tools[0].function, false);
        }
        t.eq(requests[0].body.stream, false);
        t.eq(requests[1].body.stream, true);
      } finally { globalThis.fetch = originalFetch; }
    });
  },
}];
