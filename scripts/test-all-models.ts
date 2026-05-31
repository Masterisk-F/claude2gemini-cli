import { AntigravityClient } from 'antigravity-client';
import { mapModelName } from '../server/converters/request.js';
import * as os from 'os';
import * as path from 'path';
import { mkdir, rm } from 'fs/promises';

const ALIASES_TO_TEST = [
  'claude-opus',
  'claude-sonnet',
  'claude-haiku',
  'gemini-pro',
  'gemini-flash',
  'gemini-flash-lite',
  'pro',
  'flash',
  'flash-lite',
];

async function main() {
  const workspaceDir = path.join(os.tmpdir(), `claude2gemini_test_all_${Date.now()}`);
  await mkdir(workspaceDir, { recursive: true });

  console.log('🚀 Launching AntigravityClient for integration testing...');
  const client = await AntigravityClient.launch({
    workspacePath: workspaceDir,
    verbose: false,
  });

  try {
    console.log('📡 Fetching available models...');
    const availableModels = await client.getAvailableModels();
    const availableKeys = Object.keys(availableModels);
    console.log(`✅ Available models in LS: ${availableKeys.join(', ')}`);

    console.log('\n--- Starting Model Integration Tests ---');

    // 1. Test Aliases
    for (const alias of ALIASES_TO_TEST) {
      const mapped = mapModelName(alias);
      process.stdout.write(`Testing alias [${alias}] -> [${mapped}]... `);

      try {
        if (!availableKeys.includes(mapped)) {
          console.log(`⚠️  SKIPPED (Not available in this LS instance)`);
          continue;
        }

        const cascade = await client.startCascade();
        // Send a simple message to verify it "returns normally"
        await (client as any).lsClient.sendUserCascadeMessage({
          cascadeId: cascade.cascadeId,
          items: [{ chunk: { case: 'text', value: 'Hi' } }],
          cascadeConfig: {
            plannerConfig: {
              requestedModel: { choice: { case: 'model', value: await client.resolveModelId(mapped) } }
            }
          }
        });

        // Wait for response
        await cascade.waitForTurnComplete({ timeoutMs: 45000 });

        // Extract text response robustly
        const steps = cascade.state?.trajectory?.steps ?? [];
        const responseText = steps
          .filter((s: any) => s?.step?.case === 'plannerResponse')
          .map((s: any) => s.step.value.response || s.step.value.modifiedResponse || '')
          .join('')
          .trim();

        if (responseText) {
          console.log(`✅ OK (Response: "${responseText.substring(0, 50).replace(/\n/g, ' ')}...")`);
        } else {
          const lastCase = steps[steps.length - 1]?.step?.case;
          console.log(`❌ FAILED (Empty response, last step case: ${lastCase})`);
        }
        await cascade.dispose();
      } catch (err) {
        console.log(`❌ FAILED: ${(err as Error).message}`);
      }
    }

    // 2. Test Formal Names directly from LS
    console.log('\n--- Testing Formal Model Names from LS ---');
    for (const key of availableKeys) {
      process.stdout.write(`Testing formal name [${key}]... `);
      try {
        const cascade = await client.startCascade();
        await (client as any).lsClient.sendUserCascadeMessage({
          cascadeId: cascade.cascadeId,
          items: [{ chunk: { case: 'text', value: 'Hi' } }],
          cascadeConfig: {
            plannerConfig: {
              requestedModel: { choice: { case: 'model', value: await client.resolveModelId(key) } }
            }
          }
        });

        await cascade.waitForTurnComplete({ timeoutMs: 45000 });

        // Extract text response robustly
        const steps = cascade.state?.trajectory?.steps ?? [];
        const responseText = steps
          .filter((s: any) => s?.step?.case === 'plannerResponse')
          .map((s: any) => s.step.value.response || s.step.value.modifiedResponse || '')
          .join('')
          .trim();

        if (responseText) {
          console.log(`✅ OK (Response: "${responseText.substring(0, 50).replace(/\n/g, ' ')}...")`);
        } else {
          console.log(`❌ FAILED (Empty response)`);
          if (steps.length > 0) {
            console.log('   Steps produced:');
            steps.forEach((s: any, i: number) => {
              console.log(`   - Step [${i}]: ${s?.step?.case} (status: ${s?.status})`);
            });
          }
        }
        await cascade.dispose();
      } catch (err) {
        console.log(`❌ FAILED: ${(err as Error).message}`);
      }
    }

  } finally {
    console.log('\n🧹 Cleaning up...');
    client.dispose();
    if (client.launcher) {
      await client.launcher.stop();
    }
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

main().catch(console.error);
