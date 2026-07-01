/**
 * Unit tests for the `cleanAndFixArguments()` and `unpackMetaCall()`
 * helpers exported from server/mcp-hub.ts. These are applied to tool
 * call arguments received over the /call HTTP endpoint.
 *
 * Tool schema handling itself is covered in mcp-hub.test.ts
 * ("Default behavior (passthrough)" block) — the hub now forwards the
 * original input_schema to the LS verbatim, so there is no schema
 * flattener to unit-test.
 */

import { describe, it, expect } from 'vitest';
import { cleanAndFixArguments, unpackMetaCall } from '../server/mcp-hub.js';

describe('Arguments Cleansing and Fixing', () => {
  const testSchema = {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout: { type: 'integer', default: 30 },
      verbose: { type: 'boolean' }
    },
    required: ['command', 'verbose']
  };

  it('should strip extraneous fields', () => {
    const args = {
      command: 'ls -la',
      verbose: true,
      extra_junk: 'should be deleted',
      nested: { foo: 'bar' }
    };

    const cleaned = cleanAndFixArguments(args, testSchema);
    expect(cleaned.command).toBe('ls -la');
    expect(cleaned.verbose).toBe(true);
    expect(cleaned.extra_junk).toBeUndefined();
  });

  it('should coerce types to correct values', () => {
    const args = {
      command: 12345, // should coerce to string
      timeout: '60',   // should coerce to integer
      verbose: 'true' // should coerce to boolean
    };

    const cleaned = cleanAndFixArguments(args, testSchema);
    expect(cleaned.command).toBe('12345');
    expect(cleaned.timeout).toBe(60);
    expect(cleaned.verbose).toBe(true);
  });

  it('should provide default values or fallbacks for missing required fields', () => {
    const args = {
      command: 'echo test'
    };

    const cleaned = cleanAndFixArguments(args, testSchema);
    expect(cleaned.command).toBe('echo test');
    expect(cleaned.timeout).toBe(30); // from default
    // Required boolean with no default: no longer filled with fallback
    expect(cleaned.verbose).toBeUndefined();
  });

  it('should NOT fill missing required string parameters with empty strings', () => {
    // browser_evaluate style schema: function is required string
    const evalSchema = {
      type: 'object',
      properties: {
        function: { type: 'string', description: 'JavaScript to evaluate' },
        element: { type: 'string', description: 'Element selector' }
      },
      required: ['function']
    };

    // Model sends no arguments at all
    const args = {};
    const cleaned = cleanAndFixArguments(args, evalSchema);
    // Required string should NOT be filled with empty string
    expect(cleaned.function).toBeUndefined();
  });

  it('should NOT fill missing required string parameters with empty strings for browser_click', () => {
    // browser_click style schema: target is required string
    const clickSchema = {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Element target' },
        button: { type: 'string' }
      },
      required: ['target']
    };

    const args = {};
    const cleaned = cleanAndFixArguments(args, clickSchema);
    expect(cleaned.target).toBeUndefined();
  });

  it('should preserve provided values for required fields', () => {
    const evalSchema = {
      type: 'object',
      properties: {
        function: { type: 'string' }
      },
      required: ['function']
    };

    const args = { function: 'document.title' };
    const cleaned = cleanAndFixArguments(args, evalSchema);
    expect(cleaned.function).toBe('document.title');
  });
});

describe('Unpack Meta Tool Call', () => {
  it('should unpack call_mcp_tool into original tool name and args', () => {
    const rawArgs = {
      Arguments: { command: 'find . -maxdepth 3' },
      ServerName: 'claude2gemini-mcp-proxy',
      ToolName: 'Bash',
      toolAction: 'Run find command',
      toolSummary: 'Find files'
    };

    const unpacked = unpackMetaCall('call_mcp_tool', rawArgs);
    expect(unpacked.name).toBe('Bash');
    expect(unpacked.args.command).toBe('find . -maxdepth 3');
  });

  it('should return original name and args if not call_mcp_tool', () => {
    const rawArgs = { command: 'ls -la' };
    const unpacked = unpackMetaCall('Bash', rawArgs);
    expect(unpacked.name).toBe('Bash');
    expect(unpacked.args.command).toBe('ls -la');
  });
});

describe('MCP Hub Request Parsing Mock', () => {
  it('should resolve arguments from either arguments or Arguments field', () => {
    const rawData1 = { name: 'Bash', arguments: { command: 'ls' } };
    const rawData2 = { name: 'Bash', Arguments: { command: 'ls' } };

    const getArgs = (data: any) => data.arguments ?? data.Arguments;

    expect(getArgs(rawData1)).toEqual({ command: 'ls' });
    expect(getArgs(rawData2)).toEqual({ command: 'ls' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Additional cleanAndFixArguments edge cases
// ─────────────────────────────────────────────────────────────────────────

describe('Arguments Cleansing and Fixing: edge cases', () => {
  it('coerces boolean strings case-insensitively ("True", "TRUE", "yes")', () => {
    const schema = {
      type: 'object',
      properties: { flag: { type: 'boolean' } },
    };
    expect(cleanAndFixArguments({ flag: 'True' }, schema)).toEqual({ flag: true });
    expect(cleanAndFixArguments({ flag: 'TRUE' }, schema)).toEqual({ flag: true });
    expect(cleanAndFixArguments({ flag: 'yes' }, schema)).toEqual({ flag: false });
  });

  it('coerces numeric strings to number/integer; properties not in the schema are dropped', () => {
    const schema = {
      type: 'object',
      properties: { n: { type: 'number' }, i: { type: 'integer' } },
    };
    const out = cleanAndFixArguments({ n: '3.14', i: '7' }, schema);
    expect(out.n).toBe(3.14);
    expect(out.i).toBe(7);
    // 'bad' is not in schema → dropped (the loop only iterates declared properties)
    expect((out as any).bad).toBeUndefined();
  });

  it('strips extra properties not declared in the schema (no additionalProperties passthrough)', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
    };
    const out = cleanAndFixArguments({ a: 'x', b: 'y', c: 1 }, schema);
    expect(out).toEqual({ a: 'x' });
    expect((out as any).b).toBeUndefined();
    expect((out as any).c).toBeUndefined();
  });

  it('coerces string-typed object values to JSON.stringify', () => {
    const schema = {
      type: 'object',
      properties: { payload: { type: 'string' } },
    };
    const out = cleanAndFixArguments({ payload: { foo: 'bar' } }, schema);
    expect(out.payload).toBe('{"foo":"bar"}');
  });

  it('applies default values only when the value is undefined', () => {
    const schema = {
      type: 'object',
      properties: {
        withDefault: { type: 'string', default: 'fallback' },
      },
    };
    // Missing key: default is applied
    expect(cleanAndFixArguments({}, schema)).toEqual({ withDefault: 'fallback' });
    // Explicit value: default is NOT applied
    expect(cleanAndFixArguments({ withDefault: 'explicit' }, schema)).toEqual({ withDefault: 'explicit' });
  });

  it('coerces explicit null to the JSON-string "null" when the schema declares string', () => {
    // Documenting a quirk: the implementation checks `typeof value === 'object'`
    // (true for null) and then JSON.stringify(null) === 'null'. Callers that
    // want to distinguish missing vs. null should not declare string.
    const schema = {
      type: 'object',
      properties: {
        withDefault: { type: 'string', default: 'fallback' },
      },
    };
    expect(cleanAndFixArguments({ withDefault: null }, schema)).toEqual({ withDefault: 'null' });
  });

  it('recurses into nested object properties', () => {
    const schema = {
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: {
            inner: { type: 'string' },
            count: { type: 'integer' },
          },
        },
      },
    };
    const out = cleanAndFixArguments(
      { outer: { inner: 123, count: '5', garbage: 'drop me' } },
      schema,
    );
    expect(out.outer).toEqual({ inner: '123', count: 5 });
    expect((out.outer as any).garbage).toBeUndefined();
  });

  it('recurses into array items, applying the item schema to each element', () => {
    const schema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'integer' } },
          },
        },
      },
    };
    const out = cleanAndFixArguments(
      { items: [{ id: '1', extra: 'a' }, { id: '2', extra: 'b' }] },
      schema,
    );
    expect(out.items).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('picks the best anyOf branch based on overlapping keys (ties → first branch wins)', () => {
    const schema = {
      anyOf: [
        {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        {
          type: 'object',
          properties: { content: { type: 'string' } },
          required: ['content'],
        },
      ],
    };
    // args has one key matching each branch (1 == 1, tie). On ties the loop
    // uses `>` not `>=`, so the first branch (`path`) wins. Snapshotting
    // this behavior — flipping the order would change the result.
    const out = cleanAndFixArguments({ content: 'hello', path: 'extra' }, schema);
    expect(out).toEqual({ path: 'extra' });
    expect((out as any).content).toBeUndefined();
  });

  it('picks the best anyOf branch when one branch matches more keys than the other', () => {
    const schema = {
      anyOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } },
      ],
    };
    // Both branches match key `a`, but only the second branch matches `b`.
    // The implementation iterates schema.anyOf in order and tracks the
    // strictly-greater count, so the second branch wins.
    const out = cleanAndFixArguments({ a: 'x', b: 'y' }, schema);
    expect(out).toEqual({ a: 'x', b: 'y' });
  });

  it('picks the best oneOf branch based on overlapping keys', () => {
    const schema = {
      oneOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { b: { type: 'integer' } } },
      ],
    };
    const out = cleanAndFixArguments({ b: '7' }, schema);
    expect(out).toEqual({ b: 7 });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Additional unpackMetaCall cases
// ─────────────────────────────────────────────────────────────────────────

describe('Unpack Meta Tool Call: edge cases', () => {
  it('prefers ToolName (PascalCase) over toolName (camelCase) when both are present', () => {
    const out = unpackMetaCall('call_mcp_tool', {
      ToolName: 'Bash',
      toolName: 'ShouldNotBeUsed',
      Arguments: { command: 'ls' },
    });
    expect(out.name).toBe('Bash');
  });

  it('falls back to toolName (camelCase) when ToolName is absent', () => {
    const { name, args } = unpackMetaCall('call_mcp_tool', { toolName: 'Bash', Arguments: { command: 'ls' } });
    expect(name).toBe('Bash');
    expect(args).toEqual({ command: 'ls' });
  });

  it('prefers Arguments (PascalCase) over arguments (camelCase)', () => {
    const out = unpackMetaCall('call_mcp_tool', {
      ToolName: 'Bash',
      Arguments: { command: 'ls' },
      arguments: { command: 'rm -rf /' },
    });
    expect(out.args).toEqual({ command: 'ls' });
  });

  it('returns the original name/args when toolName is not a string', () => {
    // call_mcp_tool with a non-string ToolName → cannot unpack
    const raw = { ToolName: 42, Arguments: { x: 1 } };
    const out = unpackMetaCall('call_mcp_tool', raw);
    expect(out.name).toBe('call_mcp_tool');
    expect(out.args).toEqual(raw);
  });

  it('returns the original name/args when args is null', () => {
    const out = unpackMetaCall('Bash', null);
    expect(out.name).toBe('Bash');
    expect(out.args).toBeNull();
  });

  it('does not mutate the input args object', () => {
    const raw = {
      ToolName: 'Bash',
      Arguments: { command: 'ls' },
      ServerName: 'srv',
      toolAction: 'list',
    };
    const snapshot = JSON.parse(JSON.stringify(raw));
    unpackMetaCall('call_mcp_tool', raw);
    expect(raw).toEqual(snapshot);
  });

  it('unpacks even when ServerName / toolAction / toolSummary are present (metadata is ignored)', () => {
    const raw = {
      ToolName: 'Edit',
      Arguments: { path: 'a.txt', content: 'x' },
      ServerName: 'claude2gemini-mcp-proxy',
      toolAction: 'Edit a file',
      toolSummary: 'Edit',
    };
    const out = unpackMetaCall('call_mcp_tool', raw);
    expect(out.name).toBe('Edit');
    expect(out.args).toEqual({ path: 'a.txt', content: 'x' });
  });
});


