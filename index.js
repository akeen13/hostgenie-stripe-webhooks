require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Ensure this is the service_role key
const supabase = createClient(supabaseUrl, supabaseKey);

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

const app = express();
const PORT = process.env.PORT || 3003;

// Health check route
app.get('/', (req, res) => {
  res.status(200).send('Stripe Webhook Service is running.');
});

// Stripe requires the raw body to construct the event
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  // Log immediately upon receiving a request to /webhook
  console.log(`!!! POST request to /webhook received at ${new Date().toISOString()} !!!`);
  console.log('Request Headers:', JSON.stringify(req.headers, null, 2)); // Log all headers

  const sig = req.headers['stripe-signature'];
  let event;

  // Enhanced logging for debugging signature verification
  console.log('Attempting to process Stripe Webhook Request:'); // Changed log message slightly
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Raw Body Type:', typeof req.body);
  if (Buffer.isBuffer(req.body)) {
    console.log('Raw Body Length:', req.body.length);
    console.log('Raw Body (first 256 chars):', req.body.toString('utf8', 0, 256));
  } else {
    console.log('Raw Body (unexpected type):', req.body);
  }
  console.log('Signature Header:', sig);
  console.log('Endpoint Secret (first 10 chars):', endpointSecret ? endpointSecret.substring(0, 10) + '...' : 'Not Set!');


  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error(`⚠️ Webhook signature verification failed.`, err.message);
    console.error('Error details:', err); // Log the full error object
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const data = event.data.object;
  const eventType = event.type;

  console.log(`🔔 Received event: ${eventType}`, data.id);

  try {
    switch (eventType) {
      case 'checkout.session.completed': {
        const session = data;
        // Ensure metadata exists and contains the required fields
        const userId = session.metadata?.user_id || session.client_reference_id;
        const propertyId = session.metadata?.property_id;
        const stripeCustomerId = session.customer;
        const stripeSubscriptionId = session.subscription;

        if (!userId || !propertyId || !stripeCustomerId || !stripeSubscriptionId) {
          console.error('Missing metadata (userId, propertyId) or customer/subscription ID in checkout.session.completed. Metadata:', session.metadata);
          return res.status(400).send('Missing required data in session.');
        }
        
        const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
        const stripeProductId = subscription.items.data[0]?.price?.product;
        const stripePriceId = subscription.items.data[0]?.price?.id;
        const internalTier = getInternalTierFromPriceId(stripePriceId);

        // 1. Update profiles table with stripe_customer_id if not already set
        const { error: profileError } = await supabase
          .from('profiles')
          .update({ stripe_customer_id: stripeCustomerId })
          .eq('id', userId)
          .is('stripe_customer_id', null); 
        if (profileError) console.error('Error updating profile with customer ID:', profileError.message);
        
        // 2. Create a new record in 'subscriptions'
        const { data: newSubscription, error: subError } = await supabase
          .from('subscriptions')
          .insert({
            user_id: userId,
            stripe_customer_id: stripeCustomerId,
            stripe_subscription_id: stripeSubscriptionId,
            stripe_product_id: stripeProductId,
            stripe_price_id: stripePriceId,
            status: subscription.status,
            tier: internalTier,
            current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            cancel_at_period_end: subscription.cancel_at_period_end,
            metadata: subscription.metadata,
          })
          .select()
          .single();

        if (subError) {
            console.error('Error inserting into subscriptions:', subError.message);
            throw subError;
        }
        if (!newSubscription) {
            console.error('Failed to create new subscription record, newSubscription is null.');
            throw new Error('Failed to create new subscription record.');
        }


        // 3. Create a new record in 'property_subscriptions'
        const { error: propSubError } = await supabase
          .from('property_subscriptions')
          .insert({
            property_id: propertyId,
            subscription_id: newSubscription.id, // Use the ID from the newly inserted subscription
            is_active: true,
          });
        if (propSubError) {
            console.error('Error inserting into property_subscriptions:', propSubError.message);
            throw propSubError;
        }
        
        // 4. (Optional for compatibility) Update properties.subscription JSONB
        await updatePropertiesSubscriptionJson(supabase, propertyId, internalTier, subscription.status, new Date(subscription.current_period_end * 1000));
        console.log(`Subscription ${stripeSubscriptionId} created and linked for property ${propertyId}`);
        break;
      }
      case 'customer.subscription.updated': {
        const subscription = data;
        const stripeSubscriptionId = subscription.id;
        const stripeProductId = subscription.items.data[0]?.price?.product;
        const stripePriceId = subscription.items.data[0]?.price?.id;
        const internalTier = getInternalTierFromPriceId(stripePriceId);

        const { error: updateError } = await supabase
          .from('subscriptions')
          .update({
            status: subscription.status,
            stripe_product_id: stripeProductId,
            stripe_price_id: stripePriceId,
            tier: internalTier,
            current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            cancel_at_period_end: subscription.cancel_at_period_end,
            canceled_at: subscription.canceled_at ? new Date(subscription.canceled_at * 1000).toISOString() : null,
            ended_at: subscription.ended_at ? new Date(subscription.ended_at * 1000).toISOString() : null,
            metadata: subscription.metadata,
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_subscription_id', stripeSubscriptionId);
        if (updateError) {
            console.error('Error updating subscriptions table:', updateError.message);
            throw updateError;
        }

        // Find the property_id associated with this subscription to update properties.subscription
        const { data: subDataForPropUpdate, error: subPropError } = await supabase
            .from('subscriptions')
            .select(`
                id,
                property_subscriptions(property_id)
            `)
            .eq('stripe_subscription_id', stripeSubscriptionId)
            .single();

        if (subPropError) console.error('Error fetching subscription for property_id lookup:', subPropError.message);
        
        const propertyIdToUpdate = subDataForPropUpdate?.property_subscriptions[0]?.property_id;

        if (propertyIdToUpdate) {
             await updatePropertiesSubscriptionJson(supabase, propertyIdToUpdate, internalTier, subscription.status, new Date(subscription.current_period_end * 1000));
        } else {
            console.warn(`Could not find property_id for subscription ${stripeSubscriptionId} to update properties.subscription`);
        }
        console.log(`Subscription ${stripeSubscriptionId} updated.`);
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = data;
        const stripeSubscriptionId = subscription.id;
        
        const { data: subData, error: subSelectError } = await supabase
            .from('subscriptions')
            .select(`
                id, 
                tier,
                property_subscriptions(property_id)
            `)
            .eq('stripe_subscription_id', stripeSubscriptionId)
            .single();

        if (subSelectError || !subData) { 
            console.error(`Subscription ${stripeSubscriptionId} not found for deletion. Error:`, subSelectError?.message); 
            break; 
        }

        const { error: updateError } = await supabase
          .from('subscriptions')
          .update({
            status: 'canceled', // Or 'deleted'
            ended_at: new Date(subscription.ended_at ? subscription.ended_at * 1000 : Date.now()).toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_subscription_id', stripeSubscriptionId);
        if (updateError) {
            console.error('Error updating subscriptions table for deletion:', updateError.message);
            throw updateError;
        }

        const { error: propSubError } = await supabase
          .from('property_subscriptions')
          .update({ is_active: false, unlinked_at: new Date().toISOString() })
          .eq('subscription_id', subData.id);
        if (propSubError) console.error('Error deactivating property_subscription:', propSubError.message);
        
        const propertyIdToUpdate = subData.property_subscriptions[0]?.property_id;
        if (propertyIdToUpdate) {
            await updatePropertiesSubscriptionJson(supabase, propertyIdToUpdate, subData.tier, 'canceled', new Date());
        } else {
            console.warn(`Could not find property_id for subscription ${stripeSubscriptionId} to update properties.subscription on deletion.`);
        }
        console.log(`Subscription ${stripeSubscriptionId} deleted.`);
        break;
      }
      // TODO: Add cases for 'invoice.payment_succeeded', 'invoice.payment_failed'
      default:
        console.log(`Unhandled event type ${eventType}`);
    }
  } catch (err) {
    console.error('Error processing webhook event:', err.message, err.stack);
    return res.status(500).send(`Webhook processing error: ${err.message}`);
  }

  res.status(200).json({ received: true });
});

// Helper function to map Stripe Price ID to your internal plan names
function getInternalTierFromPriceId(priceId) {
  if (!priceId) return 'free'; // Or handle as an error
  if (priceId === process.env.STRIPE_PRICE_BASIC) return 'basic';
  if (priceId === process.env.STRIPE_PRICE_PREMIUM) return 'premium';
  if (priceId === process.env.STRIPE_PRICE_MULTILINGUAL || priceId === process.env.STRIPE_PRICE_CONNECTED) return 'connected';
  console.warn(`Unknown Stripe Price ID: ${priceId}. Defaulting to free.`);
  return 'free';
}

// Helper function to update the properties.subscription JSONB (for compatibility)
async function updatePropertiesSubscriptionJson(supabaseClient, propertyId, tier, status, renewalDate) {
    if (!propertyId) {
        console.warn('updatePropertiesSubscriptionJson: propertyId is undefined, skipping update.');
        return;
    }
    try {
        const { error } = await supabaseClient
            .from('properties')
            .update({
                subscription: { // This assumes the 'subscription' column is of JSONB type
                    tier: tier,
                    status: status,
                    renewalDate: renewalDate ? renewalDate.toISOString() : null,
                    // Add other relevant fields from your old JSONB structure if needed
                }
            })
            .eq('id', propertyId);
        if (error) console.error(`Error updating properties.subscription for ${propertyId}:`, error.message);
    } catch (e) {
        console.error(`Exception updating properties.subscription for ${propertyId}:`, e.message);
    }
}

app.listen(PORT, () => console.log(`Stripe webhook service listening on port ${PORT}`));