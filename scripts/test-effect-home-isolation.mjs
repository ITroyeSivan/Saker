import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { assessHomeIsolation, samePath } from '../benchmarks/task-effects/protocol.mjs';

let failed = 0;
function test(label, fn) { try { fn(); console.log('ok ' + label); } catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); } }

const realHome = join(homedir(), '.dsh');
const isolatedRoot = join(homedir(), '.dsh-effect-isolation-fixture');
const isolatedHome = join(isolatedRoot, 'home');

await test('the daily launcher home is refused and the refusal names both faults', () => {
  const result = assessHomeIsolation({ home: realHome });
  assert.equal(result.isolated, false);
  assert(result.reasons.includes('home-is-real-user-home'), JSON.stringify(result.reasons));
  assert(result.reasons.includes('isolated-root-not-declared'), JSON.stringify(result.reasons));
  assert.equal(result.userHome, realHome);
});

await test('declaring the real home as the isolated root does not make it isolated', () => {
  const result = assessHomeIsolation({ home: realHome, declaredRoot: realHome });
  assert.equal(result.isolated, false);
  assert(result.reasons.includes('isolated-root-covers-real-home'), JSON.stringify(result.reasons));
});

await test('a root that contains the real home proves nothing', () => {
  const result = assessHomeIsolation({ home: realHome, declaredRoot: homedir() });
  assert.equal(result.isolated, false);
  assert(result.reasons.includes('isolated-root-covers-real-home'), JSON.stringify(result.reasons));
});

await test('a home outside the declared root is refused even when it is not the real home', () => {
  const result = assessHomeIsolation({ home: join(homedir(), '.dsh-other'), declaredRoot: isolatedRoot });
  assert.equal(result.isolated, false);
  assert(result.reasons.includes('home-outside-isolated-root'), JSON.stringify(result.reasons));
});

await test('a home strictly inside the declared root is isolated', () => {
  const result = assessHomeIsolation({ home: isolatedHome, declaredRoot: isolatedRoot });
  assert.equal(result.isolated, true, JSON.stringify(result));
  assert.deepEqual(result.reasons, []);
  assert.equal(result.home, isolatedHome);
  assert.equal(result.isolatedRoot, isolatedRoot);
});

await test('trailing separators, nested roots and undeclared values stay fail-closed', () => {
  assert.equal(assessHomeIsolation({ home: isolatedHome + sep, declaredRoot: isolatedRoot + sep }).isolated, true,
    'normalised trailing separators must not change the verdict');
  assert.equal(assessHomeIsolation({ home: isolatedRoot, declaredRoot: isolatedRoot }).isolated, false, 'the root itself is not a home');
  assert.equal(assessHomeIsolation({ home: isolatedHome }).isolated, false);
  assert.equal(assessHomeIsolation({ home: '', declaredRoot: isolatedRoot }).isolated, false);
  assert.equal(assessHomeIsolation({ declaredRoot: isolatedRoot }).isolated, false);
  assert.equal(assessHomeIsolation({ home: isolatedHome, declaredRoot: '   ' }).isolated, false);
  const nested = assessHomeIsolation({ home: join(isolatedRoot, 'a', 'b'), declaredRoot: isolatedRoot });
  assert.equal(nested.isolated, true, 'a nested home inside the root is still isolated');
});

await test('comparison of the real home is case-insensitive where the platform is', () => {
  if (process.platform === 'win32') {
    assert.equal(samePath(realHome.toUpperCase(), realHome.toLowerCase()), true);
    assert.equal(assessHomeIsolation({ home: realHome.toUpperCase(), userHome: realHome, declaredRoot: isolatedRoot }).isolated, false);
  } else {
    assert.equal(samePath(realHome, realHome.toLowerCase()), realHome === realHome.toLowerCase());
  }
});

console.log('Fixture verification only: isolation guard matrix, no host or model is started.');
process.exitCode = failed ? 1 : 0;
