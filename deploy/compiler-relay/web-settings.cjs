const stockSettingsPath = '/etc/overleaf/settings.js'
/** @type {{ apis: { clsi?: Record<string, unknown> } & Record<string, unknown> } & Record<string, unknown>} */
const settings = require(stockSettingsPath)
const gateway = 'http://127.0.0.1:37499'

module.exports = {
  ...settings,
  apis: {
    ...settings.apis,
    clsi: {
      ...settings.apis.clsi,
      url: gateway,
      downloadHost: gateway,
    },
  },
}
