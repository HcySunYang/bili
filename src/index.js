import util from 'util'
import path from 'path'
import globby from 'globby'
import chalk from 'chalk'
import { rollup, watch } from 'rollup'
import readPkg from 'read-pkg-up'
import camelcase from 'camelcase'
import prettyBytes from 'pretty-bytes'
import gzipSize from 'gzip-size'
import stringWidth from 'string-width'
import boxen from 'boxen'
import nodeResolvePlugin from 'rollup-plugin-node-resolve'
import commonjsPlugin from 'rollup-plugin-commonjs'
import jsonPlugin from 'rollup-plugin-json'
import uglifyPlugin from 'rollup-plugin-uglify'
import aliasPlugin from 'rollup-plugin-alias'
import replacePlugin from 'rollup-plugin-replace'
import hashbangPlugin from 'rollup-plugin-hashbang'
import textTable from 'text-table'
import template from './template'
import getBanner from './get-banner'
import { getBabelConfig } from './get-config'
import BiliError from './bili-error'
import { handleError, getDocRef } from './handle-error'

const FORMATS = ['cjs']

export default class Bili {
  static async generate(options) {
    const bundle = await new Bili(options).bundle({ write: false })
    return bundle
  }

  static async write(options) {
    const bundle = await new Bili(options).bundle()

    if (!options.watch) {
      console.log(await bundle.stats())
    }

    return bundle
  }

  static handleError(err) {
    return handleError(err)
  }

  constructor(options = {}) {
    this.options = {
      outDir: 'dist',
      filename: '[name][suffix].js',
      uglifyEs: true,
      cwd: process.cwd(),
      ...options
    }
    this.bundles = {}
  }

  async stats() {
    const { bundles } = this
    const sizes = await Promise.all(Object.keys(bundles)
      .sort()
      .map(async filepath => {
        const { code, relative } = bundles[filepath]
        return [
          relative,
          prettyBytes(code.length),
          chalk.green(prettyBytes(await gzipSize(code)))
        ]
      }))

    return boxen(textTable(
      [['file', 'size', 'gzip size'].map(v => chalk.bold(v)), ...sizes],
      {
        stringLength: stringWidth
      }
    ))
  }

  getArrayOption(name) {
    const option = this.options[name] || this.options[`${name}s`]
    if (typeof option === 'string') return option.split(',')
    return option
  }

  resolveCwd(...args) {
    return path.resolve(this.options.cwd, ...args)
  }

  relativeToProcessCwd(...args) {
    return path.relative(process.cwd(), this.resolveCwd(...args))
  }

  loadUserPlugins({ filename }) {
    const plugins = this.getArrayOption('plugin') || []
    // eslint-disable-next-line array-callback-return
    return plugins.map(pluginName => {
      // In bili.config.js or you're using the API
      // You can require rollup plugin directly
      if (typeof pluginName === 'object') {
        return pluginName
      }

      let pluginOptions = this.options[pluginName]
      if (pluginName === 'vue') {
        pluginOptions = {
          css: path.resolve(
            this.options.outDir,
            filename.replace(/\.[^.]+$/, '.css')
          ),
          ...pluginOptions
        }
      } else if (pluginName === 'postcss') {
        pluginOptions = {
          extract: true,
          ...pluginOptions
        }
      }
      const moduleName = `rollup-plugin-${pluginName}`
      try {
        // TODO:
        // Local require is always relative to `process.cwd()`
        // Instead of `this.options.cwd`
        // We need to ensure that which is actually better
        return localRequire(moduleName)(pluginOptions)
      } catch (err) {
        handleLoadPluginError(moduleName, err)
      }
    })
  }

  async createConfig({ input, format, compress }) {
    const { outDir, filename, inline = format === 'umd' } = this.options

    const outFilename = getFilename({
      input,
      format,
      filename,
      compress,
      name: this.options.name
    })
    // The path to output file
    // Relative to `this.options.cwd`
    const file = this.resolveCwd(outDir, outFilename)

    const jsPluginName = this.options.js || 'buble'
    const jsPlugin = getJsPlugin(jsPluginName)
    const jsOptions = getJsOptions(
      jsPluginName,
      this.options.jsx,
      this.options[jsPluginName]
    )

    const banner = getBanner(this.options.banner, this.pkg)

    let external = this.getArrayOption('external') || []
    external = external.map(e => (e.startsWith('./') ? path.resolve(e) : e))
    let globals = this.options.globals || this.options.global
    if (typeof globals === 'object') {
      external = [...external, ...Object.keys(globals)]
    }

    const inputOptions = {
      input,
      external,
      onwarn: ({ loc, frame, message, code }) => {
        if (
          this.options.quiet ||
          code === 'UNRESOLVED_IMPORT' ||
          code === 'THIS_IS_UNDEFINED'
        ) {
          return
        }
        // print location if applicable
        if (loc) {
          console.warn(`${loc.file} (${loc.line}:${loc.column}) ${message}`)
          if (frame) console.warn(chalk.dim(frame))
        } else {
          console.warn('🙋‍♂️ ', message)
        }
      },
      plugins: [
        hashbangPlugin(),
        ...this.loadUserPlugins({ filename: outFilename }),
        jsPluginName === 'buble' &&
          require('rollup-plugin-babel')({
            babelrc: false,
            exclude: 'node_modules/**',
            presets: [
              [
                require.resolve('./babel'),
                {
                  buble: true,
                  jsx: this.options.jsx,
                  objectAssign: jsOptions.objectAssign
                }
              ]
            ]
          }),
        jsPlugin({
          exclude: 'node_modules/**',
          ...jsOptions
        }),
        inline && commonjsPlugin(),
        inline &&
          nodeResolvePlugin({
            module: true
          }),
        jsonPlugin(),
        compress &&
          uglifyPlugin(
            {
              ...this.options.uglify,
              output: {
                ...(this.options.uglify && this.options.uglify.output),
                // Add banner (if there is)
                preamble: banner
              }
            },
            this.options.uglifyEs ? require('uglify-es').minify : undefined
          ),
        this.options.alias && aliasPlugin(this.options.alias),
        this.options.replace && replacePlugin(this.options.replace),
        {
          name: 'bili',
          ongenerate: (_, { code }) => {
            this.bundles[file] = {
              relative: path.relative(path.resolve(outDir, '..'), file),
              input,
              format,
              compress,
              code
            }
          }
        },
        this.options.env &&
          replacePlugin({
            values: Object.keys(this.options.env).reduce((res, key) => {
              res[`process.env.${key}`] = JSON.stringify(this.options.env[key])
              return res
            }, {})
          })
      ].filter(v => Boolean(v))
    }

    const outputOptions = {
      format,
      globals,
      name: format === 'umd' && this.getModuleName(),
      file,
      banner,
      exports: this.options.exports,
      sourcemap:
        typeof this.options.map === 'boolean' ? this.options.map : compress
    }

    return {
      inputOptions,
      outputOptions
    }
  }

  async bundle({ write = true } = {}) {
    this.pkg = await readPkg({ cwd: this.options.cwd }).then(res => res.pkg || {})

    let inputFiles = this.options.input || 'src/index.js'
    if (Array.isArray(inputFiles) && inputFiles.length === 0) {
      inputFiles = 'src/index.js'
    }

    inputFiles = await globby(inputFiles, { cwd: this.options.cwd }).then(res =>
      res.map(v => this.relativeToProcessCwd(v)))

    if (inputFiles.length === 0) {
      throw new BiliError('No matched files to bundle.')
    }

    const formats = this.getArrayOption('format') || FORMATS

    const options = inputFiles.reduce(
      (res, input) => [
        ...res,
        ...formats.map(format => {
          const compress = format.endsWith('-min')
          return {
            input,
            format: format.replace(/-min$/, ''),
            compress
          }
        })
      ],
      []
    )

    const actions = options.map(async option => {
      const { inputOptions, outputOptions } = await this.createConfig(option)

      if (this.options.watch) {
        const watcher = watch({
          ...inputOptions,
          output: outputOptions,
          watch: {
            clearScreen: true
          }
        })
        watcher.on('event', async e => {
          if (e.code === 'ERROR' || e.code === 'FATAL') {
            handleError(e.error)
          }
          if (e.code === 'BUNDLE_END') {
            process.exitCode = 0
            console.log(`${e.input} -> ${path.relative(
              path.resolve(this.options.outDir || 'dist', '..'),
              outputOptions.file
            )}`)
          }
        })
        return
      }

      if (this.options.inspectRollup) {
        console.log(
          chalk.bold(`Rollup input options for bundling ${option.input} in ${
            option.format
          }:\n`),
          util.inspect(inputOptions, { colors: true })
        )
        console.log(
          chalk.bold(`Rollup output options for bundling ${option.input} in ${
            option.format
          }:\n`),
          util.inspect(outputOptions, { colors: true })
        )
      }

      const bundle = await rollup(inputOptions)
      if (write) return bundle.write(outputOptions)
      return bundle.generate(outputOptions)
    })
    await Promise.all(actions)

    // Since we update `this.bundles` in Rollup plugin's `ongenerate` callback
    // We have to put follow code into another callback to execute at th end of call stack
    await nextTick(() => {
      if (
        Object.keys(this.bundles).length <
        formats.length * inputFiles.length
      ) {
        const hasName = this.options.filename.includes('[name]')
        const hasSuffix = this.options.filename.includes('[suffix]')
        const msg = `Multiple files are emitting to the same path.\nPlease check if ${
          hasName || inputFiles.length === 1 ?
            '' :
            `${chalk.green('[name]')}${hasSuffix ? '' : ' or '}`
        }${
          hasSuffix ? '' : chalk.green('[suffix]')
        } is missing in ${chalk.green('filename')} option.\n${getDocRef(
          'api',
          'filename'
        )}`
        throw new BiliError(msg)
      }
    })

    return this
  }

  getModuleName() {
    return (
      this.options.moduleName ||
      this.pkg.moduleName ||
      (this.pkg.name && camelcase(this.pkg.name))
    )
  }
}

function getSuffix(format) {
  let suffix = ''
  switch (format) {
    case 'cjs':
      suffix += '.cjs'
      break
    case 'umd':
      break
    case 'es':
      suffix += '.m'
      break
    default:
      throw new Error('unsupported format')
  }
  return suffix
}

function getNameFromInput(input) {
  return path.basename(input, path.extname(input))
}

function getFilename({ input, format, filename, compress, name }) {
  name = name || getNameFromInput(input)
  const suffix = getSuffix(format)
  const res = template(filename, { name, suffix })
  return compress ?
    path.basename(res, path.extname(res)) + '.min' + path.extname(res) :
    res
}

function getJsOptions(name, jsx, jsOptions) {
  if (name === 'babel') {
    return {
      babelrc: !process.env.BILI_TEST,
      ...getBabelConfig({ jsx }),
      ...jsOptions
    }
  }

  if (name === 'buble') {
    return {
      // objectAssign: 'Object.assign',
      // We no longer need "objectAssign" for buble
      // Since we transform object rest spread with babel
      // And replace objectAssign there
      ...jsOptions,
      transforms: {
        dangerousForOf: true,
        dangerousTaggedTemplateString: true,
        ...(jsOptions && jsOptions.transforms)
      }
    }
  }

  return {}
}

function getJsPlugin(name) {
  const req = name === 'babel' || name === 'buble' ? require : localRequire
  const moduleName = `rollup-plugin-${name}`
  try {
    return req(moduleName)
  } catch (err) {
    handleLoadPluginError(moduleName, err)
  }
}

function localRequire(name) {
  return require(path.resolve('node_modules', name))
}

function handleLoadPluginError(moduleName, err) {
  if (err.code === 'MODULE_NOT_FOUND' && err.message.includes(moduleName)) {
    throw new BiliError(`Cannot find plugin "${moduleName}" in current directory!\n${chalk.dim(`You may run "npm install -D ${moduleName}" to install it.`)}`)
  } else {
    throw err
  }
}

function nextTick(fn) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        fn()
        resolve()
      } catch (err) {
        reject(err)
      }
    })
  })
}
