// db/getCollection.js
const { getDb } = require('../database');
const COLLECTIONS = require('./collections');

function getCollection(collectionName) {
    const db = getDb();
    return db.collection(collectionName);
}

module.exports = { getCollection, COLLECTIONS };