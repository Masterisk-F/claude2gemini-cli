import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * 指定されたIDに基づいた仮想HOMEディレクトリを構築する
 * @param proxyHomeId アカウントIDなどの識別子
 * @param credentials oauth_creds.json に書き出す内容（オプション）
 */
export function buildProxyHome(proxyHomeId: string, credentials?: any): string {
  const username = os.userInfo().username;
  const proxyHome = path.join(os.tmpdir(), `claude2gemini-env-${username}-${proxyHomeId}`);
  const proxyGemini = path.join(proxyHome, '.gemini');

  if (!fs.existsSync(proxyGemini)) {
    fs.mkdirSync(proxyGemini, { recursive: true });
  }

  // 1. 認証情報のセットアップ
  const oauthPath = path.join(proxyGemini, 'oauth_creds.json');
  if (credentials) {
    // 明示的な認証情報がある場合はファイルとして書き出す
    fs.writeFileSync(oauthPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  } else {
    // 認証情報がない場合は、本来の ~/.gemini から必要なファイルをシンボリックリンクする（後方互換用）
    const realHome = os.homedir();
    const realGemini = path.join(realHome, '.gemini');

    if (fs.existsSync(realGemini)) {
      const files = fs.readdirSync(realGemini);
      for (const file of files) {
        // 個別の設定ファイルはシンボリックリンクせず、プロキシ側で用意する
        if (file === 'GEMINI.md' || file === 'settings.json' || file === 'system.md') {
          continue;
        }

        const src = path.join(realGemini, file);
        const dest = path.join(proxyGemini, file);

        if (!fs.existsSync(dest)) {
          try {
            const stat = fs.statSync(src);
            const type = stat.isDirectory() ? 'dir' : 'file';
            fs.symlinkSync(src, dest, type);
          } catch (error) {
            console.warn(`[Proxy Env] Failed to symlink ${file}:`, error instanceof Error ? error.message : String(error));
          }
        }
      }
    }
  }

  // 2. 共通設定の配置 (settings.json)
  const configDest = path.join(proxyGemini, 'settings.json');
  if (!fs.existsSync(configDest)) {
    try {
      const settings = {
        tools: { core: [] },
        skills: { enabled: false },
        experimental: { enableAgents: false },
        security: { auth: { selectedType: 'oauth-personal' } }
      };
      fs.writeFileSync(configDest, JSON.stringify(settings, null, 2));
    } catch (error) {
      console.warn(`[Proxy Env] Failed to write settings.json:`, error);
    }
  }

  // 3. システムプロンプトの無効化 (system.md)
  const systemMdPath = path.join(proxyGemini, 'system.md');
  if (!fs.existsSync(systemMdPath)) {
    try {
      fs.writeFileSync(systemMdPath, '');
    } catch (error) {
      console.warn(`[Proxy Env] Failed to create system.md:`, error);
    }
  }

  return proxyHome;
}

/**
 * プロキシ用の隔離された環境を構築し、現在のプロセスに適用する（互換性用）
 */
export function setupProxyEnv() {
  const proxyHome = buildProxyHome('default');
  
  // gemini-cli がシステムプロンプトとしてこの空ファイルを強制使用するように設定
  process.env.GEMINI_SYSTEM_MD = path.join(proxyHome, '.gemini', 'system.md');

  console.log(`[Proxy] Setting GEMINI_CLI_HOME to virtual directory: ${proxyHome}`);
  process.env['GEMINI_CLI_HOME'] = proxyHome;
}
