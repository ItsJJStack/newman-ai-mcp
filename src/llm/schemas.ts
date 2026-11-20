/**
 * @fileoverview JSON schemas and model transformations (schemas.ts).
 * Implements the project schemas for TestPlan, TestCaseDraft,
 * DatasetDraft, and FailureDiagnosis, along with toGrammarSchema and toRemoteSchema.
 */

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
  items?: any;
  enum?: any[];
  maximum?: number;
  minimum?: number;
  maxLength?: number;
  minLength?: number;
  maxItems?: number;
  minItems?: number;
  pattern?: string;
  [key: string]: any;
};

/**
 * Converts a base schema to the format expected by node-llama-cpp (toGrammarSchema).
 */
export function toGrammarSchema(schema: JsonSchema): any {
  return schema;
}

/**
 * Converts a base schema to the remote format (OpenAI response_format json_schema) (toRemoteSchema).
 */
export function toRemoteSchema(schema: JsonSchema): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) {
    return schema.map(toRemoteSchema);
  }

  const result: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (['maxLength', 'minLength', 'maxItems', 'minItems', 'minimum', 'maximum', 'pattern'].includes(key)) {
      continue;
    }
    if (key === 'properties' && value && typeof value === 'object') {
      const newProps: Record<string, any> = {};
      const allKeys = Object.keys(value);
      result.properties = newProps;
      result.required = allKeys;
      for (const [propKey, propVal] of Object.entries(value)) {
        newProps[propKey] = toRemoteSchema(propVal as JsonSchema);
      }
    } else if (key === 'items' && value) {
      result.items = toRemoteSchema(value as JsonSchema);
    } else if (key === 'additionalProperties') {
      result.additionalProperties = false;
    } else {
      result.additionalProperties = false;
      result[key] = toRemoteSchema(value);
    }
  }

  if (schema.type === 'object' && !result.required && schema.properties) {
    result.required = Object.keys(schema.properties);
  }
  if (schema.type === 'object' && result.additionalProperties === undefined) {
    result.additionalProperties = false;
  }

  return result;
}

/** Schema TestPlan para tool 1 (Planner) */
export function getTestPlanSchema(maxScenarios: number, endpointEnums: string[], criterionEnums: string[]): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'missingInfo', 'assumptions', 'title', 'scenarios'],
    properties: {
      status: { enum: ['ready', 'needs_info', 'out_of_scope'] },
      missingInfo: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['topic', 'question'],
          properties: {
            topic: { enum: ['endpoint', 'expected_result', 'business_rule', 'preconditions', 'scope'] },
            question: { type: 'string', maxLength: 200 },
          },
        },
      },
      assumptions: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 200 } },
      title: { type: 'string', maxLength: 80 },
      scenarios: {
        type: 'array',
        maxItems: maxScenarios,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'criterionId', 'kind', 'endpointId', 'expectedStatus', 'checks', 'inputNotes'],
          properties: {
            title: { type: 'string', maxLength: 80 },
            criterionId: { enum: criterionEnums.length > 0 ? criterionEnums : ['extra'] },
            kind: { enum: ['positive', 'negative', 'edge', 'security'] },
            endpointId: { enum: endpointEnums.length > 0 ? endpointEnums : ['E1'] },
            expectedStatus: { type: 'integer' },
            checks: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 150 } },
            inputNotes: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
  };
}

/** Schema TestCaseDraft para tool 1 (Writer) */
export function getTestCaseDraftSchema(includePrereq: boolean): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'description', 'method', 'url', 'auth', 'headers', 'body', 'prerequestScript', 'testScript'],
    properties: {
      name: { type: 'string', maxLength: 80 },
      description: { type: 'string', maxLength: 300 },
      method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
      url: { type: 'string', maxLength: 300 },
      auth: { enum: ['inherit', 'none'] },
      headers: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'value'],
          properties: {
            key: { type: 'string', maxLength: 100 },
            value: { type: 'string', maxLength: 300 },
          },
        },
      },
      body: { type: 'string', maxLength: 2000 },
      prerequestScript: {
        type: 'array',
        maxItems: includePrereq ? 30 : 0,
        items: { type: 'string', maxLength: 200 },
      },
      testScript: {
        type: 'array',
        maxItems: 40,
        items: { type: 'string', maxLength: 200 },
      },
    },
  };
}

/** Schema DatasetDraft para tool 2 */
export function getDatasetDraftSchema(scenarioCount: number, variables: string[]): JsonSchema {
  const rowProperties: Record<string, any> = {
    _scenario: { type: 'string', maxLength: 80 },
    _expectedStatus: { type: 'integer' },
  };
  for (const v of variables) {
    rowProperties[v] = { type: 'string', maxLength: 200 };
  }

  return {
    type: 'object',
    additionalProperties: false,
    required: ['rows'],
    properties: {
      rows: {
        type: 'array',
        minItems: scenarioCount,
        maxItems: scenarioCount,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['_scenario', '_expectedStatus', ...variables],
          properties: rowProperties,
        },
      },
    },
  };
}

/** Schema FailureDiagnosis para tool 3 */
export const failureDiagnosisSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'rootCause', 'suggestedFix', 'fixTarget', 'fixedExec', 'confidence'],
  properties: {
    category: { enum: ['assertion', 'network', 'ssl', 'timeout', 'auth', 'data', 'script_error', 'other'] },
    rootCause: { type: 'string', maxLength: 400 },
    suggestedFix: { type: 'string', maxLength: 400 },
    fixTarget: { enum: ['test_script', 'prerequest_script', 'request', 'environment', 'server'], type: 'string' },
    fixedExec: {
      type: 'array',
      maxItems: 40,
      items: { type: 'string', maxLength: 200 },
    },
    confidence: { enum: ['low', 'medium', 'high'] },
  },
};
