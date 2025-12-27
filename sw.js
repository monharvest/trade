// Service Worker for Trade.mn Price Alert PWA
const CACHE_NAME = 'trade-alert-v1';
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/manifest.json',
    'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
    'https://cdn.socket.io/4.7.2/socket.io.min.js'
];

// Install event - cache assets
self.addEventListener('install', (event) => {
    console.log('[SW] Installing service worker...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW] Caching assets');
                return cache.addAll(ASSETS_TO_CACHE);
            })
            .catch((error) => {
                console.log('[SW] Cache failed:', error);
            })
    );
    self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating service worker...');
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[SW] Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    return self.clients.claim();
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
    // Skip non-GET requests
    if (event.request.method !== 'GET') {
        return;
    }

    // Skip chrome-extension and browser requests
    if (event.request.url.startsWith('chrome-extension://') || 
        event.request.url.includes('browser-sync')) {
        return;
    }

    event.respondWith(
        caches.match(event.request)
            .then((response) => {
                // Cache hit - return response
                if (response) {
                    return response;
                }

                // Clone the request
                const fetchRequest = event.request.clone();

                return fetch(fetchRequest).then((response) => {
                    // Check if valid response
                    if (!response || response.status !== 200 || response.type !== 'basic') {
                        return response;
                    }

                    // Clone the response
                    const responseToCache = response.clone();

                    // Cache the fetched response for next time
                    caches.open(CACHE_NAME)
                        .then((cache) => {
                            cache.put(event.request, responseToCache);
                        });

                    return response;
                });
            })
            .catch(() => {
                // Offline fallback
                return new Response(
                    '<html><body><h1>Offline</h1><p>No internet connection. Please check your network.</p></body></html>',
                    { headers: { 'Content-Type': 'text/html' } }
                );
            })
    );
});

// Listen for messages from the client
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    
    // Save alerts to check in background
    if (event.data && event.data.type === 'SAVE_ALERTS') {
        self.alerts = event.data.alerts;
        console.log('[SW] Alerts saved for background monitoring:', self.alerts);
    }
});

// Periodic Background Sync (check prices in background)
self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'check-prices') {
        event.waitUntil(checkPricesAndNotify());
    }
});

// Background sync for offline notifications
self.addEventListener('sync', (event) => {
    if (event.tag === 'check-prices') {
        event.waitUntil(checkPricesAndNotify());
    }
});

async function checkPricesAndNotify() {
    console.log('[SW] Checking prices in background...');
    
    if (!self.alerts || self.alerts.length === 0) {
        console.log('[SW] No alerts to check');
        return;
    }
    
    // Check each alert
    for (const alert of self.alerts) {
        if (!alert.enabled) continue;
        
        try {
            // Fetch current price (you'll need to implement this based on your API)
            const response = await fetch('https://trade-telegram-bot.monharvest.workers.dev/api/current-price?pair=' + encodeURIComponent(alert.pair));
            const data = await response.json();
            
            if (data.price) {
                let triggered = false;
                
                if (alert.type === 'above' && data.price >= alert.target) {
                    triggered = true;
                } else if (alert.type === 'below' && data.price <= alert.target) {
                    triggered = true;
                }
                
                if (triggered) {
                    // Show browser notification
                    self.registration.showNotification('🔔 Price Alert!', {
                        body: `${alert.pair}: ${data.price.toLocaleString()} MNT (Target: ${alert.target.toLocaleString()})`,
                        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" fill="%233b82f6" rx="20"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="120" font-family="Arial" font-weight="bold" fill="white">T</text></svg>',
                        badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><circle cx="48" cy="48" r="48" fill="%233b82f6"/></svg>',
                        tag: 'price-alert-' + alert.id,
                        requireInteraction: true
                    });
                    
                    // Send Telegram notification
                    await fetch('https://trade-telegram-bot.monharvest.workers.dev/api/notify', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            message: `Price Alert Triggered!`,
                            pair: alert.pair,
                            price: data.price,
                            targetPrice: alert.target,
                            type: alert.type
                        })
                    });
                }
            }
        } catch (error) {
            console.error('[SW] Error checking price:', error);
        }
    }
}

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    
    // Open or focus the app
    event.waitUntil(
        clients.openWindow('/')
    );
});
