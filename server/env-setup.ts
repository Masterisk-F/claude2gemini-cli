import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * プロキシ用の隔離された環境を構築する。
 * 
 * - ~/.gemini の認証情報などを /tmp にシンボリックリンクする
 * - GEMINI.md や settings.json の環境固有設定を読み込ませないようにする
 * - process.env.HOME を一時ディレクトリに書き換える
 */
export function setupProxyEnv() {
  const username = os.userInfo().username;
  const proxyHome = path.join(os.tmpdir(), `claude2gemini-env-${username}`);
  const proxyGemini = path.join(proxyHome, '.gemini');

  if (!fs.existsSync(proxyGemini)) {
    fs.mkdirSync(proxyGemini, { recursive: true });
  }

  const realHome = os.homedir();
  const realGemini = path.join(realHome, '.gemini');

  // ~/.gemini ディレクトリが存在すれば、認証関連のファイルをシンボリックリンクする
  if (fs.existsSync(realGemini)) {
    const files = fs.readdirSync(realGemini);
    for (const file of files) {
      if (file === 'GEMINI.md' || file === 'settings.json') {
        continue;
      }

      const src = path.join(realGemini, file);
      const dest = path.join(proxyGemini, file);

      if (!fs.existsSync(dest)) {
        try {
          const stat = fs.statSync(src);
          // Windows などでの互換性のため symlinkType を指定するなら 'dir' / 'file' を切り替える
          const type = stat.isDirectory() ? 'dir' : 'file';
          fs.symlinkSync(src, dest, type);
        } catch (error) {
          console.warn(`[Proxy Env] Failed to symlink ${file}:`, error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  // 組み込みツールとスキルの無効化を補助するため、ダミーの settings.json を配置する
  const configDest = path.join(proxyGemini, 'settings.json');
  if (!fs.existsSync(configDest)) {
    try {
      const settings = {
        tools: {
          core: [],
        },
        skills: {
          enabled: false,
        },
        experimental: {
          enableAgents: false,
        },
      };
      fs.writeFileSync(configDest, JSON.stringify(settings, null, 2));
    } catch (error) {
      console.warn(`[Proxy Env] Failed to write settings.json:`, error);
    }
  }

  // gemini-cli 固有のシステムプロンプトが LLM に渡らないように各セクションを無効化する
  const disabledPromptSections = [
    'agentSkills',
    'agentContexts',
    'primaryWorkflows',
    'planningWorkflow',
    'operationalGuidelines',
    'preamble',
    'coreMandates',
    'sandbox',
    'git',
    'finalReminder',
    'hookContext',
  ];

  for (const section of disabledPromptSections) {
    const envKey = `GEMINI_PROMPT_${section.toUpperCase()}`;
    process.env[envKey] = '0';
  }

  console.log(`[Proxy] Overriding HOME to virtual directory: ${proxyHome}`);
  process.env.HOME = proxyHome;
}
