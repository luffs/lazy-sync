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
    async count ({ model, where = {}, search = {} }) {},
    async find ({ model, where = {}, limit = undefined, offset = 0, search = {}, order = [] }) {},
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
      cache: {
        counts: {},
        entries: {},
        lists: {}
      },
      pending: {
        counts: new Map(),
        entries: []
      },
      counts: {},
      entries: {},
      fetchTimeout: 0,
      options: {
        search: {},
        order: [],
        limit: undefined,
        offset: 0
      },
      results: {}
    })
  }

  id (id) {
    id = parseInt(id, 10)
    if (!this.entries[id]) {
      this.entries[id] = new LazyEntry(id, this.changeIndex)
      this.pending.entries.push(id)
      this.fetchLater()
    }
    return this.entries[id]
  }

  clearCount (where = {}, options) {
    options = options || this.options
    const { model } = this
    const { search } = options
    const query = { where, search, model }
    const hash = LazySync.hash(JSON.stringify(query))
    delete this.counts[hash]
    delete this.pending.counts[hash]
  }

  count (where = {}, options, snazzyList) {
    options = options || this.options
    const { model } = this
    const { search } = options
    const query = { where, search, model }
    const hash = LazySync.hash(JSON.stringify(query))

    // console.log('get count', model)
    if (typeof this.counts[hash] === 'number') {
      return this.counts[hash]
    } else if (snazzyList) {
      if (this.pending.counts.has(hash)) {
        this.pending.counts.get(hash).add(snazzyList)
      } else {
        const countHolders = new Set([snazzyList])
        this.pending.counts.set(hash, countHolders)

        Z.methods.count(query)
          .then(count => {
            console.log('count', this.model, { count, hash })
            this.counts[hash] = this.cache.counts[hash] = count || 0
            this.notifyCountHolders(hash, count)
          })
          .catch(error => {
            console.error('count error', { model, query, error })
          })
      }
    }
    return this.cache.counts[hash] || 0
  }

  find (where = {}, options) {
    options = options || this.options
    const { model } = this
    const { limit, offset, search, order } = options
    const query = { where, limit, offset, search, model, order }
    const hash = LazySync.hash(JSON.stringify(query))

    if (!this.results[hash]) {
      this.results[hash] = new LazyResult(this.model, query)
    }
    return this.results[hash]
  }

  refresh (snazzyResult) {
    const { model, query } = snazzyResult
    const { changeIndex } = Z[model]
    const hash = LazySync.hash(JSON.stringify(query))
    // Z[model].changeIndex will be incremented every time the model get invalidated by an event from the server
    if (snazzyResult.changeIndex !== changeIndex) {
      snazzyResult.changeIndex = changeIndex

      const cachedList = this.cache.lists[hash]
      if (cachedList) {
        snazzyResult.list.splice(0)
        cachedList.forEach(id => {
          const entry = Z[model].id(id)
          snazzyResult.list.push(entry)
        })
      }

      // console.log('before find', model)
      Z.methods.find(query)
        .then(rows => {
          // is supposed to fix a race condition that happens when find request is initiated, but invalidate() is called before it returns
          if (Z[model].changeIndex === changeIndex) {
            console.log('find', model, { query, rows, snazzyResult })
            this.cache.lists[hash] = rows
            // this will trigger an update and clear the array
            // snazzyResult.find = rows.map(id => Z[model].id(id))
            snazzyResult.list.splice(0)
            rows.forEach(id => {
              const entry = Z[model].id(id)
              snazzyResult.list.push(entry)
            })
            // this doesn't trigger an update
            snazzyResult.inSync = true
            notifySyncCallbacks(snazzyResult)
          } else {
            console.log('Lucky we looked for this race condition, isn\'t it?')
          }
        })
        .catch(error => {
          console.error('find', error)
        })
    }
    return snazzyResult
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

  fetchLater () {
    clearTimeout(this.fetchTimeout)
    this.fetchTimeout = setTimeout(this.fetchPending.bind(this), 1)
  }

  fetchPending () {
    if (this.ready && this.pending.entries.length > 0) {
      const entryIds = this.pending.entries
      const { model } = this
      Z.methods.get({ model, entryIds })
        .then(rows => {
          console.log('get', { model, entryIds }, { rows })
          rows.forEach(row => {
            Object.assign(row, {
              inSync: true,
              key: [this.changeIndex, row.id].join()
            })
            Object.keys(row).forEach(key => {
              Vue.set(this.entries[row.id], key, row[key])
            })
            notifySyncCallbacks(this.entries[row.id])
          })
        })
      this.pending.entries = []
    }
  }

  invalidate () {
    this.changeIndex++
    this.pending.counts = new Map()
    this.counts = {}
    for (const snazzyResult of Object.values(this.results)) {
      snazzyResult.invalidate()
    }
  }

  invalidateWithChange (change) {
    const updatedFields = Object.keys(change)
    this.changeIndex++
    updatedFields.forEach(field => {
      for (const snazzyResult of Object.values(this.results)) {
        const mightBeModified = JSON.stringify(snazzyResult.query).indexOf(field) !== -1
        if (mightBeModified) {
          snazzyResult.invalidate()
        }
      }
    })
  }

  notifyCountHolders (hash, count) {
    if (this.pending.counts.has(hash)) {
      const snazzyLists = this.pending.counts.get(hash)
      this.pending.counts.delete(hash)
      snazzyLists.forEach(sL => {
        Vue.set(sL, 'count', count)
      })
    }
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
    Object.assign(this, { model, query, changeIndex, inSync: false })
    this.invalidate()
  }

  invalidate () {
    const { model, query } = this
    const { where, search } = query
    Z[model].clearCount(where, { search })

    Vue.set(this, 'inSync', false)
    Vue.delete(this, 'list')
    Vue.delete(this, 'count')

    Object.defineProperty(this, 'list', {
      configurable: true,
      get () {
        delete this.list // delete getter
        Vue.set(this, 'list', [])
        Z[model].refresh(this)
        return this.list
      }
    })

    Object.defineProperty(this, 'count', {
      configurable: true,
      get: () => {
        const options = { search }
        const count = Z[model].count(where, options, this)
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
