const Sequelize = require("sequelize").Sequelize;

const sequelize = new Sequelize("myfirstbite", "root", "#Wishes12", {
    host: "localhost",
    dialect: "mysql",
});

module.exports = sequelize;