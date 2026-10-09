import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Suite } from './harness.ts';

export const suites: Suite[] = [{
  name: 'Windows launcher provider preflight (offline)',
  register(t) {
    if (process.platform !== 'win32') return;
    t.test('SoCLaaS-only and DeepSeek configs pass; invalid and missing configs stop before launch', () => {
      const fixture = mkdtempSync(path.join(tmpdir(), 'kingdom-launcher-'));
      try {
        const llmDir = path.join(fixture, 'game', 'src', 'llm');
        mkdirSync(llmDir, { recursive: true });
        for (const file of ['config.ts', 'check-config.ts']) {
          copyFileSync(new URL('../llm/' + file, import.meta.url), path.join(llmDir, file));
        }
        const launcher = readFileSync(new URL('../../../启动游戏.vbs', import.meta.url), 'utf8');
        // Exercise the real preflight. Stop before process termination, server startup, or browser opening.
        const preflight = launcher.split("' ---- step 1: kill any previous game server ----")[0]
          .replace('  sh.Popup msg, 0, title, icon', '  WScript.Echo title & ": " & msg')
          .replace('node = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\\nodejs\\node.exe"',
            'node = "' + process.execPath.replaceAll('"', '""') + '"');
        const script = path.join(fixture, 'preflight.vbs');
        writeFileSync(script, preflight + '\r\nWScript.Echo "PREFLIGHT_OK"\r\n');
        const envPath = path.join(fixture, 'game', '.env');
        const cases = [
          { env: 'LLM_PROVIDER=soclaas\nSOCLAAS_API_KEY="test-key" # comment\nSOCLAAS_MODEL=x-test-1', ok: true },
          { env: 'SOCLAAS_API_KEY=test-key\nDEEPSEEK_API_KEY=sk-replace-me', ok: true },
          { env: 'DEEPSEEK_API_KEY=test-key', ok: true },
          { env: 'LLM_PROVIDER=soclaas\nDEEPSEEK_API_KEY=test-key', ok: false },
          { env: 'LLM_PROVIDER=deepseek\nSOCLAAS_API_KEY=test-key', ok: false },
          { env: 'LLM_PROVIDER=soclaas\nSOCLAAS_API_KEY=your-soclaas-api-key', ok: false },
          { env: 'LLM_PROVIDER=invalid\nDEEPSEEK_API_KEY=test-key', ok: false },
          { env: null, ok: false },
        ];
        for (const testCase of cases) {
          if (testCase.env === null) rmSync(envPath, { force: true });
          else writeFileSync(envPath, testCase.env);
          const result = spawnSync('cscript.exe', ['//NoLogo', script],
            { encoding: 'utf8', windowsHide: true, timeout: 5000 });
          if (result.error) throw result.error;
          t.eq(result.status, 0, result.stderr);
          t.eq(result.stdout.includes('PREFLIGHT_OK'), testCase.ok, result.stdout);
          if (!testCase.ok) t.ok(result.stdout.includes(testCase.env === null ? 'Missing game' : 'API key not set'));
        }
      } finally { rmSync(fixture, { recursive: true, force: true }); }
    });
  },
}];
