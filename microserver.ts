/**
 * MicroServer
 * @version 2.3.3
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

const defaultToken = 'wx)>:ZUqVc+E,u0EmkPz%ZW@TFDY^3vm'
const defaultExpire = 24 * 60 * 60
const defaultMaxBodySize = 5 * 1024 * 1024
const defaultMethods = 'HEAD,GET,POST,PUT,PATCH,DELETE'

function NOOP (...args: any[]) { }

function isFunction (fn: any): boolean {
  return typeof fn === 'function' && !fn.prototype?.constructor;
}

export class Warning extends Error {
  constructor (text: string) {
    super(text)
  }
}

const commonCodes: {[key: number]: string} = { 404: 'Not found', 403: 'Access denied', 422: 'Invalid data'}
const commonTexts: {[key: string]: number} = {'Not found': 404, 'Access denied': 403, 'Permission denied': 422, 'Invalid data': 422, InvalidData: 422, AccessDenied: 403, NotFound: 404, Failed: 422, OK: 200 }
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

export type Routes = () => Record<string, Array<any>> | Array<Array<any>>

export abstract class Plugin {
  name?: string
  priority?: number
  handler?(req: ServerRequest, res: ServerResponse, next: Function): Promise<string | object | void> | string | object | void
  routes?(): Promise<Routes> | Routes 
  initialise?(): Promise<void> | void
  constructor(router: Router, ...args: any) { }
}

interface PluginClass {
  new(router: Router, ...args: any): Plugin
}

interface UploadFiles {
  list: any[]
  uploadDir: string
  resolve: (res?: any) => void
  done?: boolean
  boundary: string
  chunk?: Buffer
  last?: any
}

export type ServerRequestBody<T = any> = T extends Model<infer U extends ModelSchema> ? ModelDocument<U> : Record<string, any>

/** Extended http.IncomingMessage */
export class ServerRequest<T = any> extends http.IncomingMessage {
  /** Request protocol: http or https */
  public protocol!: string
  /** Request client IP */
  public ip?: string
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
  public router!: Router
  /** Authentication object */
  public auth?: Auth
  /** Authenticated user info */
  public user?: UserInfo
  /** Model used for request */
  public model?: T
  /** Authentication token id */
  public tokenId?: string

  private _body?: ServerRequestBody<T>
  /** Request raw body */
  public rawBody!: Buffer[]
  /** Request raw body size */
  public rawBodySize!: number
  
  private constructor (router: Router) {
    super(new net.Socket())
    this._init(router)
  }

  private _init (router: Router) {
    Object.assign(this, {
      router,
      auth: router.auth,
      protocol: 'encrypted' in this.socket && this.socket.encrypted ? 'https' : 'http',
      query: {},
      params: {},
      paramsList: [],
      path: '/',
      pathname: '/',
      baseUrl: '/',
      rawBody: [],
      rawBodySize: 0
    })
    this.updateUrl(this.url || '/')
  }

  /** Update request url */
  updateUrl (url: string) {
    this.url = url
    if (!this.originalUrl)
      this.originalUrl = url

    const parsedUrl = new URL(url || '/', 'body:/'), pathname = parsedUrl.pathname
    this.pathname = pathname
    this.path = pathname.slice(pathname.lastIndexOf('/'))
    this.baseUrl = pathname.slice(0, pathname.length - this.path.length)
    this.query = {}
    parsedUrl.searchParams.forEach((v, k) => this.query[k] = v)
  }

  /** Rewrite request url */
  rewrite (url: string): void {
    throw new Error('Internal error')
  }
  
  /** Request body: JSON or POST parameters */
  get body () {
    if (!this._body) {
      if (this.method === 'GET')
        this._body = {} as ServerRequestBody<T>
      else {
        const contentType = this.headers['content-type'] || '',
          charset = contentType.match(/charset=(\S+)/)
        let bodyString = Buffer.concat(this.rawBody).toString((charset ? charset[1] : 'utf8') as BufferEncoding)
        this._body = {} as ServerRequestBody<T>
        if (bodyString.startsWith('{') || bodyString.startsWith('[')) {
          try {
            this._body = JSON.parse(bodyString)
          } catch {
            throw new Error('Invalid request format')
          }
        } else if (contentType.startsWith('application/x-www-form-urlencoded')) {
          this._body = querystring.parse(bodyString) as ServerRequestBody<T>
        }
      }
    }
    return this._body
  }

  /** Alias to body */
  get post () {
    return this.body
  }

  private _websocket?: WebSocket
  /** Get websocket */
  get websocket(): WebSocket {
    if (!this._websocket) {
      if (!this.headers.upgrade)
        throw new Error('Invalid WebSocket request')
      this._websocket = new WebSocket(this, {
        permessageDeflate: this.router.server.config.websocketCompress,
        maxPayload: this.router.server.config.websocketMaxPayload || 1024 * 1024,
        maxWindowBits: this.router.server.config.websocketMaxWindowBits || 10
      })
    }
    if (!this._websocket.ready)
      throw new Error('Invalid WebSocket request')
    return this._websocket
  }

  private _files: UploadFiles | undefined
  /** get files list in request */
  async files (): Promise<any[] | undefined> {
    this.resume()
    delete this.headers.connection
    const files = this._files
    if (files) {
       if (files.resolve !== NOOP)
        throw new Error('Invalid request files usage')
      return new Promise((resolve, reject) => {
        files.resolve = err => {
          files.done = true
          files.resolve = NOOP
          if (err) reject(err)
          else resolve(files.list)
        }
        if (files.done)
          files.resolve()
      })
    }
  }

  /** Decode request body */
  bodyDecode(res: ServerResponse, options: any, next: () => void) {
    const contentType = (this.headers['content-type'] || '').split(';')
    const maxSize = options.maxBodySize || defaultMaxBodySize

    if (contentType.includes('multipart/form-data')) {
      const chunkParse = (chunk: Buffer) => {
        const files: UploadFiles | undefined = this._files
        if (!files || files.done)
          return
        chunk = files.chunk = files.chunk ? Buffer.concat([files.chunk, chunk]) : chunk
        const p: number = chunk.indexOf(files.boundary) || -1
        if (p >= 0 && chunk.length - p >= 2) {
          if (files.last) {
            if (p > 0)
              files.last.write(chunk.subarray(0, p))
            files.last.srtream.close()
            delete files.last.srtream
            files.last = undefined
          }
          let pe = p + files.boundary.length
          if (chunk[pe] === 13 && chunk[pe + 1] === 10) {
            chunk = files.chunk = chunk.subarray(p)
            // next header
            pe = chunk.indexOf('\r\n\r\n')
            if (pe > 0) { // whole header
              const header = chunk.toString('utf8', files.boundary.length + 2, pe)
              chunk = chunk.subarray(pe + 4)
              const fileInfo = header.match(/content-disposition: ([^\r\n]+)/i)
              const contentType = header.match(/content-type: ([^\r\n;]+)/i)
              let fieldName: string = '', fileName: string = ''
              if (fileInfo)
                fileInfo[1].replace(/(\w+)="?([^";]+)"?/, (_: string, n: string, v: string) => {
                  if (n === 'name')
                    fieldName = v
                  if (n === 'filename')
                    fileName = v
                  return _
                })
              if (fileName) {
                let file: string
                do {
                  file = path.resolve(path.join(files.uploadDir, crypto.randomBytes(16).toString('hex') + '.tmp'))
                } while (fs.existsSync(file))
                files.last = {
                  name: fieldName,
                  fileName: fileName,
                  contentType: contentType && contentType[1],
                  file: file,
                  stream: fs.createWriteStream(file)
                }
                files.list.push(files.last)
              } else if (fieldName) {
                files.last = {
                  name: fieldName,
                  stream: {
                    write: (chunk: Buffer) => {
                      if (!this._body)
                        this._body = {} as ServerRequestBody<T>
                      (this._body as any)[fieldName] = (this._body[fieldName] || '') + chunk.toString()
                    },
                    close () { }
                  }
                }
              }
            }
          } else {
            files.chunk = undefined
            files.done = true
          }
        } else {
          if (chunk.length > 8096) {
            if (files.last)
              files.last.stream.write(chunk.subarray(0, files.boundary.length - 1))
            chunk = files.chunk = chunk.subarray(files.boundary.length - 1)
          }
        }
      }

      this.pause()
      //res.setHeader('Connection', 'close') // TODO: check if this is needed
      this._body = {} as ServerRequestBody<T>
      const files = this._files = {
        list: [],
        uploadDir: path.resolve(options.uploadDir || 'upload'),
        resolve: NOOP,
        boundary: ''
      }
      if (!contentType.find(l => {
        const p = l.indexOf('boundary=')
        if (p >= 0) {
          files.boundary = '\r\n--' + l.slice(p + 9).trim()
          return true
        }
      }))
        return res.error(400)
      next()
      this.once('error', () => files.resolve(new ResponseError('Request error')))
        .on('data', chunk => chunkParse(chunk))
        .once('end', () => files.resolve(new Error('Request error')))

      res.on('finish', () => this._removeTempFiles())
      res.on('error', () => this._removeTempFiles())
      res.on('close', () => this._removeTempFiles())
    } else {
      this.once('error', err => console.error(err))
        .on('data', chunk => {
          this.rawBodySize += chunk.length
          if (this.rawBodySize >= maxSize) {
            this.pause()
            res.setHeader('Connection', 'close')
            res.error(413)
          } else
            this.rawBody.push(chunk)
        })
        .once('end', next)
    }
  }

  private _removeTempFiles () {
    if (this._files) {
      if (!this._files.done) {
        this.pause()
        this._files.resolve(new Error('Invalid request files usage'))
      }

      this._files.list.forEach(f => {
        if (f.stream)
          f.stream.close()
        if (f.file)
          fs.unlink(f.file, NOOP)
      })
      this._files = undefined
    }
  }
}

/** Extends http.ServerResponse */
export class ServerResponse<T = any> extends http.ServerResponse {
  declare req: ServerRequest<T>
  public router!: Router
  public isJson!: boolean
  public headersOnly!: boolean

  private constructor (router: Router) {
    super(new http.IncomingMessage(new net.Socket()))
    this._init(router)
  }

  private _init (router: Router) {
    this.router = router
    this.isJson = false
    this.headersOnly = false
    this.statusCode = 200
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
      this.statusCode = 500
      this.send('Internal error')
      console.error(e)
    }
  }
  
  /** Sets Content-Type acording to data and sends response */
  send (data: string | Buffer | Error | Readable | object = ''): void {
    if (data instanceof Readable)
      return (data.pipe(this, {end: true}), void 0)
    if (!this.getHeader('Content-Type') && !(data instanceof Buffer)) {
      if (data instanceof Error)
        return this.error(data)
      if (this.isJson || typeof data === 'object') {
        data = JSON.stringify(typeof data === 'string' ? { message: data } : data)
        this.setHeader('Content-Type', 'application/json')
      } else {
        data = data.toString()
        if (data[0] === '{' || data[1] === '[')
          this.setHeader('Content-Type', 'application/json')
        else if (data[0] === '<' && (data.startsWith('<!DOCTYPE') || data.startsWith('<html')))
          this.setHeader('Content-Type', 'text/html')
        else
          this.setHeader('Content-Type', 'text/plain')
      }
    }
    data = data.toString()
    this.setHeader('Content-Length', Buffer.byteLength(data, 'utf8'))
    if (this.headersOnly)
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
      return this.json(error)
    this.json(typeof error === 'string' ? { success: false, error } : { success: false, ...error })
  }
  
  /** Send json response in form { success: true, ... } */
  jsonSuccess (data?: object | string): void {
    this.isJson = true
    if (data instanceof Error)
      return this.json(data)
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

  /** Set status code */
  status (code: number): this {
    this.statusCode = code
    return this    
  }

  download (path: string, filename?: string): void {
    StaticPlugin.serveFile(this.req, this, {
      path: path,
      filename: filename || basename(path),
      mimeType: StaticPlugin.mimeTypes[extname(path)] || 'application/octet-stream'
    })
  }
}

/** WebSocket options */
export interface WebSocketOptions {
  maxPayload?: number
  autoPong?: boolean
  permessageDeflate?: boolean
  maxWindowBits?: number
  timeout?: number
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

/** WebSocket class */
export class WebSocket extends EventEmitter{
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
    this._upgrade(key, headers)
  }

  private _upgrade (key: string, headers: string[] = []) {
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
    this._socket.write(headers.join('\r\n'))
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

  protected _sendFrame (opcode: number, data: Buffer, cb?: () => void) {
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
}

const server = {}

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
    res.isJson = true
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
      const list: Array<string|Function> = [method + ' ' + url.replace(/\/\//g, '/')]
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

/** Middleware */
export interface Middleware {
  (req: ServerRequest, res: ServerResponse, next: Function): any;
  /** @default 0 */
  priority?: number;
  plugin?: Plugin;
}

/** Internal router item */
interface RouterItem {
  name?: string
  hook?: Middleware[]
  next?: Middleware[]
  param?: RouterItem
  last?: RouterItem
  tree?: Record<string, RouterItem>
}

class WaiterJob {
  _waiters: any = []
  _busy: number = 0

  start() {
    this._busy++
  }

  end() {
    this._busy--
    for (const resolve of this._waiters.splice(0))
      resolve()
  }

  async wait() {
    if (!this._busy)
      return
    return new Promise<void>(resolve => this._waiters.push(resolve))
  }
}

class Waiter {
  private _id: number = 0
  private _waiters: Record<string, WaiterJob> = {}

  isBusy(id?: string) {
    const waiter = this._waiters[id || 'ready']
    return !!waiter?._busy
  }

  startJob(id?: string) {
    let waiter = this._waiters[id || 'ready']
    if (!waiter)
      waiter = this._waiters[id || 'ready'] = new WaiterJob()
    waiter._busy++
  }

  endJob(id?: string) {
    const waiter = this._waiters[id || 'ready']
    if (waiter)
      waiter.end()
  }

  get nextId() {
    return (++this._id).toString()
  }

  async wait(id?: string): Promise<void> {
    const waiter = this._waiters[id || 'ready']
    if (!waiter)
      return
    return waiter.wait()
  }
}

/** Router */
export class Router extends EventEmitter {
  public server: MicroServer
  public auth?: Auth
  public plugins: Record<string, Plugin> = {}

  private _stack: Middleware[] = []
  private _stackAfter: Middleware[] = []
  private _tree: Record<string, RouterItem> = {}
  _waiter: Waiter = new Waiter()
  
  /** @param {MicroServer} server  */
  constructor (server: MicroServer) {
    super()
    this.server = server
  }

  /** bind middleware or create one from string like: 'redirect:302,https://redirect.to', 'error:422', 'param:name=value', 'acl:users/get', 'model:User', 'group:Users', 'user:admin' */
  bind (fn: string | Function | object): Function {
    if (typeof fn === 'string') {
      let name = fn
      let idx = name.indexOf(':')
      if (idx < 0 && name.includes('=')) {
        name = 'param:' + name
        idx = 5
      }
      if (name === 'json')
        return (req: ServerRequest, res: ServerResponse) => res.isJson = true
      if (idx >= 0) {
        const v = name.slice(idx + 1)
        const type = name.slice(0, idx)

        // predefined middlewares
        switch (type) {
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

  /** Handler */
  handler (req: ServerRequest, res: ServerResponse, next: Function, method?: string) {
    const nextAfter: Function = next
    next = () => this._walkStack(this._stackAfter, req, res, nextAfter)
    if (method)
      return !this._walkTree(this._tree[method], req, res, next) && next()
    const walk = () => {
      if (!this._walkTree(this._tree[req.method || 'GET'], req, res, next) &&
        !this._walkTree(this._tree['*'], req, res, next))
        next()
    }
    req.rewrite = (url: string) => {
      if (req.originalUrl)
        res.error(508)
      req.updateUrl(url)
      walk()
    }
    this._walkStack(this._stack, req, res, walk)
  }

  private _walkStack (rstack: Function[], req: ServerRequest, res: ServerResponse, next: Function) {
    let rnexti = 0
    const sendData = (data: any) => {
      if (!res.headersSent && data !== undefined) {
        if ((data === null || typeof data === 'string') && !res.isJson)
          return res.send(data)
        if (typeof data === 'object' && 
          (data instanceof Buffer || data instanceof Readable || (data instanceof Error && !res.isJson)))
          return res.send(data)
        return res.jsonSuccess(data)
      }
    }
    const rnext = () => {
      const cb = rstack[rnexti++]
      if (cb) {
        try {
          req.router = this
          const p = cb(req, res, rnext)
          if (p instanceof Promise)
            p.catch(e => e).then(sendData)
          else
            sendData(p)
        } catch (e) {
          sendData(e)
        }
      } else
        return next()
    }
    return rnext()
  }
  
  private _walkTree (item: RouterItem | undefined, req: ServerRequest, res: ServerResponse, next: Function) {
    req.params = {}
    req.paramsList = []
    const rstack: Function[] = []
    const reg = /\/([^/]*)/g
    let m: RegExpExecArray | null
    let lastItem, done
    while (m = reg.exec(req.pathname)) {
      const name = m[1]
      if (!item || done) {
        item = undefined
        break
      }
      if (lastItem !== item) {
        lastItem = item
        item.hook?.forEach((hook: Function) => rstack.push(hook.bind(item)))
      }
      if (!item.tree) { // last
        if (item.name) {
          req.params[item.name] += '/' + name
          req.paramsList[req.paramsList.length - 1] = req.params[item.name]
        } else
          done = true
      } else {
        item = item.last || item.tree[name] || item.param
        if (item && item.name) {
          req.params[item.name] = name
          req.paramsList.push(name)
        }
      }
    }
    if (lastItem !== item)
      item?.hook?.forEach((hook: Function) => rstack.push(hook.bind(item)))
    item?.next?.forEach((cb: Function) => rstack.push(cb))
    if (!rstack.length)
      return
    this._walkStack(rstack, req, res, next)
    return true
  }  

  private _add (method: string, url: string, key: 'next' | 'hook', middlewares: any[]) {
    if (key === 'next')
      this.server.emit('route', {
        method,
        url,
        middlewares
      })
    middlewares = middlewares.map(m => this.bind(m))

    let item: RouterItem = this._tree[method]
    if (!item)
      item = this._tree[method] = { tree: {} }
    if (!url.startsWith('/')) {
      if (method === '*' && url === '') {
        this._stack.push(...middlewares)
        return this
      }
      url = '/' + url
    }
    const reg = /\/(:?)([^/*]+)(\*?)/g
    let m: RegExpExecArray | null
    while (m = reg.exec(url)) {
      const param: string = m[1], name: string = m[2], last: string = m[3]
      if (last) {
        item.last = { name: name }
        item = item.last
      } else {
        if (!item.tree)
          throw new Error('Invalid route path')
        if (param) {
          item = item.param = item.param || { tree: {}, name: name }
        } else {
          let subitem = item.tree[name]
          if (!subitem)
            subitem = item.tree[name] = { tree: {} }
          item = subitem
        }
      }
    }
    if (!item[key])
      item[key] = []
    item[key].push(...middlewares)
  }

  /** Clear routes and middlewares */
  clear () {
    this._tree = {}
    this._stack = []
    return this
  }

  /**
   * Add middleware route.
   * Middlewares may return promises for res.jsonSuccess(...), throw errors for res.error(...), return string or {} for res.send(...)
   *
   * @signature add(plugin: Plugin)
   * @param {Plugin} plugin plugin module instance
   * @return {Promise<>}
   *
   * @signature add(pluginid: string, ...args: any)
   * @param {string} pluginid pluginid module
   * @param {...any} args arguments passed to constructor
   * @return {Promise<>}
   *
   * @signature add(pluginClass: typeof Plugin, ...args: any)
   * @param {typeof Plugin} pluginClass plugin class
   * @param {...any} args arguments passed to constructor
   * @return {Promise<>}
   *
   * @signature add(middleware: Middleware)
   * @param {Middleware} middleware
   * @return {Promise<>}
   * 
   * @signature add(methodUrl: string, ...middlewares: any)
   * @param {string} methodUrl 'METHOD /url' or '/url'
   * @param {...any} middlewares
   * @return {Promise<>}
   *
   * @signature add(methodUrl: string, controllerClass: typeof Controller)
   * @param {string} methodUrl 'METHOD /url' or '/url'
   * @param {typeof Controller} controllerClass
   * @return {Promise<>}
   *
   * @signature add(methodUrl: string, routes: Array<Array<any>>)
   * @param {string} methodUrl 'METHOD /url' or '/url'
   * @param {Array<Array<any>>} routes list with subroutes: ['METHOD /suburl', ...middlewares]
   * @return {Promise<>}
   *
   * @signature add(methodUrl: string, routes: Array<Array<any>>)
   * @param {string} methodUrl 'METHOD /url' or '/url'
   * @param {Array<Array<any>>} routes list with subroutes: ['METHOD /suburl', ...middlewares]
   * @return {Promise<>}
   * 
   * @signature add(routes: { [key: string]: Array<any> })
   * @param { {[key: string]: Array<any>} } routes list with subroutes: 'METHOD /suburl': [...middlewares]
   * @return {Promise<>}
   * 
   * @signature add(methodUrl: string, routes: { [key: string]: Array<any> })
   * @param {string} methodUrl 'METHOD /url' or '/url'
   * @param { {[key: string]: Array<any>} } routes list with subroutes: 'METHOD /suburl': [...middlewares]
   * @return {Promise<>}
   */
  async use (...args: any): Promise<void> {
    if (!args[0])
      return

    this.server._waiter.startJob()

    for (let i = 0; i < args.length; i++)
      args[i] = await args[i]

    // use(plugin)
    if (args[0] instanceof Plugin) {
      await this._plugin(args[0])
      return this.server._waiter.endJob()
    }

    // use(pluginid, ...args)
    if (typeof args[0] === 'string' && MicroServer.plugins[args[0]]) { 
      const constructor = MicroServer.plugins[args[0]]
      const plugin = new constructor(this, ...args.slice(1))
      await this._plugin(plugin)
      return this.server._waiter.endJob()
    }

    // use(PluginClass, ...args)
    if (typeof args[0] === 'function' && args[0].prototype instanceof Plugin) {
      const plugin = new args[0](this, ...args.slice(1))
      await this._plugin(plugin)
      return this.server._waiter.endJob()
    }

    // use(middleware)
    if (isFunction(args[0])) {
      this._middleware(args[0] as Middleware)
      return this.server._waiter.endJob()
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
      args = args.slice(1)
    }

    // use('/url', ControllerClass)
    if (typeof args[0] === 'function' && args[0].prototype instanceof Controller) {
      const routes = await args[0].routes()
      if (routes)
        args[0] = routes
    }

    // use('/url', [ ['METHOD /url', ...], {'METHOD } ])
    if (Array.isArray(args[0])) {
      if (method !== '*')
        throw new Error('Invalid router usage')
      for (const item of args[0]) {
        if (Array.isArray(item)) {
          // [methodUrl, ...middlewares]
          if (typeof item[0] !== 'string' || !item[0].match(/^(\w+ )?\//))
            throw new Error('Url expected')
          await this.use(item[0].replace(/\//, (url === '/' ? '' : url) + '/'), ...item.slice(1))
        } else
          throw new Error('Invalid param')        
      }
      return this.server._waiter.endJob()
    }

    // use('/url', {'METHOD /url': [...middlewares], ... } ])
    if (typeof args[0] === 'object' && args[0].constructor === Object) {
      if (method !== '*')
        throw new Error('Invalid router usage')
      for (const [subUrl, subArgs] of Object.entries(args[0])) {
        if (!subUrl.match(/^(\w+ )?\//))
          throw new Error('Url expected')
        await this.use(subUrl.replace(/\//, (url === '/' ? '' : url) + '/'), ...(Array.isArray(subArgs) ? subArgs : [subArgs]))    
      }
      return this.server._waiter.endJob()
    }

    // use('/url', ...middleware)
    this._add(method, url, 'next', args.filter((o: any) => o))
    return this.server._waiter.endJob()
  }

  private _middleware(middleware?: Middleware): void {
    if (!middleware)
      return
    const priority: number = (middleware?.priority || 0) - 1
    const stack = priority < -1 ? this._stackAfter : this._stack

    const idx = stack.findIndex(f => 'priority' in f
      && priority >= (f.priority || 0))
    stack.splice(idx < 0 ? stack.length : idx, 0, middleware)
  }

  private async _plugin(plugin: Plugin): Promise<void> {
    let added: string | undefined
    if (plugin.name) {
      if (this.plugins[plugin.name])
        throw new Error(`Plugin ${plugin.name} already added`)
      this.plugins[plugin.name] = plugin
      added = plugin.name
    }
    await plugin.initialise?.()
    if (plugin.handler) {
      const middleware: Middleware = plugin.handler.bind(plugin)
      middleware.plugin = plugin
      middleware.priority = plugin.priority
      this._middleware(middleware)
    }
    if (plugin.routes)
      await this.use(isFunction(plugin.routes) ? await plugin.routes() : plugin.routes)
    if (added)
      this.emit(added)
  }

  async waitPlugin (id: string): Promise<Plugin> {
    if (!this.plugins[id])
      await this._waiter.wait(id)
    return this.plugins[id]
  }

  /** Add hook */
  hook (url: string, ...mid: Middleware[]): void {
    const m = url.match(/^([A-Z]+) (.*)/)
    let method = '*'
    if (m)
      [method, url] = [m[1], m[2]]
    this._add(method, url, 'hook', mid)
  }

  /** Check if middleware allready added */
  has (mid: Middleware): boolean {
    return this._stack.includes(mid) || (mid.name && !!this._stack.find(f => f.name === mid.name)) || false
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

/** MicroServer configuration */
export interface MicroServerConfig extends ListenConfig {
  /** server instance root path */
  root?: string
  /** Auth options */
  auth?: AuthOptions
  /** routes to add */
  routes?: any
  /** Static file options */
  static?: StaticOptions
  /** max body size (default: 5MB) */
  maxBodySize?: number
  /** allowed HTTP methods */
  methods?: string
  /** trust proxy */
  trustProxy?: string[]
  /** cors options */
  cors?: string | CorsOptions | boolean
  /** upload dir (default: './upload') */
  uploadDir?: string,
  /** allow websocket deflate compression (default: false) */
  websocketCompress?: boolean,
  /** max websocket payload (default: 1MB) */
  websocketMaxPayload?: number,
  /** websocket max window bits 8-15 for deflate (default: 10) */
  websocketMaxWindowBits?: number,
  /** extra options for plugins */
  [key: string]: any
}

export class MicroServer extends EventEmitter {
  /** server configuration */
  public config: MicroServerConfig
  /** main router */
  public router: Router
  /** virtual host routers */
  public vhosts?: {[key: string]: Router}
  /** all sockets */
  public sockets: Set<net.Socket>
  /** server instances */
  public servers: Set<net.Server>

  _waiter: Waiter = new Waiter()

  public static plugins: {[key: string]: PluginClass} = {}
  private _methods: {[key: string]: boolean} = {}

  constructor (config: MicroServerConfig) {
    super()

    let promise = Promise.resolve()
    this.config = {
      maxBodySize: defaultMaxBodySize,
      methods: defaultMethods,
      ...config,
      root: path.normalize(config.root || process.cwd())
    };
    (config.methods || defaultMethods).split(',').map(s => s.trim()).forEach(m => this._methods[m] = true)
    this.router = new Router(this)

    this.servers = new Set()
    this.sockets = new Set()

    if (config.routes)
      this.use(config.routes)

    for (const key in MicroServer.plugins) {
      if (config[key])
        this.router.use(MicroServer.plugins[key], config[key])
    }

    if (config.listen) {
      this._waiter.startJob()
      this.listen({
        tls: config.tls,
        listen: config.listen || 8080
      }).then(() => {
        this._waiter.endJob()
      })
    }
    this._waiter.wait().then(() => this.emit('ready'))
  }

  /** Add one time listener or call immediatelly for 'ready' */
  once (name: string, cb: Function) {
    if (name === 'ready' && this.isReady)
      cb()
    else
      super.once(name, cb as any)
    return this
  }

  /** Add listener and call immediatelly for 'ready'  */
  on (name: string, cb: Function) {
    if (name === 'ready' && this.isReady)
      cb()
    super.on(name, cb as any)
    return this
  }

  public get isReady(): boolean {
    return !this._waiter.isBusy()
  }

  async waitReady (): Promise<void> {
    if (this.isReady)
      return
    return this._waiter.wait()
  }

  async waitPlugin (id: string): Promise<void> {
    await this.router.waitPlugin(id)
  }

  /** Listen server, should be used only if config.listen is not set */
  listen (config?: ListenConfig): Promise<void> {
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
      this._waiter.startJob('listen')
      let {proto, host, port} = reg.exec(listen)?.groups || {}
      let srv: net.Server | http.Server | https.Server
      switch (proto) {
        case 'tcp':
          if (!config?.handler)
            throw new Error('Handler is required for tcp')
          srv = net.createServer(handler as any)
          break
        case 'tls':
          if (!config?.handler)
            throw new Error('Handler is required for tls')
          srv = tls.createServer(tlsOptions(), handler as any)
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

      this.servers.add(srv)
      if (port === '0') // skip listening
        this._waiter.endJob('listen')
      else {
        srv.listen(parseInt(port), host?.replace(/[\[\]]/g, '') || '0.0.0.0', () => {
          const addr: net.AddressInfo = srv.address() as net.AddressInfo
          this.emit('listen', addr.port, addr.address, srv);
          (srv as any)._ready = true
          this._waiter.endJob('listen')
        })
      }
      srv.on('error', err => {
        srv.close()
        this.servers.delete(srv)
        if (!(srv as any)._ready)
          this._waiter.endJob('listen')
        this.emit('error', err)
      })
      srv.on('connection', s => {
        this.sockets.add(s)
        s.once('close', () => this.sockets.delete(s))
      })
      srv.on('upgrade', this.handlerUpgrade.bind(this))
    })
    return this._waiter.wait('listen')
  }

  /** Add middleware, routes, etc.. see {router.use} */
  use (...args: any): Promise<void> {
    return this.router.use(...args)
  }

  /** Default server handler */
  handler (req: ServerRequest, res: ServerResponse): void {
    this.requestInit(req, res)

    // limit input data size
    if (parseInt(req.headers['content-length'] || '-1') > (this.config.maxBodySize || defaultMaxBodySize)) {
      req.pause()
      res.error(413)
      return
    }

    this.handlerInit(req, res, () => this.handlerLast(req, res))
  }

  protected requestInit (req: ServerRequest, res?: ServerResponse) {
    Object.setPrototypeOf(req, ServerRequest.prototype);
    (req as any)._init(this.router)

    if (res) {
      Object.setPrototypeOf(res, ServerResponse.prototype);
      (res as any)._init(this.router)
    }
  }

  /** Preprocess request, used by {MicroServer.handler} */
  handlerInit (req: ServerRequest, res: ServerResponse, next: Function) {
    let cors = this.config.cors
    if (cors && req.headers.origin) {
      if (cors === true)
        cors = '*'
      if (typeof cors === 'string')
        cors = { origin: cors, headers: 'Content-Type', credentials: true }

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

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.setHeader('Allow', this.config.methods || defaultMethods)
      res.end()
      return
    }

    if (!req.method ||!this._methods[req.method]) {
      res.statusCode = 405
      res.setHeader('Allow', this.config.methods || defaultMethods)
      res.end()
      return
    }

    if (req.method === 'HEAD') {
      req.method = 'GET'
      res.headersOnly = true
    }

    return req.bodyDecode(res, this.config, () => {
      if ((req.rawBodySize && req.rawBody[0] && (req.rawBody[0][0] === 91 || req.rawBody[0][0] === 123))
        || req.headers.accept?.includes?.('json') || req.headers['content-type']?.includes?.('json'))
        res.isJson = true
  
      return req.router.handler(req, res, next)
    })
  }

  /** Last request handler */
  handlerLast (req: ServerRequest, res: ServerResponse, next?: Function) {
    if (res.headersSent)
      return
    if (!next)
      next = () => res.error(404)
    return next()
  }

  /** Default upgrade handler, used for WebSockets */
  handlerUpgrade (req: ServerRequest, socket: net.Socket, head: any) {
    this.requestInit(req)

    //req.headers = head
    //(req as any)['head'] = head
    const host: string = req.headers.host || ''
    const router = this.vhosts?.[host] || this.router    
    const res = {
      get headersSent (): boolean {
        return socket.bytesWritten > 0
      },
      statusCode: 200,
      socket,
      server,
      write (data?: string): void {
        if (res.headersSent)
          throw new Error('Headers already sent')
        let code = res.statusCode || 403
        if (code < 400) {
          data = 'Invalid WebSocket response'
          console.error(data)
          code = 500
        }
        if (!data)
          data = http.STATUS_CODES[code] || ''
        const headers: string[] = [
          `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}`,
          'Connection: close',
          'Content-Type: text/html',
          `Content-Length: ${Buffer.byteLength(data)}`,
          '',
          data
        ]
        socket.write(headers.join('\r\n'), () => { socket.destroy() });
      },
      error (code: number): void {
        res.statusCode = code || 403
        res.write()
      },
      end (data?: string): void {
        res.write(data)
      },
      send (data?: string): void {
        res.write(data)
      },
      setHeader (): void { }
    }
    router.handler(req, res as unknown as ServerResponse, () => res.error(404), 'WEBSOCKET')
  }

  /** Close server instance */
  async close () {
    return new Promise((resolve: Function) => {
      let count = 0
      function done () {
        count--
        if (!count)
          setTimeout(() => resolve(), 2)
      }
      for (const s of this.servers) {
        count++
        s.once('close', done)
        s.close()
      }
      this.servers.clear()
      for (const s of this.sockets) {
        count++
        s.once('close', done)
        s.destroy()
      }
      this.sockets.clear()
    }).then(() => {
      this.emit('close')
    })
  }

  /** Add route, alias to `server.router.use(url, ...args)` */
  all (url: string, ...args: any): MicroServer {
    this.router.use(url, ...args)
    return this
  }

  /** Add route, alias to `server.router.use('GET ' + url, ...args)` */
  get (url: string, ...args: any): MicroServer {
    this.router.use('GET ' + url, ...args)
    return this
  }

  /** Add route, alias to `server.router.use('POST ' + url, ...args)` */
  post (url: string, ...args: any): MicroServer {
    this.router.use('POST ' + url, ...args)
    return this
  }

  /** Add route, alias to `server.router.use('PUT ' + url, ...args)` */
  put (url: string, ...args: any): MicroServer {
    this.router.use('PUT ' + url, ...args)
    return this
  }

  /** Add route, alias to `server.router.use('PATCH ' + url, ...args)` */
  patch (url: string, ...args: any): MicroServer {
    this.router.use('PATCH ' + url, ...args)
    return this
  }

  /** Add route, alias to `server.router.use('DELETE ' + url, ...args)` */
  delete (url: string, ...args: any): MicroServer {
    this.router.use('DELETE ' + url, ...args)
    return this
  }

  /** Add websocket handler, alias to `server.router.use('WEBSOCKET ' + url, ...args)` */
  websocket (url: string, ...args: any): MicroServer {
    this.router.use('WEBSOCKET ' + url, ...args)
    return this
  }

  /** Add router hook, alias to `server.router.hook(url, ...args)` */
  hook (url: string, ...args: any): MicroServer {
    this.router.hook(url, ...args.filter((o: any) => o))
    return this
  }
}

/** Trust proxy plugin, adds `req.ip` and `req.localip` */
class TrustProxyPlugin extends Plugin {
  priority: number = 110
  name: string = 'trustProxy'

  private trustProxy: string[] = []

  constructor (router: Router, options?: string[]) {
    super(router)
    this.trustProxy = options || []
  }

  isLocal (ip: string) {
    return !!ip.match(/^(127\.|10\.|192\.168\.|172\.16\.|fe80|fc|fd|::)/)
  }

  handler(req: ServerRequest, res: ServerResponse, next: Function): void {
    req.ip = req.socket.remoteAddress || '::1'
    req.localip = this.isLocal(req.ip)
    const xip = req.headers['x-real-ip'] || req.headers['x-forwarded-for']
    if (xip) {
      if (!this.trustProxy.includes(req.ip))
        return res.error(400)

      if (req.headers['x-forwarded-proto'] === 'https') {
        req.protocol = 'https'
        req.secure = true
      }
      req.ip = Array.isArray(xip) ? xip[0] : xip
      req.localip = this.isLocal(req.ip)
    }
    return next()    
  }
}
MicroServer.plugins.trustProxy = TrustProxyPlugin

interface VHostOptions {
  [host: string]: any[] | {[url: string]: any}
}

/** Virtual host plugin */
class VHostPlugin extends Plugin {
  priority: number = 100

  constructor (router: Router, options: VHostOptions) {
    super(router)

    const server: MicroServer = router.server

    if (!server.vhosts) {
      server.vhosts = {}
      this.name = 'vhost'
    } else
      this.handler = undefined
    for (const host in options) {
      if (!server.vhosts[host])
        server.vhosts[host] = new Router(server)
      server.vhosts[host].use(options[host])
    }
  }

  handler? (req: ServerRequest, res: ServerResponse, next: Function) {
    const host = req.headers.host || ''
    const router: Router | undefined = req.router.server.vhosts?.[host]
    if (router) {
      req.router = res.router = router
      router.handler(req, res, () => req.router.server.handlerLast(req, res))
    } else
      next()
  }
}
MicroServer.plugins.vhost = VHostPlugin

/** Static files options */
export interface StaticOptions {
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
}

export interface ServeFileOptions {
  /** path */
  path: string
  /** root */
  root?: string
  /** file name */
  filename?: string
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

/**
 * Static files middleware plugin
 * Usage: server.use('static', '/public')
 * Usage: server.use('static', { root: 'public', path: '/static' })
 */
class StaticPlugin extends Plugin {
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

  constructor (router: Router, options?: StaticOptions | string) {
    super(router)
    if (!options)
      options = {}
    if (typeof options === 'string')
      options = { path: options }

    this.mimeTypes = options.mimeTypes ? { ...StaticPlugin.mimeTypes, ...options.mimeTypes } : Object.freeze(StaticPlugin.mimeTypes)
    this.root = path.resolve((options.root || options?.path || 'public').replace(/^\//, '')) + path.sep
    this.ignore = (options.ignore || []).map((p: string) => path.normalize(path.join(this.root, p)) + path.sep)
    this.index = options.index || 'index.html'
    this.handlers = options.handlers
    this.lastModified = options.lastModified !== false
    this.etag = options.etag !== false
    this.maxAge = options.maxAge

    router.use('GET /' + (options.path?.replace(/^[.\/]*/, '') || '').replace(/\/$/, '') + '/:path*', this.staticHandler.bind(this))
  }

  /** Default static files handler */
  staticHandler (req: ServerRequest, res: ServerResponse, next: Function) {
    if (req.method !== 'GET')
      return next()

    let filename = path.normalize(path.join(this.root, (req.params && req.params.path) || req.pathname))
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

      StaticPlugin.serveFile(req, res, {
        path: filename,
        mimeType,
        stats
      })
    })
  }

  static serveFile (req: ServerRequest, res: ServerResponse, options: ServeFileOptions) {
    const filePath: string = options.root ? path.join(options.root, options.path) : options.path
    const statRes = (err: NodeJS.ErrnoException | null, stats: fs.Stats): void => {
      if (err)
        return res.error(err)
      if (!stats.isFile())
        return res.error(404)

      if (!res.getHeader('Content-Type')) {
        if (options.mimeType)
          res.setHeader('Content-Type', options.mimeType)
        else
          res.setHeader('Content-Type', this.mimeTypes[path.extname(options.path)] || 'application/octet-stream')
      }
      if (options.filename)
        res.setHeader('Content-Disposition', 'attachment; filename="' + options.filename + '"')
      if (options.lastModified !== false)
        res.setHeader('Last-Modified', stats.mtime.toUTCString())
      res.setHeader('Content-Length', stats.size)
      if (options.etag !== false) {
        const etag = '"' + etagPrefix + stats.mtime.getTime().toString(32) + '"'
        if (req.headers['if-none-match'] === etag || req.headers['if-modified-since'] === stats.mtime.toUTCString()) {
          res.statusCode = 304
          res.headersOnly = true
        }
      }
      if (options.maxAge)
        res.setHeader('Cache-Control', 'max-age=' + options.maxAge)
      if (res.headersOnly) {
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
MicroServer.plugins.static = StaticPlugin

/** Proxy plugin options */
export interface ProxyPluginOptions {
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

  constructor (router: Router, options?: ProxyPluginOptions | string) {
    super(router)
    if (typeof options !== 'object')
      options = { remote: options }
    if (!options.remote)
      throw new Error('Invalid param')

    this.remoteUrl = new URL(options.remote)
    this.regex = options.match ? new RegExp(options.match) : undefined

    this.headers = options.headers
    this.validHeaders = {...ProxyPlugin.validHeaders, ...options?.validHeaders}
    if (options.path && options.path !== '/') {
      this.handler = undefined
      router.use(options.path + '/:path*', this.proxyHandler.bind(this))
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
MicroServer.plugins.proxy = ProxyPlugin

/** User info */
export interface UserInfo {
  /** User id */
  id: string,
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
      const token = await this.token((usrInfo?.id || usrInfo?._id), undefined, expire)
      
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
class AuthPlugin extends Plugin {
  options: AuthOptions
  name: string = 'auth'

  constructor (router: Router, options?: AuthOptions) {
    super(router)

    if (router.auth)
      throw new Error('Auth plugin already initialized')

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
        if (usr && (psw === undefined || router.auth?.checkPassword(usrid, psw, usr.password || '')))
          return usr
      }
    }
    router.auth = new Auth(this.options as AuthOptionsInternal)
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

    const cookie = req.headers.cookie, cookies = cookie ? cookie.split(/;\s+/g) : []
    const sid = cookies.find(s => s.startsWith('token='))
    let token = ''
    if (authorization.startsWith('Bearer '))
      token = authorization.slice(7)

    if (sid)
      token = sid.slice(sid.indexOf('=') + 1)

    if (!token)
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
MicroServer.plugins.auth = AuthPlugin

/** Create microserver */
export function create (config: MicroServerConfig) { return new MicroServer(config) }

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

  async close () {
    await this.sync()
    this._iter = 0
    this._cache = {}
  }

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
  /** is required */
  required?: boolean
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
      modelField.required = field.required ? this._fieldFunction(field.required, false) : undefined
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
    if (options.validate === false)
      return data as ModelDocument<TSchema>
    const res = {} as ModelDocument<any>
    for (const name in this.model) {
      const field = this.model[name] as ResolvedFieldSchema
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
        if ((!options?.required && name in data) || (field.required && field.default)) {
          if (typeof field.required === 'function' && field.required(paramOptions) && field.default && (!(name in data) || field.canWrite(options) === false))
            res[name] = options?.default !== false ? field.default.length ? field.default(paramOptions) : (field.default as Function)() : data[name]
          else if (name in data)
            res[name] = options?.validate !== false ? this._validateField(data[name], paramOptions) : data[name]
        }
      }
    }
    if (typeof options?.projection === 'object')
      for (const name in options.projection) {
        if (name !== '_id' && name in this.model && !res[name])
          res[name] = options.projection[name]
      }
    return res
  }

  /** Find one document */
  async findOne (query: Query, options?: ModelContextOptions): Promise<ModelDocument<TSchema>|undefined> {
    if (this.collection instanceof Promise)
      this.collection = await this.collection
    if (!this.collection)
      throw new AccessDenied('Database not configured')
    options = {readOnly: true, ...this.options, ...options}
    const doc = await this.collection.findOne(this.getFilter(query, options))
    return doc ? this.document(doc, options) : undefined
  }

  /** Find many documents */
  async findMany (query: Query, options?: ModelContextOptions): Promise<ModelDocument<TSchema>[]> {
    if (this.collection instanceof Promise)
      this.collection = await this.collection
    if (!this.collection)
      throw new AccessDenied('Database not configured')
    const res: ModelDocument<TSchema>[] = []
    options = {readOnly: true, ...this.options, ...options}
    await this.collection.find(this.getFilter(query || {}, options)).forEach((doc: ModelDocument<TSchema>) => res.push(this.document(doc, options)))
    return res
  }

  /** Insert a new document */
  async insert (data: Record<string, any>, options?: ModelContextOptions): Promise<ModelDocument<TSchema>> {
    return this.update(data, {...options, insert: true})
  }

  /** Update one matching document */
  async update (query: Record<string, any>, options?: ModelContextOptions): Promise<ModelDocument<TSchema>> {
    if (this.collection instanceof Promise)
      this.collection = await this.collection
    if (!this.collection)
      throw new AccessDenied('Database not configured')
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
    const res = await this.collection.findAndModify({query: this.getFilter(query, {required: true, validate: false, default: false}), update: query, upsert: options?.insert}) as ModelDocument<TSchema>
    if (!res)
      throw new NotFound('Document not found')
    return res
  }

  /** Delete one matching document */
  async delete (query: Query, options?: ModelContextOptions): Promise<void> {
    if (this.collection instanceof Promise)
      this.collection = await this.collection
    if (!this.collection)
      throw new AccessDenied('Database not configured')
    if (query._id)
      await this.collection.deleteOne(this.getFilter(query, {...this.options, ...options}))
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

  async updateOne(query: Query, update: Record<string, any>, options?: FindOptions): Promise<{upsertedId: any, modifiedCount: number}> {
    const res = await this.updateMany(
      query,
      update, 
      {...options, limit: 1}
    )
    return res
  }

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
