import { describe, expect, it } from 'vitest';
import { generateCicdPipelineConfig } from '../src/postman/cicdTemplates.js';

describe('CI/CD templates', () => {
  it.each(['github-actions', 'gitlab-ci', 'azure-devops', 'jenkins', 'dockerfile'] as const)('generates a stable %s template', platform => {
    const result = generateCicdPipelineConfig({ platform, collectionSource: 'collection.json', nodeVersion: '20' });
    expect(result).toMatchSnapshot();
  });
});
