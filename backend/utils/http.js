function sendError(res, code, message, status = 500) {
  res.status(status).json({ error: { code, message } });
}

module.exports = { sendError };