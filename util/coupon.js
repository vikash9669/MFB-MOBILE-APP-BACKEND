const getCouponCodeDetails = (code, orderAmount) => {
  if (code === "DIWALI100") {
    if (orderAmount >= 300) {
      return {
        valid: true,
        success: true,
        discount: 100,
        message: "Congratulations! You've got flat Rs. 100 off",
      };
    }
    return {
      valid: true,
      success: false,
      discount: 0,
      message: "Min. order value should be 300!",
    };
  }
  return {
    valid: false,
    success: false,
    discount: 0,
    message: "Invalid coupon code!",
  };
};

module.exports = {
    getCouponCodeDetails,
};
