import { AsyncLocalStorage } from 'node:async_hooks';

export interface AppContext {
  cliHome?: string;
  accountId?: string;
}

export const contextStorage = new AsyncLocalStorage<AppContext>();

let processEnvPatched = false;

/**
 * process.env.GEMINI_CLI_HOME をフックし、
 * 現在の AsyncLocalStorage コンテキストに値があればそれを返すようにする。
 * アプリケーションの起動時に1回だけ呼び出す。
 */
export function setupEnvContextHook() {
  if (processEnvPatched) return;

  const originalEnv = global.process.env;
  
  const envProxy = new Proxy(originalEnv, {
    get(target, prop, receiver) {
      if (prop === 'GEMINI_CLI_HOME') {
        const store = contextStorage.getStore();
        if (store && store.cliHome) {
          return store.cliHome;
        }
        return target['__ORIGINAL_GEMINI_CLI_HOME'];
      }
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver) {
      if (prop === 'GEMINI_CLI_HOME') {
         target['__ORIGINAL_GEMINI_CLI_HOME'] = value;
         return true;
      }
      return Reflect.set(target, prop, value, receiver);
    }
  });

  Object.defineProperty(global.process, 'env', {
    get() { return envProxy; },
    configurable: true
  });

  processEnvPatched = true;
}
