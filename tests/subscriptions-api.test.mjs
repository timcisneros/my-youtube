import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubscriptionList, rankBrowserSpecsForRequest } from '../routes/subscriptions-api.ts';

describe('subscription page parsing', () => {
  it('extracts subscriptions from nested channel renderers', () => {
    const subs = parseSubscriptionList({
      contents: {
        twoColumnBrowseResultsRenderer: {
          tabs: [{
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [{
                    itemSectionRenderer: {
                      contents: [{
                        shelfRenderer: {
                          content: {
                            expandedShelfContentsRenderer: {
                              items: [{
                                channelRenderer: {
                                  channelId: 'UC1234567890123456789012',
                                  title: { simpleText: 'Main Channel' },
                                  thumbnail: { thumbnails: [{ url: 'small.jpg' }, { url: 'large.jpg' }] },
                                  descriptionSnippet: { runs: [{ text: 'A channel' }] },
                                },
                              }],
                            },
                          },
                        },
                      }],
                    },
                  }],
                },
              },
            },
          }],
        },
      },
    });

    assert.deepEqual(subs, [{
      channelId: 'UC1234567890123456789012',
      title: 'Main Channel',
      thumbnail: 'large.jpg',
      description: 'A channel',
    }]);
  });

  it('deduplicates channels found in newer grid renderers', () => {
    const subs = parseSubscriptionList({
      rows: [{
        gridChannelRenderer: {
          channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
          title: { runs: [{ text: 'Grid Channel' }] },
        },
      }, {
        compactChannelRenderer: {
          channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
          title: { simpleText: 'Grid Channel Duplicate' },
        },
      }],
    });

    assert.equal(subs.length, 1);
    assert.equal(subs[0].title, 'Grid Channel');
  });

  it('ranks the active Chromium-compatible profile ahead of the generic profile', () => {
    const req = {
      headers: {
        'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/126 Safari/537.36',
        'sec-ch-ua': '"Chromium";v="126"',
      },
    };
    const ranked = rankBrowserSpecsForRequest(req, [
      'firefox',
      'chromium',
      'chromium:/home/timcis/.config/net.imput.helium/Profile 1',
    ]);

    assert.equal(ranked[0], 'chromium:/home/timcis/.config/net.imput.helium/Profile 1');
  });
});
