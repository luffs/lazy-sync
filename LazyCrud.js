import Sequelize, { col, fn, literal, Op, QueryTypes } from 'sequelize'
import Utils from 'sequelize/lib/utils.js'

// TODO order bulkFind... maybe replace it with manually written sql

let db = {}
let sequelize = null
let changeListener = (session, { created, related, updated, deleted, zombies }) => {}

export const crud = {
  init (dbInstance, dbModels, changeCallback) {
    db = dbModels
    sequelize = dbInstance
    changeListener = changeCallback
  },
  addMember: async function (session, { model, entryId, memberModel, memberEntryId }) {
    return addOrRemoveMember(session, 'add', { model, entryId, memberModel, memberEntryId })
  },
  removeMember: async function (session, { model, entryId, memberModel, memberEntryId }) {
    return addOrRemoveMember(session, 'remove', { model, entryId, memberModel, memberEntryId })
  },
  count: async function (session, { model, search = {} }) {
    const include = []
    const where = {}
    setSearchQuery(model, where, search, include)
    return db[model].count({ where, include })
  },
  create: async function (session, { model, objValues }) {
    const newEntry = await db[model].create(objValues)
    const entryId = newEntry.id
    Object.keys(objValues)
      .forEach(memberModel => {
        const association = db[model].associations[memberModel]
        if (association) {
          if (['BelongsToMany', 'HasMany'].includes(association.associationType)) {
            const memberEntryIds = objValues[memberModel]
            this.setMembers(session, {
              model,
              entryId,
              memberModel,
              memberEntryIds
            })
          }
        }
      })
    // TODO prevent duplicate events from calling both setMembers and this
    changeListener(session, {
      created: [
        [model, [entryId]]
      ]
    })
    return newEntry
  },
  bulkCount: async function (session, { model, searches = [] }) {
    const bulkSelectQuery = generateBulkSelectQuery({ model, searches }, true)
    const rows = await sequelize.query(bulkSelectQuery, { type: QueryTypes.SELECT })
    if (rows.length === searches.length) {
      const results = []
      rows.forEach(row => {
        const { queryId } = row
        const found = parseInt(row.found, 10) // string in postgres, number in mysql
        const validQueryId = (queryId < searches.length) && (results[queryId] === undefined)
        const validResult = typeof found === 'number'
        if (validQueryId && validResult) {
          results[queryId] = found
        } else {
          throw new Error('Count error, invalid result')
        }
      })
      return results
    } else {
      throw new Error('Count error, result.length mismatch')
    }
  },
  bulkFind: async function (session, { model, searches = [], limit = undefined, offset = 0, order = [] }) {
    const bulkSelectQuery = generateBulkSelectQuery({ model, searches, limit, offset, order })
    const rows = await sequelize.query(bulkSelectQuery, { type: QueryTypes.SELECT })
    const results = searches.map(() => [])
    rows.forEach(({ id, queryId }) => {
      results[queryId].push(id)
    })
    return results
  },
  find: async function (session, { model, search = {}, limit = undefined, offset = 0, order = [] }) {
    const attributes = ['id']
    const include = []
    const where = {}

    // order by name by default, if model has name field
    if (!Array.isArray(order) || order.length === 0) {
      order = db[model].rawAttributes.name ? ['name'] : []
    } else if (Array.isArray(order[0])) {
      // 'Locations' to db.Locations etc
      const orderFirstArgument = order[0][0]
      if (db[orderFirstArgument]) {
        order[0][0] = db[orderFirstArgument]
        include.push({
          model: db[orderFirstArgument],
          attributes: []
        })
      }
    }

    setSearchQuery(model, where, search, include)

    const rows = await db[model].findAll({ attributes, where, limit, offset, order, include })
    return rows.map(row => row.id)
  },
  get: async function (session, { model, entryIds = [] }) {
    const where = { id: entryIds }
    return db[model].findAll({ where })
  },
  order: async function (session, { model, entryIds = [], order = [] }) {
    // TODO validate array of ids and has access...
    await Promise.all(
      entryIds.map((id, index) => {
        return db[model].update({ order: order[index] }, { where: { id } })
      })
    )
    changeListener(session, {
      updated: entryIds.map((entryId, index) => [model, [entryId], { order: order[index] }])
    })
  },
  setMembers: async function (session, { model, entryId, memberModel, memberEntryIds }) {
    const parentModel = db[model]
    const association = parentModel.associations[memberModel]
    const { associationType, foreignKey } = association

    if (['BelongsToMany', 'HasMany'].includes(associationType)) {
      const setAccessor = association.accessors.set
      const getAccessor = association.accessors.get
      const parentEntry = await parentModel.findByPk(entryId)

      if (associationType === 'BelongsToMany') {
        // TODO don't emit if nothing has changed
        const updateMembers = await parentEntry[setAccessor](memberEntryIds)
        changeListener(session, {
          related: [
            [model],
            [memberModel]
          ]
        })
        return updateMembers
      } else if (associationType === 'HasMany') {
        const oldMembers = await parentEntry[getAccessor]({ attributes: ['id'] })
        const oldMemberIds = oldMembers.map(entry => entry.id)

        const removedEntries = oldMemberIds.filter(id => !memberEntryIds.includes(id))
        const addedEntries = memberEntryIds.filter(id => !oldMemberIds.includes(id))

        const updateMember = await parentEntry[setAccessor](memberEntryIds)

        // TODO get exact updatedAt from db. updateMember.updatedAt is old, not modified
        const updatedAt = new Date().toISOString()

        changeListener(session, {
          related: [
            [model],
            [memberModel]
          ],
          updated: [
            [memberModel, removedEntries, { [foreignKey]: null, updatedAt }],
            [memberModel, addedEntries, { [foreignKey]: entryId, updatedAt }]
          ]
        })
        return updateMember
      }
    } else {
      throw new Error(`${model} & ${memberModel} are not related`)
    }
  },
  update: async function (session, { model, entryId, objValues }) {
    const objEntry = await db[model].findByPk(entryId)

    // Don't allow changing relation by setting parent Id directly (ex. use MediaFolders instead of MediaFolderId)
    // Cancel that, since it this won't work when model is related to self, like Posts might have a PostId
    /* Object.keys(objValues).forEach(key => {
      if (key.endsWith('Id')) {
        delete objValues[key]
      }
    }) */

    const updatedEntry = await objEntry.update(objValues)
    const changed = {}
    Object.keys(updatedEntry._changed).forEach(key => {
      changed[key] = updatedEntry[key]
    })
    Object.keys(objValues)
      .forEach(memberModel => {
        const association = db[model].associations[memberModel]
        if (association) {
          if (['BelongsToMany', 'HasMany'].includes(association.associationType)) {
            const memberEntryIds = objValues[memberModel]
            // TODO don't call unless changed
            this.setMembers(session, {
              model,
              entryId: updatedEntry.id,
              memberModel,
              memberEntryIds
            })
          }
        }
      })
    if (Object.keys(changed).length > 0) {
      changeListener(session, {
        updated: [
          [model, [entryId], changed]
        ]
      })
    }
    return updatedEntry
  },
  delete: async function (session, { model, entryId }) {
    const objEntry = await db[model].findByPk(entryId)
    const result = await objEntry.destroy()
    changeListener(session, {
      deleted: [
        [model, [entryId]]
      ]
    })
    return result
  },
  restore: async function (session, { model, entryId }) {
    const objEntry = await db[model].findByPk(entryId, { paranoid: false })
    const result = await objEntry.restore()
    changeListener(session, {
      zombies: [
        [model, [entryId]]
      ]
    })
    return result
  }
}

function getParentModel (strModel, where) {
  return Object.keys(where)
    .filter(key => {
      const association = (db[key] && db[key].associations[strModel]) || {}
      const { foreignKey, associationType } = association

      if (associationType === 'HasMany') {
        where[foreignKey] = where[key]
        delete where[key]
        return false
      }
      return associationType === 'BelongsToMany'
    })
}

async function addOrRemoveMember (session, accessorStr, { model, entryId, memberModel, memberEntryId }) {
  const association = db[model].associations[memberModel]
  const { associationType, foreignKey } = association
  const parentEntry = await db[model].findByPk(entryId)

  if (associationType === 'BelongsToMany') {
    const accessor = association.accessors[accessorStr]
    const updatedParent = await parentEntry[accessor](memberEntryId)
    changeListener(session, {
      related: [
        [model],
        [memberModel]
      ]
    })
    return updatedParent
  } else if (associationType === 'HasMany') {
    const accessor = association.accessors[accessorStr]
    const updatedParent = await parentEntry[accessor](memberEntryId)

    const updatedAt = new Date().toISOString()
    const change = { [foreignKey]: accessorStr === 'add' ? entryId : null, updatedAt }
    changeListener(session, {
      related: [
        [model],
        [memberModel]
      ],
      updated: [
        [memberModel, [memberEntryId], change]
      ]
    })
    return updatedParent
  }
  throw new Error(`${model} & ${memberModel} are not in a many-to-many relationship`)
}

function setSearchQuery (model, where, search, include, queryId = 0) {
  if (search && typeof search === 'object') {
    Object.keys(search).forEach(field => {
      where[Op[field] || field] = resolveOpsInSearchQuery(model, search[field])
    })
    for (const symbol of Object.getOwnPropertySymbols(search)) {
      where[symbol] = resolveOpsInSearchQuery(model, search[symbol])
    }
  }
  getParentModel(model, where).forEach(parentModel => {
    const parentId = search[parentModel]
    // since it might be included by the "order" code above already
    let inc = include.find(inc => inc.model === db[parentModel])
    if (!inc) {
      inc = { model: db[parentModel], attributes: ['id'] }
      include.push(inc)
    }
    inc.required = true
    // use Op.in if parentId is array of ids
    inc.where = Array.isArray(parentId)
      ? { id: { [Op.in]: parentId } }
      : { id: parentId }

    delete where[parentModel]
  })
}

// what could possibly go wrong
function resolveOpsInSearchQuery (model, search) {
  let returnValue
  if (Array.isArray(search)) {
    returnValue = search.map(subSearch => resolveOpsInSearchQuery(model, subSearch))
  } else if (search && typeof search === 'object') {
    returnValue = {}
    Object.keys(search).forEach(opOrField => {
      returnValue[Op[opOrField] || opOrField] = resolveOpsInSearchQuery(model, search[opOrField])
    })
  } else if (db[model].rawAttributes[search]) {
    returnValue = Sequelize.col(search)
  } else {
    returnValue = search
  }
  return returnValue
}

function generateBulkSelectQuery ({ model, searches, order, limit, offset }, isCount = false) {
  const include = []

  if (!isCount) {
    // order by name by default, if model has name field
    if (!Array.isArray(order) || order.length === 0) {
      order = db[model].rawAttributes.name ? ['name'] : []
    } else if (Array.isArray(order[0])) {
      // 'Locations' to db.Locations etc
      const orderFirstArgument = order[0][0]
      if (db[orderFirstArgument]) {
        order[0][0] = db[orderFirstArgument]
        include.push({
          model: db[orderFirstArgument],
          attributes: []
        })
      }
    }
  }

  const Model = db[model]
  const sqlQueries = searches
    .map((search, queryId) => {
      const attributes = [[literal(String(queryId)), 'queryId'], isCount ? [fn('COUNT', col('*')), 'found'] : 'id']
      const where = {}
      setSearchQuery(model, where, search, include, queryId)
      return generateSelectQuery.call(Model, { where, order, limit, offset, include, attributes, distinct: isCount })
    })

  return sqlQueries
    .map(sqlQuery => {
      // remove last semicolon and wrap in parentheses
      return `(${sqlQuery.slice(0, -1)})`
    })
    .join(' UNION ')
}

function generateSelectQuery (options) {
  this.warnOnInvalidOptions(options, Object.keys(this.rawAttributes))

  const tableNames = {}

  tableNames[this.getTableName(options)] = true
  options = Utils.cloneDeep(options)

  // set rejectOnEmpty option, defaults to model options
  options.rejectOnEmpty = Object.prototype.hasOwnProperty.call(options, 'rejectOnEmpty')
    ? options.rejectOnEmpty
    : this.options.rejectOnEmpty

  this._injectScope(options)
  this._conformIncludes(options, this)
  this._expandAttributes(options)
  this._expandIncludeAll(options)

  options.originalAttributes = this._injectDependentVirtualAttributes(options.attributes)

  if (options.include) {
    options.hasJoin = true

    this._validateIncludedElements(options, tableNames)

    // If we're not raw, we have to make sure we include the primary key for de-duplication
    if (
      options.attributes &&
      !options.raw &&
      this.primaryKeyAttribute &&
      !options.attributes.includes(this.primaryKeyAttribute) &&
      (!options.group || !options.hasSingleAssociation || options.hasMultiAssociation)
    ) {
      options.attributes = [this.primaryKeyAttribute].concat(options.attributes)
    }
  }

  if (!options.attributes) {
    options.attributes = Object.keys(this.rawAttributes)
    options.originalAttributes = this._injectDependentVirtualAttributes(options.attributes)
  }

  // whereCollection is used for non-primary key updates
  this.options.whereCollection = options.where || null

  Utils.mapFinderOptions(options, this)

  options = this._paranoidClause(this, options)
  const selectOptions = Object.assign({}, options, { tableNames: Object.keys(tableNames) })
  return this.QueryGenerator.selectQuery(this.getTableName(selectOptions), selectOptions, this)
}
