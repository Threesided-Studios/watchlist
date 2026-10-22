import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

test('offline screenshot reaches classification and strict JSON parsing without writing data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'watchlist-vision-'));
  try {
    const dir = join(root, 'scripts', 'ingest');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(root, 'shots'));
    symlinkSync(fileURLToPath(new URL('./node_modules', import.meta.url)), join(dir, 'node_modules'), 'junction');
    for (const file of ['run.mjs', 'lib.mjs', 'art.mjs', 'qa.mjs', 'openai-request.mjs', 'models.mjs']) copyFileSync(new URL(file, import.meta.url), join(dir, file));
    writeFileSync(join(root, 'data.json'), '[]');
    await sharp({ create: { width: 1200, height: 1800, channels: 3, background: 'white' } }).png().toFile(join(root, 'shots', 'synthetic.png'));
    // All network calls are intercepted. No real key or production endpoint is used.
    writeFileSync(join(dir, 'mock.mjs'), `
      import assert from 'node:assert/strict';
      import sharp from 'sharp';
      let calls = 0;
      globalThis.fetch = async (url, init) => {
        assert.equal(url, 'https://api.openai.com/v1/chat/completions');
        const b = JSON.parse(init.body);
        assert.equal(b.model, 'gpt-6-luna');
        assert.equal(b.reasoning_effort, 'none');
        assert.equal(b.response_format.json_schema.strict, true);
        assert.equal(b.response_format.json_schema.schema.additionalProperties, false);
        const image = b.messages[1].content.find(x => x.type === 'image_url').image_url;
        const meta = await sharp(Buffer.from(image.url.split(',')[1], 'base64')).metadata();
        assert.equal(meta.width, calls === 0 ? 384 : 1024);
        assert.equal(image.detail, calls === 0 ? 'low' : 'high');
        calls++;
        const out = calls === 1 ? {media: true} : {screenshot_kind:'test', source_context:'synthetic', titles:[]};
        return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(out)}}],usage:{prompt_tokens:100,completion_tokens:10}});
      };
      process.on('exit', () => assert.equal(calls, 2));
    `);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(join(dir, 'mock.mjs')).href, join(dir, 'run.mjs'), '--local', join(root, 'shots'), '--dry-run'], {
      encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, OPENAI_API_KEY: 'offline-test-only' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, 'data.json'), 'utf8'), '[]');
    const report = JSON.parse(readFileSync(join(dir, '.last-report.json'), 'utf8'));
    assert.ok(report.runUsd > 0);
    assert.equal(report.report.some(x => x.outcome === 'error'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
