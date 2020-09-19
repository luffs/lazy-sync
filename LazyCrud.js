import Sequelize, { literal, Op, QueryTypes } from 'sequelize'

let db = {}
let changeListener = ({ created, related, updated, deleted, zombies }) => {}

export const crud = {
  init (dbModels, changeCallback) {
    db = dbModels
    changeListener = changeCallback
  },
  addMember: async function ({ model, entryId, memberModel, memberEntryId }) {
    return addOrRemoveMember('add', { model, entryId, memberModel, memberEntryId })
  },
  removeMember: async function ({ model, entryId, memberModel, memberEntryId }) {
    return addOrRemoveMember('remove', { model, entryId, memberModel, memberEntryId })
  },
  count: async function ({ model, search = {} }) {
    const include = []
    const where = {}
    setSearchQuery(model, where, search, include)
    return db[model].count({ where, include })
  },
  create: async function ({ model, objValues }) {
    const newEntry = await db[model].create(objValues)
    const entryId = newEntry.id
    Object.keys(objValues)
      .forEach(memberModel => {
        const association = db[model].associations[memberModel]
        if (association) {
          if (['BelongsToMany', 'HasMany'].includes(association.associationType)) {
            const memberEntryIds = objValues[memberModel]
            this.setMembers({
              model,
              entryId,
              memberModel,
              memberEntryIds
            })
          }
        }
      })
    // TODO prevent duplicate events from calling both setMembers and this
    changeListener({
      created: [
        [model, [entryId]]
      ]
    })
    return newEntry
  },
  bulkFind: async function ({ model, searches = [], limit = undefined, offset = 0, order = [] }) {
    const bulkSelectQuery = generateBulkSelectQuery(db[model], searches)
    console.log(bulkSelectQuery)

    const rows = await Sequelize.query(bulkSelectQuery, { type: QueryTypes.SELECT })
    const results = searches.map(() => [])
    rows.forEach(({ id, queryId }) => {
      results[queryId].push(id)
    })
    return results

    function generateBulkSelectQuery (Model, searches) {
      return searches
        .map(({ where = {}, order = [] }, index) => {
          const attributes = ['id', literal(index + ' AS queryId')]
          return Model.QueryGenerator.selectQuery(Model.getTableName(), { where, order, attributes }, Model)
        })
        .join(' UNION ')
      // TODO replace all ORDER BY statements, except the last
      // .replace(/[.](?=.*[.])/g, "");
    }
  },
  find: async function ({ model, search = {}, limit = undefined, offset = 0, order = [] }) {
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
  get: async function ({ model, entryIds = [] }) {
    const where = { id: entryIds }
    return db[model].findAll({ where })
  },
  order: async function ({ model, entryIds = [], order = [] }) {
    // TODO validate array of ids and has access...
    await Promise.all(
      entryIds.map((id, index) => {
        return db[model].update({ order: order[index] }, { where: { id } })
      })
    )
    changeListener({
      updated: entryIds.map((entryId, index) => [model, [entryId], { order: order[index] }])
    })
  },
  setMembers: async function ({ model, entryId, memberModel, memberEntryIds }) {
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
        changeListener({
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

        changeListener({
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
  update: async function ({ model, entryId, objValues }) {
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
            this.setMembers({
              model,
              entryId: updatedEntry.id,
              memberModel,
              memberEntryIds
            })
          }
        }
      })
    if (Object.keys(changed).length > 0) {
      changeListener({
        updated: [
          [model, [entryId], changed]
        ]
      })
    }
    return updatedEntry
  },
  delete: async function ({ model, entryId }) {
    const objEntry = await db[model].findByPk(entryId)
    const result = await objEntry.destroy()
    changeListener({
      deleted: [
        [model, [entryId]]
      ]
    })
    return result
  },
  restore: async function ({ model, entryId }) {
    const objEntry = await db[model].findByPk(entryId, { paranoid: false })
    const result = await objEntry.restore()
    changeListener({
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

async function addOrRemoveMember (accessorStr, { model, entryId, memberModel, memberEntryId }) {
  const association = db[model].associations[memberModel]
  const { associationType, foreignKey } = association
  const parentEntry = await db[model].findByPk(entryId)

  if (associationType === 'BelongsToMany') {
    const accessor = association.accessors[accessorStr]
    const updatedParent = await parentEntry[accessor](memberEntryId)
    changeListener({
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
    changeListener({
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

function setSearchQuery (model, where, query, include) {
  if (query && typeof query === 'object') {
    Object.keys(query)
      .forEach(field => {
        where[Op[field] || field] = resolveOpsInSearchQuery(model, query[field])
      })
  }
  getParentModel(model, where).forEach(parentModel => {
    const parentId = where[parentModel]
    // since it might be included by the "order" code above already
    let inc = include.find(inc => inc.model === db[parentModel])
    if (!inc) {
      inc = { model: db[parentModel], attributes: [] }
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
