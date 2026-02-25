require("dotenv").config();
const { fyersModel } = require("fyers-api-v3");

const fyers = new fyersModel({
  path: "./logs",
  enableLogging: true,
});

fyers.setAppId(process.env.APP_ID);
fyers.setRedirectUrl(process.env.REDIRECT_URL);

module.exports = fyers;
