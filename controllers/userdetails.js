
const { StoreOrders, StoreOrderDetails, StoreProducts, StoreUsersBusiness } = require('../models/userrelations');

const getOrdersByCustomerId = async (req, res) => {
    const { customer_id } = req.params;

    try {
        const orders = await StoreOrders.findAll({
            attributes: [
                'order_id',
                'customer_id',
                'vendor_id',
                'address_id',
                'rider_id',
                'vendor_discount',
                'order_amount',
                'order_discount',
                'delivery_charges',
                'order_amount_paid',
                'order_profit',
                'order_payment_type',
                'order_transaction_id',
                'order_payment_status',
                'order_payment_received',
                'order_received_time',
                'order_delivered_time',
                'order_status',
                'order_updated_by'
            ],
            where: {
                customer_id
            },
            include: [
                {
                    model: StoreOrderDetails,
                    attributes: [
                        'order_detail_id',
                        'product_id',
                        'product_qty',
                        'product_mrp',
                        'product_price',
                        'product_discount',
                        'product_total',
                        'product_available'
                    ],
                    include: {
                        model: StoreProducts,
                        attributes: ['product_name']
                    }
                },
                {
                    model: StoreUsersBusiness,
                    attributes: ['business_name']
                }
            ],
        });

        res.status(200).json({ orders });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'An error occurred while fetching the orders' });
    }
};



const createOrder = async (req, res) => {
    const { customer_id, address_id, rider_id, products } = req.body;

    try {

        let orderAmount = 0;
        for (const product of products) {
            const productDetails = await StoreProducts.findByPk(product.product_id);
            if (productDetails) {
                orderAmount += productDetails.product_mrp * product.product_qty;
            }
        }

        const newOrder = await StoreOrders.create({
            customer_id,
            vendor_id: products[0].product_user_id,
            address_id,
            rider_id,
            vendor_discount: 0,
            order_amount: orderAmount,
            order_payment_type: 'COD',
            order_transaction_id: 'CASH',
            order_payment_status: 1,
            order_payment_received: 0,
            order_received_time: new Date(),
            order_status: 1,
            order_updated_by: customer_id,
        });


        for (const product of products) {
            const productDetails = await StoreProducts.findByPk(product.product_id);
            if (productDetails) {
                await StoreOrderDetails.create({
                    order_id: newOrder.order_id,
                    product_id: product.product_id,
                    product_qty: product.product_qty,
                    product_mrp: productDetails.product_mrp,
                    product_price: productDetails.product_price,
                    product_discount: 0,
                    product_total: productDetails.product_mrp * product.product_qty,
                    product_available: productDetails.product_status === 1,
                });
            }
        }

        res.status(201).json({ message: 'Order created successfully', order: newOrder });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error creating order', error: error.message });
    }
};


module.exports = {
    getOrdersByCustomerId,
    createOrder
};