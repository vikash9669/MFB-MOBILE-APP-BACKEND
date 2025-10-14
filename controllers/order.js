const { Op } = require("sequelize");
const axios = require("axios");
const {
  StoreOrders,
  StoreOrderDetails,
  Product,
  Business,
  Address,
  Area,
  User,
} = require("../models");

const { getCouponCodeDetails } = require("../util/coupon");

const getActiveOrders = async (req, res) => {
  const { user_id } = req.user;
  const oneHourAgo = new Date(new Date() - 1 * 60 * 60 * 1000);
  try {
    const order = await StoreOrders.findOne({
      attributes: [
        "order_id",
        "customer_id",
        "vendor_id",
        "address_id",
        "rider_id",
        "vendor_discount",
        "order_amount",
        "order_discount",
        "delivery_charges",
        "order_amount_paid",
        "order_profit",
        "order_payment_type",
        "order_transaction_id",
        "order_payment_status",
        "order_payment_received",
        "order_received_time",
        "order_delivered_time",
        "order_status",
        "order_updated_by",
      ],
      where: {
        order_status: {
          [Op.notIn]: [5, 6],
        },
        customer_id: user_id,
        order_received_time: {
          [Op.gte]: oneHourAgo, // orderReceivedTime is in the last 24 hours
        },
      },
      order: [["order_id", "DESC"]],
      include: [
        {
          model: StoreOrderDetails,
          attributes: [
            "order_detail_id",
            "product_id",
            "product_qty",
            "product_mrp",
            // "product_name",
            "product_price",
            "product_discount",
            "product_total",
            "product_available",
          ],
          include: {
            model: Product,
            attributes: ["product_name"],
          },
        },
        {
          model: Business,
          attributes: ["business_name", "user_id"],
        },
      ],
    });

    if (order == null) {
      res.status(200).json({
        order: null,
        rider: null,
      });
      return;
    }
    const rider = await User.findOne({
      where: {
        user_id: order.rider_id,
      },
    });
    res.status(200).json({
      order,
      rider,
    });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ error: "An error occurred while fetching the orders" });
  }
};

const getOrdersByCustomerId = async (req, res) => {
  const { user_id } = req.user;

  try {
    const orders = await StoreOrders.findAll({
      attributes: [
        "order_id",
        "customer_id",
        "vendor_id",
        "address_id",
        "rider_id",
        "vendor_discount",
        "order_amount",
        "order_discount",
        "delivery_charges",
        "order_amount_paid",
        "order_profit",
        "order_payment_type",
        "order_transaction_id",
        "order_payment_status",
        "order_payment_received",
        "order_received_time",
        "order_delivered_time",
        "order_status",
        "order_updated_by",
      ],
      where: {
        customer_id: user_id,
      },
      order: [["order_received_time", "DESC"]],
      include: [
        {
          model: StoreOrderDetails,
          attributes: [
            "order_detail_id",
            "product_id",
            "product_qty",
            "product_mrp",
            // "product_name",
            "product_price",
            "product_discount",
            "product_total",
            "product_available",
          ],
          include: {
            model: Product,
            attributes: ["product_name"],
          },
        },
        {
          model: Business,
          attributes: ["business_name", "user_id"],
        },
      ],
    });
    res.status(200).json(orders);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ error: "An error occurred while fetching the orders" });
  }
};

const createOrder = async (req, res) => {
  const { user_id } = req.user;
  const {
    address_id,
    product_ids_with_quantity,
    business_user_id,
    coupon_code,
    platform,
  } = req.body;
  const product_ids = Object.keys(product_ids_with_quantity);

  try {
    const productDetails = await Product.findAll({
      where: {
        product_id: product_ids,
      },
    });

    const address = await Address.findByPk(address_id);
    const business = await Business.findOne({
      where: {
        user_id: business_user_id,
      },
    });

    const areaDetails = await Area.findOne({
      where: {
        [Op.and]: [
          { area_id: address.delivery_city },
          { area_user_id: business_user_id },
        ],
      },
    });

    const orderAmount = productDetails.reduce((prev, curr) => {
      return (
        prev + curr.product_mrp * product_ids_with_quantity[curr.product_id]
      );
    }, 0);

    let businessDiscount = 0;

    if (business.business_discount != null && business.business_discount > 0) {
      businessDiscount = Math.floor(
        orderAmount - orderAmount * ((100 - business.business_discount) / 100)
      );
    }

    let rainCharges = 0;
    if (business.business_rain_charges > 0) {
      rainCharges = business.business_rain_charges;
    }

    const couponCodeDetails = getCouponCodeDetails({
      code: coupon_code,
      orderAmount,
      platform,
    });

    const delivery_charges =
      couponCodeDetails.freeDelivery === true ||
      orderAmount >= areaDetails.area_charge_free
        ? 0
        : areaDetails.area_charge;

    const order_discount =
      couponCodeDetails.discount > 0
        ? couponCodeDetails.discount
        : businessDiscount;

    const newOrder = await StoreOrders.create({
      customer_id: user_id,
      vendor_id: business_user_id,
      address_id,
      rider_id: 1,
      vendor_discount: 0,
      order_amount: orderAmount - businessDiscount + rainCharges,
      order_payment_type: "COD",
      order_transaction_id: "CASH",
      order_payment_status: 1,
      order_payment_received: 0,
      order_status: 0,
      order_updated_by: user_id,
      delivery_charges,
      order_discount,
      order_received_time: new Date().getTime() + 5.5 * 60 * 60 * 1000, // IST time
    });

    for (const product of productDetails) {
      const product_qty = product_ids_with_quantity[product.product_id];
      await StoreOrderDetails.create({
        order_id: newOrder.order_id,
        product_id: product.product_id,
        product_qty,
        product_mrp: product.product_mrp,
        product_price: 0,
        product_discount: 0,
        product_total: product.product_mrp * product_qty,
        product_available: 1,
      });
    }

    const orderResponse = await StoreOrders.findOne({
      attributes: [
        "order_id",
        "customer_id",
        "vendor_id",
        "address_id",
        "rider_id",
        "vendor_discount",
        "order_amount",
        "order_discount",
        "delivery_charges",
        "order_amount_paid",
        "order_profit",
        "order_payment_type",
        "order_transaction_id",
        "order_payment_status",
        "order_payment_received",
        "order_received_time",
        "order_delivered_time",
        "order_status",
        "order_updated_by",
      ],
      where: {
        order_id: newOrder.order_id,
      },
      order: [["order_received_time", "DESC"]],
      include: [
        {
          model: StoreOrderDetails,
          attributes: [
            "order_detail_id",
            "product_id",
            "product_qty",
            "product_mrp",
            // "product_name",
            "product_price",
            "product_discount",
            "product_total",
            "product_available",
          ],
          include: {
            model: Product,
            attributes: ["product_name"],
          },
        },
        {
          model: Business,
          attributes: ["business_name", "user_id"],
        },
      ],
    });

    // Fetch user details for sendmailapi call
    const userDetails = await User.findByPk(user_id, {
      attributes: ["user_name", "user_phone"],
    });

    // Call sendmailapi after successful order creation
    try {
      const emailApiPayload = {
        user_name: userDetails.user_name || "Unknown User",
        user_phone: userDetails.user_phone || "0000000000",
        total_amount: orderAmount - businessDiscount + rainCharges + delivery_charges,
        order_id: newOrder.order_id.toString(),
      };

      await axios.post("https://myfirstbite.in/Api/sendmailapi", emailApiPayload, {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 10000, // 10 second timeout
      });

      console.log("Email notification sent successfully for order:", newOrder.order_id);
    } catch (emailError) {
      // Log the error but don't fail the order creation
      console.error("Failed to send email notification:", emailError.message);
    }

    res
      .status(201)
      .json({ message: "Order created successfully", order: orderResponse });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "Error creating order", error: error.message });
  }
};

const getCouponCodeDiscountDetails = (req, res) => {
  const { code, order_amount, platform } = req.body;
  res.status(200).json(
    getCouponCodeDetails({
      code,
      orderAmount: Number(order_amount),
      platform,
    })
  );
};

module.exports = {
  getOrdersByCustomerId,
  createOrder,
  getActiveOrders,
  getCouponCodeDiscountDetails,
};
