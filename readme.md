## HTTP MicroServer

Lightweight all-in-one http web server

Features:
  - fast REST API router
  - form/json body decoder
  - file upload
  - authentication
  - plain/hashed passwords
  - virtual hosts
  - static files
  - reverse proxy routes
  - trust ip for reverse proxy
  - json file storage with autosave
  - websockets (single file module from ws package)
  - tls with automatic certificate reload
  - data model with validation and mongodb interface
  - simple file/memory storage adapter for model
  - promises as middleware
  - controller class
  - access rights per route
  - access rights per model field
  - rewrite
  - redirect
  - express like interface

### Usage examples:

Simple router:

```ts
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
server.use('GET /api/hello/:id',
  (req: ServerRequset, res: ServerResponse) =>
    ({message:'Hello ' + req.params.id + '!'}))
server.use('POST /api/login',
  (req: ServerRequset, res: ServerResponse) =>
  {
    const user = await req.auth.login(req.body.user, req.body.password)
    return user ? {user} : 403
  })
server.use('GET /api/protected', 'acl:auth',
  (req: ServerRequset, res: ServerResponse) =>
    ({message:'Secret resource'}))
server.use('static', {root:'public'})
```

Using `Controller` class:

```ts
class RestApi extends Controller {
  static acl = '' // default acl

  gethello(id) {
    return {message:'Hello ' + id + '!'}
  }

  async postlogin() {
    const user = await this.auth.login(this.body.user, this.body.password)
    return user ? {user} : 403
  }

  static 'acl:protected' = 'user'
  static 'url:protected' = 'GET /protected'
  protected() {
    return {message:'Protected'}
  }
}

const server = new MicroServer({
  listen: 8080,
  auth: {
    users: {
      usr: {
        password: 'secret',
        acl: {user: true}
      }
    }
  }
})
server.use('/api', RestApi)
```

`Model.handler` automatically detects usage for standard functions: get,insert,update,delete

```js
import { MicroServer, Model, MicroCollection, FileStore } from '@dariuski/microserver'

const usersCollection = new MicroCollection({ store: new FileStore({ dir: 'data' }), name: 'users' })
//const usersCollection = await db.collection('users')

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

userProfile.insert({name: 'admin', password: 'secret', role: 'admin', acl: {'user/*': true}})

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
