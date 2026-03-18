// Relative time formatting ("8 hours ago", "3 days ago", etc.)
function timeAgo(date) {
  var s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 60) return 'just now';
  var m = Math.floor(s / 60);
  if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
  var h = Math.floor(m / 60);
  if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  var d = Math.floor(h / 24);
  if (d < 7) return d + (d === 1 ? ' day ago' : ' days ago');
  var w = Math.floor(d / 7);
  if (d < 30) return w + (w === 1 ? ' week ago' : ' weeks ago');
  var mo = Math.floor(d / 30);
  if (mo < 12) return mo + (mo === 1 ? ' month ago' : ' months ago');
  var y = Math.floor(mo / 12);
  return y + (y === 1 ? ' year ago' : ' years ago');
}

// Format seconds as H:MM:SS or M:SS
function formatDuration(s) {
  s = Math.floor(s);
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var sec = s % 60;
  if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

// Lazy-load thumbnails — only fetch when the image enters the viewport.
// Templates render <img data-src="..." class="lazy-thumb"> instead of src,
// so the browser doesn't fire 45+ requests on initial parse.
function _loadThumb(img) {
  img.onerror = function () { img.classList.add('thumb-error'); };
  img.src = img.dataset.src;
  img.removeAttribute('data-src');
  img.classList.remove('lazy-thumb');
}

var _thumbObserver = null;
function loadThumbnails() {
  var imgs = document.querySelectorAll('img.lazy-thumb[data-src]');
  if (!imgs.length) return;

  if ('IntersectionObserver' in window) {
    if (_thumbObserver) _thumbObserver.disconnect();
    _thumbObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          var img = entry.target;
          _loadThumb(img);
          _thumbObserver.unobserve(img);
        }
      });
    }, { rootMargin: '400px' });
    imgs.forEach(function (img) { _thumbObserver.observe(img); });
  } else {
    // Fallback: load all immediately
    imgs.forEach(function (img) {
      _loadThumb(img);
    });
  }
}

// Load video durations for all thumbnail badges on the page via SSE
// Badges with durations already rendered server-side are skipped.
// Missing durations stream in live as yt-dlp resolves them.
var _durationSource = null;
var _durationObserver = null;
function loadDurations(refreshAll) {
  var badges = Array.from(document.querySelectorAll('.video-duration[data-video-id], .video-badge[data-video-id]'));
  var pending = refreshAll
    ? badges.filter(function (b) { return b.dataset.videoId; })
    : badges.filter(function (b) { return b.dataset.videoId && !b.textContent.trim(); });
  if (!pending.length) return;

  // Use Intersection Observer to only fetch durations for visible badges
  if ('IntersectionObserver' in window && !refreshAll) {
    if (_durationObserver) _durationObserver.disconnect();
    var visibleIds = {};
    var allBadgeMap = {};
    pending.forEach(function (badge) {
      var vid = badge.dataset.videoId;
      if (!allBadgeMap[vid]) allBadgeMap[vid] = [];
      allBadgeMap[vid].push(badge);
    });
    var fetchTimer = null;
    function flushVisible() {
      var ids = Object.keys(visibleIds);
      if (!ids.length) return;
      visibleIds = {};
      // Chunk into batches of 50 (server limit)
      for (var i = 0; i < ids.length; i += 50) {
        var chunk = ids.slice(i, i + 50);
        var batchMap = {};
        chunk.forEach(function (id) { batchMap[id] = allBadgeMap[id] || []; });
        _fetchDurations(chunk, batchMap);
      }
    }
    _durationObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          var vid = entry.target.dataset.videoId;
          if (vid) visibleIds[vid] = true;
          _durationObserver.unobserve(entry.target);
        }
      });
      // Batch: wait 100ms for more entries before fetching
      clearTimeout(fetchTimer);
      fetchTimer = setTimeout(flushVisible, 100);
    }, { rootMargin: '300px' });
    pending.forEach(function (badge) { _durationObserver.observe(badge); });
    return;
  }

  // Fallback: fetch all at once, chunked to 50
  var ids = [];
  var badgeMap = {};
  pending.forEach(function (badge) {
    var vid = badge.dataset.videoId;
    if (!badgeMap[vid]) { badgeMap[vid] = []; ids.push(vid); }
    badgeMap[vid].push(badge);
  });
  for (var i = 0; i < ids.length; i += 50) {
    var chunk = ids.slice(i, i + 50);
    var chunkMap = {};
    chunk.forEach(function (id) { chunkMap[id] = badgeMap[id]; });
    _fetchDurations(chunk, chunkMap);
  }
}

function _fetchDurations(ids, badgeMap) {
  // Close any previous SSE connection (e.g. from pjax navigation)
  if (_durationSource) { _durationSource.close(); _durationSource = null; }
  var es = new EventSource('/api/stream/durations-live?ids=' + ids.join(','));
  _durationSource = es;
  es.onmessage = function (e) {
    try {
      var d = JSON.parse(e.data);
      (badgeMap[d.id] || []).forEach(function (badge) {
        if (d.live_status === 'is_live') {
          badge.className = 'video-badge live';
          badge.textContent = 'LIVE';
        } else if (d.live_status === 'is_upcoming') {
          badge.className = 'video-badge upcoming';
          badge.textContent = 'UPCOMING';
        } else {
          badge.className = 'video-duration';
          badge.textContent = formatDuration(d.duration);
        }
      });
    } catch (err) {}
  };
  es.addEventListener('done', function () {
    es.close();
    if (_durationSource === es) _durationSource = null;
  });
  es.onerror = function () {
    es.close();
    if (_durationSource === es) _durationSource = null;
  };
}

// Load watch progress bars for video thumbnails
function loadWatchProgress() {
  var els = document.querySelectorAll('[data-progress-id]');
  if (!els.length) return;
  var ids = [];
  var elMap = {};
  els.forEach(function (el) {
    var vid = el.dataset.progressId;
    if (!elMap[vid]) { elMap[vid] = []; ids.push(vid); }
    elMap[vid].push(el);
  });
  for (var i = 0; i < ids.length; i += 50) {
    var chunk = ids.slice(i, i + 50);
    (function (batch) {
      fetch('/api/watch-times', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: batch })
      }).then(function (r) { return r.json(); }).then(function (data) {
        for (var vid in data) {
          var wt = data[vid];
          if (!wt || !wt.last_position || !wt.duration) continue;
          var pct = Math.min(100, (wt.last_position / wt.duration) * 100);
          (elMap[vid] || []).forEach(function (el) {
            el.style.width = pct + '%';
          });
        }
      }).catch(function () {});
    })(chunk);
  }
}

// Pjax navigation + loading bar
(function () {
  var bar, fastInterval, slowInterval;

  function appendBar() {
    if (!bar) return;
    if (document.body) { document.body.appendChild(bar); return; }
    // Body not ready yet (script in <head>) — wait for it
    var observer = new MutationObserver(function () {
      if (document.body) { observer.disconnect(); document.body.appendChild(bar); }
    });
    observer.observe(document.documentElement, { childList: true });
  }

  function startBar() {
    if (bar) bar.remove();
    bar = document.createElement('div');
    bar.className = 'top-loading-bar';
    bar.style.width = '0%';
    appendBar();
    var width = 0;
    // Fast phase: 0 → 70%
    fastInterval = setInterval(function () {
      if (!bar) { clearInterval(fastInterval); fastInterval = null; return; }
      width += 3;
      if (width >= 70) {
        clearInterval(fastInterval);
        fastInterval = null;
        // Slow phase: trickle toward 95%
        slowInterval = setInterval(function () {
          if (!bar) { clearInterval(slowInterval); slowInterval = null; return; }
          width += 0.3;
          if (width >= 95) { clearInterval(slowInterval); slowInterval = null; }
          bar.style.width = width + '%';
        }, 100);
      }
      if (bar) bar.style.width = width + '%';
    }, 30);
  }

  function finishBar() {
    if (fastInterval) { clearInterval(fastInterval); fastInterval = null; }
    if (slowInterval) { clearInterval(slowInterval); slowInterval = null; }
    if (!bar) return;
    bar.style.width = '100%';
    bar.classList.add('done');
    setTimeout(function () { if (bar) { bar.remove(); bar = null; } }, 600);
  }

  // Set bar to a specific percentage (used by player to reflect extraction progress)
  window._setLoadBarProgress = function (pct) {
    if (fastInterval) { clearInterval(fastInterval); fastInterval = null; }
    if (slowInterval) { clearInterval(slowInterval); slowInterval = null; }
    if (!bar) return;
    bar.style.width = Math.min(95, pct) + '%';
  };

  window._startLoadBar = startBar;
  window._finishLoadingBar = finishBar;

  function updateActiveNav() {
    var path = window.location.pathname;
    document.querySelectorAll('.nav-links a:not(.nav-logout)').forEach(function (a) {
      var href = a.getAttribute('href');
      if (href === '/' && path === '/') {
        a.classList.add('active');
      } else if (href !== '/' && path.startsWith(href)) {
        a.classList.add('active');
      } else {
        a.classList.remove('active');
      }
    });
  }

  // Destroy active Shaka player before navigating away to stop buffering
  function destroyPlayer() {
    if (window._playerEngine) {
      window._playerEngine.destroy();
      window._playerEngine = null;
    } else if (window._shakaPlayer) {
      try { window._shakaPlayer.destroy(); } catch (e) {}
    }
    window._shakaPlayer = null;
    if (window._shakaKeydown) {
      document.removeEventListener('keydown', window._shakaKeydown);
      window._shakaKeydown = null;
    }
    if (window._stallTimer) {
      clearInterval(window._stallTimer);
      window._stallTimer = null;
    }
    window._chapterList = null;
    window._subtitleList = null;
    window._captionCues = null;
    window._linkifyDescriptionTimestamps = null;
    if (window._cleanupReconnect) { window._cleanupReconnect(); window._cleanupReconnect = null; }
    if (window._stopStatusPoll) { window._stopStatusPoll(); window._stopStatusPoll = null; }
    if (_durationSource) { _durationSource.close(); _durationSource = null; }
  }

  // Inject <head> resources (CSS/JS) from the fetched page that aren't already present.
  // Returns a promise that resolves when all new scripts have loaded.
  function injectHeadResources(doc) {
    var promises = [];
    doc.querySelectorAll('head link[rel="stylesheet"], head script[src]').forEach(function (el) {
      var key = el.tagName === 'LINK' ? el.getAttribute('href') : el.getAttribute('src');
      if (!key) return;
      var selector = el.tagName === 'LINK'
        ? 'link[rel="stylesheet"][href="' + key + '"]'
        : 'script[src="' + key + '"]';
      if (document.head.querySelector(selector)) return;
      var clone = document.createElement(el.tagName);
      if (el.tagName === 'LINK') {
        clone.rel = 'stylesheet';
        clone.href = key;
        promises.push(new Promise(function (resolve) {
          clone.onload = resolve;
          clone.onerror = resolve;
        }));
      } else {
        clone.src = key;
        promises.push(new Promise(function (resolve) {
          clone.onload = resolve;
          clone.onerror = resolve;
        }));
      }
      document.head.appendChild(clone);
    });
    return promises.length > 0 ? Promise.all(promises) : Promise.resolve();
  }

  function swapContent(html) {
    destroyPlayer();
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var resourcesReady = injectHeadResources(doc);
    var newMain = doc.querySelector('main');
    var newTitle = doc.querySelector('title');
    if (newTitle) {
      document.title = newTitle.textContent;
    }
    // Wait for all head resources (CSS + JS) before swapping DOM and running scripts
    // so the page is never shown unstyled
    resourcesReady.then(function () {
      if (newMain) {
        document.querySelector('main').innerHTML = newMain.innerHTML;
      }
      updateActiveNav();
      initComments();
      initTags();
      initDismiss();
      initBoost();
      initQueue();
      initMute();
      initRating();
      initTopicFilters();
      initResetRecommendations();
      initExploreClickTracking();
      initViewportImpressions();
      loadThumbnails();
      loadDurations();
      loadWatchProgress();
      var scripts = document.querySelectorAll('main script');
      scripts.forEach(function (s) {
        var ns = document.createElement('script');
        ns.textContent = s.textContent;
        s.parentNode.replaceChild(ns, s);
      });
    });
  }

  // Save current page state before navigating away, for instant back/forward
  function savePageState() {
    var main = document.querySelector('main');
    if (!main) return;
    history.replaceState({
      mainHTML: main.innerHTML,
      title: document.title,
      scroll: window.scrollY
    }, '');
  }

  async function navigate(href) {
    startBar();
    // If navigating to a video page, fire stream prefetch immediately
    // so yt-dlp + probes run in parallel with the page fetch
    var watchMatch = href.match(/[?&]v=([A-Za-z0-9_-]+)/);
    if (watchMatch) {
      if (window._startLoadTimer) window._startLoadTimer();
      fetch('/api/stream/' + watchMatch[1] + '/prefetch');
    }
    try {
      var res = await fetch(href);
      if (!res.ok) { window.location.href = href; return; }
      var html = await res.text();
      savePageState();
      history.pushState({}, '', href);
      swapContent(html);
      // For video pages, keep loading bar until player is ready
      if (watchMatch) {
        window._finishLoadingBar = finishBar;
      } else {
        finishBar();
        // Hide timer and stream-via when navigating away from a video page
        var tel = document.getElementById('load-timer');
        if (tel) tel.className = 'load-timer';
        var svel = document.getElementById('stream-via');
        if (svel) svel.textContent = '';
      }
      window.scrollTo(0, 0);
    } catch (e) {
      window.location.href = href;
    }
  }

  document.addEventListener('click', function (e) {
    var a = e.target.closest('a');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    // Only intercept same-origin, non-auth links
    try {
      var url = new URL(href, window.location.origin);
      if (url.origin !== window.location.origin) return;
      if (url.pathname.startsWith('/auth/')) return;
    } catch (err) { return; }
    e.preventDefault();
    navigate(href);
  });

  window.addEventListener('popstate', async function (e) {
    destroyPlayer();
    // Pages with dynamic state — fetch fresh instead of restoring stale cache
    if (/[?&]v=/.test(window.location.search) || window.location.pathname === '/downloads') {
      startBar();
      var vMatch = window.location.search.match(/[?&]v=([A-Za-z0-9_-]+)/);
      if (vMatch) {
        if (window._startLoadTimer) window._startLoadTimer();
        fetch('/api/stream/' + vMatch[1] + '/prefetch');
      }
      fetch(window.location.href)
        .then(function (r) { return r.ok ? r.text() : null; })
        .then(function (html) {
          if (!html) { window.location.reload(); return; }
          swapContent(html);
        })
        .catch(function () { window.location.reload(); });
      return;
    }
    // Restore from cached state if available (instant, no flicker)
    if (e.state && e.state.mainHTML) {
      var main = document.querySelector('main');
      if (main) main.innerHTML = e.state.mainHTML;
      if (e.state.title) document.title = e.state.title;
      updateActiveNav();
      document.querySelectorAll('[data-published]').forEach(function (el) {
        if (!el.dataset.published) return;
        var d = new Date(el.dataset.published);
        el.textContent = isNaN(d.getTime()) ? el.dataset.published : timeAgo(el.dataset.published);
      });
      initComments();
      initTags();
      loadThumbnails();
      loadDurations(true);
      loadWatchProgress();
      var scripts = document.querySelectorAll('main script');
      scripts.forEach(function (s) {
        var ns = document.createElement('script');
        ns.textContent = s.textContent;
        s.parentNode.replaceChild(ns, s);
      });
      if (typeof e.state.scroll === 'number') window.scrollTo(0, e.state.scroll);
      return;
    }
    // No cached state — fetch fresh
    startBar();
    try {
      var res = await fetch(window.location.href);
      var html = await res.text();
      swapContent(html);
      finishBar();
    } catch (err) {
      window.location.reload();
    }
  });
})();

// Comments
function ytUrlToLocal(url) {
  try {
    var u = new URL(url);
    var host = u.hostname.replace(/^(www|m)\./, '');
    if (host === 'youtube.com') {
      var v = u.searchParams.get('v');
      if (u.pathname === '/watch' && v) return '/watch?v=' + v + (u.searchParams.get('t') ? '&t=' + u.searchParams.get('t') : '');
      if (u.pathname.startsWith('/channel/')) return u.pathname;
      if (u.pathname.startsWith('/@')) return '/channel/' + u.pathname.slice(1);
      if (u.pathname.startsWith('/shorts/')) return '/watch?v=' + u.pathname.slice(8);
    }
    if (host === 'youtu.be') {
      var id = u.pathname.slice(1);
      if (id) return '/watch?v=' + id + (u.searchParams.get('t') ? '&t=' + u.searchParams.get('t') : '');
    }
  } catch {}
  return null;
}

function linkifyCommentText(text) {
  // Linkify URLs — route YouTube links through our app
  text = text.replace(/(https?:\/\/[^\s<]+)/g, function (url) {
    var local = ytUrlToLocal(url);
    if (local) return '<a href="' + escapeHtml(local) + '">' + escapeHtml(url) + '</a>';
    return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(url) + '</a>';
  });
  // Linkify timestamps (e.g. 1:23, 01:23, 1:23:45)
  text = text.replace(/(?:^|[\s(])(\d{1,2}:\d{2}(?::\d{2})?)(?=[\s,.)!?]|$)/g, function (match, ts) {
    var parts = ts.split(':').map(Number);
    var secs = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    return match.replace(ts, '<a href="#" class="comment-timestamp" data-time="' + secs + '">' + ts + '</a>');
  });
  return text;
}

function initComments() {
  var section = document.querySelector('.comments-section');
  if (!section || section.hidden) return;

  // Lazy-load comments when section scrolls into view
  if (section.dataset.lazy === '1') {
    section.dataset.lazy = '0';
    if ('IntersectionObserver' in window) {
      var observer = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) {
          observer.disconnect();
          _initCommentsInner(section);
        }
      }, { rootMargin: '200px' });
      observer.observe(section);
      return;
    }
    // Fallback: load immediately if no IntersectionObserver
  }
  _initCommentsInner(section);
}

function _initCommentsInner(section) {
  // Delegated click handler for timestamp links in comments
  section.addEventListener('click', function (e) {
    var ts = e.target.closest('.comment-timestamp');
    if (!ts) return;
    e.preventDefault();
    var video = document.getElementById('player');
    if (video) {
      video.currentTime = parseFloat(ts.dataset.time);
      if (video.paused) video.play().catch(function () {});
    }
  });

  var videoId = section.dataset.videoId;
  var heading = section.querySelector('h3');
  var list = section.querySelector('.comments-list');
  var btn = section.querySelector('.load-more-btn');
  var status = section.querySelector('.comments-status');
  var nextPageToken = null;

  // Clear previous content and listeners by replacing button
  list.innerHTML = '';
  var newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);
  btn = newBtn;
  btn.style.display = 'none';

  async function loadComments(pageToken) {
    var url = '/api/comments/' + videoId + (pageToken ? '?pageToken=' + pageToken : '');
    var res = await fetch(url);
    var data = await res.json();

    if (data.disabled) {
      status.textContent = 'Comments are disabled for this video.';
      btn.style.display = 'none';
      return;
    }
    if (data.error) {
      status.textContent = 'Could not load comments (' + data.error + ')';
      btn.style.display = 'none';
      return;
    }

    for (var i = 0; i < data.comments.length; i++) {
      var c = data.comments[i];
      var div = document.createElement('div');
      div.className = 'comment';
      div.innerHTML =
        (c.authorUrl ? '<a href="' + escapeHtml(c.authorUrl) + '">' : '') +
        '<img src="' + (c.authorImage ? '/api/comments/avatar/' + encodeURIComponent(c.authorImage) : '') + '" alt="" class="comment-avatar" loading="lazy" onerror="this.classList.add(\'avatar-broken\')">' +
        (c.authorUrl ? '</a>' : '') +
        '<div class="comment-body">' +
          '<div class="comment-author">' + (c.authorUrl ? '<a href="' + escapeHtml(c.authorUrl) + '">' + escapeHtml(c.author) + '</a>' : escapeHtml(c.author)) + '</div>' +
          '<div class="comment-text">' + linkifyCommentText(c.text) + '</div>' +
          '<div class="comment-meta">' + (c.likeCount || '0') + ' likes &middot; ' + (c.publishedAt && !isNaN(new Date(c.publishedAt)) ? new Date(c.publishedAt).toLocaleDateString() : (c.publishedAt || '')) + '</div>' +
        '</div>';
      list.appendChild(div);
      if (c.replyContinuation) {
        (function (token, commentDiv) {
          var body = commentDiv.querySelector('.comment-body');
          var replyBtn = document.createElement('button');
          replyBtn.className = 'show-replies-btn';
          replyBtn.textContent = c.replyCount ? c.replyCount + (c.replyCount === 1 ? ' reply' : ' replies') : 'Show replies';
          var replyContainer = document.createElement('div');
          replyContainer.className = 'replies-container';
          body.appendChild(replyBtn);
          body.appendChild(replyContainer);
          var currentToken = token;
          var loaded = false;

          function appendReplies(d) {
            for (var j = 0; j < d.replies.length; j++) {
              var r = d.replies[j];
              var rdiv = document.createElement('div');
              rdiv.className = 'comment comment-reply';
              rdiv.innerHTML =
                (r.authorUrl ? '<a href="' + escapeHtml(r.authorUrl) + '">' : '') +
                '<img src="' + (r.authorImage ? '/api/comments/avatar/' + encodeURIComponent(r.authorImage) : '') + '" alt="" class="comment-avatar" loading="lazy" onerror="this.classList.add(\'avatar-broken\')">' +
                (r.authorUrl ? '</a>' : '') +
                '<div class="comment-body">' +
                  '<div class="comment-author">' + (r.authorUrl ? '<a href="' + escapeHtml(r.authorUrl) + '">' + escapeHtml(r.author) + '</a>' : escapeHtml(r.author)) + '</div>' +
                  '<div class="comment-text">' + linkifyCommentText(r.text) + '</div>' +
                  '<div class="comment-meta">' + (r.likeCount || '0') + ' likes &middot; ' + (r.publishedAt && !isNaN(new Date(r.publishedAt)) ? new Date(r.publishedAt).toLocaleDateString() : (r.publishedAt || '')) + '</div>' +
                '</div>';
              replyContainer.appendChild(rdiv);
            }
            currentToken = d.nextReplyToken || null;
          }

          function loadReplies() {
            replyBtn.textContent = 'Loading...';
            replyBtn.disabled = true;
            fetch('/api/comments/replies?token=' + encodeURIComponent(currentToken))
              .then(function (r) { return r.json(); })
              .then(function (d) {
                appendReplies(d);
                loaded = true;
                if (currentToken) {
                  replyBtn.textContent = 'Show more replies';
                  replyBtn.disabled = false;
                } else {
                  replyBtn.textContent = 'Hide replies';
                  replyBtn.disabled = false;
                }
              })
              .catch(function () {
                replyBtn.textContent = 'Show replies';
                replyBtn.disabled = false;
              });
          }

          replyBtn.addEventListener('click', function () {
            if (!loaded) { loadReplies(); return; }
            if (currentToken) { loadReplies(); return; }
            var visible = replyContainer.style.display !== 'none';
            replyContainer.style.display = visible ? 'none' : '';
            replyBtn.textContent = visible ? 'Show replies' : 'Hide replies';
          });
        })(c.replyContinuation, div);
      }
    }

    if (data.totalCount) heading.textContent = data.totalCount;
    nextPageToken = data.nextPageToken;
    status.textContent = '';
    btn.style.display = nextPageToken ? 'block' : 'none';
  }

  btn.addEventListener('click', function () { loadComments(nextPageToken); });
  loadComments(null);
}

// Dismiss — "Not interested" button on Explore cards
function initDismiss() {
  var btns = document.querySelectorAll('.dismiss-btn[data-dismiss-id]');
  btns.forEach(function (btn) {
    // Avoid double-binding
    if (btn.dataset.dismissBound) return;
    btn.dataset.dismissBound = '1';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var videoId = btn.dataset.dismissId;
      var card = btn.closest('.video-card');
      var channelId = card ? (card.dataset.channelId || '') : '';
      fetch('/api/dismissals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: videoId, channelId: channelId })
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (data && data.channelMuted && channelId) {
          // Auto-muted: remove all cards from this channel
          document.querySelectorAll('.video-card[data-channel-id="' + channelId + '"]').forEach(function (c) {
            c.style.transition = 'opacity 0.3s ease';
            c.style.opacity = '0';
            setTimeout(function () { c.remove(); }, 300);
          });
        }
      }).catch(function () {});
      if (card) {
        card.style.transition = 'opacity 0.3s ease';
        card.style.opacity = '0';
        setTimeout(function () { card.remove(); }, 300);
      }
    });
  });
}

// Boost — channel boost button on Explore cards
function initBoost() {
  var btns = document.querySelectorAll('.boost-btn[data-boost-channel]');
  btns.forEach(function (btn) {
    if (btn.dataset.boostBound) return;
    btn.dataset.boostBound = '1';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var channelId = btn.dataset.boostChannel;
      var isBoosted = btn.classList.contains('boosted');
      fetch('/api/boosts', {
        method: isBoosted ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: channelId })
      }).catch(function () {});
      // Toggle all boost buttons for this channel
      document.querySelectorAll('.boost-btn[data-boost-channel="' + channelId + '"]').forEach(function (b) {
        b.classList.toggle('boosted');
      });
    });
  });
}

// Queue — save-for-later button on Explore cards
function initQueue() {
  var btns = document.querySelectorAll('.queue-btn[data-queue-id]');
  btns.forEach(function (btn) {
    if (btn.dataset.queueBound) return;
    btn.dataset.queueBound = '1';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var videoId = btn.dataset.queueId;
      var isQueued = btn.classList.contains('queued');
      if (isQueued) {
        fetch('/queue', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: videoId })
        }).catch(function () {});
      } else {
        fetch('/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoId: videoId,
            title: btn.dataset.queueTitle || '',
            channelTitle: btn.dataset.queueChannel || '',
            channelId: btn.dataset.queueChannelId || ''
          })
        }).catch(function () {});
      }
      // Toggle all queue buttons for this video
      document.querySelectorAll('.queue-btn[data-queue-id="' + videoId + '"]').forEach(function (b) {
        b.classList.toggle('queued');
      });
    });
  });
}

// Mute — channel mute button on Explore cards
function initMute() {
  var btns = document.querySelectorAll('.mute-btn[data-mute-channel]');
  btns.forEach(function (btn) {
    if (btn.dataset.muteBound) return;
    btn.dataset.muteBound = '1';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var channelId = btn.dataset.muteChannel;
      var isMuted = btn.classList.contains('muted');
      if (isMuted) {
        fetch('/api/mutes', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelId: channelId })
        }).catch(function () {});
        document.querySelectorAll('.mute-btn[data-mute-channel="' + channelId + '"]').forEach(function (b) {
          b.classList.remove('muted');
        });
      } else {
        fetch('/api/mutes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelId: channelId })
        }).catch(function () {});
        // Remove all cards from this channel (muted = hard exclude)
        document.querySelectorAll('.video-card[data-channel-id="' + channelId + '"]').forEach(function (card) {
          card.style.transition = 'opacity 0.3s ease';
          card.style.opacity = '0';
          setTimeout(function () { card.remove(); }, 300);
        });
        // Also remove boost state for this channel
        document.querySelectorAll('.boost-btn[data-boost-channel="' + channelId + '"]').forEach(function (b) {
          b.classList.remove('boosted');
        });
      }
    });
  });
}

// Rating — thumbs up/down on Explore cards and player page
function initRating() {
  var btns = document.querySelectorAll('[data-rate-id]');
  btns.forEach(function (btn) {
    if (btn.dataset.rateBound) return;
    btn.dataset.rateBound = '1';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var videoId = btn.dataset.rateId;
      var value = parseInt(btn.dataset.rateValue, 10);
      var activeClass = value === 1 ? 'rated-up' : 'rated-down';
      var isActive = btn.classList.contains(activeClass);

      if (isActive) {
        fetch('/api/ratings', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: videoId })
        }).catch(function () {});
        document.querySelectorAll('[data-rate-id="' + videoId + '"]').forEach(function (b) {
          b.classList.remove('rated-up', 'rated-down');
        });
      } else {
        fetch('/api/ratings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: videoId, rating: value })
        }).catch(function () {});
        document.querySelectorAll('[data-rate-id="' + videoId + '"]').forEach(function (b) {
          b.classList.remove('rated-up', 'rated-down');
          if (parseInt(b.dataset.rateValue, 10) === value) {
            b.classList.add(activeClass);
          }
        });
      }
    });
  });
}

// Topic filters — add/remove topic filter pills on Explore page
function initTopicFilters() {
  var toggle = document.getElementById('topic-filter-toggle');
  var form = document.getElementById('topic-filter-form');
  if (!toggle || !form) return;
  if (toggle.dataset.tfBound) return;
  toggle.dataset.tfBound = '1';

  toggle.addEventListener('click', function () {
    form.style.display = form.style.display === 'none' ? 'flex' : 'none';
  });

  var cancel = document.getElementById('topic-filter-cancel');
  if (cancel) cancel.addEventListener('click', function () { form.style.display = 'none'; });

  var save = document.getElementById('topic-filter-save');
  if (save) save.addEventListener('click', function () {
    var input = document.getElementById('topic-filter-input');
    var select = document.getElementById('topic-filter-type');
    var topic = (input.value || '').trim().toLowerCase();
    if (topic.length < 2) return;
    fetch('/api/topic-filters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: topic, filter: select.value })
    }).then(function () { window.location.reload(); }).catch(function () {});
  });

  document.querySelectorAll('.topic-pill-remove[data-topic]').forEach(function (btn) {
    if (btn.dataset.tfRemoveBound) return;
    btn.dataset.tfRemoveBound = '1';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      var topic = btn.dataset.topic;
      var pill = btn.closest('.topic-pill');
      fetch('/api/topic-filters', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: topic })
      }).catch(function () {});
      if (pill) pill.remove();
    });
  });
}

// Reset recommendations — clear all user recommendation data for simulation runs
function initResetRecommendations() {
  var btn = document.getElementById('reset-recommendations-btn');
  if (!btn || btn.dataset.resetBound) return;
  btn.dataset.resetBound = '1';
  btn.addEventListener('click', function () {
    if (!confirm('Reset all recommendation data? This clears watch history, ratings, boosts, mutes, dismissals, queue, topic filters, and explore events.')) return;
    fetch('/explore/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }).then(function (r) {
      if (r.ok) window.location.reload();
    }).catch(function () {});
  });
}

// Viewport impressions — log only when Explore cards are actually seen
function initViewportImpressions() {
  var grid = document.querySelector('.video-grid');
  if (!grid || grid.dataset.impBound) return;
  grid.dataset.impBound = '1';
  if (!('IntersectionObserver' in window)) return;
  var pending = {};
  var flushTimer = null;
  function flush() {
    var items = [];
    for (var key in pending) items.push(pending[key]);
    pending = {};
    if (!items.length) return;
    fetch('/api/explore-events/impressions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ impressions: items }),
      keepalive: true
    }).catch(function () {});
  }
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var card = entry.target;
      var href = card.getAttribute('href');
      if (!href) return;
      var m = href.match(/[?&]v=([A-Za-z0-9_-]+)/);
      if (!m) return;
      var videoId = m[1];
      pending[videoId] = {
        videoId: videoId,
        channelId: card.dataset.channelId || '',
        position: parseInt(card.dataset.explorePos, 10) || 0
      };
      observer.unobserve(card);
    });
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 2000);
  }, { threshold: 0.5 });
  grid.querySelectorAll('.video-card[data-explore-pos]').forEach(function (card) {
    observer.observe(card);
  });
}

// Explore click tracking — log clicks on Explore video cards for CTR-based scoring
function initExploreClickTracking() {
  var grid = document.querySelector('.video-grid');
  if (!grid || grid.dataset.clickTrackBound) return;
  grid.dataset.clickTrackBound = '1';

  // Check for bounce or return from previous Explore click
  try {
    var last = sessionStorage.getItem('lastExploreClick');
    if (last) {
      var parsed = JSON.parse(last);
      var timeDelta = (Date.now() - parsed.timestamp) / 1000;
      if (timeDelta < 60) {
        // Quick bounce — fire bounce event
        fetch('/api/explore-events/bounce', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: parsed.videoId, channelId: parsed.channelId, bounceSeconds: Math.round(timeDelta) }),
          keepalive: true
        }).catch(function () {});
      } else {
        // Return visit — user watched and came back for more
        fetch('/api/explore-events/return', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: parsed.videoId, channelId: parsed.channelId }),
          keepalive: true
        }).catch(function () {});
      }
      sessionStorage.removeItem('lastExploreClick');
    }
  } catch (_e) { /* ignore */ }

  grid.addEventListener('click', function (e) {
    // Skip dismiss, boost, queue, and mute button clicks
    if (e.target.closest('.dismiss-btn') || e.target.closest('.boost-btn') || e.target.closest('.queue-btn') || e.target.closest('.mute-btn')) return;
    var card = e.target.closest('.video-card');
    if (!card) return;
    var href = card.getAttribute('href');
    if (!href) return;
    var m = href.match(/[?&]v=([A-Za-z0-9_-]+)/);
    if (!m) return;
    var videoId = m[1];
    var channelId = card.dataset.channelId || '';
    var sessionId = grid.dataset.sessionId || '';
    var payload = { videoId: videoId, channelId: channelId };
    if (sessionId) payload.sessionId = sessionId;
    // Store click info for bounce/return detection
    try {
      sessionStorage.setItem('lastExploreClick', JSON.stringify({ videoId: videoId, channelId: channelId, timestamp: Date.now() }));
    } catch (_e2) { /* ignore */ }
    fetch('/api/explore-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(function () {});
  });
}

// Tags
function initTags() {
  var section = document.querySelector('.tags-section');
  if (!section) return;

  var videoId = section.dataset.videoId;
  var tagsList = section.querySelector('.tags-list');
  var form = section.querySelector('.tag-form');
  var input = form.querySelector('input[name="tag"]');

  // Replace form to clear old listeners
  var newForm = form.cloneNode(true);
  form.parentNode.replaceChild(newForm, form);
  form = newForm;
  input = form.querySelector('input[name="tag"]');

  function addTagBadge(tag) {
    var span = document.createElement('span');
    span.className = 'tag-badge';
    span.textContent = tag;
    var btn = document.createElement('button');
    btn.className = 'tag-remove';
    btn.dataset.tag = tag;
    btn.textContent = '\u00d7';
    btn.addEventListener('click', function () { removeTag(tag, span); });
    span.appendChild(btn);
    tagsList.appendChild(span);
  }

  async function removeTag(tag, el) {
    await fetch('/api/tags', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: videoId, tag: tag })
    });
    el.remove();
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var tag = input.value.trim();
    if (!tag) return;
    var res = await fetch('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: videoId, tag: tag })
    });
    var data = await res.json();
    if (data.ok) {
      addTagBadge(data.tag);
      input.value = '';
    } else {
      alert(data.error || 'Failed to add tag');
    }
  });

  // Wire up existing remove buttons
  tagsList.querySelectorAll('.tag-remove').forEach(function (btn) {
    btn.addEventListener('click', function () { removeTag(btn.dataset.tag, btn.parentElement); });
  });
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Hover prefetch: start yt-dlp extraction when user dwells on a video card
// so playback starts faster if they click. 200ms delay avoids firing during fast scrolls.
(function () {
  var prefetched = {};
  var hoverTimer = null;
  document.addEventListener('mouseenter', function (e) {
    if (!e.target.closest) return;
    var card = e.target.closest('.video-card');
    if (!card) return;
    var href = card.getAttribute('href') || (card.querySelector('a') && card.querySelector('a').getAttribute('href'));
    if (!href) return;
    var m = href.match(/[?&]v=([A-Za-z0-9_-]+)/);
    if (!m || prefetched[m[1]]) return;
    var videoId = m[1];
    hoverTimer = setTimeout(function () {
      prefetched[videoId] = true;
      fetch('/api/stream/' + videoId + '/prefetch').catch(function () {});
    }, 200);
    card.addEventListener('mouseleave', function cancel() {
      clearTimeout(hoverTimer);
      card.removeEventListener('mouseleave', cancel);
    }, { once: true });
  }, true);
})();

// Load timer — measures time from click/navigation to video ready
(function () {
  var timerEl, rafId, startTime;

  function getEl() {
    if (!timerEl || !document.contains(timerEl)) timerEl = document.getElementById('load-timer');
    return timerEl;
  }

  function tick() {
    var el = getEl();
    if (!el) { rafId = requestAnimationFrame(tick); return; }
    if (el.className.indexOf('running') === -1) el.className = 'load-timer running';
    var elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
    el.textContent = elapsed + 's';
    rafId = requestAnimationFrame(tick);
  }

  window._startLoadTimer = function () {
    if (rafId) cancelAnimationFrame(rafId);
    startTime = performance.now();
    var el = getEl();
    if (el) { el.textContent = '0.00s'; el.className = 'load-timer running'; }
    rafId = requestAnimationFrame(tick);
  };

  window._stopLoadTimer = function () {
    var el = getEl();
    if (!el || !startTime) return;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    var secs = (performance.now() - startTime) / 1000;
    el.textContent = secs.toFixed(2) + 's';
    var grade = secs < 4 ? 'green' : secs < 17 ? 'yellow' : 'red';
    el.className = 'load-timer done-' + grade;
  };

  // Start on direct page load if this is a video page
  if (/[?&]v=/.test(window.location.search)) {
    window._startLoadTimer();
    if (window._startLoadBar) window._startLoadBar();
  }
})();

// Initial page load — wait for DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () {
    initComments();
    initTags();
    initDismiss();
    initBoost();
    initQueue();
    initMute();
    initRating();
    initTopicFilters();
    initExploreClickTracking();
    initViewportImpressions();
    loadThumbnails();
    loadDurations();
    loadWatchProgress();
  });
} else {
  initComments();
  initTags();
  initBoost();
  initQueue();
  initMute();
  initRating();
  initTopicFilters();
  initResetRecommendations();
  initViewportImpressions();
  loadThumbnails();
  loadDurations();
  loadWatchProgress();
}
