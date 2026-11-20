import { describe, it, expect } from 'vitest';
import { testScriptProblem } from '../src/tools/generate_tests_from_story.js';
import { buildEndpointCatalog } from '../src/postman/storyAnalyzer.js';

describe('generated test script guard', () => {
  it('accepts valid JavaScript lines', () => {
    expect(testScriptProblem([
      "pm.test('status is 200', function () { pm.response.to.have.status(200); });",
      "pm.test('body is JSON', function () { pm.response.json(); });",
    ])).toBeNull();
  });

  it('rejects prose, broken syntax, template variables and empty scripts', () => {
    expect(testScriptProblem(['After the status check, verify the appointment details.'])).not.toBeNull();
    expect(testScriptProblem(['pm.expect(1).to.equal(1);', ']}  '])).not.toBeNull();
    expect(testScriptProblem(["pm.expect(pm.response.text()).to.include('{{appointmentNumber}}');"])).toMatch(/\{\{variable\}\}/);
    expect(testScriptProblem([])).toBe('empty test script');
  });
});

describe('endpoint catalog base', () => {
  it('keeps the base variable or host apart from the path', () => {
    const { catalog } = buildEndpointCatalog({
      item: [
        { name: 'a', request: { method: 'GET', url: '{{baseUrl}}/appointments/{{appointmentNumber}}' } },
        { name: 'b', request: { method: 'GET', url: 'https://api.example.com/users/:id' } },
      ],
    });
    expect(catalog.map(c => `${c.base}|${c.path}`)).toEqual([
      '{{baseUrl}}|/appointments/{{appointmentNumber}}',
      'https://api.example.com|/users/:id',
    ]);
  });
});
