const { checkProcedureName } = require('../guards/names');
const { serialiseRecordsets } = require('./serialise');

// Calls a stored procedure and shapes the answer for the web app.
//   single result set:   { rows }          (the first result set; [] if there is none)
//   several result sets: { resultSets }    (all of them, in order)
// `messages` (what the procedure PRINTed) and `returnValue` are for the caller that needs them.
exports.runProcedure = async (database, profileName, name, params, { multi = false } = {}) => {
    checkProcedureName(name);
    const result = await database.callProcedure(profileName, name, params, { multi });
    const sets = serialiseRecordsets(result.recordsets);
    return {
        ...(multi ? { resultSets: sets } : { rows: sets[0] || [] }),
        messages: result.messages || [],
        returnValue: result.returnValue
    };
};
