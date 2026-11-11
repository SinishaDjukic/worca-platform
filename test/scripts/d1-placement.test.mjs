import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1Placement } from '../../packages/platform/cli/setup.mjs';

test('d1 create gets --jurisdiction or --location from the config', () => {
  assert.deepEqual(d1Placement({}), []);
  assert.deepEqual(d1Placement({ database: {} }), []);
  assert.deepEqual(d1Placement({ database: { jurisdiction: 'eu' } }), ['--jurisdiction', 'eu']);
  assert.deepEqual(d1Placement({ database: { location: 'weur' } }), ['--location', 'weur']);
});
