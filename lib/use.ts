/* Copyright © 2020 Richard Rodger and other contributors, MIT License. */
/* $lab:coverage:off$ */
'use strict'

const Uniq: any = require('lodash.uniq')
const Eraro: any = require('eraro')

import Nua from 'nua'
import { Ordu, TaskSpec } from 'ordu'


// TODO: refactor: use.js->plugin.js and contain *_plugin api methods too
const Common: any = require('./common')
const Print: any = require('./print')

/* $lab:coverage:on$ */


exports.api_use = api_use


const intern = exports.intern = make_intern()


function api_use(callpoint: any) {
  const tasks = make_tasks()
  const ordu = new Ordu({ debug: true })

  ordu.operator('seneca_plugin', tasks.op.seneca_plugin)
  ordu.operator('seneca_export', tasks.op.seneca_export)
  ordu.operator('seneca_options', tasks.op.seneca_options)


  // TODO: exports -> meta and handle all meta processing

  ordu.add([
    tasks.args,
    tasks.load,
    tasks.normalize,
    tasks.preload,
    { name: 'pre_meta', exec: tasks.meta },
    { name: 'pre_legacy_extend', exec: tasks.legacy_extend },
    tasks.delegate,
    tasks.call_define,
    tasks.options,
    tasks.define,
    { name: 'post_meta', exec: tasks.meta },
    { name: 'post_legacy_extend', exec: tasks.legacy_extend },
    // TODO: prepare (init)
    function complete() {
      //console.log('COMPLETE')
    },
  ])

  return {
    use: make_use(ordu, callpoint),
    ordu,
    tasks,
  }
}



interface UseCtx {
  seq: { index: number }
  args: string[]
  seneca: any,
  callpoint: any
}

// TODO: not satisfactory
interface UseData {
  seq: number
  args: string[]
  plugin: any
  meta: any
  delegate: any
  plugin_done: any
  exports: any
}





function make_use(ordu: any, callpoint: any) {
  let seq = { index: 0 }

  return function use() {
    let self = this
    let args = [...arguments]

    if (0 === args.length) {
      throw self.error('use_no_args')
    }

    let ctx: UseCtx = {
      seq: seq,
      args: args,
      seneca: this,
      callpoint: callpoint(true)
    }
    let data: UseData = {
      seq: -1,
      args: [],
      plugin: null,
      meta: null,
      delegate: null,
      plugin_done: null,
      exports: {},
    }

    async function run() {
      // NOTE: don't wait for result!

      //let pn: string = (ctx.args[0] as any).name

      // TODO: set runid to indicate plugin fullname + time
      //console.log('USE AAA', pn)//, ctx.seneca.order.plugin.tasks().length)
      //var resp =
      await ordu.exec(ctx, data, {
        done: function(res: any) {
          //console.log('RES-DONE', pn, res.err)

          if (res.err) {
            //self.die(self.private$.error(res.err, 'plugin_' + res.err.code))
            var err = res.err.seneca ? res.err :
              self.private$.error(res.err, res.err.code)
            self.die(err)
          }
        }
      })

      //console.log('RESP', pn, resp.err)
      //console.dir((resp.tasklog as any[]).map((x): any => [x.name, x.op, x.result.err]), { depth: null })
    }

    run()

    return self
  }
}

function make_tasks(): any {
  return {
    // TODO: explicit tests for these operators

    op: {
      seneca_plugin: (tr: any, ctx: any, data: any): any => {
        Nua(data, tr.out.merge, { preserve: true })
        ctx.seneca.private$.plugins[data.plugin.fullname] = tr.out.plugin
        return { stop: false }
      },

      seneca_export: (tr: any, ctx: any, data: any): any => {
        Object.assign(data.exports, tr.out.exports)
        Object.assign(ctx.seneca.private$.exports, tr.out.exports)
        return { stop: false }
      },

      seneca_options: (tr: any, ctx: any, data: any): any => {
        Nua(data.plugin, tr.out.plugin, { preserve: true })

        let plugin_fullname: string = data.plugin.fullname
        let plugin_options = data.plugin.options

        let plugin_options_update: any = { plugin: {} }
        plugin_options_update.plugin[plugin_fullname] = plugin_options

        ctx.seneca.options(plugin_options_update)

        return { stop: false }
      },
    },


    // TODO: args validation?
    args: (spec: TaskSpec) => {
      let args: any[] = [...spec.ctx.args]

      // DEPRECATED: Remove when Seneca >= 4.x
      // Allow chaining with seneca.use('options', {...})
      // see https://github.com/rjrodger/seneca/issues/80
      if ('options' === args[0]) {
        spec.ctx.seneca.options(args[1])
        return {
          op: 'stop',
          why: 'legacy-options'
        }
      }

      // Plugin definition function is under property `define`.
      // `init` is deprecated from 4.x
      // TODO: use-plugin expects `init` - update use-plugin to make this customizable
      if (null != args[0] && 'object' === typeof args[0]) {
        args[0].init = args[0].define || args[0].init
      }

      return {
        op: 'merge',
        out: { plugin: { args } }
      }
    },


    load: (spec: TaskSpec) => {
      let args: string[] = spec.data.plugin.args
      let seneca: any = spec.ctx.seneca
      let private$: any = seneca.private$

      // TODO: use-plugin needs better error message for malformed plugin desc
      var desc = private$.use.build_plugin_desc(...args)

      if (private$.ignore_plugins[desc.full]) {
        seneca.log.info({
          kind: 'plugin',
          case: 'ignore',
          plugin_full: desc.full,
          plugin_name: desc.name,
          plugin_tag: desc.tag,
        })

        return {
          op: 'stop',
          why: 'ignore'
        }
      }
      else {
        let plugin: any = private$.use.use_plugin_desc(desc)

        return {
          op: 'merge',
          out: {
            plugin
          }
        }
      }
    },


    normalize: (spec: TaskSpec) => {
      let plugin: any = spec.data.plugin

      var modify: any = {}

      // NOTE: `define` is the property for the plugin definition action.
      // The property `init` will be deprecated in 4.x
      modify.define = plugin.define || plugin.init

      modify.fullname = Common.make_plugin_key(plugin)

      modify.loading = true

      return {
        op: 'merge',
        out: { plugin: modify }
      }
    },


    preload: (spec: TaskSpec) => {
      let seneca: any = spec.ctx.seneca

      let plugin: any = spec.data.plugin

      let so: any = seneca.options()

      // Don't reload plugins if load_once true.
      if (so.system.plugin.load_once) {
        if (seneca.has_plugin(plugin)) {
          return {
            op: 'stop',
            why: 'already-loaded',
            out: {
              plugin: {
                loading: false
              }
            }
          }
        }
      }

      let meta: any = {}

      if ('function' === typeof plugin.define.preload) {
        // TODO: need to capture errors
        meta = plugin.define.preload.call(seneca, plugin) || {}
      }

      let name = meta.name || plugin.name
      let fullname = Common.make_plugin_key(name, plugin.tag)

      return {
        op: 'seneca_plugin',
        out: {
          merge: {
            meta,
            plugin: {
              name,
              fullname
            }
          },
          plugin
        }
      }
    },


    meta: (spec: TaskSpec) => {
      let seneca: any = spec.ctx.seneca
      let plugin: any = spec.data.plugin
      let meta: any = spec.data.meta

      let exports: any = {}
      exports[plugin.name] = meta.export || plugin
      exports[plugin.fullname] = meta.export || plugin

      let exportmap: any = meta.exportmap || meta.exports || {}

      Object.keys(exportmap).forEach(k => {
        let v: any = exportmap[k]
        if (void 0 !== v) {
          let exportname = plugin.fullname + '/' + k
          exports[exportname] = v
        }
      })


      if (meta.order) {
        if (meta.order.plugin) {
          let tasks: any[] =
            Array.isArray(meta.order.plugin) ? meta.order.plugin :
              [meta.order.plugin]

          //console.log('AAA', spec.task.name, tasks)
          //try {
          seneca.order.plugin.add(tasks)
          //}
          //catch (e) {
          //  console.log(e)
          //}
          delete meta.order.plugin
        }
      }

      return {
        op: 'seneca_export',
        out: {
          exports
        }
      }
    },


    // NOTE: mutates spec.ctx.seneca
    legacy_extend: (spec: TaskSpec) => {
      let seneca: any = spec.ctx.seneca

      // let plugin: any = spec.data.plugin
      let meta: any = spec.data.meta

      if ('object' === typeof meta.extend) {
        if ('function' === typeof meta.extend.action_modifier) {
          seneca.private$.action_modifiers.push(meta.extend.action_modifier)
        }

        // FIX: needs to use logging.load_logger
        if ('function' === typeof meta.extend.logger) {
          if (
            !meta.extend.logger.replace &&
            'function' === typeof seneca.private$.logger.add
          ) {
            seneca.private$.logger.add(meta.extend.logger)
          } else {
            seneca.private$.logger = meta.extend.logger
          }
        }
      }

      //seneca.register(plugin, meta)
    },


    delegate: (spec: TaskSpec) => {
      let seneca: any = spec.ctx.seneca
      let plugin: any = spec.data.plugin

      //var delegate = make_delegate(seneca, plugin)


      // Adjust Seneca API to be plugin specific.
      var delegate = seneca.delegate({
        plugin$: {
          name: plugin.name,
          tag: plugin.tag,
        },

        fatal$: true,
      })

      delegate.private$ = Object.create(seneca.private$)
      delegate.private$.ge = delegate.private$.ge.gate()

      delegate.die = Common.makedie(delegate, {
        type: 'plugin',
        plugin: plugin.name,
      })

      var actdeflist: any = []

      delegate.add = function() {
        // TODO: modernize
        var argsarr = new Array(arguments.length)
        for (var l = 0; l < argsarr.length; ++l) {
          argsarr[l] = arguments[l]
        }

        var actdef = argsarr[argsarr.length - 1] || {}

        if ('function' === typeof actdef) {
          actdef = {}
          argsarr.push(actdef)
        }

        actdef.plugin_name = plugin.name || '-'
        actdef.plugin_tag = plugin.tag || '-'
        actdef.plugin_fullname = plugin.fullname

        // TODO: is this necessary?
        actdef.log = delegate.log

        actdeflist.push(actdef)

        seneca.add.apply(delegate, argsarr)

        // FIX: should be this
        return delegate
      }

      delegate.__update_plugin__ = function(plugin: any) {
        delegate.context.name = plugin.name || '-'
        delegate.context.tag = plugin.tag || '-'
        delegate.context.full = plugin.fullname || '-'

        actdeflist.forEach(function(actdef: any) {
          actdef.plugin_name = plugin.name || actdef.plugin_name || '-'
          actdef.plugin_tag = plugin.tag || actdef.plugin_tag || '-'
          actdef.plugin_fullname = plugin.fullname || actdef.plugin_fullname || '-'
        })
      }

      delegate.init = function(init: any) {
        // TODO: validate init_action is function

        var pat: any = {
          role: 'seneca',
          plugin: 'init',
          init: plugin.name,
        }

        if (null != plugin.tag && '-' != plugin.tag) {
          pat.tag = plugin.tag
        }

        delegate.add(pat, function(_: any, reply: any): any {
          init.call(this, reply)
        })
      }

      delegate.context.plugin = plugin
      delegate.context.plugin.mark = Math.random()


      return {
        op: 'merge',
        out: {
          delegate
        }
      }
    },


    call_define: (spec: TaskSpec) => {
      let plugin: any = spec.data.plugin
      let delegate: any = spec.data.delegate

      // FIX: mutating context!!!
      var seq: number = spec.ctx.seq.index++


      var plugin_define_pattern: any = {
        role: 'seneca',
        plugin: 'define',
        name: plugin.name,
        seq: seq,
      }

      if (plugin.tag !== null) {
        plugin_define_pattern.tag = plugin.tag
      }

      return new Promise(resolve => {

        // seneca
        delegate.add(plugin_define_pattern, (_: any, reply: any) => {
          resolve({
            op: 'merge',
            out: { seq, plugin_done: reply }
          })
        })

        delegate.act({
          role: 'seneca',
          plugin: 'define',
          name: plugin.name,
          tag: plugin.tag,
          seq: seq,
          default$: {},
          fatal$: true,
          local$: true,
        })
      })
    },


    options: (spec: TaskSpec) => {
      let plugin: any = spec.data.plugin
      let delegate: any = spec.data.delegate

      let so = delegate.options()

      let fullname = plugin.fullname
      let defaults = plugin.defaults || {}

      let fullname_options = Object.assign(
        {},

        // DEPRECATED: remove in 4
        so[fullname],

        so.plugin[fullname],

        // DEPRECATED: remove in 4
        so[fullname + '$' + plugin.tag],

        so.plugin[fullname + '$' + plugin.tag]
      )

      var shortname = fullname !== plugin.name ? plugin.name : null
      if (!shortname && fullname.indexOf('seneca-') === 0) {
        shortname = fullname.substring('seneca-'.length)
      }

      var shortname_options = Object.assign(
        {},

        // DEPRECATED: remove in 4
        so[shortname],

        so.plugin[shortname],

        // DEPRECATED: remove in 4
        so[shortname + '$' + plugin.tag],

        so.plugin[shortname + '$' + plugin.tag]
      )

      let base: any = {}

      // NOTE: plugin error codes are in their own namespaces
      // TODO: test this!!!
      let errors = plugin.errors || (plugin.define && plugin.define.errors)

      if (errors) {
        base.errors = errors
      }

      let outopts = Object.assign(
        base,
        shortname_options,
        fullname_options,
        plugin.options || {}
      )

      let resolved_options: any = {}

      //console.log('oAAA', delegate.util.Joi.isSchema(defaults))


      // TODO: expose this on plugin
      let joi_schema: any = intern.prepare_spec(
        delegate.util.Joi,
        defaults,
        { allow_unknown: true },
        {}
      )

      //console.log('oBBB', joi_schema === defaults)


      let joi_out = joi_schema.validate(outopts)


      //console.log('oCCC', joi_out)

      let err: Error | undefined = void 0

      if (joi_out.error) {
        err = delegate.error('invalid_plugin_option', {
          name: fullname,
          err_msg: joi_out.error.message,
          options: outopts,
        })
        //console.log('oDDD', err)
      }
      else {
        resolved_options = joi_out.value
      }

      return {
        op: 'seneca_options',
        err: err,
        out: {
          plugin: {
            options: resolved_options,
            options_schema: joi_schema
          }
        }
      }
    },


    // TODO: move data modification to returned operation
    define: (spec: TaskSpec) => {
      let seneca: any = spec.ctx.seneca
      let so: any = seneca.options()

      let plugin: any = spec.data.plugin
      let plugin_done: any = spec.data.plugin_done

      var plugin_seneca: any = spec.data.delegate
      var plugin_options: any = spec.data.plugin.options

      plugin_seneca.log.debug({
        kind: 'plugin',
        case: 'DEFINE',
        name: plugin.name,
        tag: plugin.tag,
        options: plugin_options,
        callpoint: spec.ctx.callpoint,
      })

      var meta = intern.define_plugin(
        plugin_seneca,
        plugin,
        seneca.util.clean(plugin_options)
      )


      plugin.meta = meta

      // legacy api for service function
      if ('function' === typeof meta) {
        meta = { service: meta }
      }

      // Plugin may have changed its own name dynamically

      plugin.name = meta.name || plugin.name
      plugin.tag =
        meta.tag || plugin.tag || (plugin.options && plugin.options.tag$)

      plugin.fullname = Common.make_plugin_key(plugin)
      plugin.service = meta.service || plugin.service

      plugin_seneca.__update_plugin__(plugin)

      seneca.private$.plugins[plugin.fullname] = plugin

      seneca.private$.plugin_order.byname.push(plugin.name)
      seneca.private$.plugin_order.byname = Uniq(
        seneca.private$.plugin_order.byname
      )
      seneca.private$.plugin_order.byref.push(plugin.fullname)

      var exports = (spec.data as any).exports

      // 3.x Backwards compatibility - REMOVE in 4.x
      if ('amqp-transport' === plugin.name) {
        seneca.options({ legacy: { meta: true } })
      }

      if ('function' === typeof plugin_options.defined$) {
        plugin_options.defined$(plugin)
      }

      // TODO: split out form here into separate task: call_init

      // If init$ option false, do not execute init action.
      if (false === plugin_options.init$) {
        plugin_done()
        //return resolve()
      }

      plugin_seneca.log.debug({
        kind: 'plugin',
        case: 'INIT',
        name: plugin.name,
        tag: plugin.tag,
        exports: exports,
      })


      plugin_seneca.act(
        {
          role: 'seneca',
          plugin: 'init',
          seq: spec.data.seq,
          init: plugin.name,
          tag: plugin.tag,
          default$: {},
          fatal$: true,
          local$: true,
        },
        function(err: any) {
          //try {
          if (err) {
            var plugin_err_code = 'plugin_init'

            plugin.plugin_error = err.message

            if (err.code === 'action-timeout') {
              plugin_err_code = 'plugin_init_timeout'
              plugin.timeout = so.timeout
            }

            return plugin_seneca.die(
              //internals.error(err, plugin_err_code, plugin)
              seneca.error(err, plugin_err_code, plugin)
            )
          }

          var fullname = plugin.name + (plugin.tag ? '$' + plugin.tag : '')

          if (so.debug.print && so.debug.print.options) {
            Print.plugin_options(seneca, fullname, plugin_options)
          }

          plugin_seneca.log.info({
            kind: 'plugin',
            case: 'READY',
            name: plugin.name,
            tag: plugin.tag,
          })

          if ('function' === typeof plugin_options.inited$) {
            plugin_options.inited$(plugin)
          }

          plugin_done()
        }
      )

      // TODO: test this, with preload, explicitly
      return {
        op: 'merge',
        out: {
          meta,
        }
      }

    },
  }
}


function make_intern() {
  return {
    define_plugin: function(delegate: any, plugin: any, options: any): any {
      // legacy plugins
      if (plugin.define.length > 1) {
        let fnstr = plugin.define.toString()
        plugin.init_func_sig = (fnstr.match(/^(.*)\r*\n/) || [])[1]
        let ex = delegate.error('unsupported_legacy_plugin', plugin)
        throw ex
      }

      if (options.errors) {
        plugin.eraro = Eraro({
          package: 'seneca',
          msgmap: options.errors,
          override: true,
        })
      }

      var meta

      try {
        meta = plugin.define.call(delegate, options) || {}
      } catch (e) {
        Common.wrap_error(e, 'plugin_define_failed', {
          fullname: plugin.fullname,
          message: (
            e.message + (' (' + e.stack.match(/\n.*?\n/)).replace(/\n.*\//g, '')
          ).replace(/\n/g, ''),
          options: options,
          repo: plugin.repo ? ' ' + plugin.repo + '/issues' : '',
        })
      }

      meta = 'string' === typeof meta ? { name: meta } : meta
      meta.options = meta.options || options

      var updated_options: any = {}
      updated_options[plugin.fullname] = meta.options
      delegate.options(updated_options)

      return meta
    },


    // copied from https://github.com/rjrodger/optioner
    // TODO: remove unnecessary vars+code
    prepare_spec: function(Joi: any, spec: any, opts: any, ctxt: any) {
      if (Joi.isSchema(spec)) {
        return spec
      }

      var joiobj = Joi.object()

      if (opts.allow_unknown) {
        joiobj = joiobj.unknown()
      }

      var joi = intern.walk(
        Joi,
        joiobj,
        spec,
        '',
        opts,
        ctxt,
        function(valspec: any) {
          if (valspec && Joi.isSchema(valspec)) {
            return valspec
          } else {
            var typecheck = typeof valspec
            //typecheck = 'function' === typecheck ? 'func' : typecheck

            if (opts.must_match_literals) {
              return Joi.any()
                .required()
                .valid(valspec)
            } else {
              if (void 0 === valspec) {
                return Joi.any().optional()
              } else if (null == valspec) {
                return Joi.any().default(null)
              } else if ('number' === typecheck && Number.isInteger(valspec)) {
                return Joi.number()
                  .integer()
                  .default(valspec)
              } else if ('string' === typecheck) {
                return Joi.string()
                  .empty('')
                  .default(() => valspec)
              } else {
                return Joi[typecheck]().default(() => valspec)
              }
            }
          }
        })

      return joi
    },


    // copied from https://github.com/rjrodger/optioner
    // TODO: remove unnecessary vars+code
    walk: function(
      Joi: any,
      start_joiobj: any,
      obj: any,
      path: any,
      opts: any,
      ctxt: any,
      mod: any) {

      let joiobj = start_joiobj

      // NOTE: use explicit Joi construction for checking within arrays
      if (Array.isArray(obj)) {
        return Joi.array()
      }
      else {
        for (var p in obj) {
          var v = obj[p]
          var t = typeof v

          var kv: any = {}

          if (null != v && !Joi.isSchema(v) && 'object' === t) {
            var np = '' === path ? p : path + '.' + p

            let childjoiobj = Joi.object().default()

            if (opts.allow_unknown) {
              childjoiobj = childjoiobj.unknown()
            }

            kv[p] = intern.walk(Joi, childjoiobj, v, np, opts, ctxt, mod)
          } else {
            kv[p] = mod(v)
          }

          joiobj = joiobj.keys(kv)
        }

        return joiobj
      }
    }
  }
}
