#!/usr/bin/env node
import { execFileSync } from 'node:child_process'

const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})

const pack = JSON.parse(raw)[0]
const files = pack.files.map((entry) => entry.path)
const roots = Array.from(new Set(files.map((path) => path.split('/')[0]))).sort()
const allowedRoots = new Set(['LICENSE', 'README.md', 'dist', 'package.json'])
const requiredFiles = [
  'LICENSE',
  'README.md',
  'package.json',
  'dist/bin.mjs',
  'dist/index.mjs',
  'dist/types/index.d.ts',
  'dist/schemas/README.md',
]

const forbiddenPatterns = [
  /(^|\/)(src|tests|docs|node_modules|\.git|\.github|\.env|\.npmrc)(\/|$)/i,
  /\.(?:ts|tsx|map|pem|key|crt|p12|sqlite|db|log|tsbuildinfo)$/i,
  /(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i,
]

const isDeclaration = (path) => path.endsWith('.d.ts')
const forbidden = files.filter((path) => {
  if (isDeclaration(path)) return false
  return forbiddenPatterns.some((pattern) => pattern.test(path))
})

const unexpectedRoots = roots.filter((root) => !allowedRoots.has(root))
const missingRequired = requiredFiles.filter((file) => !files.includes(file))

if (unexpectedRoots.length > 0 || forbidden.length > 0 || missingRequired.length > 0) {
  console.error('[verify-packlist] npm package contains unexpected files.')
  if (unexpectedRoots.length > 0) {
    console.error(`Unexpected package roots: ${unexpectedRoots.join(', ')}`)
  }
  if (missingRequired.length > 0) {
    console.error('Missing required files:')
    for (const file of missingRequired) console.error(`  - ${file}`)
  }
  if (forbidden.length > 0) {
    console.error('Forbidden files:')
    for (const file of forbidden) console.error(`  - ${file}`)
  }
  process.exit(1)
}

console.log(
  `[verify-packlist] ok: ${files.length} files, roots=${roots.join(', ')}, size=${pack.size} bytes`,
)
