import { reactive } from 'vue'

const inSyncCallbacks = new Map()
function notifySyncCallbacks(target) {
  if (inSyncCallbacks.has(target)) {
    const callbacks = inSyncCallbacks.get(target)
    inSyncCallbacks.delete(target)
    callbacks.forEach(cb => cb(target))
  }
}

let crudModels
export const Z = {
  init(models, methods) {
    crudModels = models
    this.methods = methods || this.methods
    models.forEach((model) => {
      this[model] = new LazySync({ model })
    })
  },
  onChange({ c: created = [], r: related = [], u: updated = [], d: deleted = [], z: zombies = [] }) {
    [...created, ...related, ...deleted, ...zombies]
      .forEach(([model]) => {
        this[model].invalidate()
      })

    updated.forEach(([model, entryIds, change]) => {
      entryIds.forEach((id) => {
        const entry = this[model].entries[id]
        if (entry) {
          Object.assign(entry, change)
        }
      })
      this[model].invalidateWithChange(change)
    })
  },
  methods: {
    async create({ model, objValues }) {},
    async addMember({ model, entryId, memberModel, memberEntryId }) {},
    async removeMember({ model, entryId, memberModel, memberEntryId }) {},
    async setMembers({ model, entryId, memberModel, memberEntryIds }) {},
    async bulkCount({ model, searches = [] }) {},
    async bulkFind({ model, searches = [], limit = undefined, offset = 0, order = [] }) {},
    async get({ model, entryIds = [] }) {},
    async order({ model, entryIds = [], order = [] }) {},
    async update({ model, entryId, objValues }) {},
    async delete({ model, entryId }) {},
    async restore({ model, entryId }) {},
  },
}

class LazySync {
  constructor({ model }) {
    this.model = model
    this.ready = false
    this.changeIndex = 1
    this.maxQueriesPerRequest = 50
    this.cache = { counts: {}, entries: {}, lists: {} }
    this.pending = { counts: new Map(), entries: [], lists: [] }
    this.fetching = { counts: new Map() }
    this.entries = {}
    this.lazyResults = {}
    this.timeouts = { entries: 0, lists: 0, counts: 0 }
  }

  id(id) {
    const { changeIndex, entries, pending } = this
    id = Number.parseInt(id, 10)
    if (!entries[id]) {
      entries[id] = reactive(new LazyEntry(id, changeIndex))
      pending.entries.push(id)
      this.fetchEntriesLater()
    }
    return entries[id]
  }

  find(search = {}, options = {}) {
    search = JSON.parse(JSON.stringify(search))
    const { model, lazyResults } = this
    const query = { search }
    const { limit, offset, order } = options
    options = { limit, offset, order }
    for (const key in options) {
      if (options[key]) {
        query[key] = options[key]
      }
    }
    const hash = LazySync.hash(JSON.stringify(query))

    if (!lazyResults[hash]) {
      lazyResults[hash] = reactive(new LazyResult(model, query))
    }
    return lazyResults[hash]
  }

  refresh(lazyResult) {
    const { model, cache, pending } = this
    const { query } = lazyResult
    const hash = LazySync.hash(JSON.stringify(query))

    pending.lists.push(hash)
    this.fetchListsLater()

    // populate from cache while we wait for the fetch
    if (lazyResult._list.length === 0) {
      const cachedList = cache.lists[hash]
      const entries = cachedList ? cachedList.map(id => Z[model].id(id)) : []
      lazyResult._list.splice(0)
      lazyResult._list.push(...entries)
    }

    return lazyResult
  }

  refreshCount(lazyResult) {
    const { cache, pending } = this
    const { query } = lazyResult
    const hash = LazySync.hash(JSON.stringify(query))

    if (typeof cache.counts[hash] !== 'number') {
      cache.counts[hash] = 0
    }
    lazyResult._count = cache.counts[hash]

    if (pending.counts.has(hash)) {
      pending.counts.get(hash).add(lazyResult)
    }
    else {
      pending.counts.set(hash, new Set([lazyResult]))
      this.fetchCountsLater()
    }
    return lazyResult
  }

  create(objValues) {
    return Z.methods.create({ model: this.model, objValues })
  }

  update(entryId, objValues) {
    return Z.methods.update({ model: this.model, entryId, objValues })
  }

  delete(entryId) {
    return Z.methods.delete({ model: this.model, entryId })
  }

  addMember(entryId, memberModel, memberEntryId) {
    return Z.methods.addMember({ model: this.model, entryId, memberModel, memberEntryId })
  }

  removeMember(entryId, memberModel, memberEntryId) {
    return Z.methods.removeMember({ model: this.model, entryId, memberModel, memberEntryId })
  }

  setMembers(entryId, memberModel, memberEntryIds) {
    return Z.methods.setMembers({ model: this.model, entryId, memberModel, memberEntryIds })
  }

  fetchEntriesLater() {
    clearTimeout(this.timeouts.entries)
    const handler = this.ready ? this.fetchPendingEntries : this.fetchEntriesLater
    const delay = this.ready ? 1 : 50
    this.timeouts.entries = setTimeout(handler.bind(this), delay)
  }

  fetchListsLater() {
    clearTimeout(this.timeouts.lists)
    const handler = this.ready ? this.fetchPendingLists : this.fetchListsLater
    const delay = this.ready ? 1 : 50
    this.timeouts.lists = setTimeout(handler.bind(this), delay)
  }

  fetchCountsLater() {
    clearTimeout(this.timeouts.counts)
    const handler = this.ready ? this.fetchPendingCounts : this.fetchCountsLater
    const delay = this.ready ? 1 : 50
    this.timeouts.counts = setTimeout(handler.bind(this), delay)
  }

  fetchPendingCounts() {
    const { model, pending, fetching, cache, maxQueriesPerRequest } = this
    const pendingCounts = Array.from(pending.counts.keys())
      .filter(hash => !fetching.counts.has(hash))

    const similarQueries = {}

    pendingCounts.forEach((hash, index) => {
      const [lazyResult] = pending.counts.get(hash)
      fetching.counts.set(hash, true)

      const { search } = lazyResult.query
      const similarHash = LazySync.hash(
        JSON.stringify({
          fields: Object.keys(search).filter(key => search[key] !== undefined),
          requestIndex: Math.floor(index / (maxQueriesPerRequest * 2)),
        }),
      )

      similarQueries[similarHash] = similarQueries[similarHash] || []
      similarQueries[similarHash].push(hash)
    })

    if (Object.keys(similarQueries).length === 0) {
      console.warn('nothing to count', model)
      return
    }

    Object.keys(similarQueries).forEach((similarHash) => {
      const hashes = similarQueries[similarHash]
      const searches = hashes.map((hash) => {
        const [lazyResult] = pending.counts.get(hash)
        return lazyResult.query.search
      })

      Z.methods.bulkCount({ model, searches })
        .then((results) => {
          results.forEach((count, index) => {
            const hash = hashes[index]
            cache.counts[hash] = count || 0
            fetching.counts.delete(hash)
            if (pending.counts.has(hash)) {
              const lazyLists = pending.counts.get(hash)
              pending.counts.delete(hash)
              lazyLists.forEach((lazyResult) => {
                lazyResult._count = count
              })
            }
          })
        })
        .catch((error) => {
          console.error('count error', { model, searches, error })
        })
    })
  }

  fetchPendingEntries() {
    const { model, pending, entries, changeIndex } = this
    if (pending.entries.length > 0) {
      const entryIds = pending.entries
      pending.entries = []
      Z.methods.get({ model, entryIds })
        .then((rows) => {
          rows.forEach((row) => {
            const entry = entries[row.id]
            if (entry) {
              Object.assign(entry, row, {
                inSync: true,
                key: [changeIndex, row.id].join(),
              })
              notifySyncCallbacks(entry)
            }
          })
        })
    }
  }

  fetchPendingLists() {
    const { model, lazyResults, changeIndex, cache, pending, maxQueriesPerRequest } = this

    const similarQueries = {}
    const pendingListHashes = pending.lists.splice(0)

    pendingListHashes.forEach((hash, index) => {
      const { query } = lazyResults[hash]
      const { search, order, limit, offset } = query
      const similarHash = LazySync.hash(
        JSON.stringify({
          order,
          limit,
          offset,
          fields: Object.keys(search),
          requestIndex: Math.floor(index / maxQueriesPerRequest),
        }),
      )
      similarQueries[similarHash] = similarQueries[similarHash] || []
      similarQueries[similarHash].push(hash)
    })

    Object.keys(similarQueries).forEach((similarHash) => {
      const hashes = similarQueries[similarHash]
      const queries = hashes.map(hash => lazyResults[hash].query)
      const { order, limit, offset } = queries[0]
      const searches = queries.map(query => query.search)

      Z.methods.bulkFind({ model, searches, limit, offset, order })
        .then((arrayOfLists) => {
          arrayOfLists.forEach((list, index) => {
            const hash = hashes[index]
            const lazyResult = lazyResults[hash]

            // guards against a race where invalidate() is called between request and response
            if (lazyResult.changeIndex < changeIndex) {
              lazyResult.changeIndex = changeIndex
              cache.lists[hash] = list

              const entries = list.map(id => Z[model].id(id))
              lazyResult._list.splice(0)
              lazyResult._list.push(...entries)
              lazyResult.inSync = true
              notifySyncCallbacks(lazyResult)
            }
            else {
              console.warn('Lucky we looked for this race condition, isn\'t it?')
            }
          })
        })
    })
  }

  invalidate() {
    this.changeIndex++
    this.pending.counts = new Map()
    for (const lazyResult of Object.values(this.lazyResults)) {
      lazyResult.invalidate()
    }
  }

  invalidateWithChange(change) {
    const updatedFields = Object.keys(change)
    this.changeIndex++
    updatedFields.forEach((field) => {
      for (const lazyResult of Object.values(this.lazyResults)) {
        const mightBeModified = JSON.stringify(lazyResult.query).includes(field)
        if (mightBeModified) {
          lazyResult.invalidate()
        }
      }
    })
  }

  static queryHash(search, options) {
    search = JSON.parse(JSON.stringify(search))
    const query = { search }
    const { limit, offset, order } = options
    options = { limit, offset, order }
    for (const key in options) {
      if (options[key]) {
        query[key] = options[key]
      }
    }
    return this.hash(JSON.stringify(query))
  }

  static hash(str) {
    let hash = 0
    if (str.length === 0)
      return hash
    for (let i = 0; i < str.length; i++) {
      const chr = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + chr
      hash |= 0 // 32-bit integer
    }
    return hash
  }
}

class LazyEntry {
  constructor(id, changeIndex) {
    this.id = id
    this.key = [id, changeIndex].join()
    this.inSync = false
  }

  then(inSyncCallback) {
    if (this.inSync) {
      inSyncCallback(this)
    }
    else if (inSyncCallbacks.has(this)) {
      inSyncCallbacks.get(this).push(inSyncCallback)
    }
    else {
      inSyncCallbacks.set(this, [inSyncCallback])
    }
  }
}

class LazyResult {
  constructor(model, query) {
    this.model = model
    this.query = query
    this.changeIndex = 0
    this.inSync = false
    this._list = []
    this._count = 0
    this._listLoaded = false
    this._countLoaded = false
  }

  // Lazy getters: first read of `list` or `count` schedules a fetch.
  // Vue 3's reactive proxy tracks the underlying _list / _count, so
  // subsequent updates re-trigger any effects that read these.
  get list() {
    if (!this._listLoaded) {
      this._listLoaded = true
      Z[this.model].refresh(this)
    }
    return this._list
  }

  get count() {
    if (!this._countLoaded) {
      this._countLoaded = true
      Z[this.model].refreshCount(this)
    }
    return this._count
  }

  invalidate() {
    this.inSync = false
    this._listLoaded = false
    this._countLoaded = false
  }

  then(inSyncCallback) {
    if (this.inSync) {
      inSyncCallback(this)
    }
    else if (inSyncCallbacks.has(this)) {
      inSyncCallbacks.get(this).push(inSyncCallback)
    }
    else {
      inSyncCallbacks.set(this, [inSyncCallback])
      if (!this._listLoaded) {
        this._listLoaded = true
        Z[this.model].refresh(this)
      }
    }
  }
}

// Optional Options-API mixin. In Vue 3 the reactivity is already on the
// LazyEntry / LazyResult instances themselves, so components can also just
// use `Z.users.id(1)` / `Z.users.find({...})` directly.
export const zMixin = {
  data() {
    const z = {}
    crudModels.forEach((model) => {
      z[model] = {
        refs: {},
        lists: {},
        id: (id) => {
          if (!this.z[model].refs[id]) {
            this.z[model].refs[id] = Z[model].id(id)
          }
          return this.z[model].refs[id]
        },
        find: (search, options = {}) => {
          const hash = LazySync.queryHash(search, options)
          if (!this.z[model].lists[hash]) {
            this.z[model].lists[hash] = Z[model].find(search, options)
          }
          return this.z[model].lists[hash]
        },
      }
    })
    return { z }
  },
}
