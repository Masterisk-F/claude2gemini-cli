import { describe, it, expect } from 'vitest';
import { childManager } from '../server/child-manager.js';

describe('Process Isolation', () => {
    it('ChildManager is defined', () => {
        expect(childManager).toBeDefined();
    });

    it('ChildManager can spawn multiple isolated workers concurrently', async () => {
        const accounts = ['test-isolation-A', 'test-isolation-B'];

        // Vitest環境での子プロセス起動を成功させるための一時的な環境設定
        const originalExecArgv = process.execArgv;
        const originalNodeOptions = process.env.NODE_OPTIONS;
        process.execArgv = ['--import', 'tsx'];
        delete process.env.NODE_OPTIONS;

        try {
            await childManager.spawnAll(accounts);
            const childrenMap = (childManager as any).children as Map<string, any>;
            expect(childrenMap.has('test-isolation-A')).toBe(true);
            expect(childrenMap.has('test-isolation-B')).toBe(true);

            const connectionA = childrenMap.get('test-isolation-A');
            const connectionB = childrenMap.get('test-isolation-B');
            expect(connectionA.process.pid).toBeDefined();
            expect(connectionB.process.pid).toBeDefined();
            expect(connectionA.process.pid).not.toBe(connectionB.process.pid);
        } finally {
            childManager.killAll();
            process.execArgv = originalExecArgv;
            if (originalNodeOptions !== undefined) {
                process.env.NODE_OPTIONS = originalNodeOptions;
            }
        }
    });
});
