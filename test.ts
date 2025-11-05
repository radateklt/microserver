import assert from 'assert'
import fs from 'fs/promises'
import { MicroServer, MicroCollection, Model, Controller, Auth, FileStore, ServerRequest, ServerResponse, Plugin } from './microserver.ts'
type Routes = import('./microserver.ts').Routes

const test: {
  (name: string, fn?: Function): void
  skip: (name: string, ...args: any) => void
  mode: (mode: 'stop' | 'continue') => void
  run: () => Promise<void>
} = ((global: any) => {
  let tests: {name: string, fn?: Function}[] = [], _mode: 'stop' | 'skip' | 'continue' = 'continue', _skip: boolean, _run: boolean
  const test = (name: string, fn?: Function) => {
    tests.push({ name, fn })
    !_run && tests.length === 1 && process.nextTick(test.run)
  }
  test.skip = (name: string, ...args: any) => name ? test(name) : _skip = true
  test.mode = (mode: 'stop' | 'skip' | 'continue') => _mode = mode
  test.run = async () => {
    if (_run) return
    _run = true
    const {log, error, warn} = console
    let count = 0, fail = 0, lastError: Error | undefined 
    const run = async (prefix: string) => {
      for (const {name, fn} of tests) {
        const stime = performance.now(), out = (pre: string, msg?: string, post?: string) => log(`${prefix}\x1b[${pre} ${name}${msg?': '+msg:''}\x1b[90m (${post||(performance.now() - stime).toFixed(1)+'ms'})\x1b[0m`)
        try {
          count++
          tests = []
          if (!(_skip = !fn))
            await fn()
          if (_skip) {
            out('90m—', '', 'skipped')
            count--
          } else if (tests.length) {
            out('32m—')
            await run(prefix + '  ')
            if (_mode === 'stop' && lastError)
              return
            lastError = undefined
          } else
            out('32m✔')
        } catch (e: any) {
          fail++
          out('31m✘', e.message)
          e.name !== 'AssertionError' && error(e.stack);
          lastError = e
          if (_mode !== 'continue')
            return
        }
      }
    }
    tests.length && await run('');
    _run = false
    if (count) {
      const ignRes = ['CloseReq', 'PipeWrap', 'TTYWrap', 'FSReqCallback']
      const l = '—'.repeat(16)+'\n', res = process.getActiveResourcesInfo().filter(n => !ignRes.includes(n))
      log(`\x1b[${fail?'33m'+l+'✘':'32m'+l+'✔'} ${count-fail}/${count} ${fail?'FAILED':'SUCCESS'}\x1b[0m`)
      res.length && warn('Active resources:', ...res)
      res.length && setTimeout(() => process.exit(1), 1000)
    }
  }
  return global.test = test
})(global)

const request: {(url: string, options?: any): Promise<any>; url: string;} = (url: string, options?: any): Promise<any> =>
  fetch(request.url + url, options).then(res => {
    const headers: {[header: string]: string} = {}
    res.headers.forEach((v, k) => headers[k] = v)
    if (options?.response)
      return { status: res.status, headers, text: () => res.text(), json: () => res.json() }
    return options?.json || headers['content-type'] === 'application/json' ? res.json() : res.text()
  })
request.url = 'http://localhost:3100'
const GET = (url: string, options?: any): Promise<any> => request(url, {...options, method: 'GET' })
const POST = (url: string, data: any, options?: any) => request(url, {...options, method: 'POST', body: JSON.stringify(data) })
const PUT = (url: string, data: any, options?: any) => request(url, {...options, method: 'PUT', body: JSON.stringify(data) })
const DELETE = (url: string, options?: any) => request(url, {...options, method: 'DELETE' })

console.debug = () => {}

let server: MicroServer

test.mode('stop')
test('Prepare', async () => {
  await fs.mkdir('./tmp/public', { recursive: true })
})

test('Start server', async () => {
  server = new MicroServer({
    cors: '*',
    listen: parseInt(request.url.match(/:(\d+)/)?.[1] || '80')
  })
  await server.waitReady()
  let listen = false
  server.on('listen', () => listen = true)
  await server.waitReady()
  await new Promise((resolve: Function) => server.on('ready', () => resolve()))
  assert(server.servers.size === 1, 'Server not ready')
  assert(listen, 'Event listen not fired')
})
test('Server async use', async () => {
  let step = 0, done!: Function, failed!: Function, p = new Promise((resolve: Function, reject: Function) => [done, failed] = [resolve, reject])
  const timeout = (timeout: number) => new Promise((resolve: Function) => setTimeout(() => resolve(), timeout))
  await server.use((async () => {
    await timeout(10)
    if (step === 0)
      step++
    else
      failed(new Error('Failed step 0!=' + step))
  })())
  class TestPlugin extends Plugin {
    name: string = 'TestPlugin'
    async initialise() {
      await timeout(4)
      if (step === 1)
        step++
      else
        failed(new Error('Failed step 1!=' + step))
    }
    async routes() {
      await timeout(2)
      if (step === 2)
        step++
      else
        failed(new Error('Failed step 2!=' + step))
      return {} as Routes
    }    
  }
  await server.use(TestPlugin)
  await server.use((async () => {
    done()
    failed = () => {}
  })())
  setTimeout(() => failed(new Error('Timeout')), 500)
  await p
  assert.equal(step, 3)
})
test('CORS', async () => {
  test('OPTIONS', async () => {
    const res = await request('/', { method: 'OPTIONS', response: true} )
    assert.equal(res.status, 204, 'Failed status')
    assert.equal(res.headers.allow, 'HEAD,GET,POST,PUT,PATCH,DELETE', 'Failed allow')
  })
  test('GET',  async() => {
    const res = await GET('/', { response: true, headers: { origin: 'http://localhost:3100' }} )
    assert.equal(res.headers['access-control-allow-origin'], '*', 'Failed origin')
    assert.equal(res.headers['access-control-allow-credentials'], 'true', 'Failed credentials')
  })
  test('invalid method',  async() => {
    const res = await request('/', { response: true, method: 'SEARCH' } )
    assert.equal(res.status, 405, 'Failed status')
    assert(res.headers.allow, 'Failed allow')
  })
})
  
test('Static', async () => {
  server.use('static', { root: './tmp/public' })
  await fs.writeFile('./tmp/public/index.html', '<html><body><h1>Hello World</h1></body></html>')
  await fs.writeFile('./tmp/public/index.dat', 'internal')
  await fs.writeFile('./tmp/index.txt', 'internal')
  test('GET', async() => assert.equal(await GET('/'), '<html><body><h1>Hello World</h1></body></html>', 'Invalid HTML content'))
  test('GET unknown', async() => assert.equal(await GET('/index.dat'), 'Not found', 'Insecure file content'))
  test('GET invalid', async() => assert.equal(await GET('/../index.txt'), 'Not found', 'Insecure file content'))
  test('GET 304', async() => {
    const headers = (await GET('/index.html', { response: true })).headers
    const res = await GET('/index.html', { response: true, headers: {'if-none-match': headers.etag, 'if-modified-since': headers['last-modified']} })
    assert.equal(res.status, 304)
  })
  test('HEAD', async() => {
    const res = await request('/index.html', { method: 'HEAD', response: true })
    assert.equal(res.status, 200)
    assert(res.headers['content-length'] > 0)
    assert.equal(await res.text(), '')
  })
  test('range', async() => {
    const res = await request('/index.html', { response: true, headers: { range: 'bytes=1-2' }})
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-length'], '2')
    assert.equal(await res.text(), 'ht')
  })
})

test('Routes: stack', async () => {
  assert.equal((server.router as any)._stack.length, 0, 'Invalid stack')
  server.use((req: ServerRequest, res: ServerResponse, next: Function) => {
    if (req.query.test)
      return {test: req.query.test, body: req.body}
    next()
  })
  test('GET', async() => assert.deepEqual(await GET('/test1?test=test-a'), {success: true, test: 'test-a', body: {}}))
  test('POST', async() => assert.deepEqual(await POST('/test2?test=test-b', {test2: 'test-b'}), {success: true, test: 'test-b', body: {test2: 'test-b'}}))
  test('Not found', async() => assert.equal(await GET('/test2'), 'Not found'))
})

test('Routes: GET', async () => {
  server.router.clear()
  assert.equal((server.router as any)._tree.GET, undefined, 'Invalid routes')
  server.use('GET /test1', (req: ServerRequest, res: ServerResponse) => {
    if (req.query.a)
      return res.jsonSuccess({ a: req.query.a })
    if (req.query.b)
      return { b: req.query.b }
    if (req.query.c)
      return res.json({ c: req.query.c })
    if (req.query.d)
      return Promise.resolve({ d: req.query.d })
    return 'done'
  })
  test('stack', () => assert.equal((server.router as any)._stack.length, 0))
  test('tree', () => assert.equal((server.router as any)._tree.GET?.tree?.test1?.next?.length, 1))
  test('jsonSuccess', async() => assert.deepEqual(await GET('/test1?a=test-a'), {success: true, a: 'test-a'}))
  test('object', async() => assert.deepEqual(await GET('/test1?b=test-b'), { success: true, b: 'test-b' }))
  test('json', async() => assert.deepEqual(await GET('/test1?c=test-c'), { c: 'test-c' }))
  test('promise', async() => assert.deepEqual(await GET('/test1?d=test-d'), { success: true, d: 'test-d' }))
  test('string', async() => assert.equal(await GET('/test1'), 'done'))
})

test('Routes: POST', async () => {
  server.router.clear()
  assert.equal((server.router as any)._tree.POST, undefined, 'Invalid routes')
  server.use('POST /test2/:id', (req: ServerRequest, res: ServerResponse) => {
    return {data: req.body, id: req.params.id}
  })
  server.use('POST /test3/:id2*', (req: ServerRequest, res: ServerResponse) => {
    throw new Error('Access denied')
  })
  test('stack', () => assert.equal((server.router as any)._stack.length, 0))
  test('tree test2', () => assert.equal((server.router as any)._tree.POST?.tree?.test2?.param?.next?.length, 1))
  test('tree test3', () => assert.equal((server.router as any)._tree.POST?.tree?.test3?.last?.next?.length, 1))
  test('json Not found', async() => assert.deepEqual((await POST('/test2', {a: 'test2-a'})), {success:false, error: 'Not found'}))
  test('json', async() => assert.deepEqual((await POST('/test2/prm', {b: 'test2-b'})), {success: true, data: {b: 'test2-b'}, id: 'prm'}))
  test('json exception', async() => assert.deepEqual((await POST('/test3/prm/error', {b: 'test2-b'})), {success: false, error: 'Access denied'}))
  test('GET Not found', async() => assert.equal(await GET('/test2'), 'Not found'))
})

test('Routes: path', async () => {
  const router = server.router as any
  server.router.clear()
  assert.equal(router._tree.GET, undefined, 'Invalid routes')

  test('any param', async () => {
    await server.use('/test2/:id', () => {})
    assert(router._tree['*']?.tree?.test2?.param, 'invalid route /test2/:id')
  })
  test('GET param', async () => {
    await server.use('GET /test3/:id', () => {})
    assert(router._tree.GET?.tree?.test3?.param, 'invalid route /test3/:id')
  })
  test('GET object', async () => {
    await server.use({'GET /test4/p1': () => {}, 'GET /test4/p2': () => {}})
    assert(router._tree.GET?.tree?.test4?.tree?.p1, 'invalid route /test4/p1')
    assert(router._tree.GET?.tree?.test4?.tree?.p2, 'invalid route /test4/p2')
  })
  test('GET url object', async () => {
    await server.use('/test5', {'GET /p1': () => {}, 'GET /p2': () => {}})
    assert(router._tree.GET?.tree?.test5?.tree?.p1, 'invalid route /test5/p1')
    assert(router._tree.GET?.tree?.test5?.tree?.p2, 'invalid route /test5/p2')
  })
  test('GET url array', async () => {
    await server.use('/test6', [ ['GET /p1', () => {}], ['GET /p2', () => {}]])
    assert(router._tree.GET?.tree?.test6?.tree?.p1, 'invalid route /test5/p1')
    assert(router._tree.GET?.tree?.test6?.tree?.p2, 'invalid route /test5/p2')
  })
})

test('Middleware', async () => {
  test('priority 1', async () => {
    server.router.clear()
    const mid1 = (req: ServerRequest, res: ServerResponse, next: Function) => {
      res.send('mid1')
    }
    const mid2 = (req: ServerRequest, res: ServerResponse, next: Function) => {
      res.send('mid2')
    }
    await server.use(mid1)
    await server.use(mid2)
    assert.equal(await GET('/test'), 'mid1') 
  })
  test('priority 2', async () => {
    server.router.clear()
    const mid1 = (req: ServerRequest, res: ServerResponse, next: Function) => {
      res.send('mid1')
    }
    mid1.priority = 1
    const mid2 = (req: ServerRequest, res: ServerResponse, next: Function) => {
      res.send('mid2')
    }
    mid2.priority = 2
    await server.use(mid1)
    await server.use(mid2)
    assert.equal(await GET('/test'), 'mid2') 
  })
  test('plugin', async () => {
    server.router.clear()
    class TestPlugin extends Plugin {
      name: string = 'test'      
    }
    await server.use(TestPlugin)
    assert(server.router.plugins.test)
    let failed = false
    try {
      await server.use(new TestPlugin(server.router))
    } catch {
      failed = true
    }
    assert(failed)
  })
})

test('Controller', async () => {
  server.router.clear()
  class TestController extends Controller {
    async insert(id: string) {
      return {data: {id}}
    }

    async update(company: string, id: string) {
      return {data: {company, id}}
    }

    async get(company: string, id: string) {
      return {data: {company, id}}
    }

    async all(company: string) {
      return {data: {company}}
    }

    async update$admin$user(id: string) {
      return {data: {id}}
    }

    static 'acl:POST /login' = ''
    async 'POST /login'() {
      return {data: this.req.body}
    }

    static 'user:login2' = 'test'
    static 'url:login2' = 'POST /login2'
    async login2() {
      return {data: this.req.body}
    }

    static 'acl:login3' = 'test2'
    static 'url:login3' = 'POST /login3'
    async login3() {
      return {data: this.req.body}
    }
  }
  const routes = TestController.routes()
  test('POST /login', () => assert(routes.find(o => o[0] === 'POST /login')))
  test('POST /login2', () => assert(routes.find(o => o[0] === 'POST /login2' && o[1] === 'user:test')))
  test('POST /login3', () => assert(routes.find(o => o[0] === 'POST /login3' && o[1] === 'acl:test2')))
  test('insert', () => assert(routes.find(o => o[0] === 'POST /:id' && o[1] === 'acl:insert')))
  test('update/admin/user', () => assert(routes.find(o => o[0] === 'PUT /admin/user/:id' && o[1] === 'acl:update')))
  test('update', () => assert(routes.find(o => o[0] === 'PUT /:id/:id1' && o[1] === 'acl:update')))
  test('get', () => assert(routes.find(o => o[0] === 'GET /:id/:id1' && o[1] === 'acl:get')))
  test('all', () => assert(routes.find(o => o[0] === 'GET /:id' && o[1] === 'acl:all')))
  test('router', async () => {
    await server.use('/api', TestController)
    await server.use((req: ServerRequest, res: ServerResponse, next: Function) => {
      req.user = {id: 'test', acl: {get: true, insert: false, update: true, all: false}}
      req.auth = new Auth(req.router?.auth?.options)
      req.auth.req = req
      req.auth.res = res
      next()
    })  
  })

  test('Login', async () => assert.deepEqual(await POST('/api/login', {user: 'test'}), {success: true, data: {user: 'test'}}))
  test('Login2', async () => assert.deepEqual(await POST('/api/login2', {user: 'test2'}), {success: true, data: {user: 'test2'}}))
  test('Login3', async () => assert.deepEqual(await POST('/api/login3', {user: 'test3'}), {success: false, error: 'Permission denied'}))
  test('Prm1', async () => assert.deepEqual(await POST('/api/prm1', {}), {success: false, error: 'Permission denied'}))
  test('Prm2', async () => assert.deepEqual(await PUT('/api/prm1/prm2', {}), {success: true, data: {company: 'prm1', id: 'prm2'}}))
})

test('Model', async () => {
  const subModel = new Model({name: String})
  const model = new Model({
    _id: 'ObjectId',
    name: String,
    field1: {type: String, format: 'email'},
    field2: {type: 'String', required: true},
    field3: {type: 'Number', canRead: false},
    field4: {type: 'String', default: 'test'},
    field5: {type: 'String', canWrite: false, default: '${user.name}'},
    field6: {type: Date, canWrite: false, default: () => new Date('2020-01-01'), required: true},
    field7: {type: 'any', default: (options) => options.field.type},
    field8: {type: 'any', canWrite:'${user.acl.insert}', canRead:'${user.acl.get}'},
    field9: {type: 'any', canWrite:'${user.acl.update}'},
    field10: {type: subModel},
    field11: {type: Array},
    field12: {type: ['string']},
    field13: {type: [subModel]},
    field14: {type: [String], enum: ['123', '456'] }
  }, {name: 'test'})
  test('Model name', () => assert.equal(model.name, 'test'))
  test('_id type', () => assert.equal(model.model._id.type, 'objectid'))
  test('name type', () => assert.equal(model.model.name.type, 'string'))
  test('field1 type', () => assert.equal(model.model.field1.type, 'string'))
  test('field2 type', () => assert.equal(model.model.field2.type, 'string'))
  test('field3 type', () => assert.equal(model.model.field3.type, 'number'))
  test('field4 type', () => assert.equal(model.model.field4.type, 'string'))
  test('field5 type', () => assert.equal(model.model.field5.type, 'string'))
  test('field6 type', () => assert.equal(model.model.field6.type, 'date'))
  test('field7 type', () => assert.equal(model.model.field7.type, 'any'))
  test('field8 type', () => assert.equal(model.model.field8.type, 'any'))
  test('field9 type', () => assert.equal(model.model.field9.type, 'any'))
  test('field10 type', () => assert.equal(model.model.field10.type, 'model'))
  test('field11 type', () => assert.equal(model.model.field11.type, 'any[]'))
  test('field12 type', () => assert.equal(model.model.field12.type, 'string[]'))
  test('field13 type', () => assert.equal(model.model.field13.type, 'model[]'))
  test('field14 type', () => assert.equal(model.model.field14.type, 'string[]'))
  test('doc1', () => assert.deepEqual(model.validate({ name: 'test', field1: 'test@example.com', field2: 'test', field3: 123, field4: 'test', field5: 'test', field6: 'test', field8: 'test', field9: 'test' }, {insert: true, user: {id:'test', name:'test', acl: {insert: true}}}),{name: 'test', field1: 'test@example.com', field2: 'test', field3: 123, field4: 'test', field5: 'test', field6: new Date('2020-01-01'), field7: 'any', field8: 'test'}))
  test('doc2', () => assert.deepEqual(model.validate({ name: 'test', field1: 'test', field2: 'test', field3: 123, field4: 'test', field5: 'test', field6: 'test', field8: 'test', field9: 'test' }, {readOnly: true, user: {id:'test', name:'test', acl: {insert: true}}}),{name: 'test', field1: 'test', field2: 'test', field4: 'test', field5: 'test', field6: 'test', field9: 'test'}))
  test('submodel', () => assert.deepEqual(model.validate({ field2: 'test', field4: null, field10: {name: 'test', value: 'test'} }, {}),{field2: 'test', field4: null, field6: new Date('2020-01-01'), field7: 'any', field10: {name: 'test'}}))
  test('array', () => assert.deepEqual(model.validate({ field2: 'test', field11: [] }, {default: false}),{field2: 'test', field11: []}))
  test('string array', () => assert.deepEqual(model.validate({ field2: 'test', field12: ['123', '456'] }, {default: false}),{field2: 'test', field12: ['123', '456']}))
  test('submodel array', () => assert.deepEqual(model.validate({ field2: 'test', field13: [{name: 'test1'}, {value: 'test2'}] }, {default: false}),{field2: 'test', field13: [{name: 'test1'}, {}]}))
})

test('Model invalid', async () => {
  const model = new Model({
    _id: 'ObjectId',
    field1: {type: 'Number', required: true, validate: (v: number) => v > 0 && v < 10 ? v : Error},
    field2: {type: 'String', format: 'email'},
    field3: {type: Date, canRead: false},
    field4: {type: [String], enum: ['red', 'green']},
    field5: {type: 'int', minimum: 1, maximum: 10},
  }, {name: 'test'})

  async function asserError(fn: () => Promise<any> | any, check: string) {
    try {
      await fn()
    } catch (e: any) {
      return assert(e.message.includes(check), e.message)
    }
    assert.fail('Does not throw error')
  }
  test('Null', () => asserError(() => model.validate({field1: null}), 'Invalid field: missing field1'))
  test('Required', () => asserError(() => model.validate({}), 'Invalid field: missing field1'))
  test('Number 0', () => asserError(() => model.validate({field1: 0}), 'Invalid field value: field1'))
  test('Number text', () => asserError(() => model.validate({field1: 'test'}), 'Invalid field type: field1'))
  test('Email empty', () => asserError(() => model.validate({field1: 1, field2: ''}), 'Invalid field value: field2'))
  test('Email format', () => asserError(() => model.validate({field1: 1, field2: 'a@#b'}), 'Invalid field value: field2'))
  test('Date format', () => asserError(() => model.validate({field1: 1, field3: '14.15-16'}), 'Invalid field type: field3'))
  test('Enum', () => asserError(() => model.validate({field1: 1, field4: ['blue']}), 'Invalid field value: field4'))
  test('Min', () => asserError(() => model.validate({field1: 1, field5: 0}), 'Invalid field value: field5'))
  test('Max', () => asserError(() => model.validate({field1: 1, field5: 11}), 'Invalid field value: field5'))
})

test('Model store', async () => {
  server.router.clear()
  const model = new Model({_id: 'ObjectId', name: String}, {name: 'test', collection: new MicroCollection()})
  server.get('/test', model)
  server.get('/test/:id', model)
  server.post('/test', model)
  server.put('/test/:id', model)
  server.delete('/test/:id', model)
  test('insert', async () => {
    await POST('/test', {name: 'test'})
    const doc = Object.values((model.collection as MicroCollection).data)[0]
    assert(doc, 'Document not created')
    assert.equal(doc.name, 'test')
  })
  test('get', async () => {
    const _id = (await model.findOne({}))?._id
    assert.deepEqual(await GET('/test'), {success: true, data: [{_id, name: 'test'}]})
    assert.deepEqual(await GET('/test/' + _id), {success: true, data: {_id, name: 'test'}})
  })
  test('update', async () => {
    const _id = (await model.findOne({}))?._id
    assert(_id, 'Does not exist')
    await PUT('/test/' + _id, {name: 'test2'})
    assert.deepEqual(await GET('/test/' + _id), {success: true, data: {_id, name: 'test2'}})
  })
  test('delete', async () => {
    const _id = (await model.findOne({}))?._id
    assert(_id, 'Does not exist')
    await DELETE('/test/' + _id)
    assert.deepEqual(await GET('/test'), {success: true, data: []})
  })
})

test('FileStore', async () => {
  const store = new FileStore({dir: './tmp', debounceTimeout: 200})
  await fs.writeFile('./tmp/test', JSON.stringify({name: 'test'}))
  const data = await store.load('test', true)
  test('data', () => assert.deepEqual(data, {name: 'test'}))
  test('change', async () => {
    data.name = 'test2'
    assert.equal(await fs.readFile('./tmp/test', 'utf8'), JSON.stringify({name: 'test'}))
  })
  test('close', async () => {
    data.name = 'test3'
    data.name = 'test4'
    await store.close()
    assert.equal(await fs.readFile('./tmp/test', 'utf8'), JSON.stringify({name: 'test4'}))
  })
})

test('Stop server', async () => {
  await server.close()
  assert(server.servers.size === 0, 'Server not closed')

  await new Promise(resolve => setTimeout(resolve, 10)) // closing listening port needs some time
})

test('Auth', async () => {
  const auth = new Auth({ token: 'test', users: {test: {id: 'test', password: 'secret'}}})
  let enc1: string, enc2: string
  test('encode1', () => {
    enc1 = auth.encode('test', 10)
    assert.equal(enc1.length, 63)
  })
  test('decode1', () => {
    const dec = auth.decode(enc1)
    assert.equal(dec.data, 'test')
  })
  test('encode2', () => {
    enc2 = auth.encode('test', 0.01)
    assert.notEqual(enc1, enc2)
  })
  test('decode2', async () => {
    await new Promise(resolve => setTimeout(resolve, 100))
    const dec = auth.decode(enc2)
    assert.equal(dec.data, '')
  })
  const usr = 'test', psw = 'secret'
  const hpsw = auth.password(usr, psw)
  const spsw = auth.password(usr, psw, 'SECRET')
  const rpsw = auth.password('', auth.password(usr, psw, 'SECRET'), '*')
  test('password h.len', () => assert.equal(hpsw.length, 128))
  test('password s.len', () => assert.equal(spsw.length, 134))
  test('password r.len', () => assert.equal(rpsw.length, 192))
  test('password p=p', () => assert(auth.checkPassword(usr, psw, psw)))
  test('password h=p', () => assert(auth.checkPassword(usr, hpsw, psw)))
  test('password r=p', () => assert(auth.checkPassword(usr, rpsw, psw, 'SECRET')))
  test('password p=h', () => assert(auth.checkPassword(usr, psw, hpsw)))
  test('password h=h', () => assert(auth.checkPassword(usr, hpsw, hpsw)))
  test('password r=h', () => assert(auth.checkPassword(usr, rpsw, hpsw, 'SECRET')))
  test('password p=s', () => assert(auth.checkPassword(usr, psw, spsw)))
  test('password h=s', () => assert(auth.checkPassword(usr, hpsw, spsw)))
  test('password r=s', () => assert(auth.checkPassword(usr, rpsw, spsw)))

  test('expire 10', () => {
    const token = auth.encode('test', 10)
    const dec = auth.decode(token)
    assert.equal(dec.data, 'test')
    assert(dec.expire >= 9)
  })
  test('expire 0', async () => {
    const token = auth.encode('test', 0.001)
    await new Promise(resolve => setTimeout(resolve, 1))
    const dec = auth.decode(token)
    assert.equal(dec.data, '')
    assert(dec.expire < 0)
  })
})

test('Server Auth', async () => {
  const usersCollection = new MicroCollection({ store: new FileStore({ dir: 'tmp' }), name: 'users' })

  const userProfile: Model = new Model({
    _id: 'string',
    name: { type: 'string', required: true },
    email: { type: 'string', format: 'email' },
    password: { type: 'string', canRead: false },
    group: { type: 'string' },
    acl: { type: 'object' },
  }, { collection: usersCollection, name: 'user' })

  const server = new MicroServer({
    listen: 3100,
    auth: {
      token: 'test',
      cache: {},
      users: (user, password) => password ? userProfile.findOne({_id: user, password }) : userProfile.findOne({_id: user}) as Promise<any>
    }
  })

  await userProfile.insert({_id: 'admin', name: 'admin', password: 'secret', group: 'admins', acl: {'user/*': true}})
  await userProfile.insert({_id: 'test', name: 'Test', password: 'secret'})

  server.use('POST /login', async (req: ServerRequest) => {
    const user = await req.auth?.login(req.body?.user, req.body?.password)
    return user ? { user } : new Error('Access denied')
  })
  server.use('GET /profile', 'acl:auth', (req: ServerRequest) => ({ user: req.user }))
  server.use('GET /admin/users', 'group:admins', userProfile)
  server.use('GET /admin/user/:id', 'acl:user/get', userProfile)
  server.use('POST /admin/user', 'group:admins', 'acl:user/insert', userProfile)
  server.use('PUT /admin/user/:id', 'acl:user/update', userProfile)
  server.use('DELETE /admin/user/:id', 'acl:user/delete', userProfile)
  await new Promise((resolve: Function) => server.on('ready', () => resolve()))

  let optionsAdmin: any, optionsTest: any

  test('Login admin', async () => {
    const res = await POST('/login', { user: 'admin', password: 'secret' }, { response: true })
    assert.equal(res.status, 200)
    assert.match(res.headers['set-cookie'] || '', /token=[\w.-]+/)
    optionsAdmin = {headers: { cookie: res.headers['set-cookie'].match(/token=[^;]+/)[0] }}
  })
  test('Login test', async () => {
    const res = await POST('/login', { user: 'test', password: 'secret' }, { response: true })
    assert.equal(res.status, 200)
    assert.match(res.headers['set-cookie'] || '', /token=[\w.-]+/)
    optionsTest = {headers: { cookie: res.headers['set-cookie'].match(/token=[^;]+/)[0] }}
  })
  test('Login Invalid', async () => {
    const res = await POST('/login', { user: 'admin2', password: 'secret2' }, { response: true })
    assert.equal(res.status, 403)
    assert.doesNotMatch(res.headers['set-cookie'] || '', /token=[\w.-]+/)
  })

  test('Profile admin', async () => assert.equal((await GET('/profile', optionsAdmin))?.user?._id, 'admin'))
  test('Profile test', async () => assert.equal((await GET('/profile', optionsTest))?.user?._id, 'test'))
  test('Profile no auth', async () => assert.equal((await GET('/profile', { response: true}))?.status, 422))
  test('Update admin', async () => {
    assert.deepEqual((await PUT('/admin/user/admin', {name: 'Test'}, optionsAdmin)), {success: true})
    assert.equal((await userProfile.findOne({_id: 'admin'}))?.name, 'Test')
    assert.equal((await userProfile.findOne({name: 'Test'}))?._id, 'admin')
  })
  test('Update Not Found', async () => {
    assert.deepEqual((await PUT('/admin/user/admin2', {name: 'Test2'}, optionsAdmin)), {success: false, error: 'Document not found'})
    assert.equal((await userProfile.findOne({name: 'Test2'}))?.name, undefined)
  })
  test('Update test', async () => {
    assert.deepEqual((await PUT('/admin/user/admin', {name: 'Test3'}, optionsTest)), {success: false, error: 'Permission denied'})
    assert.equal((await userProfile.findOne({_id: 'admin'}))?.name, 'Test')
  })
  test('Insert admin2', async () => {
    assert.deepEqual((await POST('/admin/user', {_id: 'admin2', name: 'Admin2'}, optionsAdmin)), {success: true})
    assert.equal((await userProfile.findOne({_id: 'admin2'}))?.name, 'Admin2')
  })
  test('Insert test2', async () => {
    assert.deepEqual((await POST('/admin/user', {_id: 'test2', name: 'Test2'}, optionsTest)), {success: false, error: 'Permission denied'})
    assert.equal((await userProfile.findOne({_id: 'test2'}))?.name, undefined)
  })
  test('Cache reset', async () => {
    const cache = (server.router.auth as any).options.cache
    for (const key in cache)
      delete cache[key]
    assert.equal((await GET('/profile', optionsAdmin))?.user?._id, 'admin')
  })
  test('Expire', async () => {
    const token = await server.router.auth?.token('test', 'secret', 0.001)
    assert(token)
    await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal((await GET('/profile', { response: true, headers: {cookie: 'token=' + token}}))?.status, 403)
  })
  test('Revalidate', async () => {
    const token = await server.router.auth?.token('test', 'secret', 5)
    optionsTest.headers.cookie = 'token=' + token
    assert.equal((await GET('/profile', optionsTest))?.user?._id, 'test')
  })
  test('Cleanup', () => server.close())
})

test('Cleanup', async () => {
  await fs.rm('./tmp', { recursive: true })
})
