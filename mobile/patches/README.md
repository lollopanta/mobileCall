# Temporary dependency security backports

These patches retain upstream package versions and are applied by pnpm through
`patchedDependencies` in `pnpm-workspace.yaml`. Their hashes are recorded in the
lockfile. No advisory is ignored or excluded from the raw scanner output.

| Package | Advisory | Local correction |
| --- | --- | --- |
| node-forge 1.4.0 | [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) | Check the nested AlgorithmIdentifier element count, including optional NULL; reject non-empty NULL values. |
| braces 3.0.3 | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | Limit parser stack nesting and recursive AST walkers to 128 levels, including caller-supplied ASTs. |
SDK 58 removes the babel-jest / js-yaml 3 / argparse 1 dependency chain and
`sprintf-js` from the lockfile. Its patch is retained for reference but is no
longer configured; formatter regression tests were removed with the dependency.

The RSA element-count check follows the proposed upstream fix in
[digitalbazaar/forge#1152](https://github.com/digitalbazaar/forge/pull/1152).
The additional NULL-value check enforces an empty ASN.1 NULL, preserving accepted
SHA-256 signatures both with and without NULL parameters. Tests also verify
interoperability with Node's crypto implementation and rejection of a wrong digest.
The tests sign deliberately malformed encodings to exercise the verifier; they
do not claim to test every possible cryptographic attack.

Only the entrypoints used by the installed Node/Expo toolchain are patched:
`node-forge/lib/rsa.js` and the braces parser/walkers.
Unused prebuilt browser distributions shipped inside those packages are not
modified. These packages are consumed by the development/build toolchain here.

## Validation and maintenance

Run from `mobile`:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run test:security
pnpm audit
```

The tests resolve each library through its actual consuming dependency chain,
not an unrelated copy left in node_modules. They check malicious input and normal
usage. The same tests have passed in a clean installation built from the lock.
Raw `pnpm audit` continues to report the upstream versions and returns a
nonzero exit status; version-based scanning cannot verify these local changes.
A passing regression suite is evidence for the specific guarded behavior, not a
blanket guarantee of security.

When a reviewed upstream release fixes an advisory, upgrade the affected package,
remove its patch/config entry, refresh the lock, and keep the regression tests.
Do not remove a patch merely to make installation or audit appear successful.
