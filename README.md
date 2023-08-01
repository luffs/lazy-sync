# Lazy Sync
A Vue library for querying data from a Node.js backend running Sequelize ORM, and keeping the data in sync.

It enables you to write realtime applications with code like this in a decently efficient manner:
```vue
<template>
  <div>
    <div v-for="post in posts.list" :key="post.id">
      <h2>{{ post.name }}</h2>
      <i>{{ post.author }}</i>
      <p>{{ post.text }}</p>
      <hr>
    </div>
  </div>
</template>

<script>
export default {
  name: 'Blog',
  props: {
    author: {}
  },
  data () {
    const where = { AuthorId: this.author.id }
    const options = { limit: 10, order: ['createdAt', 'DESC'] }
    return {
      // Fetches the latest 10 posts by the author from the backend,
      // and keeps the list of them in sync when posts are modified, added or removed.
      posts: Z.Posts.find(where, options)
    }
  }
}
</script>
```

What's happening below the surface is:

1. Fetch a list of post IDs by making a query to the backend (or cache if in sync). Cache the list of IDs.
2. Fetch the content of any missing posts and cache them.
3. When a post gets added or removed, the library gets notified via websocket, and marks the lists as out of sync.
4. The next time the list gets rendered, goto 1.
5. If a post gets modified, the post gets updated directly. Only lists that queries fields that have been modified will be invalidated.

Implementation of communication, access control and limiting queries made by untrusted users is left as an exercise. (for now...)

# Installation
```
npm i lazy-sync
```

# Frontend example
```js
import { Z } from 'lazy-sync/LazySync'

// these are server functions called by lazySync
const clientApi = {
  access: {
    async create ({ model, objValues }) {},
    async addMember ({ model, entryId, memberModel, memberEntryId }) {},
    async removeMember ({ model, entryId, memberModel, memberEntryId }) {},
    async bulkCount ({ model, searches = [] }) {},
    async bulkFind ({ model, searches = [], limit = undefined, offset = 0, order = [] }) {},
    async get ({ model, entryIds = [] }) {},
    async order ({ model, entryIds = [], order = [] }) {},
    async update ({ model, entryId, objValues }) {},
    async delete ({ model, entryId }) {},
    async restore ({ model, entryId }) {}
  }
}

// replace them with a socket.io event call to 'api'
Object.keys(clientApi.access).forEach(method => {
  clientApi.access[method] = args => {
    const api = 'access'
    return new Promise((resolve, reject) => {
      socket.emit('api', { api, method, args }, function callback (error, result) {
        error ? reject(new Error(error)) : resolve(result)
      })
    })
  }
})

Z.init(['Posts', 'Users', 'News'], clientApi.access)

export const socket = io(import.meta.env.VITE_BACKEND_URL)
socket
  .on('connect', () => {
    console.log('connected to websocket')
    Object.keys(Z).forEach(model => {
      if (typeof Z[model].ready === 'boolean') {
        // set ready to true when ready
        Z[model].ready = true
        Z[model].invalidate()
      }
    })
  })
  .on('z', data => {
    Z.onChange(data)
  })
```

# Backend example
```
TODO
```


