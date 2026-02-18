/**
 * MicroServer
 * @version 3.0.3
 * @package @radatek/microserver
 * @copyright Darius Kisonas 2022
 * @license MIT
 */

import http from 'http'
import https from 'https'
import net from 'net'
import tls from 'tls'
import querystring from 'querystring'
import { Readable } from 'stream'
import fs from 'fs'
import path, { basename, extname } from 'path'
import crypto from 'crypto'
import zlib from 'zlib'
import { EventEmitter } from 'events'
import { nextTick } from 'process'

const defaultToken = 'wx)>:ZUqVc+E,u0EmkPz%ZW@TFDY^3vm'
const defaultExpire = 24 * 60 * 60
const defaultMaxBodySize = 5 * 1024 * 1024
const defaultMethods = 'HEAD,GET,POST,PUT,PATCH,DELETE'
const defaultMaxFileSize = 20 * 1024 * 1024

function NOOP (...args: any[]) { }

function isFunction (fn: any): boolean {
  if (typeof fn !== 'function')
    return false
  const descriptor = Object.getOwnPropertyDescriptor(fn, 'prototype')
  return !descriptor || descriptor.writable === true
}

export class Warning extends Error {
  constructor (text: string) {
    super(text)
  }
}

const commonCodes: {[key: number]: string} = { 404: 'Not found', 403: 'Access denied', 405: 'Not allowed', 422: 'Invalid data'}
const commonTexts: {[key: string]: number} = {'Not found': 404, 'Access denied': 403, 'Not allowed': 405, 'Permission denied': 422, 'Invalid data': 422, InvalidData: 422, AccessDenied: 403, NotFound: 404, NotAllowed: 405, Failed: 422, OK: 200 }
export class ResponseError extends Error {
  static getStatusCode(text: string | number | undefined): number { return typeof text === 'number' ? text : text && commonTexts[text] || 500 }
  static getStatusText(text: string | number | undefined): string { return typeof text === 'number' ? commonCodes[text] : text?.toString() || 'Error' }
  statusCode: number
  constructor (text: string | number | undefined, statusCode?: number) {
    super(ResponseError.getStatusText(text || statusCode || 500))
    this.statusCode = ResponseError.getStatusCode(statusCode || text) || 500
  }
}

export class AccessDenied extends ResponseError {
  constructor (text?: string) { super(text, 403) }
}

export class InvalidData extends ResponseError {
  constructor (text?: string, type?: string) {
    super(type ? text ? `Invalid ${type}: ${text}` : `Invalid ${type}` : text, 422)
  }
}

export class NotFound extends ResponseError {
  constructor (text?: string) { super(text, 404) }
}

export class WebSocketError extends Error {
  statusCode: number
  constructor (text?: string, code?: number) {
    super(text)
    this.statusCode = code || 1002
  }
}

type DeferPromise<T = void> = Promise<T> & { resolve: (res?: T | Error) => void }
function deferPromise<T = void>(cb?: (res?: T | Error) => void): DeferPromise<T> {
  let _resolve!: (res?: T | Error) => void
  const p: Promise<T> & { resolve: (res?: T | Error) => void } = new Promise((resolve) => {
    _resolve = (res?: T | Error) => {
      cb?.(res)
      resolve(res as T)
    }
  }) as DeferPromise<T>
  p.resolve = _resolve
  return p
}

/** Middleware */
export interface Middleware {
  (req: ServerRequest, res: ServerResponse, next: Function): any;
  /** @default 0 */
  priority?: number;
  plugin?: Plugin;
}

export abstract class Plugin {
  name?: string
  priority?: number
  handler?(req: ServerRequest, res: ServerResponse, next: Function): Promise<string | object | void> | string | object | void
  routes?(): Promise<RoutesSet|void> | RoutesSet | void
  constructor() { }
}

interface PluginClass {
  new(options: any, server: MicroServer): Plugin
}

export type ServerRequestBody<T = any> = T extends Model<infer U extends ModelSchema> ? ModelDocument<U> : Record<string, any>

// #region ServerRequest/ServerResponse

/** Extended http.IncomingMessage */
export class ServerRequest<T = any> extends http.IncomingMessage {
  /** Request client IP */
  public ip!: string
  /** Request from local network */
  public localip?: boolean
  /** Request is secure (https) */
  public secure?: boolean
  /** Request whole path */
  public path: string = '/'
  /** Request pathname */
  public pathname: string = '/'
  /** Base url */
  public baseUrl: string = '/'
  /** Original url */
  public originalUrl?: string
  /** Query parameters */
  public query!: Record<string, string>
  /** Router named parameters */
  public params!: Record<string, string>
  /** Router named parameters list */
  public paramsList!: string[]
  /** Router */
  public server!: MicroServer
  /** Authentication object */
  public auth?: Auth
  /** Authenticated user info */
  public user?: UserInfo
  /** Model used for request */
  public model?: T
  /** Authentication token id */
  public tokenId?: string

  /** Request raw body */
  public rawBody!: Buffer[]
  /** Request raw body size */
  public rawBodySize!: number

  private _body?: ServerRequestBody<T>
  private _isReady: DeferPromise | undefined
  
  private constructor (res: http.ServerResponse, server: MicroServer) {
    super(new net.Socket())
    ServerRequest.extend(this, res, server)
  }
  /** Extend http.IncomingMessage */
  static extend(req: http.IncomingMessage, res: http.ServerResponse, server: MicroServer): ServerRequest {
    const reqNew = Object.setPrototypeOf(req, ServerRequest.prototype) as ServerRequest
    let ip = req.socket.remoteAddress || '::1';
    if (ip.startsWith('::ffff:'))
      ip = ip.slice(7);
    Object.assign(reqNew, {
      server,
      ip,
      auth: server.auth,
      protocol: 'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http',
      query: {},
      params: {},
      paramsList: [],
      path: '/',
      pathname: '/',
      baseUrl: '/',
      rawBody: [],
      rawBodySize: 0
    })
    if (req.readable && !req.complete) {
      reqNew._isReady = deferPromise((err) => {
        reqNew._isReady = undefined
        if (err && res && !res.headersSent) {
          res.statusCode = 'statusCode' in err ? err.statusCode as number : 400
          res.end(http.STATUS_CODES[res.statusCode] || 'Error')
        }
      })
    }
    reqNew.updateUrl(req.url || '/')
    return reqNew
  }

  /** Check if request is ready */
  get isReady() {
    return this._isReady === undefined
  }

  /** Wait for request to be ready, usualy used to wait for file upload */
  async waitReady(): Promise<void> {
    if (this._isReady === undefined)
      return
    const res: any = await this._isReady
    if (res && res instanceof Error)
      throw res
  }

  /** Signal request as ready */
  setReady(err?: Error): void {
    this._isReady?.resolve(err)
  }

  /** Set request body */
  setBody(body: ServerRequestBody<T>): void {
    this._body = body
  }

  /** Update request url */
  updateUrl (url: string): this {
    this.url = url
    if (!this.originalUrl)
      this.originalUrl = url

    const parsedUrl = new URL(url || '/', 'body:/'), pathname = parsedUrl.pathname
    this.pathname = pathname
    this.path = pathname.slice(pathname.lastIndexOf('/'))
    this.baseUrl = pathname.slice(0, pathname.length - this.path.length)
    this.query = {}
    parsedUrl.searchParams.forEach((v, k) => this.query[k] = v)
    return this
  }

  /** Rewrite request url */
  rewrite (url: string): void {
    throw new Error('Internal error')
  }
  
  /** Request body: JSON or POST parameters */
  get body () {
    return this._body
  }

  /** Alias to body */
  get post () {
    return this.body
  }

  /** Get websocket */
  get websocket(): WebSocket {
    throw new Error('WebSocket not initialized')
  }

  /** get files list in request */
  async files (): Promise<UploadFile[] | undefined> {
    throw new Error('Upload not initialized')
  }
}

/** Extends http.ServerResponse */
export class ServerResponse<T = any> extends http.ServerResponse {
  declare readonly req: ServerRequest<T>
  /** Should response be json */
  public isJson!: boolean

  private constructor (server: MicroServer) {
    super(new http.IncomingMessage(new net.Socket()))
    ServerRequest.extend(this.req, this, server)
    ServerResponse.extend(this)
  }

  /** Extends http.ServerResponse */
  static extend (res: http.ServerResponse) {
    Object.setPrototypeOf(res, ServerResponse.prototype)
    Object.assign(res, {
      statusCode: 200,
      isJson: false
    })
  }

  /** Send error reponse */
  error (error: string | number | Error): void {
    let code: number = 0
    let text: string
    if (error instanceof Error) {
      if ('statusCode' in error)
        code = error.statusCode as number
      text = error.message
    } else if (typeof error === 'number') {
      code = error
      text = commonCodes[code] || 'Error'
    } else
      text = error.toString()
    if (!code && text) {
      code = ResponseError.getStatusCode(text)
      if (!code) {
        const m = text.match(/^(Error|Exception)?([\w ]+)(Error|Exception)?:\s*(.+)/i)
        if (m) {
          const errorId = m[2].toLowerCase()
          code = ResponseError.getStatusCode(m[1])
          text = m[2]
          if (!code) {
            if (errorId.includes('access'))
              code = 403
            else if (errorId.includes('valid') || errorId.includes('case') || errorId.includes('param') || errorId.includes('permission'))
              code = 422
            else if (errorId.includes('busy') || errorId.includes('timeout'))
              code = 408
          }
        }
      }
    }
    code = code || 500

    try {
      if (code === 400 || code === 413)
        this.setHeader('Connection', 'close')
  
      this.statusCode = code || 200
      if (code < 200 || code === 204 || (code >= 300 && code <= 399))
        return this.send()
  
      if (this.isJson && (code < 300 || code >= 400))
        this.send({ success: false, error: text ?? (commonCodes[this.statusCode] || http.STATUS_CODES[this.statusCode]) })
      else
        this.send(text != null ? text : (this.statusCode + ' ' + (commonCodes[this.statusCode] || http.STATUS_CODES[this.statusCode])))
    } catch (e) {
      this.status(500).send('Internal error')
      this.req.server.emit('error', e)
    }
  }
  
  /** Sets Content-Type acording to data and sends response */
  send (data: string | Buffer | Error | Readable | object = ''): void {
    if (this.headersSent)
      return
    if (typeof data === 'object' || this.isJson) {
      if (data instanceof Error)
        return this.error(data)
      if (data instanceof Readable)
        return (data.pipe(this, {end: true}), void 0)
      if (data instanceof Buffer) {
        this.setHeader('Content-Length', data.byteLength)
        if (this.statusCode === 304 || this.req.method === 'HEAD')
          this.end()
        else
          this.end(data)
        return
      }
      data = JSON.stringify(typeof data === 'string' ? { message: data } : data)
      this.setHeader('Content-Type', 'application/json')
    }
    data = data.toString()
    if (!this.getHeader('Content-Type')) {
      if (data[0] === '{' || data[1] === '[')
        this.setHeader('Content-Type', 'application/json')
      else if (data[0] === '<' && (data.startsWith('<!DOCTYPE') || data.startsWith('<html')))
        this.setHeader('Content-Type', 'text/html')
      else
        this.setHeader('Content-Type', 'text/plain')
    }
    this.setHeader('Content-Length', Buffer.byteLength(data, 'utf8'))
    if (this.statusCode === 304 || this.req.method === 'HEAD')
      this.end()
    else
      this.end(data, 'utf8')
  }

  /** Send json response */
  json (data: any) {
    this.isJson = true
    if (data instanceof Error)
      return this.error(data)
    this.send(data)
  }

  /** Send json response in form { success: false, error: err } */
  jsonError (error: string | number | object | Error): void {
    this.isJson = true
    if (typeof error === 'number')
      error = http.STATUS_CODES[error] || 'Error'
    if (error instanceof Error)
      return this.error(error)
    this.json(typeof error === 'string' ? { success: false, error } : { success: false, ...error })
  }
  
  /** Send json response in form { success: true, ... } */
  jsonSuccess (data?: object | string): void {
    this.isJson = true
    if (data instanceof Error)
      return this.error(data)
    this.json(typeof data === 'string' ? { success: true, message: data } : { success: true, ...data })
  }

  /** Send redirect response to specified URL with optional status code (default: 302) */
  redirect (code: number | string, url?: string): void {
    if (typeof code === 'string') {
      url = code
      code = 302
    }
    this.setHeader('Location', url || '/')
    this.setHeader('Content-Length', 0)
    this.statusCode = code || 302
    this.end()
  }

  /** Rewrite URL */
  rewrite (url: string): void {
    return this.req.rewrite(url)
  }

  /** Set status code */
  status (code: number): this {
    this.statusCode = code
    return this    
  }

  /** Send file */
  file (path: string | ServeFileOptions): void {
    throw new Error('Not implemented')
  }
}
// #endregion ServerRequest/ServerResponse

type RouteURL = `${Uppercase<string>} /${string}`|`/${string}`
type StringMiddleware = `response:json`|`response:html`|`response:end`|`redirect:${string}`|`error:${number}`|`param:${string}=${string}`|`acl:${string}`|`user:${string}`|`group:${string}`|`model:${string}`|`${string}=${string}`
type RoutesMiddleware = Middleware|Plugin|StringMiddleware|Promise<Middleware|Plugin>
type RoutesList = [RouteURL, ...Array<RoutesMiddleware>]|[RouteURL, ControllerClass|Promise<ControllerClass>]
type RoutesSet = Array<RoutesList|ControllerClass|Promise<ControllerClass>>|Record<RouteURL,RoutesList|ControllerClass|Promise<ControllerClass>|Middleware>

//** MicroServer configuration */
export interface MicroServerConfig extends ListenConfig {
  /** Auth options */
  auth?: AuthOptions
  /** routes to add */
  routes?: RoutesSet
  /** Static file options */
  static?: StaticFilesOptions
  /** max body size (default: 5MB) */
  body?: BodyOptions
  /** allowed HTTP methods */
  methods?: string
  /** trust proxy */
  trustproxy?: string[]
  /** cors options */
  cors?: string | CorsOptions | boolean
  /** upload dir */
  upload?: UploadOptions
  /** websocket options */
  websocket?: WebSocketOptions
  /** extra options for plugins */
  [key: string]: any
}

interface MicroServerEvents {
  ready: () => void
  close: () => void
  listen: (port: number, address: string, server: http.Server) => void
  error: (err: Error) => void
  [key: `plugin:${string}`]: (plugin: Plugin) => void
}

/** Lighweight HTTP server */
export class MicroServer extends EventEmitter {
  /** MicroServer configuration */
  public config: MicroServerConfig
  /** Authorization object */
  public auth?: Auth

  private _plugins: Record<string, Plugin> = {}
  private _stack: Middleware[] = []
  private _router: RouterPlugin = new RouterPlugin()
  private _worker: Worker = new Worker()
  
  /** All sockets */
  public sockets: Set<net.Socket> | undefined
  /** Server instances */
  public servers: Set<net.Server> | undefined

  /** @param {MicroServerConfig} [config] MicroServer configuration  */
  constructor (config?: MicroServerConfig) {
    super()
    this.config = config || {}
    this.use(this._router)
    if (config) {
      if (this.config.routes)
        this.use(this.config.routes)
      if (this.config.listen) {
        this._worker.startJob()
        nextTick(() => this.listen({listen: this.config.listen}).finally(() => this._worker.endJob()))
      }
    }
  }

  on<K extends keyof MicroServerEvents>(event: K, listener: MicroServerEvents[K]): this {
    if (event === 'ready' && this.isReady)
      (listener as Function)()
    super.on(event, listener)
    return this
  }
  addListener<K extends keyof MicroServerEvents>(event: K, listener: MicroServerEvents[K]): this { return super.addListener(event, listener) }
  once<K extends keyof MicroServerEvents>(event: K, listener: MicroServerEvents[K]): this {
    if (event === 'ready' && this.isReady)
      (listener as Function)()
    else
      super.once(event, listener)
    return this
  }
  off<K extends keyof MicroServerEvents>(event: K, listener: MicroServerEvents[K] ): this { return super.off(event, listener) }
  removeListener<K extends keyof MicroServerEvents>(event: K, listener: MicroServerEvents[K]): this { return super.removeListener(event, listener) }

  public get isReady(): boolean {
    return !this._worker.isBusy()
  }

  async waitReady (): Promise<void> {
    if (this.isReady)
      return
    return this._worker.wait()
  }

  /** Listen server, should be used only if config.listen is not set */
  async listen (config: ListenConfig): Promise<void> {
    if (!config && this.config.listen) {
      console.debug('listen automatically started from constructor')
      return
    }
    if (!config)
      throw new Error('listen config is required')
    const listen = (config?.listen || this.config.listen || 0) + ''
    const handler = config?.handler || this.handler.bind(this)
    const tlsConfig = config ? config.tls : this.config.tls

    const readFile = (data: string | undefined) => data && (data.indexOf('\n') > 0 ? data : fs.readFileSync(data))
    function tlsOptions(): tls.SecureContextOptions {
      return {
        cert: readFile(tlsConfig?.cert),
        key: readFile(tlsConfig?.key),
        ca: readFile(tlsConfig?.ca)
      }
    }
    function tlsOptionsReload(srv: tls.Server | https.Server) {
      if (tlsConfig?.cert && tlsConfig.cert.indexOf('\n') < 0) {
        let debounce: NodeJS.Timeout | undefined
        fs.watch(tlsConfig.cert, () => {
          clearTimeout(debounce)
          debounce = setTimeout(() => {
            debounce = undefined
            srv.setSecureContext(tlsOptions())
          }, 2000)
        })
      }
    }

    const reg = /^((?<proto>\w+):\/\/)?(?<host>(\[[^\]]+\]|[a-z][^:,]+|\d+\.\d+\.\d+\.\d+))?:?(?<port>\d+)?/
    listen.split(',').forEach(listen => {
      this._worker.startJob('listen')
      let {proto, host, port} = reg.exec(listen)?.groups || {}
      let srv: net.Server | http.Server | https.Server
      switch (proto) {
        case 'tcp':
          if (!config?.handler)
            throw new Error('Handler is required for tcp')
          srv = net.createServer(config.handler as TcpHandler)
          break
        case 'tls':
          if (!config?.handler)
            throw new Error('Handler is required for tls')
          srv = tls.createServer(tlsOptions(), config.handler as TcpHandler)
          tlsOptionsReload(srv as tls.Server)
          break
        case 'https':
          port = port || '443'
          srv = https.createServer(tlsOptions(), handler as any)
          tlsOptionsReload(srv as https.Server)
          break
        default:
          port = port || '80'
          srv = http.createServer(handler as any)
          break
      }
      if (!this.servers)
        this.servers = new Set()
      if (!this.sockets)
        this.sockets = new Set()
      this.servers.add(srv)
      if (port === '0') // skip listening
        this._worker.endJob('listen')
      else {
        srv.listen(parseInt(port), host?.replace(/[\[\]]/g, '') || '0.0.0.0', () => {
          const addr: net.AddressInfo = srv.address() as net.AddressInfo
          this.emit('listen', addr.port, addr.address, srv);
          (srv as any)._ready = true
          this._worker.endJob('listen')
        })
      }
      srv.on('error', err => {
        srv.close()
        this.servers!.delete(srv)
        if (!(srv as any)._ready)
          this._worker.endJob('listen')
        this.emit('error', err)
      })
      srv.on('connection', s => {
        this.sockets!.add(s)
        s.once('close', () => this.sockets!.delete(s))
      })
    })
    return this._worker.wait('listen')
  }

  /* bind middleware or create one from string like: 'redirect:302,https://redirect.to', 'error:422', 'param:name=value', 'acl:users/get', 'model:User', 'group:Users', 'user:admin' */
  private _bind (fn: RoutesMiddleware): Function {
    if (typeof fn === 'string') {
      let name = fn
      let idx = name.indexOf(':')
      if (idx < 0 && name.includes('=')) {
        name = 'param:' + name
        idx = 5
      }
      if (idx >= 0) {
        const v = name.slice(idx + 1)
        const type = name.slice(0, idx)

        // predefined middlewares
        switch (type) {
          case 'response': {
            if (v === 'json')
              return (req: ServerRequest, res: ServerResponse, next: Function) => {res.isJson = true; return next()}
            if (v === 'html')
              return (req: ServerRequest, res: ServerResponse, next: Function) => {res.setHeader('Content-Type', 'text/html'); return next()}
            if (v === 'end')
              return (req: ServerRequest, res: ServerResponse, next: Function) => {res.end()}
            break
          }
          // redirect:302,https://redirect.to
          case 'redirect': {
            let redirect = v.split(','), code = parseInt(v[0])
            if (!code || code < 301 || code > 399)
              code = 302
            return (req: ServerRequest, res: ServerResponse) => res.redirect(code, redirect[1] || v)
          }
          // error:422
          case 'error':
            return (req: ServerRequest, res: ServerResponse) => res.error(parseInt(v) || 422)
          // param:name=value
          case 'param': {
            idx = v.indexOf('=')
            if (idx > 0) {
              const prm = v.slice(0, idx), val = v.slice(idx + 1)
              return (req: ServerRequest, res: ServerResponse, next: Function) => { req.params[prm] = val; return next() }
            }
            break
          }
          case 'model': {
            const model = v
            return (req: ServerRequest, res: ServerResponse) => {
              res.isJson = true
              req.params.model = model
              req.model = (Model.models as any)[model]
              if (!req.model) {
                console.error(`Data model ${model} not defined for request ${req.path}`)
                return res.error(422)
              }
              return req.model.handler(req, res)
            }
          }
          // user:userid
          // group:user_groupid
          // acl:validacl
          case 'user':
          case 'group':
          case 'acl':
            return (req: ServerRequest, res: ServerResponse, next: Function) => {
              if (type === 'user' && v === req.user?.id)
                return next()
              if (type === 'acl') {
                req.params.acl = v
                if (req.auth?.acl(v))
                  return next()
              }
              if (type === 'group') {
                req.params.group = v
                if (req.user?.group === v)
                  return next()
              }
              const accept = req.headers.accept || ''
              if (!res.isJson && req.auth?.options.redirect && req.method === 'GET' && !accept.includes('json') && (accept.includes('html') || accept.includes('*/*'))) {
                if (req.auth.options.redirect && req.url !== req.auth.options.redirect)
                  return res.redirect(302, req.auth.options.redirect)
                else if (req.auth.options.mode !== 'cookie') {
                  res.setHeader('WWW-Authenticate', `Basic realm="${req.auth.options.realm}"`)
                  return res.error(401)
                }
              }
              return res.error('Permission denied')
            }
        }
      }
      throw new Error('Invalid option: ' + name)
    }
    if (fn && typeof fn === 'object' && 'handler' in fn && typeof fn.handler === 'function')
      return fn.handler.bind(fn)
    if (typeof fn !== 'function')
      throw new Error('Invalid middleware: ' + String.toString.call(fn))
    return fn.bind(this)
  }

  /** Default server handler */
  handler (req: ServerRequest, res: ServerResponse): void {
    ServerRequest.extend(req, res, this)
    ServerResponse.extend(res)
    this._router.walk(this._stack, req, res, () => res.error(404))
  }
  
  /** Clear routes and middlewares */
  clear () {
    this._stack = []
    this._plugins = {}
    this._router.clear()
    this._plugin(this._router)
    return this
  }

  /**
   * Add middleware, plugin or routes to server.
   * Middlewares may return promises for res.jsonSuccess(...), throw errors for res.error(...), return string or {} for res.send(...)
   * RouteURL: 'METHOD /suburl', 'METHOD', '* /suburl'
   */
  async use (...args:
    [Middleware|Plugin|ControllerClass|RoutesSet]|[Promise<Middleware|Plugin|ControllerClass|RoutesSet>]
    |RoutesList|[RouteURL, RoutesSet]|[PluginClass|Promise<PluginClass>, options?: any]): Promise<void> {
    if (!args[0])
      return

    this._worker.startJob()
    for (let i = 0; i < args.length; i++)
      if (args[i] instanceof Promise)
        args[i] = await args[i]

    // use(plugin)
    if (args[0] instanceof Plugin) {
      await this._plugin(args[0])
      return this._worker.endJob()
    }

    // use(PluginClass, options?: any)
    if (typeof args[0] === 'function' && args[0].prototype instanceof Plugin) {
      const pluginid = args[0].name.toLowerCase().replace(/plugin$/, '')
      const plugin = new (args[0] as PluginClass)(args[1] || this.config[pluginid], this)
      await this._plugin(plugin)
      return this._worker.endJob()
    }

    // use(middleware)
    if (isFunction(args[0])) {
      this.addStack(args[0] as Middleware)
      return this._worker.endJob()
    }

    let method = '*', url = '/'
    if (typeof args[0] === 'string') {
      const m = args[0].match(/^([A-Z]+) (.*)/)
      if (m)
        [method, url] = [m[1], m[2]]
      else
        url = args[0]
      if (!url.startsWith('/'))
        throw new Error(`Invalid url ${url}`)
      args = args.slice(1) as any
    }

    let routes = args[0]

    // use('/url', ControllerClass)
    if (typeof args[0] === 'function' && args[0].prototype instanceof Controller) {
      routes = (args[0] as typeof Controller).routes()
    }

    // use('/url', [ ['METHOD /url', ...], {'METHOD } ])
    if (Array.isArray(routes)) {
      if (method !== '*')
        throw new Error('Invalid router usage')
      for (const item of routes) {
        if (Array.isArray(item)) {
          // [methodUrl, ...middlewares]
          if (typeof item[0] !== 'string' || !item[0].match(/^(\w+ )?\//))
            throw new Error('Url expected')
          await this.use(item[0].replace(/\//, (url === '/' ? '' : url) + '/') as RouteURL, ...item.slice(1) as any)
        } else
          throw new Error('Invalid param')        
      }
      return this._worker.endJob()
    }

    // use('/url', {'METHOD /url': [...middlewares], ... } ])
    if (typeof routes === 'object' && routes.constructor === Object) {
      if (method !== '*')
        throw new Error('Invalid router usage')
      for (const [subUrl, subArgs] of Object.entries(args[0])) {
        if (!subUrl.match(/^(\w+ )?\//))
          throw new Error('Url expected')
        await this.use(subUrl.replace(/\//, (url === '/' ? '' : url) + '/') as RouteURL, ...(Array.isArray(subArgs) ? subArgs : [subArgs]))    
      }
      return this._worker.endJob()
    }

    // use('/url', ...middleware)
    this._router.add(method, url, args.filter(o => o).map((o: any) => this._bind(o) as Middleware), true)
    return this._worker.endJob()
  }

  private async _plugin(plugin: Plugin): Promise<void> {
    if (plugin.handler) {
      const middleware: Middleware = plugin.handler.bind(plugin)
      middleware.plugin = plugin
      middleware.priority = plugin.priority
      this.addStack(middleware)
    }
    if (plugin.routes) {
      const routes = isFunction(plugin.routes) ? await plugin.routes() : plugin.routes
      if (routes)
        await this.use(routes)
    }
    if (plugin.handler && plugin.name) {
      this._plugins[plugin.name] = plugin
      this.emit('plugin', plugin.name)
      this.emit('plugin:' + plugin.name)
      this._worker.endJob('plugin:' + plugin.name)
    }
  }

  /** Add middleware to stack, with optional priority */
  addStack(middleware: Middleware): void {
    if (middleware.plugin?.name && this.getPlugin(middleware.plugin.name))
      throw new Error(`Plugin ${middleware.plugin.name} already added`)
    const priority = middleware.priority || 0
    const idx = this._stack.findLastIndex(f => (f.priority || 0) <= priority)
    this._stack.splice(idx + 1, 0, middleware)
  }

  /** Get plugin */
  getPlugin (id: string): Plugin | undefined {
    return this._plugins[id]
  }

  /** Wait for plugin */
  async waitPlugin (id: string): Promise<Plugin> {
    const p = this.getPlugin(id)
    if (p)
      return p
    this._worker.startJob('plugin:' + id)
    await this._worker.wait('plugin:' + id)
    return this.getPlugin(id)!
  }

  /** Add route, alias to `server.use(url, ...args)` */
  all (url: `/${string}`, ...args: RoutesMiddleware[]): MicroServer {
    this.use('* ' + url as RouteURL, ...args)
    return this
  }

  /** Add route, alias to `server.use('GET ' + url, ...args)` */
  get (url: `/${string}`, ...args: RoutesMiddleware[]): MicroServer {
    this.use('GET ' + url as RouteURL, ...args)
    return this
  }

  /** Add route, alias to `server.use('POST ' + url, ...args)` */
  post (url: `/${string}`, ...args: RoutesMiddleware[]): MicroServer {
    this.use('POST ' + url as RouteURL, ...args)
    return this
  }

  /** Add route, alias to `server.use('PUT ' + url, ...args)` */
  put (url: `/${string}`, ...args: RoutesMiddleware[]): MicroServer {
    this.use('PUT ' + url as RouteURL, ...args)
    return this
  }

  /** Add route, alias to `server.use('PATCH ' + url, ...args)` */
  patch (url: `/${string}`, ...args: RoutesMiddleware[]): MicroServer {
    this.use('PATCH ' + url as RouteURL, ...args)
    return this
  }

  /** Add route, alias to `server.use('DELETE ' + url, ...args)` */
  delete (url: `/${string}`, ...args: RoutesMiddleware[]): MicroServer {
    this.use('DELETE ' + url as RouteURL, ...args)
    return this
  }

  /** Add websocket handler, alias to `server.use('WEBSOCKET ' + url, ...args)` */
  websocket (url: `/${string}`, ...args: RoutesMiddleware[]): MicroServer {
    this.use('WEBSOCKET ' + url as RouteURL, ...args)
    return this
  }

  /** Add router hook, alias to `server.hook(url, ...args)` */
  hook (url: RouteURL, ...args: RoutesMiddleware[]): MicroServer {
    const m = url.match(/^([A-Z]+) (.*)/) || ['', 'hook', url]
    this._router.add(m[1], m[2], args.filter(m => m).map(m => this._bind(m) as Middleware), false)
    return this
  }

  /** Check if middleware allready added */
  has (mid: Middleware): boolean {
    const check = (stack: Middleware[]) => stack.includes(mid) || (mid.name && !!stack.find(f => f.name === mid.name)) || false
    return check(this._stack)
  }

  async close () {
    this._worker.startJob('close')
    this.servers?.forEach(srv => {
      this._worker.startJob('close')
      srv.close(() => this._worker.endJob('close'))
    })
    this.servers?.clear()
    this.sockets?.forEach(s => {
      if (s.readyState !== 'closed') {
        this._worker.startJob('close')
        s.once('close', () => this._worker.endJob('close'))
        s.destroy()
      }
    })
    this.sockets?.clear()
    this._worker.endJob('close')
    await this._worker.wait('close')
    this.emit('close')
  }
}

export interface HttpHandler {
  (req: ServerRequest, res: ServerResponse): void
}

export interface TcpHandler {
  (socket: net.Socket): void
}

export interface ListenConfig {
  /** listen port(s) with optional protocol and host (Ex. 8080 or '0.0.0.0:8080,8180' or 'https://0.0.0.0:8080' or 'tcp://0.0.0.0:8080' or 'tls://0.0.0.0:8080') */
  listen?: string | number
  /** tls options */
  tls?: {cert: string, key: string, ca?: string}
  /** custom handler */
  handler?: HttpHandler | TcpHandler
}

// #region RouterPlugin
class RouterItem {
  _stack?: Middleware[] // add if middlewares added if not last
  _next?: Record<string, RouterItem> // next middlewares
  _paramName?: string // param name if param is used
  _paramWild?: boolean
  _withParam?: RouterItem // next middlewares if param is used
  _last?: Middleware[]
}

class RouterPlugin extends Plugin {
  priority = 100
  name = 'router'

  private _tree: Record<string, RouterItem> = {}
  constructor () {
    super()
  }

  add(treeItem: string, path: string, middlewares: Middleware[], last: boolean): void {
    middlewares = middlewares.filter(m => m)
    if (!middlewares.length)
      return
    let node = this._tree[treeItem]
    if (!node)
      this._tree[treeItem] = node = { }

    if (path && path !== '/') {
      const segments = path.split('/').filter(s => s)
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]
        if (seg[0] === ':') {
          const isWild = seg.endsWith('*')
          const paramName = isWild ? seg.slice(1, -1) : seg.slice(1)
          if (!node._withParam) {
            node._withParam = { _paramName: paramName, _paramWild: isWild }
          } else {
            if (node._withParam._paramName !== paramName)
              throw new Error(`Router param already used: ${node._withParam._paramName} != ${paramName}`)
            if (isWild)
              node._withParam._paramWild = true
          }
          node = node._withParam
          if (isWild)
            break
        } else {
          if (!node._next)
            node._next = {}
          if (!node._next[seg])
            node._next[seg] = { _next: {} }
          node = node._next[seg]
        }
      }
    }

    if (last) {
      node._last ||= []
      node._last.push(...middlewares)
    } else {
      node._stack ||= []
      node._stack.push(...middlewares)
    }
  }

  private _getStack(path: string, treeItems: string[]): Middleware[] {
    const out: Middleware[] = []
    const segments = path.split('/').filter(s => s)

    for (const key of treeItems) {
      let node = this._tree[key]
      if (!node)
        continue

      for (let i = 0; i < segments.length && node; i++) {
        const seg = segments[i]
        if (node._stack)
          out.push(...node._stack)

        // static match
        if (node._next?.[seg]) {
          node = node._next[seg]
          continue
        }

        // param match
        if (node._withParam) {
          const paramNode = node._withParam
          const value = decodeURIComponent(paramNode._paramWild ? segments.slice(i).join('/') : seg), name = paramNode._paramName!
          out.push((req: ServerRequest, res: ServerResponse, next: Function) => { req.params[name] = value; req.paramsList.push(value); next() })
          node = paramNode
          if (paramNode._paramWild)
            break
          else
            continue
        }
        node = undefined as any
      }
      if (node?._stack)
        out.push(...node._stack)
      if (node?._last) {
        out.push(...node._last)
        return out
      }
    }
    return out
  }

  walk(stack: Middleware[], req: ServerRequest, res: ServerResponse, next: Function) {
    const sendData = (data: any) => {
      if (!res.headersSent && !res.closed && data !== undefined) {
        if ((data === null || typeof data === 'string') && !res.isJson)
          return res.send(data)
        if (typeof data === 'object' && 
          (data instanceof Buffer || data instanceof Readable || data instanceof Error))
          return res.send(data)
        return res.jsonSuccess(data)
      }
    }
    let idx = 0
    const callNext = () => {
      if (res.headersSent || res.closed)
        return
      const fn = stack[idx++]
      if (!fn)
        return next()
      try {
        const r: any = fn(req, res, callNext)
        if (r instanceof Promise)
          r.catch(e => e).then(sendData)
        else
          sendData(r)
      } catch (e) {
        sendData(e)
      }
    }
    return callNext()
  }

  clear (): void {
    this._tree = {}
  }

  handler (req: ServerRequest, res: ServerResponse, next: Function): void {
    const method = req.method === 'HEAD' ? 'GET' : req.method || 'GET'
    this.walk(this._getStack(req.pathname, ['hook', method, '*']), req, res, next)
  }
}
// #endregion RouterPlugin

// #region CorsPlugin
export interface CorsOptions {
  /** allowed origins (default: '*') */
  origin: string,
  /** allowed headers (default: '*') */
  headers: string,
  /** allow credentials (default: false) */
  credentials: boolean,
  /** Expose headers */
  expose?: string,
  /** Max age */
  maxAge?: number
}

export class CorsPlugin extends Plugin {
  priority = -100
  name = 'cors'

  options?: CorsOptions
  constructor (options?: CorsOptions | string | true) {
    super()
    if (!options) {
      this.handler = undefined
      return
    }
    if (options === true)
      options = '*'
    this.options = typeof options === 'string' ? { origin: options, headers: 'Content-Type', credentials: true } : options
  }

  handler?(req: ServerRequest, res: ServerResponse, next: Function): Promise<string | object | void> | string | object | void {
    if (this.options && req.headers.origin) {
      const cors = this.options
      if (cors.origin)  
        res.setHeader('Access-Control-Allow-Origin', cors.origin)
      if (cors.headers)
        res.setHeader('Access-Control-Allow-Headers', cors.headers)
      if (cors.credentials)
        res.setHeader('Access-Control-Allow-Credentials', 'true')
      if (cors.expose)
        res.setHeader('Access-Control-Expose-Headers', cors.expose)
      if (cors.maxAge)
        res.setHeader('Access-Control-Max-Age', cors.maxAge)
    }
    return next()
  }
}
// #enregion CorsPlugin

// #region MethodsPlugin
export class MethodsPlugin extends Plugin {
  priority = -90
  name = 'methods'

  private _methods: string
  private _methodsIdx: Record<string, boolean>
  constructor(methods?: string) {
    super()

    this._methods = methods || defaultMethods
    this._methodsIdx = this._methods.split(',').reduce((acc, m) => (acc[m] = true, acc), {} as {[key: string]: boolean})
  }

  handler(req: ServerRequest, res: ServerResponse, next: Function) {
    if (req.method === 'GET' || req.headers.upgrade)
      return next()
    if (req.method === 'OPTIONS') {
      res.setHeader('Allow', this._methods)
      return res.status(204).end()
    }
    if (!req.method || !this._methodsIdx?.[req.method]) {
      res.setHeader('Allow', this._methods)
      return res.status(405).end()
    }
    return next()    
  }
}
// #endregion MethodsPlugin

// #region BodyPlugin
export interface BodyOptions {
  maxBodySize?: number
}
export class BodyPlugin extends Plugin {
  priority: number = -80
  name: string = 'body'

  private _maxBodySize: number
  constructor (options?: BodyOptions) {
    super()
    this._maxBodySize = options?.maxBodySize || defaultMaxBodySize
  }

  handler(req: ServerRequest, res: ServerResponse, next: () => void) {
    if (req.complete || req.method === 'GET' || req.method === 'HEAD') {
      if (!req.body)
        req.setBody({})
      return next()
    }

    const contentType = req.headers['content-type'] || ''
    if (contentType.startsWith('multipart/form-data')) {
      req.pause()
      res.setHeader('Connection', 'close')
      return next()
    }

    if (parseInt(req.headers['content-length'] || '-1') > this._maxBodySize) {
      return req.setReady(new ResponseError("too big", 413))
    }

    req.once('error', () => {})
      .on('data', chunk => {
        req.rawBodySize += chunk.length
        if (req.rawBodySize >= this._maxBodySize)
          req.setReady(new ResponseError("too big", 413))
        else
          req.rawBody.push(chunk)
      })
      .once('end', () => {
        let charset = contentType.match(/charset=(\S+)/)?.[1]
        if (charset !== 'utf8' && charset !== 'latin1' && charset !== 'ascii')
          charset = 'utf8'
        const bodyString = Buffer.concat(req.rawBody).toString(charset as BufferEncoding)
        if (contentType.startsWith('application/x-www-form-urlencoded')) {
          req.setBody(querystring.parse(bodyString))
        } else if (bodyString.startsWith('{') || bodyString.startsWith('[')) {
          try {
            req.setBody(JSON.parse(bodyString))
          } catch {
            return res.jsonError(405)
          }
        } else
          req.setBody({})
        req.setReady()
        return next()
      })
  }
}
// #endregion BodyPlugin

// #region UploadPlugin
export interface UploadOptions {
  uploadDir?: string
  maxFileSize?: number
}

export interface UploadFile {
  name: string
  fileName?: string
  contentType?: string
  size: number
  filePath?: string
}

export class UploadPlugin extends Plugin {
  priority: number = -70
  name: string = 'upload'

  private _maxFileSize: number
  private _uploadDir?: string
  constructor (options?: UploadOptions) {
    super()
    this._maxFileSize = options?.maxFileSize || defaultMaxFileSize
    this._uploadDir = options?.uploadDir
  }

  handler (req: ServerRequest, res: ServerResponse, next: () => void) {
    if (!req.readable || req.method === 'GET' || req.method === 'HEAD')
      return next()
    const contentType = req.headers['content-type'] || ''
    if (!contentType.startsWith('multipart/form-data'))
      return next()

    req.pause()
    res.setHeader('Connection', 'close')
    if (!this._uploadDir)
      return res.error(405)

    const uploadDir = path.resolve(this._uploadDir)
    const files: UploadFile[] = []

    req.files = async (): Promise<UploadFile[]> => {
      if (req.isReady)
        return files
      req.resume()
      await req.waitReady()
      return files
    }

    const boundaryIdx = contentType.indexOf('boundary=')
    if (boundaryIdx < 0)
      return res.error(405)
    const boundary = Buffer.from('--' + contentType.slice(boundaryIdx + 9).trim())
    const lookahead = boundary.length + 6;

    let lastFile: UploadFile | undefined
    let fileStream: fs.WriteStream | undefined
    let buffer = Buffer.alloc(0)

    const chunkParse = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length > 0) {
        if (!fileStream) {
          const boundaryIndex = buffer.indexOf(boundary)
          if (boundaryIndex < 0)
            break
          const headerEndIndex = buffer.indexOf('\r\n\r\n', boundaryIndex)
          if (headerEndIndex < 0)
            break
          const header = buffer.subarray(boundaryIndex, headerEndIndex).toString()
          const contentType = header.match(/content-type: ([^\r\n;]+)/i)
          const filenameMatch = header.match(/filename="(.+?)"/)

          if (filenameMatch) {
            let filePath
            do {
              filePath = path.resolve(path.join(uploadDir, crypto.randomBytes(16).toString('hex') + '.tmp'))
            } while (fs.existsSync(filePath))
            buffer = buffer.slice(headerEndIndex + 4)
            lastFile = {
              name: filenameMatch[1],
              fileName: filenameMatch[1],
              contentType: contentType && contentType[1] || undefined,
              filePath,
              size: 0
            }
            fileStream = fs.createWriteStream(filePath)
            files.push(lastFile)
          } else {
            const nextBoundary = buffer.indexOf(boundary, boundaryIndex + boundary.length)
            if (nextBoundary === -1)
              break
            buffer = buffer.subarray(nextBoundary)
          }
        } else {
          const nextBoundaryIndex = buffer.indexOf(boundary)
          const nextBoundaryIndexEnd = nextBoundaryIndex + boundary.length
          if (nextBoundaryIndex > 1 && buffer[nextBoundaryIndex - 2] === 13 && buffer[nextBoundaryIndex - 1] === 10
            && ((buffer[nextBoundaryIndexEnd] === 13 && buffer[nextBoundaryIndexEnd + 1] === 10)
            || (buffer[nextBoundaryIndexEnd] === 45 && buffer[nextBoundaryIndexEnd + 1] === 45))
          ) {
            fileStream.write(buffer.subarray(0, nextBoundaryIndex - 2))
            fileStream.end()
            lastFile!.size += nextBoundaryIndex - 2
            fileStream = undefined
            if (buffer[nextBoundaryIndexEnd] === 45) {
              res.removeHeader('Connection')
              req.setReady()
            }
            buffer = buffer.subarray(nextBoundaryIndex)
          } else {
            const safeWriteLength = buffer.length - lookahead
            if (safeWriteLength > 0) {
              lastFile!.size += safeWriteLength
              fileStream.write(buffer.subarray(0, safeWriteLength))
              buffer = buffer.subarray(safeWriteLength)
            }
            break
          }
        }
      }
    }

    const _removeTempFiles = () => {
      if (!req.isReady)
        req.setReady(new Error('Upload error'))
      if (fileStream) {
        fileStream.close()
        fileStream = undefined
      }

      files.forEach(f => {
        if (f.filePath)
          fs.unlink(f.filePath, NOOP)
        delete f.filePath
      })
      files.splice(0)
      req.setReady()
    }

    next()
    req.once('error', () => req.setReady(new Error('Upload error')))
      .on('data', chunk => chunkParse(chunk))
      .once('end', () => req.setReady(new Error('Upload error')))

    res.once('finish', () => _removeTempFiles())
    res.once('error', () => _removeTempFiles())
    res.once('close', () => _removeTempFiles())
  }
}
// #endregion UploadPlugin

// #region WebSocket
/** WebSocket options */
export interface WebSocketOptions {
  /** max websocket payload (default: 1MB) */
  maxPayload?: number
  /** automatically send pong frame (default: true) */
  autoPong?: boolean
  /** allow websocket per message deflate compression (default: false) */
  permessageDeflate?: boolean
  /** websocket deflate compression max window bits 8-15 for deflate (default: 10) */
  maxWindowBits?: number
  /** timeout for idle websocket connection (default: 120s) */
  timeout?: number
  /** allow websocket deflate compression (default: false) */
  deflate?: boolean
} 

/** WebSocket frame object */
interface WebSocketFrame {
  fin: boolean
  rsv1: boolean
  opcode: number
  length: number
  mask: Buffer
  lengthReceived: number
  index: number
}

const EMPTY_BUFFER = Buffer.alloc(0)
const DEFLATE_TRAILER = Buffer.from([0x00, 0x00, 0xff, 0xff])

interface WebSocketEvents {
  close: (code: number, reason: string) => void;
  end: () => void;
  error: (error: Error) => void;
  ping: (data: Buffer) => void;
  pong: (data: Buffer) => void;
  message: (data: string | Buffer | ArrayBuffer | Blob) => void;
  open: () => void;
}

/** WebSocket class */
export class WebSocket extends EventEmitter {
  private _socket: net.Socket
  private _frame?: WebSocketFrame
  private _buffers: Buffer[] = [EMPTY_BUFFER]
  private _buffersLength: number = 0
  private _options: WebSocketOptions
  public ready: boolean = false

  constructor (req: ServerRequest, options?: WebSocketOptions) {
    super()
    this._socket = req.socket
    this._options = {
      maxPayload: 1024 * 1024,
      permessageDeflate: false,
      maxWindowBits: 15,
      timeout: 120000,
      ...options} 

    this._socket.setTimeout(this._options.timeout || 120000)

    const key: string | undefined = req.headers['sec-websocket-key']
    const upgrade: string | undefined = req.headers.upgrade
    const version: number = +(req.headers['sec-websocket-version'] || 0)
    const extensions: string | undefined = req.headers['sec-websocket-extensions']
    const headers: string[] = []

    if (!key || !upgrade || upgrade.toLocaleLowerCase() !== 'websocket' || version !== 13 || req.method !== 'GET') {
      this._abort('Invalid WebSocket request', 400)
      return
    }
    if (this._options.permessageDeflate && extensions?.includes('permessage-deflate')) {
      let header = 'Sec-WebSocket-Extensions: permessage-deflate'
      if ((this._options.maxWindowBits || 15) < 15 && extensions.includes('client_max_window_bits'))
        header += `; client_max_window_bits=${this._options.maxWindowBits}`
      headers.push(header)
      this._options.deflate = true
    }
    this.ready = true
    this._upgrade(key, headers, () => {
      req.setReady()
      this.emit('open')
    })
  }

  private _upgrade (key: string, headers: string[] = [], cb?: () => void): void {
    const digest = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${digest}`,
      ...headers,
      '',
      ''
    ];
    this._socket.write(headers.join('\r\n'), cb)
    this._socket.on('error',this._errorHandler.bind(this))
    this._socket.on('data', this._dataHandler.bind(this))
    this._socket.on('close', () => this.emit('close'))
    this._socket.on('end', () => this.emit('end'))
  }

  /** Close connection */
  close (reason?: number, data?: Buffer): void {
    if (reason !== undefined) {
      const buffer: Buffer = Buffer.alloc(2 + (data ? data.length : 0))
      buffer.writeUInt16BE(reason, 0)
      if (data)
        data.copy(buffer, 2)
      data = buffer
    }
    return this._sendFrame(0x88, data || EMPTY_BUFFER, () => this._socket.destroy())
  }

  /** Generate WebSocket frame from data */
  static getFrame(data: number | string | Buffer | undefined, options?: any): Buffer {
    let msgType: number = 8
    let dataLength: number = 0
    if (typeof data === 'string') {
      msgType = 1
      dataLength = Buffer.byteLength(data, 'utf8')
    } else if (data instanceof Buffer) {
      msgType = 2
      dataLength = data.length
    } else if (typeof data === 'number') {
      msgType = data
    }

    const headerSize: number = 2 + (dataLength < 126 ? 0 : dataLength < 65536 ? 2 : 8) + (dataLength && options?.mask ? 4 : 0)
    const frame: Buffer = Buffer.allocUnsafe(headerSize + dataLength)
    frame[0] = 0x80 | msgType
    frame[1] = dataLength > 65535 ? 127 : dataLength > 125 ? 126 : dataLength
    if (dataLength > 65535)
      frame.writeBigUInt64BE(dataLength as unknown as bigint, 2)
    else if (dataLength > 125)
      frame.writeUInt16BE(dataLength, 2)
    if (dataLength && frame.length > dataLength) {
      if (typeof data === 'string')
        frame.write(data, headerSize, 'utf8')
      else
        (data as Buffer).copy(frame, headerSize)
    }
    if (dataLength && options?.mask) {
      let i:number = headerSize, h:number = headerSize - 4
      for (let i = 0; i < 4; i++)
        frame[h + i] = Math.floor(Math.random() * 256)
      for (let j: number = 0; j < dataLength; j++, i++) {
        frame[i] ^= frame[h + (j & 3)]
      }
    }
    return frame
  }

  /** Send data */
  send (data: string | Buffer): void {
    let msgType: number = typeof data === 'string' ? 1 : 2
    if (typeof data === 'string')
      data = Buffer.from(data, 'utf8')
    if (this._options.deflate && data.length > 256) {
      const output: Buffer[] = []
      const deflate: zlib.Deflate = zlib.createDeflateRaw({
        windowBits: this._options.maxWindowBits
      });
      deflate.write(data)
      deflate.on('data', (chunk: Buffer) => output.push(chunk))
      deflate.flush(() => {
        if (output.length > 0 && output[output.length - 1].length > 4)
          output[output.length - 1] = output[output.length - 1].subarray(0, output[output.length - 1].length - 4)
        this._sendFrame(0xC0 | msgType, Buffer.concat(output))
      })
    } else
      return this._sendFrame(0x80 | msgType, data)
  }

  private _errorHandler (error: Error): void {
    this.emit('error', error)
    if (this.ready)
      this.close(error instanceof WebSocketError && error.statusCode || 1002)
    else
      this._socket.destroy()
    this.ready = false
  }

  private _headerLength (buffer?: Buffer): number {
    if (this._frame)
      return 0
    if (!buffer || buffer.length < 2)
      return 2
    let hederInfo: number = buffer[1]
    return 2 + (hederInfo & 0x80 ? 4 : 0) + ((hederInfo & 0x7F) === 126 ? 2 : 0) + ((hederInfo & 0x7F) === 127 ? 8 : 0)
  }

  private _dataHandler (data: Buffer): void {
    while (data.length) {
      let frame: WebSocketFrame | undefined = this._frame
      if (!frame) {
        let lastBuffer: Buffer = this._buffers[this._buffers.length - 1]
        this._buffers[this._buffers.length - 1] = lastBuffer = Buffer.concat([lastBuffer, data])
        let headerLength: number = this._headerLength(lastBuffer)
        if (lastBuffer.length < headerLength)
          return
        const headerBits: number = lastBuffer[0]
        const lengthBits: number = lastBuffer[1] & 0x7F
        this._buffers.pop()
        data = lastBuffer.subarray(headerLength)
  
        // parse header
        frame = this._frame = {
          fin: (headerBits & 0x80) !== 0,
          rsv1: (headerBits & 0x40) !== 0,
          opcode: headerBits & 0x0F,
          mask: (lastBuffer[1] & 0x80) ? lastBuffer.subarray(headerLength - 4, headerLength) : EMPTY_BUFFER,
          length: lengthBits === 126 ? lastBuffer.readUInt16BE(2) : lengthBits === 127 ? lastBuffer.readBigUInt64BE(2) as unknown as number : lengthBits,
          lengthReceived: 0,
          index: this._buffers.length
        }
      }
      let toRead: number = frame.length - frame.lengthReceived
      if (toRead > data.length)
        toRead = data.length
      if (this._options.maxPayload && this._options.maxPayload < this._buffersLength + frame.length) {
        this._errorHandler(new WebSocketError('Payload too big', 1009))
        return
      }

      // unmask
      for (let i = 0, j = frame.lengthReceived; i < toRead; i++, j++)
        data[i] ^= frame.mask[j & 3]
      frame.lengthReceived += toRead
      if (frame.lengthReceived < frame.length) {
        this._buffers.push(data)
        return
      }
      this._buffers.push(data.subarray(0, toRead))
      this._buffersLength += toRead
      data = data.subarray(toRead)

      if (frame.opcode >= 8) {
        const message = Buffer.concat(this._buffers.splice(frame.index))
        switch (frame.opcode) {
          case 8:
            if (!frame.length)
              this.emit('close')
            else {
              const code: number = message.readInt16BE(0)
              if (frame.length === 2)
                this.emit('close', code)
              else
                this.emit('close', code, message.subarray(2))
            }
            this._socket.destroy()
            return
          case 9:
            if (message.length)
              this.emit('ping', message)
            else
              this.emit('ping')
            if (this._options.autoPong)
              this.pong(message)
            break
          case 10:
            if (message.length)
              this.emit('pong', message)
            else
              this.emit('pong')
              break
          default:
            return this._errorHandler(new WebSocketError('Invalid WebSocket frame'))
        }
      } else if (frame.fin) {
        if (!frame.opcode)
          return this._errorHandler(new WebSocketError('Invalid WebSocket frame'))

        if (this._options.deflate && frame.rsv1) {
          const output: Buffer[] = []
          const inflate =  zlib.createInflateRaw({
            windowBits: this._options.maxWindowBits
          });
          inflate.on('data', (chunk: Buffer) => output.push(chunk))
          inflate.on('error', (err: Error) => this._errorHandler(err))
          for (const buffer of this._buffers)
            inflate.write(buffer)
          inflate.write(DEFLATE_TRAILER)
          inflate.flush(() => {
            if (this.ready) {
              const message = Buffer.concat(output)
              this.emit('message', frame.opcode === 1 ? message.toString('utf8') : message)
            }
          })
        } else {
          const message = Buffer.concat(this._buffers)
          this.emit('message', frame.opcode === 1 ? message.toString('utf8') : message)
        }
        this._buffers = []
        this._buffersLength = 0
      }
      this._frame = undefined
      this._buffers.push(EMPTY_BUFFER)
    }
  }

  private _abort (message?: string, code?: number, headers?: any) {
    code = code || 400
    message = message || http.STATUS_CODES[code] || 'Closed'
    headers = [
      `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}`,
      'Connection: close',
      'Content-Type: ' + message.startsWith('<') ? 'text/html' : 'text/plain',
      `Content-Length: ${Buffer.byteLength(message)}`,
      '',
      message
    ]
    this._socket.once('finish', () => {
      this._socket.destroy()
      this.emit('close')
    })
    this._socket.end(headers.join('\r\n'))
    this.emit('error', new Error(message))
  }

  /** Send ping frame */
  ping (buffer?: Buffer) {
    this._sendFrame(0x89, buffer || EMPTY_BUFFER)
  }

  /** Send pong frame */
  pong (buffer?: Buffer) {
    this._sendFrame(0x8A, buffer || EMPTY_BUFFER)
  }

  private _sendFrame (opcode: number, data: Buffer, cb?: () => void) {
    if (!this.ready)
      return
    const dataLength: number = data.length
    const headerSize: number = 2 + (dataLength < 126 ? 0 : dataLength < 65536 ? 2 : 8)
    const frame: Buffer = Buffer.allocUnsafe(headerSize + (dataLength < 4096 ? dataLength : 0))
    frame[0] = opcode
    frame[1] = dataLength > 65535 ? 127 : dataLength > 125 ? 126 : dataLength
    if (dataLength > 65535)
      frame.writeBigUInt64BE(dataLength as unknown as bigint, 2)
    else if (dataLength > 125)
      frame.writeUInt16BE(dataLength, 2)
    if (dataLength && frame.length > dataLength) {
      data.copy(frame, headerSize)
      this._socket.write(frame, cb)
    } else
      this._socket.write(frame, () => this._socket.write(data, cb))
  }

  on<K extends keyof WebSocketEvents>(event: K, listener: WebSocketEvents[K]): this { return super.on(event, listener) }
  addListener<K extends keyof WebSocketEvents>(event: K, listener: WebSocketEvents[K]): this { return super.addListener(event, listener) }
  once<K extends keyof WebSocketEvents>(event: K, listener: WebSocketEvents[K]): this { return super.once(event, listener) }
  off<K extends keyof WebSocketEvents>(event: K, listener: WebSocketEvents[K] ): this { return super.off(event, listener) }
  removeListener<K extends keyof WebSocketEvents>(event: K, listener: WebSocketEvents[K]): this { return super.removeListener(event, listener) }
}

export class WebSocketPlugin extends Plugin {
  name: string = 'websocket'
  
  private _handler: (req: ServerRequest, socket: net.Socket, head: any) => void
  constructor (options?: any, server?: MicroServer) {
    super()
    if (!server)
      throw new Error('Server instance is required')
    this._handler = this.upgradeHandler.bind(this, server)
    server.servers?.forEach(srv => this.addUpgradeHandler(srv as any))
    server.on('listen', (port: number, address: string, srv: http.Server) => this.addUpgradeHandler(srv))
  }

  private addUpgradeHandler (srv: http.Server) {
    if (!srv.listeners('upgrade').includes(this._handler as any))
      srv.on('upgrade', this._handler)
  }

  upgradeHandler (server: MicroServer, req: ServerRequest, socket: net.Socket, head: any) {
    const host: string = req.headers.host || ''
    const vhostPlugin = server.getPlugin('vhost') as VHostPlugin
    const vserver = vhostPlugin?.vhosts?.[host] || server
    req.method = 'WEBSOCKET'
    const res: any = {
      req,
      get headersSent (): boolean {
        return socket.bytesWritten > 0
      },
      statusCode: 200,
      socket,
      server,
      end (data?: string): void {
        if (res.headersSent)
          throw new Error('Headers already sent')
        let code = res.statusCode || 403
        if (code < 400) {
          data = 'Invalid WebSocket response'
          server.emit('error', new Error(data))
          code = 500
        }
        if (!data)
          data = http.STATUS_CODES[code] || ''
        const headers: string[] = [
          `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}`,
          'Connection: close',
          'Content-Type: text/plain',
          `Content-Length: ${Buffer.byteLength(data)}`,
          '',
          data
        ]
        socket.write(headers.join('\r\n'), () => { socket.destroy() });
      },
      error (code: number): void {
        res.statusCode = code || 403
        res.end()
      },
      send (data?: string): void {
        res.end(data)
      },
      getHeader (): undefined { },
      setHeader (): void { }
    }
    ServerRequest.extend(req, res as any, server)
    let _ws: WebSocket | undefined
    Object.defineProperty(req, 'websocket', {
      get: () => {
        if (!_ws)
          _ws = new WebSocket(req, server.config.websocket)
        return _ws
      },
      enumerable: true
    })
    vserver.handler(req, res as ServerResponse)
  }
}
// #endregion WebSocket

// #region TrustProxyPlugin
/** Trust proxy plugin, adds `req.ip` and `req.localip` */
export class TrustProxyPlugin extends Plugin {
  priority: number = -60
  name: string = 'trustproxy'

  private _trustProxy: string[] = []
  constructor (options?: string[]) {
    super()
    this._trustProxy = options || []
  }

  isLocal (ip: string) {
    return !!ip.match(/^(127\.|10\.|192\.168\.|172\.16\.|fe80|fc|fd|::)/)
  }

  handler(req: ServerRequest, res: ServerResponse, next: Function): void {
    req.localip = this.isLocal(req.ip)
    const xip = req.headers['x-real-ip'] || req.headers['x-forwarded-for']
    if (xip) {
      if (!this._trustProxy.includes(req.ip))
        return res.error(400)

      if (req.headers['x-forwarded-proto'] === 'https')
        req.secure = true
      req.ip = Array.isArray(xip) ? xip[0] : xip
      req.localip = this.isLocal(req.ip)
    }
    return next()    
  }
}
// #endregion TrustProxyPlugin

// #region VHostPlugin
/** Virtual host plugin */
export class VHostPlugin extends Plugin {
  priority = -10

  vhosts?: Record<string, MicroServer>
  constructor (options: Record<string, RoutesSet|MicroServer>, server?: MicroServer) {
    super()
    if (!server)
      throw new Error('Server instance is required')

    const vhostPlugin = server.getPlugin('vhost') as VHostPlugin
    let vhosts = vhostPlugin?.vhosts
    if (!vhosts) {
      vhosts = this.vhosts = {}
      this.name = 'vhost'
    } else {
      this.handler = undefined
    }
    for (const host in options) {
      const v = options[host]
      if (v instanceof MicroServer) {
        vhosts[host] = v
        continue
      }
      if (!vhosts[host])
        vhosts[host] = new MicroServer({})
      vhosts[host].use(options[host])
    }
    if (this.vhosts)
      server.on('close', () => {
        for (const host in this.vhosts)
          this.vhosts[host].emit('close')
      })      
  }

  handler? (req: ServerRequest, res: ServerResponse, next: Function) {
    const host = req.headers.host || ''
    const server: MicroServer | undefined = this.vhosts?.[host]
    if (server) {
      req.server = server
      server.handler(req, res)
    } else
      next()
  }
}
// #endregion VHostPlugin

// #region StaticPlugin
/** Static files options */
export interface StaticFilesOptions {
  /** files root directory */
  root?: string,
  /** url path */
  path?: string,
  /** additional mime types */
  mimeTypes?: { [key: string]: string },
  /** file extension handlers */
  handlers?: { [key: string]: Middleware },
  /** ignore prefixes */
  ignore?: string[]
  /** index file. default: 'index.html' */
  index?: string
  /** Update Last-Modified header. default: true */
  lastModified?: boolean
  /** Update ETag header. default: true */
  etag?: boolean
  /** Max file age in seconds */
  maxAge?: number
  /** static errors file for status code, '*' - default */
  errors?: Record<string, string>
}

export interface ServeFileOptions {
  /** path */
  path: string
  /** root */
  root?: string
  /** file name */
  filename?: string | true
  /** file mime type */
  mimeType?: string
  /** last modified date */
  lastModified?: boolean
  /** etag */
  etag?: boolean
  /** max age */
  maxAge?: number
  /** range */
  range?: boolean
  /** stat */
  stats?: fs.Stats
}

const etagPrefix = crypto.randomBytes(4).toString('hex')

//TODO: add precompressed .gz support
//TODO: add unknown file extension handler

/**
 * Static files middleware plugin
 * Usage: server.use('static', '/public')
 * Usage: server.use('static', { root: 'public', path: '/static' })
 */
export class StaticFilesPlugin extends Plugin {
  priority: number = 110
  
  /** Default mime types */
  static mimeTypes: { [key: string]: string } = {
    '.ico': 'image/x-icon',
    '.htm': 'text/html',
    '.html': 'text/html',
    '.txt': 'text/plain',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.css': 'text/css',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.pdf': 'application/pdf',
    '.woff': 'application/x-font-woff',
    '.woff2': 'application/x-font-woff2',
    '.ttf': 'application/x-font-ttf',
    '.gz': 'application/gzip',
    '.zip': 'application/zip',
    '.tgz': 'application/gzip',
  }
  
  /** Custom mime types */
  mimeTypes: { [key: string]: string }
  /** File extension handlers */
  handlers?: { [key: string]: Middleware }
  /** Files root directory */
  root: string
  /** Ignore prefixes */
  ignore: string[]
  /** Index file. default: 'index.html' */
  index: string
  /** Update Last-Modified header. default: true */
  lastModified: boolean
  /** Update ETag header. default: true */
  etag: boolean
  /** Max file age in seconds (default: 31536000) */
  maxAge?: number

  prefix: string

  errors?: Record<string, string>

  constructor (options?: StaticFilesOptions | string, server?: MicroServer) {
    super()
    if (!options)
      options = {}
    if (typeof options === 'string')
      options = { root: options }

    // allow multiple instances
    if (server && !server.getPlugin('static'))
      this.name = 'static'

    this.mimeTypes = options.mimeTypes ? { ...StaticFilesPlugin.mimeTypes, ...options.mimeTypes } : Object.freeze(StaticFilesPlugin.mimeTypes)
    this.root = (options.root && path.isAbsolute(options.root) ? options.root : path.resolve(options.root || options?.path || 'public')).replace(/[\/\\]$/, '') + path.sep
    this.ignore = (options.ignore || []).map((p: string) => path.normalize(path.join(this.root, p)) + path.sep)
    this.index = options.index || 'index.html'
    this.handlers = options.handlers
    this.lastModified = options.lastModified !== false
    this.etag = options.etag !== false
    this.maxAge = options.maxAge
    this.errors = options.errors

    this.prefix = ('/' + (options.path?.replace(/^[.\/]*/, '') || '').replace(/\/$/, '')).replace(/\/$/, '')

    const defSend = ServerResponse.prototype.send

    ServerResponse.prototype.send = function (data: any) {
      const plugin: StaticFilesPlugin = this.req.server.getPlugin('static') as StaticFilesPlugin
      if (this.statusCode < 400 || this.isJson || typeof data !== 'string' || !plugin?.errors || this.getHeader('Content-Type'))
        return defSend.call(this, data)
      const errFile: string = plugin.errors[this.statusCode] || plugin.errors['*']
      if (errFile)
        plugin.serveFile(this.req, this, {path: errFile, mimeType: 'text/html'})
      return defSend.call(this, data)
    }

    ServerResponse.prototype.file = function (path: string | ServeFileOptions) {
      const plugin: StaticFilesPlugin = this.req.server.getPlugin('static') as StaticFilesPlugin
      if (!plugin)
        throw new Error('Server error')
      plugin.serveFile(this.req, this, typeof path === 'object' ? path : {
        path,
        mimeType: StaticFilesPlugin.mimeTypes[extname(path)] || 'application/octet-stream'
      })
    }
  }

  /** Default static files handler */
  handler (req: ServerRequest, res: ServerResponse, next: Function) {
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return next()
    if (!('path' in req.params)) { // global handler
      if (req.path.startsWith(this.prefix) && (req.path === this.prefix || req.path[this.prefix.length] === '/')) {
        req.params.path = req.path.slice(this.prefix.length + 1)
      } else
        return next()
    }

    let filename = path.normalize(path.join(this.root, req.params.path))
    if (!filename.startsWith(this.root)) // check root access
      return next()

    const firstch = basename(filename)[0]
    if (firstch === '.' || firstch === '_') // hidden file
      return next()

    if (filename.endsWith(path.sep))
      filename += this.index

    const ext = path.extname(filename)
    const mimeType = this.mimeTypes[ext]
    if (!mimeType)
      return next()

    // check ignore access
    for (let i = 0; i < this.ignore.length; i++) {
      if (filename.startsWith(this.ignore[i]))
        return next()
    }

    fs.stat(filename, (err, stats) => {
      if (err || stats.isDirectory())
        return next()

      const handler = this.handlers?.[ext]
      if (handler) {
        (req as any).filename = filename
        return handler.call(this, req, res, next)
      }

      this.serveFile(req, res, {
        path: filename,
        mimeType,
        stats
      })
    })
  }

  /** Send static file */
  serveFile (req: ServerRequest, res: ServerResponse, options: ServeFileOptions) {
    const filePath: string = path.isAbsolute(options.path) ? options.path : path.join(options.root || this.root, options.path)
    const statRes = (err: NodeJS.ErrnoException | null, stats: fs.Stats): void => {
      if (err || !stats.isFile()) {
        if (res.statusCode < 400)
          return res.error(404)
        res.end(res.statusCode + ' ' + http.STATUS_CODES[res.statusCode])
        return
      }

      if (!res.getHeader('Content-Type')) {
        if (options.mimeType)
          res.setHeader('Content-Type', options.mimeType)
        else
          res.setHeader('Content-Type', this.mimeTypes[path.extname(options.path)] || 'application/octet-stream')
      }
      if (options.filename)
        res.setHeader('Content-Disposition', 'attachment; filename="' + (options.filename === true ? path.basename(options.path) : options.filename) + '"')
      if (options.lastModified !== false)
        res.setHeader('Last-Modified', stats.mtime.toUTCString())
      res.setHeader('Content-Length', stats.size)
      if (options.etag !== false) {
        const etag = '"' + etagPrefix + stats.mtime.getTime().toString(32) + '"'
        if (req.headers['if-none-match'] === etag || req.headers['if-modified-since'] === stats.mtime.toUTCString())
          res.statusCode = 304
      }
      if (options.maxAge)
        res.setHeader('Cache-Control', 'max-age=' + options.maxAge)
      if (res.statusCode === 304 || req.method === 'HEAD') {
        res.end()
        return
      }
      const streamOptions = {start: 0, end: stats.size - 1}
      if (options.range !== false) {
        const range: string | undefined = req.headers['range']
        if (range && range.startsWith('bytes=')) {
          const parts = range.slice(6).split('-')
          
          streamOptions.start = parseInt(parts[0]) || 0
          streamOptions.end = parts[1] ? parseInt(parts[1]) : stats.size - 1
          res.setHeader('Content-Range', `bytes ${streamOptions.start}-${streamOptions.end}/${stats.size}`)
          res.setHeader('Content-Length', streamOptions.end - streamOptions.start + 1)
        }        
      }
      fs.createReadStream(filePath, streamOptions).pipe(res)
    }

    if (!options.stats)
      fs.stat(filePath, statRes)
    else
      statRes(null, options.stats)
  }
}
// #endregion StaticPlugin

// #region ProxyPlugin
/** Proxy plugin options */
export interface ProxyOptions {
  /** Base path */
  path?: string,
  /** Remote url */
  remote?: string,
  /** Match regex filter */
  match?: string,
  /** Override/set headers for remote */
  headers?: { [key: string]: string },
  /** Valid headers to forward */
  validHeaders?: { [key: string]: boolean }
}

export class ProxyPlugin extends Plugin {
  priority = 120
  name = 'proxy'

  /** Default valid headers */
  static validHeaders: { [key: string]: boolean } = {
    authorization: true,
    accept: true,
    'accept-encoding': true,
    'accept-language': true,
    'cache-control': true,
    cookie: true,
    'content-type': true,
    'content-length': true,
    host: true,
    referer: true,
    'if-match': true,
    'if-none-match': true,
    'if-modified-since': true,
    'user-agent': true,
    date: true,
    range: true
  }
  /** Current valid headers */
  validHeaders: { [key: string]: boolean }
  /** Override headers to forward to remote */
  headers: { [key: string]: string } | undefined
  /** Remote url */
  remoteUrl: URL
  /** Match regex filter */
  regex?: RegExp

  constructor (options?: ProxyOptions | string, server?: MicroServer) {
    super()
    if (typeof options !== 'object')
      options = { remote: options }
    if (!options.remote)
      throw new Error('Invalid param')

    this.remoteUrl = new URL(options.remote)
    this.regex = options.match ? new RegExp(options.match) : undefined

    this.headers = options.headers
    this.validHeaders = {...ProxyPlugin.validHeaders, ...options?.validHeaders}
    if (options.path && options.path !== '/' && server) {
      this.handler = undefined
      server.use(options.path + '/:path*' as RouteURL, this.proxyHandler.bind(this))
    }
  }

  /** Default proxy handler */
  proxyHandler (req: ServerRequest, res: ServerResponse, next: Function) {
    const reqOptions: http.RequestOptions = {
      method: req.method,
      headers: {},
      host: this.remoteUrl.hostname,
      port: parseInt(this.remoteUrl.port) || (this.remoteUrl.protocol === 'https:' ? 443 : 80),
      path: this.remoteUrl.pathname
    }
    const rawHeaders: string[] = req.rawHeaders
    let path = req.params.path
    if (path)
      path += (req.path.match(/\?.*/) || [''])[0]
    if (!path && this.regex) {
      const m = this.regex.exec(req.path)
      if (!m)
        return next()
      path = m.length > 1 ? m[1] : m[0]
    }
    if (!path)
      path = req.path || ''
    if (!path.startsWith('/'))
      path = '/' + path
    reqOptions.path += path
    if (!reqOptions.headers)
      reqOptions.headers = {}
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const n = rawHeaders[i], nlow = n.toLowerCase()
      if (this.validHeaders[nlow] && nlow !== 'host')
        (reqOptions.headers as any)[n] = rawHeaders[i + 1]
    }
    if (this.headers)
      Object.assign(reqOptions.headers, this.headers)
    reqOptions.setHost = true

    const conn = this.remoteUrl.protocol === 'https:' ? https.request(reqOptions) : http.request(reqOptions)
    conn.on('response', (response: http.IncomingMessage) => {
      res.statusCode = response.statusCode || 502
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        const n = response.rawHeaders[i], nlow = n.toLowerCase()
        if (nlow !== 'transfer-encoding' && nlow !== 'connection')
          res.setHeader(n, response.rawHeaders[i + 1])
      }
      response.on('data', chunk => {
        res.write(chunk)
      })
      response.on('end', () => {
        res.end()
      })
    })
    conn.on('error', () => res.error(502))

    // Content-Length must be allready defined
    if (req.rawBody.length) {
      const postStream = new Readable()
      req.rawBody.forEach(chunk => {
        postStream.push(chunk)
      })
      postStream.push(null)
      postStream.pipe(res)
    } else
      conn.end()
  }

  /** Proxy plugin handler as middleware */
  handler? (req: ServerRequest, res: ServerResponse, next: Function): void {
    return this.proxyHandler(req, res, next)
  }
}
// #endregion ProxyPlugin

// #region AuthPlugin
/** User info */
export interface UserInfo {
  /** User _id */
  _id?: string,
  /** User id */
  id?: string,
  /** User password plain or hash */
  password?: string,
  /** ACL options */
  acl?: {[key: string]: boolean},
  /** User group */
  group?: string,
  /** Custom user data */
  [key: string]: any
}

/** Authentication options */
export interface AuthOptions {
  /** Authentication token */
  token: string | Buffer
  /** Users */
  users?: {[key: string]: UserInfo} | ((usr: string, psw?: string) => Promise<UserInfo|undefined>)
  /** Default ACL */
  defaultAcl?: { [key: string]: boolean }
  /** Expire time in seconds */
  expire?: number
  /** Authentication mode */
  mode?: 'cookie' | 'token'
  /** Authentication realm for basic authentication */
  realm?: string
  /** Redirect URL */
  redirect?: string
  /** Authentication cache */
  cache?: { [key: string]: { data: UserInfo, time: number } }
  /** Interal next cache cleanup time */
  cacheCleanup?: number
}

export interface AuthOptionsInternal extends AuthOptions {
  /** Authentication token */
  token: Buffer
  /** Users */
  users: (usr: string, psw?: string) => Promise<UserInfo|undefined>
  /** Default ACL */
  defaultAcl: { [key: string]: boolean }
  /** Expire time in seconds */
  expire: number
  /** Use object token instead of user id */
  objectToken: boolean
  /** Authentication mode */
  mode: 'cookie' | 'token'
  /** Authentication realm for basic authentication */
  realm: string
  /** Redirect URL */
  redirect: string
  /** Authentication cache */
  cache: { [key: string]: { data: UserInfo, time: number } }
  /** Interal next cache cleanup time */
  cacheCleanup: number
}

/** Authentication class */
export class Auth {
  /** Server request */
  public req: ServerRequest | undefined
  /** Server response */
  public res: ServerResponse | undefined
  /** Authentication options */
  public options: AuthOptionsInternal
  
  constructor (options: AuthOptionsInternal, req?: ServerRequest, res?: ServerResponse) {
    this.options = options
    this.req = req
    this.res = res
    if (req)
      req.auth = this
  }

  /** Decode token */
  decode (data: string) {
    data = data.replace(/-/g, '+').replace(/\./g, '/')
    const iv: Buffer = Buffer.from(data.slice(0, 22), 'base64')

    try {
      const decipher: crypto.DecipherGCM = crypto.createDecipheriv('aes-256-gcm', this.options.token, iv) as crypto.DecipherGCM
      decipher.setAuthTag(Buffer.from(data.slice(22, 44), 'base64'))
      const dec: string = decipher.update(data.slice(44), 'base64', 'utf8') + decipher.final('utf8')
      const match: RegExpMatchArray | null  = dec.match(/^(.*);([0-9a-f]{8});$/)
      if (match) {
        const expire = parseInt(match[2], 16) + 946681200 - Math.floor(new Date().getTime() / 1000)
        if (expire > 0)
          return {
            data: match[1],
            expire
          }
      }
    } catch (e) {
    }
    return {
      data: '',
      expire: -1
    }
  }

  /** Encode token */
  encode (data: string, expire?: number) {
    if (!expire)
      expire = this.options.expire || defaultExpire
    data = data + ';' + ('0000000' + Math.floor(new Date().getTime() / 1000 - 946681200 + expire).toString(16)).slice(-8) + ';'
    const iv: Buffer = crypto.randomBytes(16)
    const cipher: crypto.CipherGCM = crypto.createCipheriv('aes-256-gcm', this.options.token, iv) as crypto.CipherGCM
    let encrypted: string = cipher.update(data, 'utf8', 'base64') + cipher.final('base64')
    encrypted = iv.toString('base64').slice(0, 22) + cipher.getAuthTag().toString('base64').slice(0, 22) + encrypted

    return encrypted.replace(/==?/, '').replace(/\//g, '.').replace(/\+/g, '-')
  }

  /**
   * Check acl over authenticated user with: `id`, `group/*`, `*`
   * @param {string} id - to authenticate: `id`, `group/id`, `model/action`, comma separated best: true => false => def 
   * @param {boolean} [def=false] - default access
   */
  acl (id: string, def: boolean = false): boolean {
    if (!this.req?.user)
      return false
    const reqAcl: {[key: string]: boolean} | undefined = this.req.user.acl || this.options.defaultAcl
    if (!reqAcl)
      return def

    // this points to req
    let access: boolean | undefined
    const list = (id || '').split(',')
    list.forEach(id => access ||= id === 'auth' ? true : reqAcl[id])
    if (access !== undefined)
      return access
    list.forEach(id => {
      const p = id.lastIndexOf('/')
      if (p > 0)
        access ||= reqAcl[id.slice(0, p + 1) + '*']
    })
    if (access === undefined)
      access = reqAcl['*']
    return access ?? def
  }

  /**
     * Authenticate user and setup cookie
     * @param {string|UserInfo} usr - user id used with options.users to retrieve user object. User object must contain `id` and `acl` object (Ex. usr = {id:'usr', acl:{'users/*':true}})
     * @param {string} [psw] - user password (if used for user authentication with options.users)
     * @param {number} [expire] - expire time in seconds (default: options.expire)
     */
  async token (usr: string | UserInfo | undefined, psw: string | undefined, expire?: number): Promise<string | undefined> {
    let data: string | undefined
    if (typeof usr === 'object' && usr && (usr.id || usr._id))
      data =  JSON.stringify(usr)
    else if (typeof usr === 'string') {
      if (psw !== undefined) {
        const userInfo = await this.options.users(usr, psw)
        data = userInfo?.id || userInfo?._id
      } else
      data = usr
    }
    if (data)
      return this.encode(data, expire)
  }

  /**
   * Authenticate user and setup cookie
   */
  async login (usr: string | UserInfo | undefined, psw?: string, options?: {expire?: number, salt?: string}): Promise<UserInfo | undefined> {
    let usrInfo: UserInfo | undefined
    if (typeof usr === 'object')
      usrInfo = usr
    if (typeof usr === 'string')
      usrInfo = await this.options.users(usr, psw)
    if (usrInfo?.id || usrInfo?._id) {
      const expire = Math.min(34560000, options?.expire || this.options.expire || defaultExpire)
      const expireTime = new Date().getTime() + expire * 1000
      const token = await this.token(this.options.objectToken ? JSON.stringify(usrInfo) : (usrInfo?.id || usrInfo?._id), undefined, expire)
      
      if (token && this.res && this.req) {
        const oldToken: string | undefined = (this.req as any).tokenId
        if (oldToken)
          delete this.options.cache?.[oldToken]
        this.req.tokenId = token
        if (this.options.mode === 'cookie')
          this.res.setHeader('set-cookie', `token=${token}; max-age=${expire}; path=${this.req.baseUrl || '/'}`)
        if (this.options.cache)
          this.options.cache[token] = { data: usrInfo, time: expireTime }
      }
    }
    return usrInfo
  }

  /** Logout logged in user */
  logout (): void {
    if (this.req && this.res) {
      const oldToken: string | undefined = (this.req as any).tokenId
      if (oldToken)
        delete this.options.cache?.[oldToken]
      if (this.options.mode === 'cookie')
        this.res.setHeader('set-cookie', `token=; max-age=-1; path=${this.req.baseUrl || '/'}`)
      else {
        if (this.req.headers.authentication) {
          this.res.setHeader('set-cookie', 'token=')
          this.res.error(401)
        }
      }
      this.req.user = undefined
    }
  }

  /** Get hashed string from user and password */
  password (usr: string, psw: string, salt?: string): string {
    return Auth.password(usr, psw, salt)
  }

  /** Get hashed string from user and password */
  static password (usr: string, psw: string, salt?: string): string {
    if (psw.length < 128)
      psw = crypto.createHash('sha512').update(psw).digest('hex')
    if (usr)
      psw = crypto.createHash('sha512').update(usr + '|' + psw).digest('hex')
    if (salt) {
      salt = salt === '*' ? crypto.randomBytes(32).toString('hex') : (salt.length > 128 ? salt.slice(0, salt.length - 128) : salt)
      psw = salt + crypto.createHash('sha512').update(psw + salt).digest('hex')
    }
    return psw
  }

  /** Validate user password */
  checkPassword (usr: string, psw: string, storedPsw: string, salt?: string): boolean {
    return Auth.checkPassword(usr, psw, storedPsw, salt)
  }

  /** Validate user password */
  static checkPassword (usr: string, psw: string, storedPsw: string, salt?: string): boolean {
    let success: boolean = false
    if (usr && storedPsw) {
      if (storedPsw.length > 128) { // salted hash
        if (psw.length < 128) // plain == salted-hash
          success = this.password(usr, psw, storedPsw) === storedPsw
        else if (psw.length === 128) // hash == salted-hash
          success = this.password('', psw, storedPsw) === storedPsw
        else // rnd-salted-hash === salted-hash
          success = psw === this.password('', storedPsw, psw)
      } else if (storedPsw.length === 128) { // hash
        if (psw.length < 128) // plain == hash
          success =  this.password(usr, psw) === storedPsw
        else if (psw.length === 128) // hash == hash
          success = psw === storedPsw
        else if (salt) // rnd-salted-hash === hash
          success = psw === this.password('', this.password('', storedPsw, salt), psw)
      } else { // plain
        if (psw.length < 128) // plain == plain
          success = psw === storedPsw
        else if (psw.length === 128) // hash == plain
          success = psw === this.password(usr, storedPsw)
        else if (salt) // rnd-salted-hash == plain
          success = psw === this.password('', this.password(usr, storedPsw, salt), psw)
      }
    }
    return success
  }

  /** Clear user cache if users setting where changed */
  clearCache (): void {
    const cache = this.options.cache
    if (cache)
      Object.keys(cache).forEach(k => delete cache[k])
  }
}

/*
// Client login implementation
async function login (username, password) {
  function hex (b) { return Array.from(Uint8Array.from(b)).map(b => b.toString(16).padStart(2, "0")).join("") }
  async function hash (data) { return hex(await crypto.subtle.digest('sha-512', new TextEncoder().encode(data)))}
  const rnd = hex(crypto.getRandomValues(new Int8Array(32)))
  return rnd + await hash(await hash(username + '|' + password) + rnd)
}
 
// Server login implementation
// password should be stored with `req.auth.password(req, user, password)` but may be in plain form too
 
server.use('auth', {
  users: {
    testuser: {
      acl: {
        'user/update': true,
        'messages/*': true,
      },
      password: <hash-password>
    },
    admin: {
      acl: {
        'user/*': true,
        'messages/*': true,
      },
      password: <hash-password>
    }
  }
})
//or
server.use('auth', {
  async users (usr, psw) {
    const obj = await db.getUser(usr)
    if (!obj.disabled && this.checkPassword(usr, psw, obj.password)) {
      const {password, ...res} = obj // remove password field
      return res
    }
  }
})
 
async function loginMiddleware(req, res) {
  const user = await req.auth.login(req.body.username || '', req.body.password || '')
  if (user)
    res.jsonSuccess(user)
  else
    res.jsonError('Access denied')
}
 
// More secure way is to store salted hashes on server `req.auth.password(user, password, '*')`
// and corespondingly 1 extra step is needed in athentication to retrieve salt from passwod hash `password.slice(0, 64)`
// client function will be:
async function login (username, password, salt) {
  function hex (b) { return Array.from(Uint8Array.from(b)).map(b => b.toString(16).padStart(2, "0")).join("") }
  async function hash (data) { return hex(await crypto.subtle.digest('sha-512', new TextEncoder().encode(data)))}
  const rnd = hex(crypto.getRandomValues(new Int8Array(32)))
  return rnd + await hash(await hash(salt + await hash(await hash(username + '|' + password) + salt)) + rnd)
} 
*/

/** Authentication plugin */
export class AuthPlugin extends Plugin {
  priority = 50
  name: string = 'auth'

  options: AuthOptions
  constructor (options?: AuthOptions, server?: MicroServer) {
    super()
    if (!server)
      throw new Error('Server instance is required')

    this.options = {
      mode: 'cookie',
      token: defaultToken,
      expire: defaultExpire,
      defaultAcl: { '*': false },
      cache: {},
      ...options,
      cacheCleanup: new Date().getTime()
    }

    if (options?.token === defaultToken)
      console.warn('Default token in auth plugin')

    let token: string | Buffer = options?.token || defaultToken
    if (!token || token.length !== 32)
      token = defaultToken
    if (token.length !== 32)
      token = crypto.createHash('sha256').update(token).digest()
    if (!(token instanceof Buffer))
      token = Buffer.from(token as string)
    this.options.token = token

    if (typeof options?.users === 'function')
      this.options.users = (usr, psw) => (options.users as (usr: string, psw?: string) => Promise<UserInfo|undefined>)(usr, psw)
    else {
      this.options.users = async (usrid, psw) => {
        const users: {[key: string]: UserInfo} | undefined = this.options.users as {[key: string]: UserInfo}
        const usr: UserInfo | undefined = users?.[usrid]
        if (usr && (psw === undefined || server.auth?.checkPassword(usrid, psw, usr.password || '')))
          return usr
      }
    }
    server.auth = new Auth(this.options as AuthOptionsInternal)
  }

  /** Authentication middleware */
  async handler (req: ServerRequest, res: ServerResponse, next: Function) {
    const options: AuthOptions = this.options, cache = options.cache
    const auth = new Auth(this.options as AuthOptionsInternal, req, res)
    
    const authorization = req.headers.authorization || '';
    if (authorization.startsWith('Basic ')) {
      let usr = cache?.[authorization]
      if (usr)
        req.user = usr.data
      else {
        const usrpsw = Buffer.from(authorization.slice(6), 'base64').toString('utf-8'),
          pos = usrpsw.indexOf(':'), username = usrpsw.slice(0, pos), psw = usrpsw.slice(pos + 1)
        if (username && psw)
          req.user = await auth.options.users(username, psw)
        if (!req.user)
          return res.error(401)
        if (cache) // 1 hour to expire in cache
          cache[authorization] = { data: req.user, time: new Date().getTime() + Math.min(3600000, (options.expire || defaultExpire) * 1000) }
      }
      return next()
    }

    const cookie = req.headers.cookie, cookies = cookie ? cookie.split(/;\s*/g) : []
    const sid = cookies.find(s => s.startsWith('token='))
    let token = ''
    if (authorization.startsWith('Bearer '))
      token = authorization.slice(7)

    if (sid)
      token = sid.slice(sid.indexOf('=') + 1)

    if (req.query.token)
      token = req.query.token

    if (token) {
      const now = new Date().getTime()
      let usr: UserInfo, expire: number | undefined
      if (cache && (!options.cacheCleanup || options.cacheCleanup > now)) {
        options.cacheCleanup = now + 600000
        process.nextTick(() => Object.entries(cache).forEach((entry: [string, { data: UserInfo, time: number }]) => {
          if (entry[1].time < now) delete cache[entry[0]]
        }))
      }

      // check in cache
      (req as any).tokenId = token
      let usrCache = cache?.[token]
      if (usrCache && usrCache.time > now)
        [req.user, expire] = [usrCache.data, Math.floor((usrCache.time - now) / 1000)]
      else {
        const usrData = auth.decode(token)
        if (!usrData.data) {
          req.auth!.logout()
          return new AccessDenied()
        }
        if (usrData.data.startsWith('{')) {
          try {
            usr = JSON.parse(usrData.data)
            req.user = usr
          } catch (e) { }
        } else {
          req.user = await auth.options.users(usrData.data)
          if (!req.user) {
            req.auth!.logout()
            return new AccessDenied()
          }
        }
        expire = usrData.expire
        if (req.user && cache)
          cache[token] = { data: req.user, time: expire }
      }
      // renew
      if (req.user && expire < (options.expire || defaultExpire) / 2)
        await req.auth!.login(req.user)
    }
    if (!res.headersSent)
      return next()
  }
}
// #endregion AuthPlugin

export class StandardPlugins extends Plugin {
  constructor (options?: any, server?: MicroServer) {
    super()
    if (!server)
      throw new Error('Server instance is required')
    const config = server.config || {}
    const use = (plugin: any, id?: string) => {
      if (!id)
        server.use(plugin)
      else if (id in config)
        server.use(plugin, config[id])
    }
    use(MethodsPlugin)
    use(CorsPlugin, 'cors')
    use(TrustProxyPlugin, 'trustproxy')
    use(BodyPlugin)
    use(StaticFilesPlugin, 'static')
    use(AuthPlugin, 'auth')
  }
}

// #region Controller
interface ControllerClass {
  new (req: ServerRequest<any>, res: ServerResponse<any>): Controller<any>
}

/**
 * Controller for dynamic routes
 * 
 * @example
 * ```js
 * class MyController extends Controller {
 *   static model = MyModel;
 *   static acl = 'auth';
 * 
 *   static 'acl:index' = '';
 *   static 'url:index' = 'GET /index';
 *   async index (req, res) {
 *     res.send('Hello World')
 *   }
 *
 *   //function name prefixes translated to HTTP methods:
 *   //  all => GET, get => GET, insert => POST, post => POST,
 *   //  update => PUT, put => PUT, delete => DELETE,
 *   //  modify => PATCH, patch => PATCH,
 *   //  websocket => internal WebSocket
 *   // automatic acl will be: class_name + '/' + function_name_prefix
 *   // automatic url will be: method + ' /' + class_name + '/' + function_name_without_prefix
 *
 *   //static 'acl:allUsers' = 'MyController/all';
 *   //static 'url:allUsers' = 'GET /MyController/Users';
 *   async allUsers () {
 *     return ['usr1', 'usr2', 'usr3']
 *   }
 *
 *   //static 'acl:getOrder' = 'MyController/get';
 *   //static 'url:getOrder' = 'GET /Users/:id/:id1';
 *   static 'group:getOrder' = 'orders';
 *   static 'model:getOrder' = OrderModel;
 *   async getOrder (id: string, id1: string) {
 *     return {id, extras: id1, type: 'order'}
 *   }
 *
 *   //static 'acl:insertOrder' = 'MyController/insert';
 *   //static 'url:insertOrder' = 'POST /Users/:id';
 *   static 'model:insertOrder' = OrderModel;
 *   async insertOrder (id: string, id1: string) {
 *     return {id, extras: id1, type: 'order'}
 *   }
 *
 *   static 'acl:POST /login' = '';
 *   async 'POST /login' () {
 *     return {id, extras: id1, type: 'order'}
 *   }
 * }
 * ```
*/
export class Controller<T extends Model<any> = any> {
  req: ServerRequest<T>
  res: ServerResponse<T>

  get model(): T | undefined {
    return this.req.model
  }

  constructor (req: ServerRequest<T>, res: ServerResponse<T>) {
    this.req = req
    this.res = res
  }

  /** Generate routes for this controller */
  static routes (): any[] {
    const routes: any[] = []
    const prefix: string = Object.getOwnPropertyDescriptor(this, 'name')?.enumerable ? this.name + '/' : ''

    // iterate throught decorators
    Object.getOwnPropertyNames(this.prototype).forEach(key => {
      if (key === 'constructor' || key.startsWith('_'))
        return
      const func: any = (this.prototype as any)[key]
      if (typeof func !== 'function')
        return

      const thisStatic: any = this

      let url = thisStatic['url:' + key]
      let acl = thisStatic['acl:' + key] ?? thisStatic['acl']
      const user = thisStatic['user:' + key] ?? thisStatic['user']
      const group = thisStatic['group:' + key] ?? thisStatic['group']
      const modelName = thisStatic['model:' + key] ?? thisStatic['model']

      let method = ''
      if (!url)
        key = key.replaceAll('$', '/')
      if (!url && key.startsWith('/')) {
        method = '*'
        url = key
      }
      let keyMatch = !url && key.match(/^(all|get|put|post|patch|insert|update|modify|delete|websocket)[/_]?([\w_/-]*)$/i)
      if (keyMatch) {
        method = keyMatch[1]
        url = '/' + prefix + keyMatch[2]
      }
      keyMatch = !url && key.match(/^([*\w]+) (.+)$/)
      if (keyMatch) {
        method = keyMatch[1]
        url = keyMatch[2].startsWith('/') ? keyMatch[2] : ('/' + prefix + keyMatch[1])
      }
      keyMatch = !method && url?.match(/^([*\w]+) (.+)$/)
      if (keyMatch) {
        method = keyMatch[1]
        url = keyMatch[2].startsWith('/') ? keyMatch[2] : ('/' + prefix + keyMatch[2])
      }
      if (!method)
        return

      let autoAcl = method.toLowerCase()
      switch (autoAcl) {
        case '*':
          autoAcl = ''
          break
        case 'post':
          autoAcl = 'insert'
          break
        case 'put':
          autoAcl = 'update'
          break
        case 'patch':
          autoAcl = 'modify'
          break
      }
      method = method.toUpperCase()
      switch (method) {
        case '*':
          break
        case 'GET':
        case 'POST':
        case 'PUT':
        case 'PATCH':
        case 'DELETE':
        case 'WEBSOCKET':
            break
        case 'ALL':
          method = 'GET'
          break
        case 'INSERT':
          method = 'POST'
          break
        case 'UPDATE':
          method = 'PUT'
          break
        case 'MODIFY':
          method = 'PATCH'
          break
        default:
          throw new Error('Invalid url method for: ' + key)
      }
      if (user === undefined && group === undefined && acl === undefined)
        acl = prefix + autoAcl

      // add params if not available in url
      if (func.length && !url.includes(':')) {
        let args: string[] = ['/:id']
        for (let i = 1; i < func.length; i++)
          args.push('/:id' + i)
        url += args.join('')
      }
      const list: Array<string|Function> = [method + ' ' + url.replace(/\/\//g, '/'), 'response:json']
      if (acl)
        list.push('acl:' + acl)
      if (user)
        list.push('user:' + user)
      if (group)
        list.push('group:' + group)
      list.push((req: ServerRequest, res: ServerResponse) => {
        res.isJson = true
        const obj: Controller = new this(req, res)
        if (modelName) {
          req.model = modelName instanceof Model ? modelName : (Model.models as any)[modelName]
          if (!obj.model)
            throw new InvalidData(modelName, 'model')
          req.model = Model.dynamic(req.model, {controller: obj})
        }
        return func.apply(obj, req.paramsList)
      })
      routes.push(list)
    })
    return routes
  }
}
// #endregion Controller

// #region Worker
class WorkerJob {
  _promises: any = []
  _busy: number = 0

  start() {
    this._busy++
  }

  end() {
    this._busy--
    if (this._busy === 0)
      for (const resolve of this._promises.splice(0))
        resolve()
  }

  async wait() {
    if (!this._busy)
      return
    return new Promise<void>(resolve => this._promises.push(resolve))
  }
}

class Worker {
  private _id: number = 0
  private _jobs: Record<string, WorkerJob> = {}

  isBusy(id?: string) {
    const job = this._jobs[id || 'ready']
    return !!job?._busy
  }

  startJob(id?: string) {
    let job = this._jobs[id || 'ready']
    if (!job)
      job = this._jobs[id || 'ready'] = new WorkerJob()
    job.start()
  }

  endJob(id?: string) {
    const job = this._jobs[id || 'ready']
    if (job)
      job.end()
  }

  get nextId() {
    return (++this._id).toString()
  }

  async wait(id?: string): Promise<void> {
    const job = this._jobs[id || 'ready']
    if (!job)
      return
    return job.wait()
  }
}
// #endregion Worker

// #region FileStore
export interface FileStoreOptions {
  /** Base directory */
  dir?: string
  /** Cache timeout in milliseconds */
  cacheTimeout?: number
  /** Max number of cached items */
  cacheItems?: number
  /** Debounce timeout in milliseconds for autosave */
  debounceTimeout?: number
}

interface FileItem {
  atime: number
  mtime: number
  data: any
}

/** JSON File store */
export class FileStore {
  private _cache: { [name: string]: FileItem }
  private _dir: string
  private _cacheTimeout: number
  private _cacheItems: number
  private _debounceTimeout: number
  private _iter: number

  constructor (options?: FileStoreOptions) {
    this._cache = {}
    this._dir = options?.dir || 'data'
    this._cacheTimeout = options?.cacheTimeout || 2000
    this._cacheItems = options?.cacheItems || 10
    this._debounceTimeout = options?.debounceTimeout ?? 1000
    this._iter = 0
  }

  /** cleanup cache */
  cleanup (): void {
    if (this._iter > this._cacheItems) {
      this._iter = 0
      const now = new Date().getTime()
      const keys = Object.keys(this._cache)
      if (keys.length > this._cacheItems) {
        keys.forEach(n => {
          if (now - this._cache[n].atime > this._cacheTimeout)
            delete this._cache[n]
        })
      }
    }
  }

  private _queue: Promise<any> = Promise.resolve()

  private async _sync(cb: Function): Promise<any> {
    let r: Function
    let p: Promise<any> = new Promise(resolve => r = resolve)
    this._queue = this._queue.then(async () => {
      try {
        r(await cb())
      } catch (e) {
        r(e)
      }
    })
    return p
  }

  /** close store */
  async close () {
    await this.sync()
    this._iter = 0
    this._cache = {}
  }

  /** sync data to disk */
  async sync () {
    for (const name in this._cache) {
      for (const key in this._cache)
        await (this._cache[key].data as any).__sync__?.()
    }
    await this._queue
  }

  /** load json file data */
  async load (name: string, autosave: boolean = false): Promise<any> {
    let item: FileItem = this._cache[name]
    if (item && new Date().getTime() - item.atime < this._cacheTimeout)
      return item.data

    return this._sync(async () =>  {
      item = this._cache[name]
      if (item && new Date().getTime() - item.atime < this._cacheTimeout)
        return item.data
      try {
        const stat = await fs.promises.lstat(path.join(this._dir, name)).catch(() => null)
        if (!stat || item?.mtime !== stat.mtime.getTime()) {
          let data: object = stat ? JSON.parse(await fs.promises.readFile(path.join(this._dir, name), 'utf8').catch(() => '') || '{}') : {}
          this._iter++
          this.cleanup()
          if (autosave)
            data = this.observe(data, () => this.save(name, data))
          this._cache[name] = {
            atime: new Date().getTime(),
            mtime: stat?.mtime.getTime() || new Date().getTime(),
            data: data
          }
          return data
        }
      } catch {
        delete this._cache[name]
      }
      return item?.data
    })
  }

  /** save data */
  async save (name: string, data: any): Promise<any> {
    this._iter++
    const item: FileItem = {
      atime: new Date().getTime(),
      mtime: new Date().getTime(),
      data: data
    }
    this._cache[name] = item
    this._sync(async () =>  {
      if (this._cache[name] === item) {
        this.cleanup()
        try {
          await fs.promises.writeFile(path.join(this._dir, name), JSON.stringify(this._cache[name].data), 'utf8')
        } catch {
        }
      }
    })
    return data
  }

  /** load all files in directory */
  async all (name: string, autosave: boolean = false): Promise<Record<string, any>> {
    return this._sync(async () =>  {
      const files = await fs.promises.readdir(name ? path.join(this._dir, name) : this._dir)
      const res: Record<string, any> = {}
      await Promise.all(files.map(file => 
        (file.startsWith('.') && !file.startsWith('_') && !file.startsWith('$')) &&
          this.load(name ? name + '/' + file : file, autosave)
            .then(data => {res[file] = data})
      ))
      return res
    })
  }

  /** delete data file */
  async delete (name: string): Promise<void> {
    delete this._cache[name]
    return this._sync(async () =>  {
      if (this._cache[name])
        return
      try {
        await fs.promises.unlink(path.join(this._dir, name))
      } catch {
      }
    })
  }

  /** Observe data object */
  observe (data: object, cb: (data: object, key: string, value: any) => void): object {
    function debounce(func: (...args: any) => void, debounceTime: number): Function | any {
      const maxTotalDebounceTime: number = debounceTime * 2
      let timeoutId: any
      let lastCallTime = Date.now()
      let _args: any

      const abort = () => {
        if (timeoutId)
          clearTimeout(timeoutId)
        _args = undefined
        timeoutId = undefined
      }
      const exec = () => {
        const args = _args
        if (args) {
          abort()
          lastCallTime = Date.now()
          func(...args)
        }
      }
      const start = (...args: any) => {
        const currentTime = Date.now()
        const timeSinceLastCall = currentTime - lastCallTime
        abort()
        if (timeSinceLastCall >= maxTotalDebounceTime) {
          func(...args)
          lastCallTime = currentTime
        } else {
          _args = args
          timeoutId = setTimeout(exec, Math.max(debounceTime - timeSinceLastCall, 0))
        }
      }
      start.abort = abort
      start.immediate = exec
      return start
    }

    const changed = debounce((target: {[key: string]: any}, key: string) => cb.call(data, target, key, target[key]), this._debounceTimeout)
    const handler = {
      get(target: {[key: string]: any}, key: string) {
        if (key === '__sync__')
          return changed.immediate
        if (typeof target[key] === 'object' && target[key] !== null)
          return new Proxy(target[key], handler)
        return target[key]
      },
      set(target: {[key: string]: any}, key: string, value: any) {
        if (target[key] === value)
          return true
        if (value && typeof value === 'object')
          value = {...value}
        target[key] = value
        changed(target, key)
        return true
      },
      deleteProperty(target: {[key: string]: any}, key: string) {
        delete target[key]
        changed(target, key)
        return true
      }
    }
    return new Proxy(data, handler)
  }
}

// #endregion FileStore

// #region Model
let globalObjectId = crypto.randomBytes(8)
function newObjectId() {
  for (let i = 7; i >= 0; i--)
    if (++globalObjectId[i] < 256)
      break
  return (new Date().getTime() / 1000 | 0).toString(16) + globalObjectId.toString('hex')
}

/** Model validation options */
interface ModelContextOptions {
  /** User info */
  user?: UserInfo
  /** Request params */
  params?: Object
  /** is insert */
  insert?: boolean
  /** is read-only */
  readOnly?: boolean
  /** validate */
  validate?: boolean
  /** use default */
  default?: boolean
  /** use primary key only for filter */
  primaryKey?: boolean
  /** projection fields */
  projection?: Record<string, 0|1|true|false>
}
/** Model field validation options */
interface ModelValidateFieldOptions extends ModelContextOptions {
  name: string
  field: ResolvedFieldSchema
  model: Model<any>
}

export interface ModelCallbackFunc {
  (options: any): any
}

type ModelBasicCtorType = typeof String | typeof Number | typeof Boolean | typeof Date // | Object
type ModelBasicNamedType = 'string' | 'String' | 'number' | 'Number' | 'int' | 'Int' |
                            'integer' | 'Integer' | 'boolean' | 'Boolean' | 'object' | 'Object' |
                            'objectid' | 'ObjectId' | 'date' | 'Date' | 'any' | 'Any'
type ModelBasicType = ModelBasicNamedType | ModelBasicCtorType | Model<any>
type ModelFieldSimpleType = ModelBasicType | [ModelBasicType] | [ModelBasicType, ...never[]]

/** Model field description */
export interface ModelFieldSchema {
  /** Field type */
  type: ModelFieldSimpleType
  /** Is array */
  array?: true | false
  /** Is primary key, used for filtering */
  primaryKey?: true | false
  /** Is required */
  required?: boolean | string | ModelCallbackFunc
  /** Can read */
  canRead?: boolean | string | ModelCallbackFunc
  /** Can write */
  canWrite?: boolean | string | ModelCallbackFunc
  /** Default value */
  default?: number | string | ModelCallbackFunc
  /** Validate function */
  validate?: (value: any, options: ModelContextOptions) => string | number | object | null | Error | typeof Error
  /** Valid values */
  enum?: Array<string|number>
  /** Minimum value for string and number */
  minimum?: number | string
  /** Maximum value for string and number */
  maximum?: number | string
  /** Regex validation or 'email', 'url', 'date', 'time', 'date-time' */
  format?: string
}

interface ResolvedFieldSchema {
  type: string
  model?: Model<any>
  primaryKey?: boolean
  required?: ModelCallbackFunc
  canRead: ModelCallbackFunc
  canWrite: ModelCallbackFunc
  default: ModelCallbackFunc
  validate: (value: any, options: ModelValidateFieldOptions) => any
}

export interface ModelSchema {
  [K: string]: ModelFieldSchema | ModelFieldSimpleType
}

type ModelDocumentTypeByName<T> = 
  T extends 'string' | 'String' ? string :
  T extends 'number' | 'Number' | 'int' | 'Int' ? number :
  T extends 'boolean' | 'Boolean' ? boolean :
  T extends 'date' | 'Date' ? Date :
  T extends 'objectid' | 'ObjectId' ? string :
  T extends 'object' | 'Object' ? Record<string, any> :
  T extends 'any' | 'Any' ? any :
  never

type ModelDocumentTypeByCtor<T> = 
  T extends typeof String ? string :
  T extends typeof Number ? number :
  T extends typeof Boolean ? boolean :
  T extends typeof Date ? Date :
  T extends typeof Object ? Record<string, any> :
  never

type ModelFieldTypeExtract<T extends ModelFieldSchema> = 
  T['type'] extends string ? ModelDocumentTypeByName<T['type']> :
  T['type'] extends Array<infer U> ? Array<ModelDocumentType<U>> :
  T['type'] extends Function ? ModelDocumentTypeByCtor<T['type']> :
  T['type'] extends Model<infer U> ? ModelDocument<U> :
  never

type ModelDocumentType<T> = 
  T extends string ? ModelDocumentTypeByName<T> :
  T extends Array<infer U> ? Array<ModelDocumentType<U>> :
  T extends Function ? ModelDocumentTypeByCtor<T> :
  T extends ModelFieldSchema ? ModelFieldTypeExtract<T> :
  T extends Model<infer U> ? ModelDocument<U> :
  never


export interface ModelDocumentField<T extends ModelFieldSchema> {
  value: T['array'] extends true ? Array<ModelFieldTypeExtract<T>> : ModelFieldTypeExtract<T>
  required?: T['required']
  canRead?: T['canRead'] 
  canWrite?: T['canWrite']
  default?: T['default']
  validate?: T['validate']
}

export type ModelDocument<T extends ModelSchema> = {
  [K in keyof T]: ModelDocumentType<T[K]>} & {
  _id?: string
}

export declare interface ModelCollections {
  collection(name: string): Promise<MicroCollection>
}

class ModelCollectionsInternal implements ModelCollections {
  private _ready!: Function
  private _wait: Promise<this> = new Promise(resolve => this._ready = resolve)
  private _db: any
  set db(db: any) {
    Promise.resolve(db).then(db => this._ready(this._db = db))
  }
  get db(): any {
    return this._db 
  }
  async collection(name: string): Promise<MicroCollection> {
    const db = await this._wait
    return db.collection(name)
  }
}

export class Models {
}

export class Model<TSchema extends ModelSchema> {
  static collections: ModelCollections = new ModelCollectionsInternal()
  static models: Models = {} as Models

  static set db(db: any) {
    (this.collections as ModelCollectionsInternal).db = db
  }
  static get db(): any {
    return (this.collections as ModelCollectionsInternal).db
  }

  /** Dynamic model extension */
  static dynamic<T extends Model<any>>(model: T, options: {controller?: Controller, collection?: MicroCollection<any>, req?: ServerRequest} | Controller): T {
    if (options instanceof Controller)
      options = {controller: options}
    const collection = options?.collection || model.collection
    const modelOptions: Record<string, any> = {...model.options}
    const req = options.req || options.controller?.req
    if (req) {
      modelOptions.user = req.user
      modelOptions.params = req.params
    }
    return new Proxy(model, {
      get: (target: any, prop: string) => {
        if (prop === 'collection')
          return collection
        if (prop === 'options')
          return modelOptions
        return target[prop]
      }
    })
  }

  static register<K extends string, T extends Model<any>>(name: K, model: T) {
    (Model.models as any)[name] = model
    return this
  }

  /** Define model */
  static define<K extends string, T extends ModelSchema>(name: K, schema: T, options?: {collection?: MicroCollection | Promise<MicroCollection>, class?: typeof Model}): Model<T> {
    options = options || {}
    if (!options.collection)
      options.collection = this.collections.collection(name)
    const inst: Model<T> = options?.class
      ? new options.class(schema, {name, ...options})
      : new Model(schema, {name, ...options})
    this.register(name, inst)
    return inst
  }

  /** Model fields description */
  model: Record<string, ResolvedFieldSchema>
  /** Model collection for persistance */
  collection?: MicroCollection | Promise<MicroCollection>
  /** Custom options */
  options: Record<string, any> = {}

  /** Create model acording to description */
  constructor (schema: TSchema, options?: {collection?: MicroCollection | Promise<MicroCollection>, name?: string}) {
    const model: Record<string, ResolvedFieldSchema> = this.model = {}
    this.options.name = options?.name || (this as any).__proto__.constructor.name
    this.collection = options?.collection
    this.handler = this.handler.bind(this)

    for (const n in schema) {
      const modelField: ResolvedFieldSchema = this.model[n] = {name: n} as any
      let field: ModelFieldSchema = schema[n] as any
      let fieldType: any, isArray: boolean = false
      if (typeof field === 'object' && !Array.isArray(field) && !(field instanceof Model))
        fieldType = field.type
      else {
        fieldType = field
        field = {} as any
      }
      if (Array.isArray(fieldType)) {
        isArray = true
        fieldType = fieldType[0]
      }
      if (typeof fieldType === 'function')
        fieldType = fieldType.name

      let validateType: (value: any, options: ModelValidateFieldOptions) => any

      if (fieldType instanceof Model) {
        modelField.model = fieldType
        fieldType = 'model'
        validateType = (value: any, options: ModelValidateFieldOptions) => modelField.model?.document(value, options)
      } else {
        fieldType = fieldType.toString().toLowerCase()
        switch (fieldType) {
          case "objectid":
            validateType = (value: any, options: ModelValidateFieldOptions) => {
              if (typeof value === 'string')
                return value
              if (typeof value === 'object' && value.constructor.name.toLowerCase() === 'objectid')
                return JSON.stringify(value)
              throw new InvalidData(options.name, 'field type')
            }
            break
          case 'string':
            validateType = (value: any, options: ModelValidateFieldOptions) => {
              if (typeof value === 'string')
                return value
              if (typeof value === 'number')
                return value.toString()
              throw new InvalidData(options.name, 'field type')
            }
            break
          case 'number':
            validateType = (value: any, options: ModelValidateFieldOptions) => {
              if (typeof value === 'number')
                return value
              throw new InvalidData(options.name, 'field type')
            }
            break
          case 'int':
            validateType = (value: any, options: ModelValidateFieldOptions) => {
              if (typeof value === 'number' && Number.isInteger(value))
                return value
              throw new InvalidData(options.name, 'field type')
            }
            break
          case "json":
          case "object":
            fieldType = 'object'
            validateType = (value: any, options: ModelValidateFieldOptions) => {
              if (typeof value === 'object')
                return value
              throw new InvalidData(options.name, 'field type')
            }
            break
          case 'boolean':
            validateType = (value: any, options: ModelValidateFieldOptions) => {
              if (typeof value === 'boolean')
                return value
              throw new InvalidData(options.name, 'field type')
            }
            break
          case 'array':
            isArray = true
            fieldType = 'any'
            validateType = (value: any) => value
            break
          case 'date':
            validateType = (value: any, options: ModelValidateFieldOptions) => {
              if (typeof value === 'string')
                value = new Date(value)
              if (value instanceof Date && !isNaN(value.getTime()))
                return value
              throw new InvalidData(options.name, 'field type')
            }
            break
          case '*':
          case 'any':
            fieldType = 'any'
            validateType = (value: any) => value
            break
          default:
            throw new InvalidData(n, 'field type ' + fieldType)
        }
      }
      modelField.type = fieldType + (isArray ? '[]' : '')
      const validators: Function[] = [validateType]
      const validate = (value: any, options: ModelValidateFieldOptions) => validators.reduce((v: any, f: Function) => {
        v = f(v, options)
        if (v === Error)
          throw new InvalidData(options.name, 'field value')
        if (v instanceof Error)
          throw v
        return v
      }, value)
      if (isArray)
        modelField.validate = (value: any[], options: ModelValidateFieldOptions) => {
          if (Array.isArray(value))
            return value.map((v, i) => validate(v, { ...options, name: options.name + '[' + i + ']' }))
          throw new InvalidData(options.name, 'field type')
        }
      else
        modelField.validate = validate
      modelField.primaryKey = field.primaryKey
      modelField.required = (field.primaryKey || field.required) ? this._fieldFunction(field.primaryKey ||field.required, false) : undefined
      modelField.canWrite = this._fieldFunction(field.canWrite, typeof field.canWrite === 'string' && field.canWrite.startsWith('$') ? false : true)
      modelField.canRead = this._fieldFunction(field.canRead, typeof field.canRead === 'string' && field.canRead.startsWith('$') ? false : true)
      if (field.default !== undefined) {
        const def = field.default
        if (typeof def === 'function' && def.name === 'ObjectId')
          modelField.default = () => newObjectId()
        else if (def === Date)
          modelField.default = () => new Date()
        else if (typeof def !== 'function')
          modelField.default = this._fieldFunction(def)
        else
          modelField.default = def
      }
      if (field.minimum !== undefined) {
        const minimum = field.minimum
        validators.push((value: any, options: ModelValidateFieldOptions) => {
          try { if (value >= minimum) return value } catch (e) {}
          return Error
        })
      }
      if (field.maximum !== undefined) {
        const maximum = field.maximum
        validators.push((value: any, options: ModelValidateFieldOptions) => {
          try { if (value <= maximum) return value } catch (e) {}
          return Error
        })
      }
      if (field.enum) {
        const enumField = field.enum
        validators.push((value: any, options: ModelValidateFieldOptions) => enumField.includes(value) ? value: Error)
      }
      if (field.format && modelField.type === 'string') {
        let format = field.format
        switch (format) {
          case 'date':
            format = '^\\d{4}-\\d{2}-\\d{2}$'
            break
          case 'time':
            format = '^\\d{2}:\\d{2}(:\\d{2})?$'
            break
          case 'date-time':
            format = '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}(:\\d{2})?$'
            break
          case 'url':
            format = '^https?://[-A-Za-z0-9+&@#/%?=~_|!:,.;]*[-A-Za-z0-9+&@#/%=~_|]'
            break
          case 'email':
            format = '^[a-zA-Z0-9.!#$%&\'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$'
            break
        }
        const regex = new RegExp(format)
        validators.push((value: any, options: ModelValidateFieldOptions) => regex.test(value) ? value : Error)
      }
      if (field.validate)
        validators.push(field.validate)
    }
  }

  /** Get model name */
  get name() {
    return this.options.name
  }

  /** Validate data over model */
  document (data: Record<string, any>, options?: ModelContextOptions): ModelDocument<TSchema> {
    options = options || {}
    const prefix: string = (options as any).name ? (options as any).name + '.' : ''
    const res = {} as ModelDocument<any>
    for (const name in this.model) {
      const field = this.model[name] as ResolvedFieldSchema
      if (options.validate === false) {
        if (name in data)
          res[name] = data[name]
        continue
      }
      const paramOptions = {...this.options, ...options, field, name: prefix + name, model: this}
      const canWrite = field.canWrite(paramOptions), canRead = field.canRead(paramOptions), required = field.required?.(paramOptions)
      if (options.readOnly) {
        if (canRead === false || !field.type)
          continue
        if (data[name] !== undefined) {
          res[name] = data[name]
          continue
        }
        else if (!required)
          continue
      }
      let v = canWrite === false ? undefined : data[name]
      if (v === undefined) {
        if (options.default !== false && field.default)
          v = field.default.length ? field.default(paramOptions) : (field.default as Function)()
        if (v !== undefined) {
          res[name] = v
          continue
        }
        if (required && canWrite !== false && (!options.insert || name !== '_id'))
          throw new InvalidData('missing ' + name, 'field')
        continue
      }
      if (options.readOnly) {
        res[name] = v
        continue
      }
      if (!field.type)
        continue
      res[name] = this._validateField(v, paramOptions)
    }
    return res as ModelDocument<TSchema>
  }

  private _fieldFunction(value: any, def?: any): ModelCallbackFunc {
    if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
      const names = value.slice(2, -1).split('.')
      if (names.length === 1) {
        const n = names[0]
        if (n === 'now' || n === 'Date')
          return () => new Date()
        if (n === 'ObjectId')
          return () => newObjectId()
        return (options: any) => options[n] ?? def
      }
      return (options: any) => names.reduce((p, n) => p = typeof p === 'object' ? p[n] : undefined, options) ?? def
    }
    if (value === undefined)
      return () => def
    return () => value
  }

  private _validateField (value: any, options: ModelValidateFieldOptions): any {
    const field: ResolvedFieldSchema = options.field
    if (value == null) {
      if (field.required?.(options) && (!options.insert || options.name !== '_id'))
        throw new InvalidData('missing ' + options.name, 'field')
      return null
    }
    return field.validate(value, options) 
  }

  /** Generate filter for data queries */
  getFilter (data: Record<string, any>, options?: ModelContextOptions): Record<string, any> {
    const res: Record<string, any> = {}
    if (data._id)
      res._id = data._id
    for (const name in this.model) {
      if (!(name in res)) {
        const field = this.model[name] as ResolvedFieldSchema
        const paramOptions = {...this.options, ...options, field, name, model: this}
        if ((!options?.primaryKey && name in data) || field.primaryKey)
          res[name] = options?.validate !== false ? this._validateField(data[name], paramOptions) : data[name]
      }
    }
    return res
  }

  /** Find one document */
  async findOne (query: Query, options?: ModelContextOptions): Promise<ModelDocument<TSchema>|undefined> {
    const collection: MicroCollection = await this.collection!
    options = {readOnly: true, ...this.options, ...options}
    const doc = await collection.findOne(this.getFilter(query, options))
    return doc ? this.document(doc, options) : undefined
  }

  /** Find many documents */
  async findMany (query: Query, options?: ModelContextOptions): Promise<ModelDocument<TSchema>[]> {
    const collection: MicroCollection = await this.collection!
    const res: ModelDocument<TSchema>[] = []
    options = {readOnly: true, ...this.options, ...options}
    await collection.find(this.getFilter(query || {}, options)).forEach((doc: ModelDocument<TSchema>) => res.push(this.document(doc, options)))
    return res
  }

  /** Insert a new document */
  async insert (data: Record<string, any>, options?: ModelContextOptions): Promise<ModelDocument<TSchema>> {
    return this.update(data, {...options, insert: true})
  }

  /** Update one matching document */
  async update (query: Record<string, any>, options?: ModelContextOptions): Promise<ModelDocument<TSchema>> {
    const collection: MicroCollection = await this.collection!
    options = {...this.options, ...options}
    if (options?.validate !== false)
      query = this.document(query, options)
    const unset: Record<string, number> = query.$unset || {}
    for (const n in query) {
      if (query[n] === undefined || query[n] === null) {
        query.$unset = unset
        unset[n] = 1
        delete query[n]
      }
    }
    const res = await collection.findAndModify({query: this.getFilter(query, {primaryKey: true, validate: false}), update: query, upsert: options?.insert}) as ModelDocument<TSchema>
    if (!res)
      throw new NotFound('Document not found')
    return res
  }

  /** Update many matching documents */
  async updateMany (query: Record<string, any>, update: Record<string, any>, options?: ModelContextOptions): Promise<ModelDocument<TSchema>> {
    const collection: MicroCollection = await this.collection!
    options = {...this.options, ...options}
    if (options?.validate !== false)
      update = this.document(update, options)
    const unset: Record<string, number> = query.$unset || {}
    for (const n in update) {
      if (update[n] === undefined || update[n] === null) {
        update.$unset = unset
        unset[n] = 1
        delete update[n]
      }
    }
    const res = await collection.updateMany(this.getFilter(query, {primaryKey: true, validate: false}), update) as ModelDocument<TSchema>
    if (!res)
      throw new NotFound('Document not found')
    return res
  }

  /** Delete one matching document */
  async delete (query: Query, options?: ModelContextOptions): Promise<number> {
    const collection: MicroCollection = await this.collection!
    return await collection.deleteOne(this.getFilter(query, {...this.options, ...options}))
  }

  /** Delete many matching documents */
  async deleteMany (query: Query, options?: ModelContextOptions): Promise<number> {
    const collection: MicroCollection = await this.collection!
    return await collection.deleteMany(this.getFilter(query, {...this.options, ...options}))
  }

  /** Microserver middleware */
  handler (req: ServerRequest, res: ServerResponse): any {
    res.isJson = true
    let filter: Query | undefined, filterStr: string | undefined = req.query.filter
    if (filterStr) {
      try {
        if (!filterStr.startsWith('{'))
          filterStr = Buffer.from(filterStr, 'base64').toString('utf-8')
        filter = JSON.parse(filterStr)
      } catch {
      }
    }
    switch (req.method) {
      case 'GET':
        if ('id' in req.params)
          return this.findOne({_id: req.params.id}, {user: req.user, params: req.params, projection: filter}).then(res => ({data: res}))
        return this.findMany({}, {user: req.user, params: req.params, projection: filter}).then(res => ({data: res}))
      case 'POST':
        if (!req.body)
          return res.error(422)
        return this.update(req.body, {user: req.user, params: req.params, insert: true, projection: filter}).then(res => ({data: res}))
      case 'PUT':
        if (!req.body)
          return res.error(422)
        req.body._id = req.params.id
        return this.update(req.body, {user: req.user, params: req.params, insert: false, projection: filter}).then(res => ({data: res}))
      case 'DELETE':
        return this.delete({_id: req.params.id}, {user: req.user, params: req.params, projection: filter}).then(res => ({data: res}))
      default:
        return res.error(422)
    }
  }
}
// #endregion Model

// #region MicroCollection
export declare interface MicroCollectionOptions<T extends ModelSchema = any> {
  /** Collection name */
  name?: string
  /** Custom data saver */
  save?: (id: string, doc: ModelDocument<T> | undefined, col: MicroCollection) => Promise<ModelDocument<T>>
  /** Preloaded data object */
  data?: Record<string, ModelDocument<T>>
}

export declare interface Query {
  [key: string]: any
}

/** Cursor */
export declare interface Cursor<T extends ModelSchema> {
  forEach (cb: Function, self?: any): Promise<number>
  all (): Promise<ModelDocument<T>[]>
}

/** Find options */
export declare interface FindOptions {
  /** Query */  
  query?: Query
  /** is upsert */
  upsert?: boolean
  /** is upsert */
  delete?: boolean
  /** update object */
  update?: Query
  /** maximum number of hits */
  limit?: number
}

/** Collection factory */
export class MicroCollectionStore {
  private _collections: Map<string, MicroCollection> = new Map()
  private _store?: FileStore

  constructor (dataPath?: string, storeTimeDelay?: number) {
    if (dataPath)
      this._store = new FileStore({dir: dataPath.replace(/^\w+:\/\//, ''), debounceTimeout: storeTimeDelay ?? 1000})
    if (!Model.db)
      Model.db = this
  }

  /** Get collection */
  async collection(name: string): Promise<MicroCollection> {
    if (!this._collections.has(name)) {
      const data = await this._store?.load(name, true) || {}
      this._collections.set(name, new MicroCollection({data, name}))
    }
    return this._collections.get(name) as MicroCollection
  }
}

/** minimalistic indexed mongo type collection with persistance for usage with Model */
export class MicroCollection<TSchema extends ModelSchema = any> {
  /** Collection name */
  public name: string
  /** Collection data */
  public data: Record<string, ModelDocument<TSchema>>
  private _save?: (id: string, doc: ModelDocument<TSchema> | undefined, col: MicroCollection) => Promise<ModelDocument<TSchema>>

  constructor(options: MicroCollectionOptions<TSchema> = {}) {
    this.name = options.name || this.constructor.name
    this.data = options.data || {}
    this._save = options.save
  }

  /** Query document with query filter */
  protected queryDocument(query?: Query, data?: ModelDocument<TSchema>) {
    if (query && data)
      for (const n in query) {
        if (query[n] === null)
          if (data[n] != null)
            return
          else
            continue
        if (n.startsWith('$') || typeof query[n] === 'object')
          console.warn(`Invalid query field: ${n}`)
        if (data[n] !== query[n])
          return
      }
    return data
  }

  /** Count all documents */
  async countDocuments(): Promise<number> {
    return Object.keys(this.data).length
  }

  /** Find one matching document */
  async findOne(query: Query): Promise<ModelDocument<TSchema>|undefined> {
    const id: string = query._id
    if (id)
      return this.queryDocument(query, this.data[id])
    let res
    await this.find(query).forEach((doc: ModelDocument<TSchema>) => (res = doc) && false)
    return res
  }

  /** Find all matching documents */
  find(query: Query): Cursor<TSchema> {
    return {
      forEach: async (cb: (doc: ModelDocument<any>) => boolean | void, self?: any): Promise<number> => {
        let count: number = 0
        for (const id in this.data)
          if (this.queryDocument(query, this.data[id])) {
            count++
            if (cb.call(self ?? this, this.data[id]) === false)
              break
            if (query.limit && count >= query.limit)
              break
          }
        return count
      },
      all: async (): Promise<ModelDocument<TSchema>[]> => {
        return Object.values(this.data).filter(doc => this.queryDocument(query, doc))
      }
    }
  }

  /** Find and modify one matching document */
  async findAndModify(options: FindOptions): Promise<ModelDocument<TSchema>|undefined> {
    const res = await this.findOne(options.query || {})
    if (res?._id) {
      await this.updateOne({_id: res._id}, options.update || {}, options)
      return this.data[res._id]
    }
    if (options.upsert) {
      const doc = {...options.query} as ModelDocument<TSchema>
      for (const n in options.update)
        if (!n.startsWith('$'))
          (doc as any)[n] = options.update[n]
      if (options.update?.$set)
        Object.assign(doc, options.update.$set)
      return this.insertOne(doc)
    }
  }

  /** Insert one document */
  async insertOne(doc: ModelDocument<TSchema>): Promise<ModelDocument<TSchema>> {
    if (doc._id && this.data[doc._id])
      throw new InvalidData(`Document ${doc._id} dupplicate`)
    doc = {...doc}
    if (!doc._id)
      doc._id = newObjectId()
    this.data[doc._id] = doc
    if (this._save)
      this.data[doc._id] = doc = await this._save(doc._id, doc, this) || doc
    return doc
  }

  /** Insert multiple documents */
  async insertMany(docs: ModelDocument<TSchema>[]): Promise<ModelDocument<TSchema>[]> {  
    docs.forEach(doc => {
      if (doc._id && this.data[doc._id])
        throw new InvalidData(`Document ${doc._id} dupplicate`)
    })
    for (let i = 0; i < docs.length; i++)
      docs[i] = await this.insertOne(docs[i])
    return docs
  }

  /** Delete one matching document */
  async deleteOne(query: Query): Promise<number> {
    return (await this.updateMany(query, {}, {delete: true, limit: 1})).modifiedCount
  }

  /** Delete all matching documents */
  async deleteMany(query: Query): Promise<number> {
    return (await this.updateMany(query, {}, {delete: true})).modifiedCount
  }

  /** Update one matching document */
  async updateOne(query: Query, update: Record<string, any>, options?: FindOptions): Promise<{upsertedId: any, modifiedCount: number}> {
    const res = await this.updateMany(
      query,
      update, 
      {...options, limit: 1}
    )
    return res
  }

  /** Update many matching documents */
  async updateMany(query: Query, update: Record<string, any>, options?: FindOptions): Promise<{upsertedId: any, modifiedCount: number}> {
    let res = {upsertedId: undefined, modifiedCount: 0}
    if (!query)
      return res

    let promise = Promise.resolve()
    
    this.find(query).forEach((doc: ModelDocument<TSchema>) => {
      if (this.queryDocument(query, doc)) {
        if (options?.delete) {
          if (!doc._id)
            return
          res.modifiedCount++ 
          if (this._save)
            promise = promise.then(async () => {doc._id && this._save?.(doc._id, undefined, this)})
          delete this.data[doc._id]
        } else {
          Object.assign(doc, update)
          res.modifiedCount++
          if (this._save) {
            promise = promise.then(async () => {
              if (!doc._id)
                throw new Error('Internal error: missing _id in document')
              this.data[doc._id] = await this._save?.(doc._id, doc, this) || this.data[doc._id]
            })
          }
        }
        if (options?.limit && res.modifiedCount >= options?.limit)
          return false
      }
    })
    await promise
    if (res.modifiedCount || !options?.upsert || options?.delete)
      return res

    if (!query._id)
      query._id = (res as any).upsertedId = newObjectId()
    let doc = this.queryDocument(options.query, this.data[query._id])
    if (doc)
      throw new InvalidData(`Document dupplicate`)
    doc = {_id: query._id, ...query} as ModelDocument<TSchema>
    this.data[query._id] = doc
    if (update) {
      for (const n in update) {
        if (!n.startsWith('$'))
          (doc as any)[n] = update[n]
      }
      if (update.$set) {
        for (const n in update.$set)
          (doc as any)[n] = update.$set[n]
      }
      if (update.$unset) {
        for (const n in update.$unset)
          delete doc[n]
      }
    }
    if (this._save)
      this.data[query._id] = await this._save(query._id, doc, this) || doc
    return res 
  }
}
// #endregion MicroCollection
