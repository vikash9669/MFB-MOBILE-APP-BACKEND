const express = require('express');
const addressController = require("../controllers/address");

const router = express.Router();


router.post('/address', addressController.createAddress);

router.get('/address/:user_id', addressController.findAllByUser);

router.put('/address/:delivery_id', addressController.updateAddress);

router.delete('/address/:delivery_id', addressController.deleteAddress);

module.exports = router;

