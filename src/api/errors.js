// One error shape for the new routes: { error: { code, message, step? } }.
class ApiError extends Error {
    constructor(status, code, message, extra = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.extra = extra;
    }
}

const errorBody = (code, message, extra = {}) => ({ error: { code, message, ...extra } });

// Last handler of the new router. Unexpected errors answer a generic 500 and are
// logged with the request id; request bodies and query values are never logged.
const errorHandler = (log) => (err, req, res, next) => {
    if (res.headersSent) return next(err);

    let status = 500;
    let code = 'internal';
    let message = 'An unexpected error occurred.';
    let extra = {};

    if (err instanceof ApiError) {
        ({ status, code, message, extra } = err);
    } else if (err.type === 'entity.too.large') {
        status = 413;
        code = 'too_large';
        message = 'The request body is too large.';
    } else if (err.type === 'entity.parse.failed') {
        status = 400;
        code = 'bad_request';
        message = 'The request body is not valid JSON.';
    } else if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
        status = 400;
        code = 'bad_request';
        message = 'The request could not be read.';
    } else {
        log.error(`[api] ${req.id} unexpected error: ${err.stack || err}`);
    }

    res.status(status).json(errorBody(code, message, extra));
};

module.exports = { ApiError, errorBody, errorHandler };
