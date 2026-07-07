// db/collectionsDb.js
const { getCollection, COLLECTIONS } = require('./getCollection');
const logger = require('../logger');

// ==================== 合集 CRUD ====================

async function getNextId(colName) {
    const col = getCollection(colName);
    const maxDoc = await col.findOne({}, { sort: { id: -1 } });
    return (maxDoc?.id || 0) + 1;
}

async function createCollection({ name, type }) {
    const col = getCollection(COLLECTIONS.COLLECTION);
    const id = await getNextId(COLLECTIONS.COLLECTION);
    const now = Date.now();
    const doc = { id, name, type, created_at: now, updated_at: now };
    await col.insertOne(doc);
    logger.info(`合集已创建: id=${id}, name=${name}, type=${type}`);
    return doc;
}

async function getCollectionsByType(type) {
    const col = getCollection(COLLECTIONS.COLLECTION);
    return await col.find({ type }).sort({ name: 1 }).toArray();
}

async function getCollectionById(id) {
    const col = getCollection(COLLECTIONS.COLLECTION);
    return await col.findOne({ id: parseInt(id) });
}

async function updateCollection(id, updates) {
    const col = getCollection(COLLECTIONS.COLLECTION);
    const setFields = { updated_at: Date.now(), ...updates };
    await col.updateOne({ id: parseInt(id) }, { $set: setFields });
    logger.info(`合集已更新: id=${id}`);
    return await col.findOne({ id: parseInt(id) });
}

async function deleteCollection(id) {
    const col = getCollection(COLLECTIONS.COLLECTION);
    const subCol = getCollection(COLLECTIONS.SUB_COLLECTION);
    await subCol.deleteMany({ collection_id: parseInt(id) });
    await col.deleteOne({ id: parseInt(id) });
    logger.info(`合集已删除: id=${id}`);
}

// ==================== 子合集 CRUD ====================

async function createSubCollection({ collection_id, name, link }) {
    const col = getCollection(COLLECTIONS.SUB_COLLECTION);
    const id = await getNextId(COLLECTIONS.SUB_COLLECTION);
    const now = Date.now();
    const doc = { id, collection_id: parseInt(collection_id), name, link, created_at: now, updated_at: now };
    await col.insertOne(doc);
    const parentCol = getCollection(COLLECTIONS.COLLECTION);
    await parentCol.updateOne({ id: parseInt(collection_id) }, { $set: { updated_at: now } });
    logger.info(`子合集已创建: id=${id}, collection_id=${collection_id}`);
    return doc;
}

async function getSubCollectionsByCollectionId(collection_id) {
    const col = getCollection(COLLECTIONS.SUB_COLLECTION);
    return await col.find({ collection_id: parseInt(collection_id) }).sort({ updated_at: -1 }).toArray();
}

async function getSubCollectionById(id) {
    const col = getCollection(COLLECTIONS.SUB_COLLECTION);
    return await col.findOne({ id: parseInt(id) });
}

async function updateSubCollection(id, updates) {
    const col = getCollection(COLLECTIONS.SUB_COLLECTION);
    const now = Date.now();
    const setFields = { updated_at: now, ...updates };
    await col.updateOne({ id: parseInt(id) }, { $set: setFields });
    const sub = await col.findOne({ id: parseInt(id) });
    if (sub) {
        const parentCol = getCollection(COLLECTIONS.COLLECTION);
        await parentCol.updateOne({ id: sub.collection_id }, { $set: { updated_at: now } });
    }
    logger.info(`子合集已更新: id=${id}`);
    return await col.findOne({ id: parseInt(id) });
}

async function deleteSubCollection(id) {
    const col = getCollection(COLLECTIONS.SUB_COLLECTION);
    const sub = await col.findOne({ id: parseInt(id) });
    await col.deleteOne({ id: parseInt(id) });
    if (sub) {
        const parentCol = getCollection(COLLECTIONS.COLLECTION);
        await parentCol.updateOne({ id: sub.collection_id }, { $set: { updated_at: Date.now() } });
    }
    logger.info(`子合集已删除: id=${id}`);
}

module.exports = {
    createCollection, getCollectionsByType, getCollectionById, updateCollection, deleteCollection,
    createSubCollection, getSubCollectionsByCollectionId, getSubCollectionById, updateSubCollection, deleteSubCollection
};
