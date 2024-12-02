const getCouponCodeDetails = ({ code, orderAmount, platform }) => {
  if (code === "MFBIOS" && platform === "ios") {
    if (orderAmount >= 300) {
      return {
        valid: true,
        success: true,
        discount: 0,
        message: "Congratulations! You've got free delivery!",
        freeDelivery: true,
      };
    }
    return {
      valid: true,
      success: false,
      discount: 0,
      message: "Min. order value should be 300!",
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
