import { test, expect } from 'vitest';
import { childManager } from '../server/child-manager.js';

test('Process Isolation: ChildManager can spawn multiple isolated workers concurrently', async () => {
    // 複数アカウントでの同時起動をテスト
    const accounts = ['test-isolation-A', 'test-isolation-B'];

    await childManager.spawnAll(accounts);

    // マネージャーの内部状態に両方のプロセスが登録されていることを確認
    const childrenMap = (childManager as any).children as Map<string, any>;

    expect(childrenMap.has('test-isolation-A')).toBe(true);
    expect(childrenMap.has('test-isolation-B')).toBe(true);

    const connectionA = childrenMap.get('test-isolation-A');
    const connectionB = childrenMap.get('test-isolation-B');

    // それぞれ別のプロセスIDを持っていることを検証（プロセスが分離されている証明）
    expect(connectionA.process.pid).not.toBe(connectionB.process.pid);

    // クリーンアップ
    childManager.killAll();

    expect(childrenMap.size).toBe(0);
}, 20000); // Set timeout to 20s

