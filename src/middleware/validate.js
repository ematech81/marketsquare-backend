const HttpError = require('../utils/httpError');

// Validates req.body against a zod schema and replaces it with the parsed value.
module.exports = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join('.');
    throw new HttpError(400, field ? `${field}: ${issue.message}` : issue.message);
  }
  req.body = result.data;
  next();
};
