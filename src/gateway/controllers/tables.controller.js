const { readRows, insertRow, updateRows, deleteRows } = require('../db/table-service');

// ctx: { config, database }
exports.createTablesController = ({ config, database }) => {
    const { limits } = config;
    return {
        read: async (req, res) => {
            res.json(await readRows(database, req.apiProfileName, req.params.table, req.query, limits));
        },
        insert: async (req, res) => {
            res.status(201).json(await insertRow(database, req.apiProfileName, req.params.table, req.body, req.query));
        },
        update: async (req, res) => {
            res.json(await updateRows(database, req.apiProfileName, req.params.table, req.query, req.body, limits));
        },
        remove: async (req, res) => {
            res.json(await deleteRows(database, req.apiProfileName, req.params.table, req.query, limits));
        }
    };
};
