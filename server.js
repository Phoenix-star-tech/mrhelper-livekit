const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const { AccessToken } = require('livekit-server-sdk');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Supabase Config
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://supabase-deep.phoenixsoftwaresolutions172.workers.dev';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2cnBzcWRyYndmdmxsZWx5cWhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUxNTgxOTksImV4cCI6MjA4MDczNDE5OX0.ON2ioqbNJegKOWeGu_eqsgjNxQ6IdHCDuFRqjUfBYHk';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Google Play Config
const GOOGLE_PLAY_PACKAGE_NAME = process.env.GOOGLE_PLAY_PACKAGE_NAME || 'com.mrhelper.app';
const GOOGLE_SERVICE_ACCOUNT_KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || 'google-service-account.json';

/**
 * Get an OAuth2 access token using Google service account credentials.
 * Used to verify purchases via the Google Play Developer API.
 */
async function getGoogleAccessToken() {
    try {
        let serviceAccount;
        try {
            const keyFile = fs.readFileSync(GOOGLE_SERVICE_ACCOUNT_KEY_PATH, 'utf-8');
            serviceAccount = JSON.parse(keyFile);
        } catch (e) {
            console.log('Google service account key file not found:', GOOGLE_SERVICE_ACCOUNT_KEY_PATH);
            console.log('Please download it from Google Play Console > Setup > API access > Service accounts');
            return null;
        }

        const now = Math.floor(Date.now() / 1000);
        const payload = {
            iss: serviceAccount.client_email,
            scope: 'https://www.googleapis.com/auth/androidpublisher',
            aud: 'https://oauth2.googleapis.com/token',
            iat: now,
            exp: now + 3600,
        };

        const signedJwt = jwt.sign(payload, serviceAccount.private_key, { algorithm: 'RS256' });

        const response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedJwt}`
        });

        if (response.ok) {
            const data = await response.json();
            return data.access_token;
        } else {
            console.error('Error getting Google access token:', await response.text());
            return null;
        }
    } catch (e) {
        console.error('Error getting Google access token:', e);
        return null;
    }
}

/**
 * Verify a subscription purchase token with Google Play Developer API.
 */
async function verifyGooglePurchaseToken(productId, purchaseToken) {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) {
        console.log('Could not get Google access token for verification');
        return null;
    }

    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${GOOGLE_PLAY_PACKAGE_NAME}/purchases/subscriptions/${productId}/tokens/${purchaseToken}`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        }
    });

    if (response.ok) {
        return await response.json();
    } else {
        console.error('Google Play verification failed:', response.status, await response.text());
        return null;
    }
}

// 1. Verify Google Play Purchase
app.post('/verify-google-purchase', async (req, res) => {
    try {
        const { purchase_token, product_id, user_id } = req.body;

        if (!purchase_token || !product_id || !user_id) {
            return res.status(400).json({ status: 'error', message: 'Missing required fields' });
        }

        console.log(`Verifying Google Play purchase for user ${user_id}`);
        console.log(`Product: ${product_id}`);

        // Verify the purchase with Google Play Developer API
        const purchaseDetails = await verifyGooglePurchaseToken(product_id, purchase_token);

        if (!purchaseDetails) {
            console.log('WARNING: Could not verify with Google API. Activating based on client purchase.');
            console.log('Set up a Google Play service account for server-side verification.');
        }

        // Check if subscription is valid
        if (purchaseDetails) {
            const paymentState = purchaseDetails.paymentState;
            if (paymentState !== 1 && paymentState !== 2) {
                return res.status(400).json({
                    status: 'error',
                    message: `Invalid payment state: ${paymentState}`
                });
            }
        }

        // NOTE: Fines are NO LONGER cleared with subscription payment.
        // Fines must be paid separately via /pay-fine endpoint.

        // 1. Calculate Expiry
        const now = new Date();
        let expiryDate;

        if (purchaseDetails && purchaseDetails.expiryTimeMillis) {
            expiryDate = new Date(parseInt(purchaseDetails.expiryTimeMillis));
        } else {
            expiryDate = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000); // 28 days
        }

        // 3. Update Supabase
        const updateData = {
            is_subscribed: true,
            subscription_expiry: expiryDate.toISOString(),
            subscription_status: 'active',
            subscription_start_date: now.toISOString(),
            subscription_end_date: expiryDate.toISOString()
        };

        const updateHeaders = {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        };

        const updateResponse = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${user_id}`, {
            method: 'PATCH',
            headers: updateHeaders,
            body: JSON.stringify(updateData)
        });

        if (updateResponse.ok) {
            console.log(`Subscription activated for user ${user_id} until ${expiryDate.toISOString()}`);
            res.json({
                status: 'success',
                message: 'Subscription activated successfully',
                expiry_date: expiryDate.toISOString()
            });
        } else {
            res.status(500).json({
                status: 'error',
                message: `Database update failed: ${await updateResponse.text()}`
            });
        }

    } catch (error) {
        console.error('Error in verify-google-purchase:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// 2. Pay Fine Endpoint (Separate from subscription)
app.post('/pay-fine', async (req, res) => {
    try {
        const { user_id, payment_id } = req.body;

        if (!user_id) {
            return res.status(400).json({ status: 'error', message: 'Missing user_id' });
        }

        console.log(`Processing fine payment for user ${user_id}`);

        const headers = {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json'
        };

        // 1. Get unpaid fines
        const fineCheck = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_provider_unpaid_fines`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ p_provider_id: user_id })
        });

        if (!fineCheck.ok) {
            return res.status(500).json({ status: 'error', message: 'Failed to fetch fines' });
        }

        const fineData = await fineCheck.json();
        const totalFines = parseFloat(fineData.total_unpaid_fines || 0);

        if (totalFines <= 0) {
            return res.json({ status: 'success', message: 'No outstanding fines', fine_amount: 0 });
        }

        // 2. Pay fines
        const fineResponse = await fetch(`${SUPABASE_URL}/rest/v1/rpc/pay_provider_fines`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                p_provider_id: user_id,
                p_payment_amount: totalFines,
                p_payment_method: payment_id ? 'online_payment' : 'manual_payment'
            })
        });

        if (fineResponse.ok) {
            console.log(`Fines of Rs.${totalFines} paid successfully for user ${user_id}`);
            res.json({
                status: 'success',
                message: 'Fine paid successfully. Access restored.',
                fine_amount_paid: totalFines
            });
        } else {
            const errText = await fineResponse.text();
            console.log(`Fine payment failed: ${errText}`);
            res.status(500).json({ status: 'error', message: `Fine payment failed: ${errText}` });
        }

    } catch (error) {
        console.error('Error in pay-fine:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// 3. Google Play Webhook (Real-Time Developer Notifications)
app.post('/webhook/google-play', (req, res) => {
    try {
        const envelope = req.body;
        if (!envelope) {
            return res.status(400).json({ status: 'error' });
        }

        const pubsubMessage = envelope.message || {};
        const notificationData = pubsubMessage.data || '';

        if (notificationData) {
            const decoded = Buffer.from(notificationData, 'base64').toString('utf-8');
            const notification = JSON.parse(decoded);

            console.log('Google Play Notification:', JSON.stringify(notification));

            const subscriptionNotification = notification.subscriptionNotification || {};
            const notificationType = subscriptionNotification.notificationType;
            const purchaseToken = subscriptionNotification.purchaseToken;
            const subscriptionId = subscriptionNotification.subscriptionId;

            // Notification types:
            // 1 = RECOVERED, 2 = RENEWED, 3 = CANCELED, 4 = PURCHASED
            // 5 = ON_HOLD, 6 = IN_GRACE_PERIOD, 7 = RESTARTED
            // 12 = REVOKED, 13 = EXPIRED

            if ([1, 2, 4, 7].includes(notificationType)) {
                console.log(`Subscription active/renewed (type ${notificationType})`);
            } else if ([3, 12, 13].includes(notificationType)) {
                console.log(`Subscription ended (type ${notificationType})`);
            } else if ([5, 6].includes(notificationType)) {
                console.log(`Subscription payment issue (type ${notificationType})`);
            }
        }

        res.json({ status: 'ok' });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ status: 'error' });
    }
});

// LiveKit Config
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://mr-helper-t6v5dsu9.livekit.cloud';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'APIP2CezGzUaWU2';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'M00bbcggOQ9bLRA81y8793QAsedGAemXeT8o6UAgvYZA';

// Initialize Firebase Admin SDK
// Supports: FIREBASE_SERVICE_ACCOUNT (Base64 or raw JSON), FIREBASE_SERVICE_ACCOUNT_JSON, or file fallback
try {
    let serviceAccount;

    // 1. Try FIREBASE_SERVICE_ACCOUNT env var (Base64-encoded or raw JSON)
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            const val = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
            if (val.startsWith('{')) {
                serviceAccount = JSON.parse(val);
            } else {
                const decoded = Buffer.from(val, 'base64').toString('utf8');
                serviceAccount = JSON.parse(decoded);
            }
            console.log('Loaded Firebase credentials from FIREBASE_SERVICE_ACCOUNT env var.');
        } catch (e) {
            console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT env var:', e.message);
        }
    }

    // 2. Fallback: FIREBASE_SERVICE_ACCOUNT_JSON env var (raw JSON)
    if (!serviceAccount && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        try {
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
            console.log('Loaded Firebase credentials from FIREBASE_SERVICE_ACCOUNT_JSON env var.');
        } catch (e) {
            console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON env var:', e.message);
        }
    }

    // 3. Fallback: physical file on disk
    if (!serviceAccount && fs.existsSync(GOOGLE_SERVICE_ACCOUNT_KEY_PATH)) {
        try {
            const fileContent = fs.readFileSync(GOOGLE_SERVICE_ACCOUNT_KEY_PATH, 'utf-8');
            serviceAccount = JSON.parse(fileContent);
            console.log('Loaded Firebase credentials from file:', GOOGLE_SERVICE_ACCOUNT_KEY_PATH);
        } catch (e) {
            console.error('Failed to parse service account file:', e.message);
        }
    }

    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('Firebase Admin SDK initialized successfully.');
    } else {
        console.warn('WARNING: Firebase Service Account Key not found. Push notifications will fail.');
    }
} catch (error) {
    console.error('Error initializing Firebase Admin:', error);
}

/**
 * Generate LiveKit token for a user joining a room
 */
async function generateLiveKitToken(roomName, identity, userName) {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: identity,
        name: userName,
    });
    at.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
    });
    return await at.toJwt();
}

/**
 * Helper to send FCM Push Notification
 */
async function sendFCMNotification(token, dataPayload) {
    if (!admin.apps.length) {
        console.warn('FCM not initialized. Skipping push.');
        return false;
    }
    
    const message = {
        token: token,
        data: dataPayload,
        android: {
            priority: 'high',
            ttl: 0,
        },
        apns: {
            headers: {
                'apns-priority': '10',
                'apns-push-type': 'background',
            },
            payload: {
                aps: {
                    contentAvailable: true,
                }
            }
        }
    };

    try {
        const response = await admin.messaging().send(message);
        console.log('FCM Notification sent successfully:', response);
        return true;
    } catch (error) {
        console.error('Error sending FCM notification:', error);
        return false;
    }
}

/**
 * Helper to query all active FCM tokens for a user
 */
async function getUserFCMTokens(userId) {
    try {
        const { data, error } = await supabase
            .from('user_fcm_tokens')
            .select('fcm_token')
            .eq('user_id', userId)
            .eq('is_active', true);
            
        if (error) {
            console.error('Supabase query error for FCM tokens:', error);
            return [];
        }
        
        const tokens = data.map(row => row.fcm_token);
        
        if (tokens.length === 0) {
            const { data: userRecord, error: userError } = await supabase
                .from('users')
                .select('fcm_token')
                .eq('id', userId)
                .single();
                
            if (!userError && userRecord && userRecord.fcm_token) {
                tokens.push(userRecord.fcm_token);
            }
        }
        
        return tokens;
    } catch (e) {
        console.error('Error getting FCM tokens:', e);
        return [];
    }
}

// ==========================================
// VOICE CALLING API ENDPOINTS
// ==========================================

app.post('/startCall', async (req, res) => {
    try {
        const { callerId, receiverId, roomId, callerName, receiverFCMToken } = req.body;

        if (!callerId || !receiverId || !roomId || !callerName) {
            return res.status(400).json({ status: 'error', message: 'Missing required parameters' });
        }

        console.log(`[Call API] StartCall from ${callerName} to receiver ${receiverId}`);

        const token = await generateLiveKitToken(roomId, callerId, callerName);

        const { data: receiverProfile } = await supabase
            .from('users')
            .select('full_name, avatar_url')
            .eq('id', receiverId)
            .single();

        const receiverName = receiverProfile ? receiverProfile.full_name : 'User';
        const receiverAvatar = receiverProfile ? receiverProfile.avatar_url : '';

        const { data: callerProfile } = await supabase
            .from('users')
            .select('avatar_url')
            .eq('id', callerId)
            .single();
        const callerAvatar = callerProfile ? callerProfile.avatar_url : '';

        let orderId = null;
        if (roomId.startsWith('room_')) {
            const parsedId = roomId.replace('room_', '');
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (uuidRegex.test(parsedId)) {
                orderId = parsedId;
            }
        }

        const { data: callHistory, error: dbError } = await supabase
            .from('call_history')
            .insert({
                order_id: orderId,
                caller_id: callerId,
                receiver_id: receiverId,
                status: 'ringing',
                duration: 0
            })
            .select()
            .single();

        if (dbError) {
            console.error('Error inserting call history record:', dbError);
        }
        
        const callId = callHistory ? callHistory.id : crypto.randomUUID();

        const payload = {
            type: 'incoming_call',
            callId: callId,
            callerId: callerId,
            callerName: callerName,
            callerAvatar: callerAvatar || '',
            roomId: roomId,
            receiverId: receiverId,
            orderId: orderId || ''
        };

        let targetTokens = await getUserFCMTokens(receiverId);
        if (targetTokens.length === 0 && receiverFCMToken) {
            targetTokens.push(receiverFCMToken);
        }

        let notificationSent = false;
        if (targetTokens.length > 0) {
            const sendPromises = targetTokens.map(fcmToken => sendFCMNotification(fcmToken, payload));
            const results = await Promise.all(sendPromises);
            notificationSent = results.some(r => r === true);
        }

        res.json({
            status: 'success',
            message: 'Call initialized successfully',
            token: token,
            callId: callId,
            roomId: roomId,
            livekitUrl: LIVEKIT_URL,
            notificationSent: notificationSent,
            receiverName: receiverName,
            receiverAvatar: receiverAvatar
        });

    } catch (error) {
        console.error('Error in /startCall:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.post('/getToken', async (req, res) => {
    try {
        const { userId, roomId, userName } = req.body;

        if (!userId || !roomId || !userName) {
            return res.status(400).json({ status: 'error', message: 'Missing parameters' });
        }

        const token = await generateLiveKitToken(roomId, userId, userName);

        const { data: activeCall } = await supabase
            .from('call_history')
            .select('id')
            .eq('receiver_id', userId)
            .eq('status', 'ringing')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (activeCall) {
            await supabase
                .from('call_history')
                .update({ status: 'connected' })
                .eq('id', activeCall.id);
        }

        res.json({
            status: 'success',
            token: token,
            livekitUrl: LIVEKIT_URL,
            callId: activeCall ? activeCall.id : null
        });

    } catch (error) {
        console.error('Error in /getToken:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.post('/rejectCall', async (req, res) => {
    try {
        const { roomId, callId, rejectedBy } = req.body;

        if (!roomId || !rejectedBy) {
            return res.status(400).json({ status: 'error', message: 'Missing parameters' });
        }

        let targetCallId = callId;
        let callerId = null;

        if (targetCallId) {
            const { data: updatedCall } = await supabase
                .from('call_history')
                .update({ status: 'rejected', ended_at: new Date().toISOString() })
                .eq('id', targetCallId)
                .select('caller_id')
                .single();

            if (updatedCall) {
                callerId = updatedCall.caller_id;
            }
        } else {
            const { data: activeCall } = await supabase
                .from('call_history')
                .select('*')
                .eq('status', 'ringing')
                .order('created_at', { ascending: false })
                .limit(1)
                .single();

            if (activeCall) {
                targetCallId = activeCall.id;
                callerId = activeCall.caller_id;
                await supabase
                    .from('call_history')
                    .update({ status: 'rejected', ended_at: new Date().toISOString() })
                    .eq('id', activeCall.id);
            }
        }

        if (callerId) {
            const callerTokens = await getUserFCMTokens(callerId);
            const payload = {
                type: 'call_rejected',
                roomId: roomId,
                callId: targetCallId || '',
                rejectedBy: rejectedBy
            };

            if (callerTokens.length > 0) {
                await Promise.all(callerTokens.map(token => sendFCMNotification(token, payload)));
            }
        }

        res.json({ status: 'success', message: 'Call rejection processed' });

    } catch (error) {
        console.error('Error in /rejectCall:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.post('/endCall', async (req, res) => {
    try {
        const { roomId, callId, endedBy, duration } = req.body;

        if (!roomId || !endedBy) {
            return res.status(400).json({ status: 'error', message: 'Missing parameters' });
        }

        const callDuration = parseInt(duration || 0);

        let targetCallId = callId;
        let callerId = null;
        let receiverId = null;

        if (targetCallId) {
            const { data: updatedCall } = await supabase
                .from('call_history')
                .update({ 
                    status: 'completed', 
                    duration: callDuration,
                    ended_at: new Date().toISOString() 
                })
                .eq('id', targetCallId)
                .select('caller_id, receiver_id')
                .single();

            if (updatedCall) {
                callerId = updatedCall.caller_id;
                receiverId = updatedCall.receiver_id;
            }
        } else {
            const { data: activeCall } = await supabase
                .from('call_history')
                .select('*')
                .in('status', ['connected', 'ringing'])
                .order('created_at', { ascending: false })
                .limit(1)
                .single();

            if (activeCall) {
                targetCallId = activeCall.id;
                callerId = activeCall.caller_id;
                receiverId = activeCall.receiver_id;
                await supabase
                    .from('call_history')
                    .update({ 
                        status: 'completed', 
                        duration: callDuration,
                        ended_at: new Date().toISOString() 
                    })
                    .eq('id', activeCall.id);
            }
        }

        const otherUserId = (endedBy === callerId) ? receiverId : callerId;

        if (otherUserId) {
            const otherUserTokens = await getUserFCMTokens(otherUserId);
            const payload = {
                type: 'call_ended',
                roomId: roomId,
                callId: targetCallId || '',
                endedBy: endedBy,
                duration: callDuration.toString()
            };

            if (otherUserTokens.length > 0) {
                await Promise.all(otherUserTokens.map(token => sendFCMNotification(token, payload)));
            }
        }

        res.json({ status: 'success', message: 'Call ended processed successfully' });

    } catch (error) {
        console.error('Error in /endCall:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// 3. Health Check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'mr-helper-backend', billing: 'google_play' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
