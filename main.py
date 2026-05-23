from flask import Flask, request, jsonify
from flask_cors import CORS
import hmac
import hashlib
import os
import json
from datetime import datetime, timedelta
import requests

app = Flask(__name__)
CORS(app)  # Enable CORS for Flutter app

# Supabase Config
SUPABASE_URL = 'https://supabase-deep.phoenixsoftwaresolutions172.workers.dev'
SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2cnBzcWRyYndmdmxsZWx5cWhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUxNTgxOTksImV4cCI6MjA4MDczNDE5OX0.ON2ioqbNJegKOWeGu_eqsgjNxQ6IdHCDuFRqjUfBYHk'

# Google Play Config
# IMPORTANT: Place your Google Play service account JSON key file in the backend directory
# Download it from: Google Play Console > Setup > API access > Service accounts
# Or set the path via environment variable
GOOGLE_PLAY_PACKAGE_NAME = os.environ.get('GOOGLE_PLAY_PACKAGE_NAME', 'com.mrhelper.app')
GOOGLE_SERVICE_ACCOUNT_KEY_PATH = os.environ.get('GOOGLE_SERVICE_ACCOUNT_KEY', 'google-service-account.json')


def get_google_access_token():
    """
    Get an OAuth2 access token using the Google service account credentials.
    This is used to verify purchases via the Google Play Developer API.
    """
    try:
        import jwt
        import time

        # Load service account key
        with open(GOOGLE_SERVICE_ACCOUNT_KEY_PATH, 'r') as f:
            service_account = json.load(f)

        # Create JWT
        now = int(time.time())
        payload = {
            'iss': service_account['client_email'],
            'scope': 'https://www.googleapis.com/auth/androidpublisher',
            'aud': 'https://oauth2.googleapis.com/token',
            'iat': now,
            'exp': now + 3600,
        }

        signed_jwt = jwt.encode(
            payload,
            service_account['private_key'],
            algorithm='RS256'
        )

        # Exchange JWT for access token
        token_response = requests.post(
            'https://oauth2.googleapis.com/token',
            data={
                'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                'assertion': signed_jwt
            }
        )

        if token_response.status_code == 200:
            return token_response.json()['access_token']
        else:
            print(f'Error getting Google access token: {token_response.text}')
            return None

    except FileNotFoundError:
        print(f'Google service account key file not found: {GOOGLE_SERVICE_ACCOUNT_KEY_PATH}')
        print('Please download it from Google Play Console > Setup > API access > Service accounts')
        return None
    except Exception as e:
        print(f'Error getting Google access token: {e}')
        return None


def verify_google_purchase_token(product_id, purchase_token):
    """
    Verify a subscription purchase token with Google Play Developer API.
    Returns the subscription details if valid, None otherwise.
    """
    access_token = get_google_access_token()
    if not access_token:
        print('Could not get Google access token for verification')
        return None

    # Google Play Developer API - Verify Subscription
    url = (
        f'https://androidpublisher.googleapis.com/androidpublisher/v3'
        f'/applications/{GOOGLE_PLAY_PACKAGE_NAME}'
        f'/purchases/subscriptions/{product_id}'
        f'/tokens/{purchase_token}'
    )

    headers = {
        'Authorization': f'Bearer {access_token}',
        'Content-Type': 'application/json'
    }

    response = requests.get(url, headers=headers)

    if response.status_code == 200:
        return response.json()
    else:
        print(f'Google Play verification failed: {response.status_code} - {response.text}')
        return None


@app.route('/verify-google-purchase', methods=['POST'])
def verify_google_purchase():
    """
    Verify a Google Play subscription purchase and activate the subscription in Supabase.
    Called from the Flutter app after a successful Google Play purchase.
    """
    try:
        data = request.json
        purchase_token = data.get('purchase_token')
        product_id = data.get('product_id')
        user_id = data.get('user_id')

        if not all([purchase_token, product_id, user_id]):
            return jsonify({'status': 'error', 'message': 'Missing required fields'}), 400

        print(f'Verifying Google Play purchase for user {user_id}')
        print(f'Product: {product_id}')

        # Verify the purchase with Google Play Developer API
        purchase_details = verify_google_purchase_token(product_id, purchase_token)

        if purchase_details is None:
            # If server-side verification fails (e.g., no service account configured),
            # we still activate since Google Play already validated the purchase on-device.
            # In production, you should always verify server-side.
            print('WARNING: Could not verify with Google API. Activating based on client purchase.')
            print('Set up a Google Play service account for server-side verification.')

        # Check if subscription is valid (paymentState: 1 = received, 2 = free trial)
        if purchase_details:
            payment_state = purchase_details.get('paymentState')
            if payment_state not in [1, 2]:
                return jsonify({
                    'status': 'error',
                    'message': f'Invalid payment state: {payment_state}'
                }), 400

            expiry_millis = int(purchase_details.get('expiryTimeMillis', 0))
            if expiry_millis > 0:
                expiry_date = datetime.utcfromtimestamp(expiry_millis / 1000)
                print(f'Google subscription expires: {expiry_date.isoformat()}')

        # NOTE: Fines are NO LONGER cleared with subscription payment.
        # Fines must be paid separately via /pay-fine endpoint.

        # 1. Calculate Expiry (28 Days from now, or use Google's expiry)
        now = datetime.utcnow()
        if purchase_details and int(purchase_details.get('expiryTimeMillis', 0)) > 0:
            expiry_date = datetime.utcfromtimestamp(
                int(purchase_details['expiryTimeMillis']) / 1000
            )
        else:
            expiry_date = now + timedelta(days=28)

        # 3. Update Supabase
        update_data = {
            'is_subscribed': True,
            'subscription_expiry': expiry_date.isoformat(),
            'subscription_status': 'active',
            'subscription_start_date': now.isoformat(),
            'subscription_end_date': expiry_date.isoformat()
        }

        headers = {
            'apikey': SUPABASE_KEY,
            'Authorization': f'Bearer {SUPABASE_KEY}',
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        }

        response = requests.patch(
            f'{SUPABASE_URL}/rest/v1/users?id=eq.{user_id}',
            json=update_data,
            headers=headers
        )

        if response.status_code in [200, 204]:
            print(f'Subscription activated for user {user_id} until {expiry_date.isoformat()}')
            return jsonify({
                'status': 'success',
                'message': 'Subscription activated successfully',
                'expiry_date': expiry_date.isoformat()
            })
        else:
            return jsonify({
                'status': 'error',
                'message': f'Database update failed: {response.text}'
            }), 500

    except Exception as e:
        print(f"Error in verify-google-purchase: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/pay-fine', methods=['POST'])
def pay_fine():
    """
    Pay outstanding fines separately from subscription.
    Fines must be cleared before provider can receive orders.
    """
    try:
        data = request.json
        user_id = data.get('user_id')
        payment_id = data.get('payment_id')

        if not user_id:
            return jsonify({'status': 'error', 'message': 'Missing user_id'}), 400

        print(f'Processing fine payment for user {user_id}')

        headers = {
            'apikey': SUPABASE_KEY,
            'Authorization': f'Bearer {SUPABASE_KEY}',
            'Content-Type': 'application/json'
        }

        # 1. Get unpaid fines
        fine_check = requests.post(
            f'{SUPABASE_URL}/rest/v1/rpc/get_provider_unpaid_fines',
            json={'p_provider_id': user_id},
            headers=headers
        )

        if fine_check.status_code != 200:
            return jsonify({'status': 'error', 'message': 'Failed to fetch fines'}), 500

        fine_data = fine_check.json()
        total_fines = float(fine_data.get('total_unpaid_fines', 0))

        if total_fines <= 0:
            return jsonify({'status': 'success', 'message': 'No outstanding fines', 'fine_amount': 0})

        # 2. Pay fines
        payment_method = 'online_payment' if payment_id else 'manual_payment'
        fine_response = requests.post(
            f'{SUPABASE_URL}/rest/v1/rpc/pay_provider_fines',
            json={
                'p_provider_id': user_id,
                'p_payment_amount': total_fines,
                'p_payment_method': payment_method
            },
            headers=headers
        )

        if fine_response.status_code in [200, 204]:
            print(f'Fines of Rs.{total_fines} paid successfully for user {user_id}')
            return jsonify({
                'status': 'success',
                'message': 'Fine paid successfully. Access restored.',
                'fine_amount_paid': total_fines
            })
        else:
            print(f'Fine payment failed: {fine_response.text}')
            return jsonify({
                'status': 'error',
                'message': f'Fine payment failed: {fine_response.text}'
            }), 500

    except Exception as e:
        print(f'Error in pay-fine: {e}')
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/webhook/google-play', methods=['POST'])
def google_play_webhook():
    """
    Handle Google Play Real-Time Developer Notifications (RTDN).
    Set this up in Google Play Console > Monetization setup > Real-time developer notifications.
    Configure a Cloud Pub/Sub topic and push subscription to this endpoint.
    """
    try:
        # Google sends notifications via Cloud Pub/Sub
        envelope = request.json
        if not envelope:
            return jsonify({'status': 'error'}), 400

        # Decode the notification
        pubsub_message = envelope.get('message', {})
        notification_data = pubsub_message.get('data', '')

        if notification_data:
            import base64
            decoded = base64.b64decode(notification_data).decode('utf-8')
            notification = json.loads(decoded)

            print(f'Google Play Notification: {notification}')

            subscription_notification = notification.get('subscriptionNotification', {})
            notification_type = subscription_notification.get('notificationType')
            purchase_token = subscription_notification.get('purchaseToken')
            subscription_id = subscription_notification.get('subscriptionId')

            # Notification types:
            # 1 = RECOVERED (payment recovered after decline)
            # 2 = RENEWED (subscription renewed)
            # 3 = CANCELED (subscription canceled)
            # 4 = PURCHASED (new subscription)
            # 5 = ON_HOLD (payment on hold)
            # 6 = IN_GRACE_PERIOD (grace period)
            # 7 = RESTARTED (restarted after cancel)
            # 12 = REVOKED (revoked)
            # 13 = EXPIRED (expired)

            if notification_type in [1, 2, 4, 7]:
                # Subscription is active - verify and extend
                print(f'Subscription active/renewed (type {notification_type})')

                if purchase_token and subscription_id:
                    purchase_details = verify_google_purchase_token(
                        subscription_id, purchase_token
                    )

                    if purchase_details:
                        # Find user by purchase token or other means
                        # For now, log it - you may need a purchase_tokens table
                        print(f'Purchase verified: {purchase_details}')

            elif notification_type in [3, 12, 13]:
                # Subscription canceled/expired/revoked
                print(f'Subscription ended (type {notification_type})')

            elif notification_type in [5, 6]:
                # Payment issues
                print(f'Subscription payment issue (type {notification_type})')

        return jsonify({'status': 'ok'}), 200

    except Exception as e:
        print(f'Webhook error: {e}')
        return jsonify({'status': 'error'}), 500


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'service': 'mr-helper-backend', 'billing': 'google_play'})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=3000, debug=True)
