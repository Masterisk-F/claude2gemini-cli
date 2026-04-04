# Tests

This directory contains the test suite for the `claude2gemini-cli` project. We use [Vitest](https://vitest.dev/) as our primary testing framework.

## How to Run Tests

Execute the following commands from the project root:

```bash
# Run all tests
npm run test

# Start Vitest in watch mode (recommended for development)
npx vitest

# Run a specific test file
npx vitest run tests/child-worker.test.ts

# Run tests and generate coverage report
npx vitest run --coverage
```

## Directory Structure and Conventions

Test files should be placed in the `tests/` directory, reflecting the structure of the source code.

- **`tests/*.test.ts`**: Integration tests for core components (child process management, IPC communication) or tests for modules near the root directory.
  - e.g., `child-worker.test.ts` (Spawning and communicating with child workers)
  - e.g., `ipc-protocol.test.ts` (Serialization/deserialization of IPC messages)
  - e.g., `process-isolation.test.ts` (Process isolation when using multiple accounts)
- **`tests/server/converters/*.test.ts`**: Unit tests for request/response transformation logic located in `server/converters/`.
- **`tests/server/routes/*.test.ts`**: API integration tests for Express routers using `supertest`.

## Guidelines for Adding Tests

1. **Naming and Placement**:
   New tests should end with `.test.ts` and be placed in a corresponding subdirectory within `tests/` that mirrors the source file's location.
2. **ESM / TypeScript Environment**:
   This project uses ESM (`type: "module"`). When importing local files, remember to include the `.js` extension (e.g., `import { example } from '../server/example.js';`).
3. **Vitest API**:
   Import `describe`, `it` (or `test`), `expect`, and `vi` from `vitest` to write your tests.
   ```typescript
   import { describe, it, expect } from 'vitest';

   describe('example feature', () => {
     it('should work correctly', () => {
       expect(1 + 1).toBe(2);
     });
   });
   ```
4. **Mocking and Asynchrony**:
   - Use `vi.mock()` to isolate your tests from side effects like network requests or child process spawning.
   - For tests involving process startup or IPC communication, you may need to increase the default timeout (5s). Provide a timeout in milliseconds as the third argument to `it` (e.g., `it('...', async () => { ... }, 20000)`).
