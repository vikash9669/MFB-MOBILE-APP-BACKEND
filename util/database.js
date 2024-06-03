const Sequelize = require("sequelize").Sequelize;

const sequelize = new Sequelize("MFB", "root", "root@123", {
  host: "localhost",
  dialect: "mysql",
});

module.exports = sequelize;