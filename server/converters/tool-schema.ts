/**
 * Claude JSON Schema → Zod スキーマ変換
 */

import { z } from 'zod';
import type { ClaudeToolDefinition } from '../types.js';

/**
 * 簡易的な JSON Schema 実装から Zod スキーマへの変換
 */
export function jsonSchemaToZod(schema: any): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') {
    return z.any();
  }

  const { type, properties, required, items, enum: enumValues, description } = schema;

  let zodType: z.ZodTypeAny = z.any();

  if (enumValues && Array.isArray(enumValues)) {
    if (enumValues.length > 0) {
      zodType = z.enum(enumValues as [string, ...string[]]);
    } else {
      zodType = z.any();
    }
  } else {
    switch (type) {
      case 'string':
        zodType = z.string();
        break;
      case 'number':
        zodType = z.number();
        break;
      case 'integer':
        zodType = z.number().int();
        break;
      case 'boolean':
        zodType = z.boolean();
        break;
      case 'array':
        if (items) {
          zodType = z.array(jsonSchemaToZod(items));
        } else {
          zodType = z.array(z.any());
        }
        break;
      case 'object':
        if (properties) {
          const zodProperties: Record<string, z.ZodTypeAny> = {};
          const reqArray = Array.isArray(required) ? required : [];
          for (const [key, value] of Object.entries(properties)) {
            const propSchema = jsonSchemaToZod(value);
            if (reqArray.includes(key)) {
              zodProperties[key] = propSchema;
            } else {
              zodProperties[key] = propSchema.optional();
            }
          }
          zodType = z.object(zodProperties);
        } else {
          zodType = z.record(z.any());
        }
        break;
      default:
        zodType = z.any();
        break;
    }
  }

  if (description) {
    zodType = zodType.describe(description);
  }

  return zodType;
}

/**
 * Claude API のツール定義から Gemini SDK の Tool への対応情報を構築するためのヘルパー
 * 実際の action の実装は `session-store` と連携するため、gemini-backend.ts などで行う。
 */
export function convertClaudeToolToZodSchema(tool: ClaudeToolDefinition): z.ZodTypeAny {
  return jsonSchemaToZod(tool.input_schema);
}
