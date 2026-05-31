import { describe, it, expect } from 'vitest';
import { simplifySchema, cleanAndFixArguments, unpackMetaCall } from '../server/mcp-hub.js';

describe('Schema Simplification', () => {
  it('should resolve anyOf/oneOf to a primitive type or first option', () => {
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
    expect(simplified.properties.command.type).toBe('string');
    expect(simplified.properties.command.anyOf).toBeUndefined();
    expect(simplified.properties.timeout.type).toBe('integer');
    expect(simplified.properties.timeout.oneOf).toBeUndefined();
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
    expect(cleaned.verbose).toBe(false); // fallback for boolean
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
