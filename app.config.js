const config = require('./app.json');

const publicUrl = process.env.PUBLIC_URL || '';

module.exports = {
  ...config.expo,
  experiments: {
    ...(config.expo.experiments || {}),
    baseUrl: publicUrl,
  },
};
