import test from 'node:test';
import assert from 'node:assert/strict';
import { completionBody } from './openai-request.mjs';
import { costOf } from './lib.mjs';

const schema = { type: 'object', additionalProperties: false, required: ['media'], properties: { media: { type: 'boolean' } } };
const messages = [{ role: 'user', content: [
  { type: 'text', text: 'Identify the title in this screenshot.' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'low' } },
] }];

for (const model of ['gpt-6-luna', 'gpt-6-sol']) {
  test(`${model} preserves vision and strict JSON with nonreasoning parameters`, () => {
    const body = JSON.parse(JSON.stringify(completionBody(model, messages, schema, 1800)));
    assert.deepEqual(body.messages, messages);
    assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'out', strict: true, schema } });
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.temperature, 0);
    assert.equal(body.max_completion_tokens, 1800);
    assert.equal('max_tokens' in body, false);
  });
}

test('legacy model override retains compatible token parameters', () => {
  const body = completionBody('gpt-4.1-mini', messages, schema, 20);
  assert.equal(body.max_tokens, 20);
  assert.equal('reasoning_effort' in body, false);
});

test('new model usage is charged at published standard rates', () => {
  assert.equal(costOf('gpt-6-luna', { prompt_tokens: 1e6, completion_tokens: 1e6 }), 0.6);
  assert.equal(costOf('gpt-6-sol', { prompt_tokens: 1e6, completion_tokens: 1e6 }), 12);
});

test('other reasoning model overrides do not inherit Luna-specific parameters', () => {
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-5']) {
    assert.equal('reasoning_effort' in completionBody(model, messages, schema, 20), false);
  }
});
