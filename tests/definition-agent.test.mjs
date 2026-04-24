// Unit tests for local/definition-agent.js — pure functions with the Gemini
// call injected.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateQuestions, generateSpec, threadSlug } from '../local/definition-agent.js';

function fakeGenerate(textOut) {
  return async () => ({ text: textOut });
}

describe('definition-agent.generateQuestions', () => {
  test('parses JSON question list and suggested title', async () => {
    const out = await generateQuestions({
      captureText: 'Add push notifications to Maestro and Comms.',
      affectedApps: ['maestro', 'comms'],
      generate: fakeGenerate(JSON.stringify({
        questions: ['Which events should notify?', 'iOS + web or just web?'],
        suggested_title: 'Add push notifications',
      })),
    });
    assert.equal(out.questions.length, 2);
    assert.equal(out.suggested_title, 'Add push notifications');
  });

  test('caps questions at 5', async () => {
    const out = await generateQuestions({
      captureText: 'x',
      generate: fakeGenerate(JSON.stringify({
        questions: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        suggested_title: 't',
      })),
    });
    assert.equal(out.questions.length, 5);
  });

  test('strips ```json fences', async () => {
    const out = await generateQuestions({
      captureText: 'x',
      generate: fakeGenerate('```json\n{"questions":[],"suggested_title":"t"}\n```'),
    });
    assert.equal(out.suggested_title, 't');
  });

  test('throws on empty model response', async () => {
    await assert.rejects(
      generateQuestions({ captureText: 'x', generate: fakeGenerate('   ') }),
      /empty model response/,
    );
  });

  test('rejects missing captureText', async () => {
    await assert.rejects(
      generateQuestions({ captureText: '', generate: fakeGenerate('{}') }),
      /captureText required/,
    );
  });
});

describe('definition-agent.generateSpec', () => {
  test('interpolates Q/A into user prompt and returns text', async () => {
    let captured;
    const gen = async (params) => { captured = params; return { text: '# Spec\nAll good.' }; };
    const spec = await generateSpec({
      thread: {
        feature_title: 'Do a thing',
        questions: ['Q1?', 'Q2?'],
        answers: { 0: 'Yes', 1: 'No' },
        affected_apps: ['gloss', 'comms'],
      },
      generate: gen,
    });
    assert.match(spec, /^# Spec/);
    const userText = captured.contents[0].parts[0].text;
    assert.match(userText, /Q1\?/);
    assert.match(userText, /A: Yes/);
    assert.match(userText, /gloss, comms/);
  });
});

describe('threadSlug', () => {
  test('produces stable lowercase slug', () => {
    assert.equal(threadSlug({ feature_title: 'Add Push Notifications!' }), 'add-push-notifications');
  });
  test('handles empty/garbage', () => {
    assert.equal(threadSlug({ feature_title: '' }), 'feature');
    assert.equal(threadSlug({}), 'feature');
  });
});
