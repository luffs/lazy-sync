import Sequelize, { QueryTypes } from 'sequelize'

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
    const where = resolveOpsInSearchQuery({ model, search, include, isCount: true })
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
    const bulkSelectQuery = generateBulkSelectQuery({ model, order: [], searches, isCount: true })
    const rows = await sequelize.query(bulkSelectQuery, { type: Sequelize.QueryTypes.SELECT })
    if (rows.length === searches.length) {
      const results = []
      rows.forEach(row => {
        const { queryindex } = row
        const found = parseInt(row.found, 10) // string in postgres, number in mysql
        const validQueryIndex = (queryindex < searches.length) && (results[queryindex] === undefined)
        const validResult = typeof found === 'number'
        if (validQueryIndex && validResult) {
          results[queryindex] = found
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
    const rows = await sequelize.query(bulkSelectQuery, { type: Sequelize.QueryTypes.SELECT })
    const results = searches.map(() => [])
    rows.forEach(({ id, queryindex }) => {
      results[queryindex].push(id)
    })
    return results.map(ids => Array.from(new Set(ids)))
  },
  find: async function (session, { model, search = {}, limit = undefined, offset = 0, order = [] }) {
    const attributes = ['id']
    const include = []

    // order by name by default, if model has name field
    if (!Array.isArray(order) || order.length === 0) {
      order = db[model].getAttributes().name ? ['name'] : []
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

    const where = resolveOpsInSearchQuery({ model, search, include })
    const rows = await db[model].findAll({ attributes, where, limit, offset, order, include })
    const ids = rows.map(row => row.id)
    return Array.from(new Set(ids))
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

    const memberFields = Object.keys(objValues)
      .filter(memberModel => {
        const association = db[model].associations[memberModel]
        return association && ['BelongsToMany', 'HasMany'].includes(association.associationType)
      })

    const updateMembersPromises = memberFields.map(memberModel => {
      const memberEntryIds = objValues[memberModel]
      delete objValues[memberModel]
      // TODO don't call unless changed?
      return this.setMembers(session, {
        model,
        entryId: objEntry.id,
        memberModel,
        memberEntryIds
      })
    })
    await Promise.all(updateMembersPromises)
    const updatedEntry = await objEntry.update(objValues)
    objValues.updatedAt = objEntry.updatedAt
    changeListener(session, {
      updated: [
        [model, [entryId], objValues]
      ]
    })
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

// what could possibly go wrong

function generateBulkSelectQuery ({ model, searches, order, limit, offset, isCount = false }) {
  const include = []

  if (!isCount) {
    // order by name by default, if model has name field
    if (!Array.isArray(order) || order.length === 0) {
      order = db[model].getAttributes().name ? ['name'] : []
    } else if (Array.isArray(order[0])) {
      // 'Locations' to object in db['Locations'] etc
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

  const dbModel = db[model]
  const sqlQueries = searches
    .map((search, queryindex) => {
      const attributes = []
      if (isCount) {
        attributes.push([Sequelize.literal('COUNT(*)'), 'found'])
      } else {
        // return the primaryKey, usually "id"
        const primaryKey = Object.values(dbModel.primaryKeys)[0]
        attributes.push(primaryKey.field)
      }

      // Fetch attributes used for ordering. Well, unless attr is 'id' since it's already added
      order.forEach(item => {
        if (Array.isArray(item) && typeof item[0] === 'string' && item[0] !== 'id') {
          attributes.push(item[0])
        }
      })

      const where = resolveOpsInSearchQuery({ model, search, include })
      if (dbModel.options.paranoid) {
        where.deletedAt = null
      }
      const options = {
        type: QueryTypes.SELECT,
        model: dbModel,
        where,
        order,
        limit,
        offset,
        include,
        attributes,
        distinct: isCount
      }
      const tableName = dbModel.getTableName()

      // Prefix each query with a queryindex, like SELECT 0 AS queryindex, SELECT 1 AS queryindex etc
      // CANNOT be camelCase, must be lowercase, because postgres is silly and return it as lowercase
      return dbModel.queryGenerator.selectQuery(tableName, options, dbModel)
        .replace('SELECT', `SELECT ${queryindex} AS queryindex,`)
    })

  return sqlQueries
    .map(sqlQuery => {
      // remove last semicolon and wrap in parentheses
      return `(${sqlQuery.slice(0, -1)})`
    })
    .join(' UNION ')
}

function resolveOpsInSearchQuery ({ model, search, include, isCount = false }) {
  let where = search
  includeParentModels({ model, search, include, isCount })
  if (Array.isArray(search)) {
    where = search.map(subSearch => resolveOpsInSearchQuery({ model, search: subSearch, include, isCount }))
  } else if (search && typeof search === 'object') {
    where = {}
    Object.keys(search).forEach(opOrField => {
      where[Sequelize.Op[opOrField] || opOrField] = resolveOpsInSearchQuery({ model, search: search[opOrField], include, isCount })
    })
  } else if (db[model].getAttributes()[search]) {
    // ex. updatedAt = col(createdAt)
    where = Sequelize.col(search)
  }
  return where
}

function includeParentModels ({ model, search, include, isCount }) {
  const searchParams = Object.keys(search || {})
  searchParams.forEach(searchKey => {
    const association = (db[model] && db[model].associations[searchKey]) || {}
    const { associationType } = association
    if (associationType === 'BelongsToMany') {
      const { combinedName, target, through, as } = association
      const parentSearch = search[searchKey]
      // since it might be included by the "order" code above already
      let inc = include.find(inc => inc.model === db[combinedName])
      if (!inc) {
        inc = {
          as,
          parent: {
            model: db[model]
          },
          association,
          model: target,
          through: {
            model: through.model,
            attributes: []
          },
          attributes: []
        }
        include.push(inc)
      }
      inc.required = true
      inc.where = { id: parentSearch }

      delete search[searchKey]
    }
  })
}
