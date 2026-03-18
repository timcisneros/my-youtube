# my-youtube Varnish VCL configuration
#
# Caching layer between nginx and the Express app.
# Caches posters, thumbnails, storyboards, and static assets.
# Passes through video segments (too large) and API/auth requests.
#
# Install: sudo apt install varnish
# Config:  sudo cp deploy/varnish.vcl /etc/varnish/default.vcl
# Start:   sudo systemctl enable --now varnish
#
# nginx should proxy to Varnish (port 6081), Varnish proxies to Express (port 3000):
#   Client -> nginx:443 -> Varnish:6081 -> Express:3000

vcl 4.1;

import std;

# Backend: the Express application
backend default {
    .host = "127.0.0.1";
    .port = "3000";
    .connect_timeout = 5s;
    .first_byte_timeout = 60s;
    .between_bytes_timeout = 10s;

    # Health check — lightweight probe
    .probe = {
        .url = "/favicon.ico";
        .timeout = 3s;
        .interval = 10s;
        .window = 5;
        .threshold = 3;
        .expected_response = 204;
    }
}

# --- Request handling ---

sub vcl_recv {
    # Normalize host header
    set req.http.Host = regsub(req.http.Host, ":[0-9]+$", "");

    # Only handle GET and HEAD for caching
    if (req.method != "GET" && req.method != "HEAD") {
        return (pass);
    }

    # --- Pass-through rules (never cache) ---

    # API and auth requests — always pass through
    if (req.url ~ "^/auth/" ||
        req.url ~ "^/api/subscriptions" ||
        req.url ~ "^/api/tags" ||
        req.url ~ "^/api/comments" ||
        req.url ~ "^/api/cookies" ||
        req.url ~ "^/api/watch-time" ||
        req.url ~ "^/downloads" ||
        req.url ~ "^/health") {
        return (pass);
    }

    # SSE/WebSocket status endpoints — long-lived, don't cache
    if (req.url ~ "^/api/stream/[^/]+/status$") {
        return (pipe);
    }

    # Video segments — too large for Varnish memory, pass through
    # Matches: /api/stream/VIDEO_ID/audio/N, /api/stream/VIDEO_ID/video/N,
    #          /api/stream/VIDEO_ID/manifest, /api/stream/VIDEO_ID/hls/...
    if (req.url ~ "^/api/stream/[^/]+/(audio|video|manifest|hls)") {
        return (pass);
    }

    # Session-dependent pages (HTML pages that show user-specific content)
    if (req.url ~ "^/$" ||
        req.url ~ "^/subscriptions" ||
        req.url ~ "^/channel/" ||
        req.url ~ "^/watch/") {
        return (pass);
    }

    # --- Cacheable resources ---

    # Strip cookies for cacheable requests (posters, thumbnails, static assets)
    # This allows Varnish to cache regardless of session cookies
    if (req.url ~ "^/api/stream/[^/]+/(poster|thumb)" ||
        req.url ~ "^/api/stream/[^/]+/storyboard/" ||
        req.url ~ "^/public/" ||
        req.url ~ "^/vendor/" ||
        req.url ~ "^/fonts/") {
        unset req.http.Cookie;
        return (hash);
    }

    # Default: pass through
    return (pass);
}

# --- Cache key ---

sub vcl_hash {
    hash_data(req.url);
    hash_data(req.http.Host);
    return (lookup);
}

# --- Backend response handling ---

sub vcl_backend_response {
    # Don't cache error responses
    if (beresp.status >= 400) {
        set beresp.ttl = 0s;
        set beresp.uncacheable = true;
        return (deliver);
    }

    # --- Posters and thumbnails: cache 24 hours ---
    if (bereq.url ~ "^/api/stream/[^/]+/(poster|thumb)") {
        set beresp.ttl = 24h;
        set beresp.grace = 6h;
        unset beresp.http.Set-Cookie;
        set beresp.http.X-Varnish-Cache = "poster";
        return (deliver);
    }

    # --- Storyboard sheets: cache 24 hours ---
    if (bereq.url ~ "^/api/stream/[^/]+/storyboard/") {
        set beresp.ttl = 24h;
        set beresp.grace = 6h;
        unset beresp.http.Set-Cookie;
        set beresp.http.X-Varnish-Cache = "storyboard";
        return (deliver);
    }

    # --- Static assets: cache 7 days ---
    if (bereq.url ~ "^/public/" || bereq.url ~ "^/vendor/" || bereq.url ~ "^/fonts/") {
        set beresp.ttl = 7d;
        set beresp.grace = 1d;
        unset beresp.http.Set-Cookie;
        set beresp.http.X-Varnish-Cache = "static";
        return (deliver);
    }

    # Default: don't cache
    set beresp.ttl = 0s;
    set beresp.uncacheable = true;
    return (deliver);
}

# --- Response delivery ---

sub vcl_deliver {
    # Add cache hit/miss header for debugging
    if (obj.hits > 0) {
        set resp.http.X-Cache = "HIT";
        set resp.http.X-Cache-Hits = obj.hits;
    } else {
        set resp.http.X-Cache = "MISS";
    }

    # Remove Varnish internal headers in production
    # Uncomment these lines to hide Varnish from clients:
    # unset resp.http.X-Varnish;
    # unset resp.http.Via;
    # unset resp.http.X-Varnish-Cache;

    return (deliver);
}

# --- Grace mode: serve stale content during backend failures ---

sub vcl_hit {
    if (obj.ttl >= 0s) {
        # Normal hit, deliver cached content
        return (deliver);
    }

    # Object is expired but within grace period
    if (obj.ttl + obj.grace > 0s) {
        # Backend is healthy: fetch fresh content in background
        if (std.healthy(req.backend_hint)) {
            if (obj.ttl + 10s > 0s) {
                # Recently expired: serve stale, refresh in background
                return (deliver);
            }
            # Older: wait for fresh content
            return (miss);
        }

        # Backend is unhealthy: serve stale content
        return (deliver);
    }

    # Beyond grace period
    return (miss);
}

# --- Synthetic error pages ---

sub vcl_synth {
    if (resp.status == 503) {
        set resp.http.Content-Type = "text/html; charset=utf-8";
        set resp.http.Retry-After = "5";
        synthetic({"<!DOCTYPE html>
<html>
<head><title>Service Unavailable</title></head>
<body>
<h1>Temporarily Unavailable</h1>
<p>The server is currently unavailable. Please try again in a few moments.</p>
</body>
</html>"});
        return (deliver);
    }
}

# --- Backend error handling ---

sub vcl_backend_error {
    set beresp.http.Content-Type = "text/html; charset=utf-8";
    set beresp.http.Retry-After = "5";
    synthetic({"<!DOCTYPE html>
<html>
<head><title>Backend Error</title></head>
<body>
<h1>Backend Error</h1>
<p>Could not connect to the application server. Retrying...</p>
</body>
</html>"});
    return (deliver);
}
