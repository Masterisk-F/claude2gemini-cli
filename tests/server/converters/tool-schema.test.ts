import { describe, it, expect } from 'vitest';
import { jsonSchemaToZod } from '../../../server/converters/tool-schema.js';
import { z } from 'zod';

describe('tool-schema converter', () => {
  describe('jsonSchemaToZod', () => {
    it('should convert string schema', () => {
      const schema = { type: 'string', description: 'A name' };
      const zodType = jsonSchemaToZod(schema);
      expect(zodType instanceof z.ZodString).toBe(true);
      expect(zodType.description).toBe('A name');
      expect(zodType.parse('John')).toBe('John');
    });

    it('should convert integer schema', () => {
      const schema = { type: 'integer' };
      const zodType = jsonSchemaToZod(schema);
      expect(zodType instanceof z.ZodNumber).toBe(true);
      expect(zodType.parse(42)).toBe(42);
      expect(() => zodType.parse(3.14)).toThrow();
    });

    it('should convert object schema with properties and required fields', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' }
        },
        required: ['name']
      };
      const zodType = jsonSchemaToZod(schema);
      expect(zodType instanceof z.ZodObject).toBe(true);

      // name is required
      expect(zodType.parse({ name: 'John' })).toEqual({ name: 'John' });
      expect(() => zodType.parse({ age: 30 })).toThrow();

      // age is optional
      expect(zodType.parse({ name: 'John', age: 30 })).toEqual({ name: 'John', age: 30 });
    });

    it('should convert array schema', () => {
      const schema = {
        type: 'array',
        items: { type: 'string' }
      };
      const zodType = jsonSchemaToZod(schema);
      expect(zodType instanceof z.ZodArray).toBe(true);
      expect(zodType.parse(['a', 'b'])).toEqual(['a', 'b']);
      expect(() => zodType.parse([1, 2])).toThrow();
    });

    it('should convert enum schema', () => {
      const schema = {
        type: 'string',
        enum: ['red', 'green', 'blue']
      };
      const zodType = jsonSchemaToZod(schema);
      expect(zodType instanceof z.ZodEnum).toBe(true);
      expect(zodType.parse('red')).toBe('red');
      expect(() => zodType.parse('yellow')).toThrow();
    });
  });
});
