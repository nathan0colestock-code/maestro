// scripts/seed-recommendations.mjs — parse + post against a temp cloud.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../scripts/seed-recommendations.mjs';

const SAMPLE = `
# Plan

## Context
- Too short

## Maestro
- Add SPEC 7 definition phase with schema migration
- Polish the dashboard CSS and reduced-motion
- Remove dead-code from improvement-agent

### Gloss
- Add VAPID push notifications (auth-gated)
- Deprecate the half-migrated scanner module

## Cross-cutting themes
- Unify telemetry envelope across apps
`;

describe('parsePlan', () => {
  const items = parsePlan(SAMPLE);

  test('skips short bullets', () => {
    assert.ok(items.every(i => i.text.length >= 10));
  });

  test('assigns target_app from section heading', () => {
    const maestroItems = items.filter(i => i.target_app === 'maestro');
    assert.ok(maestroItems.length >= 3);
    const glossItems = items.filter(i => i.target_app === 'gloss');
    assert.ok(glossItems.length >= 2);
  });

  test('normalizes black-hole → black section', () => {
    const md = '## Black-hole\n- Add black-hole telemetry hook\n';
    const out = parsePlan(md);
    assert.equal(out[0].target_app, 'black');
  });

  test('cross-cutting → suite', () => {
    const suiteItems = items.filter(i => i.target_app === 'suite');
    assert.ok(suiteItems.length >= 1);
  });

  test('priority 4 for SPEC/schema/auth', () => {
    const specItem = items.find(i => i.text.includes('SPEC 7'));
    assert.equal(specItem.priority, 4);
  });

  test('priority 3 for dead-code/deprecate', () => {
    const bloatItem = items.find(i => i.text.includes('dead-code'));
    assert.equal(bloatItem.priority, 3);
  });

  test('priority 2 for UX/polish', () => {
    const uxItem = items.find(i => i.text.toLowerCase().includes('polish'));
    assert.equal(uxItem.priority, 2);
  });

  test('every item has source="tasks_md"', () => {
    assert.ok(items.every(i => i.source === 'tasks_md'));
  });
});
