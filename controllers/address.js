const { Location, Address } = require("../models");

const createAddress = async (req, res) => {
  try {
    const addressData = {
      ...req.body,
      customer_id: req.user.user_id,
    };

    const address = await Address.create(addressData);
    res.status(201).json(address);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const findAllByUser = async (req, res) => {
  try {
    const addresses = await Address.findAll({
      where: { customer_id: req.user.user_id },
      include: [{ model: Location, as: "location" }],
    });
    res.status(200).json(addresses);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const updateAddress = async (req, res) => {
  const { delivery_id } = req.params;
  const {
    delivery_address,
    delivery_landmark,
    delivery_phone,
    delivery_pin,
    delivery_city,
    delivery_state,
    delivery_status,
  } = req.body;

  try {
    const address = await Address.findByPk(delivery_id);

    if (!address) {
      return res.status(404).json({ error: "Address not found" });
    }

    address.delivery_address = delivery_address || address.delivery_address;
    address.delivery_landmark = delivery_landmark || address.delivery_landmark;
    address.delivery_phone = delivery_phone || address.delivery_phone;
    address.delivery_pin = delivery_pin || address.delivery_pin;
    address.delivery_city = delivery_city || address.delivery_city;
    address.delivery_state = delivery_state || address.delivery_state;
    address.delivery_status = delivery_status || address.delivery_status;

    await address.save();

    res.status(200).json({ message: "Address updated successfully", address });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ error: "An error occurred while updating the address" });
  }
};

const deleteAddress = async (req, res) => {
  const { delivery_id } = req.params;

  try {
    const address = await Address.findByPk(delivery_id);

    if (!address) {
      return res.status(404).json({ error: "Address not found" });
    }

    await address.destroy();

    res.status(200).json({ message: "Address deleted successfully" });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ error: "An error occurred while deleting the address" });
  }
};

module.exports = {
  createAddress,
  findAllByUser,
  updateAddress,
  deleteAddress,
};
