// Keep the image messages and strict JSON schema identical across model overrides.
export function completionBody(model, messages, schema, maxTokens) {
  const modern = /^gpt-6-(?:luna|sol)(?:-|$)/.test(model);
  return {
    model, messages, temperature: 0,
    ...(modern ? { reasoning_effort: 'none', max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    response_format: { type: 'json_schema', json_schema: { name: 'out', strict: true, schema } },
  };
}
