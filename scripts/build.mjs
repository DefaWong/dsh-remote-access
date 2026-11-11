// Build both halves: tsc emits the Host half to lib/, and the browser half is
// compiled to CommonJS and wrapped in the client module loader's factory
// format (window.__ModuleLoader__.load({ id, factory(require) })).
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
rmSync(`${root}lib`, { recursive: true, force: true })
rmSync(`${root}build`, { recursive: true, force: true })
execFileSync(process.execPath, [tsc, '-p', `${root}tsconfig.json`], { stdio: 'inherit' })
execFileSync(process.execPath, [tsc, '-p', `${root}tsconfig.client.json`], { stdio: 'inherit' })
const { name } = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))
const body = readFileSync(`${root}build/client/index.js`, 'utf8')
writeFileSync(`${root}lib/client.js`, `window.__ModuleLoader__.load({
  id: ${JSON.stringify(name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${body}
    return module.exports;
  }
});
`)
rmSync(`${root}build`, { recursive: true, force: true })
