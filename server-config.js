function resolveHost(env = process.env) {
  return String(env.FLASHDESK_HOST || '127.0.0.1').trim() || '127.0.0.1';
}

module.exports = { resolveHost };
