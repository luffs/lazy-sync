import Vue from 'vue'

const inSyncCallbacks = new Map()
function notifySyncCallbacks (list) {
  if (inSyncCallbacks.has(list)) {
    const callbacks = inSyncCallbacks.get(list)
    inSyncCallbacks.delete(list)
    callbacks.forEach(cb => cb(list))
  }
}

export const Z = {
  init (models, methods) {
    this.methods = methods || this.methods
    models.forEach(model => {
      this[model] = new LazySync({ model })
    })
  },
  onChange ({ c: created = [], r: related = [], u: updated = [], d: deleted = [], z: zombies = [] }) {
    console.log('changes', { created, related, updated, deleted, zombies });

    [...created, ...related, ...deleted, ...zombies]
      .forEach(([model]) => {
        this[model].invalidate()
      })

    updated.forEach(([model, entryIds, change]) => {
      entryIds.forEach(id => {
        const entry = this[model].entries[id]
        if (entry) {
          Object.assign(this[model].entries[id], change)
        }
      })
      this[model].invalidateWithChange(change)
    })
  },
  methods: {
    async create ({ model, objValues }) {},
    async addMember ({ model, entryId, memberModel, memberEntryId }) {},
    async removeMember ({ model, entryId, memberModel, memberEntryId }) {},
    async count ({ model, search = {} }) {},
    async bulkCount ({ model, searches = [] }) {},
    async bulkFind ({ model, searches = [], limit = undefined, offset = 0, order = [] }) {},
    async find ({ model, search = {}, limit = undefined, offset = 0, order = [] }) {},
    async get ({ model, entryIds = [] }) {},
    async order ({ model, entryIds = [], order = [] }) {},
    async update ({ model, entryId, objValues }) {},
    async delete ({ model, entryId }) {},
    async restore ({ model, entryId }) {}
  }
}

class LazySync {
  constructor ({ model }) {
    Object.assign(this, {
      model,
      ready: false,
      changeIndex: 1,
      maxQueriesPerRequest: 50,
      cache: {
        counts: {},
        entries: {},
        lists: {}
      },
      pending: {
        counts: new Map(),
        entries: [],
        lists: []
      },
      fetching: {
        counts: new Map()
      },
      counts: {},
      entries: {},
      lazyResults: {},
      timeouts: {
        entries: 0,
        lists: 0,
        counts: 0
      }
    })
  }

  id (id) {
    const { changeIndex, entries, pending } = this
    id = parseInt(id, 10)
    if (!entries[id]) {
      entries[id] = new LazyEntry(id, changeIndex)
      pending.entries.push(id)
      this.fetchEntriesLater()
    }
    return entries[id]
  }

  clearCount (search = {}) {
    const { model, counts, pending } = this
    const query = { model, search }
    const hash = LazySync.hash(JSON.stringify(query))
    delete counts[hash]
    delete pending.counts[hash]
  }

  count (search = {}, lazyList) {
    const { model, cache, counts, pending } = this
    const query = { model, search }
    const hash = LazySync.hash(JSON.stringify(query))

    // console.log('get count', model)
    if (typeof counts[hash] === 'number') {
      return counts[hash]
    } else if (lazyList) {
      if (pending.counts.has(hash)) {
        pending.counts.get(hash).add(lazyList)
      } else {
        const countHolders = new Set([lazyList])
        pending.counts.set(hash, countHolders)

        this.fetchCountsLater()
      }
    }
    return cache.counts[hash] || 0
  }

  find (search = {}, options = {}) {
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
      lazyResults[hash] = new LazyResult(model, query)
    }
    return lazyResults[hash]
  }

  refresh (lazyResult) {
    const { model, cache, pending } = this
    const { query } = lazyResult
    const hash = LazySync.hash(JSON.stringify(query))

    // add lazyResult to pending lists fetchLater
    pending.lists.push(hash)
    this.fetchListsLater()

    // set list to cached entries
    if (lazyResult.list.length === 0) {
      const cachedList = cache.lists[hash]
      const entries = cachedList ? cachedList.map(id => Z[model].id(id)) : []
      lazyResult.list.splice(0)
      lazyResult.list.push(...entries)
    }

    return lazyResult
  }

  create (objValues) {
    const { model } = this
    return Z.methods.create({ model, objValues })
  }

  update (entryId, objValues) {
    const { model } = this
    return Z.methods.update({ model, entryId, objValues })
  }

  delete (entryId) {
    const { model } = this
    return Z.methods.delete({ model, entryId })
  }

  addMember (entryId, memberModel, memberEntryId) {
    const { model } = this
    return Z.methods.addMember({
      model,
      entryId,
      memberModel,
      memberEntryId
    })
  }

  removeMember (entryId, memberModel, memberEntryId) {
    const { model } = this
    return Z.methods.removeMember({
      model,
      entryId,
      memberModel,
      memberEntryId
    })
  }

  setMembers (entryId, memberModel, memberEntryIds) {
    const { model } = this
    return Z.methods.setMembers({
      model,
      entryId,
      memberModel,
      memberEntryIds
    })
  }

  fetchEntriesLater () {
    const { ready, timeouts, fetchPendingEntries, fetchEntriesLater } = this
    clearTimeout(timeouts.entries)
    const handler = ready ? fetchPendingEntries : fetchEntriesLater
    const delay = ready ? 1 : 50
    timeouts.entries = setTimeout(handler.bind(this), delay)
  }

  fetchListsLater () {
    const { ready, timeouts, fetchPendingLists, fetchListsLater } = this
    clearTimeout(timeouts.lists)
    const handler = ready ? fetchPendingLists : fetchListsLater
    const delay = ready ? 1 : 50
    timeouts.lists = setTimeout(handler.bind(this), delay)
  }

  fetchCountsLater () {
    const { ready, timeouts, fetchPendingCounts, fetchCountsLater } = this
    clearTimeout(timeouts.counts)
    const handler = ready ? fetchPendingCounts : fetchCountsLater
    const delay = ready ? 1 : 50
    timeouts.counts = setTimeout(handler.bind(this), delay)
  }

  fetchPendingCounts () {
    const { model, pending, fetching, cache } = this
    const hashes =
      Array.from(pending.counts.keys())
        .filter(hash => !fetching.counts.has(hash))

    const searches = []
    hashes
      .forEach(hash => {
        const [lazyResult] = pending.counts.get(hash)
        fetching.counts.set(hash, true)
        searches.push(lazyResult.query.search)
      })

    if (searches.length === 0) {
      console.log('nothing to count', model)
      return
    }

    Z.methods.bulkCount({ model, searches })
      .then(counts => {
        console.log('bulkCount results', counts)
        counts
          .forEach((count, index) => {
            const hash = hashes[index]
            counts[hash] = cache.counts[hash] = count || 0
            fetching.counts.delete(hash)
            if (pending.counts.has(hash)) {
              const lazyLists = pending.counts.get(hash)
              pending.counts.delete(hash)
              lazyLists.forEach(sL => {
                Vue.set(sL, 'count', count)
              })
            }
          })
      })
      .catch(error => {
        console.error('count error', { model, searches, error })
      })
  }

  fetchPendingEntries () {
    const { model, pending, entries, changeIndex } = this
    if (pending.entries.length > 0) {
      const entryIds = pending.entries
      pending.entries = []
      Z.methods.get({ model, entryIds })
        .then(rows => {
          console.log('get', { model, entryIds }, { rows })
          rows.forEach(row => {
            Object.assign(row, {
              inSync: true,
              key: [changeIndex, row.id].join()
            })
            Object.keys(row).forEach(key => {
              Vue.set(entries[row.id], key, row[key])
            })
            notifySyncCallbacks(entries[row.id])
          })
        })
    }
  }

  fetchPendingLists () {
    const { model, lazyResults, changeIndex, cache, pending, maxQueriesPerRequest } = this

    const similarQueries = {}
    const pendingListHashes = pending.lists.splice(0)

    pendingListHashes
      .forEach((hash, index) => {
        const { query } = lazyResults[hash]
        const { search, order, limit, offset } = query
        const similarHash = LazySync.hash(
          JSON.stringify({
            order,
            limit,
            offset,
            fields: Object.keys(search),
            requestIndex: Math.floor(index / maxQueriesPerRequest)
          })
        )
        similarQueries[similarHash] = similarQueries[similarHash] || []
        similarQueries[similarHash].push(hash)
      })

    Object.keys(similarQueries)
      .forEach(similarHash => {
        const hashes = similarQueries[similarHash]
        const queries = hashes.map(hash => lazyResults[hash].query)
        const { order, limit, offset } = queries[0]
        const searches = queries.map(query => query.search)
        console.log('bulkFind', model, { queries, searches })

        Z.methods.bulkFind({ model, searches, limit, offset, order })
          .then(arrayOfLists => {
            console.log('found', model, { queries, arrayOfLists })

            arrayOfLists.forEach((list, index) => {
              const hash = hashes[index]
              const lazyResult = lazyResults[hash]

              // is supposed to fix a race condition that happens when find request is initiated, but invalidate() is called before it returns
              if (lazyResult.changeIndex < changeIndex) {
                lazyResult.changeIndex = changeIndex
                // cache the list of ids
                cache.lists[hash] = list

                // will clear the array and trigger an update
                const entries = list.map(id => Z[model].id(id))
                lazyResult.list.splice(0)
                lazyResult.list.push(...entries)
                lazyResult.inSync = true
                notifySyncCallbacks(lazyResult)
              } else {
                console.log('Lucky we looked for this race condition, isn\'t it?')
              }
            })
          })
      })
  }

  invalidate () {
    this.changeIndex++
    this.pending.counts = new Map()
    this.counts = {}
    for (const lazyResult of Object.values(this.lazyResults)) {
      lazyResult.invalidate()
    }
  }

  invalidateWithChange (change) {
    const updatedFields = Object.keys(change)
    this.changeIndex++
    updatedFields.forEach(field => {
      for (const lazyResult of Object.values(this.lazyResults)) {
        const mightBeModified = JSON.stringify(lazyResult.query).indexOf(field) !== -1
        if (mightBeModified) {
          lazyResult.invalidate()
        }
      }
    })
  }

  static hash (str) {
    let hash = 0; let i; let chr
    if (str.length === 0) return hash
    for (i = 0; i < str.length; i++) {
      chr = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + chr
      hash |= 0 // Convert to 32bit integer
    }
    return hash
  }
}

class LazyEntry {
  constructor (id, changeIndex) {
    this.id = id
    this.key = [id, changeIndex].join()
    this.inSync = false
  }

  then (inSyncCallback) {
    if (this.inSync) {
      // TODO maybe should make this behave the same way as promises (call function after nextTick)
      inSyncCallback(this)
    } else {
      if (inSyncCallbacks.has(this)) {
        inSyncCallbacks.get(this).push(inSyncCallback)
      } else {
        inSyncCallbacks.set(this, [inSyncCallback])
      }
    }
  }
}

class LazyResult {
  constructor (model, query) {
    const changeIndex = 0
    Object.assign(this, { model, query, changeIndex, list: [], inSync: false })
    this.invalidate()
  }

  invalidate () {
    const { model, query } = this
    const { search } = query
    Z[model].clearCount(search)

    const list = this.list

    Vue.set(this, 'inSync', false)
    Vue.delete(this, 'list')
    Vue.delete(this, 'count')

    Object.defineProperty(this, 'list', {
      configurable: true,
      get () {
        delete this.list // delete getter
        Vue.set(this, 'list', list)
        Z[model].refresh(this)
        return this.list
      }
    })

    Object.defineProperty(this, 'count', {
      configurable: true,
      get: () => {
        const count = Z[model].count(search, this)
        delete this.count // delete getter
        Vue.set(this, 'count', count)
        return count
      }
    })
  }

  then (inSyncCallback) {
    if (this.inSync) {
      // TODO should maybe make this behave the same way as promises (call function after nextTick)
      inSyncCallback(this)
    } else {
      if (inSyncCallbacks.has(this)) {
        inSyncCallbacks.get(this).push(inSyncCallback)
      } else {
        inSyncCallbacks.set(this, [inSyncCallback])
        Z[this.model].refresh(this)
      }
    }
  }
}
