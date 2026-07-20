import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractPlaylistId, parsePlaylistContinuationData, parsePlaylistInitialData, sanitizePlaylistId } from '../youtube/playlists.js';

describe('playlist parsing', () => {
  it('extracts header metadata and playlist videos from YouTube initial data', () => {
    const initialData = {
      metadata: {
        playlistMetadataRenderer: { title: 'Offline Playback Queue' },
      },
      contents: {
        twoColumnBrowseResultsRenderer: {
          tabs: [{
            tabRenderer: {
              selected: true,
              content: {
                sectionListRenderer: {
                  contents: [{
                    itemSectionRenderer: {
                      contents: [{
                        playlistVideoListRenderer: {
                          contents: [
                            {
                              playlistVideoRenderer: {
                                videoId: 'dQw4w9WgXcQ',
                                title: { runs: [{ text: 'First video' }] },
                                shortBylineText: {
                                  runs: [{
                                    text: 'Test Channel',
                                    navigationEndpoint: { browseEndpoint: { browseId: 'UCuAXFkgsw1L7xaCfnd5JJOw' } },
                                  }],
                                },
                                lengthText: { simpleText: '3:33' },
                              },
                            },
                            {
                              playlistVideoRenderer: {
                                videoId: '9bZkp7q19f0',
                                title: { simpleText: 'Second video' },
                                shortBylineText: { runs: [{ text: 'Another Channel' }] },
                                lengthText: { simpleText: '4:12' },
                              },
                            },
                            {
                              playlistVideoRenderer: {
                                title: { simpleText: '[Deleted video]' },
                                unplayableText: { simpleText: 'Deleted video' },
                              },
                            },
                            {
                              continuationItemRenderer: {
                                continuationEndpoint: {
                                  continuationCommand: { token: 'CONTINUE_TOKEN' },
                                },
                              },
                            },
                          ],
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
      sidebar: {
        playlistSidebarRenderer: {
          items: [{
            playlistSidebarPrimaryInfoRenderer: {
              title: { runs: [{ text: 'Fallback Title' }] },
              numVideosText: { runs: [{ text: '2 videos' }] },
              ownerText: {
                runs: [{
                  text: 'Owner Channel',
                  navigationEndpoint: { browseEndpoint: { browseId: 'UCuAXFkgsw1L7xaCfnd5JJOw' } },
                }],
              },
            },
          }],
        },
      },
    };

    const playlist = parsePlaylistInitialData(initialData, 'PL123');

    assert.strictEqual(playlist.playlistId, 'PL123');
    assert.strictEqual(playlist.title, 'Offline Playback Queue');
    assert.strictEqual(playlist.channelTitle, 'Owner Channel');
    assert.strictEqual(playlist.channelId, 'UCuAXFkgsw1L7xaCfnd5JJOw');
    assert.strictEqual(playlist.itemCountText, '2 videos');
    assert.strictEqual(playlist.thumbnailVideoId, 'dQw4w9WgXcQ');
    assert.strictEqual(playlist.nextPageToken, 'CONTINUE_TOKEN');
    assert.strictEqual(playlist.items.length, 3);
    assert.deepStrictEqual(playlist.items[0], {
      videoId: 'dQw4w9WgXcQ',
      title: 'First video',
      channelTitle: 'Test Channel',
      channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
      lengthText: '3:33',
      index: 1,
      available: true,
      unavailableReason: '',
    });
    assert.strictEqual(playlist.items[1].index, 2);
    assert.strictEqual(playlist.items[2].available, false);
    assert.strictEqual(playlist.items[2].unavailableReason, 'Deleted video');
  });

  it('deduplicates malformed repeated playlist entries', () => {
    const initialData = {
      contents: [
        { playlistVideoRenderer: { videoId: 'dQw4w9WgXcQ', title: { simpleText: 'One' } } },
        { playlistVideoRenderer: { videoId: 'dQw4w9WgXcQ', title: { simpleText: 'Duplicate' } } },
        { playlistVideoRenderer: { videoId: 'invalid', title: { simpleText: 'Bad' } } },
      ],
    };

    const playlist = parsePlaylistInitialData(initialData, 'PLdedupe');

    assert.strictEqual(playlist.items.length, 2);
    assert.strictEqual(playlist.items[0].title, 'One');
    assert.strictEqual(playlist.items[1].available, false);
  });

  it('validates playlist IDs without accepting URL-like values', () => {
    assert.strictEqual(sanitizePlaylistId('PLabc_123-xyz'), 'PLabc_123-xyz');
    assert.strictEqual(sanitizePlaylistId('https://youtube.com/playlist?list=PLabc'), '');
    assert.strictEqual(sanitizePlaylistId('../PLabc'), '');
  });

  it('extracts playlist IDs from YouTube URLs', () => {
    assert.strictEqual(extractPlaylistId('https://www.youtube.com/playlist?list=PLabc_123'), 'PLabc_123');
    assert.strictEqual(extractPlaylistId('https://youtube.com/watch?v=dQw4w9WgXcQ&list=RDMM'), 'RDMM');
    assert.strictEqual(extractPlaylistId('PLplain'), 'PLplain');
    assert.strictEqual(extractPlaylistId('https://example.com/playlist?list=PLabc'), 'PLabc');
  });

  it('parses continuation response items with the requested start index', () => {
    const continuationData = {
      onResponseReceivedActions: [{
        appendContinuationItemsAction: {
          continuationItems: [
            {
              playlistVideoRenderer: {
                videoId: '3JZ_D3ELwOQ',
                title: { simpleText: 'Third video' },
              },
            },
            {
              continuationItemRenderer: {
                continuationEndpoint: {
                  continuationCommand: { token: 'NEXT_TOKEN' },
                },
              },
            },
          ],
        },
      }],
    };

    const playlist = parsePlaylistContinuationData(continuationData, 'PL123', 101);

    assert.strictEqual(playlist.items.length, 1);
    assert.strictEqual(playlist.items[0].index, 101);
    assert.strictEqual(playlist.nextPageToken, 'NEXT_TOKEN');
  });
});
