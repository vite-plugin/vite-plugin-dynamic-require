import path from 'path'
import fastGlob from 'fast-glob'
import { type ResolvedConfig } from 'vite'
import { TopScopeType, type Analyzed } from './analyze'
import { type Resolved, Resolve } from './resolve'
import { type Options } from './index'
import { dynamicImportToGlob } from 'vite-plugin-dynamic-import'
import { MagicString, builtins } from './utils'
import { type AcornNode } from './types'

/**
 * ```
 * At present, divide `require` into three cases
 * 目前，将 require() 分为三种情况
 * 
 * ①:
 * In the top-level scope and can be converted to `import` directly (🎯-①)
 * 在顶层作用域，并且直接转换成 import
 * 
 * ②:
 * If the `id` in `require(id)` is a literal string, the `require` statement will be promoted to the top-level scope and become an `import` statement (🚧-①)
 * 如果 require(id) 中的 id 是字面量字符串，require 语句将会被提升到顶级作用域，变成 import 语句
 * 
 * ③:
 * If the `id` in `require(id)` is a dynamic-id, the `require` statement will be converted to `__matchRequireRuntime` function (🚧-②)
 * 如果 require(id) 中的 id 动态 id，require 语句将会被转换成 __matchRequireRuntime 函数
 * ```
 */

export class DynamicRequire {
  private EXT = '.extension'

  constructor(
    private options: Options,
    private config: ResolvedConfig,
    private resolve = new Resolve(config),
  ) { }

  public async transform(analyzed: Analyzed, importer: string): Promise<string> {
    const { code, require: statements } = analyzed
    const ms = new MagicString(code)
    const promotionImports: string[] = []
    const runtimeFunctions: string[] = []
    const importCache = new Map<string, string>(/* import-id, import-name */)
    let counter = 0

    for (const statement of statements) {
      const {
        node,
        ancestors,
        dynamic,
        topScopeNode,
      } = statement
      counter++

      const require2import = `__require2import__${counter}__`

      let requireId: string
      const requireIdNode = node.arguments[0]
      if (!requireIdNode) continue // Not value - require()
      if (requireIdNode.type === 'Literal') {
        requireId = requireIdNode.value
      } else if (dynamic === 'dynamic-like') {
        requireId = requireIdNode.quasis[0].value.raw
      }

      if (builtins.includes(requireId)) continue

      if (!requireId && topScopeNode) {
        const codeSnippets = analyzed.code.slice(node.start, node.end)
        throw new Error(`The following require statement cannot be converted.
      -> ${codeSnippets}
         ${'^'.repeat(codeSnippets.length)}`)
      }

      if (topScopeNode) {
        let imptStatement = ''
        let declaration = '' // `declaration` used to merge import

        switch (topScopeNode.type) {
          case TopScopeType.ExpressionStatement:
            // TODO: with members
            imptStatement = `import '${requireId}';`
            break

          case TopScopeType.VariableDeclaration:
            // TODO: Multiple declaration
            const VariableDeclarator: AcornNode = topScopeNode.declarations[0]
            const { /* L-V */id, /* R-V */init } = VariableDeclarator

            // Left value
            let LV: string | { key: string, value: string }[]
            if (id.type === 'Identifier') {
              LV = id.name
            } else if (id.type === 'ObjectPattern') {
              LV = []
              for (const { key, value } of id.properties) {
                LV.push({ key: key.name, value: value.name })
              }
            } else {
              throw new Error(`Unknown VariableDeclarator.id.type(L-V): ${id.type}`)
            }

            const LV_str = (spe: string) => typeof LV === 'object'
              ? LV.map(e => e.key === e.value ? e.key : `${e.key} ${spe} ${e.value}`).join(', ')
              : ''

            // Right value
            if (init.type === 'CallExpression') {
              if (typeof LV === 'string') {
                // const acorn = require('acorn')
                imptStatement = `import * as ${LV} from '${requireId}'`
              } else {
                // const { parse } = require('acorn')
                imptStatement = `import { ${LV_str('as')} } from '${requireId}'`
              }
            } else if (init.type === 'MemberExpression') {
              // 🚧-②
              const onlyOneMember = ancestors.find(an => an.type === 'MemberExpression').property.name
              const importDefault = onlyOneMember === 'default'
              if (typeof LV === 'string') {
                if (importDefault) {
                  // const foo = require('foo').default
                  imptStatement = `import ${LV} from '${requireId}'`
                } else {
                  imptStatement = onlyOneMember === LV
                    // const bar = require('foo').bar
                    ? `import { ${LV} } from '${requireId}'`
                    // const barAlias = require('foo').bar
                    : `import { ${onlyOneMember} as ${LV} } from '${requireId}'`
                }
              } else {
                if (importDefault) {
                  // const { member1, member2 } = require('foo').default
                  imptStatement = `import ${require2import} from '${requireId}'`
                } else {
                  // const { member1, member2 } = require('foo').bar
                  imptStatement = `import { ${onlyOneMember} as ${require2import} } from '${requireId}'`
                }
                declaration = `const { ${LV_str(':')} } = ${require2import}`
              }

            } else {
              throw new Error(`Unknown VariableDeclarator.init.type(R-V): ${id.init}`)
            }
            ms.overwrite(topScopeNode.start, topScopeNode.end, imptStatement + declaration)
            break

          default:
            throw new Error(`Unknown TopScopeType: ${topScopeNode}`)
        }
      } else if (dynamic === 'dynamic') {
        let resolved: Resolved
        let glob = await dynamicImportToGlob(
          // `require` should have only one parameter
          node.arguments[0],
          code.slice(node.start, node.end),
          async (_glob) => {
            // It's relative or absolute path
            if (/^[\.\/]/.test(_glob)) {
              return
            }

            resolved = await this.resolve.tryResolve(_glob, importer)
            if (!resolved) return

            _glob = resolved.import.resolved

            // EXT for bypass restrict
            return path.extname(_glob) ? _glob : _glob + this.EXT
          },
        )
        if (!glob) return

        glob = tryFixGlobSlash(glob)
        this.options.depth !== false && (glob = toDepthGlob(glob))

        let fileGlob: string
        if (glob.endsWith(this.EXT)) {
          glob = glob.replace(this.EXT, '')
          // If not ext is not specified, fill necessary extensions
          // e.g.
          //   `./foo/*` -> `./foo/*.{js,ts,vue,...}`
          fileGlob = glob + `.{${this.options.extensions.map(e => e.replace(/^\./, '')).join(',')}}`
        } else {
          fileGlob = glob
        }

        const result = fastGlob.sync(fileGlob, { cwd: path.dirname(importer) })
        let paths = result.map(file => !file.startsWith('.') ? `./${file}` : file)
        // TODO: execute the Options.onFiles

        if (!paths.length) continue

        const entries: Record</* localFilename */string, /* Array<possible importee> */string[]> = {}
        for (const p of paths) {
          let importee = p
          if (resolved) {
            const static1 = resolved.import.importee.slice(0, resolved.import.importee.indexOf('*'))
            const static2 = resolved.import.resolved.slice(0, resolved.import.resolved.indexOf('*'))
            // Recovery alias `./views/*` -> `@/views/*`
            importee = p.replace(static2, static1)
          }
          const ext = path.extname(importee)

          entries[p] = [importee.replace(ext, ''), importee]
          if (importee.endsWith(`/index${ext}`)) {
            entries[p].unshift(importee.replace(`/index${ext}`, ''))
          }
        }

        const runtimeFnName = `__matchRequireRuntime${counter}__`
        let counter2 = 0
        const cases: string[] = []
        for (const [localFile, importeeList] of Object.entries(entries)) {
          let dynamic_require2import: string
          const cache = importCache.get(localFile)
          if (cache) {
            dynamic_require2import = cache
          } else {
            dynamic_require2import = `__dynamic_require2import__${counter}__${counter2++}`
            importCache.set(localFile, dynamic_require2import)
            promotionImports.push(`import * as ${dynamic_require2import} from '${localFile}'`)
          }
          cases.push(importeeList
            .map(importee => `    case '${importee}':`)
            .concat(`      return ${dynamic_require2import};`)
            .join('\n'))
        }
        ms.overwrite(node.callee.start, node.callee.end, runtimeFnName)
        runtimeFunctions.push(`function ${runtimeFnName}(path) {
  switch(path) {
${cases.join('\n')}
    default: throw new Error("Cann't found module: " + path);
  }
}`)
      } else {
        promotionImports.push(`import * as ${require2import} from '${requireId}'`)
        ms.overwrite(node.start, node.end, require2import)
      }
    }

    if (promotionImports.length) {
      ms.prepend([
        '/* import-promotion-S */',
        ...promotionImports.map(i => i + ';'),
        '/* import-promotion-E */',
      ].join(' '))
    }
    if (runtimeFunctions.length) {
      ms.append([
        '// ---- dynamic require runtime functions --S--',
        ...runtimeFunctions,
        '// ---- dynamic require runtime functions --E--',
      ].join('\n'))
    }

    const str = ms.toString()
    return str === code ? null : str
  }
}

// In some cases, glob may not be available
// e.g. (fill necessary slash)
//   `./foo*` -> `./foo/*`
//   `./foo*.js` -> `./foo/*.js`
function tryFixGlobSlash(glob: string): string {
  return glob.replace(/(?<![\*\/])(\*)/g, '/$1')
}

// Match as far as possible
// e.g.
//   `./foo/*` -> `./foo/**/*`
//   `./foo/*.js` -> `./foo/**/*.js`
function toDepthGlob(glob: string): string {
  return glob.replace(/^(.*)\/\*(?!\*)/, '$1/**/*')
}
