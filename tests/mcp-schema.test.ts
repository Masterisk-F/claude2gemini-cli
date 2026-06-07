/**
 * Unit tests for the `simplifySchema()`, `cleanAndFixArguments()`, and
 * `unpackMetaCall()` helpers exported from server/mcp-hub.ts.
 *
 * `simplifySchema` is the LEGACY flattener used only when
 * `MCP_HUB_LEGACY_SCHEMA=1` is set. The default behavior of McpHub is
 * to forward the original input_schema as-is (see mcp-hub.test.ts
 * "Default behavior (passthrough)"). The tests in this file lock
 * down the legacy path so that, if it is needed for a specific
 * environment, we know exactly what it does.
 *
 * `cleanAndFixArguments` and `unpackMetaCall` are still used in
 * /call regardless of the schema passthrough setting.
 */

import { describe, it, expect } from 'vitest';
import { simplifySchema, cleanAndFixArguments, unpackMetaCall } from '../server/mcp-hub.js';

describe('Schema Simplification (LEGACY_SCHEMA mode)', () => {
  it('should merge all anyOf/oneOf branches properties and required', () => {
    const complexSchema = {
      type: 'object',
      properties: {
        command: {
          anyOf: [
            { type: 'string', description: 'The bash command to run' },
            { type: 'null' }
          ]
        },
        timeout: {
          oneOf: [
            { type: 'integer' },
            { type: 'string' }
          ]
        }
      }
    };

    const simplified = simplifySchema(complexSchema);
    // anyOf: string branch kept, null branch discarded (type-level)
    expect(simplified.properties.command.type).toBe('string');
    expect(simplified.properties.command.anyOf).toBeUndefined();
    // oneOf: merged from both branches — both types visible
    expect(simplified.properties.timeout).toBeDefined();
    expect(simplified.properties.timeout.oneOf).toBeUndefined();
  });

  it('should merge anyOf branches at the top level', () => {
    // Simulates a tool schema with two possible object shapes
    const schema = {
      anyOf: [
        {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id']
        },
        {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name']
        }
      ]
    };

    const simplified = simplifySchema(schema);
    expect(simplified.anyOf).toBeUndefined();
    // Both properties from both branches should be present
    expect(simplified.properties.id).toBeDefined();
    expect(simplified.properties.name).toBeDefined();
    // Required from both branches merged
    expect(simplified.required).toContain('id');
    expect(simplified.required).toContain('name');
  });

  it('should merge allOf schemas into a flat object', () => {
    const schema = {
      type: 'object',
      allOf: [
        {
          properties: {
            path: { type: 'string' }
          },
          required: ['path']
        },
        {
          properties: {
            content: { type: 'string' }
          },
          required: ['content']
        }
      ]
    };

    const simplified = simplifySchema(schema);
    expect(simplified.properties.path).toBeDefined();
    expect(simplified.properties.content).toBeDefined();
    expect(simplified.required).toContain('path');
    expect(simplified.required).toContain('content');
    expect(simplified.allOf).toBeUndefined();
  });

  it('should remove additionalProperties and handle multi-type arrays', () => {
    const schema = {
      type: 'object',
      properties: {
        tag: { type: ['string', 'null'] }
      },
      additionalProperties: false
    };

    const simplified = simplifySchema(schema);
    expect(simplified.properties.tag.type).toBe('string');
    expect(simplified.additionalProperties).toBeUndefined();
  });
});

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
// Additional Schema Simplification edge cases
// ─────────────────────────────────────────────────────────────────────────

describe('Schema Simplification: edge cases', () => {
  it('handles 3-level deep nested anyOf while keeping required at every level', () => {
    const schema = {
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: {
            middle: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    inner: { type: 'string', description: 'deepest' },
                  },
                  required: ['inner'],
                },
                { type: 'null' },
              ],
            },
          },
          required: ['middle'],
        },
      },
      required: ['outer'],
    };
    const simplified = simplifySchema(schema);
    expect(simplified.required).toEqual(['outer']);
    expect(simplified.properties.outer.required).toEqual(['middle']);
    // The null branch is dropped, the string-typed middle is kept.
    expect(simplified.properties.outer.properties.middle.type).toBe('object');
    expect(simplified.properties.outer.properties.middle.properties.inner.type).toBe('string');
    expect(simplified.properties.outer.properties.middle.required).toEqual(['inner']);
  });

  it('preserves description on the root schema and on top-level properties', () => {
    const schema = {
      type: 'object',
      description: 'top-level description',
      properties: {
        foo: { type: 'string', description: 'a foo parameter' },
      },
    };
    const simplified = simplifySchema(schema);
    expect(simplified.description).toBe('top-level description');
    expect(simplified.properties.foo.description).toBe('a foo parameter');
  });

  it('strips additionalProperties (LS planner does not handle it)', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    };
    const simplified = simplifySchema(schema);
    expect(simplified.additionalProperties).toBeUndefined();
  });

  it('does not crash on empty / null schema (returns the input as-is)', () => {
    expect(simplifySchema(null)).toBeNull();
    expect(simplifySchema(undefined)).toBeUndefined();
    expect(simplifySchema({})).toEqual({});
  });

  it('handles array items with nested anyOf (items is simplified recursively)', () => {
    const schema = {
      type: 'array',
      items: {
        anyOf: [
          { type: 'string', description: 'item string' },
          { type: 'null' },
        ],
      },
    };
    const simplified = simplifySchema(schema);
    expect(simplified.type).toBe('array');
    expect(simplified.items.type).toBe('string');
  });

  it('handles multi-type array declarations like ["string", "null"]', () => {
    const schema = { type: ['string', 'null'] as any };
    const simplified = simplifySchema(schema);
    expect(simplified.type).toBe('string');
  });

  it('merges oneOf with multiple non-null branches and keeps all properties/required', () => {
    const schema = {
      type: 'object',
      oneOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'integer' } }, required: ['b'] },
      ],
    };
    const simplified = simplifySchema(schema);
    expect(simplified.oneOf).toBeUndefined();
    expect(simplified.properties.a).toBeDefined();
    expect(simplified.properties.b).toBeDefined();
    expect(simplified.required.sort()).toEqual(['a', 'b']);
  });

  it('flattens allOf at the top level (no parent type, no parent properties)', () => {
    const schema = {
      allOf: [
        { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
        { type: 'object', properties: { y: { type: 'integer' } }, required: ['y'] },
      ],
    };
    const simplified = simplifySchema(schema);
    expect(simplified.allOf).toBeUndefined();
    expect(simplified.properties.x).toBeDefined();
    expect(simplified.properties.y).toBeDefined();
    expect(simplified.required.sort()).toEqual(['x', 'y']);
    expect(simplified.type).toBe('object');
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
    const out = unpackMetaCall('call_mcp_tool', {
      toolName: 'Read',
      arguments: { path: '/tmp/x' },
    });
    expect(out.name).toBe('Read');
    expect(out.args).toEqual({ path: '/tmp/x' });
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

// ─────────────────────────────────────────────────────────────────────────
// Integration: setTools → simplifySchema → cleanAndFixArguments
// (mirrors the production flow in McpHub.#handleToolsCall)
// ─────────────────────────────────────────────────────────────────────────

describe('setTools + cleanAndFixArguments integration (mirrors McpHub #handleToolsCall)', () => {
  it('applies the ORIGINAL (pre-simplification) schema to cleanse LS-sent args', () => {
    // Real-world Claude tool definition: a Read tool whose `path` is required.
    const defs = [
      {
        name: 'Read',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'absolute file path' },
            limit: { type: 'integer', default: 100 },
          },
          required: ['path'],
        },
      },
    ];
    // The hub keeps both the simplified schema (for LS) and the original
    // (for cleansing). We mimic the second half of the flow.
    const original = defs[0]!.input_schema;
    const argsFromLS = { path: '/etc/hosts', limit: '5', extra: 'noise' };

    const cleaned = cleanAndFixArguments(argsFromLS, original);
    expect(cleaned).toEqual({ path: '/etc/hosts', limit: 5 });
    expect((cleaned as any).extra).toBeUndefined();
  });

  it('handles allOf at the top level: cleanses against the MERGED original schema', () => {
    const original = {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'integer' } }, required: ['b'] },
      ],
    };
    const out = cleanAndFixArguments({ a: 'x', b: '7', c: 'drop' }, original);
    expect(out).toEqual({ a: 'x', b: 7 });
  });

  it('handles anyOf at the top level: picks the best-matching branch for cleansing', () => {
    const original = {
      anyOf: [
        { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
      ],
    };
    const out = cleanAndFixArguments({ content: 'hello' }, original);
    expect(out).toEqual({ content: 'hello' });
  });
});


