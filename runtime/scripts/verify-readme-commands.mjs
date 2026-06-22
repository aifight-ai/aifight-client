#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const readmePath = path.join(root, 'README.md')
const cliPath = path.join(root, 'src/cli/main.ts')

const readme = fs.readFileSync(readmePath, 'utf8')
const cli = fs.readFileSync(cliPath, 'utf8')

const exposedBlock = readme.match(/The package exposes:\n\n```bash\n([\s\S]*?)\n```/)
if (!exposedBlock) {
  fail('README.md is missing the "The package exposes" bash command block.')
}

const exposedLines = exposedBlock[1]
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)

const dispatchBlock = cli.match(/switch \(cmd\) \{([\s\S]*?)\n\s*default:/)
if (!dispatchBlock) {
  fail('src/cli/main.ts dispatch switch was not found.')
}

const commandNames = Array.from(dispatchBlock[1].matchAll(/case "([^"]+)":/g))
  .map((m) => m[1])
  .filter(Boolean)
  .sort()

const missingCommands = commandNames.filter((cmd) => {
  const prefix = `aifight ${cmd}`
  return !exposedLines.some((line) => line === prefix || line.startsWith(`${prefix} `))
})

const requiredExactLines = [
  'npm install -g @aifight/aifight@alpha',
  'aifight update',
  'aifight update --yes',
  'aifight service install',
  'aifight service restart',
  'aifight service status',
]

const missingExact = requiredExactLines.filter((line) => {
  if (line.startsWith('npm ')) return !readme.includes(line)
  return !exposedLines.includes(line)
})

const problems = []
if (missingCommands.length > 0) {
  problems.push(`README command block is missing CLI command(s): ${missingCommands.join(', ')}`)
}
if (missingExact.length > 0) {
  problems.push(`README is missing required release-facing line(s): ${missingExact.join(', ')}`)
}
if (!readme.includes('## Updating')) {
  problems.push('README.md is missing the Updating section.')
}
if (!readme.includes('It does not claim, re-pair, register, or create a new Agent.')) {
  problems.push('README.md must state that update does not re-register, re-pair, claim, or create a new Agent.')
}

if (problems.length > 0) {
  fail(problems.join('\n'))
}

console.log(`[verify-readme-commands] ok: ${commandNames.length} CLI command(s) covered in README.md`)

function fail(message) {
  console.error(`[verify-readme-commands] ${message}`)
  process.exit(1)
}
