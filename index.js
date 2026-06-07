// ============================================
// EDUNEXA PAYNECTA WEBHOOK BACKEND
// Deploy on Render.com
// ============================================

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// SUPABASE CONFIGURATION
// ============================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ============================================
// PAYNECTA CONFIGURATION
// ============================================
const PAYNECTA_API_KEY = process.env.PAYNECTA_API_KEY;
const PAYNECTA_API_URL = process.env.PAYNECTA_API_URL || 'https://api.paynecta.co.ke/v1';

// ============================================
// HEALTH CHECK ENDPOINT
// ============================================
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'EduNexa Paynecta Webhook is running',
        timestamp: new Date().toISOString(),
        endpoints: {
            webhook: 'POST /api/payments/webhook',
            verify: 'POST /api/payments/verify',
            status: 'GET /api/payments/status/:reference',
            health: 'GET /health'
        }
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ============================================
// PAYNECTA WEBHOOK ENDPOINT
// ============================================
app.post('/api/payments/webhook', async (req, res) => {
    console.log('📥 Webhook received:', JSON.stringify(req.body, null, 2));
    
    try {
        const { 
            transaction_reference, 
            status, 
            amount, 
            mpesa_code, 
            phone_number,
            metadata 
        } = req.body;
        
        // Verify webhook signature (if Paynecta provides one)
        const signature = req.headers['x-paynecta-signature'];
        if (process.env.PAYNECTA_WEBHOOK_SECRET && signature) {
            const crypto = require('crypto');
            const expectedSignature = crypto
                .createHmac('sha256', process.env.PAYNECTA_WEBHOOK_SECRET)
                .update(JSON.stringify(req.body))
                .digest('hex');
            
            if (signature !== expectedSignature) {
                console.error('❌ Invalid webhook signature');
                return res.status(401).json({ error: 'Invalid signature' });
            }
        }
        
        if (status === 'completed' || status === 'success') {
            // Update pending payment in database
            const { data: pending, error: findError } = await supabase
                .from('pending_payments')
                .select('*')
                .eq('transaction_ref', transaction_reference)
                .single();
            
            if (findError) {
                console.error('❌ Pending payment not found:', findError);
                return res.status(404).json({ error: 'Transaction not found' });
            }
            
            // Update status to completed
            const { error: updateError } = await supabase
                .from('pending_payments')
                .update({ 
                    status: 'completed', 
                    completed_at: new Date().toISOString() 
                })
                .eq('transaction_ref', transaction_reference);
            
            if (updateError) {
                console.error('❌ Failed to update payment:', updateError);
                return res.status(500).json({ error: 'Database update failed' });
            }
            
            // Add to payments table
            const { error: paymentError } = await supabase
                .from('payments')
                .insert({
                    school_id: pending.school_id,
                    student_name: pending.student_data.name,
                    student_code: pending.student_data.studentCode,
                    amount: pending.amount,
                    mpesa_code: mpesa_code || transaction_reference,
                    status: 'verified',
                    payment_date: new Date().toISOString()
                });
            
            if (paymentError) {
                console.error('❌ Failed to record payment:', paymentError);
            }
            
            console.log(`✅ Payment completed for ${pending.student_data.name}`);
            
            // Optional: Send SMS notification to school
            if (process.env.SMS_API_KEY) {
                await sendSmsNotification(pending.school_id, pending.student_data.name);
            }
            
            res.json({ 
                status: 'success', 
                message: 'Payment verified and student ready for registration',
                transaction: transaction_reference
            });
            
        } else if (status === 'failed' || status === 'cancelled') {
            // Update failed payment
            await supabase
                .from('pending_payments')
                .update({ status: 'failed' })
                .eq('transaction_ref', transaction_reference);
            
            console.log(`❌ Payment failed for ${transaction_reference}`);
            res.json({ status: 'failed', message: 'Payment failed' });
            
        } else {
            console.log(`⏳ Payment pending for ${transaction_reference}`);
            res.json({ status: 'pending', message: 'Waiting for completion' });
        }
        
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// VERIFY PAYMENT ENDPOINT (Called from frontend)
// ============================================
app.post('/api/payments/verify', async (req, res) => {
    const { transaction_code, amount, school_id } = req.body;
    
    console.log(`🔍 Verifying payment: ${transaction_code}`);
    
    try {
        // First check if payment already exists in our database
        const { data: existingPayment } = await supabase
            .from('payments')
            .select('*')
            .eq('mpesa_code', transaction_code)
            .single();
        
        if (existingPayment) {
            return res.json({ 
                verified: true, 
                message: 'Payment already verified',
                payment: existingPayment
            });
        }
        
        // Check pending payments
        const { data: pendingPayment } = await supabase
            .from('pending_payments')
            .select('*')
            .eq('transaction_ref', transaction_code)
            .single();
        
        if (pendingPayment && pendingPayment.status === 'completed') {
            return res.json({ 
                verified: true, 
                message: 'Payment verified',
                amount: pendingPayment.amount
            });
        }
        
        // Verify with Paynecta API
        const response = await axios.get(`${PAYNECTA_API_URL}/payments/${transaction_code}`, {
            headers: {
                'Authorization': `Bearer ${PAYNECTA_API_KEY}`
            }
        });
        
        const paymentData = response.data;
        
        if (paymentData.status === 'completed' && paymentData.amount >= amount) {
            // Payment is valid
            return res.json({
                verified: true,
                message: 'Payment verified successfully',
                transaction: paymentData
            });
        } else {
            return res.json({
                verified: false,
                message: 'Payment not found or amount mismatch'
            });
        }
        
    } catch (error) {
        console.error('❌ Verification error:', error);
        
        // If Paynecta API fails, check local pending payments
        const { data: localPayment } = await supabase
            .from('pending_payments')
            .select('*')
            .eq('transaction_ref', transaction_code)
            .eq('status', 'completed')
            .single();
        
        if (localPayment) {
            return res.json({ verified: true, message: 'Payment verified locally' });
        }
        
        res.json({ verified: false, message: 'Verification failed' });
    }
});

// ============================================
// CHECK PAYMENT STATUS ENDPOINT
// ============================================
app.get('/api/payments/status/:reference', async (req, res) => {
    const { reference } = req.params;
    
    try {
        const { data: payment, error } = await supabase
            .from('pending_payments')
            .select('*')
            .eq('transaction_ref', reference)
            .single();
        
        if (error) {
            return res.json({ status: 'not_found' });
        }
        
        res.json({
            status: payment.status,
            completed_at: payment.completed_at,
            amount: payment.amount
        });
        
    } catch (error) {
        console.error('Status check error:', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ============================================
// INITIATE PAYMENT ENDPOINT (Frontend calls this)
// ============================================
app.post('/api/payments/initiate', async (req, res) => {
    const { 
        amount, 
        phone_number, 
        email, 
        reference, 
        description,
        metadata 
    } = req.body;
    
    console.log(`💰 Initiating payment of KSh ${amount} for ${phone_number}`);
    
    try {
        // Call Paynecta API to initiate STK push
        const response = await axios.post(`${PAYNECTA_API_URL}/payments/stkpush`, {
            amount: amount,
            phone_number: phone_number,
            email: email,
            reference: reference,
            description: description,
            callback_url: `${process.env.BASE_URL}/api/payments/webhook`,
            metadata: metadata
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${PAYNECTA_API_KEY}`
            }
        });
        
        const result = response.data;
        
        if (result.status === 'success') {
            // Store pending payment
            await supabase
                .from('pending_payments')
                .insert({
                    school_id: metadata?.school_id,
                    transaction_ref: reference,
                    student_data: metadata,
                    amount: amount,
                    status: 'pending',
                    created_at: new Date().toISOString()
                });
            
            res.json({
                success: true,
                message: 'STK push sent to phone',
                payment_url: result.payment_url,
                transaction_ref: reference
            });
        } else {
            res.json({
                success: false,
                message: result.message || 'Payment initiation failed'
            });
        }
        
    } catch (error) {
        console.error('Initiate payment error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Payment initiation failed',
            error: error.message
        });
    }
});

// ============================================
// SEND SMS NOTIFICATION (Optional)
// ============================================
async function sendSmsNotification(schoolId, studentName) {
    try {
        // Get school phone number
        const { data: school } = await supabase
            .from('schools')
            .select('phone, name')
            .eq('id', schoolId)
            .single();
        
        if (school && school.phone && process.env.SMS_API_KEY) {
            // Example using Africa's Talking
            await axios.post('https://api.africastalking.com/version1/messaging', {
                username: process.env.SMS_USERNAME,
                to: school.phone,
                message: `Payment received for ${studentName} on EduNexa Pro. Student registration complete.`
            }, {
                headers: {
                    'apiKey': process.env.SMS_API_KEY,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
            console.log(`📱 SMS sent to ${school.phone}`);
        }
    } catch (error) {
        console.error('SMS error:', error.message);
    }
}

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 Webhook URL: https://your-app.onrender.com/api/payments/webhook`);
    console.log(`🔍 Verify URL: https://your-app.onrender.com/api/payments/verify`);
});

module.exports = app;
