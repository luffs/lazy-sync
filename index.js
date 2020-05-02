
import Sequelize from 'sequelize'

const { Op } = Sequelize

let db = {}
let changeListener = ({ created, related, updated, deleted, undeleted }) => {}

export const crud = {
  init (dbModels, changeCallback) {
    db = dbModels
    changeListener = changeCallback
  },
  addMember: async function ({ model, parentEntryId, memberModel, memberEntryId }) {
    return addOrRemoveMember('add', { model, parentEntryId, memberModel, memberEntryId })
  },
  removeMember: async function ({ model, parentEntryId, memberModel, memberEntryId }) {
    return addOrRemoveMember('remove', { model, parentEntryId, memberModel, memberEntryId })
  },
  count: async function ({ model, where = {}, search = {} }) {
    if (search && typeof search === 'object') {
      setSearchQuery(model, where, search)
    }

    const parentKey = getParentModel(model, where)
    if (parentKey) {
      const parentId = where[parentKey]
      const parent = await db[parentKey].findByPk(parentId)
      const countAccessor = db[parentKey].associations[model].accessors.count

      delete where[parentKey]
      return parent[countAccessor]({ where })
    }

    return db[model].count({ where })
  },
  create: async function ({ model, objValues }) {
    const newEntry = await db[model].create(objValues)
    Object.keys(objValues)
      .forEach(memberModel => {
        const association = db[model].associations[memberModel]
        if (association) {
          if (['BelongsToMany', 'HasMany'].includes(association.associationType)) {
            const memberEntryIds = objValues[memberModel]
            this.setMembers({
              model,
              parentEntryId: newEntry.id,
              memberModel,
              memberEntryIds
            })
          }
        }
      })
    // TODO prevent duplicate events from calling both setMembers and this
    changeListener({
      creates: [
        [model, [newEntry.id]]
      ]
    })
    return newEntry
  },
  find: async function ({ model, where = {}, limit = undefined, offset = 0, search = {}, order = [] }) {
    const attributes = ['id']
    const include = []

    if (search && typeof search === 'object') {
      setSearchQuery(model, where, search)
    }

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
  setMembers: async function ({ model, parentEntryId, memberModel, memberEntryIds }) {
    const parentModel = db[model]
    const association = parentModel.associations[memberModel]
    const { associationType, foreignKey } = association

    if (['BelongsToMany', 'HasMany'].includes(associationType)) {
      const setAccessor = association.accessors.set
      const getAccessor = association.accessors.get
      const parentEntry = await parentModel.findByPk(parentEntryId)

      if (associationType === 'BelongsToMany') {
        // TODO don't emit if nothing has changed
        const updateMembers = await parentEntry[setAccessor](memberEntryIds)
        changeListener({
          related: [model, memberModel]
        })
        return updateMembers
      } else if (associationType === 'HasMany') {
        const oldMembers = await parentEntry[getAccessor]({ attributes: ['id'] })
        const oldMemberIds = oldMembers.map(entry => entry.id)

        const removedEntries = oldMemberIds.filter(id => !memberEntryIds.includes(id))
        const addedEntries = memberEntryIds.filter(id => !oldMemberIds.includes(id))

        const updateMember = await parentEntry[setAccessor](memberEntryIds)

        // TODO get exact updatedAt from db. updatedAt returned by updateMember is old, not modified
        const updatedAt = new Date().toISOString()

        changeListener({
          related: [model, memberModel],
          updated: [
            [memberModel, removedEntries, { [foreignKey]: null, updatedAt }],
            [memberModel, addedEntries, { [foreignKey]: parentEntryId, updatedAt }]
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
              parentEntryId: updatedEntry.id,
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
    changeListener({
      deleted: [
        [model, [entryId]]
      ]
    })
    return objEntry.destroy()
  },
  restore: async function ({ model, entryId }) {
    const objEntry = await db[model].findByPk(entryId, { paranoid: false })
    changeListener({
      undeleted: [
        [model, [entryId]]
      ]
    })
    return objEntry.restore()
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

async function addOrRemoveMember (accessorStr, { model, parentEntryId, memberModel, memberEntryId }) {
  const association = db[model].associations[memberModel]
  const { associationType, foreignKey } = association
  const parentEntry = await db[model].findByPk(parentEntryId)

  if (associationType === 'BelongsToMany') {
    const accessor = association.accessors[accessorStr]
    const updatedParent = await parentEntry[accessor](memberEntryId)
    changeListener({
      related: [model, memberModel]
    })
    return updatedParent
  } else if (associationType === 'HasMany') {
    const accessor = association.accessors[accessorStr]
    const updatedParent = await parentEntry[accessor](memberEntryId)

    const updatedAt = new Date().toISOString()
    const change = { [foreignKey]: accessorStr === 'add' ? parentEntryId : null, updatedAt }
    changeListener({
      related: [model, memberModel],
      updated: [
        [memberModel, [memberEntryId], change]
      ]
    })
    return updatedParent
  }
  throw new Error(`${model} & ${memberModel} are not in a many-to-many relationship`)
}

function setSearchQuery (model, where, search) {
  Object.keys(search)
    .forEach(field => {
      where[Op[field] || field] = resolveOpsInSearchQuery(model, search[field])
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
