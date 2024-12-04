const MIN_ORDER_AMOUNT = 100;

const getCouponCodeDetails = ({ code, orderAmount, platform }) => {
  if (code?.toLowerCase() === "flash50" && platform === "ios") {
    if (orderAmount >= MIN_ORDER_AMOUNT) {
      return {
        valid: true,
        success: true,
        discount: Math.floor(orderAmount / 2),
        message: "Congratulations! You've got flat 50% off!",
        freeDelivery: false,
      };
    }
    return {
      valid: true,
      success: false,
      discount: 0,
      message: `Min. order value should be ${MIN_ORDER_AMOUNT}!`,
      freeDelivery: false,
    };
  }
  return {
    valid: false,
    success: false,
    discount: 0,
    message: "Invalid coupon code!",
    freeDelivery: false,
  };
};

module.exports = {
  getCouponCodeDetails,
};
