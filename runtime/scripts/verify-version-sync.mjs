#!/usr/bin/env node
// Publish gate: the package version must match the two hand-sync'd version
// constants the client reports to the platform. This drift already shipped
// once (a beta package that self-reported an older alpha version), because the
// vitest drift check is not part of the publish gate — this script is.
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const expected = pkg.version

const sources = [
  {
    file: 'src/index.ts',
    name: 'RUNTIME_VERSION',
    re: /RUNTIME_VERSION\s*=\s*"([^"]+)"/,
  },
  {
    file: 'src/controlapi/server.ts',
    name: 'CONTROL_API_VERSION',
    re: /CONTROL_API_VERSION\s*=\s*"([^"]+)"/,
  },
]

const problems = []
for (const src of sources) {
  const text = fs.readFileSync(path.join(root, src.file), 'utf8')
  const m = text.match(src.re)
  if (!m) {
    problems.push(`${src.file}: could not find ${src.name} = "..."`)
    continue
  }
  if (m[1] !== expected) {
    problems.push(`${src.file}: ${src.name} is "${m[1]}", expected "${expected}" (package.json)`)
  }
}

if (problems.length > 0) {
  console.error('[verify-version-sync] version drift:')
  for (const p of problems) console.error(`  - ${p}`)
  console.error(`\nBump all of them to "${expected}" (or fix package.json) before publishing.`)
  process.exit(1)
}

console.log(`[verify-version-sync] ok: package + RUNTIME_VERSION + CONTROL_API_VERSION all "${expected}"`)
