import test from 'node:test'
import assert from 'node:assert/strict'

test('release gate acceptance probe fails intentionally', () => {
  assert.fail('Intentional release gate acceptance probe')
})
