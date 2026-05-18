const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { RoomServiceClient } = require('livekit-server-sdk');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// LiveKit Configuration
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'your_livekit_api_key';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'your_livekit_api_secret';
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'http://localhost:7880';

// LiveKit Room Service
let roomService = null;
try {
  roomService = new RoomServiceClient(
    LIVEKIT_URL,
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET,
  );
} catch (error) {
  console.log('LiveKit room service not initialized:', error);
}

// Supabase Config
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://supabase-deep.phoenixsoftwaresolutions172.workers.dev';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2cnBzcWRyYndmdmxsZWx5cWhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUxNTgxOTksImV4cCI6MjA4MDczNDE5OX0.ON2ioqbNJegKOWeGu_eqsgjNxQ6IdHCDuFRqjUfBYHk';

// Google Play Config
const GOOGLE_PLAY_PACKAGE_NAME = process.env.GOOGLE_PLAY_PACKAGE_NAME || 'com.mrhelper.app';
const GOOGLE_SERVICE_ACCOUNT_KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || 'google-service-account.json';

// Firebase Admin SDK Initialization
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Production: Base64-encoded service account JSON from env var
    const serviceAccount = JSON.parse(
      Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8')
    );
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('Firebase Admin SDK initialized from env var');
  } else if (fs.existsSync('firebase-service-account.json')) {
    // Local dev: service account JSON file
    const serviceAccount = JSON.parse(fs.readFileSync('firebase-service-account.json', 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('Firebase Admin SDK initialized from local file');
  } else {
    console.warn('⚠️ Firebase Admin SDK NOT initialized: No service account found.');
    console.warn('   Set FIREBASE_SERVICE_ACCOUNT env var (base64) or place firebase-service-account.json locally.');
  }
} catch (firebaseError) {
  console.error('Firebase Admin SDK initialization error:', firebaseError.message);
}

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

// 3. Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'mr-helper-backend', billing: 'google_play' });
});

// 4. Get LiveKit Token (for voice calling)
app.post('/getToken', async (req, res) => {
  try {
    const { roomName, userName } = req.body;

    if (!roomName || !userName) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Missing required fields: roomName and userName' 
      });
    }

    console.log(`Generating LiveKit token for room: ${roomName}, user: ${userName}`);

    // Generate a unique identity for the user in the room
    const identity = `${userName}_${Math.random().toString(36).substring(7)}`;

    // Use AccessToken from livekit-server-sdk for proper token generation
    const { AccessToken } = require('livekit-server-sdk');
    
    const token = new AccessToken(
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET,
      {
        identity: identity,
        name: userName,
      }
    );

    // Add grants for the room
    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishAudio: true,
      canPublishVideo: false, // Audio only for voice calls
    });

    // toJwt() returns a Promise in livekit-server-sdk v2.x — must await
    const jwtToken = await token.toJwt();

    console.log(`Token generated for identity: ${identity}`);

    res.json({ 
      status: 'success', 
      token: jwtToken,
      roomName: roomName,
      identity: identity,
      message: 'Token generated successfully' 
    });
  } catch (error) {
    console.error('Error generating LiveKit token:', error);
    res.status(500).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

// =========================================================
// VOICE CALL NOTIFICATION ENDPOINT
// Sends a DATA-ONLY FCM message so the background handler
// always fires and can show the native CallKit incoming call screen.
// =========================================================
app.post('/sendCallNotification', async (req, res) => {
  try {
    const { calleeId, callerName, orderId, callerId } = req.body;

    if (!calleeId) {
      return res.status(400).json({ error: 'calleeId is required' });
    }

    // Check if Firebase Admin is initialized
    if (!admin.apps.length) {
      console.error('Firebase Admin SDK not initialized');
      return res.status(500).json({ error: 'Firebase Admin not initialized' });
    }

    // First try the new multi-device fcm_tokens table
    let fcmTokens = [];
    const fcmTokensResponse = await fetch(`${SUPABASE_URL}/rest/v1/fcm_tokens?user_id=eq.${calleeId}&select=fcm_token`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    const fcmTokensData = await fcmTokensResponse.json();
    if (fcmTokensData && fcmTokensData.length > 0) {
      fcmTokens = fcmTokensData.map(t => t.fcm_token);
    }

    // Look up callee's FCM token from legacy users table
    const supabaseResponse = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${calleeId}&select=fcm_token,name`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const users = await supabaseResponse.json();
    const calleeName = (users && users.length > 0) ? users[0].name : 'User';

    if (users && users.length > 0 && users[0].fcm_token) {
      if (!fcmTokens.includes(users[0].fcm_token)) {
        fcmTokens.push(users[0].fcm_token);
      }
    }

    if (fcmTokens.length === 0) {
      console.error('FCM token not found for user:', calleeId);
      return res.status(404).json({ error: 'FCM token not found for callee' });
    }

    console.log(`Sending call notification to ${calleeName} (tokens: ${fcmTokens.length})`);

    // Send a DATA-ONLY FCM message (NO 'notification' field)
    // This ensures the background handler ALWAYS fires on Android.
    const message = {
      tokens: fcmTokens,
      data: {
        screen: 'voice_call',
        order_id: orderId || '',
        caller_name: callerName || 'Someone',
        caller_id: callerId || '',
        title: 'Incoming Voice Call',
        body: `${callerName || 'Someone'} is calling you`,
      },
      android: {
        priority: 'high',
        ttl: 30000,
      },
    };

    const fcmResponse = await admin.messaging().sendMulticast(message);
    console.log('✅ FCM call notification sent:', fcmResponse);

    res.json({ success: true, messageId: fcmResponse });
  } catch (error) {
    console.error('❌ Error sending call notification:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to send call rejection back to the caller
app.post('/sendCallRejection', async (req, res) => {
  try {
    const { callerId, orderId } = req.body;

    if (!callerId) {
      return res.status(400).json({ error: 'callerId is required' });
    }

    if (!admin.apps.length) {
      return res.status(500).json({ error: 'Firebase Admin not initialized' });
    }

    // First try the new multi-device fcm_tokens table
    let fcmTokens = [];
    const fcmTokensResponse = await fetch(`${SUPABASE_URL}/rest/v1/fcm_tokens?user_id=eq.${callerId}&select=fcm_token`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    const fcmTokensData = await fcmTokensResponse.json();
    if (fcmTokensData && fcmTokensData.length > 0) {
      fcmTokens = fcmTokensData.map(t => t.fcm_token);
    }

    // Look up caller's FCM token from legacy users table
    const supabaseResponse = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${callerId}&select=fcm_token`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const users = await supabaseResponse.json();
    if (users && users.length > 0 && users[0].fcm_token) {
      if (!fcmTokens.includes(users[0].fcm_token)) {
        fcmTokens.push(users[0].fcm_token);
      }
    }

    if (fcmTokens.length === 0) {
      return res.status(404).json({ error: 'FCM token not found for caller' });
    }

    const message = {
      tokens: fcmTokens,
      data: {
        screen: 'call_rejected',
        order_id: orderId || '',
        title: 'Call Rejected',
        body: 'The recipient declined your call.',
      },
      android: {
        priority: 'high',
      },
    };

    const fcmResponse = await admin.messaging().sendMulticast(message);
    console.log('✅ Call rejection sent:', fcmResponse);
    res.json({ success: true, messageId: fcmResponse });
  } catch (error) {
    console.error('❌ Error sending call rejection:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to send call cancellation (caller hangs up before pickup)
app.post('/sendCallCancellation', async (req, res) => {
  try {
    const { calleeId, orderId } = req.body;

    if (!calleeId) {
      return res.status(400).json({ error: 'calleeId is required' });
    }

    if (!admin.apps.length) {
      return res.status(500).json({ error: 'Firebase Admin not initialized' });
    }

    // First try the new multi-device fcm_tokens table
    let fcmTokens = [];
    const fcmTokensResponse = await fetch(`${SUPABASE_URL}/rest/v1/fcm_tokens?user_id=eq.${calleeId}&select=fcm_token`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    const fcmTokensData = await fcmTokensResponse.json();
    if (fcmTokensData && fcmTokensData.length > 0) {
      fcmTokens = fcmTokensData.map(t => t.fcm_token);
    }

    // Look up callee's FCM token from legacy users table
    const supabaseResponse = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${calleeId}&select=fcm_token`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const users = await supabaseResponse.json();
    if (users && users.length > 0 && users[0].fcm_token) {
      if (!fcmTokens.includes(users[0].fcm_token)) {
        fcmTokens.push(users[0].fcm_token);
      }
    }

    if (fcmTokens.length === 0) {
      return res.status(404).json({ error: 'FCM token not found for callee' });
    }

    const message = {
      tokens: fcmTokens,
      data: {
        screen: 'call_cancelled',
        order_id: orderId || '',
        title: 'Call Cancelled',
        body: 'The caller hung up.',
      },
      android: {
        priority: 'high',
      },
    };

    const fcmResponse = await admin.messaging().sendMulticast(message);
    console.log('✅ Call cancellation sent:', fcmResponse);
    res.json({ success: true, messageId: fcmResponse });
  } catch (error) {
    console.error('❌ Error sending call cancellation:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`LiveKit token endpoint available at: POST /getToken`);
    console.log(`Call notification endpoint at: POST /sendCallNotification`);
});
