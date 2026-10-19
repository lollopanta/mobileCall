const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const crypto = require('node:crypto');

// Resolve along the actual dependency chain, rather than testing an unused copy.
function through(...packages) {
  let resolveFrom = require;
  for (const name of packages.slice(0, -1)) {
    resolveFrom = createRequire(resolveFrom.resolve(name));
  }
  return resolveFrom(packages.at(-1));
}
const forge = through('expo', '@expo/cli', '@expo/code-signing-certificates', 'node-forge');
const braces = through('react-native', '@react-native/community-cli-plugin', 'metro-config', 'metro', 'metro-file-map', 'micromatch', 'braces');
const { sprintf, vsprintf } = through('react-native', 'babel-jest', '@jest/transform', 'babel-plugin-istanbul', '@istanbuljs/load-nyc-config', 'js-yaml', 'argparse', 'sprintf-js');

const nativeKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 3 });
const privateKey = forge.pki.privateKeyFromPem(nativeKeys.privateKey.export({ type: 'pkcs1', format: 'pem' }));
const publicKey = forge.pki.publicKeyFromPem(nativeKeys.publicKey.export({ type: 'pkcs1', format: 'pem' }));
const message = 'MobileCall signature regression';
const digest = crypto.createHash('sha256').update(message).digest('binary');
function digestInfo({ nullParameter = true, extra = false, nullPayload = '' } = {}) {
  const asn1 = forge.asn1;
  const algorithm = [asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(forge.oids.sha256).getBytes())];
  if (nullParameter) algorithm.push(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, nullPayload));
  if (extra) algorithm.push(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, 'unexpected nested payload'));
  return asn1.toDer(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, algorithm),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, digest),
  ])).getBytes();
}
function signInfo(options) {
  const info = digestInfo(options);
  // Sign a chosen encoded message to exercise the vulnerable verifier independently
  // of probabilistic low-exponent forgery generation.
  const size = Math.ceil(publicKey.n.bitLength() / 8);
  const block = '\x00\x01' + '\xff'.repeat(size - info.length - 3) + '\x00' + info;
  return forge.pki.rsa.encrypt(block, privateKey, false);
}

test('RSA accepts valid signatures and interoperates with Node crypto', () => {
  for (const nullParameter of [true, false]) {
    assert.equal(publicKey.verify(digest, signInfo({ nullParameter })), true);
  }
  const signature = crypto.sign('sha256', Buffer.from(message), nativeKeys.privateKey);
  assert.equal(publicKey.verify(digest, signature.toString('binary')), true);
  assert.equal(publicKey.verify('wrong digest', signature.toString('binary')), false);
});

test('RSA rejects garbage in nested DigestAlgorithm, with or without NULL', () => {
  for (const nullParameter of [true, false]) {
    assert.throws(() => publicKey.verify(digest, signInfo({ nullParameter, extra: true })), /DigestInfo/);
  }
});

test('RSA rejects non-empty algorithm NULL parameters', () => {
  assert.throws(() => publicKey.verify(digest, signInfo({ nullPayload: 'unexpected payload' })), /DigestInfo/);
});

test('brace compile, expand, stringify and parse reject deeply nested inputs safely', () => {
  for (const fn of [braces.parse, braces.compile, braces.expand, braces.stringify]) {
    for (const [open, close] of [['{', '}'], ['(', ')']]) {
      const input = open.repeat(2000) + 'a,b' + close.repeat(2000);
      assert.throws(() => fn(input), error => /nesting limit/.test(error.message));
    }
  }
});

test('brace walkers also guard caller-supplied ASTs', () => {
  for (const fn of [braces.compile, braces.expand, braces.stringify]) {
    let ast = { type: 'text', value: 'a' };
    for (let i = 0; i < 5000; i++) ast = { type: 'root', nodes: [ast] };
    assert.throws(() => fn(ast), error => /nesting limit/.test(error.message));
  }
});

test('normal brace and parenthesis patterns keep their behavior', () => {
  assert.deepEqual(braces.expand('src/{app,test}/{a,b}.js'), ['src/app/a.js', 'src/app/b.js', 'src/test/a.js', 'src/test/b.js']);
  assert.equal(braces.compile('src/{app,test}.js'), 'src/(app|test).js');
  assert.equal(braces.stringify(braces.parse('src/{app,test}.js')), 'src/{app,test}.js');
  assert.doesNotThrow(() => braces.compile('('.repeat(32) + '{a,b}' + ')'.repeat(32)));
});

test('formatter rejects excessive width and precision before allocating or formatting', () => {
  for (const spec of ['%1000000000s', '%.1000000000f', '%.1000000000s', '%999999999999999999999999s']) {
    assert.throws(() => sprintf(spec, 'x'), error => /format limit/.test(error.message));
  }
  assert.throws(() => vsprintf('%1000000000s', ['x']), /format limit/);
});

test('ordinary formatter output stays compatible with argparse', () => {
  assert.equal(sprintf('%s %04d %.2f', 'value', 7, 1.25), 'value 0007 1.25');
  assert.equal(vsprintf('%.3s', ['testing']), 'tes');
  assert.equal(sprintf('%(name)s', { name: 'test' }), 'test');
});
