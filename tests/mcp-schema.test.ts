import { describe, it, expect } from 'vitest';
import { simplifySchema, cleanAndFixArguments, unpackMetaCall } from '../server/mcp-hub.js';

describe('Schema Simplification', () => {
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

