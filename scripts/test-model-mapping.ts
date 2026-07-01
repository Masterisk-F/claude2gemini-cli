import { AntigravityClient } from 'antigravity-client';
import { mapModelName } from '../server/converters/request.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';

const ALIASES_TO_TEST = [
  'claude-opus',
  'claude-sonnet',
  'claude-haiku',
  'gemini-pro',
  'gemini-pro-low',
  'gemini-flash',
  'gemini-flash-medium',
  'gemini-flash-lite',
  'pro',
  'flash',
  'flash-lite',
  'Gemini_3.1_Pro_High',
  'Claude_Opus_4.6_Thinking',
  'unknown-model'
];

async function main() {
  const workspaceDir = join(tmpdir(), `claude2gemini_test_${Date.now()}`);
  await mkdir(workspaceDir, { recursive: true });

  console.log('Launching AntigravityClient...');
  const client = await AntigravityClient.launch({
    workspacePath: workspaceDir,
    verbose: false,
  });

  try {
    console.log('LS launched. Waiting for models to be available...');
    const models = await client.getAvailableModels();
    console.log(`Available models count: ${Object.keys(models).length}`);

    let allPassed = true;
    for (const alias of ALIASES_TO_TEST) {
      const mapped = mapModelName(alias);
      try {
        const id = await client.resolveModelId(mapped);
        console.log(`✅ [${alias}] -> [${mapped}] -> ID: ${id}`);
      } catch (err) {
        console.error(`❌ [${alias}] -> [${mapped}] -> ERROR: ${(err as Error).message}`);
        allPassed = false;
      }
    }

    if (!allPassed) {
      process.exit(1);
    }
    console.log('All model mappings resolved successfully!');
  } finally {
    client.dispose();
    if (client.launcher) {
      await client.launcher.stop();
    }
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

main().catch(console.error);
