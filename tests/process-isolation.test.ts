import test from 'node:test';
import assert from 'node:assert';
import { childManager } from '../server/child-manager.js';

test('Process Isolation: ChildManager can spawn multiple isolated workers concurrently', async () => {
    // 複数アカウントでの同時起動をテスト
    const accounts = ['test-isolation-A', 'test-isolation-B'];

    await childManager.spawnAll(accounts);

    // マネージャーの内部状態に両方のプロセスが登録されていることを確認
    const childrenMap = (childManager as any).children as Map<string, any>;

    assert.strictEqual(childrenMap.has('test-isolation-A'), true, 'Account A should be running');
    assert.strictEqual(childrenMap.has('test-isolation-B'), true, 'Account B should be running');

    const connectionA = childrenMap.get('test-isolation-A');
    const connectionB = childrenMap.get('test-isolation-B');

    // それぞれ別のプロセスIDを持っていることを検証（プロセスが分離されている証明）
    assert.notStrictEqual(
        connectionA.process.pid,
        connectionB.process.pid,
        'Child processes must have different strict PIDs'
    );

    // クリーンアップ
    childManager.killAll();

    assert.strictEqual(childrenMap.size, 0, 'Children map should be empty after killAll');
});
