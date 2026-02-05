## HTTP MicroServer

Lightweight all-in-one http web server without dependencies

Features:
  - fast REST API router
  - form/json body decoder
  - file upload
  - websockets
  - authentication
  - plain/hashed passwords
  - virtual hosts
  - static files
  - rewrite
  - redirect
  - reverse proxy routes
  - trust ip for reverse proxy
  - json file storage with autosave
  - tls with automatic certificate reload
  - data model with validation and mongodb interface
  - typescript model schema translation
  - simple file/memory storage
  - promises as middleware
  - controller class
  - access rights per route
  - access rights per model field

### Usage examples:

Simple router:

```ts
import { MicroServer, AccessDenied, StandardPlugins, StaticPlugin } from '@radatek/microserver'

const server = new MicroServer({
  listen: 8080,
  auth: {
    users: {
      usr: {
        password: 'secret'
      }
    }
  }
})
server.use(StandardPlugins)
server.use('GET /api/hello/:id',
  (req: ServerRequset, res: ServerResponse) =>
    ({message:'Hello ' + req.params.id + '!'}))
server.use('POST /api/login',
  (req: ServerRequset, res: ServerResponse) =>
  {
    const user = await req.auth.login(req.body.user, req.body.password)
    return user ? {user} : new AccessDenied()
  })
server.use('GET /api/protected', 'acl:auth',
  (req: ServerRequset, res: ServerResponse) =>
    ({message:'Secret resource'}))
server.use(StaticPlugin, {root:'public'})
```

Using data schema:

```js
import { MicroServer, Model, MicroCollection } from '@radatek/microserver'

const db = new MicroCollectionStore('./data')
// or using MicroDB collection
//const db = new MicroDB('microdb://data')

const usersCollection = await db.collection('users')

const userProfile = new Model({
  _id: 'string',
  name: { type: 'string', required: true },
  email: { type: 'string', format: 'email' },
  password: { type: 'string', canRead: false },
  role: { type: 'string' },
  acl: { type: 'object' },
}, { collection: usersCollection, name: 'user' })

const server = new MicroServer({
  listen:8080,
  auth: {
    users: (user, password) => userProfile.get(password ? {_id: user, password } : {_id: user})
  }
})

await userProfile.insert({name: 'admin', password: 'secret', role: 'admin', acl: {'user/*': true}})

server.use('POST /login', async (req) => {
  const user = await req.auth.login(req.body.user, req.body.password)
  return user ? { user } : 403
})
// authenticated user allways has auth access
server.use('GET /profile', 'acl:auth', req => ({ user: req.user }))
// get all users if role='admin'
server.use('GET /admin/users', 'role:admin', userProfile)
// get user by id if has acl 'user/get'
server.use('GET /admin/user/:id', 'acl:user/get', userProfile)
// insert new user if role='admin' and has acl 'user/insert'
server.use('POST /admin/user', 'role:admin', 'acl:user/insert', userProfile)
// update user if has acl 'user/update'
server.use('PUT /admin/user/:id', 'acl:user/update', userProfile)
// delete user if has acl 'user/update'
server.use('DELETE /admin/user/:id', 'acl:user/delete', userProfile)
```

Using controller:

```ts
const server = new MicroServer({
  listen: 8080,
  auth: {
    users: {
      usr: {
        password: 'secret',
        acl: {
          user: true,
          'user/insert': true
        }
      }
    }
  }
})
server.use(StandardPlugins)

new MicroCollectionStore('data') // initialize simple file store for models
//new MicroCollectionStore() // initialize simple memory store for models

class RestApi extends Controller {
  static acl = '' // default acl

  gethello(id) { // same as 'GET /hello'
    return {message:'Hello ' + id + '!'}
  }

  async post_login() { // same as 'POST /login'
    const user = await this.auth.login(this.body.user, this.body.password)
    return user ? {user} : 403
  }

  static 'acl:protected' = 'user'
  static 'url:protected' = 'GET /protected'
  protected() {
    return {message:'Protected'}
  }
}

server.use('/api', RestApi)

const AddressModel = new Model({
  street: String,
  city: String
})

const UserModel = Model.define({
  name: { type: String, require: true },
  address: AddressModel
})

class UserController extends Controller<typeof UserModel> {
  static model = UserModel
  static name = 'user'

  static 'acl:get' = 'user/get'
  async get(id: string) { // same as 'GET user'
    return {user: await this.model.findOne({id})}
  }

  static 'acl:insert' = 'user/insert'
  async insert() { // same as 'POST user'
    await this.model.insert(this.req.body)
    return {}
  }
}

server.use('/api/user', UserController)
```
