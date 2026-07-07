// db/articles.js
const { getCollection, COLLECTIONS } = require('./getCollection');
const logger = require('../logger');

// ==================== 文章 CRUD ====================

async function getNextArticleId() {
    const col = getCollection(COLLECTIONS.ARTICLE);
    const maxDoc = await col.findOne({}, { sort: { id: -1 } });
    return (maxDoc?.id || 0) + 1;
}

async function getNextSubArticleId() {
    const col = getCollection(COLLECTIONS.SUB_ARTICLE);
    const maxDoc = await col.findOne({}, { sort: { id: -1 } });
    return (maxDoc?.id || 0) + 1;
}

async function createArticle({ title, link }) {
    const col = getCollection(COLLECTIONS.ARTICLE);
    const id = await getNextArticleId();
    const now = Date.now();
    const doc = { id, title, link, created_at: now, updated_at: now };
    await col.insertOne(doc);
    logger.info(`文章已创建: id=${id}, title=${title}`);
    return doc;
}

async function getAllArticles(sort) {
    const col = getCollection(COLLECTIONS.ARTICLE);
    let sortField = 'updated_at';
    let sortOrder = -1;
    if (sort === 'time_asc') { sortField = 'created_at'; sortOrder = 1; }
    if (sort === 'time_desc') { sortField = 'created_at'; sortOrder = -1; }
    return await col.find({}).sort({ [sortField]: sortOrder }).toArray();
}

async function getArticleById(id) {
    const col = getCollection(COLLECTIONS.ARTICLE);
    return await col.findOne({ id });
}

async function updateArticle(id, updates) {
    const col = getCollection(COLLECTIONS.ARTICLE);
    const setFields = { updated_at: Date.now(), ...updates };
    await col.updateOne({ id }, { $set: setFields });
    logger.info(`文章已更新: id=${id}`);
    return await col.findOne({ id });
}

async function deleteArticle(id) {
    const col = getCollection(COLLECTIONS.ARTICLE);
    const subCol = getCollection(COLLECTIONS.SUB_ARTICLE);
    await subCol.deleteMany({ article_id: id });
    await col.deleteOne({ id });
    logger.info(`文章已删除: id=${id}`);
}

// ==================== 子文章 CRUD ====================

async function createSubArticle({ article_id, title, link }) {
    const col = getCollection(COLLECTIONS.SUB_ARTICLE);
    const id = await getNextSubArticleId();
    const now = Date.now();
    const doc = { id, article_id, title, link, created_at: now, updated_at: now };
    await col.insertOne(doc);
    // 更新文章的 updated_at
    const articleCol = getCollection(COLLECTIONS.ARTICLE);
    await articleCol.updateOne({ id: article_id }, { $set: { updated_at: now } });
    logger.info(`子文章已创建: id=${id}, article_id=${article_id}`);
    return doc;
}

async function getSubArticlesByArticleId(article_id, sort) {
    const col = getCollection(COLLECTIONS.SUB_ARTICLE);
    let sortOrder = -1;
    if (sort === 'time_asc') sortOrder = 1;
    return await col.find({ article_id }).sort({ updated_at: sortOrder }).toArray();
}

async function getSubArticleById(id) {
    const col = getCollection(COLLECTIONS.SUB_ARTICLE);
    return await col.findOne({ id });
}

async function updateSubArticle(id, updates) {
    const col = getCollection(COLLECTIONS.SUB_ARTICLE);
    const now = Date.now();
    const setFields = { updated_at: now, ...updates };
    await col.updateOne({ id }, { $set: setFields });
    // 更新关联文章的 updated_at
    const sub = await col.findOne({ id });
    if (sub) {
        const articleCol = getCollection(COLLECTIONS.ARTICLE);
        await articleCol.updateOne({ id: sub.article_id }, { $set: { updated_at: now } });
    }
    logger.info(`子文章已更新: id=${id}`);
    return await col.findOne({ id });
}

async function deleteSubArticle(id) {
    const col = getCollection(COLLECTIONS.SUB_ARTICLE);
    const sub = await col.findOne({ id });
    await col.deleteOne({ id });
    if (sub) {
        const articleCol = getCollection(COLLECTIONS.ARTICLE);
        await articleCol.updateOne({ id: sub.article_id }, { $set: { updated_at: Date.now() } });
    }
    logger.info(`子文章已删除: id=${id}`);
}

module.exports = {
    createArticle, getAllArticles, getArticleById, updateArticle, deleteArticle,
    createSubArticle, getSubArticlesByArticleId, getSubArticleById, updateSubArticle, deleteSubArticle
};
